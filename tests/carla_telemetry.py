"""Passive per-tick telemetry logger for a running CARLA scenario.

The editor's only feedback loop today is an MP4: `osc_ego_recorder.py` writes
FPV/BEV/THD video and nothing numeric, so "did the NPC actually reach 10 m/s
five seconds in" can only be answered by eye. This writes the numbers instead.

Run it alongside `/home/dellpro2/Antonio/run.sh`; it attaches to the same CARLA,
records one CSV row per actor per tick, and exits on SIGINT/SIGTERM.

    source /home/dellpro2/Antonio/carla-venv/bin/activate
    export PYTHONPATH="/home/dellpro2/CC/carla_0.9.15/PythonAPI/carla/dist/carla-0.9.15-cp310-cp310-linux_x86_64.egg:/home/dellpro2/CC/carla_0.9.15/PythonAPI/carla:/home/dellpro2/CC/carla_0.9.15/PythonAPI"
    python tests/carla_telemetry.py --out /tmp/probe.csv --seconds 10

THE ONE RULE: never call world.tick(). ScenarioRunner owns the clock in
synchronous mode; a second ticking client advances the world underneath it and
silently corrupts every timing measurement this file exists to produce. Both
read paths here (on_tick, wait_for_tick) are passive.
"""
import argparse
import csv
import math
import os
import signal
import sys
import threading
import time

try:
    import carla  # type: ignore
except ImportError:
    sys.exit(
        "carla module not importable. Use the carla-venv interpreter and export\n"
        "PYTHONPATH to the 0.9.15 egg — see the docstring above."
    )

COLUMNS = [
    "frame", "sim_time", "actor_id", "type_id", "role_name",
    "x", "y", "z", "yaw", "vx", "vy", "vz", "speed",
]


