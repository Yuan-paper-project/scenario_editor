"""
compare_xodr_lane_graph.py — validate backend/lane_graph/lane_graph_builder.py (the
from-.xodr topology builder) against the CARLA-probed maps/<Town>/lane_graph.json
files, without needing a live CARLA connection. Those files are gitignored —
regenerate them with tests/probe_carla_lane_graph.py; a town without one is
skipped.

Besides the per-lane table below, the ROUTING graph is compared, since that is
what assign_route previews are drawn from: the LANEFOLLOW edge set (exact),
edge lengths (GlobalRoutePlanner's sample counts), lane-change edges, and the
lane sequence A* returns for random lane pairs on each graph. A* here is a
port of networkx.astar_path including its tie-breaking (.venv has no
networkx), the same algorithm frontend/js/sim/laneGraph.js runs. Route agreement
is not 100% and is not expected to be: at a fork CARLA's next()[0] order,
which a .xodr does not carry, decides which connector a lane-change edge
lands on (Town03's junction 1206 → 1100/1122 accounts for most of its
misses), and equal-cost ties fall to CARLA's topology order.

Ground truth for `left`/`right` is compared exactly (both are structural
adjacency facts, independent of how the graph was produced). `successors` is
compared as a SET, not in order — the xodr builder makes no attempt to rank a
genuine fork's candidates the way a live CARLA probe's next() does (see
backend/lane_graph/lane_graph_builder.py's module docstring), so index-0 equality is not
a meaningful signal here.

Two things a raw set-equality check would wrongly flag as bugs, confirmed by
hand-tracing real examples in maps/Town05/Town05.xodr before writing this:

  1. Ground truth uses a SELF-reference ({roadId, sectionId, laneId} equal to
     the record's own key) as a dead-end marker — the probe's bounded
     fork-walk (`_walk_to_fork`) gives up after max_hops without the lane
     identity changing. frontend/js/sim/laneGraph.js's own realSuccessors()
     already filters this out before use, so this script does too.
  2. Ground truth's successors are the result of CARLA's probe walking
     forward through a chain of single-choice lanes UNTIL the next real fork
     (or a max-hop bound) — not a raw one-hop adjacency. A tiny junction
     approach stub (observed: Town05 road 31, length 0.11 m) gets silently
     walked through by the probe and never appears as its own successor
     entry, whereas this builder's `lanes[].successors` is deliberately
     one hop at a time (see lane_graph_builder.py). Both describe the same
     real topology at a different granularity — frontend/js/sim/simulate.js's
     path-less continuation calls _nextLaneCursor repeatedly as an actor's
     lane runs out, so extra, correct, finer hops cost nothing functionally.
     This script credits a "mismatch" as OK when every ground-truth
     successor is reachable by chasing this builder's own one-hop
     successors forward a bounded number of steps.

    .venv/bin/python3 tests/compare_xodr_lane_graph.py
"""

import heapq
import itertools
import json
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.lane_graph.lane_graph_builder import build_lane_graph_from_xodr  # noqa: E402
from backend.xodr.map_renderer import XODR_PATHS, build_map_render_data  # noqa: E402

_MAPS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "maps")


def _lane_key(lane):
    return (lane['roadId'], lane['sectionId'], lane['laneId'])


def _ref_key(ref):
    return (ref['roadId'], ref['sectionId'], ref['laneId']) if ref else None


def _succ_set(lane, key):
    """Successors minus the self-referencing dead-end marker — mirrors
    frontend/js/sim/laneGraph.js's realSuccessors()."""
    return frozenset(k for s in lane['successors'] if (k := _ref_key(s)) != key)


def _reachable_within(lanes_by_key, start_key, max_hops):
    """Every lane key reachable from start_key by chasing this graph's own
    one-hop successors forward, up to max_hops — the finer-grained
    equivalent of ground truth's walk-to-fork coalescing (see module
    docstring point 2)."""
    seen = {start_key}
    frontier = {start_key}
    for _ in range(max_hops):
        nxt = set()
        for k in frontier:
            lane = lanes_by_key.get(k)
            if not lane:
                continue
            for s in _succ_set(lane, k):
                if s not in seen:
                    nxt.add(s)
                    seen.add(s)
        if not nxt:
            break
        frontier = nxt
    return seen


