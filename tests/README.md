# tests/

Coverage for static props, the event model (ego and NPC alike), the scenario
templates, the actor catalogue, and road-surface elevation. Most of
it drives a **real browser against a real running editor and a real export**,
which is the only way to catch the failure modes these features actually have
(SVG hit-testing, lane-direction maths, and the `.xosc` the backend emits).

Four layers, cheapest first. They fail at different places on purpose, so which
one goes red tells you where the problem is:

| Layer | Needs | Catches | Cannot catch |
|---|---|---|---|
| `test_normalization.py` | nothing | backend coercions, clamps, entity-ref mapping | anything about the UI or the emitted XML |
| `test_*_e2e.py` | editor on :9090 | UI wiring, the payload the frontend sends, the `.xosc` structure | whether CARLA honours the file |
| `run_carla_cases.py` | CARLA on :3000 | whether triggers fire and actors actually move | anything it has no assertion for |
| `probe_*.py` | CARLA on :3000 | measurements, not assertions | — |

## Running

```bash
bash run.sh 9090                 # terminal 1: the editor
bash tests/run_tests.sh          # terminal 2: everything except CARLA
```

First run only:

```bash
.venv/bin/python3 -m pip install playwright
.venv/bin/python3 -m playwright install chromium
```

`EDITOR_URL` overrides the target (the VS Code debugger config serves on `:8000`,
not `:9090`).

**Restart the editor before running if you changed `../llm-scenario-gen`.**
`xml_builder` reads `prop_catalog.yaml` once at import and `--reload` does not
watch that repo, so the frontend will show new catalogue data while the backend
still exports the old — which reads as a test bug but is not one.

## What is covered

| File | Checks | Covers |
|---|---|---|
| `test_props_e2e.py` | 54 | catalogue contents, toolbar tabs, sticky placement, Shift lane-snap, selection/properties, prop-type swap, drag without panning, save/load round-trip, `.xosc` export incl. `MiscObject` categories and `yaw_offset`, 400 on unknown/removed ids |
| `test_prop_yaw_e2e.py` | 23 | per-prop facing rules on a **real two-way road** (Town01 road 8, lanes ±1 at exactly 180°), free-vs-Shift orientation, far-from-lane fallback, manual-override persistence |
| `test_normalization.py` | 101 | `validate_scenario_params` in isolation: every silent coercion, both trigger rewrites, all clamps, the entity-ref mapping that `scenarioIO.js` duplicates, the actor-type whitelist, and the ego's shared `_normalize_actor` path (self-reference rejection, the `distance_to_ego`→`simulation_time` coercion, derived `route_waypoints`) |
| `test_actor_types_e2e.py` | 260 | all 12 actor types — toolbar tile and German label, placement (spawn-snap vs road-facing), map marker shape/colour/footprint, and the entity each one exports: element kind, blueprint id, category, bounding box, `maxSpeed`, controller module; plus `assign_route` survival, the walker-first base-template fork, and the 400 on an unknown type |
| `test_templates_e2e.py` | 159 | all 11 templates — panel renders them, placement attaches the right chain, `placement` rules apply, and the chain survives export with the right triggers, speeds, dynamics and lane offsets |
| `test_events_e2e.py` | 60 | the event editor across every action and trigger type, including the ones no template uses; the one-path-event rule; the events that would vanish from the export and are now refused at both ends (panel chip, client gate, backend 400); and `initial_speed` on an NPC and on a walker (emitted in the Storyboard Init, not as a Story event) |
| `test_ego_events_e2e.py` | 75 | the ego as a fully controllable actor: panel parity with an NPC (minus the ego-only-hidden `distance_to_ego` trigger), `simple_vehicle_control` (not `external_control`) in the export, the ego's own `heroBehavior` Act gated on `simulation_time` rather than `hero traveled 0.1m`, no Act at all for an event-less ego (and a 400 when nothing in the scenario has events), the `set_distance` self-reference 400, legacy `ego.trajectory` migration into a `follow_trajectory` event — both synthetic and against the real `example/Town01_scenario2.json` — the `initial_speed` split default (10 on placement, 0 when the key is absent), and the completeness guards: a path event seeded with the actor's own pose (so one click completes it) but discarding itself when drawing ends still under 2 waypoints, and a `distance_to_point` trigger seeded with a real point (5 m radius) the moment it is chosen, then moved by dragging its map marker — which is drawn above `layer-actors` so a point on its own actor stays grabbable |
| `test_elevation_e2e.py` | 33 | z derived from `<elevationProfile>` — the render payload's point shape, `groundZAt` interpolation, per-category clearance, drag and X/Y-edit recompute, waypoints following a gradient, and the flat-map baseline |
| `test_undo_e2e.py` | 44 | snapshot undo/redo across every kind of edit — placement, drag, Spawnpunkt fields, events, delete, bulk prop delete — plus the three things easy to get wrong: a whole drag coalescing into one entry while two deliberate edits stay separate, the rolling baseline that makes the announce-after-mutate placement paths record their real "before", and the deep copies that stop the history rewriting itself. Also the rule the design turns on — everything in the snapshot records, because a skipped edit is destroyed by the next undo rather than merely un-undoable — with noise handled by coalescing (one event card = one step), plus a preview run recording nothing and `loadJSON` clearing the stacks |
| `test_route_fidelity_e2e.py` | 9 | an `assign_route` preview never drives backwards: the route is routed through the cached lane graph (`LaneGraph.route`, a port of `GlobalRoutePlanner.trace_route`) and then filtered exactly as `ChangeActorWaypoints` filters it. Asserts on the computed route as well as on sampled motion, because the 4 m waypoint-acceptance radius can swallow a short backtrack the route assertion still catches |
| `test_waypoints_e2e.py` | 49 | path waypoints end to end: an `assign_route` point snapping to the lane centre at placement **and** on drag while a `follow_trajectory` vertex stays free; the drawn route line being the lane-following geometry rather than the chords between the clicks; drag/mark/delete with the map and the event card agreeing on which point is which; `Entf` taking a marked waypoint with no confirm and never the actor; one Strg+Z reverting a whole drag with its re-derived z; an unselected actor's waypoints being inert; the layer split that keeps the selected vehicle draggable and rotatable where waypoint 1 sits on top of it; `Ausblenden` hiding a path even while its actor is selected, with drawing or marking a waypoint un-hiding it by flipping the stored toggle; that no path carries direction-arrow markers; and the route line staying pixel-identical while a preview drives the actor away from its spawn |

