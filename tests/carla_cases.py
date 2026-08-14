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
#
# Road 67 is NOT flat, and that is a trap this case fell into. It climbs to
# 2.7 m by s=166 and comes back to 0 by s=301, so the ego pose below sits on a
# 2.63 m rise while the goal 134 m west is at ground level. A Town01-style
# z=0.2 puts the ego 2.4 m under the deck — the clipping this case used to show.
# z is therefore stated explicitly here: road surface + the editor's 0.5 m
# vehicle clearance (see SPAWN_CLEARANCE in frontend/js/objects.js). Cases that
# omit z get it derived from the map, which is right for a flat town.
EGO_T3 = {"x": 159.0, "y": 193.0, "z": 3.13, "yaw": 177.0}
SPOT_T3_LANE = (135.0, 193.2)   # ~24 m ahead in lane -2, 123 m of straight left
                                # (surface 2.08 m — the NPC's z is derived)
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
#     editor now derives z from the OpenDRIVE elevation profile, so it can place
#     there — but testing spawnability at a fixed low z remains meaningless for
#     those bays: z=0.3 is empty air seven metres below the deck, so everything
#     "passes". Each bay has to be probed at its own surface height.
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
# Unlike road 67 this end of Town03 really is at ground level, so the 0.5 here
# is the bare vehicle clearance — stated anyway so the two Town03 ego poses can
# be compared at a glance, and so "flat" is an assertion rather than a silence.
EGO_T3_PARK = {"x": 115.67, "y": 62.53, "z": 0.5, "yaw": 0.0}
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

# The reversing case's spot: lane +1, the oncoming carriageway, 100 m ahead of
# the ego spawn and facing EAST — so 'backing up' means travelling west, against
# its own heading, and the ego (in lane -1, 4 m away) is never in its path.
#
# The obvious placement — a car on the kerb at y=-7, backing out of a driveway —
# does not work: Town01's sidewalk is not spawnable and ScenarioRunner aborts the
# whole scenario with "Not all actors were spawned / Error: Unable to add
# actors" before a single tick. There are no driveways on road 1 to use instead.
REVERSE_SPOT = (200.0, 1.96)
# The kerb beside SPOT_WALK, where a parked vehicle occludes a crossing VRU.
# Sidewalk lane -3, because road 1's shoulder is only 0.3 m wide and there is
# nowhere else off the carriageway to park.
KERB_PARKED = (252.0, -5.5)
# The opposing carriageway (lane +1), for the stopped-heavy-vehicle case.
ONCOMING_LANE = (250.0, 1.97)

# For distance_to_point, the point has to sit BETWEEN the ego start and the NPC.
# The NPC waits, stationary, for this trigger — so putting the point beyond it
# deadlocks: the ego's Behavior agent stops ~7 m behind the parked NPC, never
# reaches the point, the trigger never fires, the NPC never moves. Measured:
# ego ran 300.6 -> 272.4 and then sat at 0 m/s for 427 s.
# It also must start further than the trigger radius away, or it is already
# satisfied at t=0 and proves nothing. Ego x=300.6, radius 20 -> 252 < px < 280.
TRIGGER_POINT = (275.0, -2.0)


# ═════════════════════════════════════════════════════════════════════════════
# Loop2Scenic benchmark corridors
# ═════════════════════════════════════════════════════════════════════════════
#
# The bench-* cases below each reproduce one entry of the Loop2Scenic benchmark
# (https://yuangao-tum.github.io/loop2scenic-bench/, 250 scenarios over five
# query modalities). tests/bench/benchmark_index.json is the extracted index and
# every case quotes its source description verbatim; tests/bench/COVERAGE.md
# holds the selection table and the per-tag rollup.
#
# They need road shapes Town01 does not have — several same-direction lanes, a
# multi-lane signalised junction — so they run on Town05, whose geometry is
# characterised here once. Every constant below was read off CARLA's waypoint
# API before use; do not adjust one without re-probing, because a lane that is
# 3.5 m out is still ON the road and produces a scenario that runs and means
# something else.

# ── Corridor A: Town05 westbound motorway (roads 36 -> 37) ───────────────────
#
# Three same-direction Driving lanes, no oncoming carriageway, ~120 m of dead
# straight from x=+19 before the road curves away south-west:
#
#   lane -1  y = -200.52   the actor's LEFT  (heading 180 => left is +y)
#   lane -2  y = -204.02   the middle lane, where the ego sits
#   lane -3  y = -207.52   the actor's RIGHT
#   (lane +1 at y=-197.02 and lanes -4..-6 are Shoulder/Sidewalk, not Driving)
#
# CARLA reports lane_change=Both on lane -2, Right on -1, Left on -3, so every
# cut-in and lane-change direction used here has a legal target. That is the
# thing Town01 road 1 and Town03's parking lanes could not provide, and the
# reason the highway-flavoured tags (LaneChange, StaticCutIn, HighwayCutIn,
# HardBrake) all live on this corridor.
#
# It is NOT flat: z climbs from 0.00 at x=+15 to 10.02 by x=-105 as the road
# ramps onto an elevated section. No case states a z — every actor here gets it
# from ObjectsManager.surfaceZFor, which is exactly the path that has to work.
# A literal z here would bury actors metres under the deck, the same failure
# Town03 road 67 produced before elevation was derived.
EGO_T5_HWY = {"x": 15.0, "y": -204.02, "yaw": 180.0}
# 155 m west. Past the (-104.97, -204.09) point the lane walk was verified to,
# so set_destination snaps it onward along the same westbound carriageway rather
# than landing on a checked waypoint — the extra runway is the point: it keeps
# the ego closing on a lead long enough for a distance_to_ego trigger to fire.
# Far enough that the ego is still driving when the storyboard ends, so no case
# measures a parked ego.
GOAL_T5_HWY = "-140,-204,0,180"
HWY_LEAD = (-15.0, -204.0)      # 30 m ahead, ego's own lane
HWY_STOPPED = (-70.0, -204.0)   # 85 m ahead, ego's own lane — far enough that a
                                # lead cutting out of the lane clears it first
HWY_LEFT = (-15.0, -200.5)      # 30 m ahead, lane -1 (ego's left)
HWY_LEFT_NEAR = (5.0, -200.5)   # 10 m ahead, lane -1 — abreast, not a lead. The
                                # ego takes ~2 s to reach its 7.6 m/s plateau
                                # while a step action puts the NPC there at
                                # once, so it gains ~8 m for free: start it 30 m
                                # ahead and it settles 45 m ahead, which is not
                                # 'alongside' by any reading.
HWY_LEFT_MID = (-20.0, -200.5)  # 35 m ahead, lane -1
HWY_RIGHT = (-15.0, -207.5)     # 30 m ahead, lane -3 (ego's right)
HWY_RIGHT_NEAR = (-5.0, -207.5)  # 20 m ahead, lane -3
HWY_RIGHT_BACK = (5.0, -207.5)  # 10 m ahead, lane -3 — a follower, not a lead
HWY_LANE_Y = {"left": -200.52, "mid": -204.02, "right": -207.52}
# A construction site tapering from the shoulder across the ego's lane, 23-41 m
# ahead of the ego spawn. Shared by the case and its expectation, so the pose
# assertion is checked against the SAME numbers the placement clicks used.
HWY_WORKZONE = [
    ("static.prop.trafficcone01", (-8.0, -206.0)),
    ("static.prop.trafficcone01", (-12.0, -205.0)),
    ("static.prop.trafficcone01", (-16.0, -204.0)),
    ("static.prop.warningconstruction", (-21.0, -204.0)),
    ("static.prop.streetbarrier", (-26.0, -204.0)),
]

# ── Corridor B: Town05 signalised 4-way junction (junction 1863) ─────────────
#
# East-west road 23 -> 22 crossed by north-south roads 51/52 at x ~ -120. The
# junction occupies x in [-132, -102]; both approaches carry two lanes each way,
# and CARLA has five traffic lights within 80 m of the ego approach, so this is
# a signalised junction and the Signalized* tags are honest here.
#
#   eastbound  lane +1  y = 91.4    lane +2  y = 94.9   <- the ego approaches
#                                                          in +2, the inner lane
#   westbound  lane -1  y = 88.0    lane -2  y = 84.5   <- oncoming
#   southbound cross street: road 51 lane -2 at x = -120.06, heading -90.5
#
# Heading 0 (east) makes the actor's left -y, so the left-turn arm is the one
# heading south and a left turn crosses the oncoming carriageway — the geometry
# every unprotected-left-turn description assumes. Flat throughout (z = 0).
EGO_T5_JCT = {"x": -172.0, "y": 94.87, "yaw": 0.0}   # 40 m short of the junction
# Both goals come from the junction probe: they are real exit waypoints of
# junction 1863 projected 25 m down their arm, not points guessed off a map.
# THE GOAL IS THE ONLY THING THAT MAKES THE EGO TURN. The .xosc gives it a spawn
# pose and nothing else, so every junction case here is 'the planner was asked
# for this arm and took it', never 'the turn was authored'.
GOAL_T5_JCT_LEFT = "-120.8,50.9,0,-91"
GOAL_T5_JCT_STRAIGHT = "-80,95,0,0"
JCT_CROSS_N = (-120.2, 122.0)   # cross street, ~17 m north of the junction
JCT_ONCOMING = (-78.0, 87.97)   # westbound lane -1, ~24 m east of the junction
JCT_AHEAD = (-145.0, 94.90)     # ego's own lane, 27 m ahead, still road 23
JCT_AHEAD_LEFT = (-145.0, 91.40)  # lane +1 alongside it
# The junction's own centre, for asking whether an actor actually got into it.
JCT_CENTRE = (-117.0, 95.0)

# ── Corridor C: Town04 eastbound motorway and its loop on-ramp ───────────────
#
# The only corridor in the bundled maps with a REAL on-ramp, which is what
# CARLA_Leaderboard_8 — "a vehicle merging into its lane from a highway
# on-ramp" — actually asks for. Corridor A can only fake it with a lane change
# out of the adjacent lane. Read off the parsed OpenDRIVE the same way:
#
#   road 40        x -357 .. -121   four eastbound Driving lanes, ids 3..6
#   junction 1176  x -121 ..  -68   road 1185 carries road 40 straight through;
#                                   road 1194 lane 2 is the RAMP's connector
#   road 39        x  -68 ..  +66   the same four lanes, continuing east
#
#   lane 6  y = 37.28 -> 37.85   the RIGHTMOST lane (heading 0 => right is +y)
#   lane 5  y = 33.8    lane 4  y = 30.3    lane 3  y = 26.8
#
# The ramp is road 44, a descending loop from (-33.9, 133.1, z=0) round to
# (-112.6, 55.9, z=8.7); connector 1194 lane 2 runs from there to (-69.7, 37.4)
# — i.e. it feeds lane 6, THE EGO'S LANE, at x ~ -68. From the spawn below the
# merging car has 22.8 m of ramp plus 48.3 m of connector, 71 m in all, to
# reach the carriageway the ego is already driving down.
#
# NOT flat: z climbs 4.95 (ego spawn) -> 7.5 (ramp spawn) -> 9.84 (merge) ->
# 10.6 (goal). Nothing here states a z, actor or route waypoint — they all come
# from ObjectsManager.surfaceZFor, the same path a map click uses.
EGO_T4_HWY = {"x": -195.847, "y": 37.184, "yaw": 0.1}
# The lane-6 point ~172 m east, past the merge. It is what makes the ego drive
# THROUGH the junction the ramp feeds instead of stopping short of it.
GOAL_T4_HWY = "-24,38,11,0"
T4_RAMP = (-123.4, 75.7)          # on the ramp, 71 m of it left to run
T4_RAMP_YAW = 286.3               # the ramp lane's own heading at that point
T4_RAMP_WP = (-123.352, 75.715)   # same point snapped to the lane centre
T4_MERGE_WP = (-58.2, 37.2)       # first carriageway waypoint, past the merge
T4_ROUTE_END = (-24.5, 37.3)      # where the route ends, beside the ego's goal
# The two distance_to_point cues. THE EGO reaches the first (53 m into its
# drive, and 43 m before the 9.7 m radius bites) and that is what releases the
# ramp car; THE RAMP CAR ITSELF reaches the second, which sits 0.1 m from where
# connector 1194 hands over to road 39, so it fires as the merge completes.
T4_CUE_POINT = (-142.8, 37.4)
T4_MERGE_POINT = (-67.5, 37.4)
T4_LANE_Y = 37.4                  # lane 6's centre through the merge and east


