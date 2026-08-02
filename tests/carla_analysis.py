"""Turn a CARLA run into pass/fail: telemetry CSV + ScenarioRunner's OSC log.

Two independent sources, answering two different questions:

  OSC log   — ScenarioRunner prints `[OSC][<t>s][EVENT][<name>] RUNNING|END`
              for every storyboard element. That says the TRIGGER FIRED and
              exactly when. Cheap, exact, and it needs no simulator introspection.
  telemetry — the per-tick CSV from carla_telemetry.py. That says the ACTOR
              ACTUALLY DID IT. An event can go RUNNING while the vehicle
              ignores it entirely (wrong entity ref, unreachable lane,
              controller never applied it).

A case only passes when both agree. Checking only the log would accept a
scenario that fires perfectly and moves nothing; checking only telemetry
cannot tell a mistimed trigger from a sluggish controller.

Time bases differ and must be reconciled — see act_start().
"""
import bisect
import csv
import math
import re


# ── ScenarioRunner's OSC lifecycle log ───────────────────────────────────────

_OSC_LINE = re.compile(
    r"^\[OSC\]\[(?P<t>[0-9.]+)s\]\[(?P<kind>[A-Z]+)\]\[(?P<name>[^\]]+)\]\s+(?P<state>\S+)")


def parse_osc_log(path):
    """-> [{t, kind, name, state}] in file order.

    kind is ACT | SCENE | MANEUVER | EVENT | ACTION; state is RUNNING | END.
    """
    out = []
    with open(path, errors="replace") as fh:
        for line in fh:
            m = _OSC_LINE.match(line.strip())
            if m:
                out.append({
                    "t": float(m.group("t")),
                    "kind": m.group("kind"),
                    "name": m.group("name"),
                    "state": m.group("state"),
                })
    return out


def event_timeline(osc):
    """-> {event_name: {'start': t, 'end': t or None}} for EVENT entries."""
    timeline = {}
    for rec in osc:
        if rec["kind"] != "EVENT":
            continue
        slot = timeline.setdefault(rec["name"], {"start": None, "end": None})
        if rec["state"] == "RUNNING" and slot["start"] is None:
            slot["start"] = rec["t"]
        elif rec["state"] == "END":
            slot["end"] = rec["t"]
    return timeline


# ── Telemetry ────────────────────────────────────────────────────────────────

class Track:
    """One actor's per-tick samples, sorted by time."""

    def __init__(self, role, type_id):
        self.role = role
        self.type_id = type_id
        self.t = []
        self.x = []
        self.y = []
        self.yaw = []
        self.speed = []
        self.frame = []

    def __len__(self):
        return len(self.t)

    def at(self, t):
        """Index of the sample nearest time `t` (telemetry time base)."""
        if not self.t:
            return None
        i = bisect.bisect_left(self.t, t)
        if i == 0:
            return 0
        if i >= len(self.t):
            return len(self.t) - 1
        return i if abs(self.t[i] - t) < abs(self.t[i - 1] - t) else i - 1

    def speed_at(self, t):
        i = self.at(t)
        return None if i is None else self.speed[i]

    def window(self, t0, t1):
        """Samples with t0 <= t <= t1 as (times, speeds)."""
        ts, ss = [], []
        for t, s in zip(self.t, self.speed):
            if t0 <= t <= t1:
                ts.append(t)
                ss.append(s)
        return ts, ss

    def distance_travelled(self):
        total = 0.0
        for i in range(1, len(self.t)):
            total += math.hypot(self.x[i] - self.x[i - 1], self.y[i] - self.y[i - 1])
        return total