def _astar(graph, start, goal):
    """networkx.astar_path (2.8.8), tie-breaking included: heap of
    (f, push counter), adjacency in edge insertion order, one edge per pair."""
    vert = {n['id']: (n['x'], n['y'], n['z']) for n in graph['nodes']}
    adj = {}
    for e in graph['edges']:
        adj.setdefault(e['from'], {})[e['to']] = e  # dict: repeat pair keeps its slot
    h = lambda n: math.dist(vert[n], vert[goal])
    counter = itertools.count()
    queue = [(0, next(counter), start, 0, None)]
    enqueued, explored = {}, {}
    while queue:
        _, _, cur, dist, parent = heapq.heappop(queue)
        if cur == goal:
            path = [cur]
            while parent is not None:
                path.append(parent)
                parent = explored[parent]
            return path[::-1]
        if cur in explored:
            if explored[cur] is None or enqueued[cur][0] < dist:
                continue
        explored[cur] = parent
        for nb, e in adj.get(cur, {}).items():
            ncost = dist + e['length']
            if nb in enqueued:
                if enqueued[nb][0] <= ncost:
                    continue
                hn = enqueued[nb][1]
            else:
                hn = h(nb)
            enqueued[nb] = (ncost, hn)
            heapq.heappush(queue, (ncost + hn, next(counter), nb, ncost, cur))
    return None


def _route_lanes(graph, a, b):
    """Lane sequence of the A* route from lane a's entry to lane b's entry."""
    ea = graph['roadIdToEdge'][str(a[0])][str(a[1])][str(a[2])]
    eb = graph['roadIdToEdge'][str(b[0])][str(b[1])][str(b[2])]
    nodes = _astar(graph, ea[0], eb[0])
    if nodes is None:
        return None
    by_pair = {(e['from'], e['to']): e for e in graph['edges']}
    out = []
    for u, v in zip(nodes, nodes[1:]):
        e = by_pair[(u, v)]
        out.append((e['type'], _lane_key(e['exit'] if e['type'].startswith('CHANGE') else e['entry'])))
    return out


def compare_routing(gt, built, n_routes=300):
    lf = lambda g: {_lane_key(e['entry']): e for e in g['edges'] if e['type'] == 'LANEFOLLOW'}
    gt_lf, b_lf = lf(gt), lf(built)

    def lc(g):
        vert = {n['id']: (n['x'], n['y'], n['z']) for n in g['nodes']}
        return {
            (vert[e['from']], e['type'], _lane_key(e['exit'])) for e in g['edges'] if e['type'].startswith('CHANGE')
        }

    junction_roads = {e['entry']['roadId'] for e in built['edges'] if e['type'] == 'LANEFOLLOW' and e['intersection']}
    junction_lc = [
        e
        for e in built['edges']
        if e['type'].startswith('CHANGE')
        and e['entry']['roadId'] in junction_roads
        and e['exit']['roadId'] in junction_roads
        and built['roadIdToEdge'][str(e['entry']['roadId'])]
    ]
    gt_lc, b_lc = lc(gt), lc(built)

    common = sorted(set(gt_lf) & set(b_lf))
    rng = random.Random(7)
    agree = total = 0
    while total < n_routes and len(common) > 1:
        a, b = rng.sample(common, 2)
        want = _route_lanes(gt, a, b)
        if want is None:
            continue
        total += 1
        agree += _route_lanes(built, a, b) == want
    return {
        'lf_equal': set(gt_lf) == set(b_lf),
        'len_off': sum(gt_lf[k]['length'] != b_lf[k]['length'] for k in common),
        'len_n': len(common),
        'lc_missing': len(gt_lc - b_lc),
        'lc_extra': len(b_lc - gt_lc),
        'lc_n': len(gt_lc),
        'route_pct': 100.0 * agree / (total or 1),
    }


