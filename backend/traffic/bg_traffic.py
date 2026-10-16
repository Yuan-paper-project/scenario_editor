"""Background traffic: SUMO trajectories that the preview and CARLA (tools/bg_traffic_player.py) replay.

Both sides replay the same file, so the preview is exact, but the cars react to nothing. So any
car coming near the scripted scenario — in space AND time: within the clearance of a track point
whose time is within KEEPOUT_TIME_S of its own — is removed and the rest re-simulated, until
nothing is dropped. Untimed parts (props) block all run and also prune edges and turns up front.

Whole map: `count` cars, each present for the whole window. Bubble (focus radius R): a car is in
the file only while within R of the preview's ego, as {t0, frames} entries, and `count` is the
average shown; trips are aimed at the bubble (_bubble_trips).

Per request: .xodr → SUMO net (cached in maps/<Town>/sumo/), a trip pool, sumo with FCD output,
then drop pop-ins, vanishings, teleports and keep-out hits and re-simulate (topping up when
short, except in the last SETTLE_ROUNDS) at most MAX_ITERATIONS times. Poses are converted
with CARLA's BridgeHelper.get_carla_transform.
"""

from __future__ import annotations

import hashlib
import json
import math
import random
import tempfile
import threading
import time
from collections import OrderedDict
from pathlib import Path

from backend.traffic.bg_keepout import _drop_routes_using, _KeepOut, _write_trip_weights
from backend.traffic.bg_sumo import (
    _BP,
    DURATION_S,
    STEP_S,
    BgTrafficError,
    _net_info,
    _read_fcd,
    _resolve_types,
    _simulate,
    _write_vtypes,
    sumo_net,
)
from backend.traffic.bg_trips import (
    BUBBLE_INSERT_CLEAR_M,
    _bubble_segments,
    _bubble_trips,
    _drop_trips_starting_near,
    _random_trips,
    _routes_without,
    _track_interpolator,
)

FORMAT_VERSION = 2  # 2: per-car t0 (a car need not exist for the whole window)
POOL_FACTOR = 2  # trips generated per requested car, up front
MAX_TOPUPS = 3  # rounds of fresh trips when a settled run is short
MAX_ITERATIONS = 16
SETTLE_ROUNDS = 4  # the last rounds only remove cars (see generate)
MAX_COUNT = 200
JUMP_SLACK_M = 2.0  # a step longer than speed·dt + this is a teleport
MAX_FOCUS_RADIUS = 500.0
KEEPOUT_TIME_S = 8.0  # a car may use a spot on a scripted path this long before/after its actor
BUBBLE_GEN_MARGIN_M = 250.0  # candidate trip edges: within the bubble radius + this of the route
BUBBLE_POOL_FACTOR = 6  # aimed trips: most pass the ego, each for part of the window
BUBBLE_MAX_TOPUPS = 6
MAX_TRIPS_PER_ROUND = 600  # SUMO time and FCD size grow with every trip
BUBBLE_HYSTERESIS_M = 20.0  # a shown car is removed only beyond radius + this
_CACHE: OrderedDict[str, dict] = OrderedDict()
_CACHE_MAX = 12
_cache_lock = threading.Lock()


def _cache_key(town: str, net: Path, req: dict) -> str:
    blob = json.dumps(
        {"v": FORMAT_VERSION, "town": town, "net": net.stat().st_mtime, **req}, sort_keys=True, separators=(",", ":")
    )
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
        pts = [[round(float(v), 1) for v in q[:3]] for q in (p.get("pts") or []) if len(q) >= 2]
        if pts:
            paths.append({"w": round(float(p.get("w", 1.0)), 2), "pts": pts})
    # Focus: {radius, paths}, the ego's route as separate polylines (joined, a gap becomes a chord).
    # Radius 0 or no points: the whole map.
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
    # track: [[t, x, y], …], the ego as the preview predicts it.
    track = sorted(
        [
            [round(float(q[0]), 2), round(float(q[1]), 1), round(float(q[2]), 1)]
            for q in (focus.get("track") or [])
            if len(q) >= 3
        ]
    )
    focus_req = (
        {"radius": round(radius, 1), "paths": fpaths, "track": track} if radius > 0 and fpaths and track else None
    )
    return {"seed": seed, "count": count, "clearance": round(clearance, 2), "keepout": paths, "focus": focus_req}


