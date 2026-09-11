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
- **There is no linter and no CI**, and no unit tests. Automated coverage is `tests/test_normalization.py` (pure Python) plus ten Playwright end-to-end suites that need a running editor, and `tests/run_carla_cases.py`, which needs a running CARLA (see Verification). Everything else is verified manually.
- All map geometry is parsed once at startup into `MAP_CACHE` (`preload_maps`, `backend/main.py`). Changes to `map_renderer.py` only take effect on restart — `--reload` does this automatically on save.
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
  — `distance_to_ego` is **not offered for the ego itself** (see below), and
  `after_event` may name an event on **any** actor, not just its own (see below).

Adding or changing one means editing all three layers:

| Layer | File | Holds |
|---|---|---|
| UI | `frontend/js/eventPanel.js` | `EVENT_ACTIONS` / `EVENT_TRIGGERS` lists + per-action form rendering |
| Validation | `backend/scenario_io.py` | `_normalize_structured_event` (per-event) / `_normalize_actor` (per-actor) — whitelists, clamps, defaults |
| Emission | `../llm-scenario-gen/generator/event_builders.py` | the actual OpenSCENARIO XML (two-phase across actors — see the cross-actor `after_event` section) |

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
re-renders on an `activePathEventId` change to keep it current.

Silent behaviours worth knowing when debugging "my event did nothing":

- Unknown action/trigger strings are **silently coerced** to `follow_trajectory` / `simulation_time` rather than raising. The coercion is still silent, but its usual consequence no longer is: a typo'd action name coerces to a `follow_trajectory` with no waypoints, which is now a hard 400 (see "An event the emitter would drop" below) instead of an event that vanished.
- An `assign_route` action forces its own trigger to `simulation_time @ 0` (`backend/scenario_io.py`, mirrored in `frontend/js/scenarioIO.js`).
- An `after_event` trigger pointing at an `assign_route` event is rewritten to `distance_to_ego @ 400` — **on whichever actor owns the route**, see the cross-actor section below.
- A `distance_to_ego` trigger on an **ego-owned** event is rewritten to `simulation_time @ 0` — a distance from hero to itself is always 0, so the condition would fire on tick 1 regardless of the configured value. This coercion runs in `_normalize_after_event_chains` **after** the `after_event`→`assign_route` rewrite above, so a rewritten trigger on an ego event is caught too. `eventPanel.js` additionally omits the option from the trigger dropdown when the actor is the ego, and `event_builders.py`'s `build_start_event` / `_add_custom_event_start_trigger` fall back to `simulation_time` for `entity_name == 'hero'` as a third, defensive layer.
- **An event the emitter would drop is a hard 400, and the editor will not let you build one.** `_add_follow_trajectory_action` / `_add_assign_route_action` return `False` under 2 waypoints (and the latter also for a non-vehicle type), `build_custom_event_chain` then skips the whole event, and anything chained onto it with `after_event` is left pointing at a `storyboardElementRef` that is not in the file. Four layers now close that off, and the frontend three share one predicate — `ScenarioRules` in `frontend/js/app.js` (`actionEmits` / `eventProblem` / `problemsOf`), which `eventPanel.js` (warning chip + the `#event-warn` count), `scenarioIO.js` (`_validateScenario`) and `simulate.js` all call:
  - a path event is still **seeded with one waypoint on the actor's own pose** (`startPathMode`), so the *first* map click already completes a usable 2-point path — but it now **deletes itself** when draw mode ends still under 2 (`_discardIncompletePath`, `frontend/js/objects.js`, hung off the `AppState.on('change')` mode transition rather than the *Fertig* button, because Esc clears the flags directly in `mapView.js`). The seed alone was the old failure: below the emitter's minimum, invisible on the map (`mapView` skips a path under 2 points), and reported by the card as „Pfad gezeichnet".
  - **`Route zuweisen` is `disabled` for `pedestrian`/`child`/`cyclist`** — `AssignRouteAction` is vehicle-only (`_ROUTE_ACTION_TYPES`), and the grid used to offer it to everyone.
  - `validate_scenario_params` raises on both cases. `_ROUTE_ACTOR_TYPES` (`backend/scenario_io.py`) is a third copy of that type list and **must include the aliases that resolve to a routable type** (`lorry`, `moped`) — the emitter runs `_TYPE_ALIASES` first, so without them the backend rejects payloads the emitter accepts.
  - `build_custom_event_chain` builds its name table from the events that **actually got appended** (two passes: actions first, then triggers), so a chained `after_event` whose target was skipped now falls back to a plain `simulation_time` start instead of dangling. This was the long-standing `KNOWN` entry in `test_events_e2e.py`.
