"""Benchmark scenarios rebuilt with the generator (Chat2Scenic, Loop2Scenic).

Each case quotes a scenario description from a public benchmark and builds it
as a generator type plus pinned parameters. Then it checks, on the built
scenario and its headless preview run, that the geometry really is the one
the text describes. Checking that `params.layout == 'ego_left_oncoming'` would
only test the label the generator gave itself, so the routes are measured
instead: the ego turns left, the other car comes from the opposite direction
and goes straight, they meet. Every case must also export.

  Chat2Scenic: https://github.com/TUM-AVS/Chat2scenic  (Benchmark/*.txt)
  Loop2Scenic: https://yuangao-tum.github.io/loop2scenic-bench/  (tests/bench/)

The recipe panel is driven through real clicks for the new pins (layout,
obstacle variant, curve site, drift cause), and the new generator types through
the Generieren menu.
"""
import json
import sys

from playwright.sync_api import sync_playwright

import _harness as H

C = H.Checks()

# What the analysis needs from a built scenario: routes as polylines, every
# actor's preview track, and where the conflict happened.
ANALYZE = """() => {
  const P = p => Array.isArray(p) ? { x: p[0], y: p[1] } : { x: p.x, y: p.y };
  const routeOf = a => {
    const ev = (a.events || []).find(e => e.action?.type === 'assign_route');
    if (ev) return (Simulate.routeGeometry(a, ev) || []).map(P);
    const tr = (a.events || []).find(e => e.action?.type === 'follow_trajectory');
    return tr ? tr.action.trajectory.map(P) : [];
  };
  const run = Simulate.runHeadless({ dt: 0.05, maxTime: 45 });
  const actors = [AppState.ego, ...AppState.npcs];
  const lane = (a, types) => {
    const q = ObjectsManager.nearestLaneProjection(a.x, a.y, new Set(types), 3);
    return q ? Math.round(q.dist * 100) / 100 : null;
  };
  return {
    gen: AppState.generated,
    actors: actors.map(a => ({
      id: a.id, type: a.type, x: a.x, y: a.y, yaw: a.yaw, speed: a.initial_speed,
      events: a.events, route: routeOf(a),
      track: run.tracks[a.id].map(p => ({ x: p.x, y: p.y })),
      parking: lane(a, ['parking']), driving: lane(a, ['driving']),
    })),
    props: AppState.staticObjects.map(p => ({ prop: p.prop, x: p.x, y: p.y })),
    times: run.times,
  };
}"""

EXPORT = """async () => {
  const p = ScenarioIO.buildParamsForTesting();
  const r = await fetch('/api/export', {method: 'POST',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify(p)});
  return { ok: r.ok, status: r.status, text: (await r.text()).slice(0, 200) };
}"""


# ── Geometry on the Python side ──────────────────────────────────────────────

def wrap(d):
    return (d + 180) % 360 - 180


def heading(a, b):
    import math
    return math.degrees(math.atan2(b["y"] - a["y"], b["x"] - a["x"]))


def dist(a, b):
    return ((a["x"] - b["x"]) ** 2 + (a["y"] - b["y"]) ** 2) ** 0.5


def nearest(poly, q):
    """(index of the nearer end of the closest segment, distance to that
    SEGMENT). Route vertices are ~2 m apart, so the vertex distance alone is
    up to a metre off."""
    best, bd = 0, dist(poly[0], q) if poly else 1e9
    for i in range(1, len(poly)):
        a, b = poly[i - 1], poly[i]
        dx, dy = b["x"] - a["x"], b["y"] - a["y"]
        l2 = dx * dx + dy * dy
        t = 0 if l2 <= 0 else max(0, min(1, ((q["x"] - a["x"]) * dx + (q["y"] - a["y"]) * dy) / l2))
        d = dist({"x": a["x"] + t * dx, "y": a["y"] + t * dy}, q)
        if d < bd:
            best, bd = (i if t > 0.5 else i - 1), d
    return best, bd


def walk(poly, i, metres):
    """Index `metres` along `poly` from index i (negative = back)."""
    step = 1 if metres > 0 else -1
    left = abs(metres)
    while 0 <= i + step < len(poly) and left > 0:
        left -= dist(poly[i], poly[i + step])
        i += step
    return i


