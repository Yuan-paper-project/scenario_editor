# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Keeping this file current

**Update this file as part of any change that invalidates it** — do not leave it to a follow-up. It is the only orientation a fresh session gets, and a stale claim here is worse than no claim, because it will be trusted.

Update it when you:

- add, remove, or rename an action, trigger, prop, or any other catalogue entry with a fixed list documented below;
- change a data flow, a serialization format, or the contract with `../llm-scenario-gen`;
- add a frontend module, a global, or anything that must go in the `index.html` script order;
- discover a non-obvious behaviour, silent coercion, or operational trap that cost you time — those are the highest-value entries here;
- invalidate a line reference. Prefer `file.js:NN` for things that are hard to grep for; use a symbol name when the name itself is greppable, since names survive edits and line numbers do not.

Keep the existing tone: terse, factual, and biased toward what is surprising rather than what is obvious from reading the code. Delete anything that is no longer true rather than appending a correction next to it.

## Running

```bash
bash run.sh          # http://localhost:9090
bash run.sh 8080     # custom port
```

`run.sh` creates `.venv/` on first run, installs deps, and starts `uvicorn backend.main:app --reload`.

- Always start from the repo root — the app is imported as `backend.main`, so `uvicorn main:app` from inside `backend/` will not work. `run.sh` handles this with `cd "$(dirname "$0")"`.
- **`.vscode/launch.json` passes no `--host`/`--port`**, so debugger runs land on uvicorn's default **8000** and bind loopback only, while `run.sh` uses **9090** on `0.0.0.0`. On a remote/SSH box the debugger's server is unreachable without a forwarded port — a hung browser tab usually means this, not a broken app.
- **There is no linter and no CI**, and no unit tests. Automated coverage is `tests/test_normalization.py` (pure Python) plus seven Playwright end-to-end suites that need a running editor, and `tests/run_carla_cases.py`, which needs a running CARLA (see Verification). Everything else is verified manually.
- All map geometry is parsed once at startup into `MAP_CACHE` (`backend/main.py:41-68`). Changes to `map_renderer.py` only take effect on restart — `--reload` does this automatically on save.
- **`--reload` only watches this repo.** Editing `../llm-scenario-gen` — including `prop_catalog.yaml`, which `xml_builder` reads once at import — requires a **manual restart**. Frontend files are read per request, so a catalogue edit appears instantly in the UI while the backend still serves the old data. That asymmetry is easy to misread as a bug.

## The sibling-repo dependency (read this first)

This repo does **not** stand alone. `.xosc` and route-XML generation are delegated to a sibling repo, `../llm-scenario-gen`, injected into `sys.path` at call time. Nothing in `requirements.txt` hints at this.

- Resolution order (`backend/scenario_io.py:10-12`): `<repo>/../llm-scenario-gen`, else the hardcoded fallback `/home/dellpro2/CC/llm-scenario-gen`.
- Imported **lazily**, inside the export functions via `_ensure_llmgen_on_path()` — a missing sibling repo fails only at export time (HTTP 500), never at startup.
- Entry points consumed:
  - `generator.xml_builder.build_xosc(params, out_path)`
  - `generator.route_builder.build_route(params, out_path)`
  - `preprocessing.map_parser.parse_xodr(path)` — junction centres, `backend/map_renderer.py:528-531`
- Consequence: **a new action or trigger type requires a matching change in `llm-scenario-gen`'s `generator/event_builders.py` and `xml_builder.py`.** The editor alone cannot emit it.
- The hero's controller module (`simple_vehicle_control`) is **template text**, not code — `templates/car.xosc` / `pedestrian.xosc`, not `_inject_ego`. A sibling-repo edit `--reload` will not pick up, same as everything else here.

## Data flow

```
maps/<Town>/<Town>.xodr
  → map_renderer.py   (OpenDRIVE parse; Y-FLIP: cx = x, cy = -y)
  → MAP_CACHE         (preloaded at startup, keyed by town name)
  → GET /api/maps/{town}/render → mapView.js  (SVG viewBox = CARLA bounds, no further transform)
  → user edits → AppState (frontend/js/app.js)
  → scenarioIO.buildScenarioParams()      ← export payload, NOT AppState.toJSON()
  → POST /api/export → validate_scenario_params() → build_xosc() → .xosc download
```

**The Y flip happens exactly once**, in the backend parser (`backend/map_renderer.py:5-6`, applied at lines 513 and 559-560). Downstream — render JSON, `AppState`, the exported `.xosc` — everything is CARLA coordinates with Y pointing down. Do not re-flip in the frontend. **Z is never flipped** — OpenDRIVE and CARLA are both Z-up.

## Height (z) comes from the OpenDRIVE elevation profile

Every z the editor writes is `elev(s)` at the placement point plus a per-category clearance. It used to be a flat `0.2` for actors and `0.0` for props, which buries an object metres under any road with a gradient.

