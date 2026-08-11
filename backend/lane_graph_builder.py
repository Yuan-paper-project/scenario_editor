"""
lane_graph_builder.py — derive a lane_graph.json-shaped routing graph directly
from a town's .xodr file, for towns tests/probe_carla_lane_graph.py has never
run against: every uploaded map, and Town10 (no CARLA counterpart to probe).

Produces the exact JSON shape frontend/js/laneGraph.js already consumes (see
maps/Town01/lane_graph.json for a real probed example, and
tests/compare_xodr_lane_graph.py, which validates this builder's output
against all 8 committed probed files). The one deliberate semantic gap from a
CARLA probe: `source` is "xodr" here (a probed file has no `source` key at
all, which the frontend treats as "carla"), and a fork's `successors` list
carries NO preferred order — CARLA's own next() picks one real successor, but
nothing in a bare .xodr ranks the candidates at a junction with more than one
<connection> for the same incoming lane, so none is invented here either.
frontend/js/simulate.js's path-less fork-continuation logic already knows to
refuse to guess when graph.source === 'xodr' and a lane has more than one
successor, rather than pick index 0 the way it safely can for real CARLA data.

Coordinate/geometry inputs are NOT recomputed here — `roads_out` (i.e.
MAP_CACHE[town]['roads']) already carries each drivable lane's `directionLine`
(already oriented in true travel direction — map_renderer.py reverses it for
left-side/positive-id lanes) and z, so this module only adds topology.

── The forward-successor rule (verified against maps/Town01 and Town03 ground
   truth before writing this) ──

OpenDRIVE's per-lane <link><predecessor/><successor/></link> — and the
road-level <link> it falls back on at a road boundary — are keyed by
s-coordinate (predecessor = the s=0 end, successor = the s=length end), NOT by
which way the lane actually drives. A negative-id lane drives with increasing
s, so its real forward neighbour is at the s=length end (the XML successor
side). A positive-id lane drives against s (map_renderer.py reverses its
directionLine for exactly this reason), so ITS real forward neighbour is at
the s=0 end — the XML *predecessor* side. Reading the wrong side for a
positive lane silently produces a fork/dead-end that doesn't exist.

── Left/right neighbour rule (also empirically verified) ──

Within one (roadId, sectionId), "right" is always the same-sign lane one
|id| further from the centreline; "left" is the same-sign lane one |id|
closer to the centreline, except at |id| == 1, where "left" crosses the
centreline to the opposite-sign lane at |id| == 1 (the oncoming lane), if one
exists. This holds for both signs — it falls out of get_left_lane()/
get_right_lane() being relative to each lane's own forward-driving direction,
which is exactly what the sign convention above already encodes.
"""

import xml.etree.ElementTree as ET
from pathlib import Path

# 'bidirectional' (a centre turn lane) is deliberately excluded — confirmed
# against ground truth (maps/Town03/Town03.xodr road 0 lane 1 is
# bidirectional and never appears in any committed lane_graph.json): CARLA's
# GlobalRoutePlanner only samples Driving lanes into its routing topology.
_ROUTABLE_TYPES = ('driving',)


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


# ── XML extraction ──────────────────────────────────────────────────────────

def _forward_side(lane_id: int) -> str:
    """Which XML <link> side ('predecessor'/'successor') a lane's own forward
    driving direction corresponds to — see module docstring."""
    return 'successor' if lane_id < 0 else 'predecessor'


def _parse_lane_links(root: ET.Element) -> dict[tuple[int, int, int], tuple[int | None, int | None]]:
    """(roadId, sectionId, laneId) -> (predecessor_lane_id, successor_lane_id),
    read straight from each <lane>'s own <link>, or (None, None) if absent."""
    result: dict[tuple[int, int, int], tuple[int | None, int | None]] = {}
    for road in root.findall('road'):
        road_id = int(road.get('id'))
        lanes_elem = road.find('lanes')
        if lanes_elem is None:
            continue
        for section_id, ls in enumerate(lanes_elem.findall('laneSection')):
            for side in ('left', 'right'):
                se = ls.find(side)
                if se is None:
                    continue
                for lane in se.findall('lane'):
                    try:
                        lane_id = int(lane.get('id'))
                    except (TypeError, ValueError):
                        continue
                    link = lane.find('link')
                    pred_id = succ_id = None
                    if link is not None:
                        pred_el = link.find('predecessor')
                        succ_el = link.find('successor')
                        if pred_el is not None and pred_el.get('id') is not None:
                            pred_id = int(pred_el.get('id'))
                        if succ_el is not None and succ_el.get('id') is not None:
                            succ_id = int(succ_el.get('id'))
                    result[(road_id, section_id, lane_id)] = (pred_id, succ_id)
    return result