`test_actor_types_e2e.py`'s count grows with the catalogue; the number above is
what it reported the last time this file was touched, not a target.

`test_ego_events_e2e.py` is kept separate from `test_events_e2e.py` rather than
folded in: the older suite's `EGO` fixture and every one of its assertions
assume an inert ego (no `events`) — true before the ego became
a controllable actor, and the entire premise the newer suite tests against.

### Why the elevation suite runs on two maps

Town01 is genuinely flat — every elevation coefficient in the file is zero — so
it isolates the clearance constants: a vehicle there must land at *exactly*
`0.5`, a VRU at exactly `0.6`. It can therefore prove nothing about the
interpolation. Town03 road 67 supplies that: it climbs to 2.7 m and returns to 0
within its own 310 m, so the same road gives both a "must be lifted" and a "must
not be lifted" case, and a drag between the two ends is the only assertion that
separates a working recompute from a lucky constant.

The suite asserts z against `ObjectsManager.groundZAt()` rather than against
literals, so it does not have to be rewritten when a lane centreline shifts by a
few centimetres — but it pins the *differences* (VRU > vehicle, prop gets no
clearance) with literals, because those are the design decisions.

### Why the actor suite reads the XML rather than trusting the export

An actor type is a bare string threaded through eight hand-kept lookup tables
across two repos, and **every one of them falls back rather than raising**. Miss
`_VEHICLE_PARAMS` and the actor exports with a car's 69 m/s top speed; miss
`vehicle_catalog.yaml` and it exports as a Lincoln MKZ; miss `vehicle_category`
and a firetruck claims `vehicleCategory="car"`. All three produce a file that
opens cleanly and looks right, so "the export succeeded" proves nothing. The
`EXPECTED` table is written out literally instead of being read back from the
catalogue — comparing the exporter against its own configuration would pass no
matter what either of them said.

Two smaller traps it is built around:

- **`ACTOR_SIZES` and `_VEHICLE_PARAMS` are independent tables**, and for every
  type predating the suite except `car` they disagree (truck 2.6 vs 2.5 wide,
  bus 9.0 vs 10.0 long, motorcycle 1.0 vs 0.9, cyclist 2.0x0.8 vs 1.7x0.6).
  Those four are grandfathered in `FOOTPRINT_DRIFT`; every type added since has
  to agree.
- **Spawn-snapping is asserted through yaw, not position.** Playwright clicks on
  integer pixels, which at map zoom is worth several decimetres, so "did it
  move" cannot separate a snap from rounding. Yaw can: a spawn-snapped actor
  inherits the lane's travel direction, a road-facing one turns to look at the
  lane.