- `_get_elevations` / `_eval_elevation` (`backend/map_renderer.py`) mirror `_get_lane_offsets` / `_eval_lane_offset` — same cubic, same `ds = s − record.s`. Do **not** model a new one on `_eval_lane_width`, whose `sOffset` is relative to the laneSection start instead.
- **z depends only on `(road, s)`**, not on lateral position: no bundled map has a `<shape>` element and every `<superelevation>` has `a=0`, so the surface at any lateral offset equals the reference-line height. If that ever stops holding, the cross-slope term belongs in `_eval_elevation`.
- **Render JSON point shape is `[x, y, z, s]`** for `directionLine` and `centerline` (`s` added for the phase-2 lane graph, same backward-compatible trick as `z` before it), and `spawnPoints` carry a `z`. Every consumer destructures positionally (`const [x0, y0] = …`), so trailing elements are backward-compatible — but a new consumer must not assume length 2 or 3. Costs ~11% payload per element; paid once at startup.
- **Every `roads[].lanes[]` entry also carries `sectionId`, `sStart`, `sEnd`** (`backend/map_renderer.py`, `_get_lane_sections`'s 0-based index in document/`s` order) and, for lane types with a `directionLine`, a parallel `widths` array (one value per point, already-computed lane width, previously derived and discarded). `sectionId` disambiguates a `laneId` that recurs across a multi-section road — `road.lanes` is otherwise flattened with no section marker. This numbering is *assumed* to match CARLA's own `waypoint.section_id`; `tests/probe_carla_lane_graph.py` cross-checked this empirically against live CARLA (Town03 road 1772) before anything was built on it — see "The cached CARLA lane graph" below. Each `roads[]` entry also carries `link: {predecessor, successor}` (`<road><link>`, `{elementType, elementId, contactPoint}` or `null` per side) — unused by rendering itself (only a crosswalk heuristic reads it), but `backend/lane_graph_builder.py` re-derives its own copy (`_parse_road_links`) to resolve a lane's successor across a road boundary, so it is no longer true that nothing consumes it.
- The frontend entry points are `ObjectsManager.groundZAt(x, y)` (bare surface, 60 m search radius, `0` beyond that) and `ObjectsManager.surfaceZFor(type, x, y, prop)` (surface + the right clearance). **Anything that moves an object must call `surfaceZFor`** — placement, the drag `mouseup`, the X/Y fields, the prop-type swap.
- `SPAWN_CLEARANCE` (`frontend/js/objects.js`): vehicles `0.5`, VRUs `0.6`, waypoints `0.5`, props none. **Always err high** — spawning below the surface fails hard in CARLA (`"collision at spawn position"`), while spawning above it is free because actors settle under physics within a tick. VRUs get more because the profile models the *reference line* and not kerbs or sidewalk height, and sidewalk lanes carry no `directionLine`, so a pedestrian on a kerb takes its z from the carriageway ~0.15 m below. A prop is a `<MiscObject>` with no settle behaviour, and its catalogue `z` is already a surface-relative offset.
- **z recomputes on `mouseup`, not on `mousemove`** (`frontend/js/objects.js`). `_nearestLaneProjection` is a linear scan over every lane segment (~59k points on Town03), so per-frame recompute would stutter — and z has no visual effect in a top-down 2D view. A hand-typed z therefore survives until the object is next moved.
- **`maps/Town10` uses an absolute geoid datum** (+50…+103 m; it is a georeferenced VectorZero map, *not* `Town10HD`). Actors placed there get those heights verbatim. The startup log flags it (`⚠ absolute datum?` from the per-town `elevation` range). Do not subtract a datum without first checking what CARLA reports for a waypoint on that map — if it builds the mesh from the same `.xodr`, the road really is up there and shifting it reintroduces the bug.
- `backend/scenario_io.py` still defaults a missing z to `0.2` / `0.0`. That is now only a fallback for payloads the editor did not build (hand-written, LLM-generated); it is not the editor's behaviour.

**Two different serializations of editor state; do not confuse them:**

| | Purpose | Ids |
|---|---|---|
| `AppState.toJSON()` / `loadJSON()` (`frontend/js/app.js`) | round-trippable save file (`.json`) | keeps internal `obj-N` |
| `buildScenarioParams()` (`frontend/js/scenarioIO.js`) | export payload for the backend | remaps to OSC entity refs |

They differ in one way that bites: `AppState._dumpActor` **spreads** (`...a`), so a new
actor field is saved to `.json` for free, while `buildScenarioParams`' `dumpActor` is an
explicit **allow-list**. A field missing from that list is silently dropped at export and
the `.xosc` comes out clean and wrong.

The id → entity-ref mapping (`ego → hero`, npc index 0 → `adversary`, index N → `adversaryN`, props → `prop0..propN`) is **duplicated** on the backend in `validate_scenario_params` (`backend/scenario_io.py`). The two must stay in agreement. `buildScenarioParams()` additionally derives `route_waypoints` with per-segment yaw for the route XML export — from the ego's own `follow_trajectory`/`assign_route` event (`AppState.pathEventOf`/`pathPointsOf`), **not** from an actor-level field — and serializes `staticObjects` as **ids and pose only** — the backend enriches each with category/mass/bbox from the catalogue, so the client is never the source of truth for what gets emitted.

`AppState.ego` has no `trajectory` field any more; a legacy save file that still has one is migrated into a `follow_trajectory` event on load (`AppState._migrateEgoTrajectory`), so it only ever exists transiently, mid-`loadJSON`.

## Actor types

12 placeable types plus `ego`. **There is no actor registry** — the type is a
bare string, and the "registry" is the set of lookup tables it appears in.

| Group | Types |
|---|---|
| Fahrzeuge | `car`, `van`, `truck`, `bus`, `motorcycle`, `scooter` |
| Einsatzfahrzeuge | `police`, `ambulance`, `firetruck` |
| Personen | `pedestrian`, `child`, `cyclist` |

`ego` is its own type but is **always coerced to `car`** at export
(`frontend/js/scenarioIO.js`, `buildScenarioParams`), and `_inject_ego` patches only `Vehicle/@name`
— so ego geometry and `vehicleCategory` are frozen at car values regardless.
`truck.ego_default` / `bus.ego_default` in the catalogue are unreachable.
The type coercion is the *only* thing still special about the ego at export —
it otherwise carries `initial_speed`/`events` exactly
like an NPC (see "The event model" below).

Adding one means editing both repos. Every lookup below **falls back silently**,
so a missed table exports a clean, wrong file:

| Where | What | If you skip it |
|---|---|---|
| `frontend/index.html` (`data-tool=`) | button + inline SVG + German label | unreachable from the UI |
| `frontend/js/mapView.js` `ACTOR_COLORS` / `ACTOR_SIZES` | map marker | drawn as an orange 4.5 m car |
| `frontend/js/mapView.js` `WALKER_TYPES` | circle vs rect+windshield | a child renders as a tiny car |
| `frontend/js/objects.js` `ROAD_FACING_TYPES` | free placement facing the road | teleported to the nearest lane spawn point |
| `frontend/js/app.js` `ACTOR_TYPE_GROUPS` | switchable-type group + German label | placeable, but the type picker never offers it |
| `../llm-scenario-gen/config/vehicle_catalog.yaml` | archetype → blueprint, **and** the `vehicle_category:` entry | exports as `vehicle.lincoln.mkz_2017` / `vehicleCategory="car"` |
| `xml_builder.py` `_VEHICLE_PARAMS` or `_PEDESTRIAN_PARAMS` | Performance + BoundingBox + Axles | car physics (69 m/s firetruck) |
| `xml_builder.py` `_TYPE_ALIASES` **and** the verbatim copy in `event_builders.py` | alias → archetype | the two resolve the type differently |
| `event_builders.py` `_ROUTE_ACTION_TYPES` — **and its copies** in `backend/scenario_io.py` (`_ROUTE_ACTOR_TYPES`) and `frontend/js/app.js` (`ScenarioRules.ROUTE_ACTION_TYPES`) | may use `assign_route` | the action grid greys the button out and the backend 400s, on a type the emitter would have routed happily |
| `xml_builder.py` `_PEDESTRIAN_TYPES` | `<Pedestrian>` vs `<Vehicle>`, controller module, base template | a `<Vehicle>` holding a `walker.*` blueprint |
| `config/scenario_components.yaml`, `scripts/generate_and_record.py` | LLM vocabulary + recording script's own third blueprint map | LLM/recording paths don't know the type |

Unlike events, an unknown NPC type is a **hard 400**, not a coercion
(`_normalize_actor_types`, `backend/scenario_io.py`), via `actor_types()` in
`xml_builder`. Same reasoning as props: the string is free-form, and every
downstream lookup would otherwise turn a typo into a Lincoln MKZ.

`mapView.js` `WALKER_TYPES` and `xml_builder` `_PEDESTRIAN_TYPES` are the same
split maintained twice — keep them in step. `_template_for` picks the base
`.xosc` from the **first** NPC's type, so a walker in slot 0 is the only
arrangement that selects `pedestrian.xosc`.

### Switching a placed actor's type

The properties panel's `#actor-type-select` swaps the type of an already-placed
NPC without touching its id, pose, events, behaviours or trigger settings —
`AppState.switchActorType` (`frontend/js/app.js`). Swaps are confined to the
group in `ACTOR_TYPE_GROUPS` (`vehicle` = Fahrzeuge + Einsatzfahrzeuge, `vru` =
Personen); `ego` and `prop` are in no group and get no picker.

**The group boundary is load-bearing, not cosmetic.** Every `vehicle` type is
snapped to a spawn point at placement while every `vru` type is in
`ROAD_FACING_TYPES` and placed freely, so a within-group swap can safely keep
the existing pose — the swap deliberately does **not** re-snap or re-derive yaw.
`assign_route` is likewise vehicle-only downstream (`_ROUTE_ACTION_TYPES`), so a
within-group swap can never orphan a route event. Crossing the boundary breaks
both, which is why the guard is in `canSwitchType` and not just in the UI.

**A swap moves the actor to the end of `AppState.npcs`.** Display numbers are
never stored — `actorLabel` derives `CAR 2` from the actor's index within
`npcs.filter(n => n.type === ...)`, so add/delete/swap all renumber through the
same path for free. Appending is what makes the swapped actor take the *next*
number in its new type rather than displacing an existing one. The cost is that
`buildScenarioParams` names NPCs `adversary`, `adversary1`, … by array index, so
a swap can rename entities in the exported file (harmless — the file stays
internally consistent) and can change which type `_template_for` sees in slot 0.
The prop picker does *not* reorder `staticObjects`, so a swapped prop keeps its
position in its new prop's numbering.

`ACTOR_SIZES` and `_VEHICLE_PARAMS` are independent tables and disagree for
every type predating `tests/test_actor_types_e2e.py` except `car`; those four
are grandfathered in that suite's `FOOTPRINT_DRIFT`. New types must agree.

**Which `walker.pedestrian.*` are children is a CARLA build property**, not an
OpenSCENARIO one, and it moves between versions. `tests/probe_carla_actor_blueprints.py`
prints each walker's `age` attribute; that output is where `child`'s blueprint
id comes from. OpenSCENARIO's `pedestrianCategory` enum has no `child` value, so
a child is a `pedestrian` with a smaller box and less mass — the only valid
encoding.

## The event model (spans three files)

Every scenario actor — **ego included** — holds `events: [{ id, name, trigger, action }]`.
The ego is not a special case here: it goes through the same UI (`eventPanel.js`),
the same backend normalizer (`_normalize_actor` in `backend/scenario_io.py`),
and the same emitter path (`_build_actor_act` in `xml_builder.py`) as every NPC.
Its entity name is `hero`; an NPC's is `adversary`/`adversaryN`.

- **Actions** (5): `follow_trajectory`, `assign_route`, `set_speed`, `set_distance`, `lane_change`
- **Triggers** (4): `simulation_time`, `distance_to_ego`, `distance_to_point`, `after_event`
  — `distance_to_ego` is **not offered for the ego itself** (see below).

Adding or changing one means editing all three layers:

| Layer | File | Holds |
|---|---|---|
| UI | `frontend/js/eventPanel.js` | `EVENT_ACTIONS` / `EVENT_TRIGGERS` lists + per-action form rendering |
| Validation | `backend/scenario_io.py` | `_normalize_structured_event` (per-event) / `_normalize_actor` (per-actor) — whitelists, clamps, defaults |
| Emission | `../llm-scenario-gen/generator/event_builders.py` | the actual OpenSCENARIO XML |

The `EVENT_ACTIONS` / `EVENT_TRIGGERS` **labels are German while the keys stay the
snake_case OpenSCENARIO-side names** — only the keys travel to the other two layers.
Renaming a label is not cosmetic-only: `test_events_e2e.py`, `test_ego_events_e2e.py`
and `test_elevation_e2e.py` all click action buttons via
`.event-action-button:has-text("<label>")`, so a rename breaks three suites at once.

**A card is laid out WENN → DANN**: `_renderEventList` appends the header (title
+ delete, nothing else), then the `.event-trigger-block` — tinted, accent-edged,
filled by `_appendEventTriggerControls`, which appends into that block and *not*
into the card — then the action controls. An `assign_route` gets
`_fixedTriggerBlock()` in place of the controls, a one-row statement of its fixed
start; dropping the block for it would leave the only card whose start condition
is stated nowhere. Inputs inside the block are lifted to `--panel` because the
block's own background is `--bg`, which is the card-wide input background.

**`.event-summary` is rendered only on a *collapsed* card** (`_summaryLine`),
where it is `<action> • <trigger>` — the whole event in one line, wrapping rather
than ellipsising, because the trigger half is the part not already in the title.
An expanded card shows both in editable form immediately below, so repeating them
there was two rows of pure duplication. Nothing outside a collapsed card prints
the trigger summary any more.

Other panel-level pieces of the events section: `#event-count` (the pill in the
section header, written by `_renderEventList`), `_bulkCollapseBar` (rendered above
the list from two events on, flips every `ev.collapsed` at once), and
`.event-card.active-draw`, which marks the card the map clicks currently belong to. That last one keys off `activeTrajectoryId`/
`activeRouteId` **as well as** `activePathEventId`, because event ids are only
unique within an actor — every actor's first event is `evt-1`. `properties.js`
re-renders on an `activePathEventId`/`triggerPointMode` change to keep it current.

Silent behaviours worth knowing when debugging "my event did nothing":

- Unknown action/trigger strings are **silently coerced** to `follow_trajectory` / `simulation_time` rather than raising. The coercion is still silent, but its usual consequence no longer is: a typo'd action name coerces to a `follow_trajectory` with no waypoints, which is now a hard 400 (see "An event the emitter would drop" below) instead of an event that vanished.
- An `assign_route` action forces its own trigger to `simulation_time @ 0` (`backend/scenario_io.py`, mirrored in `frontend/js/scenarioIO.js`).
- An `after_event` trigger pointing at an `assign_route` event is rewritten to `distance_to_ego @ 400`.
- A `distance_to_ego` trigger on an **ego-owned** event is rewritten to `simulation_time @ 0` — a distance from hero to itself is always 0, so the condition would fire on tick 1 regardless of the configured value. This coercion runs in `_normalize_actor` **after** the `after_event`→`assign_route` rewrite above, so a rewritten trigger on an ego event is caught too. `eventPanel.js` additionally omits the option from the trigger dropdown when the actor is the ego, and `event_builders.py`'s `build_start_event` / `_add_custom_event_start_trigger` fall back to `simulation_time` for `entity_name == 'hero'` as a third, defensive layer.
- **An event the emitter would drop is a hard 400, and the editor will not let you build one.** `_add_follow_trajectory_action` / `_add_assign_route_action` return `False` under 2 waypoints (and the latter also for a non-vehicle type), `build_custom_event_chain` then skips the whole event, and anything chained onto it with `after_event` is left pointing at a `storyboardElementRef` that is not in the file. Four layers now close that off, and the frontend three share one predicate — `ScenarioRules` in `frontend/js/app.js` (`actionEmits` / `eventProblem` / `problemsOf`), which `eventPanel.js` (warning chip + the `#event-warn` count), `scenarioIO.js` (`_validateScenario`) and `simulate.js` all call:
  - a path event **starts with no waypoints** and **deletes itself** when draw mode ends with fewer than 2 (`_discardIncompletePath`, `frontend/js/objects.js`, hung off the `AppState.on('change')` mode transition rather than the *Fertig* button, because Esc clears the flags directly in `mapView.js`). It used to be seeded with one waypoint on the actor — below the emitter's minimum, invisible on the map, and reported by the card as „Pfad gezeichnet".
  - **`Route zuweisen` is `disabled` for `pedestrian`/`child`/`cyclist`** — `AssignRouteAction` is vehicle-only (`_ROUTE_ACTION_TYPES`), and the grid used to offer it to everyone.
  - `validate_scenario_params` raises on both cases. `_ROUTE_ACTOR_TYPES` (`backend/scenario_io.py`) is a third copy of that type list and **must include the aliases that resolve to a routable type** (`lorry`, `moped`) — the emitter runs `_TYPE_ALIASES` first, so without them the backend rejects payloads the emitter accepts.
  - `build_custom_event_chain` builds its `event_name_by_id` from the events that **actually got appended** (two passes: actions first, then triggers), so a chained `after_event` whose target was skipped now falls back to a plain `simulation_time` start instead of dangling. This was the long-standing `KNOWN` entry in `test_events_e2e.py`.
- **A `distance_to_point` trigger is never point-less.** Choosing it in the panel places the point on the acting actor immediately (`ObjectsManager.defaultTriggerPoint`) and then arms the map to *move* it. A missing point used to be defaulted to `(0, 0, 0.2)` in `_normalize_structured_event` — the map origin, which a 3-D `DistanceCondition` can never reach — so that is now a 400 too; and in the emitter it fell through to `simulation_time(value)`, reading the radius in metres as a delay in seconds (a 20 m radius became `t > 20 s`). Both fixed.
- **The bottom-centre banner is shared by both map-click modes** — path/route drawing and trigger-point picking (`#traj-banner`, text and buttons written per mode in `objects.js`). Point mode used to announce itself only with a Toast that vanished.
- `eventPanel.js` permits at most one path-producing event (`follow_trajectory` or `assign_route`) per actor (`frontend/js/eventPanel.js`), the ego included — this is also what `route_waypoints` (for route XML export) is derived from now that there is no actor-level `ego.trajectory`. The two path buttons stay in the action grid once one exists and go **`disabled` with a title**, rather than being removed: hiding them reflowed the grid with nothing to explain where they went.
- An `assign_route` card shows the fixed chip **`startet sofort (fest)`** — in its trigger block when expanded, in the summary line when collapsed — where every other card shows its trigger summary, because a route's trigger is discarded at export (see above) and the card offers no trigger controls for it. Do not "fix" this by printing the stored trigger — it would state a start condition the file does not contain.
- **An actor with `events: []` gets no `<Act>` at all** — `build_custom_event_chain` returns `False` for an empty list and `_build_actor_act` (`xml_builder.py`) then returns `None` instead of building a fallback chain. The actor still spawns, still gets its `<Private>` teleport, controller and Init `<SpeedAction>`; it simply takes no part in the story, so it holds its `initial_speed` forever (or stands still at 0). This applies to the ego exactly as it does to an NPC — an ego with no events gets no `heroBehavior` Act, and `SimpleVehicleControl` drives it down its own spawn lane at whatever its Init speed was. **This is the opposite of the old behaviour**, where an event-less actor fell back to a `constant_speed` chain and drove off at 10 m/s; a "parked" car in a bench case covered 226 m before that was caught.
- **A scenario in which *nothing* has events is rejected with a 400** (`validate_scenario_params`, `backend/scenario_io.py`). Every actor would contribute zero Acts, leaving a `<Story>` with no `<Act>` children — XSD-invalid, and the storyboard would complete on the first tick. Traffic-signal events count towards the rule, since `_inject_traffic_signals` builds a `ScenarioBehavior` Act of its own. `build_xosc` carries its own copy of the check (`_require_nonempty_story`) as a `RuntimeError`, for payloads that never went through the backend. Deleting the empty `<Story>` is **not** an alternative fix — `<Storyboard>` requires exactly one, verified against `OpenSCENARIO.xsd`.

### `set_speed`'s dynamics dimension: a hold (`time`) or a ramp (`rate`)

A `set_speed` action's `dynamics.value` means a different physical quantity per
`dimension`, chosen in the event card's **Dynamik** toggle (`Zeit` | `Rate`,
`_speedDimensionToggle` in `eventPanel.js`, modelled on the `Modus` toggle above it).
The second field's label and unit swap with it — `Für … s` vs `Rate … m/s²` — and so
does the card summary (`für Ns` vs `mit N m/s²`).

