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
        bubble = focus is not None
        if bubble:
            # Candidate edges for the aimed trips (_bubble_trips): within reach
            # of the route, not the scenario's own lanes.
            gen_zone = _KeepOut(
                [{"w": 0.0, "pts": pts} for pts in focus["paths"]], focus["radius"] + BUBBLE_GEN_MARGIN_M
            )
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
            shown = sorted(v for v in spans if v not in drop)
            # How many are shown: cars (whole map), or cars around the ego on
            # average over the window (bubble).
            size = {v: (sum(b - a + 1 for a, b in spans[v]) / max(1, n_frames) if bubble else 1.0) for v in shown}
            amount = sum(size.values())
            # Trim to a reserve while cars are still being removed for cause,
            # and to the requested amount only once a round removed none: every
            # removal re-simulates, and can cost a car or two more.
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
            # Short of the request: fresh trips, in the same re-simulation as
            # any removals. Waiting for a round that drops nothing first left
            # Town03 at 10–13 of 40 — every removal cascades into a few more,
            # so such rounds rarely came before MAX_ITERATIONS. The last
            # SETTLE_ROUNDS only remove, so the result can still settle.
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
                # a quarter over the shortfall when cars are still being removed
                need = short + (0.25 * req["count"] if drop else 0)
                add_trips(
                    topups, min(MAX_TRIPS_PER_ROUND, 4 * req["count"], math.ceil(1.5 * need / max(per_car, 0.05)))
                )
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
                result["vehicles"].append(
                    {
                        "id": f"bg{len(result['vehicles'])}",
                        "car": vid,
                        "blueprint": bp,
                        "length": round(2 * ex, 3),
                        "width": round(2 * ey, 3),
                        "color": colour,
                        "t0": round(times[fr[a][0]], 3),
                        "frames": [
                            [round(f[1], 2), round(f[2], 2), round(f[3], 2), round(f[4], 1)] for f in fr[a : b + 1]
                        ],
                    }
                )
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


def _remember(key: str, result: dict) -> dict:
    with _cache_lock:
        _CACHE[key] = result
        _CACHE.move_to_end(key)
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
    return result
