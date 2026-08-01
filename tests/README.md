# tests/

Coverage for static props, the event model, the scenario templates, and the
actor catalogue. Most of
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
| `test_normalization.py` | 57 | `validate_scenario_params` in isolation: every silent coercion, both trigger rewrites, all clamps, the entity-ref mapping that `scenarioIO.js` duplicates, and the actor-type whitelist |
| `test_actor_types_e2e.py` | 242 | all 12 actor types — toolbar tile and German label, placement (spawn-snap vs road-facing), map marker shape/colour/footprint, and the entity each one exports: element kind, blueprint id, category, bounding box, `maxSpeed`, controller module; plus `assign_route` survival, the walker-first base-template fork, and the 400 on an unknown type |
| `test_templates_e2e.py` | 149 | all 11 templates — panel renders them, placement attaches the right chain, `placement` rules apply, and the chain survives export with the right triggers, speeds, dynamics and lane offsets |
| `test_events_e2e.py` | 37 | the event editor across every action and trigger type, including the ones no template uses; the one-path-event rule; and the cases where an event silently vanishes from the export |

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

### Known defect reported by `test_events_e2e.py`

The suite prints one `KNOWN` line rather than failing. `known_issue()` in
`_harness.py` exists so a documented open bug stays visible without making the
exit code permanently non-zero — otherwise real regressions get ignored along
with it. When the bug is fixed the line flips to `KFIXED`, which is the cue to
promote it to a normal `check()`.

The defect: `build_custom_event_chain()` in `../llm-scenario-gen` builds its
`event_name_by_id` map from **all** events, then skips any whose action builder
returns `False` — a `follow_trajectory` with fewer than two waypoints, or an
`assign_route` on a type that cannot route. An event chained onto a skipped one
keeps a `storyboardElementRef` pointing at an `<Event>` that is not in the file,
so that trigger can never be satisfied and the follow-up never fires. Drawing a
"Follow trajectory" event without drawing the path, then chaining a speed event
after it, reproduces it.

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

```bash
bash run.sh 9090                                    # terminal 1: the editor
.venv/bin/python3 tests/run_carla_cases.py          # all 12 cases, ~5 min
.venv/bin/python3 tests/run_carla_cases.py tpl-stopping evt-assign-route
```

The two `act-*` cases cover the actor catalogue where the `.xosc` cannot: that
CARLA accepts the blueprint id and that the controller ScenarioRunner picked
actually drives the thing. They assert `type_id` explicitly, because a missing
catalogue entry silently emits a Lincoln MKZ that behaves identically to a
correct one. One vehicle and one walker — the largest new vehicle and the
smallest new walker.

Needs CARLA on port 3000 (it reuses a running one). It takes the simulator over
for the duration and runs strictly sequentially, so it is deliberately **not**
part of `run_tests.sh`.

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

Artifacts land in `tests/artifacts/<case>/` (gitignored): `telemetry.csv`,
`run.log`, the exact `.xosc`, and the NPC's placed pose. Videos are moved to
`recordings/gui_test_<case>/`, matching the existing `assign_route/`,
`pedestrian/` naming.

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
  every generated Act starts on `hero traveled 0.1 m`.
- **The ego pose is not free.** `run.sh` hardcodes
  `automatic_control_1.py --goal='92,23,0,270'`. `set_destination` projects that
  to the nearest waypoint, so it still yields a route on any town — but the
  Town01 cases depend on the ego starting at `300.631,-2.025` heading west.
  Move it and every distance trigger fires at a different time.
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
- **Measure lateral displacement against a straight-line heading.** Mid-turn the
  actor is yawed 45-125 deg off the road; projecting displacement onto that
  frame turned a real 3.5 m lane change into a reported 44 m of "lateral"
  travel. `lateral_offset()` takes its reference heading at `ref_t` (act start
  by default), never at the start of the measurement window.

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