| dimension | value | speed profile | when the event **ends** |
|---|---|---|---|
| `time` (default) | seconds | instant step to the target, then hold | after `value` seconds |
| `rate` | m/s² | linear ramp from the actor's speed at trigger time | **on reaching the target** |

`distance` (metres driven) is a third dimension the runtime honours and the whitelists
accept, but the toggle does not offer it — a payload carrying it renders as `Zeit` and
is rewritten to `time` the moment the value field is touched, exactly as the field did
unconditionally before the toggle existed.

Things that only make sense once you have read `ChangeActorTargetSpeed`:

- **`rate` supersedes `duration`/`distance`** — they are an `if`/`elif` in the atomic, so
  a rate event's completion time is `|Δv| / rate`, not anything authored. Anything chained
  onto it with `after_event` fires on arrival.
- **A `rate` of `0` never terminates.** `commanded = start_speed ± 0·elapsed` never reaches
  the target, so the atomic never reports SUCCESS, the storyboard never completes, and
  `run.sh` blocks forever in `wait` — leaving an orphan that ticks CARLA underneath the
  *next* case (see the CARLA-tests section). Hence the **`0.1` floor**, applied in
  `_normalize_actor` *and* in the emitter's own copy, not merely as an input `min`.
- **`shape` is forced to `linear` for `rate`.** `step` + `rate` is self-contradictory. This
  runtime never reads `dynamicsShape` at all (`grep -rn dynamicsShape --include=*.py` on
  `scenario_runner` → 0 hits), so this is honesty rather than behaviour — but it is what
  keeps `test_templates_e2e.py`'s "`step` is what makes the duration a hold" assertion
  coherent.
- **The four speed-profile templates ramp** (`RAMP_RATE = 5.0` m/s², `frontend/js/templates.js`):
  *Beschleunigen* and *Bremsen* end on a rate event; *Stoppen* and *Stop-and-Go* alternate
  ramp and hold, because a `rate` event ends on arrival and therefore cannot itself hold —
  every dwell in those chains is a separate `time` event. Every other template, and every
  hand-written `tests/carla_cases.py` chain, stays on `time`.
- **`rate` is a local ScenarioRunner patch, not upstream.** See the Verification section.

### Initial speed (`initial_speed`) — the one thing that happens *before* the storyboard

Every scenario actor also carries `initial_speed` (m/s), edited in the properties
panel's **Spawnpunkt** section as **Start (m/s)** and emitted as a `<SpeedAction>` in
the actor's `<Private>` under `<Storyboard><Init><Actions>` — not as a Story event.
`_build_init_speed_action` / `_init_speed_of` (`xml_builder.py`), appended last inside
the `<Private>` by `_build_npc_private_init` (NPCs) and at the end of `_inject_ego`
(hero, after the `_replace_placeholder_text` sweep, same reasoning as the props).

What ScenarioRunner does with it, because none of it is guessable from the file:

- `openscenario_configuration._get_actor_speed` scans the entity's Init `<Private>`
  for **any** `AbsoluteTargetSpeed` — position inside the `<Private>` is irrelevant —
  and a **negative value raises**, killing the run. That is why the clamp floor in
  `_normalize_actor` is a real guard, not tidiness.
- It runs for `<Pedestrian>` as well as `<Vehicle>` (`_extract_pedestrian_information`
  calls the same function), so a walker can start mid-stride.
- `open_scenario._create_init_behavior` turns it into
  `ChangeActorTargetSpeed(..., init_speed=True)` under `InitialActorSettings`, a
  sibling of the stories Parallel that is **ticked before it**. Acts start on
  `SimulationTime > 0`, false on tick 1 — so **the init speed lands first and the
  first Story speed action to fire overwrites it** (`BasicControl.update_target_speed`
  assigns `_target_speed` and clears `_init_speed`).
- Neither controller ramps: `SimpleVehicleControl` calls `set_target_velocity`
  directly (our templates never pass `max_acceleration`) and `PedestrianControl` sets
  `control.speed`. The actor is *at* the speed on tick 1.

**`0` means "no init speed", and for an event-less actor that now also means
"parked".** Nothing is emitted at 0, and `open_scenario.py`'s `if actor.speed > 0`
would skip it anyway. Since an actor with `events: []` gets no Act, its init speed is
the *only* speed command it ever receives — so it holds that speed for the whole run,
and 0 leaves it stationary. An actor that has events but must stay put still needs an
explicit `set_speed 0` (`_parked()` in `tests/carla_cases.py`), because its own later
events would otherwise move it.

**The default is split on purpose, and this is the trap.** `ObjectsManager`'s
`DEFAULT_INIT_SPEED` gives a *placed* actor `10`, while an
**omitted** key defaults to `0` in both `AppState._hydrateActor` and
`_normalize_actor`. So a legacy save file, an LLM payload and every
`tests/carla_cases.py` case — none of which mention the field — keep exporting exactly
as they did before the feature existed, while a UI-placed actor starts moving. Two
identical-looking actors can therefore differ; check where the state came from before
concluding the field is broken.

### Entity refs are the exception to the coercion rule

Three fields name another actor by the editor's internal `obj-N` id and must be
remapped to an OSC entity name before export: `trigger.entity_ref`
(`distance_to_point` only), `action.target.entity_ref` (`set_speed` relative)
and `action.entity_ref` (`set_distance`). Nothing else does —
`after_event`'s `event_id` is a *storyboard element* name, and `distance_to_ego`
has no field because the emitter hardcodes `hero`. `lane_change` carries an
`entity_ref` in the emitted XML (`_add_lane_change_action`) but it is decorative:
`openscenario_parser.py` reads only `RelativeTargetLane/@value` and discards
`@entityRef` entirely, so the editor never remaps it and it means nothing to
ScenarioRunner regardless of what it says.