`test_normalization.py` needs neither the browser nor the editor:

```bash
.venv/bin/python3 tests/test_normalization.py
```

### `known_issue()` is currently unused

`known_issue()` in `_harness.py` exists so a documented open bug can stay
visible without making the exit code permanently non-zero — otherwise real
regressions get ignored along with it. It prints `KNOWN` while the bug is open
and `KFIXED` once it is fixed, which is the cue to promote it to a normal
`check()`.

Its one user was this defect, now fixed: `build_custom_event_chain()` in
`../llm-scenario-gen` built its `event_name_by_id` map from **all** events, then
skipped any whose action builder returned `False` — a `follow_trajectory` with
fewer than two waypoints, or an `assign_route` on a type that cannot route. An
event chained onto a skipped one kept a `storyboardElementRef` pointing at an
`<Event>` that was not in the file, so that trigger could never be satisfied and
the follow-up never fired. It now builds the map from the events actually
appended, in a second pass, and such a trigger falls back to `simulation_time`.
Reaching it at all now takes a payload that bypasses the editor and the backend,
both of which reject an event that cannot be built.

## Two traps these suites are built around

- **Playwright silently clamps out-of-viewport clicks.** A world point that is
  off-screen gets clicked at the viewport edge, placing the prop somewhere else
  entirely and producing a confident but meaningless pass or fail. `place()` in
  the yaw suite refuses to click off-screen and asserts the prop landed where it
  aimed. Keep that guard in any new coordinate-based test.
- **A prop group's bounding box is dominated by its label text**, not its glyph,
  so `locator.bounding_box()` centres land above the prop in empty space. Target
  the prop's *origin* via `getScreenCTM()` instead.

## CARLA behavioural cases

**Stale — deliberately deferred, not yet re-baselined.** Everything below
describes `run_carla_cases.py`/`carla_cases.py` as they exist today, unchanged
by the ego-controller work: the hero's `.xosc` controller went from
`external_control` to `simple_vehicle_control`, and the ego now takes the same
authored events an NPC does. Every case's ego is `events: []` today (never a
literal here — it is what `AppState` defaults to), and `events: []` now means
the ego gets no Act at all, so **every case's ego sits still regardless of
`SCENARIO_GOAL`** — which, separately, is
already dead against the current `run.sh` (it runs `run_selfref_video_test.py`,
which takes no `--goal` and launches no external agent). All 28 cases need
re-running and their assertions re-checked before any claim below about ego
motion, timing, or turning can be trusted again.

```bash
bash run.sh 9090                                    # terminal 1: the editor
.venv/bin/python3 tests/run_carla_cases.py          # all 28 cases, ~12 min
.venv/bin/python3 tests/run_carla_cases.py tpl-stopping evt-assign-route
```

Four families, by prefix:

| prefix | n | what it is for |
|---|---:|---|
| `tpl-*` | 6 | the scenario templates, which have no other CARLA coverage |
| `evt-*` | 4 | event mechanics — trigger semantics and chain timing, with exact numbers |
| `act-*` | 2 | the newer actor types: does CARLA accept the blueprint and drive it |
| `bench-*` | 16 | Loop2Scenic benchmark scenarios — see `tests/bench/COVERAGE.md` |

The two `act-*` cases cover the actor catalogue where the `.xosc` cannot: that
CARLA accepts the blueprint id and that the controller ScenarioRunner picked
actually drives the thing. They assert `type_id` explicitly, because a missing
catalogue entry silently emits a Lincoln MKZ that behaves identically to a
correct one. One vehicle and one walker — the largest new vehicle and the
smallest new walker.

Needs CARLA on port 3000 (it reuses a running one). It takes the simulator over
for the duration and runs strictly sequentially, so it is deliberately **not**
part of `run_tests.sh`.

### The three `kind`s a case can be

- **`template`** — placed through the real template button and a real map click,
  so the template mechanism itself is under test.
- **`events`** — one NPC with its events seeded directly into `AppState`. The
  event editor is covered by `test_events_e2e.py`; here we want exact numbers.
- **`scene`** — several NPCs and/or props. NPCs are seeded for the `events`
  reason plus one more: at whole-town zoom a Playwright click is quantised to
  ~0.4 m and a lane is 3.5 m wide, so a click cannot reliably hit a named lane.
  Props are **not** seeded — they go through `H.place_prop`, because
  `_propYawFor`'s per-lane facing rule and `surfaceZFor`'s elevation lookup only
  run on the placement path, and those are exactly what a prop case is testing.
  `H.zoom_at` wheels in over the target and back out again afterwards, so one
  placement does not move the next one's screen coordinates.