# ── Entity refs a case writes into its own events ────────────────────────────
#
# Three event fields name ANOTHER actor by the editor's internal obj-N id:
# distance_to_point's trigger.entity_ref, a relative set_speed's
# target.entity_ref, and set_distance's action.entity_ref. buildScenarioParams
# resolves them against AppState at export (-> hero / adversary / adversaryN),
# so a seeded case has to spell the ids run_carla_cases.py seeds — and those
# are fixed: the ego is obj-1, npcs[i] is obj-(i+2). An id that resolves to
# neither hero nor a real adversaryN is a hard 400 from _entity_ref in
# backend/scenario_io.py, so a wrong one fails at build time, not in CARLA.
EGO_REF = "obj-1"


def npc_ref(index=0):
    return f"obj-{index + 2}"


# ── Case definitions ─────────────────────────────────────────────────────────
#
# kind='template' -> placed through the real template button + map click.
# kind='events'   -> events seeded directly; the event editor is covered by
#                    test_events_e2e.py, and here we want exact numbers.
# kind='scene'    -> several NPCs and/or props; the benchmark cases. NPCs are
#                    seeded (same reason as 'events', plus a click cannot hit a
#                    3.5 m lane at whole-town zoom), props go through the real
#                    prop tool because the facing rule and the elevation lookup
#                    only run on that path.

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
            # No z on the point: the harness derives it, the same way the
            # editor's own trigger-point click does. DistanceCondition is a 3-D
            # distance in ScenarioRunner, so on a graded map a literal z eats
            # the radius (see SEED_EVENTS_JS in run_carla_cases.py). Flat here,
            # which is exactly why it went unnoticed until Town04.
            "trigger": {"type": "distance_to_point", "value": 20.0,
                        "point": {"name": "P", "x": TRIGGER_POINT[0],
                                  "y": TRIGGER_POINT[1]}},
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


# ── Loop2Scenic benchmark cases ──────────────────────────────────────────────
#
# One case per selected benchmark entry. Each carries its source description
# VERBATIM plus the fidelity delta, because the delta is the deliverable: a case
# that reproduces four fifths of a description and silently drops the fifth is
# worse than no case. Two recurring deltas, stated once here rather than on
# every case:
#
#  * THE EGO IS NEVER AUTHORED. The .xosc holds an ego spawn pose and nothing
#    else, so every "the ego turns left / changes lane / brakes" clause is
#    reachable only through --goal and BehaviorAgent's own plan. Where a
#    description makes the ego do something, the case induces it with the goal
#    and ASSERTS THE OUTCOME (heading change, lane, stop) instead of claiming it
#    was scripted. Where the ego would have to change lane around an obstacle or
#    reverse, BehaviorAgent simply will not, and the case says so.
#  * MOST DESCRIPTIONS END IN A COLLISION. Reproducing one ends the run at the
#    impact and makes every trace after it meaningless, so the cases build the
#    conflict that leads to the collision and assert the near miss. run.sh's
#    judge keeps a no-collision check on every case for that reason.

def _speed(eid, trigger, target, duration, shape="step"):
    return {"id": eid, "trigger": trigger,
            "action": {"type": "set_speed",
                       "dynamics": {"shape": shape, "dimension": "time",
                                    "value": duration},
                       "target": {"mode": "absolute", "value": target}}}


def _lane_change(eid, trigger, direction, distance=15.0):
    return {"id": eid, "trigger": trigger,
            "action": {"type": "lane_change", "direction": direction,
                       "dynamics": {"shape": "linear", "dimension": "distance",
                                    "value": distance}}}


def _at_start(value=400.0):
    """distance_to_ego@400 — true the moment the act begins, on every map."""
    return {"type": "distance_to_ego", "value": value}


def _parked():
    """A vehicle that must not move.

    An explicit `set_speed 0` rather than `events: []`. The two now agree —
    an actor with no events gets no Act at all, so it simply holds its Init
    speed (absent here, so 0) — but this stays explicit for two reasons: it
    states the intent in the case itself, and `events: []` on EVERY actor is
    rejected outright at export, since a scenario in which nothing happens has
    no Acts to run.

    Historical note, because the old behaviour was a real trap: an event-less
    actor used to fall back to a constant_speed chain and drive off. Measured: a
    'stationary' car covered 226 m.
    """
    return [_speed("p1", _at_start(), 0.0, 20.0)]


def _after(eid):
    return {"type": "after_event", "event_id": eid}


