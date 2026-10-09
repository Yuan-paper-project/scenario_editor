"""Run scenario templates in real CARLA, with an ego that actually drives.

    .venv/bin/python3 tests/run_template_carla.py                 # every case
    .venv/bin/python3 tests/run_template_carla.py pull-out ped     # names containing these

The tpl-* cases in run_carla_cases.py predate ego authoring: their ego has no
events and no start speed, so it stands still and every distance_to_ego
trigger can only fire on its 60 s fallback. Here every case gets an ego that
drives an assign_route past the template actor at a start speed, and the
template is placed through the real UI (toolbar-less: the Templates tab and a
map click), so the chain is whatever the template builds at that spot.

Each case is judged from the OSC log and the telemetry CSV through
run_carla_cases.run_case(), like run_generated_carla.py, and printed beside the
preview's own prediction. Needs CARLA on run.sh's port (2010) and the editor on
:9090. Not part of run_tests.sh.
"""
import argparse
import json
import math
import os
import sys

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import _harness as H  # noqa: E402
import carla_analysis as A  # noqa: E402
import run_carla_cases as R  # noqa: E402

# Town03 road 6: lane -2 (y ~ -5.6) runs towards -x, with a parking lane
# (y ~ -9.1), a shoulder and a sidewalk (y ~ -12.6) on its right.
T3_EGO_LANE = (191.3, -5.6)
T3_PARK = (191.38, -9.12)
T3_KERB = (191.4, -12.6)
# Town01 road 1: the ego's lane (y ~ -2.0) runs towards -x; SPOT_WALK in
# carla_cases.py is the open kerb beside it. Crossing cases live here: the
# Town03 road 6 kerb above has a wall/fence line at y ~ -12..-12.6 under an
# overhead structure (probed: no walker spawns there at any height), scenery
# the .xodr does not contain.
T1_EGO_LANE = (245.0, -2.0)
T1_KERB = (245.0, -6.0)
# Town04 road 40: 237 m dead straight, lanes 3..6 at y 26.5/30.0/33.5/37.0,
# travelling +x from x = -357.
T4_LANE4 = (-300.0, 30.1)
T4_LANE5 = (-300.0, 33.6)

CASES = [
    # name, town, template, spot, ego reference point on the ego's lane,
    # ego start (m behind the ref), route end (m past the ref), ego start speed
    dict(name="tpl3-pull-out", town="Town03", tpl="vehicle-pull-out", spot=T3_PARK,
         ego_ref=T3_EGO_LANE, back=60, ahead=60, ego_speed=8.0),
    dict(name="tpl1-ped-crossing", town="Town01", tpl="pedestrian-crossing", spot=T1_KERB,
         ego_ref=T1_EGO_LANE, back=55, ahead=60, ego_speed=8.0),
    dict(name="tpl1-ped-stop-in-lane", town="Town01", tpl="pedestrian-stop-in-lane", spot=T1_KERB,
         ego_ref=T1_EGO_LANE, back=55, ahead=60, ego_speed=8.0),
    dict(name="tpl1-child-runs-out", town="Town01", tpl="child-runs-out", spot=T1_KERB,
         ego_ref=T1_EGO_LANE, back=55, ahead=60, ego_speed=8.0),
    dict(name="tpl1-cyclist-crossing", town="Town01", tpl="cyclist-crossing", spot=T1_KERB,
         ego_ref=T1_EGO_LANE, back=55, ahead=60, ego_speed=8.0),
    dict(name="tpl4-emergency-brake", town="Town04", tpl="vehicle-emergency-brake", spot=T4_LANE4,
         ego_ref=T4_LANE4, back=45, ahead=150, ego_speed=13.0),
    dict(name="tpl4-lane-drift", town="Town04", tpl="vehicle-lane-drift", spot=T4_LANE4,
         ego_ref=T4_LANE4, back=70, ahead=150, ego_speed=13.0),
    # NPC in lane 5, ego approaching from behind in lane 4: it must change LEFT
    # (towards -y when facing +x) into the ego's lane once the ego is 15 m away.
    dict(name="tpl4-cut-in", town="Town04", tpl="vehicle-cut-in", spot=T4_LANE5,
         ego_ref=T4_LANE4, back=50, ahead=150, ego_speed=12.0, ego_first=True),
    dict(name="tpl4-parked", town="Town04", tpl="vehicle-parked", spot=T4_LANE4,
         ego_ref=T4_LANE4, back=60, ahead=100, ego_speed=10.0),
]

