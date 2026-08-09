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
- **Render JSON point shape is `[x, y, z]`** for `directionLine` and `centerline`, and `spawnPoints` carry a `z`. Every consumer destructures positionally (`const [x0, y0] = …`), so the third element is backward-compatible — but a new consumer must not assume length 2. Costs ~11% payload; paid once at startup.
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
it otherwise carries `behaviors`/`trigger_distance`/`events` exactly like an NPC
(see "The event model" below).

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
| `event_builders.py` `_ROUTE_ACTION_TYPES` | may use `assign_route` | route event **silently dropped**, and anything chained after it left dangling |
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

Silent behaviours worth knowing when debugging "my event did nothing":

- Unknown action/trigger strings are **silently coerced** to `follow_trajectory` / `simulation_time` rather than raising — a typo in a new action name looks like a no-op.
- An `assign_route` action forces its own trigger to `simulation_time @ 0` (`backend/scenario_io.py`, mirrored in `frontend/js/scenarioIO.js`).
- An `after_event` trigger pointing at an `assign_route` event is rewritten to `distance_to_ego @ 400`.
- A `distance_to_ego` trigger on an **ego-owned** event is rewritten to `simulation_time @ 0` — a distance from hero to itself is always 0, so the condition would fire on tick 1 regardless of the configured value. This coercion runs in `_normalize_actor` **after** the `after_event`→`assign_route` rewrite above, so a rewritten trigger on an ego event is caught too. `eventPanel.js` additionally omits the option from the trigger dropdown when the actor is the ego, and `event_builders.py`'s `build_start_event` / `_add_custom_event_start_trigger` fall back to `simulation_time` for `entity_name == 'hero'` as a third, defensive layer.
- `eventPanel.js` permits at most one path-producing event (`follow_trajectory` or `assign_route`) per actor (`frontend/js/eventPanel.js`), the ego included — this is also what `route_waypoints` (for route XML export) is derived from now that there is no actor-level `ego.trajectory`.
- **An actor with `events: []` is not stationary — it drives off.** `build_custom_event_chain` returns `False` for an empty list and `xml_builder` falls back to `build_behavior_chain` with the default `behaviors: ['constant_speed']`. This applies to the ego exactly as it does to an NPC: an ego placed with no events gets its own `heroBehavior` Act built from the fallback chain, not a motionless spawn.

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
the acting entity itself is **not** rejected — `"my current speed plus a
delta"` is a well-defined one-shot action (`ChangeActorTargetSpeed` with
`relative_actor == actor`), and the UI cannot produce it by accident since
`_relativeActorOptions` already excludes the actor from its own dropdown.

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

**No build step, no bundler, no npm.** Each `frontend/js/*.js` is an IIFE attaching one global: `AppState`, `Api`, `MapView`, `ObjectsManager`, `EventPanel`, `Simulator`, `TrafficSignals`, `ScenarioTemplates`, `PropCatalog`, plus `Toast` / `Confirm` / `UndoStack` from `app.js`. Several files (`toolbar.js`, `properties.js`, `weather.js`, `scenarioIO.js`, `mapImport.js`, `welcome.js`) export nothing and simply bind DOM listeners on load.

- **Script order in `frontend/index.html` (the `<script>` block near the end) is load-bearing** — `app.js` first, dependents after; `propCatalog.js` must precede `toolbar.js`, which renders the prop tiles from it. A new module must be added there or it never runs.
- Cross-module communication goes through `AppState`. `set()` / `updateById()` / `removeById()` / `select()` emit `change`, `actorUpdated`, `actorRemoved`, `selectionChanged`, `stateLoaded`, `trafficSignalSelected`, `trafficSignalUpdated`. Subscribe via `AppState.on(...)`; never reach into another module's DOM.
- Modal editor state (`trajectoryMode`, `routeMode`, `triggerPointMode`, `activePathEventId`, `pendingTemplate`, `pendingProp`) lives on `AppState` and is what the `mapView.js` click handlers branch on.
- The left toolbar is **tabbed** (`Akteure` | `Requisiten`, `data-toolbar-tab`). `toolbar.js` uses **event delegation** on `#toolbar`, not a load-time `.tool-btn` snapshot — prop tiles are rendered at runtime and a snapshot would silently miss them. Tab state is module-local, matching `_overviewPanelTab` in `properties.js`.
- Props reuse the `.actor-group` class (plus `.prop-group`), which gives them selection, body-drag and the `mapView.js` pan-exclusion list for free. If you add a new draggable map object, do the same rather than adding a class to three separate `closest()` checks.
- Use `Toast.success/error/warn/info` for feedback (there are no `alert()` calls) and `await Confirm.show(msg)` for destructive actions.
- **UI-facing strings are German; code, comments, and identifiers are English.** Match this when adding UI.

## Maps