def generate(town: str, xodr: Path, body: dict) -> dict:
    """Background traffic for one scenario (see the module docstring)."""
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
    rng = random.Random(req["seed"])
    result = {
        "version": FORMAT_VERSION,
        "town": town,
        "seed": req["seed"],
        "requested": req["count"],
        "clearance": req["clearance"],
        "focus_radius": 0,  # set below: 0 for the whole map, also when nothing near the route was drivable
        "dt": STEP_S,
        "duration": DURATION_S,
        "key": key,
        "vehicles": [],
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
        bubble, usable, avoided = _trip_edges(net, off, focus, keepout, weights)
        usable_edges, avoided_edges = len(usable), len(avoided)
        prefiltered = 0
        result["focus_radius"] = focus["radius"] if bubble else 0
        ego_at = _track_interpolator(focus["track"]) if bubble else None
        radius = focus["radius"] if bubble else 0.0

        def add_trips(round_no: int, n: int) -> None:
            nonlocal pool, prefiltered
            rf = cwd / f"routes{round_no}.rou.xml"
            if bubble:
                _bubble_trips(
                    rf,
                    net,
                    off,
                    vtypes,
                    weights,
                    usable,
                    ego_at,
                    radius,
                    n,
                    req["seed"] + 1000 * round_no,
                    f"r{round_no}_",
                    cwd,
                )
                _drop_trips_starting_near(rf, net, off, ego_at, radius + BUBBLE_INSERT_CLEAR_M)
            else:
                _random_trips(
                    net, rf, vtypes, req["seed"] + 1000 * round_no, n, min_distance, cwd, f"r{round_no}_", weights
                )
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
        spans: dict[str, list[tuple[int, int]]] = {}  # vid -> shown (first, last) indices into its frames
        visible_avg = 0.0
        rounds: list[list] = []  # per simulation: [cars shown (avg in a bubble), dropped, trips added after]
        iterations = 0
        settled = False
        for iterations in range(1, MAX_ITERATIONS + 1):
            fcd = _simulate(net, route_files, vtypes, req["seed"], cwd)
            times, tracks = _read_fcd(fcd, types, off)
            n_frames = len(times)
            drop, spans = _vet_tracks(tracks, types, times, bubble, ego_at, radius, keepout, reasons)
            shown = sorted(v for v in spans if v not in drop)
            # How many are shown: cars (whole map), or the average around the ego (bubble).
            size = {v: (sum(b - a + 1 for a, b in spans[v]) / max(1, n_frames) if bubble else 1.0) for v in shown}
            amount = sum(size.values())
            # Keep a reserve while removals continue (each can cascade); trim exactly once clean.
            target = req["count"] if not drop else req["count"] * 1.25
            if amount > target + (0.5 if bubble else 0):
                for v in rng.sample(shown, len(shown)):
                    if amount <= target:
                        break
                    drop.add(v)
                    amount -= size[v]
                    reasons["extra"] += 1
            visible_avg = amount
            rounds.append([round(amount, 1), len(drop), 0])
            # Short: fresh trips in the same re-simulation as the removals (waiting for a clean round
            # left Town03 at 10–13 of 40); the last SETTLE_ROUNDS only remove.
            short = req["count"] - (amount if not drop else sum(size[v] for v in shown if v not in drop))
            per_car = (amount / len(shown)) if (bubble and shown) else 1.0
            want_more = (
                short > (0.1 * req["count"] if bubble else 0)
                and topups < max_topups
                and iterations < MAX_ITERATIONS - (SETTLE_ROUNDS if drop else 0)
            )
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
                # a quarter over the shortfall while cars are still being removed
                need = short + (0.25 * req["count"] if drop else 0)
                add_trips(
                    topups, min(MAX_TRIPS_PER_ROUND, 4 * req["count"], math.ceil(1.5 * need / max(per_car, 0.05)))
                )
                rounds[-1][2] = pool - before

        result["vehicles"] = _vehicle_entries(tracks, spans, types, times, req["seed"])
        result["frames"] = len(times)
        result["stats"] = {
            "pool": pool,
            "topups": topups,
            "iterations": iterations,
            "settled": settled,
            "usable_edges": usable_edges,
            "blocked": avoided_edges,
            "prefiltered": prefiltered,
            "visible_avg": round(visible_avg, 1),
            "dropped": reasons,
            "rounds": rounds,
            "seconds": round(time.monotonic() - started, 2),
        }
    return _remember(key, result)


def _trip_edges(net: Path, off, focus: dict | None, keepout: _KeepOut, weights: Path) -> tuple[bool, list, list]:
    """(bubble, usable, avoided): the edges trips may start, end and pass on.

    A bubble aims its trips near the route; with fewer than 3 usable edges there it falls back to
    the whole map.
    """
    bubble = focus is not None
    if bubble:
        # Edges for the aimed trips: near the route, not the scenario's own lanes.
        gen_zone = _KeepOut([{"w": 0.0, "pts": pts} for pts in focus["paths"]], focus["radius"] + BUBBLE_GEN_MARGIN_M)
        usable, avoided = _write_trip_weights(net, off, gen_zone, keepout.untimed(), weights)
        if len(usable) < 3:
            bubble = False
    if not bubble:
        usable, avoided = _write_trip_weights(net, off, None, keepout.untimed(), weights)
    return bubble, usable, avoided


def _vet_tracks(tracks, types, times, bubble, ego_at, radius, keepout, reasons) -> tuple[set, dict]:
    """(drop, spans) for one simulation: the cars to remove, and each kept car's shown stretches.

    Counts every removal in `reasons`.
    """
    n_frames = len(times)
    drop: set[str] = set()
    spans = {}
    if not bubble:
        drop = set(types) - set(tracks)  # gone before the window
        reasons["absent"] += len(drop)
    for vid, fr in tracks.items():
        half_w = _BP.get(types.get(vid), (2.4, 1.0))[1]
        if bubble:
            segs = _bubble_segments(fr, times, ego_at, radius, radius + BUBBLE_HYSTERESIS_M)
            if not segs:
                continue  # never near the ego: not shown, not checked
            if segs[0][0] == 0 and fr[0][0] > 0:  # SUMO inserted it inside the bubble
                drop.add(vid)
                reasons["popin"] += 1
                continue
            if segs[-1][1] == len(fr) - 1 and fr[-1][0] < n_frames - 1:  # it arrives inside
                drop.add(vid)
                reasons["popout"] += 1
                continue
        else:
            if len(fr) != n_frames or fr[0][0] != 0:  # pops in or vanishes mid-window
                drop.add(vid)
                reasons["partial"] += 1
                continue
            segs = [(0, len(fr) - 1)]
        shown_frames = [f for a, b in segs for f in fr[a : b + 1]]
        if any(
            math.hypot(q[1] - p[1], q[2] - p[2]) > max(p[5], q[5]) * STEP_S + JUMP_SLACK_M or q[0] != p[0] + 1
            for a, b in segs
            for p, q in zip(fr[a:b], fr[a + 1 : b + 1])
        ):
            drop.add(vid)
            reasons["jump"] += 1  # a teleport
            continue
        if any(keepout.hits(f[1], f[2], half_w, times[f[0]]) for f in shown_frames):
            drop.add(vid)
            reasons["keepout"] += 1
            continue
        spans[vid] = segs
    return drop, spans


def _vehicle_entries(tracks, spans, types, times, seed) -> list[dict]:
    """The output's `vehicles`: one entry per shown stretch of each kept car."""
    vehicles: list[dict] = []
    final_ids = sorted(v for v in spans if v in types)
    colours = random.Random(seed * 31 + 7)
    for vid in final_ids:
        fr = tracks.get(vid)
        if not fr:
            continue
        bp = types[vid]
        ex, ey = _BP.get(bp, (2.4, 1.0))
        colour = "{},{},{}".format(*(colours.randrange(30, 230) for _ in range(3)))
        for a, b in spans[vid]:
            # One entry per shown stretch: from t0, one [x, y, z, yaw] per dt (a car that
            # returns is a second entry with the same `car`).
            vehicles.append(
                {
                    "id": f"bg{len(vehicles)}",
                    "car": vid,
                    "blueprint": bp,
                    "length": round(2 * ex, 3),
                    "width": round(2 * ey, 3),
                    "color": colour,
                    "t0": round(times[fr[a][0]], 3),
                    "frames": [[round(f[1], 2), round(f[2], 2), round(f[3], 2), round(f[4], 1)] for f in fr[a : b + 1]],
                }
            )
    return vehicles


def _remember(key: str, result: dict) -> dict:
    with _cache_lock:
        _CACHE[key] = result
        _CACHE.move_to_end(key)
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
    return result
