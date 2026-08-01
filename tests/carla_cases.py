"""The twelve CARLA cases: how each scenario is built, and what must happen.

Six exercise the scenario templates — the part of the editor with no prior
CARLA coverage at all. Four exercise event mechanics directly; of those only
distance_to_point is thin ground (one manual run), the rest turn behaviour that
was verified by eye into standing assertions. Two cover the newer actor types.

The .xosc carries no ego manoeuvre — only a spawn pose — so where the ego
actually drives comes from `automatic_control_1.py --goal`, which
/home/dellpro2/Antonio/run.sh reads from `$SCENARIO_GOAL`. A case therefore has
to state BOTH ends: `ego` (the spawn) and `goal` (the destination the Behavior
agent plans a route to). A case that omits `goal` gets run.sh's Town01 default,
which is only correct for a Town01 case.

Most cases run on Town01 with the ego at the one pose the toolchain is built
around: 300.631,-2.025 heading west is the pose the existing test.xosc uses and
the one every recording under recordings/ was made with. Moving it means the ego
drives somewhere else and every distance trigger fires at a different time.
"""

EGO = {"x": 300.631, "y": -2.025, "yaw": 180.0}
# ~208 m west of EGO along road 1, the pose test.xosc has always used.
GOAL = "92,23,0,270"

# ── Town03, for the lane-change cases ────────────────────────────────────────
#
# Town01 cannot host a lane change at all. Road 1 — where the fixed ego pose
# puts everything — is single-carriageway: CARLA reports lane_change=NONE, the
# left neighbour is the ONCOMING lane +1 and the right is a shoulder. Asking for
# a left change there produces a waypoint plan that dies almost immediately, and
# ChangeActorLateralMotion then hangs forever rather than failing (it only
# returns FAILURE for an empty plan), which wedges the whole run.
#
# Town03 road 67 lane -2 is the verified-good alternative: a 144 m straight at
# yaw ~177-180 running (159.2,193.0) -> (17.7,193.5), with lane_change=Left and
# lane -1 as a same-direction Driving neighbour 3.5 m to the actor's left.
#
# Parking lanes were considered for pull-out, since that is what the template
# means. Town03 has 75 of them, but EVERY one sits beside a single driving lane
# (lane_change=NONE, no same-direction neighbour), so a pull-out from a parking
# spot hits exactly the same dead end as Town01. Both lane-change cases
# therefore run on road 67, the only configuration confirmed to work.
EGO_T3 = {"x": 159.0, "y": 193.0, "yaw": 177.0}
SPOT_T3_LANE = (135.0, 193.2)   # ~24 m ahead in lane -2, 123 m of straight left
# Near the far end of that same 144 m straight, kept a few metres inside it so
# the goal lands on road 67 rather than in the junction beyond. Before this
# existed both Town03 cases inherited run.sh's Town01 goal, and set_destination
# snapped (92,23) to whatever Town03 waypoint happened to be nearest — the ego
# drove a route nobody chose.
GOAL_T3 = "25,193.4,0,180"

# ── Town03 parking bay, for the pull-out case ────────────────────────────────
#
# A pull-out is a car leaving a parking bay and joining the adjacent lane, so
# the case has to start in a bay. Finding a usable one is harder than it looks:
#
#   - Of Town03's 62 substantial parking lanes, 33 are PHYSICALLY OCCUPIED by
#     static parked-car meshes. Spawning there fails with "collision at spawn
#     position" — they are scenery, not free bays.
#   - Many of the free ones sit on the elevated deck at z ~ 7.5-8.0 m. The
#     editor hardcodes z=0.2 for actors, so it cannot place anything there;
#     z=0.2 is under the deck.
#   - Testing spawnability at a fixed low z is meaningless for those: z=0.3 is
#     empty air seven metres below the deck, so everything "passes". Each bay
#     has to be probed at its own surface height.
#
# Road 47 is free, at ground level, and has a long approach. Verified against
# CARLA by spawning a vehicle at both poses:
#
#   road 47  bay          (185.68,  67.60)  parking lane, surface z = 0.00
#            lane centre  (185.67,  62.35)  driving lane, yaw ~0 (eastward)
#            offset       5.25 m            the bay is to the car's LEFT
#            ego start    (115.67,  62.53)  70 m upstream, 70 m of straight
#
# The 70 m gap is deliberate: the template triggers on distance_to_ego@20, so
# the ego has to genuinely close in rather than the trigger already being true
# at t=0.
#
# The bay being on the car's left means the template's direction:'left' is the
# semantically CORRECT direction. When this case fails it is because the action
# cannot complete, not because the direction is wrong — do not "fix" it by
# flipping the direction or by moving the car back onto a multi-lane road.
EGO_T3_PARK = {"x": 115.67, "y": 62.53, "yaw": 0.0}
SPOT_T3_PARK = (185.68, 67.60)
PARK_LANE_CENTRE_Y = 62.35      # where a successful pull-out has to end up
# The far end of that 70 m straight — the driving-lane point beside the bay,
# already verified spawnable above. The ego has to close to within 20 m of the
# parked car for the template's trigger to fire, so the goal must be at least
# that far past the ego, i.e. beyond x=165.
GOAL_T3_PARK = "185.67,62.35,0,0"