- **A `distance_to_point` trigger is never point-less.** Choosing it in the panel places the point on the acting actor immediately (`ObjectsManager.defaultTriggerPoint`) with a **5 m** radius (`DEFAULT_POINT_RADIUS`, `eventPanel.js` — a fresh radius rather than the outgoing trigger's value, which is a delay in seconds or a 400 m ego distance and means nothing here). A missing point used to be defaulted to `(0, 0, 0.2)` in `_normalize_structured_event` — the map origin, which a 3-D `DistanceCondition` can never reach — so that is now a 400 too; and in the emitter it fell through to `simulation_time(value)`, reading the radius in metres as a delay in seconds (a 20 m radius became `t > 20 s`). Both fixed. (The `?? 20` fallbacks left in the frontend and `_normalize_structured_event`'s `trigger.get("value", 20.0)` are for a payload carrying no value at all, and still agree with each other — only the *creation* default is 5.)
- **The point is moved by dragging its map marker; there is no picking mode.** `layer-trigger-points` is appended **after** `layer-actors` (`renderMap`, `mapView.js`, last of the three top layers — `layer-paths-top` and `layer-actors-top` go before it) rather than under the trajectory layer, because a point seeded on its own actor would otherwise be drawn *and hit-tested* under the vehicle rectangle. The marker carries an invisible 2.2 m hit circle (`.trigger-point-control`) — the drawn one is 0.7 m and sub-pixel at town zoom — and its drag writes x/y per mousemove but re-derives z once, on mouseup, via `ObjectsManager.moveTriggerPoint` (`_nearestLaneProjection` is a full lane scan; same reasoning as an actor's z). The mouseup also **expires** `_suppressNextClick` on a timer: the marker is re-rendered mid-drag, so the element the drag started on is detached by mouseup and the browser may dispatch no click at all — a permanently-set flag then swallows an unrelated map click much later.
### `after_event` may name another actor's event, and may never form a loop

An `after_event` trigger carries `event_id` **plus an optional `actor_ref`**.
An absent `actor_ref` means the event's own actor, which is why every save file,
template, `tests/carla_cases.py` case and LLM payload written before this
existed resolves exactly as it always did — that default is the compatibility
contract and is implemented identically in all four layers.

**It works in CARLA because the lookup was never per-Act.** ScenarioRunner turns
a `StoryboardElementStateCondition` into `OSCStartEndCondition`, which reads a
**global** `py_trees` blackboard key — `(EVENT)<name>-END`, written by
`StoryElementStatusToBlackboard.terminate`. Every Act starts on
`SimulationTime > 0` and holds its events in a `Parallel(SUCCESS_ON_ALL)`, so
every event's start condition is already ticking when any other actor's event
completes, and `OSCStartEndCondition`'s `element_start_time >= self._start_time`
test is satisfied. Nothing in ScenarioRunner had to change; the constraint was
entirely ours.

- **The emitter builds in two phases across ALL actors.** `build_custom_event_chain`
  (`../llm-scenario-gen/generator/event_builders.py`) used to resolve its own
  triggers from a name table keyed by `event_id` and scoped to one actor. It now
  takes a shared `event_names` dict keyed by **`(entity_name, event_id)`** and a
  shared `pending_triggers` list; `build_xosc` threads both through
  `_inject_npcs` and `_inject_hero_behavior`, then calls
  `resolve_custom_event_triggers` once. **The hero's Act is built last**, so a
  reference from `adversary` to a `hero` event is a forward reference and only
  resolves because the trigger pass is deferred — resolving per actor found no
  name and degraded silently to a `simulation_time` start. Deferring is safe
  against the XSD (an Event wants its `<Action>`s before its `<StartTrigger>`)
  because the actions are appended in phase one. Called without those two
  arguments the function still resolves its own triggers, same-actor only —
  that is the LLM path.
- **Event ids are unique only within an actor**, so every actor's first event
  tends to be `evt-1`. Anything matching a reference must compare the actor too:
  `_deleteEvent`'s own re-point sweep carries an explicit `!trigger.actor_ref`
  guard for exactly this, or deleting this actor's `evt-2` would re-point a
  trigger naming *another* actor's `evt-2`.
- **The three scenario-wide `after_event` rules live in one place**,
  `_normalize_after_event_chains` (`backend/scenario_io.py`), called from
  `validate_scenario_params` **after** every `_normalize_actor`. The
  assign_route rewrite and the hero self-distance coercion used to be the tail
  of `_normalize_actor`, which was correct only while a reference could not
  leave its actor. Order inside it still matters and is unchanged: route
  rewrite → cycle check → hero coercion.
- **A cycle is a hard 400**, and the editor cannot author one. Every event on a
  loop waits for a `completeState` that never arrives, so none of them ever
  fires — a clean file that silently does nothing, the same failure shape as a
  dangling `entity_ref`. Each event has exactly one trigger, so the reference
  graph is a **functional graph** (≤1 outgoing edge per node) and a plain
  forward walk finds any cycle without an SCC pass — that is what both
  `_normalize_after_event_chains` and `frontend/js/app.js`'s `_afterEventReach`
  do. `ScenarioRules.canWaitFor` is the frontend predicate, and `eventPanel.js`
  omits every failing candidate from the dropdown, so the 400 only ever has to
  catch a save file or an LLM payload. `ScenarioRules.afterEventCycles` chips
  such an event („Auslöser wartet im Kreis") and the export gate refuses it.
- **The UI is one grouped dropdown, not an actor picker plus an event picker.**
  The `Nach Event` select carries `<optgroup>`s — `Dieser Akteur` first, then one
  per other actor labelled with `AppState.actorLabel(a, { short: true })` — and
  each option's value is `${actorId}::${eventId}` (`_splitAfterEventValue`,
  `_afterEventTrigger`). **A foreign event's owner is named in the option text
  itself as well as in its group heading** (`_afterEventOptionLabel` →
  `Geschw. setzen 1 (CAR 2)`), because a closed native select shows only the
  selected option's text: the group heading — the one thing saying whose event
  it is — vanishes the moment the dropdown closes. The actor's own events stay
  unsuffixed, where naming it on every row would say nothing; that is the same
  rule the collapsed card's summary line follows. Two kinds of event are missing from every group on
  purpose: an `assign_route`, whose own trigger is discarded at export so
  "after the route" states something the file does not contain, and anything
  that already waits on this event. A trigger loaded from a file that names an
  event the dropdown will not offer gets an extra `Aktuell` group holding it, so
  the select shows what the trigger actually says while the chip says why it
  will not export — it is never silently repointed.
- **Deleting an event sweeps every actor**, inside one `UndoStack.group` so it
  stays one undo entry. A foreign reference falls back to *the referencing
  actor's* `_defaultFirstTrigger`, not the owner's — an ego-owned event must not
  land on `distance_to_ego`. **Deleting a whole ACTOR is deliberately not
  swept**: there is no sensible event to fall back to, so the references are
  left dangling and the „Auslöser feuert nie — Event fehlt" chip plus the export
  gate say so.
- **The preview snapshots cross-actor completions once per tick**
  (`_tickCompleted`, `simulate.js`), same reasoning as `_tickSpeeds`: reading
  another actor's live `fired` map would resolve differently depending on which
  actor `_stepActor` reached first. A **same-actor** reference still reads
  `sim.fired` live — one behaviour tree ticking its own events has no ordering
  ambiguity to remove. `_normalizeEventsForSim` sets `watchActorId` on the
  trigger when the reference leaves the actor, and `neverFires` for a cycle.

### Path waypoints: snapped, editable, and drawn as they will be driven

- **A `fastest` route waypoint is snapped to the nearest driving-lane centreline; a `shortest` one and every `follow_trajectory` vertex are not.** `_routeWaypointAt` (`frontend/js/objects.js`, `ROUTE_SNAP_LANE_TYPES` = driving + bidirectional, `ROUTE_SNAP_MAX_DIST` 25 m) runs at placement, on the seed waypoint, on the map drag **and** when a waypoint is toggled to `fastest`, so a dragged point can never end up somewhere a clicked one could not. The reason is not tidiness: a `fastest` waypoint is never driven to as authored — `AssignRouteAction` hands it to `GlobalRoutePlanner`, which projects it with `map.get_waypoint()` and routes to whichever lane came out, so a point between two lanes silently becomes one of them, and when that is the oncoming carriageway the vehicle drives away from the route and loops back to reach it. A `shortest` waypoint and a trajectory vertex are the opposite case: they are driven literally, and going where lanes do not (a crossing, a swerve, a cyclist bending out) is the whole purpose. Out of reach of any lane the raw point is kept and a toast says so, once per 4 s rather than once per click.
- **The drawn route line is the lane-following route, not the chords between the clicks.** `MapView._laneFollowingRoute` calls `Simulate.routeGeometry(actor, ev)` — `LaneGraph.route` per leg plus `ChangeActorWaypoints`' own filter, i.e. exactly what the preview drives — and falls back to the straight chords when the town has no lane graph or a waypoint sits off the network, marked `.route-line-approx` with a `<title>` saying so. **It is memoised** (`_routeGeomCache`, keyed on the authored points *and the actor's pose*, since leg 0 is seeded from `next(1)` off the actor): the computation walks every lane segment on the map once per waypoint and `renderAllActors` runs on every mousemove of a drag. `renderMap` clears the cache — the geometry is lane geometry, and ids restart at `obj-1`/`evt-1` in every save file. **The pose it uses is the *authored* one, never the live one** — `Simulate.authoredPose(id)` returns the actor's pre-preview pose while a preview is running and `null` otherwise, and both `routeGeometry` and `_routeSignature` go through it. Without that the preview rewrites `actor.x/y` every tick, the signature misses every frame, and the drawn route crawls along underneath the moving vehicle. A `follow_trajectory` line is its authored vertices and never moved; a route has no business moving either.
- **Paths carry no direction arrows at all**, and the per-path `<marker>` that drew them is gone with them. They came from `marker-mid`, a triangle at every interior vertex — fine while a route line *was* its handful of authored waypoints, but the lane-following line is sampled at CARLA's own 2 m resolution, so the same attribute drew ~12 overlapping triangles per 25 m and the route read as a sawtooth band. Sampling a sparse guide fixed the band and still left the map crowded, so both went. Direction comes from the numbered waypoints instead. Line weight is `PATH_WIDTH` / `PATH_WIDTH_SEL` (0.35 / 0.6 world m, well under a lane's ~3.5 m) for the same reason — several actors' paths over a town view is a lot of ink.
- **Waypoint 1 is the vehicle, and is none of those things.** It is seeded on the actor's pose (`startPathMode`) and **tracks it** — `AppState.updateById` folds the seed's new position into the *same* patch as the actor's x/y (`_seedFollowPatch`, `frontend/js/app.js`), so a move and its seed are one undo entry, and a route can never start by driving back to somewhere the car has left. It is not deletable (`deletePathPoint` refuses `idx === 0`), never `waypoint-interactive` on the map (so those clicks reach the car underneath), never marked by its own card row, and carries no strategy toggle. That last one is not cosmetic: keeping waypoint 0 `fastest` is what makes an export run on an unpatched ScenarioRunner — see the per-waypoint strategy section below. The patch is attached whenever the actor has a path at all, even on frames where the snap leaves the seed still, because the undo key is `id + sorted patch keys` and an alternating key would break one drag into several entries. `_seedFollowPatch` stands down entirely while `Simulate.authoredPose(id)` is non-null: the preview rewrites `actor.x/y` every tick, and following that would rewrite the authored path underneath the running preview.
- **Every other waypoint is draggable and deletable, and only for the selected actor.** `AppState.selectedWaypoint` (`{actorId, eventId, pathType, index}`, editor-only so it records no undo entry) is the single mark shared by the map and the event card; `AppState.waypointPathOf(sel)` resolves it back to the live array. The map's marker groups carry `.path-waypoint` plus `data-actor-id` / `data-event-id` / `data-path-type` / `data-wp-idx`, and the card's rows carry the same four — that is the whole contract between the two halves. A marked waypoint wears the same four corner crop marks as every other selectable object (`_buildSelectionMarks`, shown by `.path-waypoint.waypoint-marked` alongside `.actor-selected` and `.traffic-light.selected`) — one selection language across the map. The helper draws around the origin for callers inside a translated group, so a waypoint, whose shapes carry absolute coordinates, wraps it in a translate of its own. Everyone *else's* waypoints are `pointer-events: none`, which is what lets the map keep every path on screen without one actor's path swallowing a mousedown aimed at another's.
  - Drag is `objects.js`'s mousedown/mousemove/mouseup, branch `_dragState.type === 'waypoint'`, and it marks the point it is about to move. `.path-waypoint` had to be added to **`mapView.js`'s pan-exclusion list** as well: that handler is capture-phase on the same `<svg>` objects.js binds on the bubble phase, so without it the pan is already under way by the time the drag handler sees the mousedown. A **route** point re-snaps every frame (and gets its z free out of the snap); a **trajectory** point moves freely and re-derives z on mouseup only, under `UndoStack.suspend()` — same reasoning, and the same two-step shape, as an actor body drag.
  - Click a card row to mark and fly to the point (`MapView.focusWaypoint` → `_centreOn` + `glowWaypoint`); marking from the map scrolls the row into view — but **only when the mark actually moved** (`_lastMarkKey`, `eventPanel.js`), because the panel re-renders on every `actorUpdated` and would otherwise fight the user for the list's scroll position mid-drag.
  - **`Entf`/`Backspace` deletes a marked waypoint immediately, with no confirm**, and preempts the actor delete in `mapView.js`'s keydown. The two are not comparable acts: deleting an actor takes its pose, its whole event chain and anything chained onto those, while a waypoint is one click of a path and comes back with one more. The mark then moves to the point that took its place, so holding the key walks the path. The card's own `×` shifts the mark down instead — indices past the deleted one all move, and a stale mark would have `Entf` delete something nobody marked.
  - Deleting below 2 waypoints is allowed and leaves the ordinary "unvollständig" warning chip; `_discardIncompletePath` only fires on leaving draw mode, so an event edited down this way survives to be fixed.