class ActorNames:
    """actor_id -> (type_id, role_name), polled on a background thread.

    Actors appear mid-run (ScenarioRunner spawns NPCs after the ego), so the
    cache cannot be built once at start. It also cannot be built lazily at CSV
    write time: by then the scenario has torn down and world.get_actors()
    returns nothing, so every row resolves to a blank type_id — which silently
    produced an empty CSV the first time this ran. Names must be captured
    while the actors are still alive.

    role_name carries the OpenSCENARIO entity name — 'hero', 'adversary',
    'adversary1', ... — which is what the assertions key on; see
    backend/scenario_io.py's actor_refs mapping.
    """

    def __init__(self, world):
        self._world = world
        self._cache = {}
        self._lock = threading.Lock()

    def refresh(self):
        try:
            actors = list(self._world.get_actors())
        except RuntimeError:
            return  # world went away mid-teardown; keep whatever we have
        with self._lock:
            for actor in actors:
                self._cache[actor.id] = (
                    actor.type_id,
                    actor.attributes.get("role_name", "") or "",
                )

    def poll_until(self, stop_event, interval=0.4):
        while not stop_event.is_set():
            self.refresh()
            stop_event.wait(interval)

    def get(self, actor_id):
        with self._lock:
            return self._cache.get(actor_id, ("", ""))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", required=True, help="CSV output path")
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--port", type=int, default=3000)
    ap.add_argument("--seconds", type=float, default=0.0,
                    help="stop after N wall-clock seconds (0 = until signalled)")
    ap.add_argument("--recorder", default=None,
                    help="also write CARLA's own binary recording to this path, "
                         "for replaying a failed assertion by eye")
    ap.add_argument("--vehicles-only", action="store_true",
                    help="skip sensors/props/controllers (smaller CSV)")
    args = ap.parse_args()

    client = carla.Client(args.host, args.port)
    client.set_timeout(20.0)
    world = client.get_world()

    settings = world.get_settings()
    print(f"[telemetry] connected to {args.host}:{args.port} "
          f"map={world.get_map().name} sync={settings.synchronous_mode} "
          f"fixed_delta={settings.fixed_delta_seconds}")
    # Deliberately NOT calling world.apply_settings(): even a no-op write can
    # race ScenarioRunner's own settings handshake.

    names = ActorNames(world)
    names.refresh()

    if args.recorder:
        # CARLA wants an absolute path; it resolves relatives against its own cwd.
        client.start_recorder(os.path.abspath(args.recorder), True)
        print(f"[telemetry] CARLA recorder -> {os.path.abspath(args.recorder)}")

    rows = []
    rows_lock = threading.Lock()
    stop = threading.Event()

    def on_tick(snapshot):
        # Runs on CARLA's callback thread: buffer only, no I/O, no world calls
        # that could block the tick.
        batch = []
        for actor_snap in snapshot:
            if not isinstance(actor_snap, carla.ActorSnapshot):
                continue
            tf = actor_snap.get_transform()
            vel = actor_snap.get_velocity()
            batch.append((
                snapshot.frame,
                snapshot.timestamp.elapsed_seconds,
                actor_snap.id,
                tf.location.x, tf.location.y, tf.location.z,
                tf.rotation.yaw,
                vel.x, vel.y, vel.z,
            ))
        with rows_lock:
            rows.append(batch)

    callback_id = world.on_tick(on_tick)

    # Keep names fresh while the actors still exist (see ActorNames docstring).
    name_poller = threading.Thread(
        target=names.poll_until, args=(stop,), daemon=True)
    name_poller.start()

    def handle_signal(_signum, _frame):
        stop.set()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    started = time.time()
    print("[telemetry] recording (Ctrl-C or SIGTERM to stop)")
    warned_idle = False
    try:
        while not stop.is_set():
            if args.seconds and (time.time() - started) >= args.seconds:
                break
            # A sync-mode world with no client ticking it produces no callbacks
            # at all, which is indistinguishable from "the scenario has no
            # actors" unless we say so. This is the normal state between runs:
            # ScenarioRunner leaves synchronous_mode on when it exits.
            if (not warned_idle and not rows
                    and settings.synchronous_mode
                    and (time.time() - started) > 3.0):
                warned_idle = True
                print("[telemetry] no ticks after 3s — the world is in "
                      "synchronous mode and nothing is ticking it. Start the "
                      "scenario first; this logger never ticks.", file=sys.stderr)
            time.sleep(0.2)
    finally:
        stop.set()
        world.remove_on_tick(callback_id)
        if args.recorder:
            client.stop_recorder()

        with rows_lock:
            batches = list(rows)

        n = 0
        seen_roles = {}
        anonymous = {}
        os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
        with open(args.out, "w", newline="") as fh:
            writer = csv.writer(fh)
            writer.writerow(COLUMNS)
            for batch in batches:
                for (frame, sim_time, aid, x, y, z, yaw, vx, vy, vz) in batch:
                    type_id, role = names.get(aid)
                    is_actor = (type_id.startswith("vehicle.")
                                or type_id.startswith("walker."))
                    if args.vehicles_only and not is_actor:
                        continue
                    writer.writerow([
                        frame, f"{sim_time:.4f}", aid, type_id, role,
                        f"{x:.4f}", f"{y:.4f}", f"{z:.4f}", f"{yaw:.4f}",
                        f"{vx:.4f}", f"{vy:.4f}", f"{vz:.4f}",
                        f"{math.sqrt(vx * vx + vy * vy + vz * vz):.4f}",
                    ])
                    n += 1
                    if role:
                        seen_roles[role] = type_id
                    elif is_actor:
                        anonymous[aid] = type_id

        span = (batches[-1][0][1] - batches[0][0][1]) if batches else 0.0
        print(f"[telemetry] {n} rows over {len(batches)} ticks "
              f"({span:.1f}s sim) -> {args.out}")
        for role, type_id in sorted(seen_roles.items()):
            print(f"[telemetry]   {role:<14} {type_id}")
        # Only vehicles/walkers matter here; the map's traffic lights, speed
        # limit signs and static meshes are legitimately unnamed.
        for aid, type_id in sorted(anonymous.items()):
            print(f"[telemetry]   warning: actor {aid} ({type_id}) has no "
                  f"role_name — identify it by type_id + spawn order",
                  file=sys.stderr)
        if not seen_roles:
            print("[telemetry]   no named actors seen — was a scenario running?",
                  file=sys.stderr)


if __name__ == "__main__":
    main()