BENCH_CASES = [
    # ---- corridor A: Town05 westbound motorway --------------------------------
    {
        "name": "bench-hard-brake-lead",
        "kind": "scene",
        "bench": "CARLA_Leaderboard_18",
        "split": "text-only",
        "tags": ["HardBrake"],
        "description": "The leading vehicle decelerates suddenly due to an "
                       "obstacle and the ego-vehicle must perform an emergency "
                       "brake or an avoidance maneuver.",
        "map": "Town05",
        "ego": EGO_T5_HWY,
        "goal": GOAL_T5_HWY,
        "npcs": [{
            "type": "car", "spot": HWY_LEAD, "yaw": 180.0,
            # 20 m ahead at 6 m/s the lead stays inside the ego's stopping
            # distance, so its stop is genuinely sudden from the ego's point of
            # view. A faster lead just runs away and the ego never has to react.
            # The brake is triggered by proximity, not by the chain: it fires
            # when the ego has closed to 15 m, which is what makes the stop
            # sudden *from the ego's point of view* regardless of how long the
            # approach took.
            "events": [_speed("e1", _at_start(), 6.0, 5.0),
                       _speed("e2", {"type": "distance_to_ego", "value": 15.0},
                              0.0, 12.0)],
        }],
        "note": "DELTA: the 'obstacle' the lead brakes for is not modelled — "
                "the deceleration is commanded directly, because a prop in "
                "front of the lead would change what the LEAD does rather than "
                "what it demonstrates. The ego's emergency brake is "
                "BehaviorAgent's, not the editor's, so it is asserted from "
                "telemetry rather than scripted.",
    },
    {
        "name": "bench-highway-cut-in",
        "kind": "scene",
        "bench": "CARLA_Leaderboard_8",
        "split": "text-only",
        "tags": ["HighwayCutIn"],
        "description": "The ego-vehicle encounters a vehicle merging into its "
                       "lane from a highway on-ramp. The ego-vehicle must "
                       "decelerate, brake or change lane to avoid a collision.",
        "map": "Town04",
        "ego": EGO_T4_HWY,
        "goal": GOAL_T4_HWY,
        "npcs": [{
            # On the ramp itself (road 44), not in a neighbour lane, and facing
            # down it. The merge is therefore the ramp's own geometry — the
            # route follows the connector into lane 6 — rather than a
            # LaneChangeAction standing in for one.
            "type": "car", "spot": T4_RAMP, "yaw": T4_RAMP_YAW,
            "events": [
                # 1. The path down the ramp and onto the carriageway. Forced to
                #    simulation_time@0 by the editor either way (see
                #    scenario_io.py), so it is stated that way here.
                #
                #    A route on its own does NOT move the car: AssignRouteAction
                #    becomes ChangeActorWaypoints, which sets waypoints and
                #    nothing else, and BasicControl._target_speed stays 0 until
                #    a speed action lands. That is what lets the ramp car WAIT
                #    for the ego instead of being released at act start — the
                #    trap bench-perpendicular-crossing hit, where an actor
                #    launched at act start cleared the conflict point before the
                #    ego ever arrived.
                {"id": "r1", "trigger": {"type": "simulation_time", "value": 0},
                 "action": {"type": "assign_route", "route_strategy": "fastest",
                            "waypoints": [{"x": T4_RAMP_WP[0], "y": T4_RAMP_WP[1]},
                                          {"x": T4_MERGE_WP[0], "y": T4_MERGE_WP[1]},
                                          {"x": T4_ROUTE_END[0], "y": T4_ROUTE_END[1]}]}},
                # 2. Released when THE EGO reaches the cue point 53 m into its
                #    drive — distance_to_point with an entity_ref, the field
                #    that has to survive the obj-N -> hero remap. It takes the
                #    ego's own speed (relative, delta 0), so the two arrive at
                #    the merge together: 71 m of ramp against the ego's 85 m of
                #    carriageway puts the ramp car in front by ~14 m.
                {"id": "m1",
                 "trigger": {"type": "distance_to_point", "value": 9.7,
                             "entity_ref": EGO_REF,
                             "point": {"name": "Merge cue", "x": T4_CUE_POINT[0],
                                       "y": T4_CUE_POINT[1]}},
                 "action": {"type": "set_speed",
                            "dynamics": {"shape": "step", "dimension": "time",
                                         "value": 2},
                            "target": {"mode": "relative", "entity_ref": EGO_REF,
                                       "delta": 0}}},
                # 3. The same trigger type pointed at ITSELF: once the ramp car
                #    is on the carriageway it accelerates away, which is what
                #    turns the merge into a cut-in the ego has to absorb rather
                #    than a car that simply appears alongside.
                {"id": "m2",
                 "trigger": {"type": "distance_to_point", "value": 5.5,
                             "entity_ref": npc_ref(0),
                             "point": {"name": "Merge complete",
                                       "x": T4_MERGE_POINT[0],
                                       "y": T4_MERGE_POINT[1]}},
                 "action": {"type": "set_speed",
                            "dynamics": {"shape": "step", "dimension": "time",
                                         "value": 5},
                            "target": {"mode": "absolute", "value": 10}}},
            ],
        }],
        "note": "Built on Town04's real on-ramp (road 44 -> connector 1194 -> "
                "lane 6 of road 39), so the description's 'from a highway "
                "on-ramp' is geometry rather than a stand-in: the merging car "
                "spawns on the ramp and joins the ego's lane where the ramp "
                "actually meets it. The ego's half of the description happens "
                "too: it brakes from 7.16 m/s to 0.13 m/s as the ramp car "
                "converges to 10.7 m. DELTAS: (a) that brake is "
                "BehaviorAgent's, so it is asserted from telemetry rather than "
                "scripted, and 'or change lane' remains unauthorable either "
                "way; (b) the collision the description ends in is replaced by "
                "the near miss, see the header.",
    },

    # ---- corridor A: the obstacle case, and the ego-avoidance gap -------------
    {
        "name": "bench-lane-blocked-construction",
        "kind": "scene",
        "bench": "CARLA_Leaderboard_12",
        "split": "text-only",
        "tags": ["ParkedObstacle", "Construction", "Accident"],
        "description": "The ego-vehicle encounters an obstacle blocking the "
                       "lane and must perform a lane change into traffic "
                       "moving in the same direction to avoid it. The obstacle "
                       "may be a construction site, an accident or a parked "
                       "vehicle.",
        "map": "Town05",
        "ego": EGO_T5_HWY,
        "goal": GOAL_T5_HWY,
        # 'traffic moving in the same direction' — the lane the ego would have
        # to move into is occupied, which is what makes the manoeuvre a decision
        # rather than a swerve.
        "npcs": [{
            "type": "car", "spot": HWY_LEFT, "yaw": 180.0,
            "events": [_speed("e1", _at_start(), 7.0, 16.0)],
        }],
        # A construction site across the ego's lane, built from the workzone
        # group: a taper of cones leading to the sign and the barrier. Placed
        # through the real prop tool, so each one gets its facing rule (cones
        # 'none', sign and barrier 'oncoming' -> they turn to face the traffic
        # coming at them) and its surface z from the elevation profile. This
        # corridor climbs, so the five props land at z 0.72 .. 2.71 — a flat
        # literal z would have buried the far end of the taper.
        "props": [{"prop": p, "spot": s} for p, s in HWY_WORKZONE],
        "note": "EXPECTED TO FAIL the avoidance half. The scene is fully "
                "expressible — props reach CARLA as <MiscObject>s at the right "
                "poses — but BehaviorAgent does not plan around a static "
                "obstacle: it keeps its lane and stops. The editor cannot "
                "author an ego lane change either, so 'must perform a lane "
                "change to avoid it' has no expression at all. Fixing it means "
                "ego-manoeuvre authoring (a hero ManeuverGroup in "
                "templates/car.xosc plus an ego event editor), which is a "
                "change to BOTH repos.",
    },

    # ---- corridor B: Town05 signalised junction -------------------------------
    {
        "name": "bench-perpendicular-crossing",
        "kind": "scene",
        "bench": "r7_town05_ins_ss",
        "split": "text-image",
        "tags": ["PerpendicularCrossingConflict"],
        "description": "In an urban environment, the ego car travels straight "
                       "through a four-way intersection. Meanwhile, an "
                       "adversarial car proceeds straight from the cross "
                       "street, cutting perpendicularly across the "
                       "intersection.",
        "map": "Town05",
        "ego": EGO_T5_JCT,
        "goal": GOAL_T5_JCT_STRAIGHT,
        "npcs": [{
            # Southbound on the cross street, 17 m north of the junction mouth.
            # yaw is the lane's own heading; this actor drives ALONG its lane,
            # and it is the two lanes being perpendicular that makes the
            # conflict — nothing here depends on a road-facing yaw.
            "type": "car", "spot": JCT_CROSS_N, "yaw": -90.5,
            # distance_to_ego@45, NOT act start. Launched at act start it is
            # through the junction 5 s before the ego arrives and the two paths
            # never actually conflict — measured on the first run: the crossing
            # car reached the junction at t=1.0s and the ego at t=5.9s. 45 m
            # fires when the ego is ~30 m out, and both reach the mouth together.
            "events": [_speed("e1", {"type": "distance_to_ego", "value": 45.0},
                              7.0, 14.0)],
        }],
        "note": "The ego's straight-through is planner-chosen: the goal is the "
                "far arm of junction 1863 and the case asserts the ego got "
                "there with no net heading change. The crossing car is fully "
                "authored.",
    },

    # ---- corridor A: cut-ins, cut-outs and parallel traffic ------------------
    {
        "name": "bench-double-cut-in",
        "kind": "scene",
        "bench": "lateral_double_cut_in_highway",
        "split": "video-only",
        "tags": ["HardBrake", "StaticCutIn"],
        "description": "the ego vehicle is driving forward under nighttime, "
                       "low-visibility conditions on a highway. the ego "
                       "vehicle is forced under an emergency braking scenario "
                       "due to two passenger cars executing simultaneous, "
                       "reckless maneuvers at a highway split, resulting in a "
                       "rear-end collision.",
        "map": "Town05",
        "ego": EGO_T5_HWY,
        "goal": GOAL_T5_HWY,
        # 'Simultaneous' is the point: both cars share one distance_to_ego
        # trigger rather than being chained, so they commit together.
        #
        # Both cut in at 5 m/s, BELOW the ego's 7.6 m/s cruise. At 8 m/s they
        # simply outrun it and the 'emergency braking' half of the description
        # never happens — measured, first attempt: closest approach 30 m and the
        # ego never dropped below 7.13 m/s. Slower traffic closing from ahead is
        # what forces the brake.
        "npcs": [
            {"type": "car", "spot": HWY_RIGHT_NEAR, "yaw": 180.0,
             "events": [_speed("e1", _at_start(), 5.0, 3.0),
                        _lane_change("e2", _after("e1"), "left", 18.0),
                        _speed("e3", _after("e2"), 5.0, 12.0)]},
            # Staggered 15 m further up the road, NOT level with the first car:
            # two vehicles converging on the same lane from opposite sides at
            # the same x would collide with each other, and an NPC-NPC crash
            # tells you nothing about the ego.
            {"type": "car", "spot": HWY_LEFT_MID, "yaw": 180.0,
             "events": [_speed("f1", _at_start(), 5.0, 3.0),
                        _lane_change("f2", _after("f1"), "right", 18.0),
                        _speed("f3", _after("f2"), 5.0, 12.0)]},
        ],
        "note": "DELTAS: the description's nighttime/low-visibility conditions "
                "are droppable (the editor has a weather model but it changes "
                "nothing measurable here), and the 'highway split' is a "
                "straight three-lane carriageway. The rear-end collision is "
                "replaced by the near miss — see the header. Both cars "
                "converging on the ego's lane from opposite sides is faithful "
                "and is what the case measures.",
    },
    {
        "name": "bench-lead-cuts-out-onto-stopped",
        "kind": "scene",
        "bench": "moving_rain_sudden_cut_out",
        "split": "text-video",
        "tags": ["HardBrake"],
        "description": "The ego vehicle is driving forward under rainy, "
                       "wet-road conditions on a divided highway. The ego "
                       "vehicle is forced under a sudden emergency braking and "
                       "swerving scenario when the vehicle directly ahead slows "
                       "down abruptly and changes lanes to the right to avoid a "
                       "collision with a stationary vehicle ahead, causing the "
                       "ego vehicle to veer right and collide with it.",
        "map": "Town05",
        "ego": EGO_T5_HWY,
        "goal": GOAL_T5_HWY,
        "npcs": [
            # The lead: cruises, slows abruptly, then cuts RIGHT out of the
            # ego's lane — revealing what it was avoiding. The spacing is
            # load-bearing: 8 m/s for 4 s then 3 m/s for 2 s puts it at x=-53
            # when the lane change starts, so it is out of lane -2 by x=-58 and
            # clears the stopped car at x=-70 by 12 m. Lengthen the first link
            # and the lead rear-ends the thing it is supposed to avoid.
            {"type": "car", "spot": HWY_LEAD, "yaw": 180.0,
             "events": [_speed("e1", _at_start(), 8.0, 4.0),
                        _speed("e2", _after("e1"), 3.0, 2.0),
                        _lane_change("e3", _after("e2"), "right", 15.0),
                        _speed("e4", _after("e3"), 8.0, 8.0)]},
            # The stationary vehicle it swerves around, in the ego's lane.
            # Commanded to 0 rather than left eventless — see _parked().
            {"type": "car", "spot": HWY_STOPPED, "yaw": 180.0,
             "events": _parked()},
        ],
        "note": "The reveal is the scenario: the ego's forward view is blocked "
                "by the lead until the lead leaves the lane, and behind it is a "
                "stopped car. DELTA: rain is not modelled and the ego's "
                "'veer right' cannot be authored — the case asserts that the "
                "ego brakes for the revealed obstacle instead.",
    },
    {
        "name": "bench-parallel-lane-traffic",
        "kind": "scene",
        "bench": "r2_town05_ins_c",
        "split": "text-image",
        "tags": ["ParallelLaneTraffic"],
        "description": "In an urban environment, the ego car drives straight "
                       "forward along a multi-lane road structure. Meanwhile, "
                       "an adversarial car occupies the adjacent straight lane "
                       "just ahead of the ego car.",
        "map": "Town05",
        "ego": EGO_T5_HWY,
        "goal": GOAL_T5_HWY,
        "npcs": [{
            "type": "car", "spot": HWY_LEFT_NEAR, "yaw": 180.0,
            # Matched to the ego's own ~7.6 m/s plateau so it STAYS alongside
            # for the whole run. A faster or slower car turns this into an
            # overtake or a drop-back, which are different tags.
            "events": [_speed("e1", _at_start(), 7.5, 16.0)],
        }],
        "note": "Full fidelity — this is the one shape the editor expresses "
                "exactly: a same-direction neighbour holding station. The ego's "
                "'drives straight forward' needs no authoring because the goal "
                "is straight ahead on the same road.",
    },
    {
        "name": "bench-lane-change-right-follower",
        "kind": "scene",
        "bench": "lc_r_2",
        "split": "image-only",
        "tags": ["LaneChange"],
        "description": "lane change right with following object",
        "note_source": "recovered from the card's data-search attribute — the "
                       "image-only split renders media and no visible text, so "
                       "this is the benchmark's own lowercased annotation, not "
                       "a verbatim prompt. The manoeuvre was read off "
                       "benchmark_drive/image-only/lc_r_2/image.png.",
        "map": "Town05",
        "ego": EGO_T5_HWY,
        "goal": GOAL_T5_HWY,
        "npcs": [
            # The subject: changes lane right, out of the ego's lane into -3.
            {"type": "car", "spot": HWY_LEAD, "yaw": 180.0,
             "events": [_speed("e1", _at_start(), 8.0, 4.0),
                        _lane_change("e2", _after("e1"), "right", 18.0),
                        _speed("e3", _after("e2"), 8.0, 8.0)]},
            # The 'following object' it has to fit in ahead of: already in the
            # target lane, behind the subject's entry point.
            {"type": "car", "spot": HWY_RIGHT_BACK, "yaw": 180.0,
             "events": [_speed("f1", _at_start(), 6.0, 18.0)]},
        ],
        "note": "The VVM catalogue entry is about the geometry of the "
                "manoeuvre, not about the ego, so this case authors both "
                "vehicles and leaves the ego as traffic. DELTA: the catalogue "
                "makes the EGO change lane; the editor cannot, so the "
                "manoeuvre is given to an NPC and the relative geometry "
                "(subject ahead, follower in the target lane) is preserved.",
    },
    {
        "name": "bench-truck-invades-lane",
        "kind": "scene",
        "bench": "lateral_ego_overtake_truck_invade",
        "split": "video-only",
        "tags": ["LaneChange", "InvadingTurn", "HeavyVehicle"],
        "description": "the ego vehicle is traveling on a multi-lane roadway "
                       "on a clear morning. the vehicle is involved in a sudden "
                       "side-impact collision when it attempts to overtake a "
                       "large cargo truck, which unexpectedly drifts to the "
                       "left and invades the ego vehicle's lane.",
        "map": "Town05",
        "ego": EGO_T5_HWY,
        "goal": GOAL_T5_HWY,
        "npcs": [{
            # A truck in lane -3 drifting LEFT into the ego's lane -2. The type
            # matters: a firetruck/truck resolves to its own blueprint with its
            # own mass and length, and CLAUDE.md documents how easily that
            # silently degrades to a Lincoln MKZ.
            "type": "truck", "spot": HWY_RIGHT, "yaw": 180.0,
            "events": [_speed("e1", _at_start(), 6.0, 4.0),
                       _lane_change("e2", _after("e1"), "left", 20.0),
                       _speed("e3", _after("e2"), 6.0, 10.0)],
        }],
        "note": "DELTA: the ego's overtake cannot be authored, so the ego stays "
                "in lane -2 and the truck comes to IT. The invasion — the half "
                "the editor can express — is exact, and the case asserts the "
                "truck really is a truck blueprint rather than the car default.",
    },

    # ---- corridor B: junction right-of-way -----------------------------------
    {
        "name": "bench-unprotected-left-turn",
        "kind": "scene",
        "bench": "MD_Unprotected_Left_Turn8",
        "split": "text-video",
        "tags": ["SignalizedJunctionLeftTurn", "NonSignalizedJunctionLeftTurn"],
        "description": "The ego vehicle approaches and turns left through an "
                       "urban, multi-lane 4-way intersection under clear "
                       "weather conditions. As the ego vehicle enters the "
                       "intersection, it yields to an oncoming adversary "
                       "vehicle passing straight ahead from the opposite "
                       "direction, as well as three adversary vehicles on the "
                       "right arm passing straight through the junction. "
                       "Additionally, a pedestrian is navigating through the "
                       "intersection, crossing from the ego's right side toward "
                       "the left as the active vehicles clear the area.",
        "map": "Town05",
        "ego": EGO_T5_JCT,
        "goal": GOAL_T5_JCT_LEFT,
        "npcs": [
            # The oncoming vehicle the ego has to yield to: westbound lane -1,
            # driving straight through the junction across the ego's turn.
            {"type": "car", "spot": JCT_ONCOMING, "yaw": 180.0,
             "events": [_speed("e1", _at_start(), 8.0, 16.0)]},
            # One of the three right-arm vehicles. Only one is modelled: the
            # cross street's driving lanes are 3.5 m apart and three cars in a
            # queue would have to be spaced by hand along a lane whose exact
            # centreline this case does not otherwise depend on. Named as a
            # delta rather than approximated badly.
            {"type": "car", "spot": JCT_CROSS_N, "yaw": -90.5,
             "events": [_speed("f1", _at_start(), 6.0, 16.0)]},
        ],
        "note": "DELTAS: (1) the ego's left turn is INDUCED BY THE GOAL, not "
                "authored — the case asserts the ~-90 deg heading change to "
                "prove the planner took the arm that was asked for; (2) one "
                "right-arm vehicle instead of three; (3) the crossing "
                "pedestrian is omitted — a walker inside a junction has no lane "
                "for _roadFacingYaw to work against, so its heading would be "
                "arbitrary and PedestrianControl walks the spawn heading "
                "forever. bench-pedestrian-crossing covers walkers where the "
                "geometry supports them.",
    },
    {
        "name": "bench-truck-runs-red-light",
        "kind": "scene",
        "bench": "turning_truck_runredlight",
        "split": "video-only",
        "tags": ["SignalizedJunctionLeftTurn", "OppositeVehicleRunningRedLight",
                 "HeavyVehicle"],
        "description": "the ego vehicle is turning left at an intersection on a "
                       "clear day. the vehicle is hit when a truck coming from "
                       "the left runs a red light, speeding straight through "
                       "the intersection and crashing into the side of the ego "
                       "vehicle.",
        "note_source": "recovered from the card's data-search attribute "
                       "(video-only split); the manoeuvre was read off "
                       "benchmark_drive/video-only/turning_truck_runredlight/"
                       "4wKjxDXnmYs_004028.mp4.",
        "map": "Town05",
        "ego": EGO_T5_JCT,
        "goal": GOAL_T5_JCT_LEFT,
        "npcs": [{
            # Southbound on the cross street — the ego's left as it approaches
            # heading east — at 11 m/s, i.e. 'speeding straight through'.
            "type": "truck", "spot": JCT_CROSS_N, "yaw": -90.5,
            # See bench-perpendicular-crossing: a cross-street actor launched at
            # act start clears the junction long before the ego reaches it.
            #
            # 45 m, not the 35 m this case was first written with. A LEFT-TURNING
            # ego cuts the corner — it starts its swing at (-134,89) instead of
            # running to the junction centre — so its closest approach to this
            # spot is 35.6 m, and a 35 m radius misses by 0.6 m. The condition
            # then never fires, the truck waits out the 60 s TimeFallback that
            # every distance_to_ego trigger carries, and the run limps to 77 s
            # with the truck crossing an empty junction. Distance radii on a
            # turning ego need margin for the corner it cuts.
            "events": [_speed("e1", {"type": "distance_to_ego", "value": 45.0},
                              11.0, 16.0)],
        }],
        "note": "DELTA, and an unusual one: 'runs a red light' needs no "
                "expression, because an NPC on simple_vehicle_control ignores "
                "traffic lights ENTIRELY. The editor can force a signal state "
                "(AppState.trafficSignals -> TrafficSignalStateAction) but has "
                "no way to make an actor obey or disobey one, so red-light "
                "running is free and light-abiding traffic is impossible. That "
                "is a gap in the NPC controller, not in the editor. The ego's "
                "left turn is goal-induced as everywhere else.",
    },
    {
        "name": "bench-blocked-intersection",
        "kind": "scene",
        "bench": "BLO_3",
        "split": "video-only",
        "tags": ["BlockedIntersection"],
        "description": "on a straight road section between two 4-way "
                       "intersections, the ego vehicle (green box) is heavily "
                       "obstructed by a cluster of stopped or slow-moving "
                       "adversaries (yellow boxes) directly ahead and to its "
                       "sides. this traffic bottleneck completely blocks the "
                       "ego's forward path, forcing it to remain stationary.",
        "note_source": "recovered from the card's data-search attribute "
                       "(video-only split); read off "
                       "benchmark_drive/video-only/BLO_3/BLO_3.mp4.",
        "map": "Town05",
        "ego": EGO_T5_JCT,
        "goal": GOAL_T5_JCT_STRAIGHT,
        # 'directly ahead and to its sides', on the straight approach BEFORE
        # junction 1863 — which is what the description's 'between two
        # intersections' means.
        #
        # 'stopped OR SLOW-MOVING': the one in the ego's lane crawls at 0.5 m/s
        # and the one beside it never moves (an empty event list is the editor's
        # way of saying so). The crawl is not decoration — a scenario whose NPCs
        # have no events at all has an empty storyboard, which ends immediately
        # and leaves nothing to measure. One event sets the run's length.
        "npcs": [
            {"type": "car", "spot": JCT_AHEAD, "yaw": 0.0,
             "events": [_speed("e1", _at_start(), 0.5, 16.0)]},
            {"type": "car", "spot": JCT_AHEAD_LEFT, "yaw": 0.0,
             "events": _parked()},
        ],
        "note": "The one case where the ego's required behaviour — remain "
                "stationary — is what BehaviorAgent does anyway, so the "
                "description is reproduced end to end without authoring the "
                "ego. Both lanes of the carriageway are blocked, so there is "
                "no gap for the planner to find.",
    },

    # ---- corridor C: Town01, the VRU cases -----------------------------------
    {
        "name": "bench-pedestrian-crossing",
        "kind": "template",
        "template": "pedestrian-crossing",
        "bench": "CPNA_25_50kph",
        "split": "text-video",
        "tags": ["DynamicObjectCrossing"],
        "description": "a collision in which a vehicle travels forwards towards "
                       "an adult pedestrian crossing its path walking from the "
                       "nearside and the frontal structure of the vehicle "
                       "strikes the pedestrian when no braking action is "
                       "applied.",
        "spot": SPOT_WALK,
        # NO npc_yaw. _roadFacingYaw gives +90 here, square across the
        # carriageway, and that yaw IS the crossing — PedestrianControl with no
        # waypoints walks the spawn heading forever. SPOT_WALK is the kerb on
        # the ego's own side of road 1, i.e. the NEARSIDE the description names.
        "note": "Placed through the real template button, so the whole "
                "template + road-facing-yaw path is under test. DELTAS: Euro "
                "NCAP's 'no braking action is applied' cannot be expressed — "
                "BehaviorAgent brakes for walkers and there is no way to "
                "disable that — so the collision becomes a near miss and the "
                "case asserts the ego yielded instead.",
    },
    {
        "name": "bench-child-from-behind-van",
        "kind": "scene",
        "bench": "CPNCO_RunningChildFromNearSide",
        "split": "image-only",
        "tags": ["DynamicObjectCrossing", "ParkingCrossingPedestrian"],
        "description": "a collision in which a vehicle travels forwards towards "
                       "a child pedestrian crossing its path running from "
                       "behind and obstruction from the nearside and the "
                       "frontal structure of the vehicle strikes the pedestrian "
                       "when no braking action is applied.",
        "note_source": "recovered from the card's data-search attribute "
                       "(image-only split); the layout was read off "
                       "benchmark_drive/image-only/CPNCO_RunningChildFromNearSide/"
                       "CPNCO_RunningChildFromNearside.png.",
        "npcs": [
            # The child, on the nearside kerb, crossing. yaw is stated because a
            # seeded actor bypasses the placement click: +90 is what
            # _roadFacingYaw computes at this spot, square across road 1.
            {"type": "child", "spot": SPOT_WALK, "yaw": 90.0,
             "events": [_speed("e1", {"type": "distance_to_ego", "value": 45.0},
                               2.5, 8.0),
                        _speed("e2", _after("e1"), 0.0, 6.0)]},
            # The obstruction it runs out from behind: a van parked at the kerb
            # two metres upstream, between the ego and the child.
            {"type": "van", "spot": KERB_PARKED, "yaw": 180.0,
             "events": _parked()},
        ],
        "note": "The occlusion is the scenario, and the editor expresses it "
                "with a parked van rather than a prop because a van is the "
                "right size and mass and CARLA's own ParkingCrossingPedestrian "
                "uses a vehicle too. DELTAS: 'running' is a 2.5 m/s walk (the "
                "walker controller takes a speed, not a gait) and the collision "
                "is a near miss.",
    },
    {
        "name": "bench-school-bus-opposing-lane",
        "kind": "scene",
        "bench": "DetectAndRespondToSchoolBus",
        "split": "image-only",
        "tags": ["HeavyVehicle"],
        "description": "a vehicle equipped with an ads feature is driving along "
                       "a straight, undivided, multilane highway. it approaches "
                       "a school bus that is stopped in an opposing lane, with "
                       "lights and signs activated, to allow students to "
                       "disembark.",
        "note_source": "recovered from the card's data-search attribute "
                       "(image-only split); read off the screenshot under "
                       "benchmark_drive/image-only/DetectAndRespondToSchoolBus/.",
        # Town01 road 1 is the undivided two-way road this needs: the ego runs
        # west in lane -1 and lane +1 at y=+1.97 is the opposing carriageway
        # (verified against CARLA's waypoint API). Corridor A cannot host it —
        # it has no oncoming lane at all.
        #
        # 'Stopped' is commanded rather than left implicit, because a scenario
        # whose only NPC has no events has an empty storyboard and ends before
        # the ego has driven anywhere.
        "npcs": [{"type": "bus", "spot": ONCOMING_LANE, "yaw": 0.0,
                  "events": _parked()}],
        "note": "DELTAS: there is no school-bus blueprint in the catalogue and "
                "no way to model the flashing lights or the extended stop sign, "
                "so this reduces to a stopped HeavyVehicle in the opposing "
                "lane — which is the tag the benchmark actually assigns. What "
                "IS tested is that `bus` resolves to a real bus blueprint with "
                "bus geometry and that a 10 m vehicle can be placed in the "
                "oncoming lane without fouling the ego's.",
    },

    # ---- the vocabulary gap --------------------------------------------------
    {
        "name": "bench-reversing-vehicle",
        "kind": "scene",
        "bench": "NHTSA_PreCrash_12",
        "split": "text-only",
        "tags": ["ReversingManeuver"],
        "description": "Vehicle is backing up in an urban area, in daylight, "
                       "under clear weather conditions, at a driveway or alley "
                       "location, with a posted speed limit of 25 mph; and "
                       "collides with another vehicle",
        # The car faces east in lane +1 and is asked to travel west, so a true
        # reverse would be pure backwards motion with the heading unchanged.
        # 100 m ahead of the ego spawn and one lane over, so whatever it does
        # plays out clear of the ego — the description ends in a collision,
        # which is the usual substitution (see the header).
        "npcs": [{
            "type": "car", "spot": REVERSE_SPOT, "yaw": 0.0,
            # The nearest thing the vocabulary offers: waypoints laid BEHIND the
            # actor's spawn heading. There is no reverse action and no negative
            # speed — _normalize_structured_event clamps set_speed at 0 — so
            # follow_trajectory is the only candidate. Waypoint z is filled in
            # by the harness from the elevation profile, never written here.
            "events": [{
                "id": "e1", "trigger": _at_start(),
                "action": {"type": "follow_trajectory",
                           "trajectory": [{"x": 190.0, "y": 1.96},
                                          {"x": 180.0, "y": 1.96},
                                          {"x": 170.0, "y": 1.96}]},
            }],
        }],
        "note": "EXPECTED TO FAIL — the editor has NO reverse. Its five actions "
                "are follow_trajectory, assign_route, set_speed, set_distance "
                "and lane_change; set_speed clamps negatives to 0 and neither "
                "SimpleVehicleControl nor the OpenSCENARIO SpeedAction the "
                "exporter emits carries a gear or a sign. This case builds the "
                "closest thing available — waypoints laid behind the actor — "
                "and measures what actually happens: the controller turns the "
                "car around and drives forward, so the actor's heading flips "
                "~180 deg instead of it backing up. Fixing it needs a new "
                "action in all three layers (eventPanel.js, "
                "_normalize_structured_event, event_builders.py) and a "
                "controller that honours it.",
    },
]