# NPC spots on the ego's westward carriageway. Proximity-trigger cases sit
# slightly beyond their own trigger radius so the trigger genuinely fires on
# approach rather than being already true at act start — otherwise the case
# proves nothing the 400 m templates don't already prove. Pedestrians and
# cyclists are offset off the carriageway so the ego drives past rather than
# through them; a collision ends the run and makes the speed trace meaningless.
SPOT_LANE = (265.0, -2.0)      # ~35.6 m ahead, same lane
SPOT_NEAR = (275.0, -2.0)      # ~25.6 m ahead, for the 20 m pull-out trigger
SPOT_WALK = (245.0, -6.0)      # ~55.8 m ahead, kerbside, for the 50 m trigger
SPOT_BIKE = (265.0, -6.0)      # ~36.0 m ahead, kerbside, for the 30 m trigger

# ── Road 1's cross-section at those spots, for the crossing checks ───────────
#
# Read off the parsed OpenDRIVE at x=245 and x=265. The road runs due east-west
# (laneYaw 180), so distance ALONG it is x and distance ACROSS it is y:
#
#   lane -3  sidewalk   -8.34 .. -4.33   <- SPOT_WALK / SPOT_BIKE sit here
#   lane -2  shoulder   -4.34 .. -4.03
#   lane -1  driving    -4.04 .. -0.03   <- the ego's westbound lane
#   lane  1  driving    -0.04 ..  3.97      oncoming
#   lane  2  shoulder    3.96 ..  4.27
#   lane  3  sidewalk    4.26 ..  8.27
#
# _roadFacingYaw at both spots is +90 deg, so a correctly placed crossing actor
# travels in +y. Clearing the FAR edge of the ego's lane is the bar: it means
# the actor got the whole way across the ego's path rather than stepping off
# the kerb onto the shoulder.
EGO_LANE_FAR_EDGE = -0.03

# For distance_to_point, the point has to sit BETWEEN the ego start and the NPC.
# The NPC waits, stationary, for this trigger — so putting the point beyond it
# deadlocks: the ego's Behavior agent stops ~7 m behind the parked NPC, never
# reaches the point, the trigger never fires, the NPC never moves. Measured:
# ego ran 300.6 -> 272.4 and then sat at 0 m/s for 427 s.
# It also must start further than the trigger radius away, or it is already
# satisfied at t=0 and proves nothing. Ego x=300.6, radius 20 -> 252 < px < 280.
TRIGGER_POINT = (275.0, -2.0)


# ── Case definitions ─────────────────────────────────────────────────────────
#
# kind='template' -> placed through the real template button + map click.
# kind='events'   -> events seeded directly; the event editor is covered by
#                    test_events_e2e.py, and here we want exact numbers.

