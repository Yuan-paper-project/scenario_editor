"""
lane_graph_builder.py — derive a lane_graph.json-shaped routing graph directly
from a town's .xodr file, for towns tests/probe_carla_lane_graph.py has never
run against: every uploaded map, and Town10 (no CARLA counterpart to probe).

Produces the exact JSON shape frontend/js/sim/laneGraph.js already consumes (see
maps/Town01/lane_graph.json for a real probed example, and
tests/compare_xodr_lane_graph.py, which validates this builder's output
against all 8 committed probed files). The one deliberate semantic gap from a
CARLA probe: `source` is "xodr" here (a probed file has no `source` key at
all, which the frontend treats as "carla"), and a fork's `successors` list
carries NO preferred order — CARLA's own next() picks one real successor, but
nothing in a bare .xodr ranks the candidates at a junction with more than one
<connection> for the same incoming lane, so none is invented here either.
frontend/js/sim/simulate.js's path-less fork-continuation logic already knows to
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

from backend.lane_graph.lane_graph_parts import (
    _carla_path,
    _carla_round,
    _derive_left_right,
    _lane_points,
    _resolve_lane_successors,
    _UnionFind,
)
from backend.xodr.xodr_lanes import _get_lane_sections, lane_centre_points
from backend.xodr.xodr_links import (
    _LC_LEFT,
    _LC_RIGHT,
    _mark_bits_at,
    _parse_junction_connections,
    _parse_lane_change_marks,
    _parse_lane_links,
    _parse_mark_records,
    _parse_road_links,
)

# 'bidirectional' (a centre turn lane) is deliberately excluded — confirmed
# against ground truth (maps/Town03/Town03.xodr road 0 lane 1 is
# bidirectional and never appears in any committed lane_graph.json): CARLA's
# GlobalRoutePlanner only samples Driving lanes into its routing topology.
_ROUTABLE_TYPES = ('driving',)

# GlobalRoutePlanner(map, 2.0) — the resolution ChangeActorWaypoints builds it with.
SAMPLING_RESOLUTION_M = 2.0


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
                'roadId': road_id,
                'sectionId': lane['sectionId'],
                'laneId': lane['laneId'],
                'type': lane['type'],
                'directionLine': direction_line,
                'sStart': lane['sStart'],
                'sEnd': lane['sEnd'],
                'isJunction': road_id in junction_roads,
            }
        if max_section >= 0:
            section_count_by_road[road_id] = max_section + 1

    # Exact geometry per lane: its s range straight from the .xodr, driven
    # direction included (a positive lane drives from s_end to s_start), and
    # an evaluator for its centre at any s. The directionLine is rounded to
    # 1 cm and sampled every 4 m — fine for drawing, too coarse for the
    # whole-metre rounding of node ids and the 2 m sample counts below.
    road_elems = {int(r.get('id')): r for r in root.findall('road')}
    section_s = {rid: [(a, b) for a, b, _ in _get_lane_sections(el)] for rid, el in road_elems.items()}
    for key, entry in lane_index.items():
        road_id, section_id, lane_id = key
        a, b = section_s[road_id][section_id]
        s0, s1 = (a, b) if lane_id < 0 else (b, a)
        evaluate = (lambda el, sec, ln: lambda svals: lane_centre_points(el, sec, ln, svals))(
            road_elems[road_id], section_id, lane_id
        )
        entry['s0'], entry['s1'], entry['evaluate'] = s0, s1, evaluate
        entry['ends'] = evaluate([s0, s1])

    lane_links = _parse_lane_links(root)
    road_links = _parse_road_links(root)
    junction_conns = _parse_junction_connections(root)
    lane_change_marks = _parse_lane_change_marks(root)
    mark_records = _parse_mark_records(root)
    left_right = _derive_left_right(lane_index)

    # ── Resolve successors per lane, filtered to lanes we actually have geometry for ──
    successors_by_lane: dict[tuple[int, int, int], list[dict]] = {}
    for key, entry in lane_index.items():
        road_id, section_id, lane_id = key
        last_section_id = section_count_by_road.get(road_id, 1) - 1
        candidates = _resolve_lane_successors(
            road_id,
            section_id,
            lane_id,
            last_section_id=last_section_id,
            road_links=road_links,
            lane_links=lane_links,
            junction_conns=junction_conns,
            section_count_by_road=section_count_by_road,
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
        first, last = entry['ends']
        node_point[entry_raw(key)] = {'x': first[0], 'y': first[1], 'z': first[2]}
        node_point[exit_raw(key)] = {'x': last[0], 'y': last[1], 'z': last[2]}

    canon_id: dict[str, int] = {}
    nodes: list[dict] = []

    # CARLA's node identity is the end point rounded to whole metres
    # (_build_topology's entryxyz/exitxyz, np.round half-to-even like round()),
    # so it also merges ends that merely round alike: a lane under ~1 m long
    # becomes a self-loop, and a route steps straight over it.
    by_rounded: dict[tuple[float, float, float], str] = {}
    for raw, pt in node_point.items():
        rounded = (_carla_round(pt['x']), _carla_round(pt['y']), _carla_round(pt['z']))
        if rounded in by_rounded:
            uf.union(raw, by_rounded[rounded])
        else:
            by_rounded[rounded] = raw

    def node_for(raw: str) -> int:
        root_id = uf.find(raw)
        if root_id not in canon_id:
            canon_id[root_id] = len(nodes)
            pt = node_point.get(raw) or node_point.get(root_id) or {'x': 0.0, 'y': 0.0, 'z': 0.0}
            # Rounded to whole metres like _build_topology's entryxyz/exitxyz:
            # the vertex is only ever the A* heuristic's input, and CARLA's
            # heuristic runs on the rounded value.
            nodes.append(
                {
                    'id': canon_id[root_id],
                    'x': _carla_round(pt['x']),
                    'y': _carla_round(pt['y']),
                    'z': _carla_round(pt['z']),
                }
            )
        return canon_id[root_id]

    # ── LANEFOLLOW edges (one per routable lane) + roadIdToEdge ────────────
    edges: list[dict] = []
    road_id_to_edge: dict[str, dict] = {}
    lane_entry_node: dict[tuple[int, int, int], int] = {}

    lane_path: dict[tuple[int, int, int], list[list[float]]] = {}

    for key, entry in lane_index.items():
        road_id, section_id, lane_id = key
        from_node = node_for(entry_raw(key))
        to_node = node_for(exit_raw(key))
        lane_entry_node[key] = from_node

        first, last = entry['ends']
        path = _carla_path(entry['evaluate'], entry['s0'], entry['s1'], SAMPLING_RESOLUTION_M)
        lane_path[key] = path
        edges.append(
            {
                'from': from_node,
                'to': to_node,
                'type': 'LANEFOLLOW',
                # _build_graph's length is a SAMPLE COUNT, not metres. It matters:
                # lane-change edges cost 0, so near-equal alternatives through a
                # neighbour lane are decided by exactly this number.
                'length': len(path) + 1,
                'intersection': entry['isJunction'],
                'path': _lane_points(path),
                'entry': {
                    'roadId': road_id,
                    'sectionId': section_id,
                    'laneId': lane_id,
                    'x': round(first[0], 3),
                    'y': round(first[1], 3),
                    'z': round(first[2], 3),
                },
                'exit': {
                    'roadId': road_id,
                    'sectionId': section_id,
                    'laneId': lane_id,
                    'x': round(last[0], 3),
                    'y': round(last[1], 3),
                    'z': round(last[2], 3),
                },
            }
        )
        road_id_to_edge.setdefault(str(road_id), {}).setdefault(str(section_id), {})[str(lane_id)] = [
            from_node,
            to_node,
        ]

    # ── CHANGELANELEFT/RIGHT edges — GlobalRoutePlanner._lane_change_link,
    # literally: none from a junction lane; otherwise walk the lane's path
    # samples and add the FIRST right and the first left change the marking
    # at that sample allows, to a Driving lane on the same road. The right
    # marking is the lane's own <roadMark>, the left one its inner
    # neighbour's (lane 0 for |id| == 1) — Map::GetMarkRecord. Every extra
    # edge here is a zero-cost detour A* may take: one inside a junction is
    # what drew "change left, then straight back right" through Town03
    # junction 730 on a route CARLA drives straight. ──────────────────────
    for key, entry in lane_index.items():
        if entry['isJunction']:
            continue
        # (lane the sample is on, [x, y, z, s]) — normally this lane's own
        # path. A lane under one sample long gets entry.next(2.0)[0] as its
        # only sample, which lies in the SUCCESSOR lane; CARLA then reads that
        # lane's markings and neighbours (Town03's 2 m stubs before a
        # junction change lanes inside the connector, not on the stub).
        samples = [(key, p) for p in lane_path[key]]
        span = abs(entry['s1'] - entry['s0'])
        succs = successors_by_lane.get(key) or []
        if span < SAMPLING_RESOLUTION_M and succs:
            # next() keeps walking through as many stubs as the 2 m covers.
            remaining = SAMPLING_RESOLUTION_M - span
            succ_key = (succs[0]['roadId'], succs[0]['sectionId'], succs[0]['laneId'])
            for _ in range(10):
                succ = lane_index[succ_key]
                succ_span = abs(succ['s1'] - succ['s0'])
                onward = successors_by_lane.get(succ_key) or []
                if remaining <= succ_span or not onward:
                    break
                remaining -= succ_span
                succ_key = (onward[0]['roadId'], onward[0]['sectionId'], onward[0]['laneId'])
            sign = 1.0 if succ['s1'] >= succ['s0'] else -1.0
            samples = [(succ_key, succ['evaluate']([succ['s0'] + sign * min(remaining, succ_span)])[0])]
        found = {'right': False, 'left': False}
        for wkey, sample in samples:
            w_road, w_section, w_lane = wkey
            lr = left_right.get(wkey) or {}
            inner_key = (w_road, w_section, w_lane + 1 if w_lane < 0 else w_lane - 1)
            s_here = sample[3]
            for direction, bit, records, edge_type in (
                ('right', _LC_RIGHT, mark_records.get(wkey), 'CHANGELANERIGHT'),
                ('left', _LC_LEFT, mark_records.get(inner_key), 'CHANGELANELEFT'),
            ):
                if found[direction] or not (_mark_bits_at(records, s_here) & bit):
                    continue
                ref = lr.get(direction)
                target_key = (ref['roadId'], ref['sectionId'], ref['laneId']) if ref else None
                if target_key not in lane_index:
                    continue
                edges.append(
                    {
                        'from': lane_entry_node[key],
                        'to': lane_entry_node[target_key],
                        'type': edge_type,
                        'length': 0,
                        'intersection': False,
                        'path': [],
                        'entry': {
                            'roadId': w_road,
                            'sectionId': w_section,
                            'laneId': w_lane,
                            'x': round(sample[0], 3),
                            'y': round(sample[1], 3),
                            'z': round(sample[2], 3),
                        },
                        'exit': {
                            'roadId': target_key[0],
                            'sectionId': target_key[1],
                            'laneId': target_key[2],
                            **node_point[entry_raw(target_key)],
                        },
                    }
                )
                found[direction] = True
            if found['right'] and found['left']:
                break

    # ── Flat lanes[] table ──────────────────────────────────────────────────
    lanes_out: list[dict] = []
    for key, entry in lane_index.items():
        road_id, section_id, lane_id = key
        lr = left_right.get(key, {'left': None, 'right': None})
        lanes_out.append(
            {
                'roadId': road_id,
                'sectionId': section_id,
                'laneId': lane_id,
                's': entry['sStart'],
                'laneType': 'Driving',
                'laneChange': lane_change_marks.get(key, 'NONE'),
                'left': lr['left'],
                'right': lr['right'],
                'successors': successors_by_lane.get(key, []),
            }
        )

    return {
        'town': town,
        'carlaMapName': None,
        'samplingResolution': SAMPLING_RESOLUTION_M,
        'probeVersion': 'xodr-2',
        'source': 'xodr',
        'nodes': nodes,
        'edges': edges,
        'roadIdToEdge': road_id_to_edge,
        'lanes': lanes_out,
    }