class Run:
    """A loaded telemetry CSV, indexed by role_name."""

    def __init__(self, csv_path):
        self.tracks = {}
        with open(csv_path) as fh:
            for row in csv.DictReader(fh):
                role = row["role_name"]
                if not role:
                    continue
                track = self.tracks.get(role)
                if track is None:
                    track = self.tracks[role] = Track(role, row["type_id"])
                track.t.append(float(row["sim_time"]))
                track.x.append(float(row["x"]))
                track.y.append(float(row["y"]))
                track.yaw.append(float(row["yaw"]))
                track.speed.append(float(row["speed"]))
                track.frame.append(int(row["frame"]))
        for track in self.tracks.values():
            order = sorted(range(len(track.t)), key=lambda i: track.t[i])
            for attr in ("t", "x", "y", "yaw", "speed", "frame"):
                seq = getattr(track, attr)
                setattr(track, attr, [seq[i] for i in order])

    def __contains__(self, role):
        return role in self.tracks

    def __getitem__(self, role):
        return self.tracks[role]

    def get(self, role):
        return self.tracks.get(role)

    def act_start(self, threshold=0.1):
        """Telemetry time at which the NPC Acts begin.

        Every generated Act starts on `hero traveled 0.1 m`
        (xml_builder._add_act_start_stop_triggers), so the ego's first motion is
        the zero every event time has to be measured from.

        This is also the bridge between the two time bases: the telemetry CSV
        carries CARLA's world clock (elapsed_seconds, which keeps counting
        across runs and starts in the hundreds), while the OSC log counts from
        scenario start. They share this instant and nothing else.
        """
        hero = self.tracks.get("hero")
        if hero is None or not hero.t:
            return None
        x0, y0 = hero.x[0], hero.y[0]
        for i in range(len(hero.t)):
            if math.hypot(hero.x[i] - x0, hero.y[i] - y0) >= threshold:
                return hero.t[i]
        return None

    def frame_at(self, t):
        hero = self.tracks.get("hero")
        if hero is None:
            return None
        i = hero.at(t)
        return None if i is None else hero.frame[i]


# ── Behavioural predicates ───────────────────────────────────────────────────
#
# All take a Run plus times measured from act_start, so they read the way the
# event chain does ("5 s after the chain begins") rather than in CARLA's clock.

def _abs_t(run, t_rel):
    base = run.act_start()
    return None if base is None else base + t_rel


def reaches_speed(run, role, target, t_from, t_to, tol=1.5):
    """Did `role` hit `target` m/s at any point in [t_from, t_to]?

    -> (ok, detail). Reports the closest approach when it fails, which is
    usually enough to tell "never moved" from "overshot".
    """
    track = run.get(role)
    if track is None:
        return False, f"no telemetry for '{role}'"
    a, b = _abs_t(run, t_from), _abs_t(run, t_to)
    if a is None:
        return False, "ego never moved, so the act never started"
    ts, speeds = track.window(a, b)
    if not speeds:
        return False, f"no samples in [{t_from:.1f},{t_to:.1f}]s after act start"
    best = min(speeds, key=lambda s: abs(s - target))
    ok = abs(best - target) <= tol
    return ok, (f"closest {best:.2f} m/s vs target {target:.2f} "
                f"(range {min(speeds):.2f}-{max(speeds):.2f} m/s "
                f"over [{t_from:.1f},{t_to:.1f}]s)")


def holds_speed(run, role, target, t_from, t_to, tol=1.5, min_fraction=0.6):
    """Was `role` within tol of `target` for most of [t_from, t_to]?

    A plateau check — distinguishes "passed through 5 m/s while decelerating"
    from "held 5 m/s", which is what a step action is supposed to produce.
    """
    track = run.get(role)
    if track is None:
        return False, f"no telemetry for '{role}'"
    a, b = _abs_t(run, t_from), _abs_t(run, t_to)
    if a is None:
        return False, "ego never moved, so the act never started"
    _, speeds = track.window(a, b)
    if not speeds:
        return False, f"no samples in [{t_from:.1f},{t_to:.1f}]s after act start"
    inside = sum(1 for s in speeds if abs(s - target) <= tol)
    frac = inside / len(speeds)
    return frac >= min_fraction, (
        f"{frac*100:.0f}% of {len(speeds)} samples within {tol} m/s of {target} "
        f"(mean {sum(speeds)/len(speeds):.2f} m/s)")