CASES = [
    # ---- templates (new coverage) -------------------------------------------
    {
        "name": "tpl-braking",
        "kind": "template",
        "template": "vehicle-braking",
        "spot": SPOT_LANE,
        "npc_yaw": 180.0,        # spawn-point yaw can face back up the road
        "note": "distance_to_ego@400 fires at act start, then after_event",
    },
    {
        "name": "tpl-stopping",
        "kind": "template",
        "template": "vehicle-stopping",
        "spot": SPOT_LANE,
        "npc_yaw": 180.0,
        "note": "3-link chain to a full stop; the step/hold profile probe",
    },
    {
        "name": "tpl-lane-change-left",
        "kind": "template",
        "template": "vehicle-lane-change-left",
        "map": "Town03",
        "ego": EGO_T3,
        "goal": GOAL_T3,
        "spot": SPOT_T3_LANE,
        "npc_yaw": 180.0,
        "note": "lane_change on Town03 road 67 lane -2, which has a legal left",
    },
    {
        "name": "tpl-pull-out",
        "kind": "template",
        "template": "vehicle-pull-out",
        "map": "Town03",
        "ego": EGO_T3_PARK,
        "goal": GOAL_T3_PARK,
        "spot": SPOT_T3_PARK,
        "npc_yaw": 0.0,          # parked aligned with the eastbound carriageway
        "note": "EXPECTED TO FAIL — pull-out from a real parking bay. The "
                "template is built on LaneChangeAction, which needs a "
                "same-direction neighbour driving lane that a bay does not "
                "have, so the action never completes and the run hangs. "
                "Rebuild the template on LaneOffsetAction (absolute target 0, "
                "continuous=false) to fix; this case is the marker for that.",
    },
    {
        "name": "tpl-pedestrian-crossing",
        "kind": "template",
        "template": "pedestrian-crossing",
        "spot": SPOT_WALK,
        # NO npc_yaw, deliberately. _roadFacingYaw gives +90 deg here, square
        # across the carriageway, and that yaw is the whole scenario:
        # PedestrianControl with no waypoints walks the spawn heading forever.
        "note": "walker controller + distance_to_ego@50; the editor's "
                "road-facing yaw is what makes it a crossing",
    },
    {
        "name": "tpl-cyclist-crossing",
        "kind": "template",
        "template": "cyclist-crossing",
        "spot": SPOT_BIKE,
        # Also no npc_yaw — but unlike the walker, yaw cannot save this one.
        "note": "EXPECTED TO FAIL the crossing checks — cyclist aliases to "
                "`bike`, a VEHICLE, so it gets simple_vehicle_control. With "
                "no waypoints that controller ignores the spawn heading "
                "entirely and generates its own plan from "
                "map.get_waypoint(...).next(2.0), i.e. it snaps to the "
                "nearest lane and rides ALONG it whichever way the bike "
                "faces. A set_speed-only template can never cross. Fix by "
                "rebuilding cyclist-crossing on follow_trajectory with "
                "waypoints across the carriageway (both controllers honour "
                "explicit waypoints); this case is the marker for that.",
    },

    # ---- event mechanics ----------------------------------------------------
    {
        "name": "evt-distance-to-point",
        "kind": "events",
        "npc_type": "car",
        "spot": SPOT_LANE,
        "note": "entity_ref unset must mean the EGO reaching the point",
        "events": [{
            "id": "e1",
            "trigger": {"type": "distance_to_point", "value": 20.0,
                        "point": {"name": "P", "x": TRIGGER_POINT[0],
                                  "y": TRIGGER_POINT[1], "z": 0.2}},
            "action": {"type": "set_speed",
                       "dynamics": {"shape": "step", "dimension": "time", "value": 10.0},
                       "target": {"mode": "absolute", "value": 8.0}},
        }],
    },
    {
        "name": "evt-simulation-time",
        "kind": "events",
        "npc_type": "car",
        "spot": SPOT_LANE,
        "note": "is simulation_time t=0 sim start or act start?",
        "events": [{
            "id": "e1",
            "trigger": {"type": "simulation_time", "value": 8.0},
            "action": {"type": "set_speed",
                       "dynamics": {"shape": "step", "dimension": "time", "value": 8.0},
                       "target": {"mode": "absolute", "value": 9.0}},
        }],
    },
    {
        "name": "evt-after-event-chain",
        "kind": "events",
        "npc_type": "car",
        "spot": SPOT_LANE,
        "note": "step vs linear dynamics in one chain",
        "events": [
            {"id": "e1", "trigger": {"type": "distance_to_ego", "value": 400.0},
             "action": {"type": "set_speed",
                        "dynamics": {"shape": "step", "dimension": "time", "value": 4.0},
                        "target": {"mode": "absolute", "value": 12.0}}},
            {"id": "e2", "trigger": {"type": "after_event", "event_id": "e1"},
             "action": {"type": "set_speed",
                        "dynamics": {"shape": "linear", "dimension": "time", "value": 4.0},
                        "target": {"mode": "absolute", "value": 4.0}}},
            {"id": "e3", "trigger": {"type": "after_event", "event_id": "e2"},
             "action": {"type": "set_speed",
                        "dynamics": {"shape": "step", "dimension": "time", "value": 6.0},
                        "target": {"mode": "absolute", "value": 10.0}}},
        ],
    },
    {
        "name": "evt-assign-route",
        "kind": "events",
        "npc_type": "car",
        "spot": SPOT_LANE,
        "note": "forced simulation_time@0, and the after_event rewrite",
        "events": [
            {"id": "r1", "trigger": {"type": "simulation_time", "value": 25.0},
             "action": {"type": "assign_route", "route_strategy": "fastest",
                        "waypoints": [{"x": 265.0, "y": -2.0, "z": 0.2},
                                      {"x": 180.0, "y": -2.0, "z": 0.2}]}},
            {"id": "s1", "trigger": {"type": "after_event", "event_id": "r1"},
             "action": {"type": "set_speed",
                        "dynamics": {"shape": "step", "dimension": "time", "value": 12.0},
                        "target": {"mode": "absolute", "value": 9.0}}},
        ],
    },

    # ---- actor types --------------------------------------------------------
    # The .xosc-level suite (test_actor_types_e2e.py) proves the right entity
    # is emitted. These two prove CARLA accepts it: the blueprint id resolves
    # to a real mesh, and the controller ScenarioRunner picks for it actually
    # drives the thing. A wrong blueprint or controller produces a file that
    # validates perfectly and then does nothing in the simulator.
    #
    # One vehicle and one walker, chosen as the extremes of the new set: the
    # largest vehicle and the smallest walker.
    {
        "name": "act-firetruck-stopped",
        "kind": "events",
        "npc_type": "firetruck",
        "spot": SPOT_LANE,
        "note": "largest new vehicle: blueprint resolves and the vehicle "
                "controller brings it to a stop",
        "events": [
            {"id": "e1", "trigger": {"type": "distance_to_ego", "value": 400.0},
             "action": {"type": "set_speed",
                        "dynamics": {"shape": "step", "dimension": "time", "value": 5.0},
                        "target": {"mode": "absolute", "value": 8.0}}},
            {"id": "e2", "trigger": {"type": "after_event", "event_id": "e1"},
             "action": {"type": "set_speed",
                        "dynamics": {"shape": "linear", "dimension": "time", "value": 4.0},
                        "target": {"mode": "absolute", "value": 0.0}}},
        ],
    },
    {
        "name": "act-child-crossing",
        "kind": "events",
        "npc_type": "child",
        "spot": SPOT_WALK,
        # Seeded directly, so it has to state the yaw the editor would have
        # given it: _roadFacingYaw at SPOT_WALK is +90, square across the
        # carriageway. The events-branch default of 180 is the ego's direction
        # and would walk the child down the road instead.
        "npc_yaw": 90.0,
        "note": "child walker: <Pedestrian> entity + pedestrian_control, same "
                "event shape as tpl-pedestrian-crossing. Kerbside so the ego "
                "drives past rather than through it — a collision ends the run "
                "and makes the speed trace meaningless.",
        "events": [
            {"id": "e1", "trigger": {"type": "distance_to_ego", "value": 50.0},
             "action": {"type": "set_speed",
                        "dynamics": {"shape": "step", "dimension": "time", "value": 10.0},
                        "target": {"mode": "absolute", "value": 1.5}}},
            {"id": "e2", "trigger": {"type": "after_event", "event_id": "e1"},
             "action": {"type": "set_speed",
                        "dynamics": {"shape": "step", "dimension": "time", "value": 5.0},
                        "target": {"mode": "absolute", "value": 0.0}}},
        ],
    },
]

