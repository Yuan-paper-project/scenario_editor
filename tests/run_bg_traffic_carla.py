"""Background traffic in real CARLA: exact replay, and the scenario untouched.

    .venv/bin/python3 tests/run_bg_traffic_carla.py Town03:lead_brake:5:40 [--baseline]

Each spec is town:type:seed:count — a generator scenario plus `count`
background cars. The scenario is built through the real editor (generator,
then "Hintergrundverkehr" on, then the same export the button makes), the
.bgtraffic.json is put next to the .xosc, and run.sh runs both: it finds the
traffic file by name and starts tools/bg_traffic_player.py beside
ScenarioRunner. From the telemetry CSV it reports

  * replay error — each background car's CARLA position against where the
    file (and therefore the editor's preview) puts it at that time;
  * clearance — the closest any background car came to the ego or an NPC;
  * the scenario itself — event start/end times, the ego's travel and its
    closest approach to the first NPC.

--baseline also runs every scenario WITHOUT traffic (BG_TRAFFIC=off), so the
last point can be compared: traffic that stays out of the way leaves the
scripted scenario as it was.

Needs CARLA on run.sh's port (2010) and the editor (EDITOR_URL, default :9090).
"""
import argparse
import csv
import json
import math
import os
import statistics
import sys

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import _harness as H  # noqa: E402
import carla_analysis as A  # noqa: E402
import run_carla_cases as R  # noqa: E402


def build(specs):
    built = []
    with sync_playwright() as p:
        browser, page, errors = H.open_editor(p, specs[0][0])
        for town, typ, seed, count in specs:
            H.select_map(page, town)
            page.wait_for_function("AppState.laneGraph !== null", timeout=60000)
            info = page.evaluate("([t, s]) => ScenarioGenerator.generate(t, s)", [typ, seed])
            if not info:
                print(f"[build] {town}:{typ}:{seed} — no scenario on this map")
                continue
            page.evaluate("n => { AppState.bgTraffic = { ...AppState.bgTraffic, enabled: true, count: n, seed: 1 }; }", count)
            page.evaluate("BgTraffic.ensure()")
            page.wait_for_function("BgTraffic.data && !BgTraffic.busy && BgTraffic.data.town === AppState.map",
                                   timeout=120000)
            traffic = page.evaluate("BgTraffic.data")
            scenario = page.evaluate("AppState.toJSON()")
            xosc = H.xosc_from_params(page, page.evaluate("ScenarioIO.buildParamsForTesting()"))
            built.append({"name": f"bg-{town}-{typ}-{seed}", "town": town, "type": typ, "seed": seed,
                          "xosc": xosc, "scenario": scenario, "traffic": traffic,
                          "npcs": len(scenario["npcs"]), "props": bool(scenario["staticObjects"])})
            print(f"[build] {town}:{typ}:{seed}: {len(traffic['vehicles'])} background cars "
                  f"({traffic['stats']})", flush=True)
        if errors:
            print("[build] browser errors:", errors)
        browser.close()
    return built


def _file_pose(v, t, dt):
    """Entry v's [x, y] at run time t, or None outside its life (t0 onward)."""
    fr = v["frames"]
    f = (t - v.get("t0", 0.0)) / dt
    if f < -1.0 or f > len(fr):
        return None
    i = int(math.floor(f))
    if i <= 0:
        return fr[0]
    if i >= len(fr) - 1:
        return fr[-1]
    a, b, w = fr[i], fr[i + 1], f - i
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w]