- Bundled towns live in `maps/<Town>/<Town>.xodr` (plus optional `.jpg` thumbnail and `_summary.json`), auto-discovered by `_scan_xodr_paths` at import time.
- Uploaded maps persist to `maps/_uploaded/*.xodr` and are re-parsed into `MAP_CACHE` on every startup (`backend/main.py:44-68`); a bad file logs a failure for that town without taking down the server.
- `maps/` is **not** gitignored — uploads land in the working tree.

## Repo notes

- `README_UPDATED.md` is a second, newer README coexisting with `README.md`. Check both before assuming docs are stale.
- `generate_pptx.py` and `frontend/presentation.html` are the project slide deck, served by `GET /api/presentation.pptx` (which shells out to the script). Unrelated to editor functionality.
- Exports are written to `/tmp/` and removed by a `BackgroundTask` after the response is sent (`backend/main.py:154-159`).

## Verification

```bash
bash run.sh                      # startup log lists each town + road count + elevation range, ends "Map cache ready."
curl -s localhost:9090/api/maps  # → {"maps": [...]}
```

Then in the browser: place an ego, add a `follow_trajectory` event to it (or leave it with no events at all — it still drives off on the shared `constant_speed` fallback), add an NPC with a `set_speed` event, and click **Export .xosc**. This is the only path that exercises the `llm-scenario-gen` dependency. Check the export: `grep -c external_control` on the file must be `0`, and `grep -A2 'Controller name="HeroAgent"'` must show `simple_vehicle_control`.

For props, also open **Requisiten**, place a few cones (the tool stays armed), place a barrier on each carriageway of a two-way road, and export. In the `.xosc` check that each prop has a teleport-only `<Private>` with **no `ControllerAction`**, that `miscObjectCategory` is `obstacle` on everything except `streetbarrier`, and that the two barriers' `h` values differ by 180°.

**Rotation can only be verified in CARLA**, not from the `.xosc`: a wrong `yaw_offset` produces a file that looks entirely correct. Run it with:

```bash
SCENARIO_FILE=/abs/path/scenario.xosc bash /home/dellpro2/Antonio/run.sh
```

**The ego drives itself now — there is no `SCENARIO_GOAL` and no external agent.** `run.sh` starts CARLA on port **2010** (if not already up) and runs `/home/dellpro2/yungloon/llm-scenario-gen-xosc/scripts/run_selfref_video_test.py`, which drives `scenario_runner_xosc.py` from a separate `scenario_runner-0.9.15` install and records FPV/THD/BEV video. It takes only `SCENARIO_FILE` — no `--goal` flag exists in this script, and it never launches `automatic_control_1.py` or any other external agent. Every ego manoeuvre — where it goes, when it speeds up, whether it turns at a junction — is now **authored in the editor as an event on the ego**, exactly like an NPC's, and reaches the file as the ego's own `heroBehavior` Act. Without a `follow_trajectory`/`assign_route` event the ego has no plan and drives its spawn lane via `SimpleVehicleControl`'s own `map.get_waypoint(...).next(2.0)` walk, which will not turn at a junction — that is expected, not a bug, and it is why junction/turn scenarios need a path event.

This `scenario_runner_xosc.py` install does **strict OpenSCENARIO XSD validation** that the primary `/home/dellpro2/Antonio/scenario_runner` (used by `tests/run_carla_cases.py`, whose own XSD check is commented out) does not. Two things this catches that the test suite currently cannot: an emitted `<Vertex>` carries `relativeTime`, but the strict schema wants `time` — any `follow_trajectory` action fails this validator today, ego or NPC, a pre-existing mismatch in `event_builders.py`. Before burning a CARLA run on a trajectory-bearing scenario, expect this failure under `run.sh`'s current toolchain; it is unrelated to whether the ego or an NPC owns the event.

**A storyboard Act needs at least one `<ManeuverGroup>` before its `<StartTrigger>`** — the OpenSCENARIO XSD requires it, and `_inject_traffic_signals`'s fallback (`xml_builder.py`) used to create an empty `ScenarioBehavior` Act unconditionally whenever a scenario had zero NPCs and zero traffic signals. That was harmless under a parser that doesn't validate structure (an empty `ManeuverGroup` loop is a no-op), but is a hard failure under one that does, and an ego-only scenario — no NPCs at all — is now an entirely normal shape to export. Fixed by only creating that Act when there is something to put in it.

`tests/` holds four layers — backend normalization, props, templates, events, actor types, elevation, and the Loop2Scenic benchmark cases — see `tests/README.md`:

```bash
bash run.sh 9090                 # terminal 1
bash tests/run_tests.sh          # terminal 2 (EDITOR_URL overrides the target)
```