SETUP_EGO = """({ref, back, ahead, speed}) => {
  const drv = new Set(['driving']);
  const at = ObjectsManager.nearestLaneProjection(ref[0], ref[1], drv, 6);
  const yaw = at.laneYaw * Math.PI / 180, ux = Math.cos(yaw), uy = Math.sin(yaw);
  // Back off until the start lands on a lane running the same way — too far
  // back can fall off this road onto a cross street.
  let s = null;
  for (let d = back; d >= 20; d -= 2) {
    s = ObjectsManager.nearestLaneProjection(ref[0] - ux * d, ref[1] - uy * d, drv, 4);
    if (s && Math.abs(((s.laneYaw - at.laneYaw) + 540) % 360 - 180) < 15) break;
    s = null;
  }
  let e = null;
  for (const d of [ahead, ahead * 0.75, ahead * 0.5]) {
    e = ObjectsManager.nearestLaneProjection(ref[0] + ux * d, ref[1] + uy * d, drv, 6);
    if (e && Math.abs(((e.laneYaw - at.laneYaw) + 540) % 360 - 180) < 30) break;
  }
  const r = v => Math.round(v * 10) / 10;
  AppState.ego = {
    id: AppState.nextId(), type: 'ego', x: r(s.x), y: r(s.y),
    z: Math.round((s.z + 0.5) * 100) / 100, yaw: Math.round(s.laneYaw), initial_speed: speed,
    events: [{ id: 'evt-1', trigger: { type: 'simulation_time', value: 0 },
      action: { type: 'assign_route', route_strategy: 'fastest', waypoints: [
        { x: r(s.x), y: r(s.y), z: Math.round((s.z + 0.5) * 100) / 100, strategy: 'fastest' },
        { x: r(e.x), y: r(e.y), z: Math.round((e.z + 0.5) * 100) / 100, strategy: 'fastest' },
      ] } }],
  };
  AppState.set({});
  return [AppState.ego.x, AppState.ego.y, AppState.ego.yaw, r(e.x), r(e.y)];
}"""

PREDICT = """() => {
  const run = Simulate.runHeadless({ dt: 0.05, maxTime: 60 });
  const ego = run.tracks[run.egoId], npc = run.tracks[AppState.npcs[0].id];
  let min = Infinity, tmin = 0;
  for (let k = 0; k < npc.length; k++) {
    const d = Math.hypot(npc[k].x - ego[k].x, npc[k].y - ego[k].y);
    if (d < min) { min = d; tmin = run.times[k]; }
  }
  const last = npc[npc.length - 1], first = npc[0];
  return { min_m: Math.round(min * 10) / 10, at_s: tmin, fired: run.fired[AppState.npcs[0].id],
           npc_moved_m: Math.round(Math.hypot(last.x - first.x, last.y - first.y) * 10) / 10 };
}"""


