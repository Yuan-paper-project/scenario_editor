# Loop2Scenic coverage

**Stale as of the ego-controller change, not yet re-derived.** This report's
entire premise for **ego-manoeuvre authoring** — *"the `.xosc` gives the ego a
spawn pose only"*, cited below as the reason 36 taxonomy-tag assignments
(9 of 11 unreachable tags, per the rollup in §4) are unreachable — no longer
holds. The ego now takes `follow_trajectory`/`assign_route`/`set_speed`/
`lane_change` events exactly like an NPC, and gets its own `heroBehavior` Act in
the export. Every row below tagged with that capability, the §4 rollup
percentages, and the `bench-*` CARLA cases themselves (deliberately deferred,
separate work) need re-checking against what can actually be authored now
before this file's conclusions can be trusted. `LaneOffsetAction` (the other
named gap) is unaffected and remains genuinely missing.

What this editor can and cannot build, measured against the
[Loop2Scenic benchmark](https://yuangao-tum.github.io/loop2scenic-bench/) — 250
scenario descriptions across five query modalities, tagged with a 50-type
Bench2Drive-derived taxonomy.

Sixteen benchmark entries were selected, rebuilt as runnable CARLA cases in
`tests/carla_cases.py`, and judged against ScenarioRunner's OSC log **and** the
telemetry CSV. **168 of 174 checks passed; the six failures are all marked
EXPECTED TO FAIL** and are the point of the exercise.

```bash
bash run.sh 9090                                              # terminal 1
.venv/bin/python3 tests/run_carla_cases.py bench-hard-brake-lead
```

## 1. Provenance

`benchmark_index.{json,csv}` and `tag_census.csv` are produced by
`extract_bench.py` from the datasheet page:

```bash
curl -sL -o bench.html https://yuangao-tum.github.io/loop2scenic-bench/
python3 tests/bench/extract_bench.py bench.html tests/bench
```

Fetched 2026-08-02; the page is byte-identical (md5 `3109f7c3…`) to a re-fetch
the same day. It is ~10 MB and inlines all 250 §9 cards, base64 media included,
so no JS, headless browser or `benchmark_drive/` download is needed. **Fetch it
raw** — a summarising fetcher truncates after §1 and the datasheet then looks
unavailable.

Extractor output, verified:

```
250 scenarios; splits {'text-only': 50, 'text-image': 50, 'image-only': 50,
                       'text-video': 50, 'video-only': 50}
47 distinct types over 315 assignments (§9 cards)
recovered from data-search: 100
no description at all: []
```

**Only 150 cards carry a visible `<p class="gdesc">`** — the three text-bearing
splits. The 100 image-only / video-only cards render media and nothing else;
their text survives only inside the card's `data-search` attribute, lowercased
with the source name and tag list appended. Those rows are flagged
`desc_source="data-search"`; treat them as the benchmark's own annotation of the
media, not a verbatim prompt. Six of the sixteen cases below use such a row and
say so in a `note_source` field.

### The §4 / §9 discrepancy

The datasheet contains two censuses of the same taxonomy and they disagree.
`tag_census.csv` puts them side by side:

| | types | assignments |
|---|---|---|
| §4's ranked table | 50 | 301 |
| the §9 card tags | 47 | 315 |

- **Five §4 types appear on no card**: `FollowLeadVehicle`,
  `ParallelEntryCrossingPaths`, `UnintentionalLaneDrift`, `ControlLoss`,
  `ExitTrafficArea`.
- **Two card tags are absent from §4**: `SignalizedJunctionLeftTurnEnterFlow`,
  `MergerIntoSlowTraffic`.
- **36 types are counted differently**, several wildly:
  `EmergencyObstacleAvoidance` 24→4, `PedestrianCrossing` 19→5, `HardBrake`
  9→20, `NonSignalizedJunctionRightTurn` 1→12, `InvadingTurn` 1→10.
- 16 cards carry the literal tag `unlabelled`, which is a card outside the
  taxonomy rather than a 51st type.

**Selection here follows the card tags** — they are attached to the description
actually being reproduced. **The rollup in §4 below is weighted by the §4
totals**, since that table is the taxonomy's own statement of what the benchmark
is made of. Both numbers are reported wherever they differ materially.

## 2. Selection

Criteria: span all five splits; span the widest set of distinct type tags,
weighted toward the head of §4's ranked list and toward tags the editor can
express; and deliberately include cases the editor **cannot** fully express.

16 cases → 5 splits (4/2/3/3/4) → 18 distinct type tags.

| bench id | split | tags | editor mechanism | fidelity |
|---|---|---|---|---|
| `CARLA_Leaderboard_18` | text-only | HardBrake | lead car, `set_speed` 6 → step 0 in the ego's lane | **full** |
| `CARLA_Leaderboard_8` | text-only | HighwayCutIn | `assign_route` down Town04's loop on-ramp into the ego's lane, released by a `distance_to_point` on the ego | **full** (ego's brake is BehaviorAgent's, asserted) |
| `CARLA_Leaderboard_12` | text-only | ParkedObstacle, Construction, Accident | 5 `static.prop.*` across the lane + traffic in the neighbour lane | **gap** — the ego's "must perform a lane change to avoid it" has no expression |
| `NHTSA_PreCrash_12` | text-only | ReversingManeuver | `follow_trajectory` with waypoints laid behind the actor | **gap** — no reverse action exists |
| `r7_town05_ins_ss` | text-image | PerpendicularCrossingConflict | cross-street car on `distance_to_ego@45`; ego straight via goal | **full** (ego straight is goal-induced, asserted) |
| `r2_town05_ins_c` | text-image | ParallelLaneTraffic | neighbour holding 7.5 m/s one lane over | **full** |
| `CPNCO_RunningChildFromNearSide` | image-only | DynamicObjectCrossing, ParkingCrossingPedestrian | `child` crossing from behind a parked `van` | **full** (near miss instead of impact) |
| `DetectAndRespondToSchoolBus` | image-only | HeavyVehicle | stopped `bus` in the opposing lane of Town01 road 1 | **partial** — no school-bus blueprint, no lights/signs |
| `lc_r_2` | image-only | LaneChange | NPC `lane_change` right with a follower already in the target lane | **partial** — the catalogue makes the *ego* change lane; given to an NPC |
| `CPNA_25_50kph` | text-video | DynamicObjectCrossing | the real `pedestrian-crossing` template on Town01 | **gap** — the template's 50 m / 2 m/s cannot produce a conflict |
| `MD_Unprotected_Left_Turn8` | text-video | SignalizedJunctionLeftTurn, NonSignalizedJunctionLeftTurn | oncoming + right-arm cars; ego left turn via goal | **partial** — turn is planner-chosen; 1 right-arm car not 3; pedestrian omitted |
| `moving_rain_sudden_cut_out` | text-video | HardBrake | lead slows, cuts right, revealing a stopped car | **partial** — rain not modelled; ego's "veer right" not authorable |
| `lateral_double_cut_in_highway` | video-only | HardBrake, StaticCutIn | two cars converging on the ego's lane on one shared trigger | **partial** — "highway split" is a straight 3-lane carriageway |
| `lateral_ego_overtake_truck_invade` | video-only | LaneChange, InvadingTurn, HeavyVehicle | `truck` drifting left into the ego's lane | **partial** — the ego's overtake is not authorable, so the truck comes to it |
| `turning_truck_runredlight` | video-only | SignalizedJunctionLeftTurn, OppositeVehicleRunningRedLight, HeavyVehicle | `truck` crossing at 11 m/s; ego left turn via goal | **partial** — red-light running is *free*, not authored (see §3) |
| `BLO_3` | video-only | BlockedIntersection | one crawling + one stationary car blocking both lanes | **full** |

## 3. Per-case results

From `tests/run_carla_cases.py <all sixteen>`. Artifacts (reloadable
`scenario.json`, `telemetry.csv`, `run.log`, the exact `.xosc`) are in
`tests/artifacts/bench-*/`.

| case | checks | what it asserted beyond "the event ran" | fidelity gap |
|---|---|---|---|
| `bench-hard-brake-lead` | **8/8** | lead holds 6 m/s then plateaus at 0 within 0.6 m/s; ego brakes to a stop behind it | the obstacle the lead brakes *for* is not modelled |
| `bench-highway-cut-in` | **15/15** | waits on the ramp at 0 m/s until the **ego's own** proximity to the cue point releases it (event t=7.35 s vs the ego arriving t=6.55 s); sets off at the ego's 7.53 m/s; descends 38.5 m of ramp into lane 6 (y=37.44); its **own** proximity to the merge point fires the 10 m/s pull-away; merges 20.9 m in front; ego brakes 7.60 → 0.00 m/s at a 10.3 m closest approach | ego's brake is planner-chosen |
| `bench-lane-blocked-construction` | 15/18 | all 5 props spawn within 1.5 m of where they were placed, at z 0.72–2.71 up the gradient | **3 EXPECTED TO FAIL** — see below |
| `bench-perpendicular-crossing` | **11/11** | crossing car's path is perpendicular (dy −98 m vs dx −0.8 m); ego net heading +0.1°; closest approach 21 m | ego's straight-through is planner-chosen |
| `bench-double-cut-in` | **11/11** | both lane changes start at t=3.12 s; both end in the ego's lane; ego sheds 5.67 m/s | night/low-visibility dropped |
| `bench-lead-cuts-out-onto-stopped` | **11/11** | 4-link chain in order; lead ends in lane -3; revealed car travels 0.0 m; ego stops | rain dropped; ego's swerve not authorable |
| `bench-parallel-lane-traffic` | **9/9** | holds 7.5 m/s 100% of samples; stays 3.4 m over and within 30 m along | none |
| `bench-lane-change-right-follower` | **12/12** | `right` gives −3.47 m (the actor's own right); subject ends ahead of the follower in the target lane | the manoeuvre belongs to the ego in the source |
| `bench-truck-invades-lane` | **10/10** | `vehicle.carlamotors.carlacola`, not the Lincoln default; invasion completes; ego sheds speed | ego's overtake not authorable |
| `bench-unprotected-left-turn` | **11/11** | **ego net heading −85.3°** and ends at (−120.4, 48.0) on the south arm; both adversaries reach the junction; closest approach 2.35 m | 1 right-arm car; no crossing pedestrian |
| `bench-truck-runs-red-light` | **11/11** | truck holds 11 m/s across the junction; ego turns −85.4°; they meet 9.0 m apart | see the red-light note below |
| `bench-blocked-intersection` | **11/11** | ego held stationary, stopped short of the queue, **never reaches the junction it was aimed at** | none |
| `bench-pedestrian-crossing` | 10/12 | walker crosses (dy +14.2 m) and clears the ego's lane | **2 EXPECTED TO FAIL** — see below |
| `bench-child-from-behind-van` | **13/13** | `walker.pedestrian.0011` (child model); `vehicle.mercedes.sprinter` stationary and *between* the ego and the child | "running" is a 2.5 m/s walk |
| `bench-school-bus-opposing-lane` | **9/9** | `vehicle.volkswagen.t2`; stopped; in the opposing lane; ego passes without leaving its own | no school bus, no lights/signs |
| `bench-reversing-vehicle` | 7/8 | the car travels 27 m backwards along its spawn axis — by swinging 179° | **1 EXPECTED TO FAIL** — see below |

### The six expected failures

**`bench-lane-blocked-construction` (3).** The scene builds perfectly: five
props reach CARLA as `<MiscObject>`s within 1.5 m of where they were clicked,
with `miscObjectCategory="barrier"` on the street barrier and `"obstacle"` on
everything else, and z following the corridor's gradient from 0.72 m to 2.71 m.
What fails is everything on the ego's side. BehaviorAgent **does not see props
at all**: it holds its lane at 6.2 m/s and drives straight through the site,
dragging the barrier 69 m down the road. It neither steers nor brakes.
*Fix:* ego-manoeuvre authoring — a `hero` ManeuverGroup in
`../llm-scenario-gen/templates/car.xosc` plus an ego event editor. Changes both
repos.

**`bench-pedestrian-crossing` (2).** This one is a defect in the **shipped
template**, not in the case. `pedestrian-crossing` fires at
`distance_to_ego@50` and walks at 2 m/s. The ego covers that 50 m in ~6.6 s at
its 7.6 m/s Town01 cruise, while the walker needs ~1–3 s to reach the
carriageway and ~4 s to clear it — so it is off the far kerb roughly 3.5 s
*before* the ego arrives, every single run. Measured: the walker crossed
cleanly, the ego never dropped below 7.18 m/s, closest approach 8.4 m. The
template cannot produce the conflict its name implies at Town01 speeds.
*Fix:* shorten the trigger radius to ~20 m or slow the walker, in
`frontend/js/templates.js`. Editor repo only.

**`bench-reversing-vehicle` (1).** There is no reverse in the vocabulary. The
five actions are `follow_trajectory`, `assign_route`, `set_speed`,
`set_distance` and `lane_change`; `_normalize_structured_event` clamps
`set_speed` at 0, and neither `SimpleVehicleControl` nor the OpenSCENARIO
`SpeedAction` the exporter emits carries a gear or a sign. The case builds the
closest available thing — waypoints laid behind the actor — and measures the
result: the car swings **179°** and drives forward. Note that its *displacement*
check passes (−26.9 m along the spawn axis): displacement alone is a false green
for a reverse, and the paired heading check is what catches it.
*Fix:* a new action in all three layers (`eventPanel.js`,
`_normalize_structured_event`, `event_builders.py`) plus a controller that
honours it.

### The red-light note

`turning_truck_runredlight` needs an NPC to disobey a signal. It turns out that
needs no expression at all: **an NPC on `simple_vehicle_control` ignores traffic
lights entirely**. The editor can force a signal state (`AppState.trafficSignals`
→ `TrafficSignalStateAction`, emitted by `_inject_traffic_signals`) but has no
way to make an actor obey or disobey one. So red-light running is free, and
**light-abiding NPC traffic is impossible** — which is the more restrictive half
and matters for every `Signalized*` tag. That is a gap in ScenarioRunner's NPC
controller, not in the editor.

## 4. Rollup by taxonomy tag

Weighted by §4's totals (301 assignments) so the summary reflects benchmark
mass rather than tag count; card totals (315) shown alongside.

| bucket | §4 mass | card mass | types |
|---|---|---|---|
| **covered** — a `bench-*` case demonstrates it end to end in CARLA | 71 (23.6%) | 97 (30.8%) | 9 |
| **partial** — the scene is expressible, one named clause is not | 90 (29.9%) | 93 (29.5%) | 14 |
| **expressible, not built** — the mechanism is proven by a sibling case | 78 (25.9%) | 89 (28.3%) | 18 |
| **not expressible** — a capability is missing | 62 (20.6%) | 36 (11.4%) | 11 |

**Covered** (9): HardBrake, StaticCutIn, HighwayCutIn,
PerpendicularCrossingConflict, ParallelLaneTraffic, InvadingTurn, HeavyVehicle,
BlockedIntersection, ParkingCrossingPedestrian.

**Partial** (14): LaneChange, MergerIntoSlowTrafficV2, MergerIntoSlowTraffic,
ParkedObstacle, Construction, Accident, and the three `*TwoWays` variants,
SignalizedJunctionLeftTurn, NonSignalizedJunctionLeftTurn,
OppositeVehicleRunningRedLight, DynamicObjectCrossing, PedestrianCrossing. Two
recurring deltas account for all of them:

- *the ego manoeuvre is planner-chosen, never authored* — every junction turn,
  and the `MD_Highway_On-Ramp_Merge*` cards, where it is the EGO that comes up
  the ramp and yields;
- *the obstacle scene builds but the avoidance does not* — every obstacle tag.

The third delta this table used to carry — *no on-ramp corridor characterised* —
is closed: `bench-highway-cut-in` runs on Town04 road 44 → connector 1194 →
road 39 lane 6, a real loop ramp feeding the ego's own lane, and the NPC half of
`r45_town06_hw_merge` is the same shape one lead car away.

**Expressible but not built** (18): AdversaryCutOut, HazardAvoidanceCutIn,
JunctionEntryCutIn, TJunction, ParallelEntryCrossingPaths,
OppositeVehicleTakingPriority, OncomingLeftTurnAcrossPath, FollowLeadVehicle,
VinillaNonSignalizedTurn(+Stopsign), Signalized/NonSignalizedJunctionRightTurn,
the two `*LeftTurnEnterFlow` variants, VehicleTurningRoute(+Pedestrian),
RoundaboutNavigation, HazardAtSideLaneTwoWays. Each reduces to a shape already
demonstrated: a cut-in (`bench-highway-cut-in`), a junction conflict
(`bench-perpendicular-crossing`), a lead car (`bench-hard-brake-lead`), or a
`set_distance` gap follower. Adding them is case-writing, not capability work.

**Not expressible** (11) — with the missing capability and the repo it belongs
in:

| tag | §4 | cards | missing capability | repo |
|---|---:|---:|---|---|
| EmergencyObstacleAvoidance | 24 | 4 | **ego-manoeuvre authoring**: the `.xosc` gives the ego a spawn pose only, and BehaviorAgent will not swerve. Needs a `hero` ManeuverGroup + an ego event editor | both |
| UTurn | 9 | 8 | ego-manoeuvre authoring (BehaviorAgent keeps its lane and will not reverse direction). NPC U-turns *are* possible via `follow_trajectory` | both |
| OvertakingIntoOncomingLane | 6 | 6 | a lateral action that can cross the centreline. `LaneChangeAction` → `ChangeActorLateralMotion` only targets a **same-direction** neighbour; needs `LaneOffsetAction` | llm-scenario-gen |
| ReversingManeuver | 5 | 4 | a reverse action + a controller that honours it | both |
| UnintentionalLaneDrift | 4 | 0 | continuous lateral offset; `LaneChangeAction` is discrete lane-to-lane. `LaneOffsetAction` again | llm-scenario-gen |
| HazardAtSideLane | 4 | 6 | same: an actor *partially* overlapping a lane needs a continuous offset | llm-scenario-gen |
| ParkingExit | 3 | 5 | same root cause as the existing `tpl-pull-out` EXPECTED-TO-FAIL: a bay has no same-direction neighbour lane, so `LaneChangeAction` can never complete | llm-scenario-gen |
| AnimalOnRoad | 3 | 2 | an animal actor type. Unknown actor ids are a hard 400, so this cannot be faked | both |
| ControlLoss | 2 | 0 | an action that perturbs an actor's control (steer/throttle noise) | both |
| HighwayExit | 1 | 1 | ego-manoeuvre authoring — leaving the carriageway is a planner decision | both |
| ExitTrafficArea | 1 | 0 | ego-manoeuvre authoring | both |

Two capabilities account for **9 of the 11** and for 51 of the 62 §4
assignments: **ego-manoeuvre authoring** (36) and **`LaneOffsetAction`** (17).
Neither is a large change, and between them they would move roughly a fifth of
the benchmark from "not expressible" into reach.

## 5. Smaller findings worth keeping

- **An NPC with `events: []` gets no Act and stays put.** It holds its
  `initial_speed` (0 when omitted) for the whole run. This reverses the older
  behaviour, where `xml_builder` fell back to a `constant_speed` chain and a
  "parked" car covered 226 m. Every stationary actor here still uses an explicit
  `set_speed 0` (`_parked()` in `carla_cases.py`), which also states the intent.
- **Distance radii need margin for the corner a turning ego cuts.** A
  `distance_to_ego@35` trigger on the cross street missed by 0.6 m — the ego
  begins its left swing at (−134, 89) rather than running to the junction
  centre, so its closest approach was 35.6 m. The condition never fired, the
  truck waited out the 60 s `TimeFallback` every `distance_to_ego` trigger
  carries, and the run limped to 77 s with the truck crossing an empty junction.
- **A cross-street actor launched at act start clears the junction before the
  ego arrives.** Measured: crossing car in at t=1.0 s, ego at t=5.9 s. Both
  crossing cases now launch on `distance_to_ego` and assert closest approach, so
  "the paths conflict in *time*" is checked rather than assumed.
- **`bus` is `vehicle.volkswagen.t2`**, a ~4.5 m microbus. The HeavyVehicle tag
  is therefore served by something considerably smaller than the coaches and
  school buses the descriptions picture. `truck` →
  `vehicle.carlamotors.carlacola` is a fair cargo truck.
- **Town01's sidewalk is not spawnable.** A car placed at y=−7 aborts the whole
  scenario with `Not all actors were spawned / Error: Unable to add actors`
  before a single tick — and road 1's shoulder is only 0.3 m wide, so there is
  nowhere off the carriageway to park a vehicle except the kerb band the
  `bench-child-from-behind-van` van uses.
- **Props are pushed around.** `run.sh` lets the ego drive, and it shoves what
  it hits; read prop transforms immediately after spawn, or the measurement is
  where physics left them. The `bench-lane-blocked-construction` expectation
  asserts against the *first* telemetry sample for this reason.

## 6. Regression status

Everything else still passes, run alongside this work:

| suite | result |
|---|---|
| `test_normalization.py` | 57/57 |
| `test_props_e2e.py` | 54/54 |
| `test_prop_yaw_e2e.py` | 23/23 |
| `test_templates_e2e.py` | 149/149 |
| `test_events_e2e.py` | 36/37 + 1 documented `KNOWN` defect |
| `test_actor_types_e2e.py` | 272/272 |
| `test_elevation_e2e.py` | 33/33 |
| the 12 pre-existing CARLA cases | 10 pass; `tpl-pull-out` and `tpl-cyclist-crossing` fail as documented |

One pre-existing wobble, **not** introduced here: `tpl-stopping`'s middle
profile segment (`[6-7s] → 5 m/s`) holds for only ~59% of its samples against a
60% bar. Reproduced identically with `tests/` stashed back to `HEAD`, so it is
the case's 1.3 s window being too tight for the controller's ramp, not a
harness change.