- **`Ausblenden` hides a path outright, selected or not.** Selection governs only how a *shown* path looks: full opacity and the top layer when selected, dimmed and underneath when not. Selection overriding the toggle was tried and reverted — a path deliberately hidden to clear the map came back the moment you clicked its vehicle, which is exactly when you are clicking around it. What stops that stranding anyone is **`MapView.showPath`**: starting a draw (`ObjectsManager.startPathMode`) or marking one of the path's waypoints un-hides it, and does so by **deleting the hidden-set entry rather than overriding it**, so the card's button flips to `Ausblenden` and never states something the map contradicts. Marking is the case that matters — the event card's row is the one way to mark a waypoint on a path you cannot see, and a mark on an invisible point is a mark on nothing that `Entf` would then delete with no visible consequence.
- **The paint order at the top of the map is `layer-paths-top` → `layer-actors-top` → `layer-trigger-points`**, all appended after `layer-actors` in `renderMap` — so the selected actor's path sits over the *other* vehicles, the selected actor itself sits over its own path, and its trigger points sit over everything. The split into two actor layers is structural, not cosmetic: waypoint 1 is seeded on the actor's own pose, so with the path on top the marker sits squarely on the vehicle, hides it, and turns every grab there into a waypoint drag instead of a move or a rotate. That waypoint is still reachable from its row in the event card. **`#layer-actors` is therefore no longer the only home of an actor marker** — `test_actor_types_e2e.py` queries both ids, and anything else looking a marker up by layer must too. The toggle is not disabled, because the event card holding it is **only ever rendered for the selected actor**, so disabling it would put the preference permanently out of reach; it says what it governs in its `title` instead, and the collapsed-card summary reads `, bei Abwahl ausgeblendet` rather than claiming a plainly visible path is hidden.

- **The bottom-centre banner is path/route drawing only** (`#traj-banner`, `objects.js`). It used to be shared with a trigger-point picking mode, which is gone in favour of the drag above — along with the panel's *Neu setzen* button and the banner's *Abbrechen* button.
- `eventPanel.js` permits at most one path-producing event (`follow_trajectory` or `assign_route`) per actor (`frontend/js/eventPanel.js`), the ego included — this is also what `route_waypoints` (for route XML export) is derived from now that there is no actor-level `ego.trajectory`. The two path buttons stay in the action grid once one exists and go **`disabled` with a title**, rather than being removed: hiding them reflowed the grid with nothing to explain where they went.
- An `assign_route` card shows the fixed chip **`startet sofort (fest)`** — in its trigger block when expanded, in the summary line when collapsed — where every other card shows its trigger summary, because a route's trigger is discarded at export (see above) and the card offers no trigger controls for it. Do not "fix" this by printing the stored trigger — it would state a start condition the file does not contain.
- **An actor with `events: []` gets no `<Act>` at all** — `build_custom_event_chain` returns `False` for an empty list and `_build_actor_act` (`xml_builder.py`) then returns `None` instead of building a fallback chain. The actor still spawns, still gets its `<Private>` teleport, controller and Init `<SpeedAction>`; it simply takes no part in the story, so it holds its `initial_speed` forever (or stands still at 0). This applies to the ego exactly as it does to an NPC — an ego with no events gets no `heroBehavior` Act, and `SimpleVehicleControl` drives it down its own spawn lane at whatever its Init speed was. **This is the opposite of the old behaviour**, where an event-less actor fell back to a `constant_speed` chain and drove off at 10 m/s; a "parked" car in a bench case covered 226 m before that was caught.
- **A scenario in which *nothing* has events is rejected with a 400** (`validate_scenario_params`, `backend/scenario_io.py`). Every actor would contribute zero Acts, leaving a `<Story>` with no `<Act>` children — XSD-invalid, and the storyboard would complete on the first tick. Traffic-signal events count towards the rule, since `_inject_traffic_signals` builds a `ScenarioBehavior` Act of its own. `build_xosc` carries its own copy of the check (`_require_nonempty_story`) as a `RuntimeError`, for payloads that never went through the backend. Deleting the empty `<Story>` is **not** an alternative fix — `<Storyboard>` requires exactly one, verified against `OpenSCENARIO.xsd`.

### Per-waypoint `routeStrategy`: one path action, two kinds of leg

Every `assign_route` waypoint carries `strategy` — `'fastest'` (default) or
`'shortest'` — and **it governs the leg that ENDS at that waypoint, not the point
itself.** `ChangeActorWaypoints.initialise` routes from waypoint `i-1` to
waypoint `i` using waypoint `i`'s strategy. That is the whole mental model, and
it is what the event card's toggle (`Spur` | `Gerade`, waypoints 2…N only) means.

- **`shortest` is not an approximation of `follow_trajectory`, it is the same
  code.** `openscenario_parser.py` builds a `FollowTrajectoryAction` as
  `ChangeActorWaypoints` with **every vertex tagged `'shortest'`** — in the fork
  `run.sh` runs and in stock 0.9.15 alike. So a route whose waypoints are all
  `shortest` is byte-identical in behaviour to a trajectory, minus the
  `ChangeActorTargetSpeed` the trajectory branch derives from `relativeTime`.