CASES += BENCH_CASES

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

import math  # noqa: E402
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


# ── Benchmark expectations ───────────────────────────────────────────────────
#
# Every bench case has to answer two questions separately, because the editor
# controls only one of them:
#
#   the ADVERSARY side — did the authored event fire (OSC log) and did the
#     actor do it (telemetry)? A failure here is an editor/exporter defect.
#   the EGO side — did BehaviorAgent take the arm the goal named, and did the
#     scene change its behaviour? A failure here is usually a fidelity limit,
#     not a bug, and is what the coverage report is made of.
#
# The helpers below exist so the ego half is never left unasserted. It is easy
# to write a junction case that checks the adversary perfectly and never notices
# the ego drove straight on past the turn.

def _lane_y(run, role, t_rel):
    """The actor's world y at `t_rel` — which lane of corridor A it is in."""
    track = run.get(role)
    if track is None:
        return None
    base = run.act_start()
    i = track.at(base + t_rel) if base is not None else None
    return None if i is None else track.y[i]


def _gap_at(run, t_rel, role="adversary"):
    """Centre-to-centre ego->actor distance at an act-relative time.

    What a distance_to_ego trigger is nominally measuring, read back out of
    telemetry so the firing instant can be checked instead of trusted.
    """
    hero, track = run.get("hero"), run.get(role)
    base = run.act_start()
    if hero is None or track is None or base is None:
        return None
    i, j = hero.at(base + t_rel), track.at(base + t_rel)
    if i is None or j is None:
        return None
    return math.hypot(hero.x[i] - track.x[j], hero.y[i] - track.y[j])