Both the `resolveAction`/`resolveTrigger` pair in `buildScenarioParams`
(`frontend/js/scenarioIO.js`) and the `actor_refs` map in
`validate_scenario_params` do the remap; the payload carries `ego.id` purely so
the backend's copy can resolve the ego too. **An `entity_ref` that resolves to
neither `hero` nor a real `adversaryN` is a hard 400** (`_entity_ref`,
`backend/scenario_io.py`), not a coercion — same policy as an unknown prop id or
actor type. The alternative was proven bad: an unresolved ref used to pass
through verbatim, ScenarioRunner matched no actor, left `trigger_actor = None`,
and the condition simply never fired — indistinguishable from a badly-tuned
radius. `valid_refs` is derived from the **npc count**, not from the ids
present, so a hand-written or LLM payload naming `adversary1` directly still
validates. `tests/_harness.py` `dangling_entity_refs()` asserts this over a
whole `.xosc`.

**A `set_distance` ref naming the acting entity itself is *also* a hard 400** —
the same `_entity_ref` call takes a `forbid=` parameter set to the actor's own
entity name (`"hero"` for the ego, `"adversaryN"` for an NPC). `KeepLongitudinalGap`
against yourself computes a gap of exactly 0 and reports SUCCESS on the first
tick — a silent no-op that looks identical to a working action until someone
watches the simulation. The same `forbid` guard also catches an *omitted*
`entity_ref`, which falls back to `"hero"` and would otherwise silently become
this exact self-reference on an ego-owned event. Relative `set_speed` naming
the acting entity itself is **not** rejected — `ChangeActorTargetSpeed` with
`relative_actor == actor` is well defined, and the UI cannot produce it by
accident since `_relativeActorOptions` already excludes the actor from its own
dropdown. It is **not** a one-shot `"current speed plus a delta"` though: the
atomic re-samples the reference every tick for the action's whole duration (see
the preview section below), so a self-reference *compounds* — it adds `delta`
per tick until the duration expires, not once.

## Static props (CARLA `static.prop.*`)

16 curated props — cones, barriers, warning signs, debris, occluders — placeable on the map and
exported as OpenSCENARIO `<MiscObject>`. They live in `AppState.staticObjects` as
`{id, type:'prop', prop:'static.prop.*', x, y, z, yaw}` (`app.js:19`).

**The catalogue is split in two, deliberately mirroring the `vehicle_catalog.yaml` pattern.** The only
shared column is the blueprint id; a mismatch fails loudly as a 400 at export, never silently.

| File | Owns | Used by |
|---|---|---|
| `frontend/js/propCatalog.js` | label, group, glyph shapes, footprints, `facing`, `planRotate` | palette + map |
| `../llm-scenario-gen/config/prop_catalog.yaml` | `category`, `mass`, `bbox`, `yaw_offset` | emitter + backend validator |

`prop_spec()` (`../llm-scenario-gen/generator/xml_builder.py`) is the public accessor; `backend/scenario_io.py`
`_normalize_static_objects` (`:130`) imports it to **reject unknown prop ids with a 400**. That is a
deliberate break from the silent-coercion pattern used for events — a typo'd blueprint would
otherwise export cleanly and fail much later inside CARLA as a missing actor.

Emission is `_build_static_prop_entity` / `_build_static_prop_init` / `_inject_static_props` in
`../llm-scenario-gen/generator/xml_builder.py`, called from `build_xosc` **after** `_inject_ego` so the `_replace_placeholder_text`
attribute sweep cannot rewrite prop values. Props get a teleport-only `<Private>` with **no
`ControllerAction`** and never appear in a `ManeuverGroup` — they are not controllable and
ScenarioRunner must not put them on the `ActorsWithController` blackboard.

### Two traps that will silently produce the wrong scenario

- **`miscObjectCategory` can override your blueprint.** ScenarioRunner maps category `barrier` →
  `static.prop.streetbarrier` and `guardRail` → `static.prop.chainbarrier`, *discarding* the `name`
  attribute. Only `streetbarrier` may use `barrier`; everything else must use `obstacle`. This is why
  `category` is stored per-entry rather than derived.
- **`yaw_offset` is mesh calibration, and it is ground truth from running CARLA — not derivable.**
  The editor's `yaw` always means "the direction the prop faces"; the offset is added at export
  (`h = radians(yaw + yaw_offset)`). An offline probe that photographed each mesh from two
  axis-aligned cameras got several props **180° wrong** by mistaking a back for a front. If a prop
  looks rotated in simulation, run it and fix the YAML — never compensate in the editor's yaw rules.

### Placement orientation is per-prop and per-lane

`_propYawFor` (`objects.js:149`) resolves a `facing` rule against the OpenDRIVE direction of the
**specific lane** nearest the click:

| Rule | Yaw | Props |
|---|---|---|
| `oncoming` | `laneYaw + 180` | barrier, warning trailer, both warning signs, billboard |
| `along` | `laneYaw` | road plate |
| `alongside` | `laneYaw` or `+180`, whichever turns the open side toward the road | bus stop, container |
| `toward-road` | bearing to the nearest lane point | vending machine |
| `none` | 0 | cones, barrel, bin, debris, cart |

This works because `map_renderer.py:639` **reverses `directionLine` for left-side lanes**, so
`laneYaw` is true lane *travel* direction. Adjacent carriageways therefore yield yaws exactly 180°
apart and an `oncoming` prop on each side faces its own lane's traffic. Sidewalk lanes carry no
`directionLine` at all, so kerbside props orient against the nearest *driving* lane.

- Orientation **always** applies (within `PROP_YAW_MAX_DIST`, `objects.js:133`); Shift controls
  *position* only. Beyond that distance yaw falls back to 0.
- Side/bearing is computed from the **original click point**, not the snapped position — snapping puts
  the prop on the centreline where "which side of the lane" degenerates.
- The prop tool is **sticky** and does not auto-select: you place a cone taper with one click each.
- Manual rotation is never clobbered; the rule only runs at placement. Swapping prop type also keeps
  the existing yaw.

### Two views of every prop

- **`side`** — elevation silhouette, palette tiles only. A picker icon should look like the object.
- **`plan`** — top-down footprint, map marker, rotating with yaw exactly like vehicle rectangles in
  `_renderActor`. The map is plan view throughout, so the marker has to be too.

`planRotate` is **cosmetic and map-only**: for props whose yaw means "the way the face points", the
drawn body sits *across* that direction (a barrier blocks the lane rather than lying along it). It is
applied to the body group alone, so the selection ring, hit target, yaw arrow and the exported `h`
are all untouched.

Footprints are real measured metres, taken from `bounding_box.extent` on the live meshes
(`tests/probe_carla_mesh_dims.py`) — several were badly wrong before that: `container` is a ~1.9 m
skip, not a 6 m shipping container. Note the measured extents are in the **mesh** frame, so for any
prop with a ±90 `yaw_offset` the axes must be swapped before use as `plan.len`/`plan.wid`, where +X
means the facing.

`planSize()` clamps small footprints up to `MIN_PLAN_EXTENT` (1.2 m) so they stay visible.
**Known limitation:** every prop below that floor draws at the floor, so the three cones
(0.88 / 0.46 / 0.34 m) all render at the same diameter and their real size difference is invisible on
the map. Removing the clamp fixes that but makes sub-metre props nearly impossible to see when zoomed
out; props carry a separate invisible hit circle, so clickability is not the blocker — visibility is.

## Frontend conventions

**No build step, no bundler, no npm.** Each `frontend/js/*.js` is an IIFE attaching one global: `AppState`, `Api`, `MapView`, `ObjectsManager`, `EventPanel`, `TrafficSignals`, `ScenarioTemplates`, `PropCatalog`, `LaneGraph`, plus `Toast` / `Confirm` / `UndoStack` / `UIUtils` / `ScenarioRules` from `app.js`. Two globals exist only as test hooks and are called by no UI code: `Simulate.routeForTesting` (`tests/test_route_fidelity_e2e.py`, asserts on a computed route without running the animation) and `ScenarioIO.buildParamsForTesting` (`tests/test_events_e2e.py`, builds the export payload without the click, so a payload the client-side gate refuses can still be handed to the backend). Several files (`toolbar.js`, `properties.js`, `weather.js`, `mapImport.js`, `welcome.js`) export nothing else and simply bind DOM listeners on load.