CASES_BY_NAME = {c["name"]: c for c in CASES}


# ── Expectations ─────────────────────────────────────────────────────────────
#
# Each returns [(label, ok, detail)]. `run` is a carla_analysis.Run, `timeline`
# is {event_name: {'start','end'}} from ScenarioRunner's OSC log.
#
# Timing tolerances are deliberately loose (±2 s). The chain advances on
# completeState, the controller needs a moment to act, and the two clocks are
# reconciled through the ego's first motion; none of that is precise to the
# tick. What is being checked is that the profile has the right SHAPE and
# roughly the right boundaries, not that CARLA is a stopwatch.

import carla_analysis as A  # noqa: E402


def _fired(timeline, substring):
    """(ok, detail, t_start) for the first event whose name contains substring."""
    for name, times in sorted(timeline.items()):
        if substring in name:
            return True, f"{name} ran at t={times['start']}s", times["start"]
    return False, f"no event matching '{substring}' ever ran (saw {sorted(timeline)})", None


def _name_of(timeline, substring):
    """Full event name containing `substring`, or None."""
    for name in sorted(timeline):
        if substring in name:
            return name
    return None


def _crossed_the_road(run, role="adversary", far_edge=EGO_LANE_FAR_EDGE):
    """Did the actor move ACROSS the carriageway, or just along it?

    This is the check the crossing cases were missing. Asserting only
    reaches_speed passes just as happily when the walker sets off down the lane
    parallel to the ego, which is exactly what a wrong spawn heading produces —
    the event fires, the controller obeys, the speed trace is perfect, and
    nothing crosses anything.

    Two independent bars, because either alone is satisfiable by the wrong
    behaviour: an actor walking down the lane covers plenty of ground without
    ever changing y, and one clipped by a passing car changes y without having
    crossed anything.

    Note `lateral_offset` is NOT usable here. It projects into the actor's own
    frame, and a crossing actor faces across the road, so its crossing shows up
    as LONGITUDINAL travel and reads as ~0 lateral. Road 1 runs due east-west,
    so world x/y are already the along/across axes.
    """
    track = run.get(role)
    if track is None or len(track) < 2:
        return [("actor crosses the carriageway", False,
                 f"no telemetry for '{role}'")]
    dx = track.x[-1] - track.x[0]
    dy = track.y[-1] - track.y[0]
    furthest = max(track.y)
    return [
        ("motion is ACROSS the road, not along it", abs(dy) > abs(dx),
         f"net dx={dx:+.1f} m (along the lane), dy={dy:+.1f} m (across it)"),
        (f"gets the whole way over the ego's lane (y > {far_edge})",
         furthest > far_edge,
         f"start y={track.y[0]:.2f}, furthest y={furthest:.2f}, "
         f"ego lane spans -4.04..-0.03"),
    ]