def _speed_at(run, role, t_rel):
    """`role`'s speed at an act-relative time.

    What a RelativeTargetSpeed action resolves against: it is emitted with
    continuous='false', so the actor takes the reference entity's speed AT THE
    INSTANT THE ACTION LANDS and holds that number. Asserting such an action
    therefore means reading the reference's own trace, not a constant.
    """
    track = run.get(role)
    base = run.act_start()
    if track is None or base is None:
        return None
    return track.speed_at(base + t_rel)


def _dropped_below(run, role, speed, after=0.0):
    """First act-relative time `role` fell under `speed` m/s past `after`.

    Telemetry's own answer to "when did the command land", for use when the OSC
    log's timestamp for an event is too coarse to measure a distance against.
    """
    track = run.get(role)
    base = run.act_start()
    if track is None or base is None:
        return None
    for i, t in enumerate(track.t):
        if t - base >= after and track.speed[i] < speed:
            return t - base
    return None


def _ego_took_the_turn(run, want_deg, tol=35.0, t_to=22.0):
    """Did the ego's heading change by ~want_deg? -> [(label, ok, detail)].

    The only available proof that a goal on a particular arm actually produced
    that manoeuvre. Left is negative in CARLA's frame, right positive, straight
    ~0. The tolerance is wide on purpose: the ego is still mid-corner when the
    storyboard ends on some cases, and what is being separated is 'took the
    turn' from 'carried straight on', not 88 deg from 92.
    """
    deg, detail = A.heading_change(run, "hero", 0.0, t_to)
    if deg is None:
        return [(f"ego heading changes by ~{want_deg:+.0f} deg", False, detail)]
    return [(f"EGO TOOK THE {'STRAIGHT' if want_deg == 0 else 'TURN'} "
             f"THE GOAL NAMED (~{want_deg:+.0f} deg)",
             abs(deg - want_deg) <= tol, detail)]


def expect_bench_hard_brake_lead(run, timeline):
    out = []
    ok, detail = _chain_order(timeline, ["SpeedEvent0", "SpeedEvent1"])
    out.append(("lead's cruise -> brake chain runs in order", ok, detail))
    ok, detail = A.reaches_speed(run, "adversary", 6.0, 0.5, 5.0, tol=1.5)
    out.append(("lead cruises at the commanded 6 m/s", ok, detail))
    # The brake is on distance_to_ego@15, not on the chain, so WHEN it fires is
    # measured rather than assumed: the ego closes on a 6 m/s lead at ~1.6 m/s
    # and takes ~16 s to eat the 30 m gap. Every window below is anchored to the
    # event's own start for that reason — a hardcoded window silently tested the
    # cruise phase instead once the trigger moved.
    brake = timeline.get(_name_of(timeline, "SpeedEvent1"), {}).get("start")
    if brake is None:
        out.append(("the brake fires on proximity", False,
                    "SpeedEvent1 never ran — the ego never closed to 15 m"))
        return out
    # Measured at the instant the lead's speed ACTUALLY collapses, not at the
    # OSC log's timestamp for it. The two clocks share only the act-start
    # instant, and the log here lags telemetry by ~0.8 s — during which the ego,
    # still at 7.5 m/s behind a now-stopped lead, eats 6 m of the gap. Reading
    # the log's time gives 9 m and looks like a broken trigger.
    fired = _dropped_below(run, "adversary", 1.0, after=6.0)
    gap = None if fired is None else _gap_at(run, fired)
    out.append(("THE BRAKE FIRES WHEN THE EGO IS ~15 m BEHIND",
                gap is not None and 13.0 <= gap <= 17.0,
                f"gap {gap:.1f} m at the lead's stop (t={fired:.2f}s, "
                f"OSC log says {brake:.2f}s)" if gap is not None else
                "the lead never stopped, so the trigger never fired"))
    # The whole description: the deceleration is SUDDEN. A step action means the
    # controller is asked for 0 immediately, so the plateau must be at 0 within
    # a couple of seconds of the trigger, not a long coast down.
    ok, detail = A.holds_speed(run, "adversary", 0.0, brake + 2.0, brake + 9.0,
                               tol=0.6)
    out.append(("lead comes to a full stop and stays there", ok, detail))
    # The ego half is not authored — assert the outcome instead of claiming it.
    # It only has to stop AFTER the lead does; before that it is cruising, and a
    # window opened at act start would pass on the ego's own standing start.
    ok, detail = A.stopped_within(run, "hero", brake, brake + 9.0, threshold=1.0)
    out.append(("EGO REACTS: brakes to a near-stop behind the lead", ok, detail))
    return out