- **Script order in `frontend/index.html` (the `<script>` block near the end) is load-bearing** — `app.js` first, dependents after; `propCatalog.js` must precede `toolbar.js`, which renders the prop tiles from it. A new module must be added there or it never runs.
- Cross-module communication goes through `AppState`. `set()` / `updateById()` / `removeById()` / `select()` emit `change`, `actorUpdated`, `actorRemoved`, `selectionChanged`, `stateLoaded`, `trafficSignalSelected`, `trafficSignalUpdated`. Subscribe via `AppState.on(...)`; never reach into another module's DOM.
- Modal editor state (`trajectoryMode`, `routeMode`, `triggerPointMode`, `activePathEventId`, `pendingTemplate`, `pendingProp`) lives on `AppState` and is what the `mapView.js` click handlers branch on.
- The left toolbar is **tabbed** (`Akteure` | `Requisiten`, `data-toolbar-tab`). `toolbar.js` uses **event delegation** on `#toolbar`, not a load-time `.tool-btn` snapshot — prop tiles are rendered at runtime and a snapshot would silently miss them. Tab state is module-local, matching `_overviewPanelTab` in `properties.js`.
- Props reuse the `.actor-group` class (plus `.prop-group`), which gives them selection, body-drag and the `mapView.js` pan-exclusion list for free. If you add a new draggable map object, do the same rather than adding a class to three separate `closest()` checks.
- Use `Toast.success/error/warn/info` for feedback (there are no `alert()` calls) and `await Confirm.show(msg)` for destructive actions.
- **UI-facing strings are German; code, comments, and identifiers are English.** Match this when adding UI.
- `UIUtils` (`app.js`) holds the helpers `properties.js` and `eventPanel.js` share: `paramRow(label, control, unit)`, `fmt(value, decimals = 1)`, `nextIndexedId(events, prefix)` and `bindLabel(label, control)`. **`fmt`'s convention is that display precision follows the input's `step`** — a `0.1`/`0.5`-step field reads 1 dp, a whole-number one reads 0 dp — and the *same* call formats the card summary above the field, so the two can never disagree (`10` next to `10.0`). `bindLabel` exists because every panel control is built in JS with no id: it assigns one and sets `for=`, or, for a segmented `.event-toggle` (a `<div>` of buttons, which `for=` cannot address), makes it a `role="group"` with an `aria-label` instead. `paramRow` and `_row` call it for you.
- The properties panel is `--props-w` wide (320px) and its content text bottoms out at **11px**; only the bold, letter-spaced uppercase section eyebrows go smaller (10px). Several event-card rows are 5–6 column grids that only fit at that width — `.event-speed-row`, `.event-point-distance-row`, and the `70px` label column shared by `.event-row` / `.event-param-row` (which is why a param label longer than ~"Sollabstand" gets shortened and the long form moved to the input's `title`).
- **The Spawnpunkt grid is `.props-group.spawn-grid`, a 4-column `label input label input`** — X│Y and Z│Gier share a row, `#prop-init-speed` spans `2 / -1`. Plain `.props-group` (the type pickers) stays 2-column. The label columns are `max-content`, so hiding `Start (m/s)` for a prop visibly narrows column 1; that is the grid working, not a bug. `#prop-z-auto` beside the Z field re-derives z via `ObjectsManager.surfaceZFor` — the only way back to the surface height after typing a z by hand, short of moving the object. It is a button and **not** a live "auto/manuell" badge on purpose: the derived value comes from `_nearestLaneProjection` (a linear scan over every lane segment) and a body drag re-renders this whole panel on every `mousemove`.

## Maps

- Bundled towns live in `maps/<Town>/<Town>.xodr` (plus optional `.jpg` thumbnail and `_summary.json`), auto-discovered by `_scan_xodr_paths` at import time.
- Uploaded maps persist to `maps/_uploaded/*.xodr` and are re-parsed into `MAP_CACHE` on every startup (`backend/main.py:44-68`); a bad file logs a failure for that town without taking down the server.
- `maps/` is **not** gitignored — uploads land in the working tree.

## The in-editor preview (`frontend/js/simulate.js`) and the cached CARLA lane graph

The Play/Pause/Stop preview is a per-tick kinematic re-implementation of the real controllers
(`SimpleVehicleControl` / `PedestrianControl`), not an idealisation of the authored events — it
evaluates all 4 real triggers (including the `distance_to_ego` 60 s OR-fallback and the
`assign_route`/`after_event` trigger rewrites `backend/scenario_io.py` applies at export), and
mirrors real termination semantics (an instant speed step that persists past its duration, a
4 m/1 m waypoint-acceptance radius, a dead stop on `_reached_goal`). `set_distance` is
deliberately not simulated (badge only) — see the plan below for why.

**A relative `set_speed` tracks its reference continuously, it does not sample once.**
`ChangeActorTargetSpeed.update()` re-reads `get_velocity(relative_actor)` and rewrites the
controller's target on **every** tick, and does so **before** the duration test — so the
final tick of the window still tracks and the controller then holds that last tracked value
forever. `continuous` governs only whether duration/distance may *end* the atomic, and the
editor always exports `continuous='false'`, so the follow is bounded by `dynamics.value`
seconds. Three consequences the preview reproduces exactly:

- Reference speeds are snapshotted once per tick (`_snapshotSpeeds` / `_refSpeed`), the same
  trick as `egoPrevPos` and for the same reason — `CarlaDataProvider`'s velocity map is
  refilled once per world tick, so no atomic reads another actor's *live* mid-tick speed and
  actor iteration order cannot matter. An unresolvable ref is a silent `0`, matching
  `get_velocity`'s own fallback; an omitted one falls back to the ego, matching the `"hero"`
  default `_entity_ref` applies at export.
- Only a **longitudinal** command cancels a running tracker (`get_last_longitudinal_command()`).
  Another `set_speed` does, and so does `follow_trajectory` — its parser branch builds its own
  `ChangeActorTargetSpeed` in a Sequence. `assign_route` and `lane_change` do **not**: they
  issue waypoint commands only, stamped on a separate `_last_waypoint_command`, so a tracker
  keeps running right across them. `_supersedeSpeedEvent` is the single place this is applied.
- `SimpleVehicleControl._reached_goal` is sticky — `run_step` returns zero velocity from then
  on whatever target the atomics keep writing. `sim.goalStopped` mirrors it so a tracker cannot
  drive a route-finished actor off again. (Still divergent, and pre-existing: a *later*
  `set_speed` event does move a goal-stopped actor in the preview, where CARLA would not.)

A negative `ref.speed + delta` is deliberately left unclamped, matching the atomic.

**All of that is the `time` dimension. `rate` is a different atomic branch, and it
cancels the continuous tracking above.** `initialise()` commands `_start_speed` rather
than the target (so there is no step at all) and snapshots `_target_speed` once; `update()`
still re-samples the reference every tick, but the rate branch **overwrites that write** with
`start_speed ± rate·elapsed` clamped at the snapshot, then reports SUCCESS on arrival. So a
relative `set_speed` with a rate is a one-shot ramp to *(reference speed at trigger time +
delta)* and never follows anything. The preview reproduces this by clearing
`sim.speedRelativeRef` when the dimension is `rate` — that is the real semantics, not a
simplification. `speedRampFrom`/`speedRampTarget` hold the snapshot, and
`_supersedeSpeedEvent` clears them so a later longitudinal command stops the ramp.

`_makeSimActor` seeds `sim.speed` from the actor's `initial_speed` rather than from 0,
which is the whole of the Init-`<SpeedAction>` mirror: every existing overwrite path
(`set_speed`, `_avgTrajectorySpeed` on a trajectory) already reproduces "replaced by the
first Story speed action" without any special case,
because that is literally what `BasicControl.update_target_speed` does. Consequences
worth expecting: an `assign_route` actor with an init speed now drives its route
immediately instead of sitting still, and an actor with no waypoints starts
lane-following on tick 1, so the "Pfad ab hier unbekannt" freeze can fire earlier than
it used to. An `events: []` actor keeps its init speed for the whole run — it gets no
Act, so nothing ever overwrites it, in the preview and in CARLA alike; the preview
badges it (`Kein Event — fährt nur mit Startgeschwindigkeit` / `steht still`).

The one thing a lightweight preview cannot compute from the `.xodr` alone is **fork order** —
which successor `waypoint.next()` returns first when a lane genuinely has more than one. That is
a fixed property of a given map + CARLA build, so for the 8 bundled towns it is probed once
against live CARLA and cached rather than guessed. Predecessor/successor/left-right topology
*itself* — everything short of ranking a genuine fork — turns out to be fully derivable from the
`.xodr`'s own `<link>`/`<junction>` elements without CARLA at all; `backend/lane_graph_builder.py`
does exactly that for every town that has no CARLA probe (see below), which is most of what makes
`assign_route`/`lane_change` work at real lane-following fidelity on an uploaded map.

- **`tests/probe_carla_lane_graph.py`** connects to a running CARLA (`localhost:2010` by
  default — the `run.sh` instance, not the port-3000 one the older mesh/prop probes use) and,
  per bundled town, constructs the real `agents.navigation.global_route_planner.GlobalRoutePlanner`
  — the **same class** `atomic_behaviors.py` builds for `AssignRouteAction` and
  `KeepLongitudinalGap` — then dumps its private `_graph`/`_id_map`/`_road_id_to_edge` straight
  to JSON, so the frontend never has to reimplement topology extraction, only A* search and path
  reconstruction. It also samples a per-lane-section table (left/right neighbour, `lane_change`
  permission, ordered `next()` successors) via `generate_waypoints()` + `get_left_lane()`/
  `get_right_lane()`. Needs the `carla-venv` environment (see `tests/README.md`'s CARLA-probes
  section for the exact `PYTHONPATH`) — this repo's own `.venv` has no `carla` package.
  **Town10 has no CARLA counterpart** (`client.get_available_maps()` only has `Town10HD`; Town10
  is a custom georeferenced map with no CARLA content asset) and is skipped.
- Output is committed as `maps/<Town>/lane_graph.json`. `backend/main.py`'s `LANE_GRAPH_CACHE` is
  populated from one of **two sources per town**, decided once at startup (and once more, per
  town, at upload time): a committed probed file if one exists on disk, otherwise
  **`backend/lane_graph_builder.py`'s `build_lane_graph_from_xodr`**, which derives the identical
  JSON shape straight from the `.xodr` — no live CARLA needed. This covers Town10 and every
  uploaded map, which previously had no lane graph at all. Served from
  `GET /api/maps/{town}/lane_graph` (404 only if the .xodr itself failed to parse or the builder
  threw). `GET /api/maps` lists every town with one (`laneGraphs`) — nearly all of them now, so
  the frontend (`toolbar.js`'s `_fetchLaneGraph`) just always attempts the fetch rather than
  gating on a town list, which would otherwise go stale the moment a map is uploaded mid-session.
  The one field that tells the two sources apart is **`source`**: `"xodr"` on a derived graph,
  absent (frontend reads this as `"carla"`) on a committed probed file — `simulate.js`'s badges
  say "aus Kartendatei" vs "CARLA-Kartendaten" accordingly, and `_preferredSuccessor` (below)
  branches on it.
- **`tests/compare_xodr_lane_graph.py`** validates the from-`.xodr` builder against all 8
  committed probed files with no CARLA connection needed — run it after touching
  `lane_graph_builder.py`. Two things it deliberately does *not* treat as a mismatch, confirmed by
  hand-tracing real examples before the check was written this way: a probed file's
  self-referencing `successors` entry (its own dead-end marker — `_walk_to_fork` gave up after
  `max_hops`) is filtered out the same way `LaneGraph.realSuccessors()` filters it on the
  frontend; and the probe's `successors` field is the result of CARLA silently walking through a
  chain of single-choice lanes until the next *real* fork (confirmed: a 0.11 m junction-approach
  stub, Town05 road 31, never appears as its own hop in any committed file), whereas this
  builder's `successors` is deliberately one physical hop at a time — so a "mismatch" only counts
  as a bug if the probed successor isn't reachable by chasing this builder's own hops forward a
  bounded number of steps. Left/right and reachability currently check out at 100% across all 8
  towns; exact 1-hop `successors` equality does not, and is not expected to.
- **The join key everywhere is `(roadId, sectionId, laneId)`** — CARLA's own identity triple,
  matched against the render JSON's `sectionId`/`sStart`/`sEnd` additions above. This was
  cross-checked empirically (Town03 road 1772) before anything was built on it; if a future
  `.xodr` re-bundle or CARLA upgrade breaks the assumption, lookups fail closed (return `null`)
  rather than silently misattributing a lane — see `frontend/js/laneGraph.js`'s `laneRecord`.
- **`frontend/js/laneGraph.js`** is the frontend half: a plain-array A* (`_astar`) over the
  cached graph, `route(graph, from, to)` (ports `GlobalRoutePlanner.trace_route`'s waypoint
  reconstruction, not its `RoadOption` turn-decision metadata — nothing here needs it, the
  controller only drives through waypoint *locations*), and `laneRecord`/`realSuccessors` for
  the per-lane table. Everything degrades to `null` when `AppState.laneGraph` is absent; nothing
  in this file guesses.
- `simulate.js` uses the graph for exactly three things, each with a phase-1 geometric fallback
  when it is absent or a specific lookup misses:
  - **`assign_route`** — a real multi-segment A* route through every authored waypoint (one
    `LaneGraph.route` call per consecutive pair), replacing the raw clicked polyline, followed
    by the runtime's own filter (see "Two halves" below). Leg 0's start is **not** the actor's
    own position: real `AssignRouteAction` seeds from
    `map.get_waypoint(actor_location).next(1)[0]`. **`.next(1.0)` means "1 m further along the
    road"** — it stays in the current lane and crosses into a successor only if the lane
    actually ends within that metre, which is what `_seedAssignRouteStart` reproduces by
    walking `_walkDirLine` 1 m and consulting `_preferredSuccessor()` only when it `ranOut`.
    Reading the cached `successors` list from an arbitrary mid-lane position instead means "what
    follows this lane's *entire remaining length*", which puts leg 0 on the wrong lane
    entirely. That mistake shipped once and looked like a normal one-way detour until the seed
    point was checked.
  - **`lane_change`** — `_buildLaneChangePlan` (`simulate.js`) ports
    `generate_target_waypoint_list_multilane` (`scenario_helper.py`) literally: 3 same-lane
    waypoints every 2 m, **one** waypoint `dynamics.value` m ahead projected onto the
    `get_left_lane()`/`get_right_lane()` neighbour (the entire lateral move is this single hop —
    CARLA does not interpolate a curve here either, so `dynamicsShape` is dead: ScenarioRunner's
    parser never reads it), then 5 target-lane waypoints every 2 m. The plan is driven through the
    ordinary `_advanceWaypoints` path like any other waypoint list, not a bespoke phase machine —
    which is also why its 4 m acceptance radius and leading-waypoint drop apply here for free.
    Each of the three legs walks via `_walkLaneChained`, which chains across a lane-section
    boundary using the same cached-graph successor lookup `_continueLaneFollowAtFork` uses for
    plain lane-following (`_nextLaneCursor`, shared by both) — a short lane section mid-maneuver
    used to freeze the actor with "Zielspur endet zu früh" because the old per-phase walker never
    consulted successors at all. The neighbour lookup (`_laneNeighbor`) happens once, at the
    single point in the maneuver the real code calls `get_left_lane()`/`get_right_lane()`: on the
    waypoint `dynamics.value` m past the same-lane leg, not at the lane-change event's trigger
    point or at the actor's pre-maneuver position. **If the graph confidently reports no
    neighbour on a side, that is trusted outright** over the geometric guess —
    `get_left_lane()`/`get_right_lane()` are relative to the lane's own OpenDRIVE numbering
    convention, not screen-left/right, and a real map has been observed where a
    `laneChange="Both"`-marked lane's `get_left_lane()` still returns nothing on one side. Trust
    the API CARLA's own atomics trust, not a geometric intuition about which way looks like
    "left". A `_buildLaneChangePlan` returning `null` (no graph, a genuine dead end, or no
    Driving neighbour) freezes the actor exactly as `generate_target_waypoint_list_multilane`
    returning `(None, None)` makes `ChangeActorLateralMotion.update` report `FAILURE`.
  - **Path-less driving** (an actor with speed but no waypoints) — on reaching the end of known
    `directionLine` geometry, `_continueLaneFollowAtFork` calls `_nextLaneCursor`, which asks
    `_preferredSuccessor` for the one successor to advance onto. On a CARLA-probed graph any
    non-empty `successors` list is usable — index 0 is `next()`'s own real fork choice, exactly
    mirroring `SimpleVehicleControl`'s own `map_wp.next(2.0)[0]`. On an **xodr-derived** graph
    (`graph.source === 'xodr'`) there is no such ranking to trust — a bare `.xodr` doesn't order a
    fork's `<connection>` candidates — so `_preferredSuccessor` refuses to guess and returns
    `null` whenever a lane has more than one successor, freezing the actor with the same badge a
    genuine dead end gets, rather than picking an arbitrary branch. An `assign_route` waypoint
    past the fork is unaffected either way: `LaneGraph.route()`'s A* already holds every candidate
    as a real edge and finds whichever branch reaches the target, without consulting
    `successors[0]` at all. A successor that names its own lane back (`_walk_to_fork`'s bounded
    search giving up at a genuine dead end, CARLA-probed graphs only) is treated as no successor,
    not an infinite loop — `LaneGraph.realSuccessors()` filters it before `_preferredSuccessor`
    ever sees it.
- **Risk accepted on purpose:** a committed probed file is pinned to this CARLA/ScenarioRunner
  build and this exact `.xodr`; a re-probe needs re-running `probe_carla_lane_graph.py` and a
  server restart, same caveat as `MAP_CACHE`. An xodr-derived graph carries no such pin — it's
  regenerated from whatever `.xodr` is on disk every time it's (re)built — but inherits the
  fork-order gap above, permanently: there is no live CARLA behind it to resolve one.

**Two halves: routing a route is not enough.** `GlobalRoutePlanner.trace_route` genuinely emits
points that double back, and the runtime throws them away before the actor ever sees them. Both
halves must be ported or the preview shows a turn-around CARLA never performs:

- `LaneGraph.route` (the router) carries a running `current` across **every** edge and trims each
  lane-follow edge to start at the point nearest it; emits a lane-change edge as exactly **two**
  points (a bare ~12 m chord, `closest_index + 5` into the target lane, no interpolation); and
  honours both destination break conditions so a leg stops near its goal instead of running to
  its final edge's exit. Trimming only the first edge, or treating a lane-change edge as a
  lane-follow one, makes every later edge restart at its own beginning — behind the actor.
- `_exactRoute` (the atomic) then applies `ChangeActorWaypoints`' filter to the **concatenated**
  route: a `> 1.0 m` dedup, and a heading test that accepts a point only when
  `|new − last| < 2.0` **or** `> 4.3` rad. That difference is deliberately **not** wrapped to
  [0, π] — the `> 4.3` arm is what catches wrap-around — so port the arithmetic literally rather
  than "fixing" it. The reference heading is `route[-1] − route[-2]`, unless that vector is
  `< 0.5 m` (accept unconditionally) or the route has ≤ 1 point, where it is the **lane tangent
  at the seed**, not a router chord.

`tests/test_route_fidelity_e2e.py` pins this. It asserts on the computed route itself, not only
on sampled motion, because the 4 m waypoint-acceptance radius can swallow a short backtrack —
with the heading filter disabled the route assertion goes red while the animation check still
passes.

See the "In-editor preview fidelity" plan (project plan history) for the full per-action/
per-trigger analysis this was built from — phase 1 (the correctness pass above the fold) and
phase 2 (this section) are both implemented; `set_distance` remains out of scope by decision.

## Repo notes

- `README_UPDATED.md` is a second, newer README coexisting with `README.md`. Check both before assuming docs are stale.
- `generate_pptx.py` and `frontend/presentation.html` are the project slide deck, served by `GET /api/presentation.pptx` (which shells out to the script). Unrelated to editor functionality.
- Exports are written to `/tmp/` and removed by a `BackgroundTask` after the response is sent (`backend/main.py:154-159`).

## Verification

```bash
bash run.sh                      # startup log lists each town + road count + elevation range, ends "Map cache ready."
curl -s localhost:9090/api/maps  # → {"maps": [...]}
```

Then in the browser: place an ego, add a `follow_trajectory` event to it, add an NPC with a `set_speed` event, and click **Export .xosc**. At least one actor must have an event — a scenario where nothing does is rejected with a 400. This is the only path that exercises the `llm-scenario-gen` dependency. Check the export: `grep -c external_control` on the file must be `0`, and `grep -A2 'Controller name="HeroAgent"'` must show `simple_vehicle_control`.

For props, also open **Requisiten**, place a few cones (the tool stays armed), place a barrier on each carriageway of a two-way road, and export. In the `.xosc` check that each prop has a teleport-only `<Private>` with **no `ControllerAction`**, that `miscObjectCategory` is `obstacle` on everything except `streetbarrier`, and that the two barriers' `h` values differ by 180°.

**Rotation can only be verified in CARLA**, not from the `.xosc`: a wrong `yaw_offset` produces a file that looks entirely correct. Run it with:

```bash
SCENARIO_FILE=/abs/path/scenario.xosc bash /home/dellpro2/Antonio/run.sh
```

**The ego drives itself now — there is no `SCENARIO_GOAL` and no external agent.** `run.sh` starts CARLA on port **2010** (if not already up) and runs `/home/dellpro2/yungloon/llm-scenario-gen-xosc/scripts/run_selfref_video_test.py`, which drives `scenario_runner_xosc.py` from a separate `scenario_runner-0.9.15` install and records FPV/THD/BEV video.

**There are two ScenarioRunner checkouts on this box and they do not agree — check which one you are editing.** `/home/dellpro2/Antonio/run.sh` executes **`/home/dellpro2/Antonio/scenario_runner`**: it `cd`s there and runs that repo's own `scripts/run_selfref_video_test.py`, which hardcodes `SCENARIO_RUNNER_ROOT` to the same path and `Popen`s its `scenario_runner.py`. `tests/run_carla_cases.py` drives the *same* `run.sh`, so both paths now exercise one install and **`/home/dellpro2/yungloon/scenario_runner-0.9.15` is imported by neither** — only the CARLA server binary and the `agents.navigation.*` package come from yungloon (`CARLA_ROOT=/home/dellpro2/yungloon/carla-0.9.15`). Their `atomic_behaviors.py` differ by ~1985 lines, and the yungloon copy is the **locally patched** one (`CHANGES_LOCAL.md` there records it): its `ChangeActorWaypoints.initialise` filters the router's output with a `> 1.0 m` dedup **plus a heading band that drops reversals**. The install `run.sh` actually runs applies only the dedup — so **`simulate.js`'s `_exactRoute` heading filter (`ROUTE_HEADING_ACCEPT_LO`/`HI`) currently models an install nothing here executes**, and an `assign_route` actor under `run.sh` can still visibly drive backwards where the preview says it will not. Both resolve `agents.navigation.global_route_planner` to `/home/dellpro2/yungloon/carla-0.9.15/PythonAPI/carla/agents/navigation/`, and the GRP is the `CarlaDataProvider` singleton at sampling resolution **2.0** — the value `probe_carla_lane_graph.py` matches. It takes only `SCENARIO_FILE` — no `--goal` flag exists in this script, and it never launches `automatic_control_1.py` or any other external agent. Every ego manoeuvre — where it goes, when it speeds up, whether it turns at a junction — is now **authored in the editor as an event on the ego**, exactly like an NPC's, and reaches the file as the ego's own `heroBehavior` Act. Without a `follow_trajectory`/`assign_route` event the ego has no plan and drives its spawn lane via `SimpleVehicleControl`'s own `map.get_waypoint(...).next(2.0)` walk, which will not turn at a junction — that is expected, not a bug, and it is why junction/turn scenarios need a path event.

**`set_speed`'s `rate` dimension only works because of a local patch to those two checkouts.** A third checkout, `/home/dellpro2/Antonio/scenario_runner_github`, is **stock 0.9.15** and is executed by nothing here — it is useful precisely as the reference for what is and is not upstream. Both `/home/dellpro2/Antonio/scenario_runner` (what `run.sh` runs) and the yungloon copy carry a `rate` branch in `openscenario_parser.py`'s `SpeedAction` block plus a `rate=` parameter and ramp in `ChangeActorTargetSpeed`; stock has neither. **On stock, `dynamicsDimension="rate"` falls into the `else` and the value is read as a duration in seconds** — a clean file that silently does the wrong thing, not an error. If an export is ever run against an unpatched ScenarioRunner, that is where a "the ramp did nothing" report comes from. Verify with:

```bash
grep -n 'dimension == "rate"' /home/dellpro2/Antonio/scenario_runner/srunner/tools/openscenario_parser.py
```

**Nothing on `run.sh`'s path validates the `.xosc` against the OpenSCENARIO XSD any more.** The `scenario_runner_xosc.py` install that did is no longer what `run.sh` invokes (see above), and `/home/dellpro2/Antonio/scenario_runner` has no XSD check. The mismatch that validator caught is still in the emitter: `event_builders.py` writes `<Vertex relativeTime=...>` where the strict schema wants `time`. Its parser reads `relativeTime` (`openscenario_parser.py:1404`), so a `follow_trajectory` scenario now runs where it used to be rejected outright — do not read a clean CARLA run as evidence the file is schema-valid.

You can still validate by hand — the schema is on this box and `xmllint` is installed, and current exports do pass:

```bash
xmllint --noout --schema /home/dellpro2/Antonio/scenario_runner/srunner/openscenario/OpenSCENARIO.xsd export.xosc
```

Use a scenario **without** a `follow_trajectory` event, or the pre-existing `<Vertex relativeTime=…>` defect above is all you will see.

**A storyboard Act needs at least one `<ManeuverGroup>` before its `<StartTrigger>`** — the OpenSCENARIO XSD requires it, and `_inject_traffic_signals`'s fallback (`xml_builder.py`) used to create an empty `ScenarioBehavior` Act unconditionally whenever a scenario had zero NPCs and zero traffic signals. That was harmless under a parser that doesn't validate structure (an empty `ManeuverGroup` loop is a no-op), but is a hard failure under one that does, and an ego-only scenario — no NPCs at all — is now an entirely normal shape to export. Fixed by only creating that Act when there is something to put in it.

`tests/` holds four layers — backend normalization, props, templates, events, actor types, elevation, and the Loop2Scenic benchmark cases — see `tests/README.md`:

```bash
bash run.sh 9090                 # terminal 1
bash tests/run_tests.sh          # terminal 2 (EDITOR_URL overrides the target)
```

That runs `test_normalization.py` (101 checks, no browser or server needed), then `compare_xodr_lane_graph.py` (also no browser/server/CARLA — validates `backend/lane_graph_builder.py` against the 8 committed probed graphs), then the eight Playwright suites: props (54), prop yaw (23), templates (159), events (60), ego events (68), actor types (260, grows with the catalogue), elevation (33), route fidelity (9). All but the first two drive a real browser against a real server and a real export. **Restart the editor first if you changed `../llm-scenario-gen`** — otherwise the frontend shows new catalogue data while the backend exports the old, which looks like a test bug and is not one.

`test_ego_events_e2e.py` is kept separate from `test_events_e2e.py` rather than folded in: the older suite's `EGO` fixture and every one of its assertions assume an inert ego (no events), which was true before the ego became a controllable actor and is the entire premise the new suite tests against.

`Checks.known_issue()` (`tests/_harness.py`) is still there and still unused by any suite: it exists so an open defect can stay visible without making the exit code permanently non-zero, reporting `KNOWN` while it fails and `KFIXED` once fixed — which is the cue to promote it to a normal check. Its one user was `test_events_e2e.py`'s dangling-`storyboardElementRef` defect, now fixed and asserted normally (see "An event the emitter would drop").

### CARLA behavioural tests

**This section, and `tests/run_carla_cases.py`/`tests/carla_cases.py` themselves, describe the pre-ego-authoring world and have not been re-baselined yet** — deliberately deferred, a separate piece of work. Two things changed underneath them: `SCENARIO_GOAL` is dead in the current `run.sh` (it runs `run_selfref_video_test.py`, which has no `--goal` and launches no external agent — dead independently of anything below), and the ego now drives via its own authored events rather than a planner. Every case's ego is currently `events: []` (an editor default, never a literal in the harness), which — now that an event-less actor gets **no Act at all** — means **every case's ego sits still**: it has no events, and no `initial_speed` either, so nothing ever commands it to move. That is the third revision of this paragraph and the second reversal: before the ego became authorable it was driven by an external planner, then briefly it drove off on the `constant_speed` fallback, and now it is stationary unless the case gives it an event or a start speed. All 28 cases need re-running and their assertions re-checked before this section can be trusted again; treat every specific claim below about ego motion as describing the old, planner-driven behaviour until that happens. A second, independent change adds to the same debt: NPC Acts no longer wait for `hero traveled 0.1 m` before starting (see the two-clocks paragraph below), so timings measured relative to that gate have shifted too.

None of the 28 cases is *blocked* by the new "something must have events" rule — the 7 that state no `events` are all `kind: template`, and every template produces events at placement — but every case's ego needs an authored event (or an `initial_speed`) before its ego-motion assertions can mean anything again.

`tests/carla_telemetry.py` is a **passive** sidecar: it attaches to the running CARLA, subscribes with `world.on_tick`, and writes one CSV row per actor per tick. It **must never call `world.tick()`** — ScenarioRunner owns the clock in synchronous mode. Names must be captured while actors are alive (a background poller does this); resolving them after the run returns blanks, because teardown has already destroyed everything.

`tests/run_carla_cases.py` builds each scenario through the real editor, runs it via `/home/dellpro2/Antonio/run.sh`, and judges it against **two independent sources**:

- **ScenarioRunner's own log** — it prints `[OSC][<t>s][EVENT][<name>] RUNNING|END` for every storyboard element, which gives exact trigger-firing and completion times for free. This is the cheapest useful signal in the whole toolchain and needs no simulator introspection.
- **the telemetry CSV** — whether the actor actually moved as commanded.

Both are needed: an event can go `RUNNING` while the vehicle ignores it entirely.

The two clocks differ. Telemetry carries CARLA's `elapsed_seconds` (a world clock that keeps counting across runs and starts in the hundreds); the OSC log counts from scenario start. They used to be reconciled through the ego's first motion, because every NPC Act started on `hero traveled 0.1 m` — a leftover from the `external_control` era, when NPCs had to wait for evidence an external agent had taken the ego over. **That gate is gone**: every actor is authored and controlled inside the `.xosc` now, so every Act — hero's included — starts on `SimulationTime > 0` alone (`_add_act_start_stop_triggers`, `../llm-scenario-gen`). `act_start()` (`tests/carla_analysis.py`) still measures the ego's first 0.1 m of telemetry motion and still gives a usable time origin, but it is no longer the exact instant NPC Acts begin — they now start essentially at scenario start, not when the ego moves. This folds into the CARLA behavioural tests' existing re-baselining debt below, not a new one: every `expect_*` assertion measured from `act_start` needs re-checking against the new timing.

A case states **both ends of the ego's drive**: `ego` (the spawn, placed in the editor) and `goal` (passed through as `SCENARIO_GOAL`). `run_case` always sets `SCENARIO_GOAL`, falling back to `C.GOAL` (the Town01 pose) rather than letting run.sh's own default through — so **any case on another town must state one** — see `GOAL_T3` / `GOAL_T3_PARK` / `GOAL_T4_HWY` / `GOAL_T5_HWY` / `GOAL_T5_JCT_LEFT` / `GOAL_T5_JCT_STRAIGHT` in `tests/carla_cases.py`. The junction goals are real exit waypoints read off CARLA's junction API, not points guessed off a map, and they are the **only** thing that makes the ego turn: `expect_*` proves the turn happened by measuring the ego's net heading change (`A.heading_change`), because there is no storyboard event to read off the OSC log.

**Every case's actors also have no `initial_speed`, and that is deliberate.** They are seeded straight into `AppState` (or, for template NPCs, placed and then not touched), and both `_hydrateActor` and `_normalize_actor` default an absent `initial_speed` to `0` rather than to the editor's placement default of 10 — so no `<SpeedAction>` reaches Init and every case behaves exactly as it did before the field existed. Set one explicitly on a case that wants traffic already moving at t=0; do **not** "fix" the absence.

The ego and a seeded NPC are injected into `AppState` directly rather than placed by a click, so they do not get the editor's derived height for free. `run_carla_cases.py` calls `ObjectsManager.surfaceZFor(...)` for both; an `ego` dict may override with its own `z`, which `EGO_T3` (3.13, on road 67's 2.63 m rise) and `EGO_T3_PARK` (0.5, ground level) do because those numbers are the point of the case. Template-placed NPCs go through the real click path and need nothing. **Never reintroduce a literal `z` here** — a flat 0.2 is what put `tpl-lane-change` under the road.

```bash
.venv/bin/python3 tests/run_carla_cases.py                    # all 28, ~12 min
.venv/bin/python3 tests/run_carla_cases.py tpl-stopping       # one case
```

Cases come in four families by name prefix: `tpl-*` (6, the templates), `evt-*` (4, event mechanics), `act-*` (2, the newer actor types) and `bench-*` (16, the Loop2Scenic benchmark — see below). A case declares one of three `kind`s: `template` (real template button + real map click), `events` (one NPC seeded straight into `AppState`, for exact numbers) or `scene` (several NPCs and/or props). In a `scene` the **npcs array order is the entity-ref order** — `buildScenarioParams` names them `adversary`, `adversary1`, … by index — and props go through `H.place_prop`, a real toolbar tile and a real click, because `_propYawFor` and `surfaceZFor` only run on the placement path. `H.zoom_at` wheels in over the target and symmetrically back out, since at whole-town zoom a Playwright click quantises to ~0.4 m against a 3.5 m lane.

Each case leaves `tests/artifacts/<case>/scenario.json` — `AppState.toJSON()` captured in the browser just before the export, i.e. the editor's own save format. Load it with **Laden** to reopen a failing case (map, ego, NPC, full event chain) and edit from exactly the state the `.xosc` beside it was built from. Anything else the harness wants out of `AppState` has to be grabbed inside `build_scenarios`, which closes the browser before the first CARLA run.

**A scenario whose storyboard never completes leaves `scenario_runner` alive** even after it prints `No more scenarios .... Exiting`, and `run.sh` then blocks forever in `wait`. An orphan keeps ticking CARLA underneath the *next* case, whose distance triggers then fire off the 60 s `TimeFallback` instead of their real condition — which reads as a trigger bug and is not one. `run_carla_cases.py` guards this with a per-case timeout, `start_new_session` + `killpg`, and a `pkill` sweep on both sides of every run. If you drive `run.sh` by hand, check for stragglers yourself.

**A `lane_change` needs a same-direction neighbour lane, and Town01 has none.** ScenarioRunner's `ChangeActorLateralMotion` only succeeds once the actor has driven `distance_other_lane` (hardcoded to 10 in `openscenario_parser.py`) *in the target lane*, and it never fails except on an empty plan — so an unreachable target lane is the commonest way to produce the hang above. On Town01 road 1, where the fixed ego pose puts everything, CARLA reports `lane_change=NONE`: the left neighbour is the oncoming carriageway and the right is a shoulder. **Lane-change scenarios must use a multi-lane road** — the `tpl-*` cases use Town03 road 67 lane -2 (144 m straight, `lane_change=Left`, lane -1 alongside) and the `bench-*` cases use **Town05 roads 36→37**, a three-lane one-way carriageway at y = -200.52 / -204.02 / -207.52 with ~120 m of straight, `lane_change=Both` on the middle lane, and therefore a legal target in either direction (it climbs from z=0 to z=10, which is why nothing there states a literal z). Town03's 75 parking lanes are *not* an alternative: every one borders a single driving lane, so pulling out of a parking spot dead-ends the same way. A merge does **not** have to be a `lane_change` at all: `bench-highway-cut-in` runs on **Town04 road 44 → connector 1194 → road 39 lane 6**, a real loop on-ramp feeding the ego's own lane at x ≈ -68, and gets the merge from an `assign_route` down the ramp instead (z climbs 4.95 → 10.6 there, so again nothing states a literal z). This cannot be caught before export — which lane an actor occupies when the change fires depends on every earlier event in its chain, so validating it statically would mean simulating the chain.

**Without waypoints, the two actor controllers get their direction from completely different places** — and neither failure mode shows up in a speed trace. `PedestrianControl.run_step` sets `control.direction` from the actor's *spawn heading* on every tick, so a walker with only `set_speed` events walks its init `h` forever; the editor's `_roadFacingYaw` (perpendicular to the lane) is the only thing that makes a crossing a crossing, and anything that overwrites that yaw silently converts it into a walk down the carriageway. `SimpleVehicleControl.run_step` ignores heading altogether and builds its own plan from `map.get_waypoint(...).next(2.0)`, i.e. snaps to the nearest lane and drives along it regardless of facing. **`cyclist` aliases to `bike`, a vehicle**, so `cyclist-crossing` cannot cross at all while it is built on `set_speed`; it needs `follow_trajectory` waypoints, which both controllers do honour. `tests/carla_cases.py` `expect_cyclist_crossing` carries that as an EXPECTED-TO-FAIL marker.

**A `distance_to_point` trigger's `z` is part of the radius.** ScenarioRunner evaluates `DistanceCondition` through `calculate_distance` → `location.distance(other)`, which is **3-D**. On a graded corridor a point left at the `0.2` default is not merely imprecise: on Town04's on-ramp, where the deck is 7.7–9.8 m up, the whole radius sits below the road and the condition can *never* become true. The editor derives point z on the click (`_setTriggerPoint` → `groundZAt + SPAWN_CLEARANCE.waypoint`, `frontend/js/objects.js`); a seeded case gets the same treatment from `SEED_EVENTS_JS` in `run_carla_cases.py`, which also covers route waypoints and trajectory vertices. **A case must never write a literal `z` — anywhere, including inside a trigger point.** The failure looks like a broken `entity_ref`, not a wrong height.

**A route on its own does not move an actor.** `AssignRouteAction` becomes `ChangeActorWaypoints`, which sets waypoints and nothing else, and `BasicControl._target_speed` stays `0` until a speed action lands. (`FollowTrajectoryAction` is the exception — `openscenario_parser` derives a target speed from the trajectory's `relativeTime` values.) That is usable rather than merely annoying: it is how `bench-highway-cut-in` parks a car on the on-ramp with its route already assigned and releases it on the ego's approach.

**Any actor with `events: []` gets no Act and therefore never moves under its own storyboard, the ego included** — it holds its `initial_speed`, which every case here omits, so it stays put. This reverses the older behaviour, where the same actor fell back to a `constant_speed` chain: a "parked" car in a bench case covered 226 m before that was caught. An actor that *has* events but must stay put still needs an explicit `set_speed 0` — `_parked()` in `tests/carla_cases.py`.

**Traffic lights are emittable but not obeyable.** `AppState.trafficSignals` → `_inject_traffic_signals` really does emit a `TrafficSignalStateAction`, so a signal's state can be forced. But an actor on `simple_vehicle_control` **ignores traffic lights entirely** — the ego included, now that it uses the same controller with the same bare `module` property and no `consider_trafficlights` argument — so running a red is free and light-abiding traffic is impossible for the ego or an NPC. That constrains every signalised-junction scenario and it is a ScenarioRunner limitation, not an editor one.

Because of the above, `run_carla_cases.py` overrides a template-placed actor's yaw **only when the case sets `npc_yaw`**. The in-lane vehicle cases pin it to 180 (spawn-point yaw can face back up the road); the crossing cases deliberately omit it and keep what the editor computed. A blanket default there is what made all three crossing cases run parallel to the road while passing every check. `_crossed_the_road` now asserts the direction — Town01 road 1 runs due east-west, so along-the-road is world x and across is world y, and `A.lateral_offset` is the wrong tool (it projects into the actor's own frame, where a crossing reads as longitudinal).

### The Loop2Scenic benchmark suite

`tests/bench/` holds the extracted [Loop2Scenic](https://yuangao-tum.github.io/loop2scenic-bench/) index (all 250 scenarios, `extract_bench.py` + `benchmark_index.{json,csv}` + `tag_census.csv`) and **`COVERAGE.md`, which is the answer to "what can this editor actually express?"** Read it before claiming a scenario shape is or is not supported. Sixteen benchmark entries are rebuilt as `bench-*` CARLA cases; each quotes its source description verbatim and names its fidelity delta.

- The datasheet is one ~10 MB page that inlines every card. Fetch it **raw** with curl — a summarising fetcher truncates it after §1 and the whole thing then looks unavailable. No headless browser or `benchmark_drive/` download is needed.
- **Only 150 of the 250 cards carry visible text.** The image-only and video-only splits keep their annotation solely in the card's `data-search` attribute, lowercased; those rows are flagged `desc_source="data-search"`.
- **The datasheet's own two censuses disagree** — §4's table says 50 types / 301 assignments, the §9 cards say 47 / 315, and 36 types differ in count. `tag_census.csv` records both. Select by card tag, weight by §4.
- Rollup, weighted by §4 mass (**stale — needs re-deriving**): 24% of the benchmark is covered by a green case, 30% partial with a named delta, 26% expressible but not yet built, **21% not expressible**. It blamed 9 of the 11 unreachable tags on two missing capabilities, one of which no longer holds: **ego-manoeuvre authoring** — *"the `.xosc` carries an ego spawn pose and nothing else, so every ego turn/swerve/exit is planner-chosen"* — is exactly what this change adds (the ego now takes `follow_trajectory`/`assign_route`/`set_speed`/`lane_change` events, same as an NPC). The rollup percentages and every per-tag "planner-chosen" delta in `tests/bench/COVERAGE.md` predate that and have not been recomputed. **`LaneOffsetAction`** remains genuinely missing (`LaneChangeAction` is discrete and needs a same-direction neighbour, so lane drift, partial-lane hazards, oncoming overtakes and parking exits are still out of reach).

Two measurement traps the bench cases added:

- **A cross-street actor triggered at act start clears the junction before the ego arrives** (measured on Town05 junction 1863: adversary in at t=1.0 s, ego at t=5.9 s). The paths cross in space and never in time, and every speed and geometry check still passes. Trigger on `distance_to_ego` and assert `closest_approach`.
- **Distance radii need margin for the corner a turning ego cuts.** A `distance_to_ego@35` missed by 0.6 m because a left-turning ego starts its swing before the junction centre; the condition never fired, the actor waited out the 60 s `TimeFallback`, and the run looked like a hang.

`tests/` also holds two CARLA measurement probes. `probe_carla_mesh_dims.py` is reliable and is where the catalogue's measured footprints came from. `probe_carla_mesh_facing.py` **is not trustworthy for `yaw_offset`** — it got several props 180° wrong. Determine rotation by running the scenario and looking at it.