def _chain_order(timeline, names):
    """Did the named events run in the given order?"""
    starts = []
    for want in names:
        match = [t["start"] for n, t in timeline.items() if want in n and t["start"] is not None]
        if not match:
            return False, f"'{want}' never ran (saw {sorted(timeline)})"
        starts.append((want, min(match)))
    ordered = all(starts[i][1] <= starts[i + 1][1] + 0.5 for i in range(len(starts) - 1))
    return ordered, " -> ".join(f"{n}@{t:.2f}s" for n, t in starts)


def expect_braking(run, timeline):
    out = []
    ok, detail, _ = _fired(timeline, "SpeedEvent0")
    out.append(("first speed event fires", ok, detail))
    ok, detail = _chain_order(timeline, ["SpeedEvent0", "SpeedEvent1"])
    out.append(("chain runs in order", ok, detail))
    ok, detail = A.reaches_speed(run, "adversary", 10.0, 0.5, 6.0)
    out.append(("npc reaches 10 m/s", ok, detail))
    ok, detail = A.holds_speed(run, "adversary", 5.0, 8.0, 14.0, tol=1.5)
    out.append(("npc brakes to and holds 5 m/s", ok, detail))
    return out


def expect_stopping(run, timeline):
    out = []
    ok, detail = _chain_order(timeline, ["SpeedEvent0", "SpeedEvent1", "SpeedEvent2"])
    out.append(("3-link chain runs in order", ok, detail))
    # 10 m/s for 5 s -> 5 m/s for 2 s -> 0 m/s for 10 s, from act start.
    ok, details = A.speed_profile(run, "adversary",
                                  [(1.0, 4.5, 10.0), (5.5, 6.8, 5.0), (9.0, 15.0, 0.0)])
    out.append(("step-and-hold profile 10 -> 5 -> 0", ok, "; ".join(details)))
    ok, detail = A.holds_speed(run, "adversary", 0.0, 9.0, 15.0, tol=0.6)
    out.append(("npc actually comes to a stop", ok, detail))
    return out


def expect_lane_change_left(run, timeline):
    out = []
    ok, detail = _chain_order(timeline, ["SpeedEvent0", "LaneChangeEvent1", "SpeedEvent2"])
    out.append(("speed -> lane change -> speed", ok, detail))
    ok, detail = A.reaches_speed(run, "adversary", 10.0, 0.5, 6.0)
    out.append(("npc reaches 10 m/s first", ok, detail))
    # Bracket the whole manoeuvre: the chain holds 10 m/s for 5 s, changes lane,
    # then resumes. Starting the window inside the turn measures only part of
    # the displacement and reads low.
    lateral, detail = A.lateral_offset(run, "adversary", 3.0, 10.0)
    if lateral is None:
        out.append(("lane change displaces the npc sideways", False, detail))
    else:
        out.append(("lane change moves ~one lane width sideways",
                    2.0 <= abs(lateral) <= 6.0, detail))
        # 'left' is emitted as RelativeTargetLane value="1". Whether that is
        # actually the actor's left depends on the sign of the OpenDRIVE lane
        # id it is sitting in, which flips with road direction.
        out.append(("'left' displaces the npc to ITS OWN left (positive)",
                    lateral > 0, detail))
    return out


