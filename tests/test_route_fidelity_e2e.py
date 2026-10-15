"""assign_route preview fidelity: the previewed path must never go backwards.

The preview routes `assign_route` through the cached CARLA lane graph
(frontend/js/laneGraph.js `route`, a port of GlobalRoutePlanner.trace_route)
and then filters the result exactly as the runtime's ChangeActorWaypoints does
(frontend/js/simRoute.js `_exactRoute`). Both halves are needed: the router
genuinely emits points that double back — a lane change is a bare ~12 m chord,
and a leg can overshoot its goal — and the real runtime drops them. Porting
the routing without the filter made the previewed ego drive ~18 m, turn round,
re-drive the same stretch and only then continue, which is what this suite
exists to catch.

Reversals are measured as the angle between consecutive segments: cos < -0.5
is a turn of more than 120 deg, which no legitimate road route makes between
2 m samples.

Needs a running editor (EDITOR_URL, default http://localhost:9090) and a town
with a committed lane_graph.json — Town03, which the other suites already use.
"""

import math
import os
import sys
import time

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import Checks, open_editor  # noqa: E402

# The scenario this defect was reported against: an ego on Town03 road 7 with a
# four-waypoint route west then north. Waypoint 0 sits on the ego's own spawn
# pose because startPathMode always seeds it there, which is what made leg 0
# degenerate and duplicated leg 1's opening stretch.
EGO = {
    "id": "obj-1",
    "type": "ego",
    "x": 110.51,
    "y": -3.33,
    "z": 0.62,
    "yaw": 180.9,
    "events": [
        {
            "id": "evt-1",
            "trigger": {"type": "simulation_time", "value": 0},
            "action": {
                "type": "assign_route",
                "route_strategy": "fastest",
                "waypoints": [
                    {"x": 110.51, "y": -3.33, "z": 0.62},
                    {"x": 49.7, "y": -4.5, "z": 0.52},
                    {"x": -9.9, "y": 43.7, "z": 0.5},
                    {"x": -9.7, "y": 68.3, "z": 0.5},
                ],
            },
        },
        {
            "id": "evt-2",
            "trigger": {"type": "simulation_time", "value": 0},
            "action": {
                "type": "set_speed",
                "dynamics": {"shape": "step", "dimension": "time", "value": 5},
                "target": {"mode": "absolute", "value": 10},
            },
        },
    ],
}

REVERSAL_COS = -0.5


def reversals(points, min_step=1e-3):
    """Indices where the path turns by more than ~120 deg."""
    out = []
    for i in range(2, len(points)):
        v1 = (points[i - 1][0] - points[i - 2][0], points[i - 1][1] - points[i - 2][1])
        v2 = (points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
        n1, n2 = math.hypot(*v1), math.hypot(*v2)
        if n1 < min_step or n2 < min_step:
            continue
        cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)
        if cos < REVERSAL_COS:
            out.append(
                (
                    i,
                    round(cos, 3),
                    (round(points[i - 1][0], 2), round(points[i - 1][1], 2)),
                    (round(points[i][0], 2), round(points[i][1], 2)),
                )
            )
    return out


check = Checks()