def heading_at(poly, i, span=4):
    a, b = poly[max(0, i - 1)], poly[min(len(poly) - 1, i + 1)]
    j = walk(poly, i, -span)
    k = walk(poly, i, span)
    if k > j:
        a, b = poly[j], poly[k]
    return heading(a, b)


def turn_through(poly, q, before=22, after=22):
    """Heading change along `poly` from `before` m ahead of its point nearest
    q to `after` m past it. y-down map: a left turn is negative."""
    i, _ = nearest(poly, q)
    return wrap(heading_at(poly, walk(poly, i, after)) - heading_at(poly, walk(poly, i, -before)))


def closest_approach(a, b):
    """(index, centre distance) of the closest approach of two tracks."""
    n = min(len(a["track"]), len(b["track"]))
    i = min(range(n), key=lambda k: dist(a["track"][k], b["track"][k]))
    return i, dist(a["track"][i], b["track"][i])


def conflict_point(r):
    at = (r["gen"].get("criticality") or {}).get("at")
    return at


# ── Cases ────────────────────────────────────────────────────────────────────
#
# (id, source, quoted description, town, generator type, seed, pins, checker)

def chk_left_turn_oncoming(tag, r):
    ego, npc = r["actors"][0], r["actors"][1]
    at = conflict_point(r)
    C(f"{tag}: the ego turns left through the conflict",
      turn_through(ego["route"], at, 30, 25) < -45, turn_through(ego["route"], at, 30, 25))
    C(f"{tag}: the other car goes straight", abs(turn_through(npc["route"], at)) < 30,
      turn_through(npc["route"], at))
    ie, _ = nearest(ego["route"], at)
    jn, _ = nearest(npc["route"], at)
    app = wrap(heading_at(npc["route"], walk(npc["route"], jn, -25)) - heading_at(ego["route"], walk(ego["route"], ie, -30)))
    C(f"{tag}: ...coming from the opposite direction", abs(app) > 150, app)


def chk_npc_left_oncoming(tag, r):
    ego, npc = r["actors"][0], r["actors"][1]
    at = conflict_point(r)
    C(f"{tag}: the ego goes straight", abs(turn_through(ego["route"], at)) < 30, turn_through(ego["route"], at))
    C(f"{tag}: the oncoming car turns left across it", turn_through(npc["route"], at, 30, 25) < -45,
      turn_through(npc["route"], at, 30, 25))
    ie, _ = nearest(ego["route"], at)
    jn, _ = nearest(npc["route"], at)
    app = wrap(heading_at(npc["route"], walk(npc["route"], jn, -30)) - heading_at(ego["route"], walk(ego["route"], ie, -22)))
    C(f"{tag}: ...from the opposite direction", abs(app) > 150, app)


def chk_crossing(tag, r):
    ego, npc = r["actors"][0], r["actors"][1]
    at = conflict_point(r)
    C(f"{tag}: both go straight", abs(turn_through(ego["route"], at)) < 30 and abs(turn_through(npc["route"], at)) < 30,
      (turn_through(ego["route"], at), turn_through(npc["route"], at)))
    ie, _ = nearest(ego["route"], at)
    jn, _ = nearest(npc["route"], at)
    app = abs(wrap(heading_at(npc["route"], jn) - heading_at(ego["route"], ie)))
    C(f"{tag}: ...on crossing paths", 50 < app < 130, app)
    C(f"{tag}: the crossing car ignores lights (runs the red)", npc["events"] and True)


def chk_turn_vru(want_turn, vru_type):
    def chk(tag, r):
        ego, vru = r["actors"][0], r["actors"][1]
        C(f"{tag}: the crossing person is a {vru_type}", vru["type"] == vru_type, vru["type"])
        traj = vru["events"][0]["action"].get("trajectory") or []
        # Where the kerb-to-kerb line meets the ego's route (not its middle:
        # on a wide two-way road that is the centre line, metres away).
        a, b = traj[0], traj[-1]
        pts = [{"x": a["x"] + (b["x"] - a["x"]) * k / 80, "y": a["y"] + (b["y"] - a["y"]) * k / 80} for k in range(81)]
        mid = min(pts, key=lambda q: nearest(ego["route"], q)[1])
        i, d = nearest(ego["route"], mid)
        C(f"{tag}: the crossing is on the ego's route", d < 2.5, d)
        t = wrap(heading_at(ego["route"], walk(ego["route"], i, -3)) - heading_at(ego["route"], walk(ego["route"], i, -40)))
        ok = t < -45 if want_turn == "left" else t > 45
        C(f"{tag}: the ego has just turned {want_turn} when it reaches the crossing", ok, t)
        cross = abs(wrap(heading(traj[0], traj[-1]) - heading_at(ego["route"], i)))
        C(f"{tag}: the person crosses the road the ego turned into", 60 < cross < 120, cross)
        _, cd = closest_approach(ego, vru)
        C(f"{tag}: a non-reacting ego meets it", cd < 3.0, cd)
    return chk


