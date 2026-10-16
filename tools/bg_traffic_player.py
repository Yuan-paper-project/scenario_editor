"""Replay background traffic in CARLA as "puppets" (see backend/traffic/bg_traffic.py).

    PYTHONPATH=$CARLA_ROOT/PythonAPI/carla python tools/bg_traffic_player.py \
        scenario.bgtraffic.json [--host 127.0.0.1] [--port 2010]

Runs beside ScenarioRunner (started when run.sh finds `<scenario>.bgtraffic.json` next to the
.xosc) and never ticks the world. Each tick it commands the velocity that takes each car from
where it is to where the file has it one tick later — a closed loop, so the run shows the
preview's traffic (median 1 mm).

Velocity only: physics off + a transform per tick crashes this CARLA build as soon as two other
vehicles collide, and physics on + transforms crashes it under run.sh's cameras (CLAUDE.md).

t = 0 is the hero's first tick. Each entry is spawned at its t0 (role_name "background", on
CARLA's lane near SUMO's height) and removed after its last frame. Emergency stop: a car whose
next HOLD_LOOKAHEAD_S would bring it closer to and into a box around the ego or an NPC holds,
its clock stopped, and resumes later; holds are logged. Scenario actors' obstacle sensors see
these cars (tools/probes/probe_puppet_obstacle.py).
"""

import argparse
import json
import math
import signal
import sys
import time

import carla

ROLE = "background"
SPAWN_LIFT_M = 0.6  # spawned this high, put on the road one tick later
SPAWN_RETRIES = 3  # failed spawns are retried on the next ticks, higher
LAG_WARN_M = 2.0  # a car this far off its trajectory is reported (once)
HERO_WAIT_S = 180.0
HOLD_LOOKAHEAD_S = (0.5, 1.0, 1.5, 2.0)  # where the car will be, checked for a conflict
HOLD_LONG_M = 3.5  # + the car's half-length: box ahead/behind a scenario actor
HOLD_LAT_M = 1.6  # + the car's half-width: beside it (an adjacent lane is ~3.5 m)
ACTOR_REFRESH_S = 1.0  # how often the list of scenario actors is re-read
RESUME_CLEAR_S = 0.5  # a holding car resumes only after this long without a conflict


def _lerp_frame(frames, t, dt):
    """[x, y, z, yaw] at time t, interpolated between the file's samples."""
    f = t / dt
    i = int(math.floor(f))
    if i <= 0:
        return frames[0]
    if i >= len(frames) - 1:
        return frames[-1]
    a, b = frames[i], frames[i + 1]
    w = f - i
    dyaw = ((b[3] - a[3] + 540.0) % 360.0) - 180.0
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w, a[3] + dyaw * w]


