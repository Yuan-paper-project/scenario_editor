"""
check_render_geometry.py — sanity-check the lane polygons map_renderer.py builds
for every bundled town. Pure Python: no server, no browser, no CARLA.

Two artefact classes it pins, both of which reached the map before:

  1. laneOffset step spikes. CARLA maps step the laneOffset at a lane-section
     boundary; evaluating a section's last sample with the NEXT section's record
     threw that vertex sideways by up to 6 m (Town03 road 1566). Checked as: the
     inner edge of every lane may not move further sideways between its last two
     vertices than the sample spacing allows.
     The same at a section's FIRST sample: the sampler can emit s = 2.0 beside
     the boundary's own 2.000000000000057, and the 2.0 one read the previous
     record — Town06 road 1124's connector lanes started 14 m to one side,
     which every route through junction 1050 drew as a sideways jump. Checked
     at both ends of every polygon edge and of every directionLine.
  2. Folded offset curves. A lateral distance beyond an arc's radius crosses the
     arc centre and the edge doubles back (Town02 road 2's sidewalks). Checked
     as: no edge turns back by more than 120° at a vertex.

    .venv/bin/python3 tests/check_render_geometry.py
"""

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.map_renderer import XODR_PATHS, build_map_render_data  # noqa: E402

TOWNS = ['Town01', 'Town02', 'Town03', 'Town04', 'Town05', 'Town06', 'Town07', 'Town10HD', 'Town10']

# A defect in the .xodr itself, not in the renderer: road 598 carries a 0.39 m
# laneOffset blip (+0.635 → −2.865 → +0.635) inside a single lane section.
ALLOW = {('Town06', '598')}

REVERSAL_COS = -0.5  # > 120° turn at a vertex


def _edges(poly):
    n = len(poly) // 2
    return poly[:n], poly[n:][::-1]


def check_town(town):
    data = build_map_render_data(town)
    reversals, end_jumps = [], []
    for road in data['roads']:
        if (town, road['id']) in ALLOW:
            continue
        for lane in road['lanes']:
            for edge in _edges(lane['polygon']):
                for i in range(1, len(edge) - 1):
                    a = (edge[i][0] - edge[i - 1][0], edge[i][1] - edge[i - 1][1])
                    b = (edge[i + 1][0] - edge[i][0], edge[i + 1][1] - edge[i][1])
                    la, lb = math.hypot(*a), math.hypot(*b)
                    if la < 1e-3 or lb < 1e-3:
                        continue
                    if (a[0] * b[0] + a[1] * b[1]) / (la * lb) < REVERSAL_COS:
                        reversals.append((road['id'], lane['laneId'], lane['sectionId'], i))
            # Section-end jump: an end segment may not be much longer than the
            # section's own spacing next to it permits — at either end.
            inner, outer = _edges(lane['polygon'])
            for edge in (inner, outer, lane.get('directionLine') or []):
                if len(edge) < 3:
                    continue
                # A 1 m road sampled at s 0, 0.98, 1.0 has a "jump" that is
                # simply the road; a real one is a fraction of its edge.
                total = sum(
                    math.hypot(edge[i][0] - edge[i - 1][0], edge[i][1] - edge[i - 1][1]) for i in range(1, len(edge))
                )
                for e in (edge, edge[::-1]):
                    last = math.hypot(e[-1][0] - e[-2][0], e[-1][1] - e[-2][1])
                    prev = math.hypot(e[-2][0] - e[-3][0], e[-2][1] - e[-3][1])
                    if last > 1.0 and last > 4.0 * max(prev, 0.25) + 0.5 and last < 0.75 * total:
                        end_jumps.append((road['id'], lane['laneId'], lane['sectionId'], round(last, 2)))
    return reversals, end_jumps


def main():
    failed = 0
    for town in TOWNS:
        if town not in XODR_PATHS:
            print(f'  SKIP {town} (no .xodr)')
            continue
        reversals, end_jumps = check_town(town)
        ok = not reversals and not end_jumps
        print(
            f"  {'PASS' if ok else 'FAIL'} {town}: {len(reversals)} folded vertices, {len(end_jumps)} section-end jumps"
        )
        for r in (reversals + end_jumps)[:5]:
            print(f'       road/lane/section/…: {r}')
        failed += not ok
    print(f'\n{len(TOWNS) - failed}/{len(TOWNS)} towns clean')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