A `scene` case's `npcs` array order is load-bearing: `buildScenarioParams` names
them `adversary`, `adversary1`, … by index, and that is the entity ref the
expectations read back.

**Any actor with `events: []` gets no Act, the ego included** —
`build_custom_event_chain()` returns False for an empty list and
`_build_actor_act()` then returns None, so the actor holds its `initial_speed`
(0 when omitted, as it is in every case here) for the whole run. This reverses
the older behaviour, where the same actor drove off on a `constant_speed`
fallback: a "parked" car covered 226 m before that was caught. An actor that
*has* events but must stay put still needs `_parked()` (an explicit
`set_speed 0`). A scenario in which *nothing* has events is rejected at export
with a 400.

Each case builds its scenario through the real editor, runs it through
`/home/dellpro2/Antonio/run.sh`, and judges the result against two independent
sources:

- **ScenarioRunner's OSC log.** It prints `[OSC][<t>s][EVENT][<name>] RUNNING|END`
  for every storyboard element. That is exact trigger-firing and completion
  timing, free, with no simulator introspection — the cheapest useful signal in
  the toolchain and the thing to reach for first when debugging a chain.
- **`carla_telemetry.py`'s CSV.** One row per actor per tick, so you can ask
  whether the actor actually did what the event commanded.

Both are required. An event can go `RUNNING` while the vehicle ignores it
entirely (wrong entity ref, unreachable lane, controller never applied it), and
telemetry alone cannot separate a mistimed trigger from a sluggish controller.

Artifacts land in `tests/artifacts/<case>/` (gitignored): `scenario.json`,
`telemetry.csv`, `telemetry.log`, `run.log`, and the exact `.xosc`. Videos are
moved to `recordings/gui_test_<case>/`, matching the existing `assign_route/`,
`pedestrian/` naming.

`scenario.json` is `AppState.toJSON()` captured in the browser at the moment the
case was built — the editor's own save format, not a test-only dump. Drop it on
the editor's **Laden** button to reopen the failing case complete with map, ego,
NPC and its full event chain, and carry on editing from there. It is captured
before the export, so it is exactly the state the `.xosc` beside it came from.

### Traps this runner is built around

- **The sidecar must never call `world.tick()`.** ScenarioRunner owns the clock
  in synchronous mode; a second ticking client advances the world underneath it
  and corrupts every timing measurement. `world.on_tick` is passive. Verified by
  running a scenario with and without the sidecar — both ended at `20.15s`.
- **Actor names must be captured while the actors are alive.** Resolving
  `role_name` when the CSV is written returns blanks for everything, because
  teardown has already destroyed the actors — which silently produces an empty
  file. A background poller keeps the map fresh during the run.
- **A hung scenario contaminates the next case.** A storyboard that never
  completes leaves `scenario_runner` alive even after it prints
  `No more scenarios .... Exiting`, and `run.sh` blocks forever in `wait`. The
  orphan then keeps ticking CARLA under the following case, whose distance
  triggers start firing off the 60 s `TimeFallback` instead of their real
  condition — indistinguishable from a trigger bug unless you know to look.
  Hence the per-case timeout, `start_new_session` + `killpg`, and the `pkill`
  sweep on both sides of every run.
- **Two clocks.** Telemetry carries CARLA's `elapsed_seconds`, a world clock
  that keeps counting across runs and starts in the hundreds. The OSC log counts
  from scenario start. They are reconciled through the ego's first motion, since
  every **NPC** Act starts on `hero traveled 0.1 m` — the hero's own Act
  (`heroBehavior`) does not carry that gate, since the ego cannot wait for
  itself to move before it is allowed to.
- **The ego pose is not free, and the goal is never inherited.** `run_case`
  always exports `SCENARIO_GOAL`, falling back to `C.GOAL` (`92,23,0,270`)
  rather than letting run.sh's own default through — that default lives outside
  this repo and gets retargeted by hand while debugging. `set_destination`
  projects whatever it is given to the nearest waypoint, so a wrong goal never
  errors, it just drives the ego somewhere nobody chose. The Town01 cases also
  depend on the ego starting at `300.631,-2.025` heading west; move it and every
  distance trigger fires at a different time.
