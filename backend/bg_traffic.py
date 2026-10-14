"""
Background traffic: SUMO-generated trajectories that CARLA replays as "puppets".

The traffic is computed once, here, and is then *played back* — by the editor's
preview and, unchanged, by tools/bg_traffic_player.py inside a CARLA run, which
steers every car onto the file's pose on every tick. That is what makes the
preview exact for the background: neither side decides anything.
The price is that the cars react to nothing. So every car that would come
near the scripted scenario is taken out and the rest is simulated again, until
what is left neither touches the scenario nor was shaped by a car that is no
longer there. "Near" is in space AND time: the keep-out is the track the
preview predicts for the ego and each NPC, every point with its time, and a car
is dropped only if it is within the clearance of a point whose time is within
KEEPOUT_TIME_S of its own — so traffic may use the ego's own roads ahead of
and behind it (a purely spatial keep-out left ~2–20 cars near the ego).
Untimed parts (props) block for the whole run, and also take out, before any
simulation, every edge and junction turn they touch. In CARLA, the player's
emergency stop holds a car whose timing has drifted that far after all.

Two shapes of result:
  * whole map (no focus): `count` cars, each present for the whole window;
  * a BUBBLE around the ego (focus radius R, the editor's "Umkreis"): a car
    is shown only while within R of where the preview has the ego (and until
    R + BUBBLE_HYSTERESIS_M once shown), one file entry {t0, frames} per such
    stretch, and `count` is the AVERAGE number shown. Trips are aimed at the
    bubble (_bubble_trips): they start ahead of where the ego will be, pass
    near its route and end beyond it.

Pipeline, per request:
  1. `.xodr` → SUMO net with netconvert (cached on disk next to the `.xodr`,
     in a `sumo/` folder, rebuilt when the `.xodr` or the type file is newer).
     Options copied from CARLA's own Co-Simulation/Sumo/util/netconvert_carla.py.
  2. randomTrips.py: a pool of trips departing during the warm-up, so the
     window starts with traffic already spread out (whole map: POOL_FACTOR ×
     count; bubble: aimed trips, BUBBLE_POOL_FACTOR × count). A bigger pool
     jams the small towns (cars never get onto the network), so a run that
     is short is topped up with fresh trips instead — in the same
     re-simulation as any removals (step 4), except in the last
     SETTLE_ROUNDS, which only remove.
  3. sumo, headless, FCD output for the window only.
  4. Drop every car that pops in or vanishes where it is shown (whole map: is
     not there for the whole window), jumps (a teleport), or enters the
     keep-out; drop random extras down to `count`. If anything was dropped,
     re-simulate without it (step 3) — at most MAX_ITERATIONS times. Removals
     cascade: a car whose leader is gone drives faster and may now reach the
     keep-out inside the window.

Coordinates: FCD gives the FRONT BUMPER and a compass angle in SUMO's frame
(net offset applied, y up). The conversion to a CARLA centre pose is
BridgeHelper.get_carla_transform from CARLA's co-simulation, verbatim.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import random
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
from collections import OrderedDict
from pathlib import Path

FORMAT_VERSION = 2       # 2: per-car t0 (a car need not exist for the whole window)
WARMUP_S = 60.0         # simulated before the window starts
DURATION_S = 65.0       # the window: every Act stops at MaxSimTime 60
STEP_S = 0.1            # SUMO step and FCD period; consumers interpolate
POOL_FACTOR = 2         # trips generated per requested car, up front
MAX_TOPUPS = 3          # rounds of fresh trips when a settled run is short
MAX_ITERATIONS = 16
SETTLE_ROUNDS = 4       # the last rounds only remove cars (see generate)
MAX_COUNT = 200
JUMP_SLACK_M = 2.0      # a step longer than speed·dt + this is a teleport
MAX_FOCUS_RADIUS = 500.0
KEEPOUT_TIME_S = 8.0         # a car may use a spot on a scripted path this long before/after its actor
BUBBLE_GEN_MARGIN_M = 250.0  # candidate trip edges: within the bubble radius + this of the route
BUBBLE_POOL_FACTOR = 6       # aimed trips: most pass the ego, each for part of the window
BUBBLE_MAX_TOPUPS = 6
MAX_TRIPS_PER_ROUND = 600    # SUMO time and FCD size grow with every trip
BUBBLE_HYSTERESIS_M = 20.0   # a shown car is removed only beyond radius + this
BUBBLE_INSERT_CLEAR_M = 30.0 # trips departing within radius + this of the ego are not generated

_TYPE_FILE = Path(__file__).parent / "sumo_data" / "opendrive_netconvert.typ.xml"

# CARLA blueprints used for background cars, with their bounding-box extents
# (half-length, half-width) measured on the fail2drive build run.sh uses
# (2026-10-13). The half-length is what turns SUMO's front-bumper position into
# CARLA's centre; every blueprint's box sits on its origin (location.z ≈ extent.z),
# so a puppet's z is the road surface itself.
BLUEPRINTS = [
    ("vehicle.lincoln.mkz_2017",      2.451, 1.064),
    ("vehicle.audi.a2",               1.853, 0.894),
    ("vehicle.toyota.prius",          2.257, 1.003),
    ("vehicle.tesla.model3",          2.396, 1.082),
    ("vehicle.nissan.micra",          1.817, 0.923),
    ("vehicle.mercedes.coupe_2020",   2.337, 0.906),
    ("vehicle.seat.leon",             2.096, 0.908),
    ("vehicle.citroen.c3",            1.994, 0.925),
    ("vehicle.mini.cooper_s",         1.903, 0.985),
    ("vehicle.chevrolet.impala",      2.679, 1.017),
    ("vehicle.audi.etron",            2.428, 1.016),
    ("vehicle.nissan.patrol_2021",    2.783, 1.075),
    ("vehicle.jeep.wrangler_rubicon", 1.933, 0.953),
    ("vehicle.volkswagen.t2_2021",    2.221, 0.887),
    ("vehicle.mercedes.sprinter",     2.958, 0.994),
    ("vehicle.ford.mustang",          2.359, 0.947),
    ("vehicle.dodge.charger_2020",    2.504, 0.941),
    ("vehicle.audi.tt",               2.091, 0.997),
]
_BP = {bp: (ex, ey) for bp, ex, ey in BLUEPRINTS}


class BgTrafficError(RuntimeError):
    """A request that cannot be served (missing SUMO, bad parameters, …)."""


# ── SUMO installation ───────────────────────────────────────────────────────

def sumo_home() -> Path:
    """SUMO_HOME of the `eclipse-sumo` wheel in this venv, or BG_SUMO_HOME.

    The shell's own SUMO_HOME is deliberately not trusted: on this box it
    points at a directory that does not exist.
    """
    env = os.environ.get("BG_SUMO_HOME")
    if env and Path(env, "bin").is_dir():
        return Path(env)
    try:
        import sumo  # the eclipse-sumo wheel
        return Path(sumo.SUMO_HOME)
    except Exception as exc:  # pragma: no cover - depends on the install
        raise BgTrafficError(
            "SUMO ist nicht installiert (pip install eclipse-sumo==1.24.0 in .venv)") from exc


def _run(cmd: list[str], cwd: Path) -> None:
    env = dict(os.environ, SUMO_HOME=str(sumo_home()))
    proc = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-5:]
        raise BgTrafficError(f"{Path(cmd[0]).name} fehlgeschlagen: " + " | ".join(tail))


# ── Network ────────────────────────────────────────────────────────────────

_net_locks: dict[str, threading.Lock] = {}
_net_locks_guard = threading.Lock()


def sumo_net(xodr: Path) -> Path:
    """The SUMO net for an `.xodr`, built on first use and cached beside it."""
    xodr = Path(xodr).resolve()
    out = xodr.parent / "sumo" / f"{xodr.stem}.net.xml"
    with _net_locks_guard:
        lock = _net_locks.setdefault(str(out), threading.Lock())
    with lock:
        fresh = (out.exists()
                 and out.stat().st_mtime >= xodr.stat().st_mtime
                 and out.stat().st_mtime >= _TYPE_FILE.stat().st_mtime)
        if fresh:
            return out
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(".tmp.xml")
        _run([str(sumo_home() / "bin" / "netconvert"),
              "--opendrive", str(xodr),
              "--output-file", str(tmp),
              "--geometry.min-radius.fix",
              "--geometry.remove",
              "--opendrive.curve-resolution", "1",
              "--opendrive.import-all-lanes",
              "--type-files", str(_TYPE_FILE),
              "--output.original-names",
              "--no-warnings"], cwd=out.parent)
        tmp.replace(out)
        return out


def _net_info(net: Path) -> tuple[tuple[float, float], float]:
    """(netOffset, diagonal of the converted boundary) from the net's <location>."""
    for _, el in ET.iterparse(net, events=("start",)):
        if el.tag == "location":
            ox, oy = (float(v) for v in el.get("netOffset").split(","))
            x0, y0, x1, y1 = (float(v) for v in el.get("convBoundary").split(","))
            return (ox, oy), math.hypot(x1 - x0, y1 - y0)
    raise BgTrafficError("SUMO-Netz ohne <location>")