class Player:
    """The file's entries as cars: each spawned at its t0, steered by t − t0, removed after its last frame."""

    def __init__(self, client, data, tick_dt):
        self.client = client
        self.tick_dt = tick_dt
        self.world = client.get_world()
        self.cmap = self.world.get_map()
        self.data = data
        self.dt = float(data["dt"])
        self.entries = data["vehicles"]
        self.t0 = [float(v.get("t0", 0.0)) for v in self.entries]
        self.t_end = [t + (len(v["frames"]) - 1) * self.dt for t, v in zip(self.t0, self.entries)]
        self.waiting = sorted(range(len(self.entries)), key=lambda i: self.t0[i])  # not yet spawned
        self.attempts = {}  # entry -> failed spawn attempts so far
        self.actors = {}  # entry -> actor id, while alive
        self.delay = [0.0] * len(self.entries)  # seconds each car has held so far
        self.holding = {}  # entry -> seconds clear so far, while holding
        self.holds = 0  # hold episodes over the run
        self.spawned = 0
        self.failed = 0
        self._warned = set()
        self._others = []  # scenario actor ids (hero + NPCs)
        self._others_at = -1e9

    def _transform(self, frame, lift=0.0):
        x, y, z_hint, yaw = frame
        wp = self.cmap.get_waypoint(
            carla.Location(x, y, z_hint), project_to_road=True, lane_type=carla.LaneType.Driving
        )
        if wp is not None and abs(wp.transform.location.z - z_hint) < 6.0:
            z, pitch = wp.transform.location.z, wp.transform.rotation.pitch
        else:
            z, pitch = z_hint, 0.0
        return carla.Transform(carla.Location(x, y, z + 0.02 + lift), carla.Rotation(pitch=pitch, yaw=yaw))

    def _spawn_due(self, t):
        """Spawn every entry whose t0 has come; a blocked spawn is retried higher, up to SPAWN_RETRIES."""
        due = [i for i in self.waiting if self.t0[i] <= t]
        due = [i for i in due if t <= self.t_end[i]]
        gone = [i for i in self.waiting if self.t0[i] <= t and t > self.t_end[i]]
        for i in gone:  # its whole life passed before it got in
            self.waiting.remove(i)
            self.failed += 1
        if not due:
            return
        lib = self.world.get_blueprint_library()
        cmds = []
        for i in due:
            v = self.entries[i]
            bp = lib.find(v["blueprint"])
            if bp.has_attribute("color") and v.get("color"):
                bp.set_attribute("color", v["color"])
            bp.set_attribute("role_name", ROLE)
            lift = SPAWN_LIFT_M * (1 + 2 * self.attempts.get(i, 0))
            cmds.append(
                carla.command.SpawnActor(
                    bp, self._transform(_lerp_frame(v["frames"], t - self.t0[i], self.dt), lift=lift)
                )
            )
        for i, resp in zip(due, self.client.apply_batch_sync(cmds, False)):
            if not resp.error:
                self.actors[i] = resp.actor_id
                self.waiting.remove(i)
                self.spawned += 1
                continue
            self.attempts[i] = self.attempts.get(i, 0) + 1
            if self.attempts[i] > SPAWN_RETRIES:
                self.waiting.remove(i)
                self.failed += 1
                print(
                    f"[bg_traffic] car {self.entries[i]['id']} ({self.entries[i]['blueprint']}) "
                    f"not spawned: {resp.error}",
                    flush=True,
                )

    def _remove_ended(self, t):
        ended = [i for i in self.actors if t > self.t_end[i] + self.delay[i] + self.tick_dt]
        if ended:
            self.client.apply_batch([carla.command.DestroyActor(self.actors.pop(i)) for i in ended])

    def step(self, t, snap):
        """Everything for the coming tick, whose snapshot is at time t."""
        self._remove_ended(t)
        self._spawn_due(t)
        self._refresh_others(t)
        self._place(t, snap)

    def _refresh_others(self, t):
        """Every vehicle and walker in the world that is not ours."""
        if t - self._others_at < ACTOR_REFRESH_S:
            return
        self._others_at = t
        ours = set(self.actors.values())
        try:
            found = self.world.get_actors()
        except RuntimeError:
            return
        self._others = [
            a.id
            for a in found
            if (a.type_id.startswith("vehicle.") or a.type_id.startswith("walker."))
            and a.id not in ours
            and a.attributes.get("role_name") != ROLE
        ]

    def _conflict(self, i, local, cur_xy, positions):
        """The scenario actor this car is about to run into, or None: a coming pose inside a box around
        it AND closer than now (a car moving away from someone behind it must not hold)."""
        v = self.entries[i]
        frames = v["frames"]
        long_m = float(v.get("length", 4.5)) / 2 + HOLD_LONG_M
        lat_m = float(v.get("width", 2.0)) / 2 + HOLD_LAT_M
        for dt_ahead in HOLD_LOOKAHEAD_S:
            fx, fy, _, fyaw = _lerp_frame(frames, local + dt_ahead, self.dt)
            c, s_ = math.cos(math.radians(fyaw)), math.sin(math.radians(fyaw))
            for aid, ax, ay in positions:
                dx, dy = ax - fx, ay - fy
                if (
                    abs(dx * c + dy * s_) < long_m
                    and abs(-dx * s_ + dy * c) < lat_m
                    and math.hypot(dx, dy) < math.hypot(ax - cur_xy[0], ay - cur_xy[1])
                ):
                    return aid
        return None

    def _place(self, t, snap):
        """Velocity commands from each car's actual position to the file's pose at t; z and pitch are physics'."""
        h = self.tick_dt
        cmds = []
        positions = []
        for oid in self._others:
            o = snap.find(oid)
            if o is not None:
                loc = o.get_transform().location
                positions.append((oid, loc.x, loc.y))
        for i, aid in self.actors.items():
            cur = snap.find(aid)
            if cur is None:
                continue
            tf = cur.get_transform()
            local = t - self.t0[i] - self.delay[i]
            who = self._conflict(i, local, (tf.location.x, tf.location.y), positions) if positions else None
            if who is None and i in self.holding:
                self.holding[i] += h
                if self.holding[i] < RESUME_CLEAR_S:
                    who = "-"  # clear, but not for long enough yet
            elif who is not None and i in self.holding:
                self.holding[i] = 0.0
            if who is not None:
                # Hold: the car's own clock stops with it.
                if i not in self.holding:
                    self.holding[i] = 0.0
                    self.holds += 1
                    print(f"[bg_traffic] car {self.entries[i]['id']} holds for actor {who} at t={t:.2f}", flush=True)
                self.delay[i] += h
                cmds.append(carla.command.ApplyTargetVelocity(aid, carla.Vector3D(0.0, 0.0, cur.get_velocity().z)))
                cmds.append(carla.command.ApplyTargetAngularVelocity(aid, carla.Vector3D(0.0, 0.0, 0.0)))
                continue
            if i in self.holding:
                del self.holding[i]
                print(
                    f"[bg_traffic] car {self.entries[i]['id']} resumes at t={t:.2f} "
                    f"({self.delay[i]:.1f} s behind the preview)",
                    flush=True,
                )
                local = t - self.t0[i] - self.delay[i]
            target = _lerp_frame(self.entries[i]["frames"], local, self.dt)
            ex, ey = target[0] - tf.location.x, target[1] - tf.location.y
            # not while settling after the spawn
            if local > 1.0 and math.hypot(ex, ey) > LAG_WARN_M and i not in self._warned:
                self._warned.add(i)
                print(
                    f"[bg_traffic] car {self.entries[i]['id']} is "
                    f"{math.hypot(ex, ey):.1f} m off its trajectory at t={t:.2f}",
                    flush=True,
                )
            dyaw = ((target[3] - tf.rotation.yaw + 540.0) % 360.0) - 180.0
            cmds.append(carla.command.ApplyTargetVelocity(aid, carla.Vector3D(ex / h, ey / h, cur.get_velocity().z)))
            cmds.append(carla.command.ApplyTargetAngularVelocity(aid, carla.Vector3D(0.0, 0.0, dyaw / h)))
        if cmds:
            self.client.apply_batch(cmds)

    def destroy(self):
        held = [d for d in self.delay if d > 0]
        print(
            f"[bg_traffic] {self.spawned}/{len(self.entries)} entries spawned over the run"
            + (f", {self.failed} not" if self.failed else ""),
            flush=True,
        )
        print(
            f"[bg_traffic] emergency stops: {self.holds} holds by {len(held)} cars, {sum(held):.1f} s held in total",
            flush=True,
        )
        if not self.actors:
            return
        try:
            self.client.apply_batch_sync([carla.command.DestroyActor(a) for a in self.actors.values()], False)
            print(f"[bg_traffic] destroyed {len(self.actors)} background cars", flush=True)
        except RuntimeError as exc:
            print(f"[bg_traffic] cleanup failed: {exc}", flush=True)
        self.actors = {}