def expect_bench_highway_cut_in(run, timeline):
    """Wait on the ramp -> released by the ego -> merge -> accelerate away.

    Each of the three events is a different mechanism under test:

      AssignRouteEvent0    the ramp path itself, and the fact that a route ALONE
                           does not move the car (ChangeActorWaypoints leaves
                           _target_speed at 0)
      RelativeSpeedEvent1  distance_to_point pointed at the EGO — the merging
                           car is released by the ego's own progress — plus a
                           relative speed target, so it merges at the ego's speed
      SpeedEvent2          the same trigger type pointed at ITSELF, firing where
                           the ramp hands over to the carriageway

    So a failure here says which of the three broke, and the position checks say
    whether the car physically did what the events asked.
    """
    out = []
    ok, detail = _chain_order(
        timeline, ["AssignRouteEvent0", "RelativeSpeedEvent1", "SpeedEvent2"])
    out.append(("route -> release -> accelerate runs in order", ok, detail))

    release = timeline.get(_name_of(timeline, "RelativeSpeedEvent1"), {}).get("start")
    if release is None:
        out.append(("THE EGO RELEASES THE RAMP CAR", False,
                    "RelativeSpeedEvent1 never ran — the ego never came within "
                    "9.7 m of the cue point, or its entity_ref did not resolve "
                    f"(saw {sorted(timeline)})"))
        return out

    # 1. WHEN it was released, measured against the ego's own recorded motion
    #    rather than a hardcoded time. This is the whole distance_to_point
    #    contract: an entity_ref that failed to resolve leaves trigger_actor
    #    None and the condition simply never fires, which is indistinguishable
    #    from a badly-tuned radius unless the two times are compared.
    want = A.time_ego_within(run, T4_CUE_POINT, 9.7)
    out.append(("THE EGO'S OWN PROXIMITY TO THE CUE POINT IS WHAT FIRES IT",
                want is not None and abs(release - want) <= 2.0,
                f"event at t={release:.2f}s, ego reached "
                f"{T4_CUE_POINT} +/-9.7 m at t={want:.2f}s"
                if want is not None else
                f"event at t={release:.2f}s but the ego never came within "
                f"9.7 m of {T4_CUE_POINT} at all"))

    # 2. Until then it WAITS on the ramp. A route is waypoints only — nothing
    #    sets a target speed — so a car that creeps here means something else
    #    (a stray behaviour chain, a fallback) is driving it.
    ok, detail = A.holds_speed(run, "adversary", 0.0, 0.5,
                               max(1.0, release - 1.0), tol=0.5)
    out.append(("it waits on the ramp until the ego releases it", ok, detail))

    # 3. Relative target, delta 0: it takes THE EGO'S speed at that instant,
    #    which is what keeps the two converging on the merge together instead of
    #    one clearing it first.
    ego_v = _speed_at(run, "hero", release)
    if ego_v is not None:
        ok, detail = A.reaches_speed(run, "adversary", ego_v,
                                     release + 0.5, release + 6.0, tol=1.5)
        out.append((f"it sets off at THE EGO'S speed ({ego_v:.2f} m/s)", ok, detail))

    # 4. It came down the ramp: 38 m of y, which no vehicle on the carriageway
    #    can produce — every lane there is within 11 m of the next.
    npc = run.get("adversary")
    if npc is not None:
        dy = npc.y[0] - min(npc.y)
        out.append(("IT DESCENDS THE RAMP RATHER THAN STARTING ON THE ROAD",
                    npc.y[0] > 60.0 and dy > 30.0,
                    f"spawned at y={npc.y[0]:.2f} (ramp), came down to "
                    f"y={min(npc.y):.2f} — {dy:.1f} m of lateral travel"))

    # 5. The merge itself: it has to END UP in lane 6, the ego's lane. Measured
    #    at the merge cue rather than at the last sample, because the route ends
    #    at x=-24.5 and the controller then plans its own continuation.
    merge = timeline.get(_name_of(timeline, "SpeedEvent2"), {}).get("start")
    y_merged = None if merge is None else _lane_y(run, "adversary", merge + 3.0)
    if y_merged is not None:
        out.append((f"IT ENDS UP IN THE EGO'S LANE (y ~ {T4_LANE_Y})",
                    abs(y_merged - T4_LANE_Y) <= 1.5,
                    f"y={y_merged:.2f} at t={merge + 3.0:.2f}s; spawned on the "
                    f"ramp at y={T4_RAMP[1]}, lane 6 centre {T4_LANE_Y}"))

    # 6. The second distance_to_point, this one measuring the ACTOR, not the
    #    ego. Same comparison as check 1, against the actor's own track.
    if merge is not None:
        want = A.time_within(run, "adversary", T4_MERGE_POINT, 5.5)
        out.append(("its OWN proximity to the merge point fires the accelerate",
                    want is not None and abs(merge - want) <= 2.0,
                    f"event at t={merge:.2f}s, the car reached "
                    f"{T4_MERGE_POINT} +/-5.5 m at t={want:.2f}s"
                    if want is not None else
                    f"event at t={merge:.2f}s but the car never came within "
                    f"5.5 m of {T4_MERGE_POINT}"))
        ok, detail = A.reaches_speed(run, "adversary", 10.0,
                                     merge + 0.5, merge + 8.0, tol=1.5)
        out.append(("it accelerates to 10 m/s once on the carriageway", ok, detail))

        # 7. IN FRONT OF THE EGO, not behind it. A merge that lands behind is
        #    still a merge and still passes every check above, but it is not the
        #    scenario: the description has the ego meeting the merging car.
        hero, gap = run.get("hero"), _gap_at(run, merge)
        base = run.act_start()
        if hero is not None and npc is not None and base is not None:
            i, j = hero.at(base + merge), npc.at(base + merge)
            ahead = npc.x[j] - hero.x[i]   # corridor runs east, so +x is ahead
            out.append(("IT MERGES IN FRONT OF THE EGO", ahead > 0,
                        f"the merging car is {ahead:+.1f} m along the corridor "
                        f"from the ego as it joins"
                        + (f", {gap:.1f} m away" if gap is not None else "")))

        # 8. THE EGO'S HALF OF THE DESCRIPTION — "must decelerate, brake or
        #    change lane to avoid a collision". Not authored and not authorable:
        #    this is BehaviorAgent reacting to a car converging on its lane, so
        #    it is measured, not claimed. Measured: cruising at 7.16 m/s with
        #    the ramp car 10.7 m off, it went to 0.13 m/s inside half a second —
        #    an emergency stop, not a lift-off. The window is the approach
        #    itself; opening it later catches the recovery instead, which peaks
        #    ABOVE the cruise (12.6 m/s) and reads as no brake at all.
        ok, detail = A.slows_by(run, "hero", 2.0, release, merge)
        out.append(("EGO REACTS: it sheds speed as the ramp car converges",
                    ok, detail))

    # 9. The conflict is real: a merge 100 m clear of the ego is not a cut-in.
    #    Measured 10.68 m, at t=+14.2s — while the ramp still converges, before
    #    the merge completes. The no-collision floor is added by the judge for
    #    every case.
    dist, when = A.closest_approach(run, "hero", "adversary")
    if dist is not None:
        out.append(("the merge happens in the ego's immediate path", dist <= 25.0,
                    f"closest approach {dist:.2f} m at t={when:+.1f}s"))
    return out


def expect_bench_lane_blocked_construction(run, timeline):
    """The scene builds perfectly; the avoidance does not exist at all.

    Props reach CARLA as `prop0..propN` — the entity refs validate_scenario_params
    assigns by array index — NOT under their blueprint id, so they are looked up
    by role here. They carry no events, so the OSC log says nothing about them
    and telemetry is the only witness; this is the one case that records the
    whole world rather than vehicles only.
    """
    out = []
    # 1. Every prop reached CARLA at the pose the editor placed it. This is the
    #    whole export chain in one assertion: catalogue -> <MiscObject> ->
    #    teleport -> spawn, including the elevation-derived z, since the taper
    #    climbs 2 m over its 18 m and a flat z would bury its far end.
    for i, (blueprint, (px, py)) in enumerate(HWY_WORKZONE):
        role = f"prop{i}"
        track = run.get(role)
        ok = track is not None
        out.append((f"{role} ({blueprint.split('.')[-1]}) spawned", ok,
                    f"no rows for {role}; roles seen: {sorted(run.tracks)}"))
        if track is not None:
            off = math.hypot(track.x[0] - px, track.y[0] - py)
            out.append((f"{role} spawned within 1.5 m of where it was placed",
                        off < 1.5,
                        f"spawned ({track.x[0]:.1f},{track.y[0]:.1f}), "
                        f"placed ({px},{py}); off by {off:.2f} m"))
    # 2. The same-direction traffic the description says the ego must merge into.
    ok, detail = A.reaches_speed(run, "adversary", 7.0, 0.5, 14.0, tol=2.0)
    out.append(("the lane the ego would merge into is occupied and moving",
                ok, detail))

    # 3. The two halves that do not exist, asserted positively so they turn
    #    green the day ego-manoeuvre authoring lands. Measured: the ego holds
    #    its lane at ~7 m/s and DRIVES THROUGH the site, dragging the barrier
    #    70 m down the road. It does not brake and it does not steer.
    y_end = _lane_y(run, "hero", 20.0)
    if y_end is not None:
        out.append(("EXPECTED TO FAIL — ego changes lane around the obstacle",
                    abs(y_end - HWY_LANE_Y["left"]) <= 1.5,
                    f"ego y={y_end:.2f}, still its own lane "
                    f"{HWY_LANE_Y['mid']:.2f}; BehaviorAgent keeps its lane and "
                    f"the editor cannot author an ego lane change"))
    ok, detail = A.stopped_within(run, "hero", 3.0, 22.0, threshold=1.0)
    out.append(("EXPECTED TO FAIL — ego brakes for the obstacle", ok, detail))
    # The evidence for the line above, and the sharper finding: BehaviorAgent's
    # obstacle check only considers vehicles and walkers, so a <MiscObject> is
    # invisible to it. Displacement is the proof it was hit rather than passed.
    shoved = max(
        (math.hypot(run[f"prop{i}"].x[-1] - run[f"prop{i}"].x[0],
                    run[f"prop{i}"].y[-1] - run[f"prop{i}"].y[0])
         for i in range(len(HWY_WORKZONE)) if f"prop{i}" in run), default=0.0)
    out.append(("EXPECTED TO FAIL — the site is still standing at the end",
                shoved < 2.0,
                f"the ego shoved a prop {shoved:.1f} m: it drove through the "
                f"site, so props are not obstacles to BehaviorAgent at all"))
    return out


def expect_bench_perpendicular_crossing(run, timeline):
    out = []
    ok, detail, _ = _fired(timeline, "SpeedEvent0")
    out.append(("cross-street car's speed event fires", ok, detail))
    ok, detail = A.reaches_speed(run, "adversary", 7.0, 0.5, 8.0, tol=2.0)
    out.append(("cross-street car drives at the commanded 7 m/s", ok, detail))
    # It has to actually enter the junction — a car that sets off and stops
    # short of the mouth crosses nothing, and the speed trace cannot tell.
    t_in = A.time_within(run, "adversary", JCT_CENTRE, 15.0)
    out.append(("cross-street car reaches the junction", t_in is not None,
                f"within 15 m of {JCT_CENTRE} at t={t_in}s" if t_in is not None
                else f"never got within 15 m of {JCT_CENTRE}"))
    # Perpendicular means perpendicular: the cross street runs north-south, the
    # ego's road east-west, so the adversary's travel must be dominated by dy.
    adv = run.get("adversary")
    if adv is not None:
        dx, dy = adv.x[-1] - adv.x[0], adv.y[-1] - adv.y[0]
        out.append(("its path is PERPENDICULAR to the ego's, not along it",
                    abs(dy) > 2 * abs(dx),
                    f"net dx={dx:+.1f} m (ego's axis), dy={dy:+.1f} m (across it)"))
    out.extend(_ego_took_the_turn(run, 0.0, tol=25.0))
    t_ego = A.time_within(run, "hero", JCT_CENTRE, 15.0)
    out.append(("ego reaches the junction too", t_ego is not None,
                f"ego within 15 m of the junction at t={t_ego}s"
                if t_ego is not None else "ego never reached the junction"))
    # Crossing the same junction at different times is not a conflict. This is
    # the check that separates 'the geometry is perpendicular' from 'the two
    # actually met there', and it is what the distance_to_ego trigger buys.
    dist, when = A.closest_approach(run, "hero", "adversary")
    out.append(("THE PATHS CONFLICT IN TIME, not just in space",
                dist is not None and dist < 25.0,
                f"closest approach {dist:.1f} m at t={when:+.1f}s"
                if dist is not None else "no data"))
    return out


def _merged_into(run, role, want_y, t_rel=12.0, label="the ego's lane"):
    """Did `role` end up in the lane at `want_y`? -> (label, ok, detail).

    The absolute companion to lateral_offset. |lateral| ~ 3.5 m is equally true
    of a lane change that went the WRONG way, and on a three-lane carriageway
    that lands the actor somewhere the scenario never meant it to be.
    """
    y = _lane_y(run, role, t_rel)
    if y is None:
        return (f"{role} ends up in {label}", False, "no samples")
    return (f"{role} ENDS UP IN {label.upper()} (y ~ {want_y})",
            abs(y - want_y) <= 1.5,
            f"y={y:.2f} at t={t_rel:.0f}s; lanes are "
            + ", ".join(f"{k} {v}" for k, v in HWY_LANE_Y.items()))