- **A `distance_to_point` radius is a 3-D radius.** ScenarioRunner evaluates
  `DistanceCondition` through `location.distance(other)`, so the point's `z`
  counts against it. On Town04's ramp, where the deck is 7.7–9.8 m up, a point
  left at the `0.2` default puts the entire 5.5 m radius below the road and the
  condition can never become true — which looks exactly like an `entity_ref`
  that failed to resolve. `SEED_EVENTS_JS` in `run_carla_cases.py` derives the z
  of every trigger point, route waypoint and trajectory vertex from
  `ObjectsManager.surfaceZFor`, the same call the editor's own click makes. **A
  case never writes a literal z.**
- **A route on its own does not move an actor.** `AssignRouteAction` becomes
  `ChangeActorWaypoints`, which sets waypoints and nothing else, leaving
  `BasicControl._target_speed` at 0 until a speed action lands. Useful rather
  than merely surprising: it is how `bench-highway-cut-in` parks a car on the
  on-ramp with its route already assigned and releases it on the ego's approach.
- **A lane change needs a same-direction neighbour lane, and Town01 has none.**
  `ChangeActorLateralMotion` only reports success once the actor has driven
  `distance_other_lane` (hardcoded to 10 in `openscenario_parser.py`) *in the
  target lane*. It never reports failure except for an empty plan, so an
  unreachable target lane hangs the run forever instead of failing it. The
  lane-change cases therefore run on **Town03 road 67 lane -2** — a 144 m
  straight from `(159.2,193.0)` to `(17.7,193.5)` with `lane_change=Left` and
  lane -1 as a same-direction neighbour. Verified with CARLA's waypoint API
  before use; see the comment block in `carla_cases.py`.
- **Town03's parking lanes cannot host a pull-out.** All 75 of them sit beside
  a *single* driving lane (`lane_change=NONE`, no same-direction neighbour), so
  a lane change out of a parking spot dead-ends exactly like Town01. Both
  lane-change cases share road 67 instead.
- **A merge does not have to be a lane change.** `bench-highway-cut-in` uses
  Town04's real loop on-ramp — road 44 → connector 1194 → road 39 lane 6, which
  feeds the ego's own lane at x ≈ -68 — and gets the merge from an
  `assign_route` down the ramp. No `lane_change`, no same-direction-neighbour
  requirement, and the on-ramp in the description is geometry rather than a
  stand-in.
- **Measure lateral displacement against a straight-line heading.** Mid-turn the
  actor is yawed 45-125 deg off the road; projecting displacement onto that
  frame turned a real 3.5 m lane change into a reported 44 m of "lateral"
  travel. `lateral_offset()` takes its reference heading at `ref_t` (act start
  by default), never at the start of the measurement window.
- **`|lateral| ~ 3.5 m` is equally true of a lane change that went the wrong
  way**, and on a three-lane carriageway that puts the actor somewhere the
  scenario never meant. Pair it with an absolute check on the actor's final `y`
  against the lane it was supposed to reach — `_merged_into()` in
  `carla_cases.py`.
- **A cross-street actor launched at act start clears the junction before the
  ego gets there.** Measured on Town05 junction 1863: crossing car in at
  t=1.0 s, ego at t=5.9 s — the paths intersect in space and never in time, and
  every speed and geometry check still passes. Launch on `distance_to_ego` and
  assert `closest_approach`.
- **Distance radii need margin for the corner a turning ego cuts.** A
  `distance_to_ego@35` on the cross street missed by 0.6 m, because a
  left-turning ego starts its swing before the junction centre. The condition
  never fired, the actor waited out the 60 s `TimeFallback` that every
  `distance_to_ego` trigger carries, and the run limped to 77 s looking like a
  hang.
- **Town01's sidewalk is not spawnable.** A vehicle at y=-7 aborts the whole
  scenario with `Not all actors were spawned / Error: Unable to add actors`
  before a single tick.

## The benchmark cases

`bench-*` reproduces sixteen scenarios from the Loop2Scenic benchmark. The index
(all 250 entries), the extractor, the two conflicting tag censuses and the
coverage report live in [`tests/bench/`](bench/COVERAGE.md).

They are ordinary CARLA cases and are run the same way; what is different is
that each one carries the benchmark description it reproduces **verbatim** plus
its named fidelity delta, and that six of its checks are marked
`EXPECTED TO FAIL` on purpose:

- `bench-lane-blocked-construction` (3) — the props reach CARLA correctly and
  BehaviorAgent drives straight through them, shoving the barrier 69 m. There is
  no way to author an ego avoidance.
