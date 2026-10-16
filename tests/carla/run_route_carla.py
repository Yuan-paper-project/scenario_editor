"""Drive assign_route scenarios in real CARLA and compare each route actor's
track with the route the editor draws and the preview drives.

    .venv/bin/python3 tests/carla/run_route_carla.py scenario.json [more.json …]

Each argument is an editor save file (the Speichern/Laden format). It is loaded
into the editor, every actor with an assign_route event has its drawn route
(Simulate.routeGeometry) and its preview track (Simulate.runHeadless) recorded,
the scenario is exported and run through /home/dellpro2/Antonio/run.sh with the
telemetry sidecar (run_carla_cases.run_case), and the CARLA track is compared:

  off_route p95/max — distance of the CARLA track from the drawn route. Lanes
                      are ~3.5 m apart, so a car in a different lane than the
                      editor drew shows up as ≥ ~3 m; a car on the drawn lane
                      stays well under 1.5 m (corner cutting included).
  progress          — share of the drawn route's length the car got along
                      (a route can outlast the 60 s MaxSimTime, or the actor
                      can be released late), measured as the furthest route
                      point the track came within 2.5 m of.
  off_preview p95   — the same distance against the preview's own simulated
                      track, over the part of it the car actually drove.

Slow: run.sh records video in synchronous mode (~11 s wall per game second),
so a full 60 s storyboard takes ~12 minutes.

A route actor is judged OK when off_route max < 2.5 m and progress > 0.1.
Needs the editor (EDITOR_URL) and CARLA on run.sh's port (2010). Not part of
run_tests.sh.
"""

import argparse
import json
import math
import os
import sys

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "e2e"))
import _harness as H  # noqa: E402
import carla_analysis as A  # noqa: E402
import carla_run as R  # noqa: E402

COLLECT = """() => {
  const out = {};
  const actors = [AppState.ego, ...AppState.npcs].filter(Boolean);
  const run = Simulate.runHeadless({ dt: 0.05, maxTime: 60 });
  actors.forEach((a) => {
    const ev = (a.events || []).find(e => e.action && e.action.type === 'assign_route');
    if (!ev) return;
    const role = a === AppState.ego ? 'hero'
      : (AppState.npcs.indexOf(a) === 0 ? 'adversary' : 'adversary' + AppState.npcs.indexOf(a));
    const route = Simulate.routeGeometry(a, ev) || [];
    const track = (run && run.tracks[a.id]) || [];
    out[role] = { id: a.id, route: route.map(p => [p.x, p.y]), preview: track.map(p => [p.x, p.y]) };
  });
  return { actors: out, source: AppState.laneGraph ? (AppState.laneGraph.source || 'carla') : null };
}"""


def _seg_dist(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)


def dist_to_polyline(p, poly):
    if len(poly) == 1:
        return math.dist(p, poly[0])
    return min(_seg_dist(p, poly[i - 1], poly[i]) for i in range(1, len(poly)))


def pct(values, q):
    v = sorted(values)
    return v[min(len(v) - 1, int(q * len(v)))] if v else None


def compare(route, preview, track):
    """track: [(x, y)] of the CARLA actor once it has started moving."""
    out = {}
    if not track or len(route) < 2:
        return {"error": "no track" if not track else "no route"}
    # Thin the track to ~0.5 m steps — 20 Hz at low speed is mostly duplicates.
    thin = [track[0]]
    for p in track[1:]:
        if math.dist(p, thin[-1]) >= 0.5:
            thin.append(p)
    d = [dist_to_polyline(p, route) for p in thin]
    out["off_route_p95"] = round(pct(d, 0.95), 2)
    out["off_route_max"] = round(max(d), 2)
    worst = thin[d.index(max(d))]
    out["worst_at"] = [round(worst[0], 1), round(worst[1], 1)]
    # Progress along the drawn route.
    cum = [0.0]
    for i in range(1, len(route)):
        cum.append(cum[-1] + math.dist(route[i - 1], route[i]))
    reached = 0.0
    for i, q in enumerate(route):
        if any(math.dist(q, p) < 2.5 for p in thin):
            reached = max(reached, cum[i])
    out["route_m"] = round(cum[-1], 1)
    out["progress"] = round(reached / cum[-1], 2) if cum[-1] else None
    if len(preview) >= 2:
        dp = [dist_to_polyline(p, preview) for p in thin]
        out["off_preview_p95"] = round(pct(dp, 0.95), 2)
        out["off_preview_max"] = round(max(dp), 2)
    out["ok"] = out["off_route_max"] < 2.5 and (out["progress"] or 0) > 0.1
    return out


def build(paths):
    built = []
    with sync_playwright() as p:
        first = json.load(open(paths[0]))
        browser, page, errors = H.open_editor(p, first["map"])
        for path in paths:
            scen = json.load(open(path))
            H.select_map(page, scen["map"])
            page.wait_for_function("!!AppState.laneGraph", timeout=60000)
            page.evaluate("(s) => AppState.loadJSON(s)", scen)
            info = page.evaluate(COLLECT)
            xosc = H.xosc_from_params(page, page.evaluate("ScenarioIO.buildParamsForTesting()"))
            name = "route-" + os.path.splitext(os.path.basename(path))[0]
            built.append({"name": name, "scenario": scen, "xosc": xosc, **info})
        if errors:
            print("JS errors:", errors[:3])
        browser.close()
    return built


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scenarios", nargs="+")
    # run.sh records three cameras in synchronous mode, so CARLA advances only
    # ~1 game second per 11-12 s of wall time; a 60 s storyboard needs ~12 min.
    # A shorter timeout silently cuts every route after ~100 m.
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(HERE), "artifacts", "route_carla.json"))
    args = ap.parse_args()

    results = []
    for b in build(args.scenarios):
        print(f"\n=== {b['name']} ({b['scenario']['map']}, lane graph: {b['source']})", flush=True)
        res = R.run_case({"name": b["name"]}, b["xosc"], b["scenario"], keep_video=False, timeout=args.timeout)
        entry = {
            "name": b["name"],
            "town": b["scenario"]["map"],
            "graph": b["source"],
            "terminated": not res["timed_out"],
            "wall_s": round(res["elapsed"]),
            "actors": {},
        }
        try:
            run = A.Run(res["csv"])
        except FileNotFoundError:
            entry["error"] = "no telemetry"
            print(json.dumps(entry), flush=True)
            results.append(entry)
            continue
        for role, a in b["actors"].items():
            tr = run.get(role)
            if tr is None:
                entry["actors"][role] = {"error": "not in telemetry (never spawned?)"}
                continue
            pts = list(zip(tr.x, tr.y))
            start = next((i for i in range(len(pts)) if math.dist(pts[i], pts[0]) > 1.0), len(pts))
            moving = pts[max(0, start - 1) :]
            entry["actors"][role] = {
                "driven_m": round(tr.distance_travelled(), 1),
                **compare(a["route"], a["preview"], moving),
            }
        print(json.dumps(entry, indent=1), flush=True)
        results.append(entry)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump(results, fh, indent=1)
    ok = sum(1 for e in results for a in e["actors"].values() if a.get("ok"))
    n = sum(len(e["actors"]) for e in results)
    print(f"\nroute actors within 2.5 m of the drawn route: {ok}/{n}   (wrote {args.out})")


if __name__ == "__main__":
    main()
