"""Run the CARLA cases end to end and report what actually happened.

    bash run.sh 9090                      # terminal 1: the editor
    .venv/bin/python3 tests/run_carla_cases.py            # all cases
    .venv/bin/python3 tests/run_carla_cases.py tpl-stopping evt-assign-route

Per case: build the .xosc through the real editor, start the telemetry sidecar,
run /home/dellpro2/Antonio/run.sh against it, then judge the result against
BOTH ScenarioRunner's OSC lifecycle log (did the trigger fire, when) and the
telemetry (did the actor actually do it). Artifacts land in tests/artifacts/.

This monopolises CARLA on port 3000 for the duration and runs strictly
sequentially — run.sh's cleanup does `pkill -f scenario_runner.py`, so two at
once would kill each other.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import carla_analysis as A  # noqa: E402
import carla_cases as C  # noqa: E402
import _harness as H  # noqa: E402

RUN_SH = "/home/dellpro2/Antonio/run.sh"
SR_ROOT = "/home/dellpro2/Antonio/scenario_runner"
SCENARIO_DIR = os.path.join(SR_ROOT, "srunner/examples/scenario_tester")
RECORDINGS = "/home/dellpro2/Antonio/recordings"
ARTIFACTS = os.path.join(HERE, "artifacts")
CARLA_PY = "/home/dellpro2/Antonio/carla-venv/bin/python"
CARLA_ROOT = "/home/dellpro2/CC/carla_0.9.15"
CARLA_PYTHONPATH = ":".join([
    f"{CARLA_ROOT}/PythonAPI/carla/dist/carla-0.9.15-cp310-cp310-linux_x86_64.egg",
    f"{CARLA_ROOT}/PythonAPI/carla",
    f"{CARLA_ROOT}/PythonAPI",
])


# ── Scenario construction (browser) ──────────────────────────────────────────

def build_scenarios(cases):
    """-> {case_name: (xosc_text, scenario_json)}; one browser session for all.

    `scenario_json` is AppState.toJSON() — the editor's own save format, so the
    artifact it lands in can be re-opened with the Laden button.
    """
    from playwright.sync_api import sync_playwright

    built = {}
    with sync_playwright() as p:
        browser, page, errors = H.open_editor(p, "Town01")
        for case in cases:
            town = case.get("map", "Town01")
            ego = case.get("ego", C.EGO)
            # Real map selection, not just AppState.map: placement snapping
            # reads the loaded geometry, so a stale map silently snaps actors
            # into the wrong town's lanes.
            H.select_map(page, town)
            # Spell the weather keys out rather than passing {}: loadJSON copies
            # the object verbatim, so an empty one makes the captured
            # scenario.json differ from a hand-saved file. Harmless downstream —
            # the backend clamps only the keys it is given and compute_weather
            # reads each with .get(k, 0.0) — but the artifact is meant to be
            # indistinguishable from a real save.
            # z is seeded, not hardcoded. This used to be a flat 0.2, which is
            # only ever right on a flat town — on Town03 road 67 it put the ego
            # 2.4 m under the road it was supposed to drive on. A case may state
            # its own z (the Town03 poses do, since those numbers are the point);
            # otherwise it comes from the editor's own derivation, the same call
            # a map click makes.
            page.evaluate("""({town, ego}) => AppState.loadJSON({
                map:town, time:'daytime',
                weather:{fog:0, rainy:0, cloudy:0, sunny:0,
                         wet_road:0, snowy:0, dust_storm:0},
                ego:{id:'obj-1', type:'ego', x:ego.x, y:ego.y,
                     z:ego.z ?? ObjectsManager.surfaceZFor('ego', ego.x, ego.y),
                     yaw:ego.yaw, trajectory:[], events:[]},
                npcs:[], staticObjects:[], trafficSignals:[]})""",
                          {"town": town, "ego": ego})

            if case["kind"] == "template":
                # Real template button + real map click, so the template
                # mechanism itself is under test and not bypassed.
                actor = H.place_template(page, case["template"], *case["spot"])
                # Override the yaw ONLY where the case asks for it. For a car
                # with no placement rule the yaw comes from the nearest spawn
                # point, which can face back up the road, so those cases pin it
                # to the ego's direction and the run measures the event chain
                # rather than a head-on.
                #
                # This must never be a blanket default. Pedestrians, children
                # and cyclists are placed by _roadFacingYaw PERPENDICULAR to
                # the lane — that yaw IS the crossing, and it is the only thing
                # that makes a crossing case a crossing. Forcing 180 turns
                # every one of them into a walk down the carriageway, and does
                # it silently: PedestrianControl re-reads the spawn heading on
                # every tick when it has no waypoints, so the scenario still
                # runs, still reaches its target speed, and still passes any
                # check that only looks at speed.
                if "npc_yaw" in case:
                    page.evaluate("({id, yaw}) => AppState.updateById(id, {yaw})",
                                  {"id": actor["id"], "yaw": case["npc_yaw"]})
            elif case["kind"] == "scene":
                # Several NPCs and/or props in one scenario — the benchmark
                # cases, where "an adversary cuts in while another brakes ahead"
                # needs two actors and "the lane is blocked" needs props.
                #
                # NPCs are seeded for the same reason the `events` kind seeds
                # them: the benchmark description pins exact lanes and exact
                # speeds, and a placement click quantised to whole pixels cannot
                # hit a 3.5 m lane reliably at whole-town zoom. Props are NOT
                # seeded — see H.place_prop.
                #
                # Array order is load-bearing: buildScenarioParams names npcs
                # `adversary`, `adversary1`, ... by index, so the case's npc list
                # order IS the entity-ref order the expectations read back.
                # Trajectory and route waypoints get their z here too, from the
                # same call the map-click path uses. A case never writes a
                # literal z: on a graded corridor a flat 0.2 puts the waypoint
                # under the road, and ChangeActorWaypoints then plans through
                # the deck.
                page.evaluate("""(npcs) => {
                    const wz = (p) => ({...p,
                        z: ObjectsManager.surfaceZFor('waypoint', p.x, p.y)});
                    AppState.npcs = npcs.map((n, i) => ({
                        id: `obj-${i + 2}`, type: n.type,
                        x: n.spot[0], y: n.spot[1], yaw: n.yaw,
                        z: ObjectsManager.surfaceZFor(n.type, n.spot[0], n.spot[1]),
                        behaviors: ['constant_speed'], trigger_distance: 400,
                        events: (n.events || []).map(ev => {
                            const a = ev.action || {};
                            return {...ev, action: {...a,
                                ...(a.trajectory ? {trajectory: a.trajectory.map(wz)} : {}),
                                ...(a.waypoints ? {waypoints: a.waypoints.map(wz)} : {})}};
                        })}));
                    AppState.set({});
                }""", [{"type": n["type"], "spot": list(n["spot"]),
                        "yaw": n.get("yaw", 180), "events": n.get("events", [])}
                       for n in case["npcs"]])
            else:
                # Seeded directly, so the pose comes entirely from the case.
                # 180 (the ego's direction) suits the in-lane vehicle cases;
                # a crossing case has to state its own yaw, as
                # act-child-crossing does.
                # Same reasoning as the ego's z above. A seeded NPC bypasses the
                # placement click, so it has to ask for the height explicitly —
                # a template-placed one already got it from the real click path.
                page.evaluate("""(c) => {
                    const npc = {id:'obj-2', type:c.npc_type,
                                 x:c.spot[0], y:c.spot[1], yaw:c.yaw,
                                 z:ObjectsManager.surfaceZFor(c.npc_type,
                                                              c.spot[0], c.spot[1]),
                                 behaviors:['constant_speed'],
                                 trigger_distance:400, events:c.events};
                    AppState.npcs = [npc];
                    AppState.set({});
                }""", {"npc_type": case["npc_type"], "spot": list(case["spot"]),
                       "yaw": case.get("npc_yaw", 180), "events": case["events"]})

            # Props last, and for any kind: the prop tool is sticky and shares
            # the map with the actor tools, so arming it before an actor click
            # would drop a cone where the actor should have gone.
            for prop in case.get("props", []):
                placed = H.place_prop(page, prop["prop"], *prop["spot"])
                # The per-lane facing rule already ran at placement. A case only
                # overrides it when the description pins an orientation the rule
                # cannot express (see the prop tables in CLAUDE.md).
                if "yaw" in prop:
                    page.evaluate(
                        """({id, yaw}) => { AppState.staticObjects =
                             AppState.staticObjects.map(p =>
                               p.id === id ? {...p, yaw} : p);
                           AppState.set({}); }""",
                        {"id": placed["id"], "yaw": prop["yaw"]})

            # Captured here, not after export: this is the exact state the
            # .xosc alongside it was built from. toJSON() is the Speichern
            # button's serialiser, so the artifact loads back with no
            # conversion.
            scenario = page.evaluate("AppState.toJSON()")
            built[case["name"]] = (H.export_xosc(page), scenario)

        if errors:
            print(f"[build] JS errors during construction: {errors[:3]}",
                  file=sys.stderr)
        browser.close()
    return built


# ── One CARLA run ────────────────────────────────────────────────────────────

def kill_stragglers():
    """Make sure nothing from a previous case is still ticking the world.

    This is not paranoia. A scenario whose storyboard never completes leaves
    scenario_runner alive even after it prints "No more scenarios .... Exiting"
    — a lane_change action that never reaches END does exactly that. run.sh
    then blocks in `wait`, our timeout kills only the bash we spawned, and the
    orphaned scenario_runner keeps ticking CARLA underneath the NEXT case. The
    symptom is subtle and awful: the next case's distance triggers fire off the
    60 s TimeFallback instead of their real condition, and it looks like a
    trigger bug rather than contamination.
    """
    for pattern in ("scenario_runner.py", "automatic_control_1.py"):
        subprocess.run(["pkill", "-f", pattern], capture_output=True)
    time.sleep(1.0)


def run_case(case, xosc_text, scenario, keep_video=True, timeout=180):
    name = case["name"]
    outdir = os.path.join(ARTIFACTS, name)
    os.makedirs(outdir, exist_ok=True)

    scenario_rel = f"srunner/examples/scenario_tester/gui_test_{name}.xosc"
    scenario_abs = os.path.join(SR_ROOT, scenario_rel)
    with open(scenario_abs, "w") as fh:
        fh.write(xosc_text)
    shutil.copy(scenario_abs, os.path.join(outdir, f"{name}.xosc"))
    # The editor's save format, indent and all — drop it on the Laden button to
    # reopen the case exactly as the harness built it.
    with open(os.path.join(outdir, "scenario.json"), "w") as fh:
        json.dump(scenario, fh, indent=2)

    csv_path = os.path.join(outdir, "telemetry.csv")
    log_path = os.path.join(outdir, "run.log")

    kill_stragglers()

    env = dict(os.environ, PYTHONPATH=CARLA_PYTHONPATH)
    # --vehicles-only drops everything that is not a vehicle or a walker, which
    # includes <MiscObject> props. A prop case's central question is whether the
    # prop reached CARLA at the pose the editor placed it, so those cases record
    # the whole world instead. Everything else keeps the narrow filter — the map
    # contributes hundreds of unnamed static meshes per tick.
    sidecar_cmd = [CARLA_PY, os.path.join(HERE, "carla_telemetry.py"),
                   "--out", csv_path]
    if not case.get("props"):
        sidecar_cmd.append("--vehicles-only")
    sidecar = subprocess.Popen(
        sidecar_cmd,
        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(1.0)

    started = time.time()
    timed_out = False
    # The ego's destination. run.sh defaults to the Town01 pose, which is
    # meaningless anywhere else — a case on another town that omits "goal" would
    # have set_destination snap that Town01 point to some arbitrary local
    # waypoint and the ego would drive a route nobody chose.
    run_env = dict(os.environ, SCENARIO_FILE=scenario_rel)
    if case.get("goal"):
        run_env["SCENARIO_GOAL"] = case["goal"]
    # start_new_session so the whole run.sh process group can be killed;
    # subprocess timeouts only reach the direct child, and run.sh's children
    # (scenario_runner, automatic_control, CARLA) are the ones that linger.
    with open(log_path, "w") as log:
        proc = subprocess.Popen(
            ["bash", RUN_SH], cwd=REPO, stdout=log, stderr=subprocess.STDOUT,
            env=run_env, start_new_session=True)
        try:
            returncode = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            returncode = None
            try:
                os.killpg(os.getpgid(proc.pid), 15)
                proc.wait(timeout=15)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(os.getpgid(proc.pid), 9)
                except ProcessLookupError:
                    pass
    elapsed = time.time() - started

    # Always stop the sidecar — it writes its CSV on the way out, so skipping
    # this on the timeout path loses the very data needed to see what hung.
    sidecar.terminate()
    try:
        sidecar_out = sidecar.communicate(timeout=30)[0]
    except subprocess.TimeoutExpired:
        sidecar.kill()
        sidecar_out = sidecar.communicate()[0]
    with open(os.path.join(outdir, "telemetry.log"), "w") as fh:
        fh.write(sidecar_out or "")
    kill_stragglers()

    # run.sh hardcodes --record-prefix test, so every run lands in a
    # timestamped test__<Town>__* directory. Claim the one this run produced
    # and give it the case's name, matching the existing assign_route/,
    # pedestrian/ convention in recordings/.
    video_dir = None
    if keep_video and os.path.isdir(RECORDINGS):
        fresh = [d for d in os.listdir(RECORDINGS)
                 if d.startswith("test__")
                 and os.path.getmtime(os.path.join(RECORDINGS, d)) >= started - 2]
        if fresh:
            newest = max(fresh, key=lambda d: os.path.getmtime(os.path.join(RECORDINGS, d)))
            target = os.path.join(RECORDINGS, f"gui_test_{name}")
            if os.path.isdir(target):
                shutil.rmtree(target)
            shutil.move(os.path.join(RECORDINGS, newest), target)
            video_dir = target

    return {
        "returncode": returncode,
        "timed_out": timed_out,
        "elapsed": elapsed,
        "csv": csv_path,
        "log": log_path,
        "video": video_dir,
        "xosc": scenario_abs,
    }


# ── Judging ──────────────────────────────────────────────────────────────────

def judge(case, result):
    """-> (rows, notes). rows are (label, ok, detail)."""
    notes = []
    try:
        run = A.Run(result["csv"])
    except FileNotFoundError:
        return [("telemetry captured", False, "no CSV written")], notes
    osc = A.parse_osc_log(result["log"])
    timeline = A.event_timeline(osc)

    notes.extend(A.summarise(run))
    if timeline:
        notes.append("events: " + ", ".join(
            f"{n}@{t['start']}s->{t['end']}s" for n, t in sorted(timeline.items())))
    else:
        notes.append("events: NONE — ScenarioRunner logged no [OSC][EVENT] lines")

    # A hang is a result, not a harness problem: the telemetry and the OSC log
    # up to that point are still valid, and the remaining expectations are
    # still worth evaluating to see how far the chain got.
    if result.get("timed_out"):
        unfinished = sorted(n for n, t in timeline.items() if t["end"] is None)
        notes.append(f"RUN HUNG after {result['elapsed']:.0f}s; "
                     f"events still RUNNING at the end: {unfinished or 'none'}")
    # A scene case names its own entity refs by npc index, the same mapping
    # buildScenarioParams and validate_scenario_params both apply.
    n_npcs = len(case.get("npcs", [])) or 1
    refs = ["adversary" if i == 0 else f"adversary{i}" for i in range(n_npcs)]

    rows = [
        ("scenario terminated on its own",
         not result.get("timed_out") and result["returncode"] == 0,
         f"timed out after {result['elapsed']:.0f}s"
         if result.get("timed_out") else f"run.sh exit {result['returncode']}"),
        ("telemetry captured every actor",
         "hero" in run and all(r in run for r in refs),
         f"want hero + {refs}; roles: {sorted(run.tracks)}"),
        ("the act started (ego moved)", run.act_start() is not None, ""),
    ]
    if run.act_start() is None:
        return rows, notes

    try:
        rows.extend(C.EXPECTATIONS[case["name"]](run, timeline))
    except Exception as exc:  # a broken predicate must not look like a pass
        rows.append((f"expectations evaluated", False,
                     f"{type(exc).__name__}: {exc}"))

    # A perfect speed trace that ended in a crash is not a pass. Many benchmark
    # descriptions ARE collisions; the cases below reproduce the conflict that
    # leads to one and assert the near miss, because a real impact ends the run
    # and makes every trace after it meaningless. That substitution is recorded
    # per case as a fidelity delta, not papered over here.
    for ref in refs:
        dist, when = A.closest_approach(run, "hero", ref)
        if dist is not None:
            rows.append((f"no ego/{ref} collision", dist > 1.5,
                         f"closest {dist:.2f} m at t={when:+.1f}s"))
    return rows, notes


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("cases", nargs="*", help="case names (default: all)")
    ap.add_argument("--no-video", action="store_true")
    ap.add_argument("--timeout", type=int, default=180,
                    help="per-case wall-clock limit; a healthy run takes ~15 s")
    args = ap.parse_args()

    selected = ([C.CASES_BY_NAME[n] for n in args.cases]
                if args.cases else C.CASES)
    os.makedirs(ARTIFACTS, exist_ok=True)

    print("NOTE: xml_builder reads ../llm-scenario-gen once at import and "
          "--reload does not watch it.\n      Restart the editor if you "
          "changed that repo, or you will test the old exporter.\n")
    for repo in (REPO, "/home/dellpro2/Antonio/llm-scenario-gen"):
        head = subprocess.run(["git", "-C", repo, "rev-parse", "--short", "HEAD"],
                              capture_output=True, text=True).stdout.strip()
        dirty = subprocess.run(["git", "-C", repo, "status", "--porcelain"],
                               capture_output=True, text=True).stdout.strip()
        print(f"  {os.path.basename(repo):<20} {head}"
              f"{' (dirty)' if dirty else ''}")
    print()

    print(f"Building {len(selected)} scenario(s) through the editor...")
    built = build_scenarios(selected)

    summary = []
    for i, case in enumerate(selected, 1):
        name = case["name"]
        xosc_text, scenario = built[name]
        print(f"\n{'='*72}\n[{i}/{len(selected)}] {name} — {case['note']}\n{'='*72}")
        result = run_case(case, xosc_text, scenario, keep_video=not args.no_video,
                          timeout=args.timeout)
        rows, notes = judge(case, result)
        for note in notes:
            print(f"  · {note}")
        print()
        for label, ok, detail in rows:
            print(("  PASS  " if ok else "  FAIL  ") + label
                  + (f"   [{detail}]" if detail and not ok else
                     f"   ({detail})" if detail else ""))
        n_ok = sum(1 for _, ok, _ in rows if ok)
        fails = [f"{label}: {detail}" for label, ok, detail in rows if not ok]
        summary.append((name, n_ok, len(rows) - n_ok, fails))
        print(f"\n  {n_ok}/{len(rows)} checks passed in {result['elapsed']:.0f}s"
              f"{'  video: ' + os.path.basename(result['video']) if result['video'] else ''}")

    print(f"\n{'='*72}\nSUMMARY\n{'='*72}")
    total_fail = 0
    for name, n_ok, n_fail, fails in summary:
        status = "PASS" if n_fail == 0 else f"FAIL ({n_fail})"
        print(f"  {status:<10} {name:<26} {n_ok}/{n_ok+n_fail}")
        for f in fails:
            print(f"             - {f}")
        total_fail += n_fail
    print(f"\nartifacts: {ARTIFACTS}/<case>/  (scenario.json, telemetry.csv, "
          f"telemetry.log, run.log, *.xosc)")
    return 1 if total_fail else 0


if __name__ == "__main__":
    sys.exit(main())