def compare_town(town: str) -> dict:
    gt_path = os.path.join(_MAPS_DIR, town, "lane_graph.json")
    gt = json.loads(open(gt_path).read())
    gt_by_key = {_lane_key(l): l for l in gt['lanes']}

    xodr_path = XODR_PATHS[town]
    roads_out = build_map_render_data(town)['roads']
    built = build_lane_graph_from_xodr(xodr_path, roads_out, town)
    built_by_key = {_lane_key(l): l for l in built['lanes']}

    common = set(gt_by_key) & set(built_by_key)
    missing = set(gt_by_key) - set(built_by_key)
    extra = set(built_by_key) - set(gt_by_key)

    left_match = right_match = succ_exact = succ_reachable = 0
    gt_fork_count = built_fork_count = 0
    succ_unreachable = []
    for key in common:
        g, b = gt_by_key[key], built_by_key[key]
        if _ref_key(g['left']) == _ref_key(b['left']):
            left_match += 1
        if _ref_key(g['right']) == _ref_key(b['right']):
            right_match += 1

        gset, bset = _succ_set(g, key), _succ_set(b, key)
        if gset == bset:
            succ_exact += 1
            succ_reachable += 1
        else:
            reach = _reachable_within(built_by_key, key, max_hops=8)
            unreached = {r for r in gset if r not in reach}
            if not unreached:
                succ_reachable += 1
            elif len(succ_unreachable) < 8:
                succ_unreachable.append((key, sorted(unreached), sorted(bset)))

        if len(_succ_set(g, key)) > 1:
            gt_fork_count += 1
        if len(_succ_set(b, key)) > 1:
            built_fork_count += 1

    n = len(common) or 1
    routing = compare_routing(gt, built)
    return {
        **routing,
        'town': town,
        'gt_lanes': len(gt_by_key),
        'built_lanes': len(built_by_key),
        'common': len(common),
        'missing': len(missing),
        'extra': len(extra),
        'left_pct': 100.0 * left_match / n,
        'right_pct': 100.0 * right_match / n,
        'succ_exact_pct': 100.0 * succ_exact / n,
        'succ_reachable_pct': 100.0 * succ_reachable / n,
        'gt_forks': gt_fork_count,
        'built_forks': built_fork_count,
        'succ_unreachable': succ_unreachable,
        'missing_keys': sorted(missing)[:5],
        'extra_keys': sorted(extra)[:5],
    }


def main():
    towns = sorted(t for t in os.listdir(_MAPS_DIR) if os.path.isfile(os.path.join(_MAPS_DIR, t, "lane_graph.json")))
    print(f"Comparing xodr-derived lane graphs against {len(towns)} CARLA-probed ground-truth files\n")
    overall_ok = True
    for town in towns:
        r = compare_town(town)
        print(f"── {town} ──")
        print(
            f"  lanes: ground-truth={r['gt_lanes']}  built={r['built_lanes']}  "
            f"common={r['common']}  missing={r['missing']}  extra={r['extra']}"
        )
        print(f"  left match:  {r['left_pct']:5.1f}%")
        print(f"  right match: {r['right_pct']:5.1f}%")
        print(f"  successor-set exact match:       {r['succ_exact_pct']:5.1f}%")
        print(
            f"  successor reachable-within-8hop: {r['succ_reachable_pct']:5.1f}%  "
            f"(ground-truth forks: {r['gt_forks']}, built forks: {r['built_forks']})"
        )
        if r['missing_keys']:
            print(f"  sample missing (in ground truth, not built): {r['missing_keys']}")
        if r['extra_keys']:
            print(f"  sample extra (built, not in ground truth): {r['extra_keys']}")
        print(
            f"  routing: LANEFOLLOW edges {'identical' if r['lf_equal'] else 'DIFFER'}; "
            f"lengths off {r['len_off']}/{r['len_n']}; lane-change edges missing {r['lc_missing']} "
            f"extra {r['lc_extra']} of {r['lc_n']}; A* lane sequence agrees {r['route_pct']:5.1f}%"
        )
        for key, unreached, bset in r['succ_unreachable']:
            print(f"  GENUINE mismatch {key}: unreachable ground-truth targets={unreached} (built 1-hop={bset})")
        print()
        if r['left_pct'] < 98 or r['right_pct'] < 98 or r['succ_reachable_pct'] < 97:
            overall_ok = False
        # Routing: floors just under what the builder reaches (2026-10-12), so
        # a regression shows. With lane-change gating alone, Town03 agreed on
        # 72% and Town07 on 54%; Town03 stays lowest because its misses are the
        # fork-order cases the module docstring describes.
        route_floor = 70 if town == 'Town03' else 95
        if (
            not r['lf_equal']
            or r['len_off'] > 0.07 * r['len_n']
            or r['lc_missing'] + r['lc_extra'] > max(4, 0.12 * r['lc_n'])
            or r['route_pct'] < route_floor
        ):
            overall_ok = False
    print("OVERALL:", "look reasonable" if overall_ok else "below threshold — needs investigation")
    return 0 if overall_ok else 1


if __name__ == '__main__':
    sys.exit(main())