def _parse_road_links(root: ET.Element) -> dict[int, dict]:
    """roadId -> {'predecessor': side|None, 'successor': side|None}, each side
    {'elementType', 'elementId': int, 'contactPoint'} — same shape as
    map_renderer._get_road_link, re-derived here to keep this module
    independent of map_renderer's private helpers."""
    result: dict[int, dict] = {}
    for road in root.findall('road'):
        road_id = int(road.get('id'))
        link_elem = road.find('link')
        sides: dict[str, dict | None] = {'predecessor': None, 'successor': None}
        if link_elem is not None:
            for tag in ('predecessor', 'successor'):
                el = link_elem.find(tag)
                if el is None:
                    continue
                element_id = el.get('elementId')
                sides[tag] = {
                    'elementType': el.get('elementType', 'road'),
                    'elementId': int(element_id) if element_id is not None else None,
                    'contactPoint': el.get('contactPoint', 'start'),
                }
        result[road_id] = sides
    return result


def _parse_junction_connections(root: ET.Element) -> dict[tuple[int, int], list[dict]]:
    """(incomingRoadId, fromLaneId) -> [{'connectingRoadId', 'toLaneId',
    'contactPoint'}, ...] — a list because a single incoming lane can appear
    in more than one <connection> at a genuine fork; every candidate is kept,
    none ranked (see module docstring)."""
    result: dict[tuple[int, int], list[dict]] = {}
    for junction in root.findall('junction'):
        for conn in junction.findall('connection'):
            incoming_road = conn.get('incomingRoad')
            connecting_road = conn.get('connectingRoad')
            if incoming_road is None or connecting_road is None:
                continue
            incoming_road = int(incoming_road)
            connecting_road = int(connecting_road)
            contact_point = conn.get('contactPoint', 'start')
            for ll in conn.findall('laneLink'):
                from_id = ll.get('from')
                to_id = ll.get('to')
                if from_id is None or to_id is None:
                    continue
                key = (incoming_road, int(from_id))
                result.setdefault(key, []).append({
                    'connectingRoadId': connecting_road,
                    'toLaneId': int(to_id),
                    'contactPoint': contact_point,
                })
    return result


def _parse_lane_change_marks(root: ET.Element) -> dict[tuple[int, int, int], str]:
    """(roadId, sectionId, laneId) -> best-effort <roadMark laneChange="...">
    value, title-cased to match the probed schema's enum spelling. NOT used
    to gate anything — see module docstring's schema note; ScenarioRunner's
    own ChangeActorLateralMotion doesn't check lane-change legality either
    (CLAUDE.md / _findSameDirectionNeighbor's docstring: check=False), so
    this is informational only, kept for schema parity."""
    result: dict[tuple[int, int, int], str] = {}
    for road in root.findall('road'):
        road_id = int(road.get('id'))
        lanes_elem = road.find('lanes')
        if lanes_elem is None:
            continue
        for section_id, ls in enumerate(lanes_elem.findall('laneSection')):
            for side in ('left', 'right'):
                se = ls.find(side)
                if se is None:
                    continue
                for lane in se.findall('lane'):
                    try:
                        lane_id = int(lane.get('id'))
                    except (TypeError, ValueError):
                        continue
                    value = 'none'
                    for rm in lane.findall('roadMark'):
                        rm_value = (rm.get('laneChange') or 'none').lower()
                        # most permissive wins if a lane carries more than one
                        # roadMark record (e.g. different sOffsets)
                        if rm_value == 'both':
                            value = 'both'
                            break
                        if value == 'none' and rm_value != 'none':
                            value = rm_value
                    result[(road_id, section_id, lane_id)] = {
                        'none': 'NONE', 'both': 'Both',
                        'increase': 'Increase', 'decrease': 'Decrease',
                    }.get(value, 'NONE')
    return result