def lateral_offset(run, role, t_from, t_to, ref_t=0.0):
    """Signed sideways displacement between two times, in the actor's own frame.

    Positive = the actor's left. This is what says whether a lane change went
    the way the editor asked: `left` must come out positive.

    The reference heading is taken at `ref_t` (act start by default), NOT at
    `t_from`. Taking it at t_from is wrong whenever t_from lands inside the
    manoeuvre: mid-turn the actor is yawed ~45-125 deg off the road, and
    projecting onto that frame turns a 3.7 m lane change into a reported 44 m
    of "lateral" travel. Use an instant when the actor is known to be running
    straight.
    """
    track = run.get(role)
    if track is None:
        return None, f"no telemetry for '{role}'"
    a, b = _abs_t(run, t_from), _abs_t(run, t_to)
    if a is None:
        return None, "ego never moved, so the act never started"
    i, j = track.at(a), track.at(b)
    r = track.at(_abs_t(run, ref_t))
    if i is None or j is None or r is None:
        return None, "no samples"
    h = math.radians(track.yaw[r])
    dx, dy = track.x[j] - track.x[i], track.y[j] - track.y[i]
    # CARLA is left-handed with Y down, so the actor's left is (sin h, -cos h).
    lateral = dx * math.sin(h) - dy * math.cos(h)
    longitudinal = dx * math.cos(h) + dy * math.sin(h)
    return lateral, (f"lateral {lateral:+.2f} m, longitudinal {longitudinal:+.2f} m "
                     f"over [{t_from:.1f},{t_to:.1f}]s "
                     f"(frame: heading {track.yaw[r]:.1f}deg at t={ref_t:.1f}s)")


def closest_approach(run, role_a, role_b):
    """Minimum distance between two actors, and when. -> (dist, t_rel)."""
    ta, tb = run.get(role_a), run.get(role_b)
    if ta is None or tb is None:
        return None, None
    base = run.act_start() or 0.0
    best, best_t = float("inf"), None
    for i, t in enumerate(ta.t):
        j = tb.at(t)
        if j is None:
            continue
        d = math.hypot(ta.x[i] - tb.x[j], ta.y[i] - tb.y[j])
        if d < best:
            best, best_t = d, t - base
    return best, best_t


def time_within(run, role, point, radius):
    """When `role` first came within `radius` of a world point (act-relative)."""
    track = run.get(role)
    if track is None:
        return None
    base = run.act_start()
    if base is None:
        return None
    px, py = point
    for i, t in enumerate(track.t):
        if math.hypot(track.x[i] - px, track.y[i] - py) <= radius:
            return t - base
    return None


def time_ego_within(run, point, radius):
    """When the ego first came within `radius` of a world point (act-relative).

    Lets a distance_to_point assertion be checked against the ego's own
    recorded motion instead of a hardcoded timestamp: compute when the trigger
    SHOULD have fired, then compare that to when the event actually did.
    """
    return time_within(run, "hero", point, radius)


def slows_by(run, role, drop, t_from, t_to):
    """Did `role` shed at least `drop` m/s from its peak in the window?

    -> (ok, detail). For the ego, which is never scripted: 'it braked' cannot be
    an absolute threshold, because the plateau BehaviorAgent settles at depends
    on the town's speed limit. What is stable is the shape — cruise, then a real
    loss of speed — so this measures the peak and the deepest trough AFTER it.
    Comparing whole-window min to whole-window max would score a standing start
    as a brake.
    """
    track = run.get(role)
    if track is None:
        return False, f"no telemetry for '{role}'"
    a, b = _abs_t(run, t_from), _abs_t(run, t_to)
    if a is None:
        return False, "ego never moved, so the act never started"
    ts, speeds = track.window(a, b)
    if not speeds:
        return False, f"no samples in [{t_from:.1f},{t_to:.1f}]s after act start"
    i_peak = max(range(len(speeds)), key=lambda i: speeds[i])
    after = speeds[i_peak:]
    shed = speeds[i_peak] - min(after)
    return shed >= drop, (
        f"peaked {speeds[i_peak]:.2f} m/s at t={ts[i_peak] - _abs_t(run, 0.0):+.1f}s "
        f"then fell to {min(after):.2f} — shed {shed:.2f} m/s (wanted {drop:.1f})")