That runs `test_normalization.py` (81 checks, no browser or server needed), then the seven Playwright suites: props (54), prop yaw (23), templates (149), events (43, one of them a `KNOWN` open defect — see below), ego events (45), actor types (272, grows with the catalogue), elevation (33). All but the first drive a real browser against a real server and a real export. **Restart the editor first if you changed `../llm-scenario-gen`** — otherwise the frontend shows new catalogue data while the backend exports the old, which looks like a test bug and is not one.

`test_ego_events_e2e.py` is kept separate from `test_events_e2e.py` rather than folded in: the older suite's `EGO` fixture and every one of its assertions assume an inert ego (no behaviors, no events), which was true before the ego became a controllable actor and is the entire premise the new suite tests against.

`test_events_e2e.py` reports one **`KNOWN`** line instead of failing. `Checks.known_issue()` exists so an open defect stays visible without making the exit code permanently non-zero; it flips to `KFIXED` when the bug is fixed, which is the cue to promote it to a normal check. The defect is in `build_custom_event_chain` (`../llm-scenario-gen`): it maps event ids to names for *all* events, then skips any whose action builder returns `False` (`follow_trajectory` under 2 waypoints, `assign_route` on a non-routable type), leaving any `after_event` chained onto the skipped one pointing at a `storyboardElementRef` that is not in the file. That trigger can never fire.

### CARLA behavioural tests

**This section, and `tests/run_carla_cases.py`/`tests/carla_cases.py` themselves, describe the pre-ego-authoring world and have not been re-baselined yet** — deliberately deferred, a separate piece of work. Two things changed underneath them: `SCENARIO_GOAL` is dead in the current `run.sh` (it runs `run_selfref_video_test.py`, which has no `--goal` and launches no external agent — dead independently of anything below), and the ego now drives via its own authored events rather than a planner. Every case's ego is currently `events: []` (an editor default, never a literal in the harness), which — now that `events: []` triggers the shared `constant_speed` fallback for the ego too — means **every case's ego drives off in a straight line down its spawn lane, planner or no planner**, rather than sitting still. All 28 cases need re-running and their assertions re-checked before this section can be trusted again; treat every specific claim below about ego motion as describing the old, planner-driven behaviour until that happens.

`tests/carla_telemetry.py` is a **passive** sidecar: it attaches to the running CARLA, subscribes with `world.on_tick`, and writes one CSV row per actor per tick. It **must never call `world.tick()`** — ScenarioRunner owns the clock in synchronous mode. Names must be captured while actors are alive (a background poller does this); resolving them after the run returns blanks, because teardown has already destroyed everything.

`tests/run_carla_cases.py` builds each scenario through the real editor, runs it via `/home/dellpro2/Antonio/run.sh`, and judges it against **two independent sources**:

- **ScenarioRunner's own log** — it prints `[OSC][<t>s][EVENT][<name>] RUNNING|END` for every storyboard element, which gives exact trigger-firing and completion times for free. This is the cheapest useful signal in the whole toolchain and needs no simulator introspection.
- **the telemetry CSV** — whether the actor actually moved as commanded.

Both are needed: an event can go `RUNNING` while the vehicle ignores it entirely.

The two clocks differ. Telemetry carries CARLA's `elapsed_seconds` (a world clock that keeps counting across runs and starts in the hundreds); the OSC log counts from scenario start. They are reconciled through the ego's first motion, because **every NPC Act** starts on `hero traveled 0.1 m` (`_add_act_start_stop_triggers`, `wait_for_hero=True`). The hero's *own* Act (`heroBehavior`) does not carry this gate — it starts on `SimulationTime > 0` alone, because the ego cannot wait for itself to move before it is allowed to move. `act_start()` (`tests/carla_analysis.py`) still works as the shared time origin either way, since the ego still has to move eventually for any of this to be worth measuring.

A case states **both ends of the ego's drive**: `ego` (the spawn, placed in the editor) and `goal` (passed through as `SCENARIO_GOAL`). `run_case` always sets `SCENARIO_GOAL`, falling back to `C.GOAL` (the Town01 pose) rather than letting run.sh's own default through — so **any case on another town must state one** — see `GOAL_T3` / `GOAL_T3_PARK` / `GOAL_T4_HWY` / `GOAL_T5_HWY` / `GOAL_T5_JCT_LEFT` / `GOAL_T5_JCT_STRAIGHT` in `tests/carla_cases.py`. The junction goals are real exit waypoints read off CARLA's junction API, not points guessed off a map, and they are the **only** thing that makes the ego turn: `expect_*` proves the turn happened by measuring the ego's net heading change (`A.heading_change`), because there is no storyboard event to read off the OSC log.

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

**Any actor with `events: []` is not stationary — it drives off, the ego included.** `build_custom_event_chain` returns `False` for an empty list and `xml_builder` falls back to `build_behavior_chain` with the default `behaviors: ['constant_speed']`. A "parked" car in a bench case covered 226 m before this was caught. Anything that must stay put needs an explicit `set_speed 0` event — `_parked()` in `tests/carla_cases.py`.

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