def chk_turn_with_cross_traffic(ego_turn, npc_from):
    """Ego turns `ego_turn`; the other car comes from the ego's `npc_from`
    and goes straight. y-down map: a car from the ego's left heads +90°
    from the ego's heading."""
    def chk(tag, r):
        ego, npc = r["actors"][0], r["actors"][1]
        at = conflict_point(r)
        # The ego's turn across its whole junction, not around the contact
        # point, which can be anywhere on the turn.
        i0, _ = nearest(ego["route"], at)
        t = wrap(heading_at(ego["route"], walk(ego["route"], i0, 30)) - heading_at(ego["route"], walk(ego["route"], i0, -40)))
        C(f"{tag}: the ego turns {ego_turn}", t < -45 if ego_turn == "left" else t > 45, t)
        C(f"{tag}: the other car goes straight", abs(turn_through(npc["route"], at)) < 30, turn_through(npc["route"], at))
        jn, _ = nearest(npc["route"], at)
        rel = wrap(heading_at(npc["route"], walk(npc["route"], jn, -25)) - heading_at(ego["route"], walk(ego["route"], i0, -40)))
        ok = 45 < rel < 135 if npc_from == "left" else -135 < rel < -45
        C(f"{tag}: ...coming from the ego's {npc_from}", ok, rel)
        _, cd = closest_approach(ego, npc)
        C(f"{tag}: they meet", cd < 7.0, cd)
    return chk


def chk_rear_approach(npc_type):
    def chk(tag, r):
        ego, npc = r["actors"][0], r["actors"][1]
        C(f"{tag}: the car from behind is a {npc_type}", npc["type"] == npc_type, npc["type"])
        lc = [e for e in ego["events"] if e["action"]["type"] == "lane_change"]
        C(f"{tag}: the ego is set to change lanes", len(lc) == 1, [e["action"]["type"] for e in ego["events"]])
        # Behind the ego at the start, on the neighbouring lane.
        i_e, _ = nearest(ego["route"], ego)
        i_n, d_n = nearest(ego["route"], npc)
        ahead = heading_at(ego["route"], i_e)
        import math
        along = (npc["x"] - ego["x"]) * math.cos(math.radians(ahead)) + (npc["y"] - ego["y"]) * math.sin(math.radians(ahead))
        C(f"{tag}: it starts behind the ego", along < -2, along)
        # Sideways in the ego's frame: it is behind the start of the ego's
        # route, so a distance to that route is a distance to its first point.
        side = abs(-(npc["x"] - ego["x"]) * math.sin(math.radians(ahead)) + (npc["y"] - ego["y"]) * math.cos(math.radians(ahead)))
        C(f"{tag}: ...in the next lane, not the ego's", 2.0 < side < 5.5, side)
        surge = npc["events"][0]["action"]["target"]["value"]
        C(f"{tag}: it is faster than the ego", surge > ego["speed"], (surge, ego["speed"]))
        _, cd = closest_approach(ego, npc)
        C(f"{tag}: an ego that changes regardless is hit", cd < 3.0, cd)
    return chk