def expect_pull_out(run, timeline):
    """A pull-out: leave the bay, join the driving lane, drive off.

    EXPECTED TO FAIL until the template stops using LaneChangeAction — see the
    case note. The trigger checks should still pass; what fails is the car
    actually getting out of the bay, and the run terminating.
    """
    out = []
    ok, detail, t = _fired(timeline, "SpeedEvent0")
    out.append(("speed event fires", ok, detail))
    ok2, detail2, t2 = _fired(timeline, "LaneChangeEvent1")
    out.append(("lateral event fires", ok2, detail2))
    if t is not None and t2 is not None:
        out.append(("both events share one trigger, so they fire together",
                    abs(t - t2) <= 1.0, f"speed@{t:.2f}s lateral@{t2:.2f}s"))
    # The car starts 60 m ahead of the ego and the trigger is 20 m, so it must
    # NOT fire immediately — that is what makes this a proximity case rather
    # than another fires-at-act-start one.
    if t is not None:
        out.append(("20 m trigger waits for the ego to close in", t > 1.0,
                    f"fired at t={t:.2f}s"))

    # The lateral event must COMPLETE. LaneChangeAction from a bay cannot:
    # ChangeActorLateralMotion only succeeds once the actor has driven 10 m in
    # a target lane, and a parking bay has no same-direction neighbour to
    # target. No END means the chain is stuck and the run will not finish.
    ended = timeline.get(_name_of(timeline, "LaneChangeEvent1"), {}).get("end")
    out.append(("the lateral action completes", ended is not None,
                "event went RUNNING but never reached END — the manoeuvre "
                "cannot finish, so the storyboard never ends"))

    # The car has to actually get out of the bay: 5.25 m to its left, landing
    # on the driving lane centre. Positive lateral = the actor's own left.
    lateral, detail = A.lateral_offset(run, "adversary", 0.0, 14.0)
    if lateral is None:
        out.append(("the car leaves the parking bay", False, detail))
    else:
        out.append(("the car moves ~5.25 m out of the bay, to its left",
                    3.5 <= lateral <= 7.0, detail))

    npc = run.get("adversary")
    if npc is not None:
        # Absolute check on the same thing, independent of the projection:
        # the bay is at y=-11.3, the driving lane centre at y=-6.02.
        final_y = npc.y[-1]
        out.append((f"the car ends up on the driving lane centre "
                    f"(y ~ {PARK_LANE_CENTRE_Y})",
                    abs(final_y - PARK_LANE_CENTRE_Y) <= 1.5,
                    f"final y={final_y:.2f}, bay y={SPOT_T3_PARK[1]:.2f}, "
                    f"lane centre y={PARK_LANE_CENTRE_Y:.2f}"))

    ok, detail = A.reaches_speed(run, "adversary", 5.0, 0.0, 14.0, tol=2.0)
    out.append(("npc pulls away at ~5 m/s", ok, detail))
    return out


def expect_pedestrian_crossing(run, timeline):
    out = []
    ok, detail, t = _fired(timeline, "SpeedEvent0")
    out.append(("walker speed event fires", ok, detail))
    ok, detail = _chain_order(timeline, ["SpeedEvent0", "SpeedEvent1"])
    out.append(("chain runs in order", ok, detail))
    walker = run.get("adversary")
    out.append(("walker appears in telemetry", walker is not None,
                f"roles seen: {sorted(run.tracks)}"))
    if walker is not None:
        out.append(("walker is a walker blueprint",
                    walker.type_id.startswith("walker."), walker.type_id))
        ok, detail = A.reaches_speed(run, "adversary", 2.0, 0.0, 14.0, tol=1.0)
        out.append(("walker actually walks at ~2 m/s", ok, detail))
        out.extend(_crossed_the_road(run))
    return out


