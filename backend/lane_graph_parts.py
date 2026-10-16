"""The CARLA-mirroring pieces build_lane_graph_from_xodr assembles: float32 rounding, node merging, 2 m paths, successors and neighbours."""

import struct

from backend.xodr_links import _forward_side


def _carla_round(v: float) -> float:
    """np.round(v, 0) of a carla.Location coordinate, which is float32: a
    point at exactly x.5 in the map — Town03 has several at x = -0.5 — comes
    out of float64 maths a hair either side, and only the float32 cast puts it
    back on .5, where half-to-even then rounds it the way CARLA does."""
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
    """The interior `path` GlobalRoutePlanner._build_topology samples for one
    lane driven from s0 to s1: entry.next(step) repeatedly, kept while the
    straight-line distance to the exit is still > step; a lane whose ends are
    within `step` of each other gets exactly one point. next() advances along
    s, so the samples sit at s0 ± k·step, evaluated exactly (`evaluate`, a
    list of s -> [x, y, z, s] points): a last sample 2.0001 m from the exit
    is in, 1.9999 m is out, and that sample count is the edge's A* cost."""
    sign = 1.0 if s1 >= s0 else -1.0
    span = abs(s1 - s0)
    entry_pt, exit_pt = evaluate([s0, s1])

    def chord(p: list[float]) -> float:
        d = ((p[0] - exit_pt[0]) ** 2 + (p[1] - exit_pt[1]) ** 2 + (p[2] - exit_pt[2]) ** 2) ** 0.5
        # On a straight lane whose length is a multiple of `step` the last
        # sample is exactly `step` from the exit; CARLA's `> step` is then
        # false (Town02's 18 m lanes), our float64 a hair either side.
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
    """All resolved successor candidates for one lane, per the module
    docstring's forward-side rule. Unranked — a real fork yields every
    candidate, in whatever order the XML gives them."""
    side = _forward_side(lane_id)
    at_road_boundary = (side == 'successor' and section_id == last_section_id) or (
        side == 'predecessor' and section_id == 0
    )

    if not at_road_boundary:
        target_section = section_id + 1 if side == 'successor' else section_id - 1
        pred_id, succ_id = lane_links.get((road_id, section_id, lane_id), (None, None))
        target_lane_id = succ_id if side == 'successor' else pred_id
        if target_lane_id is None:
            # No <link> at this internal boundary (rare) — assume the lane
            # keeps its own id into the next section, same as it visually
            # does in the render polygon.
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
    """(roadId, sectionId, laneId) -> {'left': ref|None, 'right': ref|None},
    per the module docstring's left/right rule."""
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
