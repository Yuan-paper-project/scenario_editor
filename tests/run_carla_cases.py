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
    """-> {case_name: (xosc_text, npc_pose)}; one browser session for all."""
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
            page.evaluate("""({town, ego}) => AppState.loadJSON({
                map:town, weather:{}, time:'daytime',
                ego:{id:'obj-1', type:'ego', x:ego.x, y:ego.y, z:0.2,
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
            else:
                # Seeded directly, so the pose comes entirely from the case.
                # 180 (the ego's direction) suits the in-lane vehicle cases;
                # a crossing case has to state its own yaw, as
                # act-child-crossing does.
                page.evaluate("""(c) => {
                    const npc = {id:'obj-2', type:c.npc_type,
                                 x:c.spot[0], y:c.spot[1], z:0.2, yaw:c.yaw,
                                 behaviors:['constant_speed'],
                                 trigger_distance:400, events:c.events};
                    AppState.npcs = [npc];
                    AppState.set({});
                }""", {"npc_type": case["npc_type"], "spot": list(case["spot"]),
                       "yaw": case.get("npc_yaw", 180), "events": case["events"]})

            pose = page.evaluate("AppState.npcs[0]")
            built[case["name"]] = (H.export_xosc(page), pose)

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


def run_case(case, xosc_text, pose, keep_video=True, timeout=180):
    name = case["name"]
    outdir = os.path.join(ARTIFACTS, name)
    os.makedirs(outdir, exist_ok=True)

    scenario_rel = f"srunner/examples/scenario_tester/gui_test_{name}.xosc"
    scenario_abs = os.path.join(SR_ROOT, scenario_rel)
    with open(scenario_abs, "w") as fh:
        fh.write(xosc_text)
    shutil.copy(scenario_abs, os.path.join(outdir, f"{name}.xosc"))
    with open(os.path.join(outdir, "npc_pose.json"), "w") as fh:
        json.dump(pose, fh, indent=2)

    csv_path = os.path.join(outdir, "telemetry.csv")
    log_path = os.path.join(outdir, "run.log")

    kill_stragglers()

    env = dict(os.environ, PYTHONPATH=CARLA_PYTHONPATH)
    sidecar = subprocess.Popen(
        [CARLA_PY, os.path.join(HERE, "carla_telemetry.py"),
         "--out", csv_path, "--vehicles-only"],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(1.0)

    started = time.time()
    timed_out = False
    # start_new_session so the whole run.sh process group can be killed;
    # subprocess timeouts only reach the direct child, and run.sh's children
    # (scenario_runner, automatic_control, CARLA) are the ones that linger.
    with open(log_path, "w") as log:
        proc = subprocess.Popen(
            ["bash", RUN_SH], cwd=REPO, stdout=log, stderr=subprocess.STDOUT,
            env=dict(os.environ, SCENARIO_FILE=scenario_rel),
            start_new_session=True)
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
    rows = [
        ("scenario terminated on its own",
         not result.get("timed_out") and result["returncode"] == 0,
         f"timed out after {result['elapsed']:.0f}s"
         if result.get("timed_out") else f"run.sh exit {result['returncode']}"),
        ("telemetry captured both actors",
         "hero" in run and "adversary" in run, f"roles: {sorted(run.tracks)}"),
        ("the act started (ego moved)", run.act_start() is not None, ""),
    ]
    if run.act_start() is None:
        return rows, notes

    try:
        rows.extend(C.EXPECTATIONS[case["name"]](run, timeline))
    except Exception as exc:  # a broken predicate must not look like a pass
        rows.append((f"expectations evaluated", False,
                     f"{type(exc).__name__}: {exc}"))

    # A perfect speed trace that ended in a crash is not a pass.
    dist, when = A.closest_approach(run, "hero", "adversary")
    if dist is not None:
        rows.append(("no ego/npc collision", dist > 1.5,
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
        xosc_text, pose = built[name]
        print(f"\n{'='*72}\n[{i}/{len(selected)}] {name} — {case['note']}\n{'='*72}")
        result = run_case(case, xosc_text, pose, keep_video=not args.no_video,
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
    print(f"\nartifacts: {ARTIFACTS}/<case>/  (telemetry.csv, run.log, *.xosc)")
    return 1 if total_fail else 0


if __name__ == "__main__":
    sys.exit(main())