- `bench-pedestrian-crossing` (2) — a defect in the shipped
  `pedestrian-crossing` template: `distance_to_ego@50` at 2 m/s puts the walker
  off the far kerb ~3.5 s before the ego arrives, on every run.
- `bench-reversing-vehicle` (1) — there is no reverse action, so the actor
  turns round and drives forward instead.

Regenerating the index needs nothing but curl:

```bash
curl -sL -o bench.html https://yuangao-tum.github.io/loop2scenic-bench/
python3 tests/bench/extract_bench.py bench.html tests/bench
```

## CARLA probes (not tests)

`probe_carla_mesh_facing.py` and `probe_carla_mesh_dims.py` are one-off
measurement tools, not assertions. They need a running CARLA on port 3000 and
the `carla-venv` environment:

```bash
source /home/dellpro2/Antonio/carla-venv/bin/activate
export PYTHONPATH="/home/dellpro2/CC/carla_0.9.15/PythonAPI/carla/dist/carla-0.9.15-cp310-cp310-linux_x86_64.egg:/home/dellpro2/CC/carla_0.9.15/PythonAPI/carla:/home/dellpro2/CC/carla_0.9.15/PythonAPI"
python tests/probe_carla_mesh_dims.py       # bounding-box extents -> catalogue dims
python tests/probe_carla_mesh_facing.py     # two axis-aligned views per prop
```

`probe_carla_actor_blueprints.py` checks every id in `vehicle_catalog.yaml`
against the running build and lists each `walker.pedestrian.*` with its `age`
attribute. Both questions are invisible in the `.xosc` — a blueprint that does
not exist produces a perfectly valid file and fails at spawn time — and which
walkers are children is a property of the CARLA build, not of OpenSCENARIO, so
it moves between versions. The `child` archetype's id comes from this output.
It spawns nothing, so it is safe against a live session, and exits non-zero
only when an id is missing.

`probe_carla_mesh_dims.py` is reliable — its extents are what the catalogue's
measured footprints came from.

**`probe_carla_mesh_facing.py` is not trustworthy for `yaw_offset`.** It got
several props 180° wrong by mistaking a mesh's back for its front. Determine
rotation by running the scenario and looking at it; use the probe only to narrow
down which axis is involved. Both destroy every actor they spawn in a `finally`
block, so they are safe to run against a live session.

`probe_carla_lane_graph.py` is different in kind from the two above: it does not
measure a mesh, it caches CARLA's own routing/topology graph per bundled town so
`frontend/js/simulate.js` can route `assign_route`/`lane_change`/path-less
driving exactly instead of approximating — see CLAUDE.md's "cached CARLA lane
graph" section for the full picture. It targets `localhost:2010` by default (the
`run.sh` instance, not the port-3000 convention above), and it **does** mutate
the live world — it calls `client.load_world(...)` once per town, restoring the
original map in a `finally` block:

```bash
source /home/dellpro2/Antonio/carla-venv/bin/activate
export PYTHONPATH="/home/dellpro2/CC/carla_0.9.15/PythonAPI/carla/dist/carla-0.9.15-cp310-cp310-linux_x86_64.egg:/home/dellpro2/CC/carla_0.9.15/PythonAPI/carla:/home/dellpro2/CC/carla_0.9.15/PythonAPI"
python tests/probe_carla_lane_graph.py              # every bundled town with a CARLA counterpart (~30s total)
python tests/probe_carla_lane_graph.py Town03 Town05 # just these
```

Re-run it whenever a bundled `.xodr` changes or the CARLA build is upgraded —
there is no staleness check, the backend just loads whatever
`maps/<Town>/lane_graph.json` happens to be on disk at startup.

`capture_carla_aerial.py` renders the aerial image behind the editor's
`Luftbild` / `Beides` base-map modes into `maps/<Town>/aerial/` (see CLAUDE.md,
"Aerial image"). It also calls `load_world` per town, so it defaults to
**port 2050** — a private instance, never run.sh's 2010:

```bash
cd ~/yungloon/fail2drive/f2d_carla && ./CarlaUE4.sh -carla-port=2050 -RenderOffScreen -nosound &
/home/dellpro2/Antonio/carla-venv/bin/python tests/capture_carla_aerial.py              # all 8 CARLA towns, ~2 min
/home/dellpro2/Antonio/carla-venv/bin/python tests/capture_carla_aerial.py Town03       # just this one
```

Re-run it after a CARLA build upgrade or a `.xodr` change; the backend reads
the tiles per request, so a browser reload picks the new ones up.