def analyse(csv_path, traffic, n_npcs):
    rows = []
    with open(csv_path) as fh:
        for r in csv.DictReader(fh):
            rows.append(r)
    if not rows:
        return {"error": "empty telemetry"}
    by_actor = {}
    for r in rows:
        by_actor.setdefault(r["actor_id"], []).append(
            (float(r["sim_time"]), float(r["x"]), float(r["y"]), float(r["z"]), r["role_name"]))
    roles = {aid: next((x[4] for x in tr if x[4]), "") for aid, tr in by_actor.items()}
    hero = next((a for a, r in roles.items() if r == "hero"), None)
    if hero is None:
        return {"error": "no hero in telemetry"}
    t0 = by_actor[hero][0][0]
    bg = [a for a, r in roles.items() if r == "background"]
    out = {"bg_actors": len(bg), "bg_in_file": len(traffic["vehicles"])}

    # Match each CARLA background car to its file vehicle by position at its first row.
    dt = traffic["dt"]
    errors, matched = [], 0
    worst = None
    # A car's first rows are its spawn: created a few ticks after its t0 at a
    # lifted pose, then steered onto the file. Match on its second row and
    # measure from SETTLE_S into its life; the spawn offset is reported apart.
    SETTLE_S = 0.6
    hero_xy = {round(ts, 3): (xs, ys) for (ts, xs, ys, _z, _r) in by_actor[hero]}
    spawn_offsets, appear_d, vanish_d = [], [], []
    for aid in bg:
        tr = by_actor[aid]
        if len(tr) < 2:
            continue
        t, x, y = tr[1][0] - t0, tr[1][1], tr[1][2]
        live = [(v, _file_pose(v, t, dt)) for v in traffic["vehicles"]]
        live = [(v, p) for v, p in live if p is not None]
        if not live:
            continue
        best, p = min(live, key=lambda vp: math.hypot(vp[1][0] - x, vp[1][1] - y))
        if math.hypot(p[0] - x, p[1] - y) > 3.0:
            continue
        matched += 1
        q0 = _file_pose(best, tr[0][0] - t0, dt) or p
        spawn_offsets.append(math.hypot(q0[0] - tr[0][1], q0[1] - tr[0][2]))
        # how far from the ego a car appears and disappears (the bubble's edge)
        for row, sink in ((tr[0], appear_d), (tr[-1], vanish_d)):
            h = hero_xy.get(round(row[0], 3))
            if h and 0.5 < row[0] - t0 < traffic["duration"] - 0.5:
                sink.append(math.hypot(row[1] - h[0], row[2] - h[1]))
        for (ts, xs, ys, _zs, _r) in tr[1:]:
            tt = ts - t0
            if ts - tr[0][0] < SETTLE_S or tt > traffic["duration"] - 0.2:
                continue
            q = _file_pose(best, tt, dt)
            if q is None:
                continue
            e = math.hypot(q[0] - xs, q[1] - ys)
            errors.append(e)
            if worst is None or e > worst[0]:
                worst = (round(e, 2), aid, round(tt, 2))
    out["bg_matched"] = matched
    if appear_d:
        out["appears_at_hero_m"] = {"min": round(min(appear_d), 1), "median": round(statistics.median(appear_d), 1)}
    if vanish_d:
        out["vanishes_at_hero_m"] = {"min": round(min(vanish_d), 1), "median": round(statistics.median(vanish_d), 1)}
    if spawn_offsets:
        out["spawn_tick_offset_m"] = {"max": round(max(spawn_offsets), 2),
                                      "t": round(min(by_actor[a][0][0] for a in bg) - t0, 2)}
    if errors:
        errors.sort()
        out["replay_error_m"] = {"median": round(statistics.median(errors), 3),
                                 "p95": round(errors[int(0.95 * len(errors))], 3),
                                 "max": round(errors[-1], 3), "samples": len(errors), "worst": worst}

    # Clearance: centre distance from every scripted vehicle to every background car, per frame.
    scripted = [a for a, r in roles.items() if r == "hero" or r.startswith("adversary")]
    frames = {}
    for aid in scripted + bg:
        for (ts, xs, ys, _zs, _r) in by_actor[aid]:
            frames.setdefault(round(ts, 3), {})[aid] = (xs, ys)
    closest = {}
    for ts, poses in frames.items():
        for s in scripted:
            if s not in poses:
                continue
            for b in bg:
                if b not in poses:
                    continue
                d = math.hypot(poses[s][0] - poses[b][0], poses[s][1] - poses[b][1])
                key = roles[s]
                if key not in closest or d < closest[key][0]:
                    closest[key] = (round(d, 2), round(ts - t0, 2))
    out["closest_bg_centre_m"] = {k: {"d": v[0], "t": v[1]} for k, v in sorted(closest.items())}
    return out


def scenario_outcome(result, n_npcs):
    out = {"terminated": not result["timed_out"] and result["returncode"] == 0,
           "wall_s": round(result["elapsed"])}
    try:
        run = A.Run(result["csv"])
    except FileNotFoundError:
        out["error"] = "no telemetry"
        return out
    timeline = A.event_timeline(A.parse_osc_log(result["log"]))
    out["events"] = {n: [t["start"], t["end"]] for n, t in sorted(timeline.items())}
    hero = run.get("hero")
    if hero:
        out["ego_travel_m"] = round(hero.distance_travelled(), 1)
    if n_npcs:
        d, t = A.closest_approach(run, "hero", "adversary")
        if d is not None:
            out["ego_adversary_closest_m"] = round(d, 2)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("specs", nargs="+", help="town:type:seed:count")
    ap.add_argument("--baseline", action="store_true", help="also run each scenario without traffic")
    ap.add_argument("--timeout", type=int, default=1200)
    ap.add_argument("--out", default=os.path.join(HERE, "artifacts", "bg_traffic_carla.json"))
    args = ap.parse_args()
    specs = []
    for s in args.specs:
        town, typ, seed, count = (s.split(":") + ["40"])[:4]
        specs.append((town, typ, int(seed), int(count)))

    built = build(specs)
    results = []
    for b in built:
        report = {"name": b["name"], "bg_cars": len(b["traffic"]["vehicles"]),
                  "clearance_m": b["traffic"]["clearance"]}
        # run_case writes the .xosc to srunner/examples/scenario_tester/gui_test_<name>.xosc;
        # the traffic goes beside it under the name run.sh looks for.
        name = b["name"]
        bg_path = os.path.join(R.SR_ROOT, "srunner/examples/scenario_tester", f"gui_test_{name}.bgtraffic.json")
        with open(bg_path, "w") as fh:
            json.dump(b["traffic"], fh)
        os.environ.pop("BG_TRAFFIC", None)
        print(f"\n=== {name} with {report['bg_cars']} background cars", flush=True)
        res = R.run_case({"name": name, "props": b["props"]}, b["xosc"], b["scenario"],
                         keep_video=True, timeout=args.timeout)
        with open(res["log"]) as fh:
            log = fh.read()
        report["player_log"] = [ln.strip() for ln in log.splitlines() if "[bg_traffic]" in ln]
        report["with_traffic"] = scenario_outcome(res, b["npcs"])
        try:
            report["traffic"] = analyse(res["csv"], b["traffic"], b["npcs"])
        except FileNotFoundError:
            report["traffic"] = {"error": "no telemetry"}
        if args.baseline:
            os.environ["BG_TRAFFIC"] = "off"
            print(f"=== {name} baseline (no traffic)", flush=True)
            res0 = R.run_case({"name": name + "-baseline", "props": b["props"]}, b["xosc"], b["scenario"],
                              keep_video=False, timeout=args.timeout)
            os.environ.pop("BG_TRAFFIC", None)
            report["baseline"] = scenario_outcome(res0, b["npcs"])
        print(json.dumps(report, indent=1), flush=True)
        results.append(report)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump(results, fh, indent=1)
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