with sync_playwright() as p:
    browser, page, errors = open_editor(p, town="Town03")
    check("no JS errors on load", not errors, str(errors[:3]))

    check("Town03 has a cached lane graph", page.evaluate("() => !!AppState.laneGraph"))

    # ── The route itself ─────────────────────────────────────────────────────
    # Deterministic: computed once, no animation timing involved.
    route = page.evaluate(
        """(ego) => {
        AppState.ego = ego; AppState.npcs = []; AppState.set({});
        return Simulate.routeForTesting(ego);
    }""",
        EGO,
    )

    check(
        "the exact route was built from the lane graph (not the raw polyline)",
        route is not None and len(route) > 20,
        f"len={len(route) if route else None}",
    )

    if route:
        pts = [(p_["x"], p_["y"]) for p_ in route]
        rev = reversals(pts)
        check("the computed route contains no reversal", not rev, str(rev[:4]))

        # The authored waypoints run west (x 110 -> 49) then north (y -4 -> 68).
        check(
            "route starts near the ego and ends near the last waypoint",
            math.hypot(pts[0][0] - 110.51, pts[0][1] - (-3.33)) < 15
            and math.hypot(pts[-1][0] - (-9.7), pts[-1][1] - 68.3) < 15,
            f"first={pts[0]} last={pts[-1]}",
        )

        # Leg 0 is degenerate (waypoint 0 == ego pose). Before the fix it
        # emitted ~18 m of lane and leg 1 then restarted behind the actor.
        first_leg = [q for q in pts[:12]]
        check(
            "the route does not re-visit its own start after moving away",
            all(q[0] <= 111.6 for q in first_leg),
            f"first 12 x = {[round(q[0], 1) for q in first_leg]}",
        )

    # ── The animated preview ─────────────────────────────────────────────────
    page.evaluate("""() => { const s = document.getElementById('sim-speed');
                             s.value = '4'; s.dispatchEvent(new Event('input')); }""")
    page.click("#sim-play")
    samples = []
    for _ in range(40):
        time.sleep(0.25)
        samples.append(page.evaluate("() => [AppState.ego.x, AppState.ego.y]"))
    page.click("#sim-stop")

    moved = math.hypot(samples[-1][0] - 110.51, samples[-1][1] - (-3.33))
    check("the previewed ego actually drove the route", moved > 80, f"moved={moved:.1f} m")

    rev = reversals(samples, min_step=0.05)
    check("the previewed ego never drives backwards", not rev, str(rev[:4]))

    check("no unexpected JS errors during the run", not errors, str(errors[:3]))

    # ── Routes CARLA was checked against (GlobalRoutePlanner on a live server) ──
    def route_of(actor):
        return page.evaluate(
            """(a) => (Simulate.routeForTesting(a) || [])
                                  .map(p => [p.x, p.y, p.z || 0])""",
            actor,
        )

    def routed(aid, x, y, z, yaw, wps):
        return {
            "id": aid,
            "type": "car",
            "x": x,
            "y": y,
            "z": z,
            "yaw": yaw,
            "initial_speed": 0,
            "events": [
                {
                    "id": "evt-1",
                    "trigger": {"type": "simulation_time", "value": 0},
                    "action": {
                        "type": "assign_route",
                        "route_strategy": "fastest",
                        "waypoints": [{**w, "strategy": "fastest"} for w in wps],
                    },
                }
            ],
        }

    # Reported: a junction_conflict car on Town03 road 2 lane -2 previewed a
    # change into lane -1 and straight back before junction 730; CARLA drives
    # it straight through (road 2 -> 743 -> 3, lane -2 all the way). The
    # xodr-derived graph had lane-change edges inside the junction.
    car = routed(
        "obj-1",
        -87.3,
        -174.9,
        0.5,
        93,
        [
            {"x": -87.3, "y": -174.9, "z": 0.5},
            {"x": -88.7, "y": -116.9, "z": 0.34},
            {"x": -88.4, "y": -19.9, "z": 0.36},
        ],
    )
    pts = route_of(car)
    stray = [p for p in pts if -172 < p[1] < -126 and p[0] > -86.0]
    check(
        "the junction_conflict car stays in lane -2 up to junction 730 (no change and back)",
        len(pts) > 20 and not stray,
        f"len={len(pts)} stray={stray[:3]}",
    )

    # Standing within 1 m of a lane end, CARLA's seed (next(1)) is in the
    # successor, waypoint 0 is behind it, and the real route goes round the
    # block to come back: road 5 is a 0.8 m stub. CARLA's route reaches y -197.
    stub = routed(
        "obj-9",
        220.97,
        -1.68,
        0.5,
        -179.18,
        [{"x": 220.97, "y": -1.68, "z": 0.5}, {"x": 69.19, "y": 130.11, "z": 0.51}],
    )
    pts = route_of(stub)
    check(
        "a seed past a 0.8 m stub drives CARLA's loop round the block",
        pts and min(p[1] for p in pts) < -190,
        f"min y={min(p[1] for p in pts) if pts else None}",
    )

    # A waypoint on a bridge deck projects onto the deck (3-D, like
    # get_waypoint), not the street under it.
    deck = page.evaluate("""() => ObjectsManager.nearestLaneProjection(
        71.8, -136.7, new Set(['driving']), 30, 8.47)?.z""")
    check(
        "a route waypoint on Town03's elevated road projects onto the deck", deck is not None and deck > 5, f"z={deck}"
    )

    check("no JS errors from the CARLA-checked routes", not errors, str(errors[:3]))
    browser.close()

check.report()
