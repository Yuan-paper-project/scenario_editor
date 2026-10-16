"""Run one built .xosc through run.sh with the telemetry sidecar beside it.

Shared by the CARLA runners in this folder (run_generated_carla.py and the others).
This monopolises CARLA on port 2010 (run.sh's) and runs strictly sequentially —
run.sh's cleanup does `pkill -f scenario_runner.py`, so two at once would kill each other.
"""

import json
import os
import shutil
import subprocess
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))

RUN_SH = "/home/dellpro2/Antonio/run.sh"
SR_ROOT = "/home/dellpro2/Antonio/scenario_runner"
SCENARIO_DIR = os.path.join(SR_ROOT, "srunner/examples/scenario_tester")
RECORDINGS = "/home/dellpro2/Antonio/recordings"
ARTIFACTS = os.path.join(os.path.dirname(HERE), "artifacts")
CARLA_PY = "/home/dellpro2/Antonio/carla-venv/bin/python"
# The port run.sh starts (and reuses) CARLA on. The telemetry sidecar must
# attach to the SAME server — its own default (3000) is a leftover from before
# run.sh moved to 2010, and attaching there records nothing or someone else's.
CARLA_PORT = 2010
CARLA_ROOT = "/home/dellpro2/CC/carla_0.9.15"
CARLA_PYTHONPATH = ":".join(
    [
        f"{CARLA_ROOT}/PythonAPI/carla/dist/carla-0.9.15-cp310-cp310-linux_x86_64.egg",
        f"{CARLA_ROOT}/PythonAPI/carla",
        f"{CARLA_ROOT}/PythonAPI",
    ]
)


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
    for pattern in ("scenario_runner.py", "automatic_control_1.py", "bg_traffic_player.py"):
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
    sidecar_cmd = [CARLA_PY, os.path.join(HERE, "carla_telemetry.py"), "--out", csv_path, "--port", str(CARLA_PORT)]
    if not case.get("props"):
        sidecar_cmd.append("--vehicles-only")
    sidecar = subprocess.Popen(sidecar_cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(1.0)

    started = time.time()
    timed_out = False
    run_env = dict(os.environ, SCENARIO_FILE=scenario_rel)
    # start_new_session so the whole run.sh process group can be killed;
    # subprocess timeouts only reach the direct child, and run.sh's children
    # (scenario_runner, automatic_control, CARLA) are the ones that linger.
    with open(log_path, "w") as log:
        proc = subprocess.Popen(
            ["bash", RUN_SH], cwd=REPO, stdout=log, stderr=subprocess.STDOUT, env=run_env, start_new_session=True
        )
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
        fresh = [
            d
            for d in os.listdir(RECORDINGS)
            if d.startswith("test__") and os.path.getmtime(os.path.join(RECORDINGS, d)) >= started - 2
        ]
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