- The atomic appends a `shortest` waypoint **verbatim** — outside the routed
  branch, so neither the `> 1.0 m` dedup nor the heading filter touches it.
  `simulate.js`'s `_exactRoute` mirrors that exactly; the drawn route line comes
  free from the same call.
- **Placement is `Shift`+click**, reusing the meaning `Shift` already carries for
  props: *do not snap to the lane*. Here that is the semantics rather than a
  convenience — see the snapping bullet above.
- **A `shortest` waypoint immediately preceding a `fastest` one is a routing
  seed**, because the next leg starts at *the previous authored point* whatever
  its own strategy was. Off-lane, `map.get_waypoint()` projects it onto whatever
  it finds. Measured on Town01: seeded on the oncoming carriageway the actor was
  stranded 37.8 m from its final waypoint and the storyboard never completed.
- **Waypoint 0 must be `fastest`**, enforced three times — the seed is placed
  `fastest` and cannot be toggled or deleted (see above), `ScenarioRules` chips
  it, and `validate_scenario_params` raises a **400**. It is a 400 and not a
  coercion because a payload the editor did not build may have no waypoint on the
  actor at all, and rewriting its first leg from a straight line into a routed one
  hands back a different scenario. The reason it matters at all is in the
  Verification section: `shortest` at index 0 followed by `fastest` at index 1
  kills the run with an `UnboundLocalError` on any unpatched ScenarioRunner.
- **The XSD's other two values (`leastIntersections`, `random`) fold into
  `fastest`.** ScenarioRunner treats everything that is not `'shortest'` as the
  planner, so the fold changes the file without changing what CARLA does — and
  stops the file claiming a strategy nothing implements.
- **A route cannot carry per-waypoint speed and never will**: the XSD's
  `Waypoint` is `Position` + `routeStrategy` and nothing else. (The trajectory's
  per-vertex `velocity` is already collapsed to a single average by the parser,
  so less is lost than it looks.)
- `MapView._routeSignature` keys the route-geometry cache on the strategy as well
  as the position — toggling to `Gerade` leaves coordinates untouched, so without
  it the map kept drawing the lane-following line it no longer was.

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
  all four alternate ramp and hold, because a `rate` event ends on arrival and therefore
  cannot itself hold — every dwell in those chains, including the final one, is a separate
  `time` event. Every other template, and every
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

Four fields name another actor by the editor's internal `obj-N` id and must be
remapped to an OSC entity name before export: `trigger.entity_ref`
(`distance_to_point` only), `trigger.actor_ref` (`after_event` only — **which
actor owns the referenced event**, see the cross-actor section below),
`action.target.entity_ref` (`set_speed` relative) and `action.entity_ref`
(`set_distance`). Nothing else does — `after_event`'s `event_id` beside it is a
*storyboard element* name and stays verbatim, and `distance_to_ego`
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

**No build step, no bundler, no npm.** Each `frontend/js/*.js` is an IIFE attaching one global: `AppState`, `Api`, `MapView`, `ObjectsManager`, `EventPanel`, `TrafficSignals`, `ScenarioTemplates`, `PropCatalog`, `LaneGraph`, `Dropdown`, `SpecialBuildings`, plus `Toast` / `Confirm` / `UndoStack` / `UIUtils` / `ScenarioRules` from `app.js`. `Simulate` also exports `routeGeometry(actor, ev)` — the lane-following route `mapView.js` draws. Two globals exist only as test hooks and are called by no UI code: `Simulate.routeForTesting` (`tests/test_route_fidelity_e2e.py`, asserts on a computed route without running the animation) and `ScenarioIO.buildParamsForTesting` (`tests/test_events_e2e.py`, builds the export payload without the click, so a payload the client-side gate refuses can still be handed to the backend). Several files (`toolbar.js`, `properties.js`, `weather.js`, `mapImport.js`, `welcome.js`, `layerMenu.js`) export nothing else and simply bind DOM listeners on load.

- **Script order in `frontend/index.html` (the `<script>` block near the end) is load-bearing** — `app.js` first, dependents after; `propCatalog.js` must precede `toolbar.js`, which renders the prop tiles from it. A new module must be added there or it never runs.
- **The header's two dropdowns share one mechanism.** `dropdown.js` (global `Dropdown`) owns toggle-on-button, close-on-outside-click and close-on-Esc; the Esc handler is on the **capture phase** and `stopPropagation`s, so closing a menu does not also cancel a path being drawn in `mapView`. A menu needs no module of its own — `dropdown.js` auto-binds any `[data-dropdown]` wrapper holding a `[data-dropdown-button]` and a `[data-dropdown-panel]` (this is how **Datei** works), and a row marked `data-menu-item` closes the menu after its own handler runs. A menu with extra behaviour calls `Dropdown.bind()` itself instead; **Ebenen** does, and must therefore *not* also carry `data-dropdown` or it binds twice. Shared classes are `.menu` / `.menu-btn` / `.menu-panel` / `.menu-item`; `.menu-panel-right` right-aligns a panel near the window edge.
- **The seven map-layer checkboxes live in the Ebenen dropdown** (`#layer-toggles` → `#layer-menu-btn` + `#layer-menu-panel`, "Ebenen N/7"). Ownership is split: `layerMenu.js` owns only the count pill and `Alle`/`Keine`, while `mapView.js`'s `_setupLayerToggles` still binds each `#toggle-*` checkbox to its SVG layer by id, exactly as when they were inline in the header. Keep those ids: they are the contract between the two files (and `tests/test_props_e2e.py` asserts `#toggle-props` exists). `Alle`/`Keine` set `.checked` directly, which fires **no** event, so it dispatches a synthetic `change` per box — drop that and the pill updates while the map does not. `#layer-toggles` itself stays `hidden` until a map loads (`mapImport.js`, `_setupLayerToggles`).
- **The Datei menu holds `#btn-save` / `#btn-load-input` / `#btn-export-route`, and their ids are unchanged** — `scenarioIO.js` binds them by id and does not care that they now live in a popup. `#btn-export` deliberately stays a top-level primary button: it is the app's goal, and `tests/_harness.py` clicks it directly and waits on its `.disabled`.
- **The simulation controls are not in the header.** `simulate.js` injects `#sim-controls` into `#map-bottom-stack`, a click-through (`pointer-events: none`, children `auto`) bottom-centre overlay inside `#map-container` that also holds `#traj-banner`. They are **stacked in a flex column, not given fixed `bottom` offsets** — either can be hidden without the other having to know. The ids `#sim-play` / `#sim-stop` (`tests/test_route_fidelity_e2e.py`) and `#traj-banner` (`tests/test_ego_events_e2e.py`) are unchanged by the move.
- **`#map-status` carries the road count only** ("122 Straßen") — the town name is `#map-select`'s job, and every path that writes the count (`toolbar.js` select-change and `stateLoaded`, `mapImport.js`) also sets `mapSelect.value`, so the name is never lost. Transient and failure states ("Lade …", "Import fehlgeschlagen") still take over the badge text.
- **Pan/zoom is clamped, and `F` is the way back.** `mapView.js` holds `MIN_ZOOM` (0.25) / `MAX_ZOOM` (200) around `_zoom`, which is `1.0` when the whole town fills the viewBox. The wheel derives `_pan` from the **clamped** zoom, not the requested one — deriving it from the request keeps translating the map at the limit, which walks it off screen as effectively as no clamp. Unbounded is what it used to be: 200 notches out reached `scale(0.0000087)` and nothing but `renderMap()` ever reset the view, so the only way back was a reload, which discards the scenario. The recovery path is `MapView.resetView()` / `zoomToSelection()` / `zoomBy(factor)`, bound to `#map-view-controls` (top-right of the map, unhidden by `_setupLayerToggles` alongside `#layer-toggles`) and to the `F` key — `F` frames the selection at `ZOOM_TO_SPAN` (90 m) and falls back to a full reset when nothing is selected. **Buttons zoom about the view centre (`zoomBy` → `_centreOn`), the wheel about the cursor**; scaling `_zoom` alone zooms about the viewBox origin. Shift on the wheel switches to `ZOOM_STEP_COARSE` (1.4 vs 1.12), which is a real ergonomic difference — 9 notches to lane scale instead of 26, and 50 before the base step was raised.