# ── Keep-out ───────────────────────────────────────────────────────────────

class _KeepOut:
    """Segments of a set of paths, each with a half-width, bucketed on a grid
    for the per-frame test `hits`: is a car of half-width `half_w` at (x, y)
    within `clearance` of a path's edge — and, for a TIMED path, at a moment
    within KEEPOUT_TIME_S of when its actor is there? Used for the keep-out
    (the scripted scenario's paths) and, with half-width 0, for zones.

    A path's points are [x, y] (untimed: occupied for the whole run — props,
    and the part of a route the preview never reaches) or [x, y, t] (timed:
    the preview's track; a segment is occupied from its first point's t to its
    last's, so an actor standing still occupies its spot for as long as it
    stands). `hits(…, t=None)` ignores time.

    The grid cell is at least the largest distance a hit can be at, so looking
    in the car's own cell (each segment is filed one cell beyond its box) is
    enough. A fixed 10 m cell used to miss hits past 10 m — any "Abstand" over
    ~7 m."""

    def __init__(self, paths: list[dict], clearance: float, window_s: float = 0.0):
        self.clearance = clearance
        self.window = window_s
        self.segs: list[tuple] = []          # (ax, ay, bx, by, w, t_lo, t_hi) — t None: untimed
        self.grid: dict[tuple[int, int], list[int]] = {}
        for path in paths or []:
            w = float(path.get("w", 1.0))
            pts = [tuple(float(v) for v in p[:3]) for p in path.get("pts", []) if len(p) >= 2]
            if len(pts) == 1:
                pts = pts * 2
            for a, b in zip(pts, pts[1:]):
                if len(a) == 3 and len(b) == 3:
                    lo, hi = min(a[2], b[2]), max(a[2], b[2])
                else:
                    lo = hi = None
                self.segs.append((a[0], a[1], b[0], b[1], w, lo, hi))
        max_w = max((sg[4] for sg in self.segs), default=0.0)
        self.reach = clearance + max_w + 1.5          # + the widest puppet's half-width
        self.cell = max(10.0, self.reach)
        c = self.cell
        for i, (ax, ay, bx, by, *_rest) in enumerate(self.segs):
            for gx in range(int(math.floor(min(ax, bx) / c)) - 1, int(math.floor(max(ax, bx) / c)) + 2):
                for gy in range(int(math.floor(min(ay, by) / c)) - 1, int(math.floor(max(ay, by) / c)) + 2):
                    self.grid.setdefault((gx, gy), []).append(i)

    def untimed(self) -> "_KeepOut":
        """The same keep-out without its timed segments (what is in the way
        for the whole run, whatever the timing)."""
        k = _KeepOut([], self.clearance, self.window)
        for sg in self.segs:
            if sg[5] is None:
                k.segs.append(sg)
        k.reach, k.cell = self.reach, self.cell
        c = k.cell
        for i, (ax, ay, bx, by, *_rest) in enumerate(k.segs):
            for gx in range(int(math.floor(min(ax, bx) / c)) - 1, int(math.floor(max(ax, bx) / c)) + 2):
                for gy in range(int(math.floor(min(ay, by) / c)) - 1, int(math.floor(max(ay, by) / c)) + 2):
                    k.grid.setdefault((gx, gy), []).append(i)
        return k

    def hits(self, x: float, y: float, half_w: float, t: float | None = None) -> bool:
        cell = self.grid.get((int(math.floor(x / self.cell)), int(math.floor(y / self.cell))))
        if not cell:
            return False
        for i in cell:
            ax, ay, bx, by, w, lo, hi = self.segs[i]
            if t is not None and lo is not None and not (lo - self.window <= t <= hi + self.window):
                continue                                   # the actor is not there then
            dx, dy = bx - ax, by - ay
            L2 = dx * dx + dy * dy
            u = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / L2))
            px, py = ax + u * dx - x, ay + u * dy - y
            lim = self.clearance + w + half_w
            if px * px + py * py < lim * lim:
                return True
        return False