def expect_cyclist_crossing(run, timeline):
    out = []
    ok, detail, t = _fired(timeline, "SpeedEvent0")
    out.append(("cyclist speed event fires", ok, detail))
    if t is not None:
        out.append(("30 m trigger waits for the ego to close in", t > 0.3,
                    f"fired at t={t:.2f}s"))
    bike = run.get("adversary")
    out.append(("cyclist appears in telemetry", bike is not None,
                f"roles seen: {sorted(run.tracks)}"))
    if bike is not None:
        out.append(("cyclist resolved to the bike blueprint",
                    "diamondback" in bike.type_id or "bike" in bike.type_id,
                    bike.type_id))
        ok, detail = A.reaches_speed(run, "adversary", 4.0, 0.0, 12.0, tol=1.5)
        out.append(("cyclist rides at ~4 m/s", ok, detail))
        # EXPECTED TO FAIL — see the case note. simple_vehicle_control
        # generates its own lane-following plan and never reads the spawn
        # heading, so the bike rides along the road no matter how it is
        # placed. These two lines are the marker for that defect; they turn
        # green only once cyclist-crossing is rebuilt on follow_trajectory.
        out.extend(_crossed_the_road(run))
    return out


def expect_firetruck_stopped(run, timeline):
    """A new vehicle type spawns as the right mesh and its controller drives it.

    The blueprint assertion is the point: xml_builder falls back to `car` for
    every lookup it cannot resolve, so a missing catalogue entry emits a
    Lincoln MKZ that behaves identically. Only type_id tells them apart.
    """
    out = []
    ok, detail = _chain_order(timeline, ["SpeedEvent0", "SpeedEvent1"])
    out.append(("speed chain runs in order", ok, detail))
    truck = run.get("adversary")
    out.append(("firetruck appears in telemetry", truck is not None,
                f"roles seen: {sorted(run.tracks)}"))
    if truck is not None:
        out.append(("resolved to the firetruck blueprint, not the car default",
                    "firetruck" in truck.type_id, truck.type_id))
        ok, detail = A.reaches_speed(run, "adversary", 8.0, 0.5, 6.0, tol=1.0)
        out.append(("firetruck reaches 8 m/s", ok, detail))
        ok, detail = A.holds_speed(run, "adversary", 0.0, 6.0, 9.0, tol=0.6)
        out.append(("firetruck comes to a stop", ok, detail))
    return out


def expect_child_crossing(run, timeline):
    """The child reaches CARLA as a walker and pedestrian_control moves it.

    Mirrors expect_pedestrian_crossing. The extra assertion is the blueprint:
    _build_npc_pedestrian_entity used to hardcode the adult model, so a child
    that walks correctly but spawns as walker.pedestrian.0001 would otherwise
    look like a pass.
    """
    out = []
    ok, detail, t = _fired(timeline, "SpeedEvent0")
    out.append(("child speed event fires", ok, detail))
    if t is not None:
        out.append(("50 m trigger waits for the ego to close in", t > 0.3,
                    f"fired at t={t:.2f}s"))
    kid = run.get("adversary")
    out.append(("child appears in telemetry", kid is not None,
                f"roles seen: {sorted(run.tracks)}"))
    if kid is not None:
        out.append(("child is a walker blueprint",
                    kid.type_id.startswith("walker."), kid.type_id))
        out.append(("child is the child model, not the adult default",
                    kid.type_id != "walker.pedestrian.0001", kid.type_id))
        ok, detail = A.reaches_speed(run, "adversary", 1.5, 0.0, 14.0, tol=1.0)
        out.append(("child actually walks at ~1.5 m/s", ok, detail))
        out.extend(_crossed_the_road(run))
    return out


def expect_distance_to_point(run, timeline):
    out = []
    ok, detail, t_fired = _fired(timeline, "SpeedEvent0")
    out.append(("point-distance event fires", ok, detail))
    # The whole point: it must fire when the EGO reaches the point, not when
    # the NPC does. Derived from the ego's own recorded path, so no hardcoded
    # timestamp can drift.
    t_ego = A.time_ego_within(run, TRIGGER_POINT, 20.0)
    npc = run.get("adversary")
    t_npc = None
    if npc is not None:
        import math
        base = run.act_start() or 0.0
        for i, t in enumerate(npc.t):
            if math.hypot(npc.x[i] - TRIGGER_POINT[0], npc.y[i] - TRIGGER_POINT[1]) <= 20.0:
                t_npc = t - base
                break
    out.append(("the ego does reach the trigger point", t_ego is not None,
                f"ego within 20 m of {TRIGGER_POINT} at t={t_ego}s"
                if t_ego is not None else "ego never got within 20 m"))
    if t_fired is not None and t_ego is not None:
        out.append(("EVENT FIRES WHEN THE EGO REACHES THE POINT",
                    abs(t_fired - t_ego) <= 2.0,
                    f"event@{t_fired:.2f}s vs ego-in-range@{t_ego:.2f}s"
                    + (f" (npc-in-range@{t_npc:.2f}s)" if t_npc is not None else "")))
    ok, detail = A.reaches_speed(run, "adversary", 8.0, 0.0, 18.0, tol=1.5)
    out.append(("npc reaches the commanded 8 m/s", ok, detail))
    return out