- **Selection is four corner marks, and one helper draws them for everything.** `_buildSelectionMarks(w, h)` (`mapView.js`) builds a `.actor-select-marks` group of black-over-white crop marks on the object's box, called from `_renderActor`, `_renderProp` and `_renderTrafficLight` — actors, props and signals share one selection language, and `.actor-select-marks` is shown by both `.actor-selected` and `.traffic-light.selected`. It replaced a yellow ring per renderer, which failed on three counts worth not reintroducing: `#ffff00` is the map's *own* colour (lane paint, the `#ffee55` ruler, a `#ddaa00` bus body), so around a bus on a painted road the mark was ambiguous; one radius gave a 9 m bus and a 0.9 m cone the same circle, saying where but never what; and it drew through the actor's own label. Three details carry it — **`vector-effect: non-scaling-stroke`**, so the corners follow the box while the line keeps its screen width (a scaled 2 px line goes sub-pixel long before the cone it frames does); the **white casing under the black line**, because the map runs from a `#e8edf2` verge to a near-black carriageway and no single colour survives both; and **`pointer-events: none`**, because a 5 px casing would otherwise swallow clicks aimed at the object it frames. `w`/`h` are the **drawn** extent in the object's own rotated frame, which is not always the catalogue's: a walker is a circle of diameter `size.w` so its box is square, and a prop whose `planRotate` is ±90 has its extent swapped.
- **Drag and rotate are two disjoint zones on the marker, and the gap between them is real.** The body drags; a handle out past the nose rotates. `_buildYawArrow` (`mapView.js`) takes the caller's **own hit radius** — half the marker for an actor, the prop's invisible grab circle for a prop — and derives `arrowLen = bodyRadius + YAW_HANDLE_GAP + handleR`, so the invariant *(handle inner edge is outside the body, always)* holds by construction at any size rather than by a tuned constant. It did not before: `max(w, 4.5) * 0.8` with a fixed `r = 1.5` grab circle put the handle's inner edge at 2.1 m on a car whose half-length is 2.25 m, and swallowed a small oriented prop whole (arrow 1.6 m out, `r` 1.5, body grab circle 1.2) — that prop could not be dragged at all, every grab rotated it. Two more pieces of the same fix: the shaft is `.yaw-shaft`, `pointer-events: none`, drawn from the body edge instead of from the actor's *centre* where it hit-tested as "rotate" straight across the marker; and `objects.js`'s mousedown matches the single class `.yaw-handle` instead of the old four-way string match on `[class*="arrow"]` and `style === 'cursor:grab'`. **A new part of the arrow is decoration unless it carries `.yaw-handle`.** The mode guard (`activeTool`/`trajectoryMode`/`routeMode`) is now shared by both branches at the top of the handler — the rotate branch had none, so with a tool armed the handle rotated while the body selected.
- **The drag cursor is a class on `<body>`, not `:active` on the element.** `.actor-group` is `move`, `.yaw-handle` is `grab`, and mousedown adds `body.dragging-actor` / `body.rotating` (removed on mouseup) which force `move` / `grabbing` document-wide. `:active` cannot work here: every `updateById` re-renders the whole actor layer (`AppState.on('actorUpdated')`), so the element the drag started on is detached within a frame — the same reason the trigger-point drag re-derives its z on mouseup rather than trusting the element. `.yaw-handle-ring` draws the grab circle's own boundary on `.yaw-arrow:hover`, so the zone is findable *before* committing to a drag.
- **`AppState.cancelPlacement(extra)` is the one way to disarm placement**, with `AppState.placementActive` as its predicate. It clears all eight of `activeTool` / `pendingTemplate` / `pendingProp` / `trajectoryMode` / `activeTrajectoryId` / `routeMode` / `activeRouteId` / `activePathEventId`; three callers need exactly that set — Esc, the `r` ruler toggle (which passes its own `activeTool`) and pressing Play. It records no undo entry (`_isScenarioPatch` ignores editor-only keys), but clearing the draw flags is what fires `objects.js`'s `_discardIncompletePath`, so **a caller that then reads the actors must call it first** or it simulates/exports an event that no longer exists.
- **The preview answers to `Leertaste` (Play/Pause) and `Esc` (Stop).** Both are one bubble-phase `window` keydown in `simulate.js`, deliberately without `stopPropagation`: `app.js`'s confirm dialog and `dropdown.js`'s menus handle Escape on the **capture** phase and stop it there, so they preempt this for free, and `mapView.js` — loaded first — runs its own Escape branch before it. Space yields to a control **only when the keyboard put focus there** (`UIUtils.keyboardFocused`), and otherwise `preventDefault()`s — which is what stops the browser turning the keydown into a click on the focused button. The blanket `button, [role="option"], a[href]` bail it replaced was a real bug: clicking leaves a button focused, so the last toolbar tile clicked ate every Space and re-armed/disarmed itself (crosshair flickering on and off) while the preview never started, and a clicked panel button or scene row did the same. **`:focus-visible` cannot be used for this** — it was tried first, and its heuristic is "was the most recent interaction a keypress", so pressing Space *itself* flips every control into focus-visible and the next press hands the key back to the button. `app.js` tracks focus modality directly instead: Tab/arrow/Home/End set it, any mousedown clears it. `properties.js`'s scene-row Space reads the same predicate and preempts this handler through `e.defaultPrevented`. `_startSimulation` calls `AppState.cancelPlacement()` on a cold start — `body.simulating` dims the *toolbar*, but the map SVG stays live for pan/zoom, so an armed tool used to survive Play, crosshair and all, and the first click on the animating map placed an actor.

- **`MapView.focusActor(id)` frames an actor *without* selecting it**, sharing `_frameActor` with `zoomToSelection`, then calls `glowActor(id)`. The glow is the **object's own body brightening** — the same `filter` it gets when hovered directly on the map, **no ring**, nothing appended to the actor group at render time. It brightens, holds ~0.5 s, then fades: `GLOW_MS` (900) must stay in step with the `actor-glow-fade` keyframes (brightness held to 55% of the timeline), or the class outlives the animation and leaves the object sitting bright. It is fired on the scene list's **click**, never on hover — hovering a list to read it must not set things flashing on the map. Both work for props: they carry `.actor-group` too. Flying the view *is* the feature — markers are drawn at true world size, so an actor at the town view is a few pixels and no amount of highlighting would find it for you.

- **Every object label on the map is one size and one hide rule.** An object label is the *name of the object under it* — an actor's, a prop's, a landmark's, a trigger point's. All four are drawn at `MAP_LABEL_M` (3.2 world metres), all four carry the class **`.map-label`**, and `_updateLabelVisibility` (called from `_applyTransform`) hides the lot by toggling `map-labels-hidden` on the `<svg>` when `pxPerMetre * MAP_LABEL_M < LABEL_MIN_PX` (6). They were three sizes across four call sites before (2.2 / 2.2 / 1.8 / 1.8), and only the actor's was ever hidden, so a prop's name was visibly smaller than the car's next to it and a trigger point's stayed on screen as a smear at any zoom. **A new object label must carry `.map-label` and `String(MAP_LABEL_M)`** or it silently reintroduces exactly that.
  - **What is deliberately *not* a `.map-label`**: waypoint numbers and per-waypoint velocities, the ruler's distance readout, the preview's status badges. Those annotate a measurement rather than name an object, and they keep their own smaller sizes.
  - **The floor is a screen size, so it — not the metre value — is what decides how far out labels survive.** At 3.2 m / 6 px they hold to ~1.9 px per world metre, against ~3.2 before, i.e. roughly **1.7× further out**; Town10HD and Town02 now keep their labels at the whole-town view where they used to lose them. Raising `MAP_LABEL_M` alone widens that range too, since the threshold is their ratio.
  - **Do not "fix" small markers by scaling them up**: the markers being true-size is what makes the map trustworthy, and a label that grew as you zoomed out would be the one thing on it lying about scale — `MapView.focusActor` is the way to reach a small actor. The `font-size` at each call site and `MAP_LABEL_M` are the same number written several times and must stay in step.
  - **The check is driven off the live CTM** (`_pxPerMetre`, shared with the scale ruler) and **not** off `_zoom`, because `_zoom` is relative to a viewBox that is the town's own bounds: the same `_zoom` is a different number of pixels per metre on Town01 and Town04.
  - **Every object label is cased** — the stroke is painted *under* the glyphs (`paint-order: stroke` on `.map-label`), white text over a dark casing by default, and `.building-label` inverts to dark text over a white one. This is not decoration at the current size: the map runs from a near-white verge to a near-black carriageway, and now that labels are bigger and hold further out they spend real time over the light verges, where plain white text vanished. A new label variant sets `stroke` (the colour) and nothing else.
  - Prop labels are still drawn **only while the prop is selected** — a six-cone taper with one name per cone buries the glyphs it annotates — but when drawn they are now the same size as everything else.