# ── Successor resolution ────────────────────────────────────────────────────

def _resolve_lane_successors(
    road_id: int, section_id: int, lane_id: int, *,
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
    at_road_boundary = (
        (side == 'successor' and section_id == last_section_id) or
        (side == 'predecessor' and section_id == 0)
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
    for (road_id, section_id, lane_id) in lane_index:
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
    return [{'x': p[0], 'y': p[1], 'z': p[2]} for p in direction_line]


def _lane_length(direction_line: list[list[float]]) -> float:
    total = 0.0
    for a, b in zip(direction_line, direction_line[1:]):
        total += ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 + (b[2] - a[2]) ** 2) ** 0.5
    return round(total, 2)


# ── Public entry point ──────────────────────────────────────────────────────

def build_lane_graph_from_xodr(xodr_path: Path, roads_out: list[dict], town: str) -> dict:
    """Build a lane_graph.json-shaped dict for `town` from its .xodr file,
    using `roads_out` (MAP_CACHE[town]['roads']) as the geometry source so
    lane centrelines and z are not recomputed. Re-parses the .xodr itself
    (cheap, one-time, at startup/upload) rather than threading `root` through
    map_renderer.py's existing, unrelated return signature."""
    root = ET.parse(str(xodr_path)).getroot()

    # ── Index every routable (Driving/Bidirectional) lane from roads_out ────
    lane_index: dict[tuple[int, int, int], dict] = {}
    junction_roads: set[int] = set()
    section_count_by_road: dict[int, int] = {}
    for road in roads_out:
        road_id = int(road['id'])
        if road.get('junction', '-1') != '-1':
            junction_roads.add(road_id)
        max_section = -1
        for lane in road['lanes']:
            max_section = max(max_section, lane['sectionId'])
            if lane['type'] not in _ROUTABLE_TYPES:
                continue
            direction_line = lane.get('directionLine')
            if not direction_line or len(direction_line) < 2:
                continue
            key = (road_id, lane['sectionId'], lane['laneId'])
            lane_index[key] = {
                'roadId': road_id, 'sectionId': lane['sectionId'], 'laneId': lane['laneId'],
                'type': lane['type'], 'directionLine': direction_line,
                'sStart': lane['sStart'], 'sEnd': lane['sEnd'],
                'isJunction': road_id in junction_roads,
            }
        if max_section >= 0:
            section_count_by_road[road_id] = max_section + 1

    lane_links = _parse_lane_links(root)
    road_links = _parse_road_links(root)
    junction_conns = _parse_junction_connections(root)
    lane_change_marks = _parse_lane_change_marks(root)
    left_right = _derive_left_right(lane_index)

    # ── Resolve successors per lane, filtered to lanes we actually have geometry for ──
    successors_by_lane: dict[tuple[int, int, int], list[dict]] = {}
    for key, entry in lane_index.items():
        road_id, section_id, lane_id = key
        last_section_id = section_count_by_road.get(road_id, 1) - 1
        candidates = _resolve_lane_successors(
            road_id, section_id, lane_id,
            last_section_id=last_section_id,
            road_links=road_links, lane_links=lane_links,
            junction_conns=junction_conns, section_count_by_road=section_count_by_road,
        )
        resolved = [c for c in candidates if (c['roadId'], c['sectionId'], c['laneId']) in lane_index]
        successors_by_lane[key] = resolved

    # ── Union-find node identities: a lane's exit merges with each resolved
    # successor's entry, so a fork/merge falls out of shared node ids rather
    # than needing separate connector edges (matches how the real CARLA-probed
    # graphs are structured — verified against maps/Town01/lane_graph.json:
    # edge count equals lane count 1:1 outside of lane-change edges). ────────
    uf = _UnionFind()

    def entry_raw(key):
        return f"{key[0]}:{key[1]}:{key[2]}:entry"

    def exit_raw(key):
        return f"{key[0]}:{key[1]}:{key[2]}:exit"

    for key, succs in successors_by_lane.items():
        for succ in succs:
            succ_key = (succ['roadId'], succ['sectionId'], succ['laneId'])
            uf.union(exit_raw(key), entry_raw(succ_key))

    node_point: dict[str, dict] = {}
    for key, entry in lane_index.items():
        dl = entry['directionLine']
        node_point[entry_raw(key)] = {'x': dl[0][0], 'y': dl[0][1], 'z': dl[0][2]}
        node_point[exit_raw(key)] = {'x': dl[-1][0], 'y': dl[-1][1], 'z': dl[-1][2]}

    canon_id: dict[str, int] = {}
    nodes: list[dict] = []

    def node_for(raw: str) -> int:
        root_id = uf.find(raw)
        if root_id not in canon_id:
            canon_id[root_id] = len(nodes)
            pt = node_point.get(raw) or node_point.get(root_id) or {'x': 0.0, 'y': 0.0, 'z': 0.0}
            nodes.append({'id': canon_id[root_id], 'x': pt['x'], 'y': pt['y'], 'z': pt['z']})
        return canon_id[root_id]

    # ── LANEFOLLOW edges (one per routable lane) + roadIdToEdge ────────────
    edges: list[dict] = []
    road_id_to_edge: dict[str, dict] = {}
    lane_entry_node: dict[tuple[int, int, int], int] = {}

    for key, entry in lane_index.items():
        road_id, section_id, lane_id = key
        from_node = node_for(entry_raw(key))
        to_node = node_for(exit_raw(key))
        lane_entry_node[key] = from_node

        dl = entry['directionLine']
        edges.append({
            'from': from_node, 'to': to_node, 'type': 'LANEFOLLOW',
            'length': _lane_length(dl), 'intersection': entry['isJunction'],
            'path': _lane_points(dl[1:-1]),
            'entry': {'roadId': road_id, 'sectionId': section_id, 'laneId': lane_id,
                      'x': dl[0][0], 'y': dl[0][1], 'z': dl[0][2]},
            'exit': {'roadId': road_id, 'sectionId': section_id, 'laneId': lane_id,
                     'x': dl[-1][0], 'y': dl[-1][1], 'z': dl[-1][2]},
        })
        road_id_to_edge.setdefault(str(road_id), {}).setdefault(str(section_id), {})[str(lane_id)] = [from_node, to_node]

    # ── CHANGELANELEFT/RIGHT edges — mirrors the flat lanes[] left/right
    # table exactly (no legality gate: the real ChangeActorLateralMotion
    # atomic doesn't check one either, check=False — see module docstring). ─
    for key, lr in left_right.items():
        if key not in lane_index:
            continue
        for direction, edge_type in (('left', 'CHANGELANELEFT'), ('right', 'CHANGELANERIGHT')):
            ref = lr[direction]
            if not ref:
                continue
            target_key = (ref['roadId'], ref['sectionId'], ref['laneId'])
            if target_key not in lane_index:
                continue
            from_node = lane_entry_node[key]
            to_node = lane_entry_node[target_key]
            edges.append({
                'from': from_node, 'to': to_node, 'type': edge_type,
                'length': 0, 'intersection': lane_index[key]['isJunction'],
                'path': [],
                'entry': {'roadId': key[0], 'sectionId': key[1], 'laneId': key[2],
                          **node_point[entry_raw(key)]},
                'exit': {'roadId': target_key[0], 'sectionId': target_key[1], 'laneId': target_key[2],
                         **node_point[entry_raw(target_key)]},
            })

    # ── Flat lanes[] table ──────────────────────────────────────────────────
    lanes_out: list[dict] = []
    for key, entry in lane_index.items():
        road_id, section_id, lane_id = key
        lr = left_right.get(key, {'left': None, 'right': None})
        lanes_out.append({
            'roadId': road_id, 'sectionId': section_id, 'laneId': lane_id,
            's': entry['sStart'],
            'laneType': 'Driving',
            'laneChange': lane_change_marks.get(key, 'NONE'),
            'left': lr['left'], 'right': lr['right'],
            'successors': successors_by_lane.get(key, []),
        })

    return {
        'town': town,
        'carlaMapName': None,
        'samplingResolution': None,
        'probeVersion': 'xodr-1',
        'source': 'xodr',
        'nodes': nodes,
        'edges': edges,
        'roadIdToEdge': road_id_to_edge,
        'lanes': lanes_out,
    }
