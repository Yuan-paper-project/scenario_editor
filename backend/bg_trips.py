"""Trip generation for background traffic: aimed trips for the bubble around the ego, random trips for the whole map."""

from __future__ import annotations

import math
import random
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from backend.bg_keepout import _densify
from backend.bg_sumo import DURATION_S, WARMUP_S, _run, _sumolib_net, sumo_home

BUBBLE_INSERT_CLEAR_M = 30.0  # trips departing within radius + this of the ego are not generated
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


def _bubble_trips(
    routes: Path,
    net: Path,
    off,
    vtypes: Path,
    weights: Path,
    usable: list[str],
    ego_at,
    radius: float,
    n: int,
    seed: int,
    prefix: str,
    cwd: Path,
) -> None:
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
        t_meet = max(0.0, depart - WARMUP_S) + 8.0  # ~8 s to drive into the bubble
        ex, ey = ego_at(t_meet)
        if early:
            src = pick(ex, ey, 0.0, radius + 150.0, "start")  # inserted before the window: anywhere
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
            fh.write(
                f'    <trip id="{tid}" depart="{depart:.2f}" from="{src}" to="{dst}" via="{via}" '
                f'type="bg" departLane="best" departSpeed="max"/>\n'
            )
        fh.write("</routes>\n")
    _run(
        [
            str(sumo_home() / "bin" / "duarouter"),
            "-n",
            str(net),
            "--route-files",
            str(tfile),
            "-o",
            str(routes),
            "--additional-files",
            str(vtypes),
            "--weight-files",
            str(weights) + ".route.xml",
            "--weight-attribute",
            "traveltime",
            "--remove-loops",
            "--ignore-errors",
            "--no-warnings",
            "--no-step-log",
            "--alternatives-output",
            "NUL",
        ],
        cwd=cwd,
    )


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
            continue  # inserted before the window opens
        route = el.find("route")
        edges = (route.get("edges") if route is not None else "").split()
        if not edges:
            continue
        x, y = snet.getEdge(edges[0]).getShape()[0]
        ex, ey = ego_at(t)
        if math.hypot(x - off[0] - ex, -(y - off[1]) - ey) < clear_r:
            root.remove(el)
    tree.write(routes)


def _random_trips(
    net: Path,
    out: Path,
    vtypes: Path,
    seed: int,
    n_trips: int,
    min_distance: float,
    cwd: Path,
    prefix: str,
    weights: Path | None = None,
) -> None:
    home = sumo_home()
    period = WARMUP_S / max(1, n_trips)
    extra = []
    if weights:
        extra = [
            "--weights-prefix",
            str(weights),
            "--duarouter-weight-files",
            str(weights) + ".route.xml",
            "--duarouter-weight-attribute",
            "traveltime",
        ]
    _run(
        [
            sys.executable,
            str(home / "tools" / "randomTrips.py"),
            "-n",
            str(net),
            "-r",
            str(out),
            "-o",
            str(out.with_suffix(".trips.xml")),
            "--prefix",
            prefix,
            "--seed",
            str(seed),
            "--begin",
            "0",
            "--end",
            f"{WARMUP_S:.1f}",
            "--period",
            f"{period:.4f}",
            "--min-distance",
            f"{min_distance:.0f}",
            "--fringe-factor",
            "1",
            "--vclass",
            "passenger",
            "--intermediate",
            "12",  # long routes: a car must last the whole window
            "--remove-loops",
            "--validate",
            "--trip-attributes",
            'type="bg" departLane="best" departSpeed="max"',
            "--additional-files",
            str(vtypes),
        ]
        + extra,
        cwd=cwd,
    )


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