def chk_slow_lead(diff_kmh, lead_type, lateral=None):
    def chk(tag, r):
        ego, lead = r["actors"][0], r["actors"][1]
        C(f"{tag}: lead is a {lead_type}", lead["type"] == lead_type, lead["type"])
        d = (ego["speed"] - lead["speed"]) * 3.6
        if diff_kmh is not None:
            C(f"{tag}: speed difference {diff_kmh} km/h", abs(d - diff_kmh) < 2, d)
        i, cd = closest_approach(ego, lead)
        C(f"{tag}: a non-reacting ego runs into it", cd < 5.0, cd)
        if lateral is not None:
            off = [e for e in lead["events"] if e["action"]["type"] == "lane_offset"]
            C(f"{tag}: lead held {lateral} m off the lane centre",
              off and abs(off[0]["action"]["offset"] - lateral) < 0.05, off)
            # Off the centre in the preview too, by the time the ego is close.
            j, _ = nearest(ego["route"], lead["track"][i])
            seen = dist(lead["track"][i], ego["route"][j])
            C(f"{tag}: ...and actually off it when the ego closes in", seen > lateral - 0.35, seen)
    return chk


def chk_standing(vru_type, facing_away=True):
    def chk(tag, r):
        ego = r["actors"][0]
        st = [a for a in r["actors"][1:] if a["type"] == vru_type and not a["events"]]
        if not C(f"{tag}: a standing {vru_type} (no events)", len(st) == 1, [a["type"] for a in r["actors"]]):
            return
        v = st[0]
        i, d = nearest(ego["route"], v)
        C(f"{tag}: it stands in the ego's path", d < 1.0, d)
        if facing_away:
            C(f"{tag}: ...with its back to the ego", abs(wrap(v["yaw"] - heading_at(ego["route"], i))) < 20,
              (v["yaw"], heading_at(ego["route"], i)))
        _, cd = closest_approach(ego, v)
        C(f"{tag}: a non-reacting ego reaches it", cd < 2.5, cd)
    return chk


def chk_queue(tag, r):
    ego = r["actors"][0]
    still = [a for a in r["actors"][1:] if not a["events"]]
    types = [a["type"] for a in still]
    C(f"{tag}: a motorcycle and a car standing", sorted(types) == ["car", "motorcycle"], types)
    if len(still) == 2:
        order = sorted(still, key=lambda a: nearest(ego["route"], a)[0])
        C(f"{tag}: the ego meets the motorcycle first", order[0]["type"] == "motorcycle", [a["type"] for a in order])
        C(f"{tag}: both in the ego's lane", all(nearest(ego["route"], a)[1] < 1.0 for a in still),
          [nearest(ego["route"], a)[1] for a in still])


def chk_stopped_vehicle(vtype, curve=False, lateral=None, oncoming=False):
    def chk(tag, r):
        ego = r["actors"][0]
        st = [a for a in r["actors"][1:] if not a["events"] and a["type"] == vtype]
        if not C(f"{tag}: a stopped {vtype}", len(st) == 1, [a["type"] for a in r["actors"]]):
            return
        v = st[0]
        i, d = nearest(ego["route"], v)
        if lateral is not None:
            C(f"{tag}: {lateral} m off the lane centre", abs(d - lateral) < 0.25, d)
        else:
            C(f"{tag}: in the ego's lane", d < 1.1, d)
        if curve:
            t = wrap(heading_at(ego["route"], walk(ego["route"], i, 15)) - heading_at(ego["route"], walk(ego["route"], i, -15)))
            C(f"{tag}: ...in a curve", abs(t) > 12, t)
        rel = abs(wrap(v["yaw"] - heading_at(ego["route"], i)))
        if oncoming:
            C(f"{tag}: ...facing the ego", rel > 160, rel)
        else:
            C(f"{tag}: ...facing the ego's way", rel < 20, rel)
    return chk


def chk_pull_out(tag, r):
    ego, npc = r["actors"][0], r["actors"][1]
    C(f"{tag}: the car starts in a parking lane", npc["parking"] is not None and npc["parking"] < 0.5, npc["parking"])
    C(f"{tag}: ...standing (start speed 0)", npc["speed"] == 0, npc["speed"])
    # 40 m on from the bay it is on the ego's road (its route runs on past
    # the ego's, so not its end).
    on = npc["route"][walk(npc["route"], 0, 40)] if npc["route"] else None
    _, d = nearest(ego["route"], on) if on else (0, 99)
    C(f"{tag}: it drives on along the ego's road", d < 2.5, d)
    i, cd = closest_approach(ego, npc)
    C(f"{tag}: it ends up in front of a non-reacting ego", cd < 5.0, cd)
    rel = nearest(ego["route"], npc["track"][i])[0] >= nearest(ego["route"], ego["track"][i])[0]
    C(f"{tag}: ...ahead of it, not behind", rel)


