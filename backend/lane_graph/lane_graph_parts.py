"""The CARLA-mirroring pieces build_lane_graph_from_xodr assembles: float32 rounding, node merging, 2 m paths, successors and neighbours."""

import struct

from backend.xodr.xodr_links import _forward_side


def _carla_round(v: float) -> float:
    """np.round of a float32 carla.Location coordinate (Town03 has ends at exactly x = -0.5)."""
    return float(round(struct.unpack('f', struct.pack('f', v))[0]))


# ── Union-find (merges lane-boundary node identities that connect) ─────────


class _UnionFind:
    def __init__(self):
        self._parent: dict[str, str] = {}

    def find(self, x: str) -> str:
        self._parent.setdefault(x, x)
        root = x
        while self._parent[root] != root:
            root = self._parent[root]
        while self._parent[x] != root:
            self._parent[x], x = root, self._parent[x]
        return root

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self._parent[ra] = rb


def _carla_path(evaluate, s0: float, s1: float, step: float) -> list[list[float]]:
    """The interior samples GlobalRoutePlanner takes along a lane driven s0 → s1.

    entry.next(step) repeatedly while the chord to the exit is still > step, at exact s; the
    sample count is the edge's A* cost, so 2.0001 m vs 1.9999 m matters.
    """
    sign = 1.0 if s1 >= s0 else -1.0
    span = abs(s1 - s0)
    entry_pt, exit_pt = evaluate([s0, s1])

    def chord(p: list[float]) -> float:
        d = ((p[0] - exit_pt[0]) ** 2 + (p[1] - exit_pt[1]) ** 2 + (p[2] - exit_pt[2]) ** 2) ** 0.5
        # A chord within 1 µm of `step` is a tie, which CARLA's `> step` loses (Town02's 18 m lanes).
        return step if abs(d - step) < 1e-6 else d

    if chord(entry_pt) <= step:
        return evaluate([s0 + sign * min(step, span)])
    candidates = evaluate([s0 + sign * step * k for k in range(1, int(span / step) + 1) if step * k < span])
    out = []
    for p in candidates:
        if chord(p) <= step:
            break
        out.append(p)
    return out


# ── Successor resolution ────────────────────────────────────────────────────


def _resolve_lane_successors(
    road_id: int,
    section_id: int,
    lane_id: int,
    *,
    last_section_id: int,
    road_links: dict[int, dict],
    lane_links: dict[tuple[int, int, int], tuple[int | None, int | None]],
    junction_conns: dict[tuple[int, int], list[dict]],
    section_count_by_road: dict[int, int],
) -> list[dict]:
    """All successor candidates of one lane (lane_graph_builder's forward rule), unranked."""
    side = _forward_side(lane_id)
    at_road_boundary = (side == 'successor' and section_id == last_section_id) or (
        side == 'predecessor' and section_id == 0
    )

    if not at_road_boundary:
        target_section = section_id + 1 if side == 'successor' else section_id - 1
        pred_id, succ_id = lane_links.get((road_id, section_id, lane_id), (None, None))
        target_lane_id = succ_id if side == 'successor' else pred_id
        if target_lane_id is None:
            # No <link> at an internal boundary: assume the lane keeps its id.
            target_lane_id = lane_id
        return [{'roadId': road_id, 'sectionId': target_section, 'laneId': target_lane_id}]

    link_side = (road_links.get(road_id) or {}).get(side)
    if link_side is None or link_side.get('elementId') is None:
        return []

    if link_side['elementType'] == 'road':
        pred_id, succ_id = lane_links.get((road_id, section_id, lane_id), (None, None))
        own_target_id = succ_id if side == 'successor' else pred_id
        if own_target_id is None:
            return []
        target_road = link_side['elementId']
        contact = link_side.get('contactPoint', 'start')
        target_section = 0 if contact == 'start' else max(0, section_count_by_road.get(target_road, 1) - 1)
        return [{'roadId': target_road, 'sectionId': target_section, 'laneId': own_target_id}]

    if link_side['elementType'] == 'junction':
        candidates = junction_conns.get((road_id, lane_id), [])
        out = []
        for cand in candidates:
            target_road = cand['connectingRoadId']
            contact = cand.get('contactPoint', 'start')
            target_section = 0 if contact == 'start' else max(0, section_count_by_road.get(target_road, 1) - 1)
            out.append({'roadId': target_road, 'sectionId': target_section, 'laneId': cand['toLaneId']})
        return out

    return []


def _derive_left_right(lane_index: dict[tuple[int, int, int], dict]) -> dict[tuple[int, int, int], dict]:
    """(roadId, sectionId, laneId) -> {'left', 'right'} per lane_graph_builder's left/right rule."""
    by_road_section: dict[tuple[int, int], list[int]] = {}
    for road_id, section_id, lane_id in lane_index:
        by_road_section.setdefault((road_id, section_id), []).append(lane_id)

    result: dict[tuple[int, int, int], dict] = {}
    for (road_id, section_id), lane_ids in by_road_section.items():
        present = set(lane_ids)
        for lane_id in lane_ids:
            sign = 1 if lane_id > 0 else -1
            mag = abs(lane_id)
            right_id = sign * (mag + 1)
            if mag > 1:
                left_id = sign * (mag - 1)
            else:
                left_id = -sign * 1  # cross the centreline at the innermost lane
            right = {'roadId': road_id, 'sectionId': section_id, 'laneId': right_id} if right_id in present else None
            left = {'roadId': road_id, 'sectionId': section_id, 'laneId': left_id} if left_id in present else None
            result[(road_id, section_id, lane_id)] = {'left': left, 'right': right}
    return result


def _lane_points(direction_line: list[list[float]]) -> list[dict]:
    return [{'x': round(p[0], 3), 'y': round(p[1], 3), 'z': round(p[2], 3)} for p in direction_line]