- Cross-module communication goes through `AppState`. `set()` / `updateById()` / `removeById()` / `select()` emit `change`, `actorUpdated`, `actorRemoved`, `selectionChanged`, `stateLoaded`, `trafficSignalSelected`, `trafficSignalUpdated`. Subscribe via `AppState.on(...)`; never reach into another module's DOM.
- **The no-selection overview panel re-renders off an allow-list, not off every `change`.** `properties.js`'s `change` handler calls `_renderOverviewPanel()` for `weather`, `time`, `map`, `mapData` — and for an **empty patch**, which is this codebase's signal that one of the state arrays was mutated in place (`AppState.npcs = [...]; AppState.set({})`). `map`/`mapData` are in there because the summary prints the town name and otherwise sat on “Karte: None” from load until an unrelated event forced a render — which reads as intermittent rather than broken. The empty patch is in there for the scene list: **placing a prop is the one placement that does not select what it placed**, so the overview stays on screen and would otherwise keep showing the pre-placement counts. A new summary field sourced from `AppState` needs its key added here too.

- **The `Übersicht` tab is a scene list, and its single click does not select.** `_sceneListHtml` (`properties.js`) renders one `.scene-row` per scenario actor — ego first, then a collapsible `NPCs` section — carrying the map's own colour swatch, `actorLabel(actor, { short: true })`, the event count and the `.event-warn` chip from `ScenarioRules.problemsOf`. **Click flies the map to the actor without selecting it** (`MapView.focusActor`), **double-click or `Enter` selects**; `Space` re-locates and the arrow keys walk the rows. The split is load-bearing, not a preference: the overview panel is only rendered while *nothing* is selected, so a selecting single click would close the list on the first row and you could never walk down it. Selection is the deliberate gesture because it swaps the whole panel out.
  - **Props are counted per type, never listed per object.** A cone taper is a dozen entries differing only in position and would push the actors off the panel. One `.scene-prop-row` per **blueprint** carries a stepper (`◀ n/N ▶`, also the ←/→ keys on a focused row) that walks that type's instances; the row's `data-scene-id` is whichever instance the stepper points at, so click/double-click/delete all act on *that* one. `_propCursor` is clamped at render time rather than maintained on delete — props are also added and removed by the map and the toolbar, which never touch it.
  - **Every row has a delete, rightmost, and on a prop row there are two with different blast radii.** `✕` sits with the stepper and takes the instance; the trash (`.scene-del-all`, behind a divider) takes the whole type. **At `count === 1` the row collapses to a single instance-trash** — the two would otherwise do the same thing and the bulk one would have to say “Alle 1 × …”; `.scene-del-spacer` holds the `✕` column open so the trashes stay aligned. What actually makes this safe is not the icons but that **both confirm and the confirm text names the target** (`LEITKEGEL 3 löschen?` vs `Alle 6 × Leitkegel löschen?`). A bulk delete is wrapped in `UndoStack.group()` and is therefore **one** undo entry, so a taper of twelve cones comes back on one `Strg+Z`.
  - **Every delete confirms, and `Strg` (`Cmd` on a Mac) is the app-wide "skip the confirm" modifier.** It is honoured by `Entf`/`Backspace` (`mapView.js`), by every scene-list trash and the prop `✕`, and by `#props-delete` in the properties header; each button carries it in its `title`. It is `(e.ctrlKey || e.metaKey)` at every site — `Cmd` is not optional, since `Strg`+click is a right-click on macOS and fires no `click` at all. **Shift used to be this modifier and must not be given the job back**: it already means coarse wheel zoom (`ZOOM_STEP_COARSE`) and prop lane-snap at placement (`_placeProp`), and a mis-modified delete is unrecoverable in a way a mis-zoom is not. The `Entf` path used to delete outright — it was the one unguarded delete in the app — so it now awaits `Confirm.show` and **re-reads the object in the callback** rather than trusting the id it captured, since the selection can move while the dialog is open. The one deliberate exception is a marked path **waypoint**, which `Entf`/`Backspace` takes with no confirm and ahead of the actor — see the waypoint section above for why the two are not comparable acts.
  - `_sceneCollapsed` and `_locatedId` are module-local in `properties.js` **because `_renderOverviewPanel` rebuilds its `innerHTML` wholesale** — a collapsed section held only in the DOM springs back open the moment a prop is placed. Anything else the scene list needs to remember goes there too.
  - The summary above the list no longer prints `Ego-Fahrzeug` / `NPCs` / `Requisiten` counts or the NPC breakdown; the list is the same numbers with the objects reachable behind them. `Karte`, `Akteure mit Pfad` and the `Wetter` block stayed — the list cannot show those.
- Modal editor state (`trajectoryMode`, `routeMode`, `activePathEventId`, `pendingTemplate`, `pendingProp`) lives on `AppState` and is what the `mapView.js` click handlers branch on.
- The left toolbar is **tabbed** (`Akteure` | `Requisiten`, `data-toolbar-tab`). `toolbar.js` uses **event delegation** on `#toolbar`, not a load-time `.tool-btn` snapshot — prop tiles are rendered at runtime and a snapshot would silently miss them. Tab state is module-local, matching `_overviewPanelTab` in `properties.js`.
- Props reuse the `.actor-group` class (plus `.prop-group`), which gives them selection, body-drag and the `mapView.js` pan-exclusion list for free. If you add a new draggable map object, do the same rather than adding a class to three separate `closest()` checks.
- Use `Toast.success/error/warn/info` for feedback (there are no `alert()` calls) and `await Confirm.show(msg)` for destructive actions. The dialog answers to **`Enter` = confirm, `Esc` = cancel** from anywhere, via a **capture-phase** `keydown` in `app.js` that `stopPropagation`s — without capture, `Esc` would also cancel the tool or the path being drawn *behind* the dialog, and `Enter` would reach the finish-path shortcut. `Confirm.isOpen` is there so other key handlers can stand down; `objects.js`'s `Enter` handler checks it.

### Undo is snapshot-based and captured automatically

`UndoStack` (`app.js`) holds whole **scenario states**, not edit descriptions. It
used to hold one deleted actor per entry, and the failure mode was worse than a
missing feature: `Strg+Z` after a misplaced *drag* popped an unrelated delete
from earlier in the session and resurrected that actor, while the drag stood.

- **Capture is automatic, at `AppState.set` / `updateById` / `removeById`.** Every
  scenario edit in the app goes through one of those, so placement, both drags,
  the Spawnpunkt fields, type swaps, event add/delete and templates are covered
  without a call at the site — and so is anything added later. **The one
  exception is `TrafficSignals.update()`**, which rewrites
  `AppState.trafficSignals` directly; it calls `UndoStack.record()` itself. A new
  mutation path that bypasses the three mutators must do the same.
- **Everything in the snapshot must be recorded.** This is the rule the whole
  design turns on, and it is not obvious: an edit that is *skipped* is not merely
  un-undoable, it is **destroyed by the next undo**, because the entry pushed
  after it describes a world where it never happened. Skipping event tweaks made
  "add event A, retune event B, `Strg+Z`" silently throw the retune away. The way
  to keep something out of undo is to keep it out of the **snapshot** — which is
  what `weather`/`time` do, and why they cause no such problem — never to stop
  recording something the snapshot contains.