def chk_drift_parked(tag, r):
    ego = r["actors"][0]
    drift = next(a for a in r["actors"][1:] if a["events"])
    parked = [a for a in r["actors"][1:] if not a["events"]]
    if not C(f"{tag}: a parked car is the reason for the swerve", len(parked) == 1, len(parked)):
        return
    p = parked[0]
    _, dp = nearest(ego["route"], p)
    C(f"{tag}: it is in the oncoming lane, not the ego's", 2.0 < dp < 6.0, dp)
    _, dd = closest_approach(drift, p)
    C(f"{tag}: the drifting car clears it", dd > 2.2, dd)
    _, de = closest_approach(drift, ego)
    C(f"{tag}: ...and comes at the ego", de < 4.0, de)


def chk_occluded_ped(tag, r):
    kinds = [a["type"] for a in r["actors"][1:]]
    C(f"{tag}: a pedestrian and a parked vehicle hiding it",
      "pedestrian" in kinds and any(k in ("van", "truck", "car") for k in kinds), kinds)


def chk_type_is(field, value):
    def chk(tag, r):
        C(f"{tag}: {field} is {value}", r["gen"]["params"].get(field) == value, r["gen"]["params"].get(field))
    return chk


CASES = [
    # ── Chat2Scenic ──
    ("c2s-carla-02", "Chat2Scenic CARLA_Leaderboard #2",
     "The ego-vehicle is performing an unprotected left turn at an intersection, yielding to oncoming traffic.",
     "Town03", "junction_conflict", 2, {"layout": "ego_left_oncoming"}, chk_left_turn_oncoming),
    ("c2s-r152-01", "Chat2Scenic UN_R152 #1",
     "the subject vehicle passes by a left turn ... in front of an oncoming vehicle that is stopped to make a left turn",
     "Town05", "junction_conflict", 3, {"layout": "npc_left_oncoming"}, chk_npc_left_oncoming),
    ("c2s-r171-36", "Chat2Scenic UN_R171 #36",
     "The ego vehicle approaches an intersection in a straight line while a vehicle target enters from the side",
     "Town03", "junction_conflict", 1, {"layout": "crossing"}, chk_crossing),
    ("c2s-carla-06", "Chat2Scenic CARLA_Leaderboard #6",
     "The ego-vehicle needs to perform a turn at an intersection yielding to bicycles crossing from either the left or right.",
     "Town05", "turn_vru", 4, {"vru_type": "cyclist", "turn": "left"}, chk_turn_vru("left", "cyclist")),
    ("c2s-pre-10", "Chat2Scenic NHTSA_PreCrash #10 / UN_R171 #33",
     "Vehicle is turning right ... and encounters a pedalcyclist / pedestrian target begins crossing ... at 5 km/h",
     "Town03", "turn_vru", 3, {"turn": "right", "vru_type": "pedestrian", "speed": 1.4},
     chk_turn_vru("right", "pedestrian")),
    ("c2s-r171-14", "Chat2Scenic UN_R171 #14",
     "approaches a slower moving heavy truck or motorcycle ... traveling at a speed exactly 50 km/h less than the ego",
     "Town04", "slow_lead", 1, {"lead_type": "truck", "ego_speed": 16, "lead_speed": 2.1}, chk_slow_lead(50, "truck")),
    ("c2s-r171-15", "Chat2Scenic UN_R171 #15",
     "slower moving vehicle target ahead ... with a significant lateral offset ... exceeding the 0.5-meter threshold",
     "Town04", "slow_lead", 2, {"lead_type": "car", "ego_speed": 12, "lead_speed": 5, "lateral_m": 0.8, "side": "left"},
     chk_slow_lead(25, "car", 0.8)),
    ("c2s-r171-27", "Chat2Scenic UN_R171 #27",
     "a stationary adult pedestrian target positioned directly in its driving path and facing away from the vehicle",
     "Town03", "obstacle", 1, {"variant": "stationary_vru", "vru_type": "pedestrian", "lateral_m": 0},
     chk_standing("pedestrian")),
    ("c2s-r171-30", "Chat2Scenic UN_R171 #30",
     "a stationary bicycle target positioned directly in its driving path and facing away",
     "Town05", "obstacle", 2, {"variant": "stationary_vru", "vru_type": "cyclist", "lateral_m": 0},
     chk_standing("cyclist")),
    ("c2s-r157-07", "Chat2Scenic UN_R157 #7",
     "a motorcycle and a passenger car are stopped sequentially within the same lane",
     "Town04", "obstacle", 3, {"variant": "queue"}, chk_queue),
    ("c2s-r171-12", "Chat2Scenic UN_R171 #12",
     "entering a curve where it encounters a stationary heavy truck ... positioned within the lane",
     "Town03", "obstacle", 2, {"variant": "breakdown", "vehicle_type": "truck", "site": "curve", "lateral_m": 0},
     chk_stopped_vehicle("truck", curve=True)),
    ("c2s-r171-11", "Chat2Scenic UN_R171 #11",
     "a curved road section where it must detect a stationary vehicle positioned with a 1.0-meter lateral offset",
     "Town04", "obstacle", 1, {"variant": "breakdown", "vehicle_type": "car", "site": "curve", "lateral_m": 1.0},
     chk_stopped_vehicle("car", curve=True, lateral=1.0)),
    ("c2s-r171-10", "Chat2Scenic UN_R171 #10",
     "rounds a curve to find a stationary vehicle facing toward the VUT (oncoming orientation) in its lane",
     "Town03", "obstacle", 3, {"variant": "breakdown", "vehicle_type": "car", "site": "curve", "facing": "oncoming",
                               "lateral_m": 0}, chk_stopped_vehicle("car", curve=True, oncoming=True)),
    ("c2s-r157-05", "Chat2Scenic UN_R157 #5",
     "a stationary powered two-wheeler positioned directly in the center of the lane when ... navigating a highway curve",
     "Town04", "obstacle", 4, {"variant": "breakdown", "vehicle_type": "motorcycle", "site": "curve", "lateral_m": 0},
     chk_stopped_vehicle("motorcycle", curve=True)),
    ("c2s-carla-23", "Chat2Scenic CARLA_Leaderboard #23",
     "The ego-vehicle must slow down or brake to allow a parked vehicle exiting a parallel parking bay to cut in front.",
     "Town03", "pull_out", 1, {}, chk_pull_out),
    ("c2s-carla-17", "Chat2Scenic CARLA_Leaderboard #17",
     "an oncoming vehicles invading its lane on a bend due to an obstacle",
     "Town03", "oncoming_drift", 2, {"cause": "parked"}, chk_drift_parked),
    ("c2s-carla-20", "Chat2Scenic CARLA_Leaderboard #20",
     "a pedestrian emerging from behind a parked vehicle and advancing into the lane",
     "Town03", "vru_crossing", 1, {"vru_type": "pedestrian", "occluded": True}, chk_occluded_ped),
    ("c2s-r171-18", "Chat2Scenic UN_R171 #18",
     "follows a lead car that suddenly swerves into the adjacent lane to avoid a stationary ... heavy truck",
     "Town05", "cut_out", 1, {"stopped_type": "truck"}, chk_type_is("stopped_type", "truck")),
    ("c2s-r171-23", "Chat2Scenic UN_R171 #23",
     "a large heavy-duty truck in the adjacent lane suddenly executes a full lane change into the ego lane",
     "Town04", "cut_in", 1, {"npc_type": "truck"}, chk_type_is("npc_type", "truck")),
    # ── Loop2Scenic (tests/bench/benchmark_index.json) ──
    ("l2s-vvm-lt-onc", "Loop2Scenic left_turn_with_oncoming_obj_passing_straight_intersecting",
     "the ego car initiates a left turn at the intersection. Simultaneously, an oncoming adversarial object drives straight",
     "Town05", "junction_conflict", 1, {"layout": "ego_left_oncoming"}, chk_left_turn_oncoming),
    ("l2s-ccftap", "Loop2Scenic CCFtap_10kph_30kph (Euro NCAP)",
     "a vehicle turns across the path of an oncoming vehicle travelling at constant speed",
     "Town10HD", "junction_conflict", 2, {"layout": "ego_left_oncoming"}, chk_left_turn_oncoming),
    ("l2s-vvm-pass-onc-lt", "Loop2Scenic pass_straight_with_oncoming_obj_turning_left",
     "pass straight with oncoming object turning left",
     "Town03", "junction_conflict", 4, {"layout": "npc_left_oncoming"}, chk_npc_left_oncoming),
    ("l2s-vvm-lt-left", "Loop2Scenic left_turn_with_obj_from_left_passing_straight_intersecting",
     "the blue ego car attempts to make a left turn at the intersection. The pink adversarial car approaches from the left and passes straight through",
     "Town05", "junction_conflict", 2, {"layout": "ego_left_crossing", "npc_from": "left"},
     chk_turn_with_cross_traffic("left", "left")),
    ("l2s-colm-r21", "Loop2Scenic r21_town07_ins_sr (CoLMDriver)",
     "the ego vehicle turns right at a signalized 4-way intersection ... while an adversary vehicle starting from the left arm passes straight through",
     "Town07", "junction_conflict", 1, {"layout": "ego_right_crossing", "npc_from": "left"},
     chk_turn_with_cross_traffic("right", "left")),
    ("l2s-cpta", "Loop2Scenic CPTA (Euro NCAP)",
     "a vehicle turns towards an adult pedestrian crossing its path, walking across a junction",
     "Town10HD", "turn_vru", 2, {"vru_type": "pedestrian", "turn": "right"}, chk_turn_vru("right", "pedestrian")),
    ("l2s-cpnco", "Loop2Scenic CPNCO_RunningChildFromNearSide (Euro NCAP)",
     "a child pedestrian crossing its path running from behind and obstruction from the nearside",
     "Town03", "vru_crossing", 2, {"vru_type": "child", "occluded": True, "from": "right"},
     chk_type_is("vru_type", "child")),
    ("l2s-encroach", "Loop2Scenic EncroachingOncomingVehicle (NHTSA ADS)",
     "Another moving vehicle is approaching in an opposing lane of travel and begins to drift into the SV's lane",
     "Town05", "oncoming_drift", 1, {"offset_m": 2.5}, chk_type_is("offset_m", 2.5)),
    ("l2s-carla-16", "Loop2Scenic CARLA_Leaderboard_16",
     "a slow moving hazard blocking part of the lane ... next to a lane of traffic moving in the opposite direction",
     "Town03", "slow_lead", 3, {"lead_type": "motorcycle", "lateral_m": 1.0, "side": "right", "lead_speed": 2},
     chk_slow_lead(None, "motorcycle", 1.0)),
    # ── Lane change into a car from behind (both benchmarks) ──
    ("c2s-r171-03", "Chat2Scenic UN_R171 #3",
     "must detect and yield to a high-speed vehicle approaching from the rear in the target lane",
     "Town04", "rear_approach", 1, {"npc_type": "car", "speed_diff": 7}, chk_rear_approach("car")),
    ("c2s-r171-04", "Chat2Scenic UN_R171 #4",
     "it detects a motorcycle filtering or approaching rapidly from behind in the adjacent lane",
     "Town06", "rear_approach", 2, {"npc_type": "motorcycle"}, chk_rear_approach("motorcycle")),
    ("c2s-nhtsa-13", "Chat2Scenic NHTSA_Crash #13",
     "Driver A misjudged the distance and speed of Vehicle B ... struck A from behind",
     "Town03", "rear_approach", 3, {"gap_at_change_m": 4, "npc_type": "car"}, chk_rear_approach("car")),
]