def expect_simulation_time(run, timeline):
    out = []
    ok, detail, t = _fired(timeline, "SpeedEvent0")
    out.append(("simulation_time event fires", ok, detail))
    if t is not None:
        # Records which clock t=0 means. The Act itself only starts once the
        # ego moves, so an 8 s SimulationTimeCondition could plausibly mean
        # 8 s after sim start or 8 s after the act began.
        out.append(("fires at ~8 s on ScenarioRunner's clock",
                    6.0 <= t <= 10.0, f"fired at t={t:.2f}s (asked for 8 s)"))
    ok, detail = A.reaches_speed(run, "adversary", 9.0, 0.0, 18.0, tol=1.5)
    out.append(("npc reaches the commanded 9 m/s", ok, detail))
    ok, detail = A.holds_speed(run, "adversary", 0.0, 0.0, 5.0, tol=0.5)
    out.append(("npc stays put before the trigger", ok, detail))
    return out


def expect_after_event_chain(run, timeline):
    out = []
    ok, detail = _chain_order(timeline, ["SpeedEvent0", "SpeedEvent1", "SpeedEvent2"])
    out.append(("3-link chain runs in order", ok, detail))
    starts = {n: t["start"] for n, t in timeline.items() if t["start"] is not None}
    e0 = next((v for k, v in starts.items() if "SpeedEvent0" in k), None)
    e1 = next((v for k, v in starts.items() if "SpeedEvent1" in k), None)
    e2 = next((v for k, v in starts.items() if "SpeedEvent2" in k), None)
    if None not in (e0, e1):
        out.append(("link 2 waits out link 1's 4 s duration",
                    3.0 <= (e1 - e0) <= 6.0, f"gap {e1-e0:.2f}s (expected ~4 s)"))
    if None not in (e1, e2):
        out.append(("link 3 waits out link 2's 4 s duration",
                    3.0 <= (e2 - e1) <= 6.0, f"gap {e2-e1:.2f}s (expected ~4 s)"))
    ok, detail = A.reaches_speed(run, "adversary", 12.0, 0.5, 5.0)
    out.append(("step to 12 m/s", ok, detail))
    ok, detail = A.reaches_speed(run, "adversary", 4.0, 5.0, 11.0, tol=2.0)
    out.append(("linear ramp down to 4 m/s", ok, detail))
    return out


def expect_assign_route(run, timeline):
    out = []
    ok, detail, t = _fired(timeline, "AssignRouteEvent0")
    out.append(("assign_route event fires", ok, detail))
    if t is not None:
        out.append(("assign_route fires at t~0 despite asking for 25 s",
                    t <= 2.0, f"fired at t={t:.2f}s"))
    ok2, detail2, t2 = _fired(timeline, "SpeedEvent1")
    out.append(("the chained speed event still fires", ok2, detail2))
    npc = run.get("adversary")
    if npc is not None:
        out.append(("npc follows the route westward",
                    npc.distance_travelled() > 20.0,
                    f"travelled {npc.distance_travelled():.1f} m"))
    ok, detail = A.reaches_speed(run, "adversary", 9.0, 0.0, 18.0, tol=2.0)
    out.append(("npc reaches the commanded 9 m/s", ok, detail))
    return out


EXPECTATIONS = {
    "tpl-braking": expect_braking,
    "tpl-stopping": expect_stopping,
    "tpl-lane-change-left": expect_lane_change_left,
    "tpl-pull-out": expect_pull_out,
    "tpl-pedestrian-crossing": expect_pedestrian_crossing,
    "tpl-cyclist-crossing": expect_cyclist_crossing,
    "evt-distance-to-point": expect_distance_to_point,
    "evt-simulation-time": expect_simulation_time,
    "evt-after-event-chain": expect_after_event_chain,
    "evt-assign-route": expect_assign_route,
    "act-firetruck-stopped": expect_firetruck_stopped,
    "act-child-crossing": expect_child_crossing,
}
