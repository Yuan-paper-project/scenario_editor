"""Run generator-built scenarios in real CARLA and report what happened.

    .venv/bin/python3 tests/carla/run_generated_carla.py Town03:cut_in:3 Town05:vru_crossing:7
    .venv/bin/python3 tests/carla/run_generated_carla.py --sample 6 --towns Town03,Town05

Each spec is town:type:seed, optionally followed by @{json} with pinned
recipe values (Town03:junction_conflict:2@{"layout":"ego_left_oncoming"}),
optionally :weather:time (before the @) with a generator
weather preset (klar, bewoelkt, regen, starkregen, nebel, nass) and an
editor time key (daytime, morning, dusk, nighttime). The scenario is built through the real editor
(ScenarioGenerator.generate, then the export endpoint), run through
/home/dellpro2/Antonio/run.sh with the scripted ego, and judged from the OSC log
and the telemetry CSV — the same two sources run_carla_cases.py uses, through
its own run_case().

What a generated scenario has to show here is not a pass/fail expectation but
an INTERACTION: the NPC's ego-relative trigger fires, and the two actors then
come close. With the scripted ego (consider_obstacles on) a near miss is the
expected outcome — the ego brakes — so the report gives the closest approach
and how much the ego slowed, and the preview's own prediction beside it.

Needs CARLA on run.sh's port (2010) and the editor on :9090. Not part of
run_tests.sh, for the same reasons run_carla_cases.py is not.
"""

import argparse
import json
import os
import random
import sys

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "e2e"))
import _harness as H  # noqa: E402
import carla_analysis as A  # noqa: E402
import carla_run as R  # noqa: E402

TYPES = ["lead_brake", "cut_in", "vru_crossing", "junction_conflict", "obstacle", "slow_lead", "turn_vru", "pull_out"]

PREDICT = """() => {
  const run = Simulate.runHeadless({ dt: 0.05, maxTime: 45 });
  const ego = run.tracks[run.egoId];
  const out = {};
  AppState.npcs.forEach((npc, i) => {
    const tr = run.tracks[npc.id];
    let min = Infinity;
    for (let k = 0; k < tr.length; k++) min = Math.min(min, Math.hypot(tr[k].x - ego[k].x, tr[k].y - ego[k].y));
    out[i === 0 ? 'adversary' : 'adversary' + i] = Math.round(min * 10) / 10;
  });
  return out;
}"""


def build(specs):
    built = []
    with sync_playwright() as p:
        browser, page, errors = H.open_editor(p, specs[0][0])
        for town, typ, seed, weather, tod, pins in specs:
            H.select_map(page, town)
            page.wait_for_function("AppState.laneGraph !== null", timeout=60000)
            info = page.evaluate(
                "([t, s, o]) => ScenarioGenerator.generate(t, s, o ? { overrides: o } : {})", [typ, seed, pins]
            )
            if weather:
                page.evaluate(
                    "([w, t]) => { AppState.weather = ScenarioGenerator.weatherPreset(w); AppState.time = t; }",
                    [weather, tod or "daytime"],
                )
            if not info:
                print(f"[build] {town}:{typ}:{seed} — no scenario on this map")
                continue
            predicted = page.evaluate(PREDICT)
            scenario = page.evaluate("AppState.toJSON()")
            xosc = H.xosc_from_params(page, page.evaluate("ScenarioIO.buildParamsForTesting()"))
            npc_types = [n["type"] for n in scenario["npcs"]]
            pin_tag = "-" + "-".join(f"{k}{v}" for k, v in sorted(pins.items())) if pins else ""
            built.append(
                {
                    "name": f"gen-{town}-{typ}-{seed}" + (f"-{weather}-{tod}" if weather else "") + pin_tag,
                    "town": town,
                    "type": typ,
                    "seed": seed,
                    "info": info,
                    "xosc": xosc,
                    "scenario": scenario,
                    "predicted": predicted,
                    "npc_types": npc_types,
                    "props": bool(scenario["staticObjects"]),
                }
            )
        browser.close()
    return built


def judge(b, result):
    out = {
        "name": b["name"],
        "params": b["info"]["params"],
        "predicted_min_m": b["predicted"],
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
    out["roles"] = sorted(run.tracks)
    hero = run.get("hero")
    if hero:
        out["ego_travel_m"] = round(hero.distance_travelled(), 1)
        out["ego_max_speed"] = round(max(hero.speed), 1)
    out["closest_m"] = {}
    for i in range(len(b["npc_types"])):
        ref = "adversary" if i == 0 else f"adversary{i}"
        d, t = A.closest_approach(run, "hero", ref)
        if d is not None:
            j = hero.at(t + (run.act_start() or 0.0)) if hero else None
            out["closest_m"][ref] = {
                "d": round(d, 2),
                "t": round(t, 1),
                "ego_speed_then": round(hero.speed[j], 1) if j is not None else None,
            }
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("specs", nargs="*", help="town:type:seed")
    ap.add_argument("--sample", type=int, default=0, help="also run N random town/type/seed picks")
    ap.add_argument("--towns", default="Town03,Town05,Town10HD")
    ap.add_argument("--timeout", type=int, default=240)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(HERE), "artifacts", "generated_carla.json"))
    args = ap.parse_args()

    specs = []
    for s in args.specs:
        s, _, pins = s.partition("@")
        parts = s.split(":") + [None, None]
        specs.append((parts[0], parts[1], int(parts[2]), parts[3], parts[4], json.loads(pins) if pins else None))
    rnd = random.Random(12345)
    for _ in range(args.sample):
        specs.append((rnd.choice(args.towns.split(",")), rnd.choice(TYPES), rnd.randint(1, 10**6), None, None, None))
    if not specs:
        ap.error("give town:type:seed specs or --sample N")

    built = build(specs)
    results = []
    for b in built:
        case = {"name": b["name"], "props": b["props"]}
        print(f"\n=== {b['name']}  {json.dumps(b['info']['params'])}", flush=True)
        res = R.run_case(case, b["xosc"], b["scenario"], keep_video=True, timeout=args.timeout)
        j = judge(b, res)
        print(json.dumps(j, indent=1), flush=True)
        results.append(j)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump(results, fh, indent=1)
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
