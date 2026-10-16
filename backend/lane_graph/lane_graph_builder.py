"""Derive a lane_graph.json-shaped routing graph from a town's .xodr, for towns never probed in CARLA.

Same shape as a probed file (tests/compare_xodr_lane_graph.py checks it), with `source: "xodr"`
and successors in no preferred order: a bare .xodr ranks no fork, so none is invented. Geometry
comes from MAP_CACHE's roads (directionLines already in travel direction); this adds topology.

Forward rule: OpenDRIVE links are keyed by s (predecessor = s 0 end), not by travel direction.
A negative-id lane drives with s, so its forward neighbour is on the successor side; a positive
one drives against s, so on the PREDECESSOR side.

Left/right rule: within a section "right" is the same-sign lane one |id| further out, "left" one
|id| further in, except at |id| 1, where left is the opposite-sign lane 1 (the oncoming lane).
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

# Only Driving lanes: CARLA's GlobalRoutePlanner samples nothing else (Town03's bidirectional
# separator never appears in a probed graph).
_ROUTABLE_TYPES = ('driving',)

# GlobalRoutePlanner(map, 2.0) — the resolution ChangeActorWaypoints builds it with.
SAMPLING_RESOLUTION_M = 2.0


# ── Public entry point ──────────────────────────────────────────────────────


def build_lane_graph_from_xodr(xodr_path: Path, roads_out: list[dict], town: str) -> dict:
    """Build a lane_graph.json-shaped dict for `town`; geometry from `roads_out`, topology from the .xodr."""
    root = ET.parse(str(xodr_path)).getroot()

    # ── Index every routable lane from roads_out ───────────────────────────
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

    # Exact geometry per lane (s range, driven direction, centre evaluator): the 1 cm, 4 m
    # directionLine is too coarse for whole-metre node ids and 2 m sample counts.
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

    # ── Node identities by union-find: a lane's exit merges with its successors' entries, so
    # forks and merges fall out of shared ids, one edge per lane as in the probed graphs. ──
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

    # CARLA's node identity is the end point rounded to whole metres (half-to-even), so ends that
    # merely round alike merge too: a lane under ~1 m becomes a self-loop a route steps over.
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
            # Rounded, like CARLA's vertices: they are only the A* heuristic's input.
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
                # A SAMPLE COUNT, not metres: lane changes cost 0, so this decides near-equal routes.
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

    # ── Lane-change edges, as GlobalRoutePlanner._lane_change_link: none from a junction lane;
    # else the FIRST right and first left change the marking allows along the lane's samples
    # (right: its own <roadMark>, left: its inner neighbour's). Each extra edge is a free detour. ─
    for key, entry in lane_index.items():
        if entry['isJunction']:
            continue
        # (lane, [x, y, z, s]) per sample. A lane under one sample long gets next(2)[0], which lies
        # in its successor, whose markings and neighbours CARLA then reads.
        samples = [(key, p) for p in lane_path[key]]
        span = abs(entry['s1'] - entry['s0'])
        succs = successors_by_lane.get(key) or []
        if span < SAMPLING_RESOLUTION_M and succs:
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