def _find_hero(world):
    for a in world.get_actors().filter("vehicle.*"):
        if a.attributes.get("role_name") == "hero":
            return a
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=2010)
    args = ap.parse_args()
    with open(args.file) as fh:
        data = json.load(fh)
    if not data.get("vehicles"):
        print("[bg_traffic] file has no vehicles — nothing to replay", flush=True)
        return

    client = carla.Client(args.host, args.port)
    client.set_timeout(30.0)
    player = None
    stop = {"flag": False}

    def _on_signal(*_):
        stop["flag"] = True

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    try:
        # Wait for the hero (t = 0); the world may be reloaded while ScenarioRunner switches town.
        deadline = time.time() + HERO_WAIT_S
        hero, t0 = None, None
        while hero is None and not stop["flag"] and time.time() < deadline:
            try:
                world = client.get_world()
                snap = world.wait_for_tick(2.0)
                hero = _find_hero(world)
                if hero is not None:
                    t0 = snap.timestamp.elapsed_seconds
            except RuntimeError:
                time.sleep(0.2)
        if hero is None:
            print("[bg_traffic] hero never appeared — giving up", flush=True)
            return
        if world.get_map().name.split("/")[-1] != data.get("town"):
            print(
                f"[bg_traffic] WARNING: traffic is for {data.get('town')}, world is "
                f"{world.get_map().name} — not replaying",
                flush=True,
            )
            return

        tick_dt = world.get_settings().fixed_delta_seconds or 0.05
        player = Player(client, data, tick_dt)
        player.step(tick_dt, world.get_snapshot())
        print(
            f"[bg_traffic] replaying {len(player.entries)} entries over {data['duration']:.0f} s "
            f"at dt {player.dt} (world tick {tick_dt}) from sim t0 {t0:.2f}; "
            f"{len(player.actors)} spawned at the start",
            flush=True,
        )
        misses = 0
        while not stop["flag"]:
            try:
                snap = player.world.wait_for_tick(2.0)
            except RuntimeError:
                misses += 1
                if misses >= 5:  # nothing ticks the world any more
                    break
                continue
            misses = 0
            # The newest tick: when this loop falls behind, older commands would land a tick late.
            try:
                snap = player.world.get_snapshot()
            except RuntimeError:
                continue
            if snap.find(hero.id) is None:
                break  # scenario over: ScenarioRunner destroyed the hero
            player.step(snap.timestamp.elapsed_seconds - t0 + tick_dt, snap)
    finally:
        if player is not None:
            player.destroy()


if __name__ == "__main__":
    sys.exit(main())