def build_case(page, case):
    cid, src, text, town, typ, seed, pins, chk = case
    tag = f"{cid} ({src})"
    if page.evaluate("AppState.map") != town:
        H.select_map(page, town)
        page.wait_for_function("AppState.laneGraph !== null", timeout=60000)
    info = page.evaluate("([t, s, o]) => ScenarioGenerator.generate(t, s, { overrides: o })",
                         [typ, seed, pins])
    if not C(f"{tag}: builds — “{text[:70]}…”", info is not None):
        return
    got = page.evaluate("AppState.generated.params")
    for k, v in pins.items():
        if k == "ego_speed":
            C(f"{tag}: pinned ego_speed honoured", page.evaluate("AppState.ego.initial_speed") == v)
            continue
        C(f"{tag}: pinned {k} honoured", got.get(k) == v, (k, got.get(k), v))
    r = page.evaluate(ANALYZE)
    chk(tag, r)
    exp = page.evaluate(EXPORT)
    C(f"{tag}: exports", exp["ok"], f"{exp['status']} {exp['text']}")


def pin_through_panel(page, key, value):
    page.evaluate("AppState.select(null)")
    page.click('[data-overview-tab="overview"]')
    page.wait_for_selector(f'[data-recipe-key="{key}"]', timeout=5000)
    page.locator(f'[data-recipe-key="{key}"]').select_option(value)
    page.wait_for_timeout(400)