- **Noise is handled by coalescing, not by exclusion.** An `{events}` patch keys
  on the id of the one event it changed plus what kind of change it is
  (`_eventsPatchInfo`), and `_sealUnlessInEventCard` skips the seal inside a
  `.event-card` — so every control in one card folds into a single undo step,
  while a different card, or deleting the card being edited, starts its own. The
  changed event is found by **reference identity**, not by comparing contents:
  every mutation site rebuilds the array with `.map()`, so untouched events are
  the same objects, which keeps this free on the trigger-point drag (one patch
  per mousemove against a possibly-huge trajectory).
- **A path mutator must copy the points array, never write through to it.**
  `_eventPath` (`objects.js`) returns the *live* `action.trajectory`/`waypoints`,
  so `path.push(point)` changed the actor before `updateById` was told —
  the patch then equalled the state it was patching, `_isNoOpPatch` scored it a
  no-op, and the waypoint was silently unrecordable. `_addPathPoint`,
  `deletePathPoint` and `setPathPointVelocity` all build a new array. Relatedly,
  `_setEventPath` now goes through `updateById` rather than assigning
  `actor.events` directly: as the one scenario mutation reaching neither of
  AppState's mutators, it left the baseline stale, and undoing an unrelated
  rotate wiped a five-point trajectory that had been drawn after it.
- Each waypoint click is its own entry, so `Strg+Z` while drawing removes one
  waypoint — the same granularity as the banner's own *Rückgängig* button.
- **Scope is the scenario objects only** — `ego`, `npcs`, `staticObjects`,
  `trafficSignals` and their events, plus `selectedId`/`selectedTrafficLightId` so
  the panel follows the undo. `map`/`mapData` are out (undoing a town switch would
  need an async re-fetch on the undo path) and so are `weather`/`time` (a global
  setting rather than an edit — and the weather sliders are the only controls in
  the app that fire on `input` rather than `change`, so they would need their own
  coalescing).
- **What gets pushed is `_baseline`, not a snapshot taken at record time.** The
  placement paths mutate the array *first* and only then announce it
  (`AppState.npcs = [...]; AppState.set({})`), so when `set()` runs the "before"
  state is already gone. `_settle()` re-reads the baseline after each mutation
  instead. Get this wrong and placements undo to themselves — which is exactly
  what the first cut did.
- **Coalescing is by `kind`**: `id + sorted patch keys` for `updateById`, so a
  drag's dozens of same-shaped calls are one entry. `seal()` ends a run and is
  bound to `change` and `mousedown` in the **capture** phase, which is what keeps
  two deliberate Spawnpunkt edits apart — `_onPosChange` sends all four of
  `x/y/z/yaw` every time, so both produce an identical key. A patch that changes
  nothing records nothing (`_isNoOpPatch`), or blurring a field would push a step
  that undoes to where it started.
- **`suspend()`/`resume()` is for code that writes poses without editing.** The
  preview does this on every tick (`simulate.js` `_startSimulation` /
  `_stopSimulation`, balanced on a `wasRunning` flag) — unsuspended, one run
  buries the history. The drag's mouseup z-fixup (`objects.js`) uses it too: the
  drag's entry already holds the pre-drag z, and a separate entry would undo the
  height without the position. `resume()` re-reads the baseline on the way out,
  so whatever ran underneath is invisible rather than merely unrecorded.
- **Both directions deep-copy.** `AppState.toJSON()` is *not* a deep copy —
  `_dumpActor` spreads each event, so an action's `trajectory`/`waypoints` array
  stays shared with the live state — and `updateById` mutates actors in place with
  `Object.assign`. So `_snapshot` and `_apply` both JSON round-trip, or the
  history silently rewrites itself.
- **`Strg+Z` is ignored while a field has focus** (`mapView.js`'s `inInput`
  guard): the browser's own text undo owns the keystroke there. Redo is
  `Strg+Umschalt+Z` or `Strg+Y`. `loadJSON` clears both stacks — restoring a
  pre-load scenario would leave it beside the map, weather and time from the file.
- Depth is `MAX_HISTORY` (100) — raised from 50 once waypoints started recording,
  since one long path would otherwise evict every placement behind it.
  `tests/test_undo_e2e.py` pins all of the above.