def build(cases):
    built = []
    with sync_playwright() as p:
        browser, page, errors = H.open_editor(p, cases[0]["town"])
        for c in cases:
            H.select_map(page, c["town"])
            page.wait_for_function("AppState.laneGraph !== null", timeout=60000)
            page.evaluate("town => AppState.loadJSON({map: town, weather: {}, time: 'daytime', "
                          "ego: null, npcs: [], staticObjects: [], trafficSignals: []})", c["town"])
            page.evaluate(f"MapView.centreOn({c['spot'][0]}, {c['spot'][1]}, 120)")
            page.wait_for_timeout(200)
            ego_args = {"ref": list(c["ego_ref"]), "back": c["back"],
                        "ahead": c["ahead"], "speed": c["ego_speed"]}
            # A template that reads the ego at the click (the cut-in's
            # direction) needs the ego placed first.
            if c.get("ego_first"):
                ego = page.evaluate(SETUP_EGO, ego_args)
            npc = H.place_template(page, c["tpl"], *c["spot"])
            if not c.get("ego_first"):
                ego = page.evaluate(SETUP_EGO, ego_args)
            predicted = page.evaluate(PREDICT)
            scenario = page.evaluate("AppState.toJSON()")
            xosc = H.xosc_from_params(page, page.evaluate("ScenarioIO.buildParamsForTesting()"))
            built.append({**c, "npc": npc, "ego": ego, "predicted": predicted,
                          "scenario": scenario, "xosc": xosc})
            print(f"[build] {c['name']}: npc {npc['type']} at ({npc['x']:.1f},{npc['y']:.1f}) "
                  f"yaw {npc['yaw']:.0f} start {npc['initial_speed']}; ego {ego}; "
                  f"{len(npc['events'])} events; preview {predicted}", flush=True)
        if errors:
            print("[build] JS errors:", errors[:3])
        browser.close()
    return built


def judge(b, result):
    out = {"name": b["name"], "terminated": not result["timed_out"] and result["returncode"] == 0,
           "wall_s": round(result["elapsed"]), "preview": b["predicted"]}
    try:
        run = A.Run(result["csv"])
    except FileNotFoundError:
        out["error"] = "no telemetry"
        return out
    timeline = A.event_timeline(A.parse_osc_log(result["log"]))
    out["events"] = {n: [t["start"], t["end"]] for n, t in sorted(timeline.items())}
    hero, adv = run.get("hero"), run.get("adversary")
    out["roles"] = sorted(run.tracks)
    if hero:
        out["ego_travel_m"] = round(hero.distance_travelled(), 1)
        out["ego_max_speed"] = round(max(hero.speed), 1)
    if adv:
        out["npc_type"] = adv.type_id
        out["npc_start"] = [round(adv.x[0], 1), round(adv.y[0], 1), round(adv.z[0], 2)]
        out["npc_end"] = [round(adv.x[-1], 1), round(adv.y[-1], 1), round(adv.z[-1], 2)]
        out["npc_moved_m"] = round(math.hypot(adv.x[-1] - adv.x[0], adv.y[-1] - adv.y[0]), 1)
        out["npc_max_speed"] = round(max(adv.speed), 1)
        out["npc_min_z"] = round(min(adv.z), 2)
        out["npc_max_z"] = round(max(adv.z), 2)
    d, t = A.closest_approach(run, "hero", "adversary")
    if d is not None:
        j = hero.at(t + (run.act_start() or 0.0)) if hero else None
        out["closest"] = {"d": round(d, 2), "t": round(t, 1),
                          "ego_speed_then": round(hero.speed[j], 1) if j is not None else None}
    if hero:
        out["ego_min_speed_after_2s"] = round(min(
            s for s, tt in zip(hero.speed, hero.t) if tt - hero.t[0] > 2.0), 1)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("filters", nargs="*")
    ap.add_argument("--timeout", type=int, default=150)
    ap.add_argument("--out", default=os.path.join(HERE, "artifacts", "template_carla.json"))
    args = ap.parse_args()
    cases = [c for c in CASES if not args.filters or any(f in c["name"] for f in args.filters)]
    built = build(cases)
    results = []
    for b in built:
        print(f"\n=== {b['name']}", flush=True)
        res = R.run_case({"name": b["name"], "props": False}, b["xosc"], b["scenario"],
                         keep_video=True, timeout=args.timeout)
        j = judge(b, res)
        print(json.dumps(j, indent=1), flush=True)
        results.append(j)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump(results, fh, indent=1)
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