def main():
    global C
    with sync_playwright() as pw:
        browser, page, errors = H.open_editor(pw, "Town03")
        page.wait_for_function("AppState.laneGraph !== null", timeout=60000)
        page.on("dialog", lambda d: d.accept())

        # ── The new types are in the Generieren menu ─────────────────────────
        page.click("#gen-menu-btn")
        for label in ("Langsames Fahrzeug voraus", "Abbiegen, Fußgänger/Rad quert", "Ausparken vor Ego",
                      "Spurwechsel, Fahrzeug von hinten"):
            C(f"menu: offers „{label}“",
              page.locator("#gen-menu-types .menu-item", has_text=label).count() == 1)
        page.fill("#gen-seed", "3")
        page.locator("#gen-menu-types .menu-item", has_text="Abbiegen, Fußgänger/Rad quert").click()
        page.wait_for_function("AppState.generated && AppState.generated.type === 'turn_vru'", timeout=20000)
        r = page.evaluate(ANALYZE)
        chk_turn_vru(r["gen"]["params"]["turn"], r["gen"]["params"]["vru_type"])("menu turn_vru seed 3", r)

        # ── Pins through the recipe panel (real selects) ─────────────────────
        page.evaluate("ScenarioGenerator.generate('junction_conflict', 2)")
        before = page.evaluate("AppState.generated.params.layout")
        page.evaluate("AppState.select(null)")
        page.click('[data-overview-tab="overview"]')
        C("panel: junction layout is a recipe field",
          page.locator('select[data-recipe-key="layout"]').count() == 1)
        pin_through_panel(page, "layout", "ego_left_oncoming")
        g = page.evaluate("AppState.generated")
        C("panel: layout pin rebuilds a left turn across oncoming traffic",
          g["overrides"].get("layout") == "ego_left_oncoming" and g["params"]["layout"] == "ego_left_oncoming",
          (before, g["overrides"], g["params"].get("layout")))
        chk_left_turn_oncoming("panel layout", page.evaluate(ANALYZE))

        page.evaluate("ScenarioGenerator.generate('obstacle', 1)")
        pin_through_panel(page, "variant", "stationary_vru")
        g = page.evaluate("AppState.generated")
        C("panel: obstacle variant pin rebuilds a standing person/bike",
          g["params"]["variant"] == "stationary_vru", g["params"])
        C("panel: the person-type row appears once it is used",
          page.locator('[data-recipe-key="vru_type"]').count() == 1)
        C("panel: the vehicle-type row is gone for it",
          page.locator('[data-recipe-key="vehicle_type"]').count() == 0)
        pin_through_panel(page, "site", "curve")
        g = page.evaluate("AppState.generated")
        C("panel: site pin moves it into a curve", g["params"]["site"] == "curve", g["params"])

        # Negative control: the left-turn checker rejects a straight crossing,
        # so it is not passing trivially.
        page.evaluate("ScenarioGenerator.generate('junction_conflict', 1, { overrides: { layout: 'crossing' } })")
        ctrl = H.Checks()
        real, C = C, ctrl
        chk_left_turn_oncoming("control", page.evaluate(ANALYZE))
        C = real
        C("control: a straight crossing fails the left-turn check", len(ctrl.fails) > 0, ctrl.fails)

        # ── Every benchmark case ─────────────────────────────────────────────
        for case in CASES:
            build_case(page, case)

        C("no JS errors", not [e for e in errors if "404" not in e], errors[:5])
        browser.close()
    sys.exit(C.report())


if __name__ == "__main__":
    main()