- **`Enter` finishes a path or route being drawn** (`objects.js`, same code path as the banner's *Fertig*); `Esc` still cancels. It is bound in `objects.js` rather than `mapView.js`'s keydown because `_finishPathMode` and the banner both live there. Remember `_discardIncompletePath` still applies — finishing under 2 waypoints deletes the event.
- **UI-facing strings are German; code, comments, and identifiers are English.** Match this when adding UI. `tests/` assert on German labels in several places, so a rename is not cosmetic.
- **`AppState.actorLabel` owns the ego's two spellings; never pass one in.** Prose is `Ego-Fahrzeug` (panel titles, toasts, validation messages) and `{ short: true }` is `EGO` (map marker, draw banner, event dropdowns, scene-list rows — where it sits beside `CAR 1` and has to match their case and width; note the short form uppercases the **raw type**, so it is `CAR 1`, not the German `AUTO 1` the toolbar shows, and `test_actor_types_e2e.py` asserts exactly that). Callers used to pass the string, which is how one vehicle came to be called `Ego-Fahrzeug`, `EGO`, `Ego Vehicle` and `Ego` in four places. The `fallback` for an unresolvable id is `Akteur`.
- **`AppState.typeLabel` / `weatherLabel` / `timeLabel` are the German names for the bare keys** (`car` → `Auto`, `wet_road` → `Nasse Straße`, `daytime` → `Tagsüber`). `typeLabel` is derived from `ACTOR_TYPE_GROUPS` rather than a second table, so a new type in the picker is named everywhere for free; `WEATHER_LABELS` / `TIME_LABELS` are their own tables and **duplicate the words the weather bar prints in `index.html` markup** — keep the two in step. Anything reporting state back to the user goes through these: the scenario summary used to print `car` and `wet_road` beside a toolbar saying Auto and Nasse Str.
- `UIUtils` (`app.js`) holds the helpers `properties.js` and `eventPanel.js` share: `paramRow(label, control, unit)`, `fmt(value, decimals = 1)`, `nextIndexedId(events, prefix)` and `bindLabel(label, control)`. **`fmt`'s convention is that display precision follows the input's `step`** — a `0.1`/`0.5`-step field reads 1 dp, a whole-number one reads 0 dp — and the *same* call formats the card summary above the field, so the two can never disagree (`10` next to `10.0`). `bindLabel` exists because every panel control is built in JS with no id: it assigns one and sets `for=`, or, for a segmented `.event-toggle` (a `<div>` of buttons, which `for=` cannot address), makes it a `role="group"` with an `aria-label` instead. `paramRow` and `_row` call it for you.
- The properties panel is `--props-w` wide (320px) and its content text bottoms out at **11px**; only the bold, letter-spaced uppercase section eyebrows go smaller (10px). Several event-card rows are 5–6 column grids that only fit at that width — `.event-speed-row`, `.event-point-distance-row`, and the `70px` label column shared by `.event-row` / `.event-param-row` (which is why a param label longer than ~"Sollabstand" gets shortened and the long form moved to the input's `title`).
- **The Spawnpunkt grid is `.props-group.spawn-grid`, a 4-column `label input label input`** — X│Y and Z│Gier share a row, `#prop-init-speed` spans `2 / -1`. Plain `.props-group` (the type pickers) stays 2-column. The label columns are `max-content`, so hiding `Start (m/s)` for a prop visibly narrows column 1; that is the grid working, not a bug. `#prop-z-auto` beside the Z field re-derives z via `ObjectsManager.surfaceZFor` — the only way back to the surface height after typing a z by hand, short of moving the object. It is a button and **not** a live "auto/manuell" badge on purpose: the derived value comes from `_nearestLaneProjection` (a linear scan over every lane segment) and a body drag re-renders this whole panel on every `mousemove`.

## Maps

- Bundled towns live in `maps/<Town>/<Town>.xodr` (plus optional `.jpg` thumbnail and `_summary.json`), auto-discovered by `_scan_xodr_paths` at import time.
- Uploaded maps persist to `maps/_uploaded/*.xodr` and are re-parsed into `MAP_CACHE` on every startup (`preload_maps`, `backend/main.py`); a bad file logs a failure for that town without taking down the server.
- `maps/` is **not** gitignored — uploads land in the working tree.

### Landmark overlay (`maps/special_buildings.csv`)

A bundled table of ~130 reference points (bus stops, parks, shops, …) drawn as
violet dots with the raw `building_type` above each one. **Reference decoration
only** — it is not scenario data, so it never reaches `AppState.toJSON()`, the
export payload, `SCENARIO_KEYS` (hence no undo entry) or the `.xosc`, and there
is no import UI: edit the CSV.

- Columns are `town,building_type,carla_name,x,y,z`. **`x`/`y` are CARLA world
  coordinates** — the same frame the render JSON and every actor pose already
  use — so the frontend plots them verbatim. Do **not** re-flip Y here; the
  single flip lives in `backend/map_renderer.py`. (Checked against the `.xodr`
  bounds when the file was added: Town01's rows span y 2…331 against a CARLA
  y-range of 0…328.6, which only fits the unflipped frame.) `z` is carried but
  unused — the map is 2-D.
- The `town` column matches the `maps/` directory names, `Town10HD` included.
  **`Town10` (the georeferenced VectorZero map) has no rows** and draws nothing;
  a row naming a town that is not loaded is simply never drawn.
- `GET /api/special_buildings` (`backend/main.py`, `_read_special_buildings`)
  **re-reads the file per request** rather than caching it at startup —
  deliberately, so it is not one more `MAP_CACHE`-style "restart to see your
  edit" trap. Edit the CSV, reload the browser tab. A missing or malformed file
  yields `{"buildings": []}`, never a 404; rows with no town/type or an
  unparseable x/y are skipped individually.
- `frontend/js/specialBuildings.js` (global `SpecialBuildings`) fetches **all
  towns at once** on load — the file is small, so switching maps costs no
  request — and publishes them to `AppState.specialBuildings`. A failed fetch is
  a `console.warn`, not a toast.
- `mapView.js` owns the drawing: `layer-buildings`, created in `renderMap()`
  alongside the other map-detail layers and inserted **before**
  `layer-trajectories`, so actors, props and paths all draw over it.
  `_renderSpecialBuildings` filters by `AppState.map` and runs from two places —
  inside `renderMap` (which replaces the layer wholesale) and off a `change`
  patch carrying `specialBuildings` (the fetch can land either side of the first
  render). The group is `pointer-events: none` throughout: a hit target here
  would swallow clicks aimed at the road under it.
- The label is an ordinary object label: `font-size: MAP_LABEL_M`, class
  `map-label building-label` — see "Every object label on the map is one size and
  one hide rule" under Frontend conventions. `.building-label` adds only its
  colour (dark violet text, white casing, inverting `.map-label`'s default). The
  dots stay at every zoom; only the text goes.
- The **`Sonderorte`** checkbox (`#toggle-buildings`) is the 7th entry in the
  Ebenen menu — the pill now reads `N/7` — wired in `_setupLayerToggles` by id
  like the other six, through a getter because the layer is recreated per
  `renderMap`.

## The in-editor preview (`frontend/js/simulate.js`) and the cached CARLA lane graph

The Play/Pause/Stop preview is a per-tick kinematic re-implementation of the real controllers
(`SimpleVehicleControl` / `PedestrianControl`), not an idealisation of the authored events — it
evaluates all 4 real triggers (including the `distance_to_ego` 60 s OR-fallback, the
`assign_route`/`after_event` trigger rewrites `backend/scenario_io.py` applies at export, and
an `after_event` naming another actor's event), and
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
- Exports are written to `/tmp/` and removed by a `BackgroundTask` after the response is sent (both export endpoints, `backend/main.py`).

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

**There are two ScenarioRunner checkouts on this box and they do not agree — check which one you are editing.** `/home/dellpro2/Antonio/run.sh` executes **`/home/dellpro2/Antonio/scenario_runner`**: it `cd`s there and runs that repo's own `scripts/run_selfref_video_test.py`, which hardcodes `SCENARIO_RUNNER_ROOT` to the same path and `Popen`s its `scenario_runner.py`. `tests/run_carla_cases.py` drives the *same* `run.sh`, so both paths now exercise one install and **`/home/dellpro2/yungloon/scenario_runner-0.9.15` is imported by neither** — only the CARLA server binary and the `agents.navigation.*` package come from yungloon (`CARLA_ROOT=/home/dellpro2/yungloon/carla-0.9.15`). Their `atomic_behaviors.py` differ by ~1985 lines, and the yungloon copy is the **locally patched** one (`CHANGES_LOCAL.md` there records it): its `ChangeActorWaypoints.initialise` filters the router's output with a `> 1.0 m` dedup **plus a heading band that drops reversals**. The install `run.sh` actually runs carries the same 2.0/4.3 heading band (verified 2026-08-24 by reading both files), so `simulate.js`'s `_exactRoute` filter (`ROUTE_HEADING_ACCEPT_LO`/`HI`) models what actually executes. **The executed install also carries one further local patch**: `ChangeActorWaypoints.initialise` binds its `ego_next_wp` seed *before* the waypoint loop instead of inside the `i == 0` branch. Unpatched — and stock 0.9.15 is unpatched — a route whose first waypoint is `shortest` and whose second is `fastest` reaches the heading filter's fallback with that variable unbound and kills the run with an `UnboundLocalError`. **The patch is deliberately not load-bearing**: the editor never emits such a route (waypoint 0 is the seed and is always `fastest`, enforced again as a 400 in `validate_scenario_params`), so exports run on an unpatched install either way. It covers hand-written and LLM payloads only. The yungloon copy still has the bug and is executed by nothing. Both resolve `agents.navigation.global_route_planner` to `/home/dellpro2/yungloon/carla-0.9.15/PythonAPI/carla/agents/navigation/`, and the GRP is the `CarlaDataProvider` singleton at sampling resolution **2.0** — the value `probe_carla_lane_graph.py` matches. It takes only `SCENARIO_FILE` — no `--goal` flag exists in this script, and it never launches `automatic_control_1.py` or any other external agent. Every ego manoeuvre — where it goes, when it speeds up, whether it turns at a junction — is now **authored in the editor as an event on the ego**, exactly like an NPC's, and reaches the file as the ego's own `heroBehavior` Act. Without a `follow_trajectory`/`assign_route` event the ego has no plan and drives its spawn lane via `SimpleVehicleControl`'s own `map.get_waypoint(...).next(2.0)` walk, which will not turn at a junction — that is expected, not a bug, and it is why junction/turn scenarios need a path event.

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

`tests/` holds four layers — backend normalization, props, templates, events, actor types, elevation, waypoints, and the Loop2Scenic benchmark cases — see `tests/README.md`:

```bash
bash run.sh 9090                 # terminal 1
bash tests/run_tests.sh          # terminal 2 (EDITOR_URL overrides the target)
```

That runs `test_normalization.py` (123 checks, no browser or server needed — the last three build a real `.xosc` through the sibling repo to pin cross-actor `after_event` name resolution), then `compare_xodr_lane_graph.py` (also no browser/server/CARLA — validates `backend/lane_graph_builder.py` against the 8 committed probed graphs), then the ten Playwright suites: props (54), prop yaw (23), templates (159), events (60), ego events (75), actor types (260, grows with the catalogue), elevation (33), route fidelity (9), undo (44), waypoints (67). All but the first two drive a real browser against a real server and a real export. **Restart the editor first if you changed `../llm-scenario-gen`** — otherwise the frontend shows new catalogue data while the backend exports the old, which looks like a test bug and is not one.

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