def heading_change(run, role, t_from, t_to):
    """Signed yaw change over a window, wrapped to (-180,180]. -> (deg, detail).

    This is how an EGO MANOEUVRE gets asserted at all. The .xosc gives the ego a
    spawn pose and nothing else — every turn is chosen by `--goal` and planned by
    BehaviorAgent, so there is no storyboard event to read off the OSC log. What
    can be checked is whether the ego actually ended up pointing down the arm the
    goal was on: a left turn out of a 4-way junction is ~-90 deg in CARLA's
    left-handed frame, a right turn ~+90, straight ~0.

    Wrapping is per-sample, not endpoint-to-endpoint: a 180 deg turn read from
    two samples is ambiguous in sign, and accumulating the small per-tick deltas
    is not.
    """
    track = run.get(role)
    if track is None:
        return None, f"no telemetry for '{role}'"
    a, b = _abs_t(run, t_from), _abs_t(run, t_to)
    if a is None:
        return None, "ego never moved, so the act never started"
    i, j = track.at(a), track.at(b)
    if i is None or j is None or j <= i:
        return None, "no samples"
    total = 0.0
    for k in range(i + 1, j + 1):
        total += (track.yaw[k] - track.yaw[k - 1] + 180) % 360 - 180
    return total, (f"yaw {track.yaw[i]:.1f} -> {track.yaw[j]:.1f} deg, "
                   f"net {total:+.1f} deg over [{t_from:.1f},{t_to:.1f}]s")


def stopped_within(run, role, t_from, t_to, threshold=0.5):
    """Did `role` drop below `threshold` m/s inside the window? -> (ok, detail).

    For the cases whose whole point is that the EGO had to give way — a lead
    that brakes to a halt, a blocked junction, a pedestrian in the road. The ego
    is not scripted, so 'it slowed down' is the only observable that separates
    'the scene had an effect' from 'the ego drove past regardless'.
    """
    track = run.get(role)
    if track is None:
        return False, f"no telemetry for '{role}'"
    a, b = _abs_t(run, t_from), _abs_t(run, t_to)
    if a is None:
        return False, "ego never moved, so the act never started"
    _, speeds = track.window(a, b)
    if not speeds:
        return False, f"no samples in [{t_from:.1f},{t_to:.1f}]s after act start"
    return min(speeds) <= threshold, (
        f"min {min(speeds):.2f} m/s (max {max(speeds):.2f}) "
        f"over [{t_from:.1f},{t_to:.1f}]s")


def speed_profile(run, role, boundaries, tol=1.5):
    """Check a step-and-hold profile: [(t_from, t_to, target), ...].

    The shape a template's after_event chain should produce — the target
    applied at once, then held for the action's stated duration, then the next
    link. Returns (ok, [per-segment detail]).
    """
    details, ok = [], True
    for (t_from, t_to, target) in boundaries:
        held, detail = holds_speed(run, role, target, t_from, t_to, tol=tol)
        ok = ok and held
        details.append(f"[{t_from:.0f}-{t_to:.0f}s]->{target} m/s: "
                       f"{'ok' if held else 'MISS'} ({detail})")
    return ok, details


def summarise(run):
    """One line per actor — the first thing to read when a case fails."""
    base = run.act_start()
    lines = []
    for role, track in sorted(run.tracks.items()):
        if not len(track):
            continue
        rel0 = track.t[0] - base if base is not None else track.t[0]
        rel1 = track.t[-1] - base if base is not None else track.t[-1]
        lines.append(
            f"{role:<12} {track.type_id:<30} {len(track):4d} samples "
            f"t=[{rel0:+.1f},{rel1:+.1f}]s "
            f"speed 0-{max(track.speed):.1f} m/s "
            f"travelled {track.distance_travelled():.1f} m")
    return lines