# ── Focus: traffic around the ego's route ───────────────────────────────────

_sumolib_nets: dict[str, tuple[float, object]] = {}
_sumolib_lock = threading.Lock()


def _sumolib_net(net: Path):
    """The net parsed by sumolib (from the wheel's tools/), cached per file."""
    tools = str(sumo_home() / "tools")
    if tools not in sys.path:
        sys.path.append(tools)
    import sumolib  # noqa: E402  (lives in SUMO's tools/, not on the default path)
    key = str(net)
    mtime = net.stat().st_mtime
    with _sumolib_lock:
        hit = _sumolib_nets.get(key)
        if hit and hit[0] == mtime:
            return hit[1]
        parsed = sumolib.net.readNet(key, withInternal=True)   # junction lanes: see _write_trip_weights
        _sumolib_nets[key] = (mtime, parsed)
        return parsed


def _write_trip_weights(net: Path, off, zone: "_KeepOut | None", keepout: "_KeepOut",
                        prefix: Path) -> tuple[list[str], "_Blocked"]:
    """Where trips may start, end and stop, and what routes must not use.

    * randomTrips weight files (<prefix>.src/.dst/.via.xml): 1 for a drivable
      edge inside `zone` (any edge without one), nothing (= 0) for the rest.
      Loaded weights REPLACE randomTrips' own edge filter, so its passenger
      and via-not-fringe rules are applied here.
    * Blocked: the edges the scenario's own actors drive on (a lane within the
      keep-out of a scripted path) and the TURNS whose junction lane crosses
      one. Blocked edges are never a start, end or stop and cost duarouter
      1000× their travel time (<prefix>.route.xml); a route that still uses a
      blocked edge or turn is removed before simulation (_drop_routes_using).
      Turns are judged one by one — a side street's right turn stays usable
      when its left turn crosses the ego's path.

    Returns (start/end edges, the blocked edges and turns)."""
    snet = _sumolib_net(net)
    to_carla = lambda x, y: (x - off[0], -(y - off[1]))  # noqa: E731
    usable, usable_via, blocked_edges, blocked_turns = [], [], [], set()

    def hits(shape):
        return any(keepout.hits(*to_carla(x, y), 1.0) for x, y in _densify(shape))

    for edge in snet.getEdges(withInternal=False):
        if not edge.allows("passenger"):
            continue
        for to_edge, conns in edge.getOutgoing().items():
            if any(c.getViaLaneID() and hits(snet.getLane(c.getViaLaneID()).getShape()) for c in conns):
                blocked_turns.add((edge.getID(), to_edge.getID()))
        if any(hits(lane.getShape()) for lane in edge.getLanes()):
            blocked_edges.append(edge)
            continue
        if zone is not None and not any(zone.hits(*to_carla(x, y), 0.0) for x, y in _densify(edge.getShape())):
            continue
        usable.append(edge.getID())
        if not edge.is_fringe():
            usable_via.append(edge.getID())
    for suffix, ids in ((".src.xml", usable), (".dst.xml", usable), (".via.xml", usable_via)):
        with open(str(prefix) + suffix, "w") as fh:
            fh.write('<edgedata>\n    <interval id="w" begin="0" end="1000000">\n')
            for eid in ids:
                fh.write(f'        <edge id="{eid}" value="1"/>\n')
            fh.write("    </interval>\n</edgedata>\n")
    with open(str(prefix) + ".route.xml", "w") as fh:
        fh.write('<meandata>\n    <interval id="w" begin="0" end="1000000">\n')
        for edge in blocked_edges:
            tt = 1000.0 * edge.getLength() / max(edge.getSpeed(), 1.0)
            fh.write(f'        <edge id="{edge.getID()}" traveltime="{tt:.1f}"/>\n')
        fh.write("    </interval>\n</meandata>\n")
    return usable, _Blocked({e.getID() for e in blocked_edges}, blocked_turns)


