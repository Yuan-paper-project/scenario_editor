"""Run the speed/offset/trigger extensions in real CARLA, beside the preview.

    .venv/bin/python3 tests/run_actions_ext_carla.py            # every case
    .venv/bin/python3 tests/run_actions_ext_carla.py accel      # names containing these

Each case is seeded straight into AppState on Town04 road 40 (237 m dead
straight, lanes 3..6 at y 26.5/30.0/33.5/37.0, travelling +x from x = -357),
exported through the real backend, run via run.sh and judged from the telemetry
CSV and the OSC log — printed next to what Simulate.runHeadless predicted:

  ext-accel        max_acceleration 6 / max_deceleration 2 against the 3 / 10
                   defaults: the measured ramp and braking rates.
  ext-reverse      a negative absolute target: the car backs up without turning.
  ext-offset       lane_offset „Hin & zurück" (continuous="false"): it reaches
                   the offset, the event ENDs, and the car returns to the centre.
  ext-triggers     relative_speed, „Abstand zu Akteur" (distance to an NPC) and
                   a continuous factor follow, all off a driving ego.

Needs CARLA on run.sh's port (2010) and the editor (EDITOR_URL, default :9090).
Not part of run_tests.sh.
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

LANE = {3: 26.5, 4: 30.0, 5: 33.5, 6: 37.0}


def car(cid, lane, x, events, **extra):
    return {"id": cid, "type": "car", "x": x, "y": LANE[lane], "yaw": 0, "events": events, **extra}


def spd(eid, trigger, target, dim="time", value=30):
    return {
        "id": eid,
        "trigger": trigger,
        "action": {
            "type": "set_speed",
            "dynamics": {"shape": "linear" if dim == "rate" else "step", "dimension": dim, "value": value},
            "target": target,
        },
    }


def at(t):
    return {"type": "simulation_time", "value": t}


def absolute(v, **kw):
    return {"mode": "absolute", "value": v, **kw}


PARKED_EGO = {
    "id": "obj-1",
    "type": "ego",
    "x": -350,
    "y": LANE[3],
    "yaw": 0,
    "events": [spd("e1", at(0), absolute(0), value=60)],
}

CASES = [
    dict(
        name="ext-accel",
        ego=PARKED_EGO,
        npcs=[
            car(
                "obj-2",
                4,
                -330,
                [spd("evt-1", at(1), absolute(12), value=6), spd("evt-2", at(8), absolute(0), value=20)],
                max_acceleration=6,
                max_deceleration=2,
            ),
            car(
                "obj-3",
                5,
                -330,
                [spd("evt-1", at(1), absolute(12), value=6), spd("evt-2", at(8), absolute(0), value=20)],
            ),
        ],
    ),
    dict(
        name="ext-reverse",
        ego=PARKED_EGO,
        npcs=[
            car(
                "obj-2",
                4,
                -280,
                [
                    spd("evt-1", at(1), absolute(3, reverse=True), value=6),
                    spd("evt-2", {"type": "after_event", "event_id": "evt-1"}, absolute(0), value=5),
                ],
            )
        ],
    ),
    dict(
        name="ext-offset",
        ego=PARKED_EGO,
        npcs=[
            car(
                "obj-2",
                4,
                -340,
                [
                    {
                        "id": "evt-1",
                        "trigger": at(6),
                        "action": {"type": "lane_offset", "direction": "left", "offset": 1.75, "continuous": False},
                    },
                    spd("evt-2", {"type": "after_event", "event_id": "evt-1"}, absolute(8), value=5),
                ],
                initial_speed=8,
            )
        ],
    ),
    dict(
        name="ext-triggers",
        ego={
            "id": "obj-1",
            "type": "ego",
            "x": -350,
            "y": LANE[3],
            "yaw": 0,
            "initial_speed": 10,
            "events": [spd("e1", at(0), absolute(10), value=60)],
        },
        npcs=[
            # waits until the ego is > 5 m/s faster than itself (it stands: ego > 5 m/s)
            car(
                "obj-2",
                4,
                -260,
                [
                    spd(
                        "evt-1",
                        {"type": "relative_speed", "entity_ref": "obj-1", "rule": "greaterThan", "value": 5},
                        absolute(5),
                    )
                ],
            ),
            # waits until obj-2 (not the ego) is within 20 m of it
            car(
                "obj-3",
                5,
                -215,
                [spd("evt-1", {"type": "distance_to_ego", "value": 20, "entity_ref": "obj-2"}, absolute(4))],
            ),
            # follows half the ego's speed, for good
            car(
                "obj-4",
                6,
                -330,
                [
                    spd(
                        "evt-1",
                        at(0),
                        {
                            "mode": "relative",
                            "entity_ref": "obj-1",
                            "value_type": "factor",
                            "factor": 0.5,
                            "continuous": True,
                        },
                    )
                ],
            ),
        ],
    ),
]

SEED = """(c) => {
  const fix = a => {
    const n = ObjectsManager.nearestLaneProjection(a.x, a.y, new Set(['driving']), 4);
    return {...a, y: Math.round(n.y * 100) / 100, yaw: Math.round(n.laneYaw),
            z: Math.round(ObjectsManager.surfaceZFor('car', a.x, n.y) * 100) / 100};
  };
  AppState.loadJSON({map: 'Town04', weather: {}, time: 'daytime', ego: fix(c.ego),
                     npcs: c.npcs.map(fix), staticObjects: [], trafficSignals: []});
  const run = Simulate.runHeadless({dt: 0.05, maxTime: 30});
  const tracks = {};
  for (const [id, tr] of Object.entries(run.tracks)) tracks[id] = tr.filter((_, k) => k % 10 === 9);
  return {fired: run.fired, completed: run.completed, tracks,
          poses: [AppState.ego, ...AppState.npcs].map(a => [a.id, a.x, a.y, a.z, a.yaw])};
}"""

ROLE = {"obj-1": "hero", "obj-2": "adversary", "obj-3": "adversary1", "obj-4": "adversary2"}


def build(cases):
    built = []
    with sync_playwright() as p:
        browser, page, errors = H.open_editor(p, "Town04")
        page.wait_for_function("AppState.laneGraph !== null", timeout=60000)
        for c in cases:
            predicted = page.evaluate(SEED, {"ego": c["ego"], "npcs": c["npcs"]})
            scenario = page.evaluate("AppState.toJSON()")
            xosc = H.xosc_from_params(page, page.evaluate("ScenarioIO.buildParamsForTesting()"))
            built.append({**c, "predicted": predicted, "scenario": scenario, "xosc": xosc})
            print(f"[build] {c['name']}: {predicted['poses']}", flush=True)
        if errors:
            print("[build] JS errors:", errors[:3])
        browser.close()
    return built


def rate_between(tr, v0, v1):
    """Mean |dv/dt| between the first crossings of v0 and v1 — searched from the
    start for a rise, from the speed peak for a fall (before the peak the car is
    still standing, and „below 10" is trivially true there)."""
    pk = max(range(len(tr.speed)), key=lambda k: tr.speed[k])
    ts = list(zip(tr.t, tr.speed))
    seg = ts if v1 > v0 else ts[pk:]
    hit = (lambda s, v: s >= v) if v1 > v0 else (lambda s, v: s <= v)
    t0 = next((t for t, s in seg if hit(s, v0)), None)
    t1 = next((t for t, s in seg if t0 is not None and t > t0 and hit(s, v1)), None)
    if t0 is None or t1 is None:
        return None
    return round(abs(v1 - v0) / (t1 - t0), 2)


def judge(b, result):
    out = {
        "name": b["name"],
        "terminated": not result["timed_out"] and result["returncode"] == 0,
        "wall_s": round(result["elapsed"]),
    }
    try:
        run = A.Run(result["csv"])
    except FileNotFoundError:
        out["error"] = "no telemetry"
        return out
    timeline = A.event_timeline(A.parse_osc_log(result["log"]))
    out["events"] = {n: [t["start"], t["end"]] for n, t in sorted(timeline.items())}
    t0 = run.tracks["hero"].t[0] if "hero" in run.tracks else 0
    for cid, role in ROLE.items():
        tr = run.get(role)
        if not tr:
            continue
        info = {"max_speed": round(max(tr.speed), 2), "z_range": [round(min(tr.z), 2), round(max(tr.z), 2)]}
        if b["name"] == "ext-accel" and role != "hero":
            info["accel_rate_2_10"] = rate_between(tr, 2, 10)
            info["brake_rate_10_2"] = rate_between(tr, 10, 2)
        if b["name"] == "ext-reverse" and role == "adversary":
            info["dx"] = round(tr.x[-1] - tr.x[0], 2)
            info["yaw_range"] = [round(min(tr.yaw), 1), round(max(tr.yaw), 1)]
            vx = [
                (tr.x[k + 10] - tr.x[k]) / (tr.t[k + 10] - tr.t[k])
                for k in range(0, len(tr.t) - 10, 10)
                if tr.t[k + 10] > tr.t[k]
            ]
            info["min_vx"] = round(min(vx), 2) if vx else None
        if b["name"] == "ext-offset" and role == "adversary":
            y0 = tr.y[0]
            info["min_dy"] = round(min(y - y0 for y in tr.y), 2)
            info["final_dy"] = round(tr.y[-1] - y0, 2)
        if b["name"] == "ext-triggers" and role != "hero":
            moving = [t - t0 for t, s in zip(tr.t, tr.speed) if s > 0.3]
            info["starts_moving_s"] = round(moving[0], 2) if moving else None
            if role == "adversary2":
                hero = run.get("hero")
                pairs = []
                for k in range(0, len(tr.t), 40):
                    j = hero.at(tr.t[k])
                    if j is not None:
                        pairs.append([round(tr.t[k] - t0, 1), round(tr.speed[k], 2), round(hero.speed[j], 2)])
                info["speed_vs_ego"] = pairs[:8]
        out[role] = info
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("filters", nargs="*")
    ap.add_argument("--timeout", type=int, default=200)
    ap.add_argument("--out", default=os.path.join(HERE, "artifacts", "actions_ext_carla.json"))
    args = ap.parse_args()
    cases = [c for c in CASES if not args.filters or any(f in c["name"] for f in args.filters)]
    built = build(cases)
    results = []
    for b in built:
        print(f"\n=== {b['name']}", flush=True)
        res = R.run_case(
            {"name": b["name"], "props": False}, b["xosc"], b["scenario"], keep_video=False, timeout=args.timeout
        )
        j = judge(b, res)
        j["preview"] = {"fired": b["predicted"]["fired"], "completed": b["predicted"]["completed"]}
        print(json.dumps(j, indent=1), flush=True)
        results.append(j)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump(results, fh, indent=1)
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
