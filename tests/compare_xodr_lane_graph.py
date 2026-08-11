"""
compare_xodr_lane_graph.py — validate backend/lane_graph_builder.py (the
from-.xodr topology builder) against the 8 committed CARLA-probed
maps/<Town>/lane_graph.json files, without needing a live CARLA connection.

Ground truth for `left`/`right` is compared exactly (both are structural
adjacency facts, independent of how the graph was produced). `successors` is
compared as a SET, not in order — the xodr builder makes no attempt to rank a
genuine fork's candidates the way a live CARLA probe's next() does (see
backend/lane_graph_builder.py's module docstring), so index-0 equality is not
a meaningful signal here.

Two things a raw set-equality check would wrongly flag as bugs, confirmed by
hand-tracing real examples in maps/Town05/Town05.xodr before writing this:

  1. Ground truth uses a SELF-reference ({roadId, sectionId, laneId} equal to
     the record's own key) as a dead-end marker — the probe's bounded
     fork-walk (`_walk_to_fork`) gives up after max_hops without the lane
     identity changing. frontend/js/laneGraph.js's own realSuccessors()
     already filters this out before use, so this script does too.
  2. Ground truth's successors are the result of CARLA's probe walking
     forward through a chain of single-choice lanes UNTIL the next real fork
     (or a max-hop bound) — not a raw one-hop adjacency. A tiny junction
     approach stub (observed: Town05 road 31, length 0.11 m) gets silently
     walked through by the probe and never appears as its own successor
     entry, whereas this builder's `lanes[].successors` is deliberately
     one hop at a time (see lane_graph_builder.py). Both describe the same
     real topology at a different granularity — frontend/js/simulate.js's
     path-less continuation calls _nextLaneCursor repeatedly as an actor's
     lane runs out, so extra, correct, finer hops cost nothing functionally.
     This script credits a "mismatch" as OK when every ground-truth
     successor is reachable by chasing this builder's own one-hop
     successors forward a bounded number of steps.

    .venv/bin/python3 tests/compare_xodr_lane_graph.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.map_renderer import build_map_render_data, XODR_PATHS  # noqa: E402
from backend.lane_graph_builder import build_lane_graph_from_xodr  # noqa: E402

_MAPS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "maps")


def _lane_key(lane):
    return (lane['roadId'], lane['sectionId'], lane['laneId'])


def _ref_key(ref):
    return (ref['roadId'], ref['sectionId'], ref['laneId']) if ref else None


def _succ_set(lane, key):
    """Successors minus the self-referencing dead-end marker — mirrors
    frontend/js/laneGraph.js's realSuccessors()."""
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
    return {
        'town': town,
        'gt_lanes': len(gt_by_key), 'built_lanes': len(built_by_key),
        'common': len(common), 'missing': len(missing), 'extra': len(extra),
        'left_pct': 100.0 * left_match / n, 'right_pct': 100.0 * right_match / n,
        'succ_exact_pct': 100.0 * succ_exact / n, 'succ_reachable_pct': 100.0 * succ_reachable / n,
        'gt_forks': gt_fork_count, 'built_forks': built_fork_count,
        'succ_unreachable': succ_unreachable,
        'missing_keys': sorted(missing)[:5], 'extra_keys': sorted(extra)[:5],
    }


def main():
    towns = sorted(
        t for t in os.listdir(_MAPS_DIR)
        if os.path.isfile(os.path.join(_MAPS_DIR, t, "lane_graph.json"))
    )
    print(f"Comparing xodr-derived lane graphs against {len(towns)} CARLA-probed ground-truth files\n")
    overall_ok = True
    for town in towns:
        r = compare_town(town)
        print(f"── {town} ──")
        print(f"  lanes: ground-truth={r['gt_lanes']}  built={r['built_lanes']}  "
              f"common={r['common']}  missing={r['missing']}  extra={r['extra']}")
        print(f"  left match:  {r['left_pct']:5.1f}%")
        print(f"  right match: {r['right_pct']:5.1f}%")
        print(f"  successor-set exact match:       {r['succ_exact_pct']:5.1f}%")
        print(f"  successor reachable-within-8hop: {r['succ_reachable_pct']:5.1f}%  "
              f"(ground-truth forks: {r['gt_forks']}, built forks: {r['built_forks']})")
        if r['missing_keys']:
            print(f"  sample missing (in ground truth, not built): {r['missing_keys']}")
        if r['extra_keys']:
            print(f"  sample extra (built, not in ground truth): {r['extra_keys']}")
        for key, unreached, bset in r['succ_unreachable']:
            print(f"  GENUINE mismatch {key}: unreachable ground-truth targets={unreached} (built 1-hop={bset})")
        print()
        if r['left_pct'] < 98 or r['right_pct'] < 98 or r['succ_reachable_pct'] < 97:
            overall_ok = False
    print("OVERALL:", "look reasonable" if overall_ok else "below threshold — needs investigation")
    return 0 if overall_ok else 1


if __name__ == '__main__':
    sys.exit(main())