def expect_bench_double_cut_in(run, timeline):
    out = []
    for role in ("adversary", "adversary1"):
        ok, detail = A.reaches_speed(run, role, 5.0, 0.5, 4.0, tol=1.0)
        out.append((f"{role} settles at 5 m/s before committing", ok, detail))
        # Both converge on the ego's lane — one from the right, one from the
        # left — so both are checked against the same target y.
        out.append(_merged_into(run, role, HWY_LANE_Y["mid"], 12.0))
    # Simultaneous is the description's word: both cars share one act-start
    # trigger and their chains are the same length, so the two lane changes must
    # begin within a second of each other.
    starts = [t["start"] for n, t in timeline.items()
              if "LaneChange" in n and t["start"] is not None]
    out.append(("both cut-ins commit simultaneously", len(starts) == 2
                and abs(starts[0] - starts[1]) <= 1.5,
                f"lane-change starts at {sorted(round(s, 2) for s in starts)}s"))
    # 'forced under an emergency braking scenario' — the one ego-side claim.
    # A drop, not an absolute floor: the ego ends up FOLLOWING the two cars at
    # their 5 m/s, so it never stops, and the observable is that it gave up
    # 2.5 m/s of its cruise to do so.
    ok, detail = A.slows_by(run, "hero", 2.5, 1.0, 20.0)
    out.append(("EGO REACTS: sheds speed for the converging traffic",
                ok, detail))
    return out


def expect_bench_lead_cuts_out_onto_stopped(run, timeline):
    out = []
    ok, detail = _chain_order(
        timeline, ["SpeedEvent0", "SpeedEvent1", "LaneChangeEvent2", "SpeedEvent3"])
    out.append(("cruise -> slow -> cut out -> resume runs in order", ok, detail))
    ok, detail = A.reaches_speed(run, "adversary", 3.0, 4.5, 7.0, tol=1.5)
    out.append(("lead slows abruptly to 3 m/s before swerving", ok, detail))
    out.append(_merged_into(run, "adversary", HWY_LANE_Y["right"], 12.0,
                            "the right-hand lane"))
    # The stationary car has to still be stationary and still in the ego's lane
    # — it is the thing the reveal reveals.
    stopped = run.get("adversary1")
    if stopped is not None:
        out.append(("the revealed vehicle never moves",
                    stopped.distance_travelled() < 2.0,
                    f"travelled {stopped.distance_travelled():.1f} m"))
        out.append(("the revealed vehicle is in the ego's lane",
                    abs(stopped.y[0] - HWY_LANE_Y["mid"]) <= 1.0,
                    f"y={stopped.y[0]:.2f} vs ego lane {HWY_LANE_Y['mid']}"))
    ok, detail = A.stopped_within(run, "hero", 3.0, 22.0, threshold=1.0)
    out.append(("EGO REACTS: brakes for the vehicle the lead uncovered",
                ok, detail))
    return out


def expect_bench_parallel_lane_traffic(run, timeline):
    out = []
    ok, detail, _ = _fired(timeline, "SpeedEvent0")
    out.append(("the neighbour's speed event fires", ok, detail))
    ok, detail = A.holds_speed(run, "adversary", 7.5, 1.0, 14.0, tol=1.0)
    out.append(("neighbour holds the commanded 7.5 m/s", ok, detail))
    out.append(_merged_into(run, "adversary", HWY_LANE_Y["left"], 12.0,
                            "the adjacent left lane"))
    # 'Alongside' is the whole tag: it must stay in the adjacent lane and stay
    # roughly level, not overtake and vanish or drop back out of sight.
    hero, adv = run.get("hero"), run.get("adversary")
    if hero is not None and adv is not None:
        base = run.act_start()
        gaps = []
        for t_rel in (2.0, 6.0, 10.0, 14.0):
            i, j = hero.at(base + t_rel), adv.at(base + t_rel)
            if i is not None and j is not None:
                gaps.append(abs(hero.x[i] - adv.x[j]))
        out.append(("it stays ALONGSIDE, not ahead and gone",
                    bool(gaps) and max(gaps) < 30.0,
                    "along-road gap at t=2,6,10,14s: "
                    + ", ".join(f"{g:.1f}" for g in gaps) + " m"))
        lat = [abs(hero.y[hero.at(base + t)] - adv.y[adv.at(base + t)])
               for t in (2.0, 6.0, 10.0, 14.0)]
        out.append(("it stays one lane over the whole time",
                    max(lat) < 5.0,
                    "lateral separation: " + ", ".join(f"{v:.1f}" for v in lat) + " m"))
    return out


def expect_bench_lane_change_right_follower(run, timeline):
    out = []
    ok, detail = _chain_order(
        timeline, ["SpeedEvent0", "LaneChangeEvent1", "SpeedEvent2"])
    out.append(("subject's accelerate -> change right -> resume", ok, detail))
    ended = timeline.get(_name_of(timeline, "LaneChangeEvent1"), {}).get("end")
    out.append(("the lane change completes", ended is not None,
                f"LaneChangeEvent1 END at t={ended}s" if ended is not None else
                "went RUNNING but never reached END"))
    lateral, detail = A.lateral_offset(run, "adversary", 2.0, 12.0)
    if lateral is None:
        out.append(("subject changes lane", False, detail))
    else:
        # 'right' is emitted as RelativeTargetLane value=-1 and lateral_offset
        # is positive to the actor's LEFT, so a right change must come out
        # negative. This is the sign check the direction mapping needs.
        out.append(("'right' displaces the subject to ITS OWN right (negative)",
                    -6.0 <= lateral <= -2.0, detail))
    out.append(_merged_into(run, "adversary", HWY_LANE_Y["right"], 12.0,
                            "the right-hand lane"))
    # The 'following object': already in the target lane, and it must still be
    # BEHIND the subject at the end — otherwise the subject cut in front of
    # nothing.
    subj, follower = run.get("adversary"), run.get("adversary1")
    if subj is not None and follower is not None:
        out.append(("the follower is in the target lane",
                    abs(follower.y[0] - HWY_LANE_Y["right"]) <= 1.0,
                    f"follower y={follower.y[0]:.2f} vs lane "
                    f"{HWY_LANE_Y['right']}"))
        # The corridor runs west, so 'ahead' is smaller x.
        out.append(("the subject cut in AHEAD of the follower",
                    subj.x[-1] < follower.x[-1],
                    f"subject ended x={subj.x[-1]:.1f}, follower x="
                    f"{follower.x[-1]:.1f} (west is decreasing x)"))
        dist, _ = A.closest_approach(run, "adversary", "adversary1")
        out.append(("the two never collide with each other", dist > 2.0,
                    f"closest {dist:.2f} m"))
    return out


def expect_bench_truck_invades_lane(run, timeline):
    out = []
    truck = run.get("adversary")
    out.append(("truck appears in telemetry", truck is not None,
                f"roles seen: {sorted(run.tracks)}"))
    if truck is not None:
        # The blueprint check matters as much as the manoeuvre: xml_builder
        # falls back to `car` for any lookup it cannot resolve, and a Lincoln
        # MKZ drifting into the lane would pass every other line here.
        out.append(("resolved to a truck blueprint, not the car default",
                    "carlamotors" in truck.type_id or "truck" in truck.type_id
                    or "tt" in truck.type_id,
                    truck.type_id))
    ok, detail = _chain_order(
        timeline, ["SpeedEvent0", "LaneChangeEvent1", "SpeedEvent2"])
    out.append(("cruise -> drift left -> resume runs in order", ok, detail))
    ended = timeline.get(_name_of(timeline, "LaneChangeEvent1"), {}).get("end")
    out.append(("the lane invasion completes", ended is not None,
                f"LaneChangeEvent1 END at t={ended}s" if ended is not None else
                "went RUNNING but never reached END — a 10 m vehicle needs more "
                "room to complete a change than a car does"))
    out.append(_merged_into(run, "adversary", HWY_LANE_Y["mid"], 12.0,
                            "the ego's lane"))
    ok, detail = A.slows_by(run, "hero", 2.5, 1.0, 20.0)
    out.append(("EGO REACTS: sheds speed for the truck entering its lane",
                ok, detail))
    return out


def expect_bench_unprotected_left_turn(run, timeline):
    out = []
    ok, detail = A.reaches_speed(run, "adversary", 8.0, 0.5, 8.0, tol=2.0)
    out.append(("oncoming vehicle drives at the commanded 8 m/s", ok, detail))
    ok, detail = A.reaches_speed(run, "adversary1", 6.0, 0.5, 8.0, tol=2.0)
    out.append(("right-arm vehicle drives at the commanded 6 m/s", ok, detail))
    # Both adversaries must actually reach the junction, or there is no conflict
    # to yield to and the case degenerates into 'the ego turned left'.
    for role, who in (("adversary", "oncoming vehicle"),
                      ("adversary1", "right-arm vehicle")):
        t_in = A.time_within(run, role, JCT_CENTRE, 18.0)
        out.append((f"{who} reaches the junction", t_in is not None,
                    f"within 18 m of {JCT_CENTRE} at t={t_in}s"
                    if t_in is not None else "never reached the junction"))
    # The claim the goal is making. Left is negative in CARLA's frame.
    out.extend(_ego_took_the_turn(run, -90.0))
    hero = run.get("hero")
    if hero is not None:
        # Corroborates the heading: the left arm runs south, so the ego has to
        # end up well below the y=94.9 it started on.
        out.append(("ego ends up on the left arm (south of the junction)",
                    hero.y[-1] < 88.0,
                    f"ego ended ({hero.x[-1]:.1f},{hero.y[-1]:.1f}), started "
                    f"({hero.x[0]:.1f},{hero.y[0]:.1f})"))
    return out


def expect_bench_truck_runs_red_light(run, timeline):
    out = []
    truck = run.get("adversary")
    out.append(("truck appears in telemetry", truck is not None,
                f"roles seen: {sorted(run.tracks)}"))
    if truck is not None:
        out.append(("resolved to a truck blueprint, not the car default",
                    "carlamotors" in truck.type_id or "truck" in truck.type_id
                    or "tt" in truck.type_id, truck.type_id))
    ok, detail = A.reaches_speed(run, "adversary", 11.0, 0.5, 8.0, tol=2.0)
    out.append(("truck speeds through at the commanded 11 m/s", ok, detail))
    # 'Runs a red light' reduces to 'enters the junction without stopping'.
    # There is no signal state to read here — the assertion is that the truck
    # never gave way, which an actor that obeyed a light could not satisfy.
    t_in = A.time_within(run, "adversary", JCT_CENTRE, 18.0)
    out.append(("truck enters the junction", t_in is not None,
                f"within 18 m of {JCT_CENTRE} at t={t_in}s" if t_in is not None
                else "never reached the junction"))
    # 'Runs the light' = crosses at full speed without checking. Measured as a
    # plateau across the junction rather than as "never stopped": the truck IS
    # stationary before its distance_to_ego trigger fires, and a whole-run
    # minimum would score that wait as a stop at the line. The window starts
    # after the trigger and covers the crossing (junction entry ~t=3.9s).
    ok, detail = A.holds_speed(run, "adversary", 11.0, 3.0, 10.0, tol=2.0)
    out.append(("TRUCK CROSSES AT FULL SPEED WITHOUT SLOWING, i.e. it runs "
                "the light", ok, detail))
    dist, when = A.closest_approach(run, "hero", "adversary")
    out.append(("the truck and the turning ego really meet at the junction",
                dist is not None and dist < 30.0,
                f"closest approach {dist:.1f} m at t={when:+.1f}s"
                if dist is not None else "no data"))
    out.extend(_ego_took_the_turn(run, -90.0))
    return out