class _Blocked:
    def __init__(self, edges: set[str], turns: set[tuple[str, str]]):
        self.edges, self.turns = edges, turns

    def __len__(self):
        return len(self.edges) + len(self.turns)

    def route_ok(self, edges: list[str]) -> bool:
        return not (self.edges.intersection(edges)
                    or any((a, b) in self.turns for a, b in zip(edges, edges[1:])))


def _drop_routes_using(routes: Path, blocked: "_Blocked") -> int:
    """Remove every vehicle whose route uses a blocked edge or turn (see
    _write_trip_weights). Such a car would be dropped for the keep-out after
    a whole simulation, and its removal would cost another. Returns how many
    were removed."""
    tree = ET.parse(routes)
    root = tree.getroot()
    removed = 0
    for el in list(root):
        route = el.find("route") if el.tag == "vehicle" else None
        if route is not None and not blocked.route_ok(route.get("edges", "").split()):
            root.remove(el)
            removed += 1
    tree.write(routes)
    return removed


def _densify(shape, step=5.0):
    pts = []
    for (ax, ay), (bx, by) in zip(shape, shape[1:]):
        n = max(1, int(math.hypot(bx - ax, by - ay) // step))
        pts.extend((ax + (bx - ax) * k / n, ay + (by - ay) * k / n) for k in range(n))
    pts.append(shape[-1])
    return pts


# ── Generation ─────────────────────────────────────────────────────────────

def _track_interpolator(track: list):
    """ego_at(t) -> (x, y) from [[t, x, y], …], held at both ends."""
    ts = [p[0] for p in track]

    def ego_at(t: float):
        import bisect
        i = bisect.bisect_right(ts, t)
        if i <= 0:
            return track[0][1], track[0][2]
        if i >= len(track):
            return track[-1][1], track[-1][2]
        (t0, x0, y0), (t1, x1, y1) = track[i - 1], track[i]
        w = (t - t0) / (t1 - t0) if t1 > t0 else 0.0
        return x0 + (x1 - x0) * w, y0 + (y1 - y0) * w
    return ego_at


def _bubble_segments(fr, times, ego_at, enter_r: float, leave_r: float) -> list[tuple[int, int]]:
    """Index ranges of `fr` during which the car is shown: from the frame it
    comes within enter_r of the ego to the last frame before it is beyond
    leave_r (the gap keeps a car on the edge from flickering in and out)."""
    segs, start = [], None
    for i, f in enumerate(fr):
        ex, ey = ego_at(times[f[0]])
        d = math.hypot(f[1] - ex, f[2] - ey)
        if start is None and d <= enter_r:
            start = i
        elif start is not None and d > leave_r:
            segs.append((start, i - 1))
            start = None
    if start is not None:
        segs.append((start, len(fr) - 1))
    return segs


def _bubble_trips(routes: Path, net: Path, off, vtypes: Path, weights: Path, usable: list[str],
                  ego_at, radius: float, n: int, seed: int, prefix: str, cwd: Path) -> None:
    """Trips aimed at the bubble: each starts in a ring outside it around
    where the ego is about to be, passes an edge inside it, and ends in the
    ring again — so nearly every car drives through once, close to the ego,
    instead of randomTrips' cars scattered over town and time. A fifth depart
    before the window opens, around the ego's start, so t = 0 is not empty.
    Routed by duarouter with the same weights (the scenario's own lanes
    avoided)."""
    snet = _sumolib_net(net)
    rng = random.Random(seed * 104729 + 17)
    # Per edge: where a car on it starts (its first point), ends (its last)
    # and passes (every ~5 m). Edge MIDPOINTS used to stand for all three,
    # and on Town05's long edges no midpoint was near the ego: cyclist_ahead
    # seed 1 got no trip at all.
    to_c = lambda q: (q[0] - off[0], -(q[1] - off[1]))  # noqa: E731
    edges = []
    for eid in usable:
        shape = snet.getEdge(eid).getShape()
        edges.append((eid, to_c(shape[0]), to_c(shape[-1]), [to_c(q) for q in _densify(shape)]))

    def pick(cx, cy, lo, hi, where):
        def d(e):
            if where == "start":
                return math.hypot(e[1][0] - cx, e[1][1] - cy)
            if where == "end":
                return math.hypot(e[2][0] - cx, e[2][1] - cy)
            return min(math.hypot(x - cx, y - cy) for x, y in e[3])
        cands = [e[0] for e in edges if lo <= d(e) <= hi]
        return rng.choice(cands) if cands else None

    trips = []
    for i in range(n):
        early = i % 5 == 0
        depart = rng.uniform(WARMUP_S - 30.0, WARMUP_S) if early else rng.uniform(WARMUP_S, WARMUP_S + DURATION_S - 8.0)
        t_meet = max(0.0, depart - WARMUP_S) + 8.0           # ~8 s to drive into the bubble
        ex, ey = ego_at(t_meet)
        if early:
            src = pick(ex, ey, 0.0, radius + 150.0, "start")          # inserted before the window: anywhere
        else:
            src = pick(ex, ey, radius + BUBBLE_INSERT_CLEAR_M, radius + 150.0, "start")
        via = pick(ex, ey, 0.0, radius * 0.75, "pass")
        dst = pick(ex, ey, radius + BUBBLE_INSERT_CLEAR_M, radius + 250.0, "end")
        if not (src and via and dst) or len({src, via, dst}) < 3:
            continue
        trips.append((depart, f"{prefix}{i}", src, via, dst))
    trips.sort()
    tfile = cwd / f"{prefix}trips.xml"
    with open(tfile, "w") as fh:
        fh.write("<routes>\n")
        for depart, tid, src, via, dst in trips:
            fh.write(f'    <trip id="{tid}" depart="{depart:.2f}" from="{src}" to="{dst}" via="{via}" '
                     f'type="bg" departLane="best" departSpeed="max"/>\n')
        fh.write("</routes>\n")
    _run([str(sumo_home() / "bin" / "duarouter"),
          "-n", str(net), "--route-files", str(tfile), "-o", str(routes),
          "--additional-files", str(vtypes),
          "--weight-files", str(weights) + ".route.xml", "--weight-attribute", "traveltime",
          "--remove-loops", "--ignore-errors", "--no-warnings", "--no-step-log",
          "--alternatives-output", "NUL"], cwd=cwd)


def _drop_trips_starting_near(routes: Path, net: Path, off, ego_at, clear_r: float) -> None:
    """Remove the trips SUMO would insert within clear_r of the ego: inside the
    bubble a car must drive in, not appear. Done on the route file, before any
    simulation, so it costs no re-simulation (a car still inserted inside — a
    delayed insertion — is caught as "popin" afterwards)."""
    snet = _sumolib_net(net)
    tree = ET.parse(routes)
    root = tree.getroot()
    for el in list(root):
        if el.tag != "vehicle":
            continue
        t = float(el.get("depart", "0")) - WARMUP_S
        if t < 0:
            continue                                         # inserted before the window opens
        route = el.find("route")
        edges = (route.get("edges") if route is not None else "").split()
        if not edges:
            continue
        x, y = snet.getEdge(edges[0]).getShape()[0]
        ex, ey = ego_at(t)
        if math.hypot(x - off[0] - ex, -(y - off[1]) - ey) < clear_r:
            root.remove(el)
    tree.write(routes)


def _write_vtypes(path: Path) -> None:
    lines = ['<additional>']
    for bp, ex, ey in BLUEPRINTS:
        lines.append(
            f'  <vType id="{bp}" vClass="passenger" length="{2 * ex:.3f}" width="{2 * ey:.3f}" '
            f'minGap="2.5" accel="2.6" decel="4.5" sigma="0.5" speedFactor="normc(1,0.1,0.8,1.2)"/>')
    lines.append(f'  <vTypeDistribution id="bg" vTypes="{" ".join(bp for bp, _, _ in BLUEPRINTS)}"/>')
    lines.append('</additional>')
    path.write_text("\n".join(lines) + "\n")


def _random_trips(net: Path, out: Path, vtypes: Path, seed: int, n_trips: int, min_distance: float,
                  cwd: Path, prefix: str, weights: Path | None = None) -> None:
    home = sumo_home()
    period = WARMUP_S / max(1, n_trips)
    extra = []
    if weights:
        extra = ["--weights-prefix", str(weights),
                 "--duarouter-weight-files", str(weights) + ".route.xml",
                 "--duarouter-weight-attribute", "traveltime"]
    _run([sys.executable, str(home / "tools" / "randomTrips.py"),
          "-n", str(net), "-r", str(out), "-o", str(out.with_suffix(".trips.xml")),
          "--prefix", prefix,
          "--seed", str(seed), "--begin", "0", "--end", f"{WARMUP_S:.1f}",
          "--period", f"{period:.4f}",
          "--min-distance", f"{min_distance:.0f}",
          "--fringe-factor", "1",
          "--vclass", "passenger",
          "--intermediate", "12",   # long routes: a car must last the whole window
          "--remove-loops", "--validate",
          "--trip-attributes", 'type="bg" departLane="best" departSpeed="max"',
          "--additional-files", str(vtypes)] + extra, cwd=cwd)


def _routes_without(src: Path, dst: Path, drop: set[str]) -> int:
    tree = ET.parse(src)
    root = tree.getroot()
    kept = 0
    for el in list(root):
        if el.tag in ("vehicle", "trip"):
            if el.get("id") in drop:
                root.remove(el)
            else:
                kept += 1
    tree.write(dst)
    return kept


def _simulate(net: Path, routes: list[Path], vtypes: Path, seed: int, cwd: Path) -> Path:
    fcd = cwd / "fcd.xml"
    _run([str(sumo_home() / "bin" / "sumo"),
          "-n", str(net), "-r", ",".join(str(r) for r in routes), "-a", str(vtypes),
          "--begin", "0", "--end", f"{WARMUP_S + DURATION_S:.1f}",
          "--step-length", f"{STEP_S}",
          "--seed", str(seed),
          "--fcd-output", str(fcd),
          "--device.fcd.begin", f"{WARMUP_S:.1f}",
          "--fcd-output.attributes", "x,y,z,angle,speed",
          "--lanechange.duration", "3",   # smooth lane changes; instant ones jump 3.5 m in a step
          "--time-to-teleport", "300",
          "--no-step-log", "--no-warnings", "--duration-log.disable"], cwd=cwd)
    return fcd


def _to_carla(fx, fy, fz, angle, ext_x, off):
    """CARLA's BridgeHelper.get_carla_transform: front bumper → centre, net
    offset removed, y flipped, compass angle → CARLA yaw."""
    yaw_s = math.radians(-angle + 90.0)
    sx = fx - math.cos(yaw_s) * ext_x - off[0]
    sy = fy - math.sin(yaw_s) * ext_x - off[1]
    yaw = (angle - 90.0 + 180.0) % 360.0 - 180.0
    return sx, -sy, fz, yaw


def _read_fcd(fcd: Path, types: dict[str, str], off) -> tuple[list[float], dict[str, list]]:
    times: list[float] = []
    tracks: dict[str, list] = {}
    for _, el in ET.iterparse(fcd, events=("end",)):
        if el.tag != "timestep":
            continue
        t = round(float(el.get("time")) - WARMUP_S, 3)
        times.append(t)
        k = len(times) - 1
        for v in el.findall("vehicle"):
            vid = v.get("id")
            bp = types.get(vid) or v.get("type")
            ext_x = _BP.get(bp, (2.4, 1.0))[0]
            x, y, z, yaw = _to_carla(float(v.get("x")), float(v.get("y")), float(v.get("z", 0.0)),
                                     float(v.get("angle")), ext_x, off)
            tracks.setdefault(vid, []).append((k, x, y, z, yaw, float(v.get("speed", 0.0))))
        el.clear()
    return times, tracks


def _vehicle_types(routes: Path) -> dict[str, str]:
    """vehicle id → vType id as duarouter resolved the distribution."""
    out = {}
    for _, el in ET.iterparse(routes, events=("end",)):
        if el.tag == "vehicle":
            out[el.get("id")] = el.get("type")
    return out


def _resolve_types(routes: Path, seed: int) -> dict[str, str]:
    """Pin every vehicle to one concrete blueprint, so the type is known before
    simulation (duarouter keeps the distribution id `bg`). duarouter also
    copies the vType definitions into its output; they are removed, because
    sumo loads them from the additional file and refuses a second definition."""
    rng = random.Random(seed * 7919 + 1)
    tree = ET.parse(routes)
    root = tree.getroot()
    for el in list(root):
        if el.tag in ("vType", "vTypeDistribution"):
            root.remove(el)
        elif el.tag == "vehicle" and el.get("type") in (None, "bg"):
            el.set("type", rng.choice(BLUEPRINTS)[0])
    tree.write(routes)
    return _vehicle_types(routes)


_CACHE: "OrderedDict[str, dict]" = OrderedDict()
_CACHE_MAX = 12
_cache_lock = threading.Lock()


def _cache_key(town: str, net: Path, req: dict) -> str:
    blob = json.dumps({"v": FORMAT_VERSION, "town": town, "net": net.stat().st_mtime, **req},
                      sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(blob.encode()).hexdigest()


def normalize_request(body: dict) -> dict:
    """Validated, canonical form of a request (also the cache key's input)."""
    try:
        seed = int(body.get("seed", 1))
        count = int(body.get("count", 30))
        clearance = float(body.get("clearance", 0.5))
    except (TypeError, ValueError) as exc:
        raise BgTrafficError("Hintergrundverkehr: ungültige Zahl") from exc
    if not 0 <= count <= MAX_COUNT:
        raise BgTrafficError(f"Hintergrundverkehr: Anzahl muss 0…{MAX_COUNT} sein")
    clearance = max(0.0, min(20.0, clearance))
    paths = []
    for p in body.get("keepout") or []:
        # [x, y] untimed, [x, y, t] timed (see _KeepOut)
        pts = [[round(float(v), 1) for v in q[:3]] for q in (p.get("pts") or []) if len(q) >= 2]
        if pts:
            paths.append({"w": round(float(p.get("w", 1.0)), 2), "pts": pts})
    # Focus: {radius, paths: [[[x, y], …], …]} — the ego's route as one or more
    # polylines (kept apart: joined, the gap between two would become a chord
    # the zone covers). Radius 0 or no points: the whole map.
    focus = body.get("focus") or {}
    try:
        radius = max(0.0, min(MAX_FOCUS_RADIUS, float(focus.get("radius", 0) or 0)))
    except (TypeError, ValueError) as exc:
        raise BgTrafficError("Hintergrundverkehr: ungültiger Umkreis") from exc
    fpaths = []
    for line in focus.get("paths") or []:
        pts = [[round(float(q[0]), 1), round(float(q[1]), 1)] for q in (line or []) if len(q) >= 2]
        if pts:
            fpaths.append(pts)
    # track: [[t, x, y], …] — where the ego is when, as the preview predicts it.
    track = sorted([[round(float(q[0]), 2), round(float(q[1]), 1), round(float(q[2]), 1)]
                    for q in (focus.get("track") or []) if len(q) >= 3])
    focus_req = ({"radius": round(radius, 1), "paths": fpaths, "track": track}
                 if radius > 0 and fpaths and track else None)
    return {"seed": seed, "count": count, "clearance": round(clearance, 2), "keepout": paths,
            "focus": focus_req}


def generate(town: str, xodr: Path, body: dict) -> dict:
    """Background traffic for one scenario. See the module docstring."""
    req = normalize_request(body)
    net = sumo_net(xodr)
    key = _cache_key(town, net, req)
    with _cache_lock:
        if key in _CACHE:
            _CACHE.move_to_end(key)
            return _CACHE[key]

    started = time.monotonic()
    off, diag = _net_info(net)
    keepout = _KeepOut(req["keepout"], req["clearance"], KEEPOUT_TIME_S)
    focus = req["focus"]
    zone = _KeepOut([{"w": 0.0, "pts": pts} for pts in focus["paths"]], focus["radius"]) if focus else None
    rng = random.Random(req["seed"])
    result = {
        "version": FORMAT_VERSION, "town": town, "seed": req["seed"],
        "requested": req["count"], "clearance": req["clearance"],
        "focus_radius": 0,   # set below: 0 for the whole map, also when nothing near the route was drivable
        "dt": STEP_S, "duration": DURATION_S, "key": key, "vehicles": [],
    }
    if req["count"] == 0:
        result["stats"] = {"iterations": 0, "seconds": 0.0}
        return _remember(key, result)

    with tempfile.TemporaryDirectory(prefix="bgtraffic_") as tmpd:
        cwd = Path(tmpd)
        vtypes = cwd / "vtypes.add.xml"
        _write_vtypes(vtypes)
        route_files: list[Path] = []
        types: dict[str, str] = {}
        pool = 0
        weights = cwd / "weights"
        min_distance = min(600.0, 0.45 * diag)
        bubble = focus is not None
        if bubble:
            # Candidate edges for the aimed trips (_bubble_trips): within reach
            # of the route, not the scenario's own lanes.
            gen_zone = _KeepOut([{"w": 0.0, "pts": pts} for pts in focus["paths"]],
                                focus["radius"] + BUBBLE_GEN_MARGIN_M)
            usable, avoided = _write_trip_weights(net, off, gen_zone, keepout.untimed(), weights)
            if len(usable) < 3:
                bubble = False
        if not bubble:
            usable, avoided = _write_trip_weights(net, off, None, keepout.untimed(), weights)
        usable_edges, avoided_edges = len(usable), len(avoided)
        prefiltered = 0
        result["focus_radius"] = focus["radius"] if bubble else 0
        ego_at = _track_interpolator(focus["track"]) if bubble else None
        radius = focus["radius"] if bubble else 0.0

        def add_trips(round_no: int, n: int) -> None:
            nonlocal pool, prefiltered
            rf = cwd / f"routes{round_no}.rou.xml"
            if bubble:
                _bubble_trips(rf, net, off, vtypes, weights, usable, ego_at, radius, n,
                              req["seed"] + 1000 * round_no, f"r{round_no}_", cwd)
                _drop_trips_starting_near(rf, net, off, ego_at, radius + BUBBLE_INSERT_CLEAR_M)
            else:
                _random_trips(net, rf, vtypes, req["seed"] + 1000 * round_no, n, min_distance, cwd,
                              f"r{round_no}_", weights)
            prefiltered += _drop_routes_using(rf, avoided)
            new = _resolve_types(rf, req["seed"] + round_no)
            types.update(new)
            pool += len(new)
            route_files.append(rf)

        add_trips(0, min(MAX_TRIPS_PER_ROUND, (BUBBLE_POOL_FACTOR if bubble else POOL_FACTOR) * req["count"]))
        topups = 0
        max_topups = BUBBLE_MAX_TOPUPS if bubble else MAX_TOPUPS

        reasons = {"absent": 0, "partial": 0, "popin": 0, "popout": 0, "jump": 0, "keepout": 0, "extra": 0}
        times: list[float] = []
        tracks: dict[str, list] = {}
        spans: dict[str, list[tuple[int, int]]] = {}   # vid -> shown (first, last) indices into its frames
        visible_avg = 0.0
        rounds: list[list] = []   # per simulation: [cars shown (avg in a bubble), dropped, trips added after]
        iterations = 0
        settled = False
        for iterations in range(1, MAX_ITERATIONS + 1):
            fcd = _simulate(net, route_files, vtypes, req["seed"], cwd)
            times, tracks = _read_fcd(fcd, types, off)
            n_frames = len(times)
            drop: set[str] = set()
            spans = {}
            if not bubble:
                drop = set(types) - set(tracks)              # gone before the window
                reasons["absent"] += len(drop)
            for vid, fr in tracks.items():
                half_w = _BP.get(types.get(vid), (2.4, 1.0))[1]
                if bubble:
                    segs = _bubble_segments(fr, times, ego_at, radius, radius + BUBBLE_HYSTERESIS_M)
                    if not segs:
                        continue                             # never near the ego: not shown, not checked
                    if segs[0][0] == 0 and fr[0][0] > 0:     # SUMO inserted it inside the bubble
                        drop.add(vid); reasons["popin"] += 1
                        continue
                    if segs[-1][1] == len(fr) - 1 and fr[-1][0] < n_frames - 1:   # it arrives inside
                        drop.add(vid); reasons["popout"] += 1
                        continue
                else:
                    if len(fr) != n_frames or fr[0][0] != 0:  # pops in or vanishes mid-window
                        drop.add(vid); reasons["partial"] += 1
                        continue
                    segs = [(0, len(fr) - 1)]
                shown_frames = [f for a, b in segs for f in fr[a:b + 1]]
                if any(math.hypot(q[1] - p[1], q[2] - p[2]) > max(p[5], q[5]) * STEP_S + JUMP_SLACK_M
                       or q[0] != p[0] + 1 for a, b in segs for p, q in zip(fr[a:b], fr[a + 1:b + 1])):
                    drop.add(vid); reasons["jump"] += 1      # a teleport
                    continue
                if any(keepout.hits(f[1], f[2], half_w, times[f[0]]) for f in shown_frames):
                    drop.add(vid); reasons["keepout"] += 1
                    continue
                spans[vid] = segs
            shown = sorted(v for v in spans if v not in drop)
            # How many are shown: cars (whole map), or cars around the ego on
            # average over the window (bubble).
            size = {v: (sum(b - a + 1 for a, b in spans[v]) / max(1, n_frames) if bubble else 1.0)
                    for v in shown}
            amount = sum(size.values())
            # Trim to a reserve while cars are still being removed for cause,
            # and to the requested amount only once a round removed none: every
            # removal re-simulates, and can cost a car or two more.
            target = req["count"] if not drop else req["count"] * 1.25
            if amount > target + (0.5 if bubble else 0):
                for v in rng.sample(shown, len(shown)):
                    if amount <= target:
                        break
                    drop.add(v); amount -= size[v]; reasons["extra"] += 1
            visible_avg = amount
            rounds.append([round(amount, 1), len(drop), 0])
            # Short of the request: fresh trips, in the same re-simulation as
            # any removals. Waiting for a round that drops nothing first left
            # Town03 at 10–13 of 40 — every removal cascades into a few more,
            # so such rounds rarely came before MAX_ITERATIONS. The last
            # SETTLE_ROUNDS only remove, so the result can still settle.
            short = req["count"] - (amount if not drop else sum(size[v] for v in shown if v not in drop))
            per_car = (amount / len(shown)) if (bubble and shown) else 1.0
            want_more = (short > (0.1 * req["count"] if bubble else 0) and topups < max_topups
                         and iterations < MAX_ITERATIONS - (SETTLE_ROUNDS if drop else 0))
            if not drop and not want_more:
                settled = True
                break
            for vid in drop:
                types.pop(vid, None)
            if not types and not want_more:
                tracks, spans = {}, {}
                settled = True
                break
            for rf in route_files:
                _routes_without(rf, rf, drop)
            if want_more:
                topups += 1
                before = pool
                # a quarter over the shortfall when cars are still being removed
                need = short + (0.25 * req["count"] if drop else 0)
                add_trips(topups, min(MAX_TRIPS_PER_ROUND, 4 * req["count"],
                                      math.ceil(1.5 * need / max(per_car, 0.05))))
                rounds[-1][2] = pool - before

        final_ids = sorted(v for v in spans if v in types)
        colours = random.Random(req["seed"] * 31 + 7)
        for vid in final_ids:
            fr = tracks.get(vid)
            if not fr:
                continue
            bp = types[vid]
            ex, ey = _BP.get(bp, (2.4, 1.0))
            colour = "{},{},{}".format(*(colours.randrange(30, 230) for _ in range(3)))
            for a, b in spans[vid]:
                # One entry per stretch the car is shown: it exists from t0 for
                # len(frames) samples, one [x, y, z, yaw] per dt — the whole
                # window without a focus; with one, from where it enters the
                # bubble to where it leaves (a car that comes back is a second
                # entry, same `car`).
                result["vehicles"].append({
                    "id": f"bg{len(result['vehicles'])}",
                    "car": vid,
                    "blueprint": bp,
                    "length": round(2 * ex, 3), "width": round(2 * ey, 3),
                    "color": colour,
                    "t0": round(times[fr[a][0]], 3),
                    "frames": [[round(f[1], 2), round(f[2], 2), round(f[3], 2), round(f[4], 1)]
                               for f in fr[a:b + 1]],
                })
        result["frames"] = len(times)
        result["stats"] = {
            "pool": pool, "topups": topups, "iterations": iterations, "settled": settled,
            "usable_edges": usable_edges, "blocked": avoided_edges, "prefiltered": prefiltered,
            "visible_avg": round(visible_avg, 1),
            "dropped": reasons, "rounds": rounds,
            "seconds": round(time.monotonic() - started, 2),
        }
    return _remember(key, result)


def _remember(key: str, result: dict) -> dict:
    with _cache_lock:
        _CACHE[key] = result
        _CACHE.move_to_end(key)
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
    return result