def expect_bench_blocked_intersection(run, timeline):
    out = []
    ok, detail, _ = _fired(timeline, "SpeedEvent0")
    out.append(("the crawling vehicle's event fires", ok, detail))
    crawl, still = run.get("adversary"), run.get("adversary1")
    if crawl is not None:
        out.append(("the vehicle ahead is slow-moving, not stopped",
                    0.5 < crawl.distance_travelled() < 20.0,
                    f"travelled {crawl.distance_travelled():.1f} m in the run"))
    if still is not None:
        out.append(("the vehicle beside it never moves",
                    still.distance_travelled() < 2.0,
                    f"travelled {still.distance_travelled():.1f} m"))
    # The description's own success criterion, and the one case where the ego's
    # required behaviour is what BehaviorAgent does anyway.
    ok, detail = A.stopped_within(run, "hero", 3.0, 20.0, threshold=0.5)
    out.append(("EGO IS FORCED TO REMAIN STATIONARY", ok, detail))
    hero = run.get("hero")
    if hero is not None:
        # It must be stopped BEHIND the blockage, not past it: the queue sits at
        # x=-145 and the ego approaches from x=-172 heading east.
        out.append(("ego is held short of the blockage", hero.x[-1] < -143.0,
                    f"ego ended x={hero.x[-1]:.1f}, queue at x={JCT_AHEAD[0]}"))
        out.append(("ego never reaches the junction it was aimed at",
                    A.time_within(run, "hero", JCT_CENTRE, 12.0) is None,
                    "the bottleneck did block the forward path"))
    return out


def expect_bench_pedestrian_crossing(run, timeline):
    out = []
    ok, detail, t = _fired(timeline, "SpeedEvent0")
    out.append(("walker's speed event fires", ok, detail))
    if t is not None:
        out.append(("the 50 m trigger waits for the ego to close in", t > 0.3,
                    f"fired at t={t:.2f}s"))
    walker = run.get("adversary")
    if walker is not None:
        out.append(("adult pedestrian blueprint", walker.type_id.startswith("walker."),
                    walker.type_id))
        ok, detail = A.reaches_speed(run, "adversary", 2.0, 0.0, 14.0, tol=1.0)
        out.append(("walks at the commanded 2 m/s", ok, detail))
        # The nearside->crossing geometry, reusing the road-1 cross-section.
        out.extend(_crossed_the_road(run))
    # EXPECTED TO FAIL, and the finding is about the TEMPLATE, not this case.
    # `pedestrian-crossing` triggers at distance_to_ego@50 and walks at 2 m/s.
    # The ego covers that 50 m in ~6.6 s at its 7.6 m/s Town01 cruise, while the
    # walker needs only ~1-3 s to reach the carriageway and ~4 s to clear it —
    # so it is off the far kerb roughly 3.5 s BEFORE the ego arrives, every
    # time. Measured: the walker crossed cleanly, the ego never dropped below
    # 7.07 m/s and passed 8.4 m behind it. The shipped template therefore cannot
    # produce the conflict its name implies at Town01 speeds; it needs either a
    # shorter trigger radius (~20 m) or a slower walker.
    ok, detail = A.slows_by(run, "hero", 2.0, 1.0, 20.0)
    out.append(("EXPECTED TO FAIL — ego yields to the crossing pedestrian",
                ok, detail))
    dist, when = A.closest_approach(run, "hero", "adversary")
    out.append(("EXPECTED TO FAIL — the walker is still in the road when the "
                "ego arrives", dist is not None and dist < 4.0,
                f"closest approach {dist:.1f} m at t={when:+.1f}s — the "
                f"template's 50 m trigger sets the walker off far too early"
                if dist is not None else "no data"))
    return out


def expect_bench_child_from_behind_van(run, timeline):
    out = []
    kid, van = run.get("adversary"), run.get("adversary1")
    out.append(("child appears in telemetry", kid is not None,
                f"roles seen: {sorted(run.tracks)}"))
    if kid is not None:
        out.append(("child is a walker, and the child model not the adult one",
                    kid.type_id.startswith("walker.")
                    and kid.type_id != "walker.pedestrian.0001", kid.type_id))
        ok, detail = A.reaches_speed(run, "adversary", 2.5, 0.0, 14.0, tol=1.0)
        out.append(("child runs at the commanded 2.5 m/s", ok, detail))
        out.extend(_crossed_the_road(run))
    if van is not None:
        # vehicle_catalog.yaml maps van -> vehicle.mercedes.sprinter. Spelled
        # out rather than pattern-matched, for the reason the actor-type suite
        # gives: comparing the exporter against its own configuration passes no
        # matter what either of them says.
        out.append(("the occluding van is the catalogue's van, not a Lincoln",
                    van.type_id == "vehicle.mercedes.sprinter", van.type_id))
        out.append(("the van never moves", van.distance_travelled() < 2.0,
                    f"travelled {van.distance_travelled():.1f} m"))
        # The occlusion only works if the van is BETWEEN the ego and the child
        # along the road. Road 1 runs east-west and the ego drives west, so the
        # van has to sit at a larger x than the child.
        if kid is not None:
            out.append(("the van sits between the ego and the child",
                        van.x[0] > kid.x[0],
                        f"van x={van.x[0]:.1f}, child x={kid.x[0]:.1f}, "
                        f"ego starts at x={EGO['x']:.1f} heading west"))
    return out


def expect_bench_school_bus_opposing_lane(run, timeline):
    out = []
    bus = run.get("adversary")
    out.append(("bus appears in telemetry", bus is not None,
                f"roles seen: {sorted(run.tracks)}"))
    if bus is not None:
        # A bus that silently exported as a car is the failure this guards: the
        # scenario reads correctly and the vehicle is 5 m long instead of 10.
        # vehicle_catalog.yaml maps bus -> vehicle.volkswagen.t2. See the
        # coverage report: the T2 is a 4.5 m microbus, so the HeavyVehicle tag
        # is served by something a good deal smaller than a school bus.
        out.append(("resolved to the catalogue's bus, not the car default",
                    bus.type_id == "vehicle.volkswagen.t2", bus.type_id))
        out.append(("the bus is stopped, as the description requires",
                    bus.distance_travelled() < 2.0,
                    f"travelled {bus.distance_travelled():.1f} m"))
        # The tag is about the opposing lane specifically: a bus in the ego's
        # own lane is a different scenario entirely.
        out.append(("the bus is in the OPPOSING lane, not the ego's",
                    bus.y[0] > 0.0,
                    f"bus y={bus.y[0]:.2f}; ego lane spans -4.04..-0.03, "
                    f"oncoming +1 is centred at {ONCOMING_LANE[1]}"))
    hero = run.get("hero")
    if hero is not None:
        # Passing a 10 m vehicle in the oncoming lane without being deflected is
        # the observable half of 'detect and respond'.
        out.append(("ego passes it without leaving its own lane",
                    max(abs(y + 2.0) for y in hero.y) < 2.5,
                    f"ego y range {min(hero.y):.2f}..{max(hero.y):.2f}, "
                    f"lane centre -2.0"))
    return out


def expect_bench_reversing_vehicle(run, timeline):
    """EXPECTED TO FAIL — there is no reverse in the vocabulary.

    The measurement is the deliverable: given waypoints laid behind it, the
    actor turns around and drives forward. That is SimpleVehicleControl building
    a forward plan through the waypoints, and it is why 'reverse' needs a new
    action rather than a clever arrangement of the existing ones.
    """
    out = []
    ok, detail, _ = _fired(timeline, "Trajectory")
    if not ok:
        ok, detail, _ = _fired(timeline, "Event")
    out.append(("the trajectory event fires", ok, detail))
    car = run.get("adversary")
    if car is None:
        return out + [("car appears in telemetry", False,
                       f"roles seen: {sorted(run.tracks)}")]
    out.append(("the car moves at all", car.distance_travelled() > 3.0,
                f"travelled {car.distance_travelled():.1f} m"))
    # Reversing means going BACKWARDS relative to the heading the car SPAWNED
    # with, while keeping that heading. Both halves are measured against
    # track.yaw[0] rather than through A.lateral_offset/heading_change, whose
    # windows start at act start — by which point this car has already begun
    # swinging round, and a reference frame taken mid-turn measures nothing.
    h0 = math.radians(car.yaw[0])
    dx, dy = car.x[-1] - car.x[0], car.y[-1] - car.y[0]
    longitudinal = dx * math.cos(h0) + dy * math.sin(h0)
    swing = max(abs((y - car.yaw[0] + 180) % 360 - 180) for y in car.yaw)
    out.append(("EXPECTED TO FAIL — the car keeps its spawn heading throughout",
                swing < 30.0,
                f"spawned at yaw {car.yaw[0]:.1f} deg and swung {swing:.0f} deg "
                f"away from it — SimpleVehicleControl builds a FORWARD plan "
                f"through the waypoints, so it turns round rather than reversing"))
    # This one PASSES, and on its own it would be a false green: the car does
    # end up behind where it started — by turning round and driving there. It is
    # here as the necessary half of the pair, so that the failing heading check
    # above is read as "it got there the wrong way" rather than "it did not
    # move". Never assert displacement alone for a reverse.
    out.append(("net travel is backwards along the spawn axis (necessary, "
                "not sufficient — see the heading check above)",
                longitudinal < -3.0,
                f"net {longitudinal:+.1f} m along its spawn heading over "
                f"{car.distance_travelled():.1f} m driven"))
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

    "bench-hard-brake-lead": expect_bench_hard_brake_lead,
    "bench-highway-cut-in": expect_bench_highway_cut_in,
    "bench-lane-blocked-construction": expect_bench_lane_blocked_construction,
    "bench-perpendicular-crossing": expect_bench_perpendicular_crossing,
    "bench-double-cut-in": expect_bench_double_cut_in,
    "bench-lead-cuts-out-onto-stopped": expect_bench_lead_cuts_out_onto_stopped,
    "bench-parallel-lane-traffic": expect_bench_parallel_lane_traffic,
    "bench-lane-change-right-follower": expect_bench_lane_change_right_follower,
    "bench-truck-invades-lane": expect_bench_truck_invades_lane,
    "bench-unprotected-left-turn": expect_bench_unprotected_left_turn,
    "bench-truck-runs-red-light": expect_bench_truck_runs_red_light,
    "bench-blocked-intersection": expect_bench_blocked_intersection,
    "bench-pedestrian-crossing": expect_bench_pedestrian_crossing,
    "bench-child-from-behind-van": expect_bench_child_from_behind_van,
    "bench-school-bus-opposing-lane": expect_bench_school_bus_opposing_lane,
    "bench-reversing-vehicle": expect_bench_reversing_vehicle,
}
