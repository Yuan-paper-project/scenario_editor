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
- **There is no linter and no CI**, and no unit tests. Automated coverage is `tests/test_normalization.py` (pure Python) plus twenty Playwright end-to-end suites that need a running editor, and `tests/run_carla_cases.py`, which needs a running CARLA (see Verification). Everything else is verified manually.
- All map geometry is parsed once at startup into `MAP_CACHE` (`preload_maps`, `backend/main.py`). Changes to `map_renderer.py` only take effect on restart — `--reload` does this automatically on save.
- **`--reload` watches every `*.py` in the repo — `tests/` included.** Writing or editing a test file while a suite runs restarts the server under it: the in-flight request dies (seen as a batch-export download that never arrives), and on 2026-10-09 the restarted worker then wedged outright — ~90 connections unread in CLOSE-WAIT, no response, and after it was killed the reloader left a zombie and never respawned. Only a fresh `run.sh` recovers. When editing tests and running suites in parallel, run the suites against a server **without** `--reload` (`.venv/bin/uvicorn backend.main:app --port 9091`, `EDITOR_URL=http://localhost:9091`).
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
- **A section's LAST sample evaluates laneOffset and widths at the left limit (`s_end − ε`)** — `_section_eval_s` (`backend/map_renderer.py`), used by the polygon builder and the `directionLine` loop. CARLA maps *step* the laneOffset at a lane-section boundary to make up for a lane that starts or ends there (Town03 road 1566: −6.635 → −0.635 at s=2); evaluating at `s_end` picks the record that starts there and throws section N's last vertex up to 6 m sideways. That was every spike and long wedge at a road join (Town03/04/06/10). The road `centerline` emits both limits at such a step so the marking jogs instead of slanting. Spawn points never had the bug — they drop the section-end sample outright.
- **Lateral positions go through `_lateral_point`, which clamps the distance to just short of the arc centre on the concave side.** Past the radius an offset curve folds back on itself — the bow-tie sidewalk corners at Town01/02 junctions (Town02 road 2: 7.5 m radius, sidewalk outer edge at 8.3 m). It needs per-sample curvature, which comes from `_curvature_at` rather than a 5th sample element, because `_sample_geometry`'s 4-tuple is unpacked positionally everywhere. **Arcs are sampled at ~6° steps** (`ARC_SAMPLE_ANGLE_RAD`), not the flat 4 m that used to facet tight bends.
- **A section's evaluation s is floored at its own start** (`_section_eval_s(samples, s_start)`).
  The section filters take samples within 1e-4 of `s_start`, and the sampler can emit both s = 2.0
  (the interval) and 2.000000000000057 (the boundary); the 2.0 one read the *previous* laneOffset
  record. Town06 road 1124 steps −14.635 → −0.635 there, so its connector lanes started 14 m to one
  side and every route through junction 1050 drew a 14 m sideways jump. `lane_centre_points` is
  the same maths at exact s, unrounded, for `lane_graph_builder`.
- `tests/check_render_geometry.py` (no server, in `run_tests.sh`) pins both across all 9 towns,
  checking jumps at **both** ends of every polygon edge and directionLine. **Town06 road 598 is allow-listed**: its `.xodr` has a 0.39 m laneOffset blip (+0.635 → −2.865 → +0.635) inside one section — a source defect, not ours.
- **A road that passes over another one is drawn in `#layer-overpass`** (`_roadOverpassLevels`, `mapView.js`), one `.ovp-level` group per level, each holding a dark casing (`.ovp-casing`), the lane polygons, and that road's own markings (`.ovp-marks`) and arrows (`.ovp-dir`). Before it, paint order was document order, so the street *under* a bridge — markings and all — was often drawn across the deck. Pairs are compared **at the overlap** (a centreline sample of one road inside the other's lane polygon, against the other road's centreline z there), not by road-average z, because a ramp is low at one end and high at the other; > `OVERPASS_GAP_M` (4 m) is an over/under, less is a junction at grade. The layer sits above markings, arrows and crosswalks, and `layer-spawns` is **moved above it** so a bridge's own spawn dots are not painted over by its deck. The Markierungen / Fahrtrichtung checkboxes reach the overpass copies through `_applyLayerToggleExtras`; Luftbild hides the overpass like `#layer-roads`, Beides outlines it. The bundled data has very few: Town04 road 39 over 47, Town05's ring 37 over 3/9/24 — Town03's "elevated" area overlaps nothing (checked offline by brute force). **Placement height under a bridge is still nearest-lane-in-2-D** (`groundZAt`), deliberately: a "topmost road wins" rule was tried and reverted, because the generator relies on a vehicle on a lane centre taking its own lane's height, and it would lift a car on the street onto the deck.
- **`median` / `border` / `restricted` / `bidirectional` lanes are hatched** (`#hatch-blocked` in `index.html`'s `<defs>`, `BLOCKED_LANE_TYPES` in `mapView.js`) and in Beides lose the white lane outline. They used to fall through to `DEFAULT_LANE_COLOR`, i.e. asphalt, so Town03's tunnel median read as a drivable lane. Every lane polygon now carries `class="lane lane-<type>"`. **`bidirectional` is treated as a wall everywhere, not just drawn as one**: its only use in the bundled maps is Town03's ring-highway separator (lane 1 of roads 0–4, 28, 29, 65–69 — the tunnel approach), and CARLA's planner never routes it (`lane_graph_builder.py` `_ROUTABLE_TYPES`). So it gets no direction arrows, no spawn points, no route snapping (`ROUTE_SNAP_LANE_TYPES`) and no preview lane-following (`simulate.js`). An uploaded map with a real centre turn lane would lose those too — revisit if one turns up.
- **Road furniture comes from the `.xodr`, drawn in `mapView.js` (`_renderRoadMarks` & co), never hit-tested:**
  - `roads[].marks` — painted lines from each lane's `<roadMark>` (a lane's mark is its **outer** border; the centre lane's is the reference line), `{type: 'solid'|'broken', color: 'white'|'yellow', width, points}`, built by `_build_mark_polylines` with the same left-limit and fold-clamp maths as the polygons. A double mark (`broken solid`) becomes two lines ±0.12 m, first token on the left in s direction. `none`/`curb`/`grass` are not drawn. Mark `sOffset`s are added to the sample s-values so a type change has no gap. **Junction roads' marks are not drawn** (connector edges criss-cross the box); a road with no marks falls back to the old guessed yellow centreline. Lives in `#layer-markings` (`Markierungen`).
  - Parking **lanes** are tinted blue (`LANE_COLORS`) with a „P" every 20 m (`_renderParkingGlyphs`), in `#layer-markings`. **Except on junction connectors**: the `.xodr` carries the kerb-side parking lane across the box as a `parking`-typed connector lane (Town03 25 roads, Town05 8, Town07 2), which drew blue strips through junctions; `build_map_render_data` paints those in the driving colour. The lane keeps `type: 'parking'`. Town03's 121 `<object type="parking">` bays are deliberately **not** drawn: they cover only 10 of its 54 parking-lane roads (plus 13 bays on roads with no parking lane), and the aerial photo shows no bay markings, so they made the map disagree with itself.
  - `signs` — static Stop (`type="206"`) / Yield (`205`) signals → `#layer-signs` (`Schilder`). Town05/07/10HD only.
  - `speedSigns` — the `Speed_NN` objects (km/h) → `#layer-speeds` (`Tempolimits`, off by default, hidden with the labels when zoomed out). **Not the per-road `<type><speed>` records**: those say `mph`, but CARLA's `MapBuilder::CreateRoadSpeed` discards the unit and uses the raw number only to size Stop/Yield trigger boxes, while a vehicle's limit comes from the sign actors. Taken literally they put 89 km/h on Town03's residential streets. Only Town01–05 have signs.
- The frontend entry points are `ObjectsManager.groundZAt(x, y)` (bare surface, 60 m search radius, `0` beyond that) and `ObjectsManager.surfaceZFor(type, x, y, prop)` (surface + the right clearance). **Anything that moves an object must call `surfaceZFor`** — placement, the drag `mouseup`, the X/Y fields, the prop-type swap.
- `SPAWN_CLEARANCE` (`frontend/js/objects.js`): vehicles `0.5`, VRUs `0.6`, waypoints `0.5`, props none. **Always err high** — spawning below the surface fails hard in CARLA (`"collision at spawn position"`), while spawning above it is free because actors settle under physics within a tick. VRUs get more because the profile models the *reference line* and not kerbs or sidewalk height, and sidewalk lanes carry no `directionLine`, so a pedestrian on a kerb takes its z from the carriageway ~0.15 m below. A prop's catalogue `z` is a surface-relative offset, and for a prop it is **not** a clearance to err high on: it is the measured lift that puts a mesh with an off-base pivot onto the road — see "Static props".
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
downstream lookup would otherwise turn a typo into a Lincoln MKZ. Laden warns about one the moment the file is loaded (`scenarioIO.js`), since the type picker
offers no way out of a type that is in no group — the fix is to delete and re-place the actor.

`mapView.js` `WALKER_TYPES`, `xml_builder` `_PEDESTRIAN_TYPES`, `event_builders`
`_WALKER_ACTION_TYPES` and `backend/scenario_io.py` `_WALKER_ACTOR_TYPES` are the
same split maintained **four** times — keep them in step. The last two gate
`lane_offset`, which is available to every `<Vehicle>` and therefore to a
**wider** set than `assign_route`: a `cyclist` aliases to `bike`, so the route
planner will not route it but `simple_vehicle_control` honours its offset
perfectly well. Do not "simplify" either one into `_ROUTE_ACTION_TYPES`. `_template_for` picks the base
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

- **Actions** (6): `follow_trajectory`, `assign_route`, `set_speed`, `set_distance`, `lane_change`, `lane_offset`.
  **`set_distance` is hidden from the action grid by decision** (`HIDDEN_ACTIONS`,
  `eventPanel.js`) but kept in every layer, so a loaded one still renders and exports: the
  emitter writes no `DynamicConstraints`, so `KeepLongitudinalGap` falls back to
  `max_speed_limit = 100` and commands 100 m/s whenever the gap is too large
  (`atomic_behaviors.py` `KeepLongitudinalGap.__init__`), and the preview does not simulate
  it. Re-enabling it needs a `maxSpeed` field first.
- **Triggers** (7): `simulation_time`, `distance_to_ego`, `distance_to_point`, `ego_speed`,
  `relative_speed`, `after_event`, `event_started`.
  `distance_to_ego` is **„Abstand zu Akteur"**: it carries an optional `entity_ref`, the
  *other* actor, measured to the acting one (`RelativeDistanceCondition`, the other actor
  triggering). **Absent means the ego**, and stays absent through the export, so every older
  payload is byte-identical; the key name is kept for the same reason. The ego may use it
  only naming an NPC — absent or naming itself it is still coerced to `simulation_time @ 0`
  (see below); an NPC naming itself is a 400. `relative_speed` is `{entity_ref, rule, value}`
  → `RelativeSpeedCondition`, which is **speed(triggering) − speed(entityRef)**, so the
  *other* actor is emitted as the triggering entity and the acting one as the reference: a
  positive value reads "the other one is that much faster than me". Both speeds are
  magnitudes; value may be negative; a self-reference is a 400. Both actor-relative triggers
  are hidden from the dropdown when there is no other actor (an ego alone). `after_event` (fires on the named event's `completeState`) and
  `event_started` (UI „Mit Start eines Events", fires on its `startTransition` — "when
  X starts, also do Y") are the two **event references**; both may name an event on
  **any** actor, except that **an NPC may never wait on an ego event** (see below).
  `ego_speed` is `{rule: greaterThan|lessThan, value}` → a `SpeedCondition` on `hero`
  (`TriggerVelocity`, the ego's *measured* speed — so `lessThan` is true at once for a
  standing ego). It is one of the ways an NPC reacts to the ego now that it may not
  wait on an ego event, alongside `distance_to_ego`, `relative_speed` and
  `distance_to_point` naming the ego.
- **There is no trigger delay, by decision.** ScenarioRunner builds a `<Condition
  delay="d">` as `Sequence(TimeOut(d), condition)` — it waits *before it starts
  watching*, the reverse of the OpenSCENARIO meaning — in stock 0.9.15 and the local
  checkout alike (`convert_condition_to_atomic`). For "after X + 3 s" that means the
  condition starts watching at t = 3 s and `OSCStartEndCondition` then needs a START/END
  newer than its own `initialise`: no delay at all if X ends later, never fires if X
  ended during the wait. A correct delay needs a ScenarioRunner patch (condition first,
  `TimeOut` after); it was offered and declined. Every emitter `delay` stays `'0'`.

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
- A `distance_to_ego` trigger on an **ego-owned** event that names no other actor (or the ego itself) is rewritten to `simulation_time @ 0` — a distance from hero to itself is always 0, so the condition would fire on tick 1 regardless of the configured value. One naming an NPC is kept. This coercion runs in `_normalize_after_event_chains` **after** the `after_event`→`assign_route` rewrite above, so a rewritten trigger on an ego event is caught too. `eventPanel.js` additionally omits the option from the trigger dropdown when the actor is the ego, and `event_builders.py`'s `build_start_event` / `_add_custom_event_start_trigger` fall back to `simulation_time` for `entity_name == 'hero'` as a third, defensive layer.
- **An event the emitter would drop is a hard 400, and the editor will not let you build one.** `_add_follow_trajectory_action` / `_add_assign_route_action` return `False` under 2 waypoints (and the latter also for a non-vehicle type), `build_custom_event_chain` then skips the whole event, and anything chained onto it with `after_event` is left pointing at a `storyboardElementRef` that is not in the file. Four layers now close that off, and the frontend three share one predicate — `ScenarioRules` in `frontend/js/app.js` (`actionEmits` / `eventProblem` / `problemsOf`), which `eventPanel.js` (warning chip + the `#event-warn` count), `scenarioIO.js` (`_validateScenario`) and `simulate.js` all call:
  - a path event is still **seeded with one waypoint on the actor's own pose** (`startPathMode`), so the *first* map click already completes a usable 2-point path — but it now **deletes itself** when draw mode ends still under 2 (`_discardIncompletePath`, `frontend/js/objects.js`, hung off the `AppState.on('change')` mode transition rather than the *Fertig* button, because Esc clears the flags directly in `mapView.js`). The seed alone was the old failure: below the emitter's minimum, invisible on the map (`mapView` skips a path under 2 points), and reported by the card as „Pfad gezeichnet".
  - **`Route zuweisen` is `disabled` for `pedestrian`/`child`/`cyclist`** — `AssignRouteAction` is vehicle-only (`_ROUTE_ACTION_TYPES`), and the grid used to offer it to everyone.
  - `validate_scenario_params` raises on both cases. `_ROUTE_ACTOR_TYPES` (`backend/scenario_io.py`) is a third copy of that type list and **must include the aliases that resolve to a routable type** (`lorry`, `moped`) — the emitter runs `_TYPE_ALIASES` first, so without them the backend rejects payloads the emitter accepts.
  - `build_custom_event_chain` builds its name table from the events that **actually got appended** (two passes: actions first, then triggers), so a chained `after_event` whose target was skipped now falls back to a plain `simulation_time` start instead of dangling. This was the long-standing `KNOWN` entry in `test_events_e2e.py`.
- **A `distance_to_point` trigger is never point-less.** Choosing it in the panel places the point on the acting actor immediately (`ObjectsManager.defaultTriggerPoint`) with a **5 m** radius (`DEFAULT_POINT_RADIUS`, `eventPanel.js` — a fresh radius rather than the outgoing trigger's value, which is a delay in seconds or a 400 m ego distance and means nothing here). A missing point used to be defaulted to `(0, 0, 0.2)` in `_normalize_structured_event` — the map origin, which a 3-D `DistanceCondition` can never reach — so that is now a 400 too; and in the emitter it fell through to `simulation_time(value)`, reading the radius in metres as a delay in seconds (a 20 m radius became `t > 20 s`). Both fixed. (The `?? 20` fallbacks left in the frontend and `_normalize_structured_event`'s `trigger.get("value", 20.0)` are for a payload carrying no value at all, and still agree with each other — only the *creation* default is 5.)
- **The point is moved by dragging its map marker; there is no picking mode.** `layer-trigger-points` is appended **after** `layer-actors` (`renderMap`, `mapView.js`, last of the three top layers — `layer-paths-top` and `layer-actors-top` go before it) rather than under the trajectory layer, because a point seeded on its own actor would otherwise be drawn *and hit-tested* under the vehicle rectangle. The marker carries an invisible 2.2 m hit circle (`.trigger-point-control`) — the drawn one is 0.7 m and sub-pixel at town zoom — and its drag writes x/y per mousemove but re-derives z once, on mouseup, via `ObjectsManager.moveTriggerPoint` (`_nearestLaneProjection` is a full lane scan; same reasoning as an actor's z). The mouseup also **expires** `_suppressNextClick` on a timer: the marker is re-rendered mid-drag, so the element the drag started on is detached by mouseup and the browser may dispatch no click at all — a permanently-set flag then swallows an unrelated map click much later.
### Event references (`after_event`, `event_started`) may name another actor's event, and may never form a loop

Everything below applies to both reference kinds — `ScenarioRules.isEventRef`
(`frontend/js/app.js`) and `_EVENT_REF_TRIGGERS` (`backend/scenario_io.py`) are the
switch — except the `lane_offset` ban, which is about *completion* and so covers
`after_event` only: a `lane_offset`'s START is well defined, and `event_started` may
name one. `_isChainTarget(ev, triggerType)` is the dropdown/default/re-point predicate
that carries that difference; `_canChainOnto` and the delete sweeps keep the
referencing trigger's kind.

An event-reference trigger carries `event_id` **plus an optional `actor_ref`**.
An absent `actor_ref` means the event's own actor, which is why every save file,
template, `tests/carla_cases.py` case and LLM payload written before this
existed resolves exactly as it always did — that default is the compatibility
contract and is implemented identically in all four layers.

**It works in CARLA because the lookup was never per-Act.** ScenarioRunner turns
a `StoryboardElementStateCondition` into `OSCStartEndCondition`, which reads a
**global** `py_trees` blackboard key — `(EVENT)<name>-END`, written by
`StoryElementStatusToBlackboard.terminate`, or `(EVENT)<name>-START` (state
`startTransition`), written by its `initialise` — i.e. on the tick the named event's
own trigger succeeds, so an `event_started` fires on that tick or the next.
Measured in CARLA (Town05): a same-actor and a cross-actor `event_started` both
fired at 2.10 s, the tick of their target. Every Act starts on
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
  `resolve_custom_event_triggers` once. Actors are built in order (NPCs, then the
  hero last), so a reference from `adversary` to an `adversary1` event is a forward
  reference and only resolves because the trigger pass is deferred — resolving per actor found no
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
- **The scenario-wide event-reference rules live in one place**,
  `_normalize_after_event_chains` (`backend/scenario_io.py`), called from
  `validate_scenario_params` **after** every `_normalize_actor`. The
  assign_route rewrite and the hero self-distance coercion used to be the tail
  of `_normalize_actor`, which was correct only while a reference could not
  leave its actor. Order inside it matters: route rewrite → NPC→ego ban →
  `after_event`→`lane_offset` ban → cycle check → hero coercion.
- **An NPC may not wait on an ego event — a hard 400, not a coercion.** The ego
  may be driven by the AV under test, whose run carries no ego storyboard events
  at all, so an NPC chained onto one would simply never move, in a file that looks
  well formed. `ScenarioRules.mayWaitOnActor(actor, owner)` is the frontend
  predicate: `_afterEventGroups` drops the whole ego group from an NPC's dropdown,
  `_canChainOnto` refuses it for the delete re-point, `eventProblem` chips a loaded
  file's reference (`npc_waits_on_ego`, blocks the export), and the preview marks it
  `neverFires`. The ego may still wait on an NPC event. **A reference to the ego's
  `assign_route` is not caught**: the route rewrite runs first and turns it into
  `distance_to_ego @ 400`, which is no dependency at all — every layer checks the
  route case before the ban, and must keep doing so.
- **A cycle is a hard 400**, and the editor cannot author one. `after_event` and
  `event_started` edges are walked alike — a loop of "starts with the other" never
  fires either. Every event on a loop waits for a state change that never arrives, so none of them ever
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
- **The preview snapshots cross-actor completions and starts once per tick**
  (`_tickCompleted` / `_tickStarted`, `simulate.js`), same reasoning as `_tickSpeeds`: reading
  another actor's live `fired` map would resolve differently depending on which
  actor `_stepActor` reached first. A **same-actor** reference still reads
  `sim.fired` live — one behaviour tree ticking its own events has no ordering
  ambiguity to remove. `_normalizeEventsForSim` sets `watchActorId` on the
  trigger when the reference leaves the actor, and `neverFires` for a cycle.

### Path waypoints: snapped, editable, and drawn as they will be driven

- **A `fastest` route waypoint is snapped to the nearest driving-lane centreline; a `shortest` one and every `follow_trajectory` vertex are not.** `_routeWaypointAt` (`frontend/js/objects.js`, `ROUTE_SNAP_LANE_TYPES` = driving only, `ROUTE_SNAP_MAX_DIST` 25 m) runs at placement, on the seed waypoint, on the map drag **and** when a waypoint is toggled to `fastest`, so a dragged point can never end up somewhere a clicked one could not. The reason is not tidiness: a `fastest` waypoint is never driven to as authored — `AssignRouteAction` hands it to `GlobalRoutePlanner`, which projects it with `map.get_waypoint()` and routes to whichever lane came out, so a point between two lanes silently becomes one of them, and when that is the oncoming carriageway the vehicle drives away from the route and loops back to reach it. A `shortest` waypoint and a trajectory vertex are the opposite case: they are driven literally, and going where lanes do not (a crossing, a swerve, a cyclist bending out) is the whole purpose. Out of reach of any lane the raw point is kept and a toast says so, once per 4 s rather than once per click.
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
`dimension`, chosen by a small select **inside the speed row** (`für` | `Rate`,
`_speedDimensionSelect` in `eventPanel.js`, `.event-speed-dim`). The unit after the
second field swaps with it — `für … s` vs `Rate … m/s²` — and so does the card summary
(`für Ns` vs `mit N m/s²`).

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
- **The four speed-profile templates ramp** (`RAMP_RATE = 5.0` m/s², `frontend/js/templates.js`),
  and so does `Notbremsung` (`EMERGENCY_DECEL` 8 m/s², released by `distance_to_ego` 25):
  all alternate ramp and hold, because a `rate` event ends on arrival and therefore
  cannot itself hold — every dwell in those chains, including the final one, is a separate
  `time` event. Every other template, and every
  hand-written `tests/carla_cases.py` chain, stays on `time`.
- **`rate` is a local ScenarioRunner patch, not upstream.** See the Verification section.

### `lane_offset`: a held displacement, or a swerve out and back

`LaneOffsetAction` / `AbsoluteTargetLaneOffset` → `ChangeActorLaneOffset`, which
writes the controller's `_offset`; `SimpleVehicleControl._offset_waypoint`
displaces the waypoint it **aims at** along `transform.get_right_vector()` and
leaves its waypoint list untouched. The action state is `{type, direction, offset, continuous?}`
— an **unsigned** magnitude plus a side, the same shape `lane_change` uses — and
the sign is applied at emission, never stored. The card's „½" / „1" preset buttons, at
the end of the **Seite** row (`_laneWidthAt`), sets the offset from the render JSON's `widths` at the actor —
half a lane straddles the line; Town01/02 lanes are 4 m, so a fixed 1.75 m is not half.

- **Positive is RIGHT of travel. That is the OPPOSITE of `lane_change`**, whose
  `RelativeTargetLane` writes `-1` for right because that value is an OpenDRIVE
  lane-id delta and not a distance. Same German „Links | Rechts" in the card,
  inverted sign one layer down.
- **Two modes, the card's „Dauer" toggle.** `Dauerhaft` (absent/`true`, the default
  and every older payload) emits `continuous="true"`: the Event never completes on its
  own. It does **not** hang the run: every Act carries `MaxSimTime > 60`. `Hin & zurück`
  (`continuous: false`) emits `continuous="false"`: the Event completes once the actor is
  within `OFFSET_THRESHOLD` (0.1 m) of the offset, and `terminate()` then puts the offset
  back to 0 — a swerve in one event, which **may** be chained onto with `after_event`.
- **`Hin & zurück` only works on the patched ScenarioRunner `run.sh` executes.** Stock
  0.9.15 writes `_current_target_offset` only in the **relative** branch, so for an
  absolute target the completion test compares against 0, passes on the first tick, and
  `terminate()` resets the offset before the actor moves (on a curve the controller's
  wobble sometimes keeps it outside 0.1 m, so it half-works). The working tree of
  `/home/dellpro2/Antonio/scenario_runner` (uncommitted) sets it for an absolute target
  in `ChangeActorLaneOffset.update`; stock and the yungloon copy do not. **Measured in
  CARLA** (Town04 road 40, 8 m/s, 1.75 m left, `tests/run_actions_ext_carla.py`): out to
  1.6 m, Event END 1.25 s after start, back on the centre ~1.4 s later; the chained event
  fired on the END.
- **"Drift back to the centre" is a SECOND `lane_offset` of 0**, and that is the
  only way to end one. It works because a second offset command sets the first
  atomic's `_overwritten` flag, so its `terminate()` skips the reset and the new
  value stands. `-0.0` is falsy, hence the emitter's `or 0.0` — without it a
  left-hand 0 writes `value="-0"`.
- **Starting an offset ends a running route, but does not stop the driving.**
  `ActorControl.update_offset` stamps `_last_waypoint_command` as well as its own
  slot, so a running `ChangeActorWaypoints`/`ChangeActorLateralMotion` reports
  SUCCESS immediately — but `update_waypoints()` is never called, so the
  controller keeps driving the list it already has, now offset. The visible
  consequence: **an `after_event` waiting on that route fires the moment the
  offset starts**, not at route end. The reverse also holds — a later route,
  trajectory or lane change ends the offset *without* `_overwritten`, so it
  re-centres.
- **An `after_event` may never name a held `lane_offset`** — nor a continuous
  relative `set_speed`, the other action that never completes on its own. One
  predicate on each side: `ScenarioRules.neverCompletes` (`app.js`) and
  `_never_completes` (`scenario_io.py`). The runtime *would* complete one that a
  later command supersedes, but that was judged too conditional to author against.
  Enforced in four places: `_afterEventGroups` omits it from the dropdown —
  and so do the new-event default (`_defaultEvent`) and the delete re-point
  (`_canChainOnto`), all three through one predicate, `_isChainTarget`
  (`eventPanel.js`). **`event_started` is exempt** — the ban is about completion,
  and an offset's start is well defined, so a second Spurversatz or anything else can
  start *with* one; that is the way to chain onto an offset. They drifted once already: the dropdown learned about
  `lane_offset` and the default did not, so a second Spurversatz arrived
  pre-chained onto the first.
  `ScenarioRules.eventProblem` chips a loaded file's reference
  (`after_lane_offset` / `after_continuous_speed`, which also block the export), `_normalize_after_event_chains`
  raises a **400** (not a rewrite like `assign_route` gets — there is no stand-in
  trigger that means the same thing), and the preview marks it `neverFires`.
  Chain onto an offset with `event_started`, or by giving the next event its own
  time or distance trigger.
- **Vehicle-only, but a WIDER set than `assign_route`** — see the actor-types
  section. `PedestrianControl` inherits `update_offset` from `BasicControl` and
  never reads `_offset`, so a walker would get a valid file in which it simply
  never moves sideways; a 400, not a coercion. A `cyclist` is a `<Vehicle>` and is
  allowed.
- `LaneOffsetActionDynamics/@dynamicsShape` is **required by the XSD and read by
  nothing** (`openscenario_parser`'s branch says so outright), so the emitter writes
  a fixed `linear` rather than carrying a dead value through three layers. There is
  no UI for it and `maxLateralAcc` is omitted entirely.
- **The preview simulates it** (`simulate.js`): `sim.x`/`sim.y` stay on the driven
  centreline and the offset is added when the pose is written back (`_pose`), which
  is what the controller does. The driven `laneOffset` approaches the controller's
  `laneOffsetTarget` **exponentially in distance driven** (`LANE_OFFSET_APPROACH_M` = 3 m:
  the remaining gap halves every ~2 m, measured in CARLA out and back alike), so a
  standing actor does not swerve and a `Hin & zurück` completes when it actually gets
  there (`_advanceLaneOffset`) — preview 1.05 s vs CARLA 1.25 s in the case above. Storing the displaced position back into `sim.x/y`
  would be wrong — `_walkDirLine` walks from the position it is handed toward the
  next centreline point, so the actor would converge back onto the centreline over
  a few ticks and quietly eat the offset. `_pose` is also what the two distance
  triggers measure from. The supersede rules above are mirrored in
  `_supersedeLaneOffset` / `_supersedeWaypointEvents`.

### `set_speed` targets: relative by delta or factor, continuous, self-relative, reverse

`target` is `{mode: 'absolute', value, reverse?}` or `{mode: 'relative', entity_ref,
value_type?: 'delta'|'factor', delta | factor, continuous?}`. Absent `value_type` is `delta`
and absent `continuous` is `false` — every older payload unchanged.

- **`factor`** emits `speedTargetValueType="factor"`: target = reference speed × factor
  (clamped 0…10). `delta` adds instead.
- **`continuous: true`** („Folgen: Dauerhaft") emits `continuous="true"`: the atomic re-applies
  the reference every tick **forever** and never reports SUCCESS (only a later longitudinal
  command ends it), and it **skips the rate ramp** (`if not continuous and rate`), so the emitter
  forces it to a `time`/`step` dynamics of 0 and the card hides the Dynamik row and states
  „dauerhaft (folgt)". It is therefore a never-completing action (`neverCompletes`).
- **Relative to the actor itself** („Eigene Geschw.", the last entry of „Relativ zu") is legal
  **only with `rate` and not continuous** — with `time` the per-tick re-sample compounds (+delta
  or ×factor per tick), the rate branch overwrites it with a one-shot snapshot. Picking it switches
  the dynamics to Rate and disables Zeit; `ScenarioRules.selfSpeedCompounds` chips a loaded file
  and the backend 400s. „Faktor 0,5 relativ zu eigener Geschw. mit Rate" is "brake to half of
  whatever I am doing".
- **`reverse: true`** („Richtung: Rückwärts", absolute mode only) emits a **negative**
  `AbsoluteTargetSpeed`. `SimpleVehicleControl` does not special-case the sign: it scales the
  direction to its next waypoint by it, so the vehicle backs away without turning. **Vehicles
  only** — `PedestrianControl` raises `NotImplementedError` on a negative target, so a walker gets
  no toggle, a chip and a 400. The preview moves a reversing actor straight back along its
  heading (`_advanceReverse`), leaving its lane anchor and waypoints for when it drives on.
  Measured in CARLA: −3 m/s held, 18 m straight back, yaw unchanged. The Init speed can never be negative (it raises).

### Per-actor acceleration limits (`max_acceleration` / `max_deceleration`)

Every actor carries both (m/s², defaults **3.0 / 10.0** — what every vehicle was emitted with
before the fields existed — clamped 0.1…50 in `_normalize_actor`). Edited in the properties panel
under the Ampeln/Hindernisse row (`#dynamics-row`, `#prop-max-accel` / `#prop-max-decel`, hidden
for walkers and props), carried by `dumpActor`'s allow-list, emitted as the NPC controller's
properties (`_dynamics_limit`, `xml_builder.py`) and rewritten into the hero's template text by
`_inject_ego` like the `consider_*` pair. **They cap everything**: a `rate` ramp or a step above
them is held to them, and `consider_obstacles` braking uses `max_deceleration` too. The preview
applies them (see "Commanded vs driven speed" in the preview section). **Measured in
CARLA** (Town04, `tests/run_actions_ext_carla.py`): set 6 / 2 → 5.71 / 1.98 m/s²; the
defaults 3 / 10 → 3.02 / 9.41. The same run confirmed `relative_speed` (CARLA 1.7 s vs
preview 1.6 s), „Abstand zu Akteur" naming an NPC (7.5 vs 7.4 s) and a continuous ×0.5
follow (4.98 m/s at an ego 9.83, tracking through the ego's ramp). Same stock-0.9.15 caveat
as the rest of those properties: only safe on the locally patched `simple_vehicle_control.py`.

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
- **A vehicle ramps up to it; a walker does not.** Every `simple_vehicle_control`
  actor is emitted with its `max_acceleration` (default 3.0, see "Per-actor acceleration
  limits"), and `SimpleVehicleControl` never reads the `_init_speed` flag the init atomic
  sets — so the init speed is just a target like any other, approached from the measured
  speed (≈0 at spawn) at that rate, with the controller's 0.5 m/s floor bump on the first
  tick. A 10 m/s start takes ~3.2 s and ~16 m to reach at 3 m/s². `PedestrianControl` sets
  `control.speed` directly and is still *at* the speed on tick 1. The preview does exactly
  this now (`_applyControllerLimits`). (Read off the code, not yet measured in CARLA.)

**`0` means "no init speed", and for an event-less actor that now also means
"parked".** Nothing is emitted at 0, and `open_scenario.py`'s `if actor.speed > 0`
would skip it anyway. Since an actor with `events: []` gets no Act, its init speed is
the *only* speed command it ever receives — so it holds that speed for the whole run,
and 0 leaves it stationary. An actor that has events but must stay put still needs an
explicit `set_speed 0` (`_parked()` in `tests/carla_cases.py`), because its own later
events would otherwise move it.

**The default is split on purpose, and this is the trap.** `ObjectsManager`'s
`DEFAULT_INIT_SPEED` gives a *placed vehicle* `10` — but a placed walker or cyclist
(`ROAD_FACING_TYPES`) `0`, and a template-placed actor whatever
`ScenarioTemplates.initialSpeedFor` says (its first `set_speed`'s target for a vehicle, `0`
for a VRU, an explicit `initialSpeed` for `Ausparken`/`Pannenfahrzeug`). A walker used to
get 10 too: the Init speed lands on tick 1, so every crossing pedestrian sprinted off at
36 km/h along its heading before its distance trigger could fire. An
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

## Scenario templates (`frontend/js/templates.js`)

17 one-actor templates in the overview panel's **Templates** tab (Auto 11 in two sections — „Spur &
Position" 6, „Tempo" 5 —, Fußgänger 4 incl. `child-runs-out`, Radfahrer 2), below „Konflikt hier erzeugen" (the generator's types, see the
generator section) and „Eigene Vorlagen" (user templates, below). A template is `{label, hint, actorType, events, placement?, initialSpeed?, build?}`;
`objects.js` `_placeActor` runs `eventsForActor` and `initialSpeedFor` at the click.

- **`hint` is the button's hover text** (`_buttonHtml` reads it) and the picker option's — a new
  template without one fails `test_templates_e2e.py` ("every template button has a hover description").
- **A template can be applied to an actor that is already placed**: the event panel's
  `Ablauf aus Template …` select (`.event-template-select`, `_renderEventActionGrid`) →
  `ScenarioTemplates.applyTo`, which rebuilds the chain for the actor's *current* pose, replaces its
  events and sets the template's start speed in **one** `updateById` (one undo entry), after a
  confirm when it already has events. `compatibleWith(type)` groups by what the chain needs, not by
  `ACTOR_TYPE_GROUPS`: vehicle chains on any vehicle, walker chains on `pedestrian`/`child`,
  cyclist chains on `cyclist` only (a `set_speed` crossing rides a cyclist *along* the lane), and
  nothing on the ego (every chain waits on `distance_to_ego`). Other actors' event references into
  the replaced chain are not re-pointed; the usual „Event fehlt" chip reports them.

- **`build(actor)` computes a chain from the road at the click, with the actor's final pose**, and
  falls back to the static `events` with a toast when it returns null (no road, or a "crossing"
  heading along the carriageway). Used by the four crossings and the pull-out.
  `_crossingProfile` walks the actor's heading in 0.25 m steps over every lane polygon that is not
  `sidewalk`/`none` and reports entry, exit (+1.5 m onto the kerb) and the middle of the first
  driving lane **by lane identity** — by type, two adjacent driving lanes are one span and its middle
  is the line between them.
- **Walker crossings are `set_speed` holds sized to the road**: `duration = crossing length / speed`.
  A fixed 10 s used to stop a walker mid-carriageway on a wide road and walk it into a wall on a
  narrow one. `pedestrian-crossing` triggers at **30 m** at 1.4 m/s — at the old 50 m / 2 m/s the
  CARLA bench case measured the walker off the far kerb ~3.5 s before the ego arrived.
- **`cyclist-crossing` is a `follow_trajectory`** (seed on the actor + mid + a vertex **4 m past
  the far kerb**, 4 m/s): a cyclist is a `<Vehicle>` and a `set_speed` rides it *along* the lane.
  The overshoot is `SimpleVehicleControl`'s 4 m waypoint acceptance — it stops dead on reaching the
  last one, so a trajectory ending *at* the kerb left the bike in the middle of the oncoming lane
  (measured). Its export hits the known `<Vertex relativeTime>` XSD defect like any trajectory.
- **`vehicle-pull-out` is an `assign_route`** (NOTES 1.1 #3), not a `lane_change`, which never fires
  from a parking lane: seed (`routeWaypointAt` → the driving lane beside the bay), a merge point
  10 m ahead on a same-direction driving lane, and a run-on probed 80/60/40/30/20 m straight ahead (a
  lane's own `directionLine` ends at its section, often a few metres on), plus `set_speed` 10 m/s at
  `distance_to_ego` 30, start speed 0 — a route alone does not move an actor, so it waits at the kerb.
- **A template actor that ends up standing in a lane blocks the run**: the ego (obstacles on) waits
  behind it, its route never completes, and the run only ends on `MaxSimTime` — which is also when
  `run.sh` is most likely to hang (see "CARLA verification of the templates"). So `Notbremsung`
  stands 3 s and pulls away again (`rate` 3 m/s² back to 10 m/s) and the pull-out's route runs 80 m
  on. `vehicle-parked` is the deliberate exception — blocking is its job.
- **`vehicle-cut-in` (Einscheren) changes lanes *toward the ego*, and decides which way at the
  click** (`_buildCutIn`): the sign of the cross product of the NPC's heading with the vector to
  `AppState.ego` — CARLA's frame is left-handed with y down, so facing +x the right is +y. No ego
  placed yet means `right` plus a toast; placing the ego afterwards does **not** re-derive it. Its
  `lane_change` fires on `distance_to_ego` 15, not `after_event` on a 5 s hold like the two
  Spurwechsel templates, which change lanes wherever the ego happens to be.
- `vehicle-parked` has `events: []` (no Act, holds start speed 0); `vehicle-lane-drift` is two
  `lane_offset`s on two ego distances (40 m out 1.5 m, 20 m back to 0) because nothing may chain
  onto a `lane_offset` with `after_event`.
- **User templates („Eigene Vorlagen") live in the same `templates` table under `user:N` ids**, each
  with a `build(actor)` that maps a stored chain onto the new actor's pose — so placement, the
  `Ablauf aus Template …` picker and `applyTo` need no special case. `saveFromActor` (the event
  panel's „Als Vorlage speichern", `.event-template-save`) stores every position **relative to the
  actor** (`u` along its heading, `v` to its right — y-down, so right is +y at heading +x) and every
  actor reference as `'$self'`/`'$ego'`; on build a `fastest` route waypoint is re-snapped and
  waypoint 0 goes on the actor, and every z is re-derived (`groundZAt` + 0.5). **A chain naming another
  NPC is refused** (that actor will not exist where the template is used). Stored per viewer in
  `localStorage` (`scenarioEditor.userTemplates`, try/catch, not scenario state, not undo); shared as a
  JSON file (Exportieren / Importieren, which adds with new ids). The transform is rigid: on a bend or a
  different road width a trajectory keeps its shape and may no longer fit — the preview shows it.
- `test_templates_e2e.py` pins chains with an `ANY` wildcard for computed values and checks the
  computed hold is 0.5–60 s; its `export_template` places the actor with `yaw: 90` so the crossing
  builders have Town01 road 1 to cross.

### CARLA verification of the templates (`tests/run_template_carla.py`)

The `tpl-*` cases in `run_carla_cases.py` give the ego no events, so it stands still and no
`distance_to_ego` trigger fires except on its 60 s fallback. `run_template_carla.py` instead gives
each case an ego driving an `assign_route` past the actor at a start speed, places the template
with a real click, and prints CARLA's result beside the preview's. Measured 2026-10-09 (all on
the scripted ego, obstacles on):

- **Pull-out** (Town03 road 6 bay): waits, released at 2.0 s, 2.8 m out onto the driving lane, 10 m/s.
- **Pedestrian crossing / stop in lane / child** (Town01 road 1 kerb): 1.4 / 1.4 / 3.0 m/s exactly,
  kerb to kerb; the stop-in-lane walker stood 3 s at y −2.35 (the ego's lane centre is −2.0) and the
  ego stopped 9 m short and waited. Ego yielded in all three (closest 6.3–7.0 m).
- **Cyclist crossing**: crosses on its trajectory at 4.0 m/s and stops on the far kerb.
- **Notbremsung** (Town04 road 40): 10 → 0 in 1.3 s (8 m/s²), 3 s stand, back to 10 in 3.35 s.
- **Schlenker links**: 1.45 m left (authored 1.5) for 4 s, back exactly at the 20 m trigger.
- **Einscheren** (Town04 road 40, NPC lane 5, ego lane 4): changed left at 13.15 s with the ego
  15 m back, into the ego's lane in ~2 s; the ego braked 11.9 → 5.1 m/s and followed at 10.8 m.
- **Trigger times now agree with the preview's to within 0.15 s** (re-run 2026-10-12, all nine
  cases). They used to run ~1.2 s later, while the preview started the ego at speed; it now ramps
  it at `max_acceleration` like the controller (`_applyControllerLimits`).
- **A spot can be unspawnable for scenery the `.xodr` does not contain**: Town03 road 6's sidewalk at
  y −12…−12.6 is a wall/fence line under an overhead deck (`cast_ray` hits z 8.1); no walker spawns
  there at any height, and "Unable to add actors" kills the run. Nothing in the editor can see this.
- **`run.sh` sometimes does not return after ScenarioRunner prints "Exiting"**, even for a storyboard
  that completed (every event END-ed) — seen on 3 of 13 runs, including one that hit only
  `HeroActComplete`. The behaviour data is complete when it happens; `run_case`'s timeout and
  `killpg` clean up. Cause not found.

## Static props (CARLA `static.prop.*`)

79 curated props in six groups — Baustelle, Fahrbahn, Verlorene Ladung, Abfall & Container,
Straßenmöbel, Garten & Freizeit — placeable on the map and exported as OpenSCENARIO `<MiscObject>`.
The build has 109 `static.prop.*` blueprints; the 30 left out are deliberate: `mesh` (no mesh),
`calibrator`/`screenshot1`/`screenshot2`/`autobahn` (test slabs), `brickwall` (a 4×3 m slab lying
flat, not a wall), `busstoplb`/`haybale` (a rotated and a half-buried duplicate), the 0-height decals
(`ampel`, `schild`, `graffiti`, `smiley`, `snow`, `stickers`, `dirt`), everything under ~0.2 m
(`garbage01–06`, `brokentile01–04`, `colacan`, `mobile`, `wateringcan`, `platformgarbage01`) and
`fountain` (wobbles and slides once physics is on). `walkingkid`/`walkingkidlarge` are flat too but
kept: they are 3-D-illusion pavement paintings, a real phantom-pedestrian test case.
`static.prop.bike helmet` has a **space in its blueprint id** — that is CARLA's spelling, and it works
end to end. They live in `AppState.staticObjects` as
`{id, type:'prop', prop:'static.prop.*', x, y, z, yaw}` (`AppState.staticObjects`, `app.js`).

**The catalogue is split in two, deliberately mirroring the `vehicle_catalog.yaml` pattern.** The only
shared column is the blueprint id; a mismatch fails loudly as a 400 at export, never silently.

| File | Owns | Used by |
|---|---|---|
| `frontend/js/propCatalog.js` | label, group, glyph shapes, footprints, `z` lift, `plan.off`, `facing`, `planRotate` | palette + map |
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

### Three traps that will silently produce the wrong scenario

- **`miscObjectCategory` can override your blueprint.** ScenarioRunner maps category `barrier` →
  `static.prop.streetbarrier` and `guardRail` → `static.prop.chainbarrier`, *discarding* the `name`
  attribute. Only `streetbarrier` may use `barrier`; everything else must use `obstacle`. This is why
  `category` is stored per-entry rather than derived.
- **`yaw_offset` is mesh calibration, and it is ground truth from running CARLA — not derivable.**
  The editor's `yaw` always means "the direction the prop faces"; the offset is added at export
  (`h = radians(yaw + yaw_offset)`). An offline probe that photographed each mesh from two
  axis-aligned cameras got several props **180° wrong** by mistaking a back for a front. If a prop
  looks rotated in simulation, run it and fix the YAML — never compensate in the editor's yaw rules.
  The sign convention is `yaw_offset = -(CARLA yaw the face points at h=0)`; every new oriented prop
  was checked by spawning it at editor yaw 0 through ScenarioRunner's sequence and photographing it
  from +X.
- **ScenarioRunner runs every prop with physics ON, so a pivot above the mesh base drops it through
  the world.** `CarlaDataProvider.request_new_actors` sends `SetSimulatePhysics(True)` for every
  `misc` actor and `ActorTransformSetter` re-enables it after the Init teleport. (A bare
  `spawn_actor` leaves physics off and the prop never moves, which is why a static probe hides
  this.) `shoppingcart`, `travelcase`, `shoppingbag` and `shoppingtrolley` have their pivot at the
  **top** of the mesh: at `z` 0 their collision starts ~1 m under the asphalt and they fall ~80 m to
  the kill plane — the cart, in the catalogue since the start at `z: 0`, simply vanished in every
  run. The per-prop `z` in `propCatalog.js` is the measured lift (cart 1.08 m), applied by
  `surfaceZFor` at placement and on every move. A few props still settle slightly off because their
  *collision* mesh differs from the visual one (`barrel` +0.25 m, `foodcart` sinks 0.53 m,
  `haybalelb` rolls onto its end, `trafficcone02` topples at any z) — physics moves them back, so z
  cannot fix it; each is noted in the YAML. `tests/probe_carla_props.py` re-measures all of this.

### Placement orientation is per-prop and per-lane

`_propYawFor` (`objects.js:149`) resolves a `facing` rule against the OpenDRIVE direction of the
**specific lane** nearest the click:

| Rule | Yaw | Props |
|---|---|---|
| `oncoming` | `laneYaw + 180` | barrier, chain barrier, warning trailer, both warning signs, billboard, the three `streetsign*` panels |
| `along` | `laneYaw` | road plate, pavement paintings, benches, planters, clothes container, food cart |
| `alongside` | `laneYaw` or `+180`, whichever turns the open side toward the road | bus stop, container |
| `toward-road` | bearing to the nearest lane point | vending machine, ATM, mailbox, info board |
| `none` | 0 | everything symmetric or with no front (cones, drums, boxes, luggage, bins, garden items) |

The benches are `along`, not `alongside`, on purpose: which side the seat faces was not verifiable
from the photos, and `along` only commits to the axis. The `streetsign*` meshes are **advertising /
info panels, not traffic signs** — they were once dropped from the catalogue (along with
`chainbarrier`) when filed under a „Verkehrsführung" group; they are back under accurate labels.

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
(`tests/probe_carla_props.py`, which supersedes `probe_carla_mesh_dims.py`) — several were badly wrong before that: `container` is a ~1.9 m
skip, not a 6 m shipping container. Note the measured extents are in the **mesh** frame, so for any
prop with a ±90 `yaw_offset` the axes must be swapped before use as `plan.len`/`plan.wid`, where +X
means the facing.

**Some meshes are not centred on their pivot**, and `plan.off` (`PropCatalog.planOffset`, editor
frame, metres) says by how much: the container 1.1 m to one side, the slide 1.6 m, the shopping cart
0.6 m. `_renderProp` shifts the body, its grab circle and its selection marks by it, while the group
— the exported position and the rotation centre — stays on the pivot, so the yaw arrow does too.
Drawing them centred put the marker beside where CARLA actually puts the object. Unlike the
footprint, the offset is **not** scaled by `planSize`'s visibility clamp: it is a real position.

`planSize()` clamps small footprints up to `MIN_PLAN_EXTENT` (1.2 m) so they stay visible.
**Known limitation:** every prop below that floor draws at the floor, so the three cones
(0.88 / 0.46 / 0.34 m) all render at the same diameter and their real size difference is invisible on
the map. Removing the clamp fixes that but makes sub-metre props nearly impossible to see when zoomed
out; props carry a separate invisible hit circle, so clickability is not the blocker — visibility is.

## Frontend conventions

**No build step, no bundler, no npm.** Each `frontend/js/*.js` is an IIFE attaching one global: `AppState`, `Api`, `MapView`, `ObjectsManager`, `EventPanel`, `TrafficSignals`, `ScenarioTemplates`, `PropCatalog`, `LaneGraph`, `Dropdown`, `SpecialBuildings`, `AerialMap`, `ScenarioGenerator`, `EventTimeline`, plus `Toast` / `Confirm` / `UndoStack` / `UIUtils` / `ScenarioRules` from `app.js`. `Simulate` also exports `seek` / `pause` / `play` / `paused` / `time` / `end` and `onTime(fn)` (called with the view time on every shown frame, `null` on Stop — the Ablauf playhead and highlight use it), `routeGeometry(actor, ev)` — the lane-following route `mapView.js` draws — and `runHeadless()`, the whole preview run to completion in one call (see the generator section). `ScenarioIO` exports `buildParams` / `validate` / `downloadBlob` for the generator's batch, beside the `buildParamsForTesting` test hook. Two globals exist only as test hooks and are called by no UI code: `Simulate.routeForTesting` (`tests/test_route_fidelity_e2e.py`, asserts on a computed route without running the animation) and `ScenarioIO.buildParamsForTesting` (`tests/test_events_e2e.py`, builds the export payload without the click, so a payload the client-side gate refuses can still be handed to the backend). Several files (`toolbar.js`, `properties.js`, `weather.js`, `mapImport.js`, `welcome.js`, `layerMenu.js`) export nothing else and simply bind DOM listeners on load.

- **Script order in `frontend/index.html` (the `<script>` block near the end) is load-bearing** — `app.js` first, dependents after; `propCatalog.js` must precede `toolbar.js`, which renders the prop tiles from it, and `aerialMap.js` must precede `mapView.js`, whose `renderMap` / `_applyTransform` call into it unguarded. `scenarioGenerator.js` goes after `simulate.js` (it calls `Simulate.routeGeometry` / `runHeadless`) and after `dropdown.js`, whose delegated `[data-menu-item]` close is what shuts its menu. `eventTimeline.js` goes after `simulate.js` (it inserts `#sim-lanes` into `#map-bottom-stack` above `#sim-controls` and appends its toggle to the bar). A new module must be added there or it never runs.
- **The header's dropdowns share one mechanism.** `dropdown.js` (global `Dropdown`) owns toggle-on-button, close-on-outside-click and close-on-Esc; the Esc handler is on the **capture phase** and `stopPropagation`s, so closing a menu does not also cancel a path being drawn in `mapView`. A menu needs no module of its own — `dropdown.js` auto-binds any `[data-dropdown]` wrapper holding a `[data-dropdown-button]` and a `[data-dropdown-panel]` (this is how **Datei**, **Generieren** and **Umgebung** work), and a row marked `data-menu-item` closes the menu after its own handler runs. A menu with extra behaviour calls `Dropdown.bind()` itself instead; **Ebenen** does, and must therefore *not* also carry `data-dropdown` or it binds twice. Shared classes are `.menu` / `.menu-btn` / `.menu-panel` / `.menu-item`; `.menu-panel-right` right-aligns a panel near the window edge.
- **The nine map-layer checkboxes live in the Ebenen dropdown** (`#layer-toggles` → `#layer-menu-btn` + `#layer-menu-panel`, "Ebenen N/9"; the pill counts checkboxes, so it needs no edit when one is added). `Tempolimits` (`#toggle-speeds`) is the only one that starts **unchecked**. Ownership is split: `layerMenu.js` owns only the count pill and `Alle`/`Keine`, while `mapView.js`'s `_setupLayerToggles` still binds each `#toggle-*` checkbox to its SVG layer by id, exactly as when they were inline in the header. Keep those ids: they are the contract between the two files (and `tests/test_props_e2e.py` asserts `#toggle-props` exists). `Alle`/`Keine` set `.checked` directly, which fires **no** event, so it dispatches a synthetic `change` per box — drop that and the pill updates while the map does not. `#layer-toggles` itself stays `hidden` until a map loads (`mapImport.js`, `_setupLayerToggles`).
- **The Datei menu holds `#btn-save` / `#btn-load-input` / `#btn-import-map-input` / `#btn-export-route`, and their ids are unchanged** — `scenarioIO.js` binds them by id and does not care that they now live in a popup. **`#btn-new-scenario` („Neues Szenario (alles entfernen)") is its first row**: `AppState.clearScenario()` — ego, NPCs,
props, signal Schaltungen and the generator recipe on the **current town only**, weather/time kept — as one undo step, after a confirm (Strg
skips it; an empty scenario just toasts). `#btn-export` deliberately stays a top-level primary button: it is the app's goal, and `tests/_harness.py` clicks it directly and waits on its `.disabled`.
- **Weather and time of day are the header's `Umgebung` menu (`#env-menu`), not a bar under the map.** The full-width `#weather-bar` footer is gone (it cost 68 px of map height for something set rarely), and with it `--footer-h`. `weather.js` still binds the same `w-time` / `w-<key>` / `wv-<key>` ids, adds six presets (`PRESETS`, the same values as `scenarioGenerator.js`'s `WEATHER_PRESETS` — keep the two in step) and writes `Regen · Nacht` onto the button (`#env-summary`); a weather that matches no preset exactly reads `Eigenes Wetter`. A preset sets **all seven** keys, the others to 0. `Schnee` / `Staub` stay offered by decision even though CARLA 0.9.15 renders neither. **Fog only renders below a 1 km visual range**: ScenarioRunner sets `fog_density = 100` iff `visualRange < 1000` (`openscenario_parser.get_weather`), and `weather_mapper.py` used to map fog 0–1 onto 100 km–0, so „Nebel" (0.7 → 30 km) and every generator „nebel" batch ran in clear air. It now maps onto 1000 m–10 m (0.2 → 800 m, 0.7 → 300 m). The dust-storm range still uses the old 5 km scale and so still renders nothing below 0.8.
- **Undo/redo also have header buttons** (`#btn-undo` / `#btn-redo`), sharing `mapView.js`'s `_stepHistory` with `Strg+Z` / `Strg+Y`. `UndoStack` emits nothing, so `_refreshHistoryButtons` re-reads `UndoStack.length` / `redoLength` once per frame after any AppState event.
- **The header is one row at every width** — nothing in it may wrap. Below 1340 px `.app-title` is hidden, below 1180 px the road count and the weather summary text too. A new header control must fit that budget or go into a menu.
- **Each town keeps its own scenario for the session.** Poses belong to the town they were placed on (they
  used to survive a switch and sit at meaningless coordinates). A switch calls `UIUtils.leaveMap()` — stops the
  preview, **parks** the scenario *and its undo/redo stacks* (`UndoStack.park()`) keyed by town — then
  `UIUtils.enterMap(town)`, which `UndoStack.unpark`s that town's entry or starts it empty with no history.
  Towns holding a parked scenario read `Town03 ●` in `#map-select` (`mapScenariosChanged` → `toolbar.js`), and a
  restore toasts. **In memory only**: a reload loses parked scenarios as it loses the live one, and the save file
  holds the current town only. Used by `toolbar.js`'s select handler, `mapImport.js` and Laden
  (`UIUtils.beforeLoadFile`: parks the current town when the file is for another, and drops the file's own
  town's parked entry, which the file replaces). **The batch generator's `_loadMap` sets `#map-select`'s
  `data-keep-scenario="1"`** before dispatching `change` — it saves and restores the scenario itself, and parking
  there would break every multi-town batch. `beforeLoadFile` **stops a running preview first, whatever the town** — left running it animated the loaded actors (two hand-made saves share `obj-1`, `obj-2`, …) and its Stop put the old scenario's authored poses onto them (`test_preview_lock_e2e.py`). Laden of another town's file also **re-fetches the geometry now**; it
  used to only when no map was loaded, drawing a Town05 file on Town03's roads.
- **A preview is view-only.** `objects.js`'s mousedown returns while `Simulate.running` (no body, yaw or
  waypoint drag), the trigger point/radius drags refuse, and `mapView.js`'s pan exclusion is skipped so a grab on
  a marker pans the map. `Entf`/`Backspace`/`Strg+Z`/`Strg+Y` are swallowed. Selecting still works. The
  properties panel stays at **full opacity and scrolls**: under `body.simulating` every descendant is
  `pointer-events: none` except the scroll containers (`#properties-panel` itself, `.waypoint-list`), a capture
  `focusin` in `properties.js` blurs anything Tab reaches, and the cue is the sticky `#preview-lock-banner` plus
  an inset accent frame — chosen over the old 0.5 fade, which made the panel unreadable exactly when it is most
  useful. A new nested scroll container in the panel needs its own `pointer-events: auto` line.
- **The empty map is a town picker** (`#map-quick-pick`, filled by `toolbar.js` `_renderQuickPick`); a button just sets `#map-select` and dispatches its `change`, so there is still one load path. `#scale-ruler` stays `hidden` until a map renders.
- **The simulation controls are not in the header.** `simulate.js` injects `#sim-controls` into `#map-bottom-stack`, a click-through (`pointer-events: none`, children `auto`) bottom-centre overlay inside `#map-container` that also holds `#traj-banner`. They are **stacked in a flex column, not given fixed `bottom` offsets** — either can be hidden without the other having to know. The ids `#sim-play` / `#sim-stop` (`tests/test_route_fidelity_e2e.py`) and `#traj-banner` (`tests/test_ego_events_e2e.py`) are unchanged by the move. `#sim-progress-bar` is the scrubbable timeline (see the preview section); `#sim-time-label` reads `t / end`. **`#sim-controls` is a fixed 560 px card of two `.sim-row`s**: `.sim-row-top` holds icon-only Play/Pause/Stop, the tempo slider, then „Ego bremst" and „Ablauf" (eventTimeline.js appends its toggle into `.sim-row-top`, not the card), `.sim-row-timeline` only the scrub bar and `t / end`, so the bar gets the width. **`#map-bottom-stack` is centred in the strip right of the scale ruler** (`left: 272px; right: 12px`), not on the map's 50% — the old ~690 px one-row bar slid over the ruler. That reserve only holds because the ruler is bounded: `_NICE_DISTS` starts at 0.1 m, so its bar stays within ~70–170 px. **Below 1340 px window width that strip is under 560 px** and the top row's fixed-width controls spilled out of the card under the properties panel (at 1100 px „Ablauf" was cut off), so a media query gives the stack the whole map width (`left: 12px`) and lifts `.scale-ruler` above the card (`bottom: 84px`); `test_preview_timeline_e2e.py` checks 1600/1280/1100/1024. Nothing in the bar may change width when a preview starts or on an edit — the card has a width, Stop keeps its slot (`.sim-idle` = `visibility: hidden`), Play/Pause are the same 30 px icon slot, the toggles and the time label are fixed width — or the timeline moves out from under the cursor and a click at one x lands at a different time (`test_preview_timeline_e2e.py`'s "seeking to the same time twice"). **Play's state (`Abspielen` / `Fortsetzen` / `Nochmal`) is not visible text**: `_setPlayLabel` writes it into the visually hidden `#sim-play-text` (tests read it), the `title` and `aria-label`, and „Nochmal" swaps in the replay icon (`.replay`). Never set `btnPlay.textContent`, which would wipe the icons.
- **`#map-status` carries the road count only** ("122 Straßen") — the town name is `#map-select`'s job, and every path that writes the count (`toolbar.js` select-change and `stateLoaded`, `mapImport.js`) also sets `mapSelect.value`, so the name is never lost. Transient and failure states ("Lade …", "Import fehlgeschlagen") still take over the badge text.
- **Pan/zoom is clamped, and `F` is the way back.** `mapView.js` holds `MIN_ZOOM` (0.25) / `MAX_ZOOM` (200) around `_zoom`, which is `1.0` when the whole town fills the viewBox. The wheel derives `_pan` from the **clamped** zoom, not the requested one — deriving it from the request keeps translating the map at the limit, which walks it off screen as effectively as no clamp. Unbounded is what it used to be: 200 notches out reached `scale(0.0000087)` and nothing but `renderMap()` ever reset the view, so the only way back was a reload, which discards the scenario. The recovery path is `MapView.resetView()` / `zoomToSelection()` / `zoomBy(factor)`, bound to `#map-view-controls` (top-right of the map, unhidden by `_setupLayerToggles` alongside `#layer-toggles`) and to the `F` key — `F` frames the selection at `ZOOM_TO_SPAN` (90 m) and falls back to a full reset when nothing is selected. **Buttons zoom about the view centre (`zoomBy` → `_centreOn`), the wheel about the cursor**; scaling `_zoom` alone zooms about the viewBox origin. Shift on the wheel switches to `ZOOM_STEP_COARSE` (1.4 vs 1.12), which is a real ergonomic difference — 9 notches to lane scale instead of 26, and 50 before the base step was raised.

- **Selection is four corner marks, and one helper draws them for everything.** `_buildSelectionMarks(w, h)` (`mapView.js`) builds a `.actor-select-marks` group of black-over-white crop marks on the object's box, called from `_renderActor`, `_renderProp` and `_renderTrafficLight` — actors, props and signals share one selection language, and `.actor-select-marks` is shown by both `.actor-selected` and `.traffic-light.selected`. It replaced a yellow ring per renderer, which failed on three counts worth not reintroducing: `#ffff00` is the map's *own* colour (lane paint, the `#ffee55` ruler, a `#ddaa00` bus body), so around a bus on a painted road the mark was ambiguous; one radius gave a 9 m bus and a 0.9 m cone the same circle, saying where but never what; and it drew through the actor's own label. Three details carry it — **`vector-effect: non-scaling-stroke`**, so the corners follow the box while the line keeps its screen width (a scaled 2 px line goes sub-pixel long before the cone it frames does); the **white casing under the black line**, because the map runs from a `#e8edf2` verge to a near-black carriageway and no single colour survives both; and **`pointer-events: none`**, because a 5 px casing would otherwise swallow clicks aimed at the object it frames. `w`/`h` are the **drawn** extent in the object's own rotated frame, which is not always the catalogue's: a walker is a circle of diameter `size.w` so its box is square, and a prop whose `planRotate` is ±90 has its extent swapped.
- **A traffic light's properties panel shares `#props-content` with actors and props**, so `_renderTrafficSignalPanel` (`properties.js`) must hide every section they show — spawn, both type pickers, events, delete — or the previous selection's section leaks through (a light clicked after a car showed „Typ: Auto"). A new actor/prop section needs a hide line there too; `tests/test_signal_panel_e2e.py` pins it. Each signal event is a „Schaltung" card read WENN → DANN: „Ego näher als N m" (emitted as a `ReachPositionCondition` on `hero` with that tolerance around the pole) → state. It sets the light **once**; CARLA's cycle then carries on (a forced red lasted ~13 s in a Town05 run), which the panel says in its hint.
- **Every map light carries `signalId`, `roads` (the connectors it governs), its road-surface `z`, and `inCarla`.** The emitter places the signal event's trigger point at that `z` (`xml_builder._append_traffic_signal_event`); it used to write z = 0, and since the condition is a 3-D distance, a short radius at an elevated light (Town03 has them 8 m up) never fired. `inCarla` comes from `maps/<town>/carla_traffic_lights.json`, written by `tests/probe_carla_traffic_lights.py` against a live CARLA: **Town10HD's `traffic_light_10`/`_11` exist in the `.xodr` but not in CARLA** (nearest actor 10.8 m away; they also govern no road), and a signal event on one makes ScenarioRunner abort with "Unknown traffic light" — a light is addressed as `pos=x,y` and resolved within 2 m. Such a light is drawn as a ghost (`.not-in-carla`), its panel says so and disables „+ Schaltung", the export gate refuses it, and `validate_scenario_params` raises a 400 (`_reject_phantom_signals`, which reads the same file). Town01–07 match CARLA within 0.85 m. A town with no probe file is not checked.
- **A traffic light is drawn as a signal head** (`_renderTrafficLight`): dark housing, three lamps, all dark until a signal event forces a state, then exactly the states its events set are lit, plus an accent outline. It used to be an 8 m red disc with a glow, red whether or not anything was configured. The invisible r = 2.4 m circle is its hit target.
- **Drag and rotate are two disjoint zones on the marker, and the gap between them is real.** The body drags; a handle out past the nose rotates. `_buildYawArrow` (`mapView.js`) takes the caller's **own hit radius** — half the marker for an actor, the prop's invisible grab circle for a prop — and derives `arrowLen = bodyRadius + YAW_HANDLE_GAP + handleR`, so the invariant *(handle inner edge is outside the body, always)* holds by construction at any size rather than by a tuned constant. It did not before: `max(w, 4.5) * 0.8` with a fixed `r = 1.5` grab circle put the handle's inner edge at 2.1 m on a car whose half-length is 2.25 m, and swallowed a small oriented prop whole (arrow 1.6 m out, `r` 1.5, body grab circle 1.2) — that prop could not be dragged at all, every grab rotated it. Two more pieces of the same fix: the shaft is `.yaw-shaft`, `pointer-events: none`, drawn from the body edge instead of from the actor's *centre* where it hit-tested as "rotate" straight across the marker; and `objects.js`'s mousedown matches the single class `.yaw-handle` instead of the old four-way string match on `[class*="arrow"]` and `style === 'cursor:grab'`. **A new part of the arrow is decoration unless it carries `.yaw-handle`.** The mode guard (`activeTool`/`trajectoryMode`/`routeMode`) is now shared by both branches at the top of the handler — the rotate branch had none, so with a tool armed the handle rotated while the body selected.
- **The drag cursor is a class on `<body>`, not `:active` on the element.** `.actor-group` is `move`, `.yaw-handle` is `grab`, and mousedown adds `body.dragging-actor` / `body.rotating` (removed on mouseup) which force `move` / `grabbing` document-wide. `:active` cannot work here: every `updateById` re-renders the whole actor layer (`AppState.on('actorUpdated')`), so the element the drag started on is detached within a frame — the same reason the trigger-point drag re-derives its z on mouseup rather than trusting the element. `.yaw-handle-ring` draws the grab circle's own boundary on `.yaw-arrow:hover`, so the zone is findable *before* committing to a drag.
- **`AppState.cancelPlacement(extra)` is the one way to disarm placement**, with `AppState.placementActive` as its predicate. It clears all nine of `activeTool` / `pendingTemplate` / `pendingProp` / `pendingGenerate` / `trajectoryMode` / `activeTrajectoryId` / `routeMode` / `activeRouteId` / `activePathEventId`; three callers need exactly that set — Esc, the `r` ruler toggle (which passes its own `activeTool`) and pressing Play. It records no undo entry (`_isScenarioPatch` ignores editor-only keys), but clearing the draw flags is what fires `objects.js`'s `_discardIncompletePath`, so **a caller that then reads the actors must call it first** or it simulates/exports an event that no longer exists.
- **The preview answers to `Leertaste` (Play/Pause) and `Esc` (Stop).** Both are one bubble-phase `window` keydown in `simulate.js`, deliberately without `stopPropagation`: `app.js`'s confirm dialog and `dropdown.js`'s menus handle Escape on the **capture** phase and stop it there, so they preempt this for free, and `mapView.js` — loaded first — runs its own Escape branch before it. Space yields to a control **only when the keyboard put focus there** (`UIUtils.keyboardFocused`), and otherwise `preventDefault()`s — which is what stops the browser turning the keydown into a click on the focused button. The blanket `button, [role="option"], a[href]` bail it replaced was a real bug: clicking leaves a button focused, so the last toolbar tile clicked ate every Space and re-armed/disarmed itself (crosshair flickering on and off) while the preview never started, and a clicked panel button or scene row did the same. **`:focus-visible` cannot be used for this** — it was tried first, and its heuristic is "was the most recent interaction a keypress", so pressing Space *itself* flips every control into focus-visible and the next press hands the key back to the button. `app.js` tracks focus modality directly instead: Tab/arrow/Home/End set it, any mousedown clears it. `properties.js`'s scene-row Space reads the same predicate and preempts this handler through `e.defaultPrevented`. `_startSimulation` calls `AppState.cancelPlacement()` on a cold start — `body.simulating` dims the *toolbar*, but the map SVG stays live for pan/zoom, so an armed tool used to survive Play, crosshair and all, and the first click on the animating map placed an actor.

- **`MapView.focusActor(id)` frames an actor *without* selecting it**, sharing `_frameActor` with `zoomToSelection`, then calls `glowActor(id)`. The glow is the **object's own body brightening** — the same `filter` it gets when hovered directly on the map, **no ring**, nothing appended to the actor group at render time. It brightens, holds ~0.5 s, then fades: `GLOW_MS` (900) must stay in step with the `actor-glow-fade` keyframes (brightness held to 55% of the timeline), or the class outlives the animation and leaves the object sitting bright. It is fired on the scene list's **click**, never on hover — hovering a list to read it must not set things flashing on the map. Both work for props: they carry `.actor-group` too. Flying the view *is* the feature — markers are drawn at true world size, so an actor at the town view is a few pixels and no amount of highlighting would find it for you.

- **Every object label on the map is one size and one hide rule.** An object label is the *name of the object under it* — an actor's, a prop's, a landmark's, a trigger point's. All four are drawn at `MAP_LABEL_M` (3.2 world metres), all four carry the class **`.map-label`**, and `_updateLabelVisibility` (called from `_applyTransform`) hides the lot by toggling `map-labels-hidden` on the `<svg>` when `pxPerMetre * MAP_LABEL_M < LABEL_MIN_PX` (6). They were three sizes across four call sites before (2.2 / 2.2 / 1.8 / 1.8), and only the actor's was ever hidden, so a prop's name was visibly smaller than the car's next to it and a trigger point's stayed on screen as a smear at any zoom. **A new object label must carry `.map-label` and `String(MAP_LABEL_M)`** or it silently reintroduces exactly that.
  - **What is deliberately *not* a `.map-label`**: waypoint numbers and per-waypoint velocities, the ruler's distance readout, the preview's status badges. Those annotate a measurement rather than name an object, and they keep their own smaller sizes.
  - **The floor is a screen size, so it — not the metre value — is what decides how far out labels survive.** At 3.2 m / 6 px they hold to ~1.9 px per world metre, against ~3.2 before, i.e. roughly **1.7× further out**; Town10HD and Town02 now keep their labels at the whole-town view where they used to lose them. Raising `MAP_LABEL_M` alone widens that range too, since the threshold is their ratio.
  - **Do not "fix" small markers by scaling them up**: the markers being true-size is what makes the map trustworthy, and a label that grew as you zoomed out would be the one thing on it lying about scale — `MapView.focusActor` is the way to reach a small actor. The `font-size` at each call site and `MAP_LABEL_M` are the same number written several times and must stay in step.
  - **There is also a ceiling, `LABEL_MAX_PX` (15).** Uncapped, 3.2 m reached ~60 px at lane zoom and a landmark's name sat across the vehicle being edited. It is applied as CSS — `_updateLabelVisibility` sets `--map-label-size` on the `<svg>` and `.map-label { font-size: var(--map-label-size) }` overrides every call site's `font-size` attribute (in SVG, CSS `px` is a user unit, i.e. a world metre here). So the attribute is now only the fallback, and a label positioned by baseline offset must not assume the glyph is 3.2 m tall.
  - **Actor and prop labels are upright** (`_uprightLabel`): drawn inside the rotated actor group but counter-rotated, on the screen side the yaw arrow is not on (below when the nose points up). They used to turn with the vehicle, so anything driving north–south was labelled sideways.
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
- Modal editor state (`trajectoryMode`, `routeMode`, `activePathEventId`, `pendingTemplate`, `pendingProp`, `pendingGenerate`) lives on `AppState` and is what the `mapView.js` click handlers branch on.
- The left toolbar is **tabbed** (`Akteure` | `Requisiten`, `data-toolbar-tab`). `toolbar.js` uses **event delegation** on `#toolbar`, not a load-time `.tool-btn` snapshot — prop tiles are rendered at runtime and a snapshot would silently miss them. Tab state is module-local, matching `_overviewPanelTab` in `properties.js`.
- **The Requisiten tab is a search field over foldable group sections** (`PropCatalog.renderPanel`). At 79 props a flat two-column grid is a ~40-row scroll. Fold state is a per-viewer `localStorage` preference (`scenarioEditor.propSections`, a JSON array of folded group ids; not scenario state, not undo) and **defaults to everything past Baustelle and Fahrbahn folded**. A folded tile is still in the DOM but not visible, so **a test that clicks a tile outside those two groups must unfold it, search for it, or seed that key with `'[]'`** (`test_prop_yaw_e2e.py` does the last). While the search has text every section with a hit is shown open regardless of its fold state (`.searching`), and the fold state itself is left alone. The search's own `Esc` clears the field and `stopPropagation`s — otherwise it would also reach `mapView.js`'s `Esc` and disarm the prop tool just picked. Prop tile labels wrap to two lines rather than ellipsising.
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
- **`AppState.typeLabel` / `weatherLabel` / `timeLabel` are the German names for the bare keys** (`car` → `Auto`, `wet_road` → `Nasse Straße`, `daytime` → `Tagsüber`). `typeLabel` is derived from `ACTOR_TYPE_GROUPS` rather than a second table, so a new type in the picker is named everywhere for free; `WEATHER_LABELS` / `TIME_LABELS` are their own tables and **duplicate the words the Umgebung menu prints in `index.html` markup** — keep the two in step. Anything reporting state back to the user goes through these: the scenario summary used to print `car` and `wet_road` beside a toolbar saying Auto and Nasse Str.
- `UIUtils` (`app.js`) holds the helpers `properties.js` and `eventPanel.js` share: `paramRow(label, control, unit)`, `fmt(value, decimals = 1)`, `nextIndexedId(events, prefix)` and `bindLabel(label, control)`. **`fmt`'s convention is that display precision follows the input's `step`** — a `0.1`/`0.5`-step field reads 1 dp, a whole-number one reads 0 dp — and the *same* call formats the card summary above the field, so the two can never disagree (`10` next to `10.0`). `bindLabel` exists because every panel control is built in JS with no id: it assigns one and sets `for=`, or, for a segmented `.event-toggle` (a `<div>` of buttons, which `for=` cannot address), makes it a `role="group"` with an `aria-label` instead. `paramRow` and `_row` call it for you.
- **An event card is one row per meaning** (`_multiRow`, `eventPanel.js`): a choice and the value it governs share a row rather than taking one each — „Modus [Absolut|Relativ] [Ego ▾]" (or `[Vor|Rück]`), „Art [Δ|×] [Einmal|Dauer]", the speed row with its dynamics select, „Seite [Links|Rechts] [2.0] m [½][1]", „Richtung [Links ▾] über [12] m", and the speed triggers' „Ego ist / Differenz [rule ▾] [value] m/s". The trade is that a toggle's label lives in its `title` instead of a row label, and its buttons use short words (`Vor`/`Rück`, `Δ`/`×`, `Einmal`/`Dauer`); the CSS sizes toggles to their content and lets only the last control in a row stretch — sizing them evenly squeezed the reference-actor select to nothing. `test_actions_ext_e2e.py` pins the row counts. A new control goes into an existing row when it qualifies one, not into a row of its own.
- The properties panel is `--props-w` wide (320px) and its content text bottoms out at **11px**; only the bold, letter-spaced uppercase section eyebrows go smaller (10px). Several event-card rows are 5–6 column grids that only fit at that width — `.event-speed-row`, `.event-point-distance-row`, and the `70px` label column shared by `.event-row` / `.event-param-row` (which is why a param label longer than ~"Sollabstand" gets shortened and the long form moved to the input's `title`).
- **The Spawnpunkt grid is `.props-group.spawn-grid`, a 4-column `label input label input`** — X│Y and Z│Gier share a row, `#prop-init-speed` spans `2 / -1`. Plain `.props-group` (the type pickers) stays 2-column. The label columns are `max-content`, so hiding `Start (m/s)` for a prop visibly narrows column 1; that is the grid working, not a bug. `#prop-z-auto` beside the Z field re-derives z via `ObjectsManager.surfaceZFor` — the only way back to the surface height after typing a z by hand, short of moving the object. It is a button and **not** a live "auto/manuell" badge on purpose: the derived value comes from `_nearestLaneProjection` (a linear scan over every lane segment) and a body drag re-renders this whole panel on every `mousemove`.

## Maps

- Bundled towns live in `maps/<Town>/<Town>.xodr` (plus optional `.jpg` thumbnail and `_summary.json`), auto-discovered by `_scan_xodr_paths` at import time.
- Uploaded maps persist to `maps/_uploaded/*.xodr` and are re-parsed into `MAP_CACHE` on every startup (`preload_maps`, `backend/main.py`); a bad file logs a failure for that town without taking down the server.
- `maps/` is **not** gitignored — uploads land in the working tree.

### Aerial image (`maps/<Town>/aerial/`) and the base-map switch

A top-down photo of each CARLA town, rendered from CARLA itself by
`tests/capture_carla_aerial.py` — a JPEG tile pyramid (512 px tiles, level 0 =
10 px/m, each level halves) plus `meta.json` holding `x0`/`y0` (world position
of level-0 pixel (0,0)), `ppm`, `width`/`height`, `levels`. ~85 MB for all 8
towns. **The georeference is exact by construction, not fitted**: a nadir
camera at `pitch -90, yaw -90` already images +x right / +y down (the editor's
frame, no flip), and its altitude is set per frame so the road surface images
at exactly `ppm` (`alt = z_ground + f/ppm`). Overlaying the `.xodr` lane lines
on a capture is the check that this still holds.

- **Run it against a private CARLA, never run.sh's 2010** — it `load_world`s
  each town. Default `CARLA_PORT` is **2050**; start one from the same
  `f2d_carla` build run.sh uses so the photo shows the meshes a scenario runs
  on. A whole re-capture takes about a minute of render time.
- **8° FOV from ~1.5 km, central half of each 2048 px frame kept** — near
  orthographic (a 30 m building leans ≤ ~1 m). That altitude was checked
  against a 60° low capture: UE4 LOD/texture streaming does not degrade at
  1.5 km. **Exposure is manual** (`fstop 7`, `shutter 60`, `iso 100`) — the
  default histogram auto-exposure varies per frame and makes every seam
  visible. **The sun is at 80°, not 90, and bloom/lens flare are off**: under
  an overhead sun a nadir camera catches the water's specular reflection dead
  centre in *every* frame, and bloom haloes it onto the shore, so Town04's sea
  came out as a visible checkerboard of the capture grid. 80° moves the glint
  out of the 8° view for ~0.18 × height shadows; a ~5% darkening toward each
  frame's edge remains on open water and is the known residue. Parked cars
  and trees are kept (they are really there at runtime).
- **The capture extent is the union of CARLA's driving waypoints and the
  editor's own `bounds`** (`build_map_render_data`, stdlib-only so it imports
  fine in `carla-venv`) + 60 m. Waypoints alone are driving lanes only and
  missed ~180 m of Town03's west side.
- **Town10 and uploaded maps have no image** — nothing to photograph. Their
  `GET /api/maps/{town}/aerial` is a 404 (one expected console line), and the
  switch disables its two image modes with a `title` saying why.
- Served by `GET /api/maps/{town}/aerial` (meta) and
  `/api/maps/{town}/aerial/{level}/{col}_{row}.jpg`, **read from disk per
  request** like `special_buildings` — a re-capture shows on a browser reload,
  no restart.
- `frontend/js/aerialMap.js` (global `AerialMap`) owns `#layer-aerial`, the
  **first** child of `#world` (under the drawn roads), and `#map-base-toggle`
  (`Vektor | Luftbild | Beides`, top-left of the map). Two tile sets are on
  screen: a **backdrop** (finest level with ≤ 16 tiles, always fully loaded,
  so panning never flashes the verge) and a **detail** level matched to the
  live CTM × `devicePixelRatio`, only for tiles in view, rebuilt once per
  animation frame from `_applyTransform`. Tiles overlap their neighbour by one
  source pixel — abutting exactly leaves anti-aliased hairlines.
- **The modes are classes on `#map-svg` (`base-aerial`, `base-both`), never
  `style.display`**, because the Ebenen checkboxes write `style.display` on
  the same layers and the two would overwrite each other. `Luftbild` hides
  lane polygons, markings, crosswalks and junction circles; `Beides` keeps
  lane polygons as white outlines over the photo. Spawns, traffic lights,
  direction arrows and landmarks stay under their own checkboxes in every mode.
- The chosen mode is a per-viewer `localStorage` preference
  (`scenarioEditor.baseMap`), not scenario state — not in `toJSON()`, not in
  undo. A town without an image shows `Vektor` without forgetting it.

### Landmark overlay (`maps/special_buildings.csv`)

A bundled table of ~130 reference points (bus stops, parks, shops, …) drawn as
violet dots with a German name for the `building_type` above each one
(`LANDMARK_LABELS` in `mapView.js`; an unlisted type falls back to the key with
underscores as spaces). **Reference decoration
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
- The **`Sonderorte`** checkbox (`#toggle-buildings`) is an entry in the
  Ebenen menu, wired in `_setupLayerToggles` by id
  like the other six, through a getter because the layer is recreated per
  `renderMap`.

## The in-editor preview (`frontend/js/simulate.js`) and the cached CARLA lane graph

**The run is simulated up front and Play replays it — that is what makes the timeline
scrubbable.** Play calls `_simulateTimeline()` once (≈20 ms on a generated Town03 scenario):
it steps every sim actor at a **fixed 20 Hz** (`SIM_DT_S`, ScenarioRunner's own synchronous
tick — it used to be the rAF frame time × playback speed) and records a pose + badge frame
per tick. `_showTime(t)` interpolates between two frames and writes the poses through
`AppState.updateById` (undo suspended, as before); playback, the scrub bar
(`#sim-progress-bar`, pointer-drag, pauses and resumes), `←`/`→` (±0.5 s, `Umschalt` ±5 s)
and a click on an event tick (`.sim-marker`, one per tick that started events, tooltip
names them by their card title via `EventPanel.displayName`) are all just `_seek(t)`. A
click on the bar with no preview running starts one, paused. **The run ends where
ScenarioRunner's would**: the ego has driven 500 m, or 60 s (every Act's `MaxSimTime`), or
— the preview's own rule — nothing has moved and no event has fired for 3 s *and* no
event is still pending (an unfired `distance_to_ego` keeps it going to its 60 s fallback).
Playback holds the last frame there and `Nochmal` replays. The old live-stepping preview
dropped seeking on purpose ("it would mean replaying everything"); replaying everything
once is cheap, so nothing is faked. The `HeroActComplete` stop group is not modelled.

The Play/Pause/Stop preview is a per-tick kinematic re-implementation of the real controllers
(`SimpleVehicleControl` / `PedestrianControl`), not an idealisation of the authored events — it
evaluates all 7 real triggers (including the `distance_to_ego` 60 s OR-fallback, the
`assign_route`/`after_event` trigger rewrites `backend/scenario_io.py` applies at export,
an event reference naming another actor's event, and `ego_speed`/`relative_speed` off the
per-tick speed snapshot; „Abstand zu Akteur" reads the other actor off the per-tick pose
snapshot `_tickPoses`), and
mirrors real termination semantics (a speed step that persists past its duration, a
4 m/1 m waypoint-acceptance radius, a dead stop on `_reached_goal`). `lane_offset`
is simulated too — see its own section above for the centreline/`_pose` split and
why storing the displaced position would eat the offset. `set_distance` is
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
- `SimpleVehicleControl._reached_goal` is a **one-way latch** — `run_step` returns zero velocity
  *before* reading any target, and nothing (not `update_waypoints`, not `reset`) clears it. So a
  vehicle that reaches the end of its trajectory or route **never moves again**: no later
  `set_speed`, route, lane change or offset does anything. `sim.goalStopped` mirrors it for
  vehicles completely (`_advancePosition` returns; a later event is recorded and badged
  „Wirkungslos — steht nach Pfadende"; a new path completes at once, as `ChangeActorWaypoints`
  does on `check_reached_waypoint_goal()`). The event card warns statically for the one case that
  is certain — an `after_event` on the vehicle's **own** `follow_trajectory`, which fires at that
  very moment (`ScenarioRules.eventWarning`, an amber `.event-warning` chip that never blocks the
  export); any other timing only the preview can tell. **Walkers have no such latch**:
  `PedestrianControl` keeps walking its forward vector after the last waypoint. The preview still
  stops a walker there (until a new event moves it) — a known divergence, left because a walker
  walking on forever would hold every crossing preview to its 60 s limit.
- **A path event completes when its last waypoint is reached** (`_advanceWaypoints`). It used to
  never complete in the preview, so nothing chained onto a trajectory with `after_event` ever
  fired there.

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

**Commanded vs driven speed.** `sim.target` is what the atomics command
(`BasicControl._target_speed`) and `sim.speed` what the actor drives:
`_applyControllerLimits` runs `SimpleVehicleControl._set_new_velocity`'s clamp literally every
tick — against the **last commanded** speed (`sim.lastCmd`), at the actor's own
`max_acceleration` / `max_deceleration`, with the 0.5 m/s pull-away bump; the branch is chosen by
comparing the target with the measured speed (a magnitude), so a reverse target always takes the
deceleration branch. A walker has no limits (`PedestrianControl`). Consequences: a vehicle spawns
at rest and pulls up to its `initial_speed` (`_makeSimActor` seeds `target`, not `speed`); a
time-dimension `set_speed` step is a ramp at the limits; a `rate` ramp faster than the limit is
capped by it while the event still ends when its *commanded* ramp arrives. Every speed snapshot
(`_tickSpeeds`) and a rate ramp's `_start_speed` read the **driven** magnitude, as
`CarlaDataProvider.get_velocity` does. Otherwise this is the whole of the Init-`<SpeedAction>` mirror: every existing overwrite path
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
- Output is `maps/<Town>/lane_graph.json` — **gitignored, not committed**, so a fresh checkout has
  none and every town runs on the builder below. The probe is deterministic (a 2026-10-12 re-probe
  reproduced the old Town10HD file byte for byte); re-run it, against an idle CARLA, to get them
  back. `backend/main.py`'s `LANE_GRAPH_CACHE` is
  populated from one of **two sources per town**, decided once at startup (and once more, per
  town, at upload time): a probed file if one exists on disk, otherwise
  **`backend/lane_graph_builder.py`'s `build_lane_graph_from_xodr`**, which derives the identical
  JSON shape straight from the `.xodr` — no live CARLA needed. This covers Town10 and every
  uploaded map, which previously had no lane graph at all. Served from
  `GET /api/maps/{town}/lane_graph` (404 only if the .xodr itself failed to parse or the builder
  threw). `GET /api/maps` lists every town with one (`laneGraphs`) — nearly all of them now, so
  the frontend (`toolbar.js`'s `_fetchLaneGraph`) just always attempts the fetch rather than
  gating on a town list, which would otherwise go stale the moment a map is uploaded mid-session.
  The one field that tells the two sources apart is **`source`**: `"xodr"` on a derived graph,
  absent (frontend reads this as `"carla"`) on a probed file — `simulate.js`'s badges
  say "aus Kartendatei" vs "CARLA-Kartendaten" accordingly, and `_preferredSuccessor` (below)
  branches on it.
- **The builder reproduces `GlobalRoutePlanner`'s graph, not just the topology**, because the
  preview's route *is* an A* over it and every difference became a different drawn route (the
  reported one: a Town03 car swerving into lane −1 and back before junction 730, which CARLA drives
  straight). What it has to copy, each found by diffing against the probed graphs:
  - **Lane-change edges only as `_lane_change_link` adds them**: none from a junction lane; a lane
    gets at most one right and one left edge, at the first of its 2 m path samples whose marking
    allows it — the right marking is the lane's own `<roadMark>`, the left one its inner
    neighbour's (lane 0, `<center>`, for |id| = 1); `increase` → Right, `decrease` → Left, an absent
    attribute is Both (`LaneMarking.cpp`, RHT). Ungated it had 1,124 extra edges over 8 towns, and a
    lane-change edge costs 0, so each was a free detour. A lane shorter than 2 m has one sample,
    `entry.next(2)[0]`, which lies in its (first) **successor** — CARLA reads that lane's markings
    and neighbours, so a stub before a junction gets its edges into the connector.
  - **Edge length is `len(path) + 1`, a 2 m sample count**, not metres. `path` is `entry.next(2)`
    repeated while the chord to the exit is `> 2`, at exact s steps, so it is computed from exact
    geometry (`map_renderer.lane_centre_points`), not the 1 cm-rounded, 4 m-sampled directionLine:
    a last sample 2.0001 m from the exit counts, 1.9999 m does not. A chord within 1 µm of 2 m is
    a genuine tie, which CARLA's `> 2` loses (Town02's 18 m lanes).
  - **Node identity is the end point rounded to whole metres** (`entryxyz`, half-to-even) as well
    as the lane links: CARLA merges ends that merely round alike, so a lane under ~1 m becomes a
    self-loop a route steps over. Coordinates go through **float32** first (`_carla_round`) —
    `carla.Location` is float32, and Town03 has ends at exactly x = −0.5 that float64 maths puts a
    hair either side. Node vertices are the rounded values (they are only A*'s heuristic).
  - **Why lengths and vertices matter so much**: the heuristic is metres and the cost is samples
    (≈ metres / 2), so A* is *inadmissible* — it does not return the cheapest route, and which one
    it returns moves with off-by-one lengths and rounded vertices.
  What it cannot copy: `next()[0]` order at a fork (CARLA's `unordered_map` iteration — the
  highest road id is first at 73% of probed forks, not reliably) and the topology order that breaks
  equal-cost ties. Measured over 500 random lane pairs per town: identical lane sequence on 100% in
  Town01/04/07/10HD, ~99% Town02/05/06, ~80% Town03, whose misses are almost all one fork
  (1206 → 1100/1122, which only relabels where a lane change lands).
- **`tests/run_route_carla.py save.json …`** drives `assign_route` scenarios through `run.sh` and
  measures each route actor's CARLA track against the drawn route (`Simulate.routeGeometry`) and
  the preview track. Run 2026-10-12 on the xodr graphs (probed files moved aside), 11 scenarios
  over all 8 towns incl. lane-change chains, the stub loop and the reported junction-730 case: 11/12
  route actors stayed within 0.43–1.31 m of the drawn route; the 12th ended on a waypoint where two
  junction connectors overlap exactly and CARLA took the other one (a 60 m loop). **Which of
  exactly-overlapping lanes `get_waypoint` returns is not predictable** — probed on 300 tied points
  in 5 towns, highest vs lowest road id is ~50/50 — so do not add a tie-break rule. Two traps:
  **`run.sh` records in sync mode at ~11 s wall per game second**, so the default timeout is 900 s
  (150 s silently cut every route at ~100 m); and `run_carla_cases.kill_stragglers` runs
  `pkill -f scenario_runner.py`, which also kills **your own shell** if that string is in its
  command line.
- **`tests/compare_xodr_lane_graph.py`** validates the from-`.xodr` builder against the probed
  files present, with no CARLA connection needed — run it after touching
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
  towns; exact 1-hop `successors` equality does not, and is not expected to. It also compares the
  **routing graph**: LANEFOLLOW edge set (exact), lengths, lane-change edges, and A* lane
  sequences for 300 random lane pairs, with its own heap port of networkx's A* (`.venv` has no
  networkx), floors just under the figures above.
- **The join key everywhere is `(roadId, sectionId, laneId)`** — CARLA's own identity triple,
  matched against the render JSON's `sectionId`/`sStart`/`sEnd` additions above. This was
  cross-checked empirically (Town03 road 1772) before anything was built on it; if a future
  `.xodr` re-bundle or CARLA upgrade breaks the assumption, lookups fail closed (return `null`)
  rather than silently misattributing a lane — see `frontend/js/laneGraph.js`'s `laneRecord`.
- **`frontend/js/laneGraph.js`** is the frontend half: `_astar`, a **literal port of
  `networkx.astar_path` 2.8.8** (the version `carla-venv` runs) down to its tie-breaking — a binary
  heap on `(f, push counter)`, adjacency in edge order, one edge per `(from, to)` pair, the
  heuristic as `sqrt(dot)` so floats match bit for bit. The plain-array A* it replaced returned a
  different equal-cost path on 26% of random Town03 routes, often with lane changes CARLA does not
  make; the port agrees with networkx on 2,100/2,100. Then `route(graph, from, to)` `route(graph, from, to)` (ports `GlobalRoutePlanner.trace_route`'s waypoint
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
    actually ends within that metre, which is what `_seedAssignRouteStart` reproduces:
    - it walks **1 m of s** (`_walkDirLineS`, the directionLine's 4th element), not arc length —
      on the inside of a curve a lane is shorter than its s span, and an arc-length metre ran off
      the end of lanes `next(1)` stays inside (Town04's ramps);
    - the lane end is **exclusive** — landing exactly on it is already the successor;
    - it carries the leftover through as many successor stubs as the metre reaches, and builds
      the seed's lane ref **from the lane it walked**, never by re-projecting: the boundary point
      projects back onto the lane just left;
    - at an xodr fork, where path-less driving refuses to guess, the seed takes the
      highest-numbered road — any successor beats the actor's own point, see the next item.
    **Why the seed matters**: once it is past the lane end, waypoint 0 (the actor's own pose) is
    *behind* it, and CARLA really does drive round the block to come back to it (Town03 road 5 is
    a 0.8 m stub: a 194 m loop). The preview now draws that loop too. CARLA's own `get_waypoint`
    s is only good to ~0.3 m on curves (it reported s 1.28 for a point at s 1.0), so an actor
    standing within that of the 1 m threshold can go either way.
  - **Every route endpoint is projected in 3-D** (`_resolveLaneRef` / `_laneAnchor` pass z to
    `ObjectsManager.nearestLaneProjection`'s optional `wz`), as `get_waypoint` does — a waypoint on
    a bridge deck routed from the street beneath it. Placement height (`groundZAt`) stays 2-D on
    purpose. A waypoint inside a junction where connectors **overlap exactly** can still land on
    a different connector than CARLA's; that tie is CARLA's spatial index, not knowable here.
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
- **Risk accepted on purpose:** a probed file is pinned to this CARLA/ScenarioRunner
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

## The random scenario generator (`frontend/js/scenarioGenerator.js`)

Header menu **Generieren** (`#gen-menu-btn`): one row per scenario type, `Beliebiger Typ`, a `Seed`
field, and **Mehrere generieren …** (the batch dialog, `#gen-batch-overlay`). The goal is bulk test
scenarios for a perception/planning or end-to-end stack, so **random means randomised parameters of
a known conflict, never random actions**. Eight types: `lead_brake`, `cut_in`, `vru_crossing`,
`junction_conflict`, `obstacle`, `oncoming_drift`, `cyclist_ahead`, `cut_out`. Plan and history:
<https://claude.ai/artifact/GReE895gaqTjULAjrzN8Dm>.

`generate(type, seed, {near, overrides})` replaces the whole scenario as **one undo step**; `build(...)`
is the same without touching `AppState`; `generateBatch({...})` makes N off-screen;
`assess(candidate)` scores one. A seed rebuilds the same scenario on the same map + lane graph. Actor ids
are not part of that — `nextId` keeps counting.

- **The ego may be driven by the AV under test, so nothing is timed off the clock.** Every NPC event
  starts on `distance_to_ego` (or `after_event` on its own chain); `simulation_time` appears only on
  an `assign_route`, where the backend forces it anyway. The radius is solved from a target
  time-to-conflict (`_solveTrigger`). The ego still gets an `assign_route` and an `initial_speed`,
  so the file also runs scripted. `tests/test_generator_e2e.py` asserts the trigger rule on every
  generated event. **Verified in CARLA** (see below): every ego-relative trigger fired while the
  scripted ego, which ramps at 3 m/s² and the preview does not, was approaching.
- **Everything starts from an ego corridor**: a lane-centre walk from a random non-junction lane
  through random lane-graph successors. The ego's route waypoints sit **8 m past each junction exit**,
  not inside it — connector lanes overlap, and a waypoint in the box can project onto the wrong one.
  The computed route (`Simulate.routeGeometry`) must stay within 2 m of the corridor or the attempt is
  thrown away; up to 150 attempts per scenario from one seeded RNG (mulberry32). `cut_in` and
  `oncoming_drift` start their corridor on a lane that has the neighbour they need — a random start
  finds one rarely.
- **Every light the ego meets before the conflict is forced green — a "green wave"** (`_greenWave`,
  called in `build` with each type's `conflictD`; the result is the scenario's `trafficSignals`). The
  ego obeys reds and a four-way cycle holds one for up to ~40 s: in CARLA the ego sat 44 s at a red
  and reached the crossing pedestrian only as every Act's 60 s stop trigger ended the run, and the
  preview models no lights. Corridors through signalized junctions used to be *rejected* outright
  (`_signalBefore`); forcing them green instead took Town10HD's drift from ~7/12 to 10/10 seeds and
  lets `junction_conflict` build **perpendicular red-light runners** at signalized junctions (the NPC
  ignores lights, the ego gets green). Three details carry it:
  - **Which light**: each junction connector road carries a `<signalReference>` to exactly one light
    (`map_renderer._extract_traffic_lights` → `roads`). `_lightsFor` takes the light on the ego's
    connector *plus* any on a connector sharing its entry point — a light's trigger volume covers
    the approach lane, so an unreferenced turn still stops at its neighbour's red.
  - **Re-asserted, not set once**: `TrafficLightStateSetter` is a bare `set_state` and the group
    controller overwrites it at its next phase change, so each light gets a Schaltung at 55/38/24/13/5 m
    before the stop line (`GREEN_WAVE_BEFORE_M`). `simple_vehicle_control` stops only for **red** and
    only inside the trigger volume just before the line, so the 5 m one leaves no window.
  - **3-D radii**: the condition is `location.distance()` from the ego to the pole, so each radius is
    the 3-D distance from the pole (at its road z) to the corridor point.
  Measured in CARLA (Town03 ×2, Town05): every forced event fired (7/7, 13/13, 12/12), the ego never
  stopped at a light, and the conflicts happened (0.35 m — a truck running the red — 3.15 m, 3.27 m).
  The lead in `lead_brake` / `cut_out` ignores lights: it reaches each light *before* the ego
  switches it, and waiting at that red parked it there.
- **A headway is a bumper gap; `distance_to_ego` is centre to centre** (`_centreDistance`).
  `simple_vehicle_control` follows at a 5 m bumper gap (`DEFAULT_STANDOFF_DISTANCE`), ~9.5 m between
  two car centres, so the lead's brake radius used to be unreachable whenever headway × speed came out
  under that — it fired only on the 60 s fallback. Same for the cyclist's swerve.
- **Timing is solved against the ego at cruise speed, with a run-up of v²/(2·3 m/s²) + 15 m**. The
  junction NPC and the oncoming-drift NPC wait on their routes at speed 0 (a route alone does not
  move an actor) and are released with a `set_speed` **`rate` 3.0**, not a `time` step, so preview
  and CARLA ramp identically.
- **Both conflict NPCs ignore lights and obstacles** (`_ignoresTraffic`: `obey_traffic_lights` /
  `obey_obstacles` false). With them on, the junction car braked for the ego crossing in front of it
  and the drifting car braked for the ego head-on in the lane it swings into — each defused the
  conflict it exists to create. The ego keeps both on; its lights are forced green (above).
- **Site rules that are not obvious:** a cut-in takes its neighbour from the lane graph's `left`/
  `right` (same-direction lanes only), checks the graph agrees in reverse, and needs room for the
  whole change on both lanes — `ChangeActorLateralMotion` never fails, it hangs. Town01/02/07 have no
  such pair. `oncoming_drift` needs the ego in lane ±1 of
  a two-way road; offsets under ~1.4 m only brush past.
- **`cut_out` (Euro NCAP CCRs cut-out)**: a lead in the ego's lane, a 0.9–2 s headway ahead at the
  ego's speed, swerves into a same-direction neighbour (lane graph `left`/`right`, checked in
  reverse) and uncovers a stopped vehicle. The swerve is a `lane_change` triggered by
  `distance_to_point` on the lead's **own** entity — positional, and ego-relative through the
  following itself. It starts as late as the lead can make it: 6 m same-lane run-in + 60% of the
  lateral spread (where a 2.1 m car stops overlapping a 3.5 m lane) + both half-lengths + 1.5–10 m;
  drawn generously the ego saw the obstacle 4–7 s out — far too easy. The lead ignores
  obstacles (its sensor would brake it for the car it is swerving round). 70% of stopped cars drive
  off once the ego is right behind (a **9 m** bumper-gap radius — the scripted ego halts ~6.3 m back,
  so 6 m was never reached and the car left only on the 60 s fallback), so the run does not stall. Criticality is
  measured from the swerve (`res.revealedBy` → `assess`), with the lead as scenery. Town01/02/07 have
  no lane pair.
  Measured in CARLA (Town03/05/10HD): the lead swerved at the scripted point, cleared the stopped car
  by ~3.5 m, and the scripted ego braked to a stop ~10.8 m (centre) behind it; with the drive-off it
  then carried on.
- **`oncoming_drift` is a route, not a `lane_offset`**: fastest legs along the car's own lane, then
  a run of `shortest` waypoints every ~3 m tracing a half-cosine swing into the ego's lane, an
  optional hold, a swing back, then a `fastest` waypoint 30–50 m on (`_walkForward`) so the route's
  end — where the controller stops dead — is behind the ego. A `lane_offset` jumped the aim point
  sideways in one tick. Three rules hold it together: **the swing ends exactly on its own lane
  centre** before the next `fastest` waypoint (that leg is routed *from* it, and an off-lane seed
  projects onto the ego's lane — the wrong way); **the first swing waypoint stays `fastest`** (its
  leg is the routed run-up); and **each sample is projected onto the oncoming lane of the corridor
  segment it falls in** (`oncAt`), so a swing may cross lane sections — Town10HD splits its two-way
  roads into short ones, and requiring one lane found no site there. The drift point is drawn only
  from junction-free two-way *stretches* where the whole swing fits; a uniform draw lost most of
  Town03's attempts to junctions. Because the car starts from rest, the conflict sits further down
  the corridor than the old meeting point did, past more lights the ego obeys, so Town10HD builds
  ~7/12 seeds (the old drift ~10/12); Town06 has no two-way ±1 lanes and never built one. `cyclist_ahead` has no route (a
  cyclist is not routable), so its whole ride before the ego catches it must be junction-free.
- **Crossing VRUs start and end on a `sidewalk` polygon only**, found by stepping across the road
  until it leaves every carriageway polygon (`_carriagewayEdges`) and then searching a kerb offset
  that lands on a sidewalk (`_onWalkable`). "Just past the edge" was a building wall on Town10HD and a
  guardrailed shoulder on Town04, and CARLA refused the spawn, killing the run. Their **z comes from
  the corridor at the crossing point plus 0.6 + 0.4 m** (`KERB_ALLOWANCE`), never from the nearest
  lane (an overpass, beside Town03's elevated roads) — the elevation profile does not model kerbs, and
  Town02's sidewalk is 0.32 m up, enough to put a walker's capsule into it at the editor's usual
  0.6 m. A crossing uses `follow_trajectory` (a cyclist is a `<Vehicle>`; `set_speed` would ride it
  along the road). The occluding van is only parked in a real `parking` lane and is marked scenery.
  A crossing *cyclist* starts 0.8 m inside the carriageway edge, not on the sidewalk — a 1.8 m bike
  set across a narrow sidewalk reached the wall behind it — but a sidewalk beyond the edge is still
  required (without that rule the site was a guardrailed Town07 bridge). **30% of walkers stop dead
  in the ego's lane** for 1.5–4 s and then carry on (`stops_in_lane_s`): a `set_speed 0` triggered by
  `distance_to_point` on the walker's *own* entity at the lane centre (radius 1.5 m — the condition is
  3-D and the walker's centre is ~0.9 m up), then `set_speed v` after it. Verified in CARLA.
- **Heights are taken from the nearest lane in 2-D** (`surfaceZFor`, `routeWaypointAt`), which is
  ambiguous under an overpass — but every generated vehicle sits on a lane centre, so its own lane is
  always the nearest (measured: 3 of ~630 actors stood where two levels overlap, all on their own lane
  at 0.00 m, the other level ≥ 0.72 m away). Crossing VRUs, which stand off the lane, take the
  corridor's z explicitly. Do not "simplify" that back to `surfaceZFor`.
- `_spawnsClear` rejects overlapping spawns and any prop within 15 m of the ego's spawn. **It cannot
  see scenery meshes** (hedges, railings, poles are not in the `.xodr`) — see the spawn probe below.
- **The lead car's route runs 60 m past the ego's** (`egoEndD`), and **75% of full stops drive off
  again**: in CARLA a lead that stopped for good blocked the ego for the rest of the run (45 m
  driven, then the 60 s stop trigger).

### „Konflikt hier erzeugen": a generator type built at a map click

`build(type, seed, {near: {x, y}})` sets the module-level `_focus` for that one call (try/finally): every
`_buildCorridor` then starts `_focusStart` — a random 50–220 m walk **back** through predecessors from a
driving lane within 6 m of the click (12 m on a retry from a kerb; either direction, connectors included) —
and is **forced along that path** to the clicked lane before going on at random. A type's own start-lane
bias (cut-in's multi-lane, the drift's two-way start) is ignored under a focus; its site search still runs
on the corridor. A candidate is kept only when `assess()`'s new **`at`** — the ego's position at contact,
or at closest approach — is within `FOCUS_RADIUS_M` (40 m) of the click, and gets 150 more attempts for
it. A seed + spot reproduces. Measured on Town03/05/10HD spawn points: 2–6 of 6 spots per type, slowest
~1.7 s (`junction_conflict` on Town05); failures are sites that cannot host the type.

UI: the Templates tab's first section (`[data-generate-here]`, `ScenarioTemplates._generatorSectionHtml`,
labels from `ScenarioGenerator.TYPES`) and the Generieren menu with **„Ort auf der Karte wählen"**
(`#gen-pick-spot`) both call `ScenarioGenerator.armAt(type)`, which sets **`AppState.pendingGenerate`**
(`'any'` for Beliebig). `objects.js`'s click handler hands the next map click to `generateAtClick` before
anything else — on an actor too, since the scenario is replaced (confirm unless Strg). A spot where nothing
fits toasts and **re-arms**, so the next click tries elsewhere. `tests/test_generate_here_e2e.py` pins it.

### Internal conflict check: trivial and unavoidable candidates are dropped

**Nothing here is shown to the user.** The difficulty grades (leicht/mittel/schwer), the batch
„Schwierigkeit" filter, the live badge and the TTC/difficulty manifest columns were all removed on
2026-10-11 as not accurate enough to show. What remains is the rejection gate and the conflict
location `at` used by „Konflikt hier erzeugen".

`generate`/`generateBatch` **stop a running preview first** (`Simulate.stop()`): `runHeadless`
cannot run beside it, and generating mid-Play used to fail every attempt and report „Kein passender
Ort". `Abbrechen` during a batch aborts with no download (it used to download the partial zip).

`assess()` runs the candidate through **`Simulate.runHeadless()`** — the same `_makeSimActor`/
`_stepActor` as Play at a fixed `dt`, no rendering, no `AppState` writes; it accepts `{ego, npcs}`
so a candidate can be scored before it is loaded, and **returns null while Play runs** (shared tick
state). It also reports `frozen`/`frozenAt`: route-less actors (cut-in car, oncoming car, cyclist)
freeze in the preview at the first `.xodr` fork, where CARLA would drive on. Checked: in 59 freezes
across 75 scenarios the freeze always came *after* the conflict, so no label rests on it. The preview ego never reacts, which is the counterfactual wanted: "what if the system under
test does nothing". Contact is a **separating-axis overlap of the two footprints** (`ACTOR_SIZES` /
`PropCatalog.planSize`, yaw from motion) — a flat centre distance is wrong for both a rear-end and a
7 m truck.

- `ttc_s` = time from **threat onset** to first contact; `decel_mps2` = ego braking needed from onset
  to stop short of the contact point (an upper bound for a moving NPC). Onset is the NPC's first
  ego-relative trigger, **except** where a type names something better: the junction car crossing
  the line into its connector, the pedestrian stepping off the kerb (`res.onsets`), the cyclist's
  swerve rather than its kerb-riding event that fires at t = 0 (`res.threats`). Measured from the
  release, every junction conflict looked easy, because the NPC's run-up includes ~15 m inside the
  junction.
- **trivial** = no contact and the footprints never within 2 m → rejected. **unavoidable** = contact
  < 1.0 s after onset or > 9 m/s² needed → rejected. Everything else is kept (`verdict: 'ok'`).
- Scenery (`res.sceneryIds`, the occluding van) is excluded from the conflict search, or a parked car
  beside the lane scores as a near miss.

### Recipes: a generated scenario's parameters, editable (`AppState.generated`)

`generate()` stores a **recipe** on `AppState.generated` — `{type, label, seed, town, near, anchored,
attempt, overrides, params, criticality, signature}` — which is **scenario state**: in `SCENARIO_KEYS`,
in both undo directions (`_snapshot`/`_apply`) and in `toJSON`/`loadJSON`, so undoing a rebuild
restores the recipe that built what is on screen. The Übersicht tab renders it as „Generiert"
(`ScenarioGenerator.recipeHtml` / `bindRecipe`, called by `properties.js` like the template panel; the
overview re-renders on a `generated` patch). One field per entry of `PARAMS[type]` plus `EGO_SPEED`;
changing one **pins** it (`overrides`) and calls `rebuild()`; × unpins; „Variante würfeln" = new seed,
pins kept, focused on the recipe's spot.

- **Every random draw goes through `_p(key, drawn)`, and the draw is made whether or not it is
  pinned** — conditional draws were rewritten so (`stopDraw`, `hesitDraw`/`holdDraw`, `occDraw`).
  `key` is also the key in the build's `params`, which is what the panel *displays*: the value used,
  not the pin, because a site may not honour one (an occluder needs a parking lane; a lead or cut-in
  car is capped at 0.9 × ego speed). A pin that differs from its value is flagged (`.unmet`, ⚠).
- **Each attempt has its own RNG** (`_attemptSeed(seed, attempt)`), not one shared generator. That is
  what makes "same site" possible: attempt k is the same corridor and draws whatever happened before
  it, so `rebuild` retries the recipe's `attempt` first (`opts.firstAttempt`, `onlyFirst`). With one
  shared RNG a pin that changed how far an earlier attempt got shifted every later one, and a pinned
  build also accepts verdicts the original rejected (below), so an *earlier* attempt won and the
  scenario jumped ~100 m. **This changed which scenario every seed produces** — seeds from batches
  made before it do not reproduce.
- `anchored` says which attempt numbering `attempt` is in: a focused build (a click, or a rebuild
  that needed the focus) is anchored and rebuilds focused; otherwise the **plain** attempt is retried
  first and kept only if its conflict stays within `FOCUS_RADIUS_M` of the recipe's `near` (the first
  build's conflict point), else a focused build follows. Measured on Town05 (seed 5, every type, one pin
  at a time): 43 of 47 rebuilds kept the ego start exactly; the 4 that moved (two speed pins, two
  ego-speed pins) made the original attempt infeasible.
- **With pins the trivial/unavoidable gate is off** (`no_run` still rejected): the user asked for those
  values, and the badge says what they give.
- `signature` (a djb2 hash of ego/npcs/props right after the build) tells the panel the scenario was
  hand-edited; a rebuild then asks first (`_confirmDiscardEdits`). A collapsed event card counts as an
  edit — it only decides whether to ask. On another map the panel says so and `rebuild` refuses.
- **„Serie exportieren"** (`sweepFromRecipe`, `_sweepHtml`): one scenario per value of one parameter
  (2–25 evenly spaced values rounded to the field's step, or every option of a choice/bool), optionally
  × all six weather presets, max 200, each built with `_buildFromRecipe` (the same path as `rebuild`, so
  the same site), exported through `POST /api/export/batch` with `sweep_param`/`sweep_value`/`pinned`
  in the manifest. The editor is swapped out and restored exactly like `generateBatch`. `_sweepUi` keeps
  the box's state across the overview's wholesale re-renders; its open flag is set on the summary
  **click**, not on `toggle` — `toggle` is a later task and a re-render in between drew it closed.
- `tests/test_recipe_e2e.py`.

### „Ego bremst": a reacting ego, preview only (`simulate.js`)

`#sim-ego-react` (preview bar, fixed width) switches the preview ego from "does nothing" to a simple
braking driver: `_reactEgoTarget` caps its **commanded** speed (`sim.target`, what the events set —
the event logic never sees the brake) by the braking room to stop 2 m short of anything in its path
(`_egoAllowedSpeed`: other sims and props inside a footprint-wide corridor up to 60 m ahead, extent
taken conservatively whatever their heading), and the controller limits do the braking and pulling
away — the ego's own `max_deceleration` / `max_acceleration`, as `consider_obstacles` does in CARLA. Flipping it mid-preview stops and reopens the run at the same time.
**`runHeadless` never reacts unless asked** (`reactiveEgo`, saved/restored around the run), so the
generator's `assess` always scores the no-reaction counterfactual. It is not a model of CARLA's scripted ego (`consider_obstacles`) —
measured on Town03, a braking ego avoids lead-brake/cut-in/cut-out/cyclist/obstacle contacts and not
an oncoming drift or a walker stepping out late, which is the plausible split.

### „Ablauf": the events on a time axis (`frontend/js/eventTimeline.js`)

`#sim-lanes-toggle` (preview bar, fixed width) opens `#sim-lanes` above the bar, as wide as the bar:
one row per actor (ego first), one block per event from its `firedAt` to its `completedAt` (dashed
right edge = still running at the end), read off `Simulate.runHeadless` — which now also returns
`completed` — with a dashed connector from the event an `after_event`/`event_started` waits on, and
an „nie: N" column for events that never fire in the run. **Its run ends where the preview's does** (`runHeadless({stopWhenIdle: true})`, the same idle/pending rule as `_simulateTimeline`) — on the generator's rule (10 s still *and* past 60 s), which `assess` still uses, every axis stretched to 60 s. Re-runs 400 ms after any edit while open,
never during a preview (`runHeadless` refuses) — opened mid-preview it keeps its last result or says
„Vorschau läuft". **Click a block → `Simulate.seek(firedAt)`** (new export; starts a paused
preview). **Blocks are not draggable, by decision**: drag-to-retime existed and was removed along with
the criticality badge (2026-10-11); retime an event in its card. `tests/test_event_timeline_e2e.py`.

- **A block click also selects its actor and marks its card** (`EventPanel.highlight` → `.event-card.timeline-focus`,
  scrolled into view once, shown expanded even if `collapsed` — view only, the stored flag is untouched). The
  mark is module state in `eventPanel.js` because the panel re-renders on every preview frame; for the same
  reason it is static (no animation, no smooth scroll). Cleared on Stop.
- **The red playhead (`.sim-lane-playhead`) follows `Simulate.onTime`** and is placed on *this panel's* axis
  (`_data.end`, the headless run), not the preview bar's — with „Ego bremst" on the two runs end differently.
  Dragging it, or pressing anywhere on the axis row, scrubs (`Simulate.seek`, paused while dragging, resumed
  after if it was playing). Opened mid-preview the panel still has no data (`runHeadless` refuses) — open it first.
  `tests/test_preview_lock_e2e.py`.

### Batch export and coverage (phases 2 and 3)

`generateBatch` builds N scenarios **without disturbing the editor**: each candidate is swapped into
`AppState` by plain assignment (not `set()`), so nothing renders or records undo, and the saved
actors/weather/time/map are put back at the end. It emits `change {}` afterwards, **never
`stateLoaded`** — `app.js` clears the undo history on that. `POST /api/export/batch`
(`export_batch_zip`, `backend/scenario_io.py`) zips `<name>.xosc`, `<name>.json` (an editor save
file, reopens with **Laden**) and `<name>_route.xml` (the ego route as a goal for an AV stack) per
scenario plus `manifest.csv`/`manifest.json` (seed, town, type, weather, time,
every type parameter). Each scenario is exported independently; a failure is a manifest row with
its error, not a lost batch.

- **Coverage is pairwise over town × type × weather × time** (`coveragePlan`, greedy AETG-style: each
  next combination is the one of 40 random candidates covering the most uncovered pairs). The full
  product is ~1000 combinations; pairs are where most failures hide. `Typen gleichmäßig verteilen`
  off hands the type back to the generator's own pick. Ties on new pairs go to the
  combination whose values are least used so far, so values spread evenly too: without it, once an
  eighth type existed a 9-item all-maps batch covered only 6 of the 8 towns.
- **Weather is a preset, not independent sliders** (`WEATHER_PRESETS`: klar, bewoelkt, regen,
  starkregen, nebel, nass) — rain without a wet road is not a condition anyone drives in. Snow and
  dust are left out (CARLA 0.9.15 renders neither). Times: daytime, morning, dusk, nighttime.
- **`Alle CARLA-Karten`** switches maps through the real `#map-select` (so the lane graph loads the
  normal way), grouped so each town loads once — Town01–07 and Town10HD, the towns run.sh's CARLA
  build ships. 48 scenarios over all eight take ~13 s; 20 on one map ~0.7 s.

### What `follow_trajectory`'s speed becomes in CARLA

**The card therefore offers ONE speed per trajectory** (`.trajectory-speed-input`, `Geschw.`), not a field per
waypoint. It is still stored on every vertex — all equal, written by `ObjectsManager.setPathVelocity` — so the
payload, the backend and the emitter are unchanged and a constant speed reaches CARLA exactly. A legacy file
with differing vertex velocities shows the effective average (`EventPanel._trajectorySpeed`, the same formula
as `Simulate._avgTrajectorySpeed`) until the field is edited, which rewrites them all. No input before a path
exists: there is no vertex to hold the value.

Per-vertex `velocity` is turned into `relativeTime` by the emitter (`_compute_trajectory_times`), and
ScenarioRunner's parser collapses that to **one** speed — total length ÷ total time — set as the
target by a `ChangeActorTargetSpeed` ahead of the waypoints. Constant velocity survives exactly
(measured: cyclists held 4.68 vs 4.7 and 3.43 vs 3.4 m/s); varying it per vertex does not. A bike
ramps to it at 3 m/s² (~1–1.5 s); a walker does not. **A later `set_speed` changes the speed and
leaves the path running**, so speed along a trajectory is authored with `set_speed` events — e.g.
`distance_to_point` on the actor itself — which is what the stop-in-lane walker does. An
`assign_route` with every waypoint `shortest` is the same atomic underneath, but is not needed for
this and is refused for walkers in three layers (emitter, backend, `ScenarioRules`).

### CARLA verification (`tests/run_generated_carla.py`, `tests/probe_generated_spawns.py`)

- `run_generated_carla.py town:type:seed[:weather:time] …` builds through the editor and runs each
  through run.sh via `run_carla_cases.run_case`, reporting event times, closest approach and the
  ego's speed then, beside the preview's prediction. Measured 2026-10-08 on 13 scenarios across 7
  towns: every trigger fired and every NPC type produced a real interaction (scripted ego braked to
  2.3–5.3 m, or stopped behind the lead). The scripted ego **drives through cones** — it does not
  avoid static props; that is what an obstacle scenario tests an AV stack on.
- Re-run 2026-10-09, one seed per type: every trigger fired and every type produced its conflict —
  Town03 `cut_out` (ego stopped 10.9 m behind the uncovered truck), Town05 `oncoming_drift` (ego
  stopped, 3.2 m apart), Town10HD `vru_crossing` (ego slowed to 4.5 m/s, 6.2 m clear), Town03
  `junction_conflict` (red-light runner, 2.7 m), Town05 `cyclist_ahead` (8.2 m), Town02 `obstacle`,
  Town10HD `lead_brake` (ego followed the braked van at 7.8 m). Two defects:
  - **The junction NPC's route ended just past the exit**, where it stopped dead in the road the
    ego turned onto; the ego sat behind it until the 60 s stop trigger. Its route now runs 60–90 m
    on (`_walkForward`, `_junctionConflict`); re-run: ego route complete at 34.9 s.
    **That was not enough when the NPC leaves the junction onto the ego's own lane** (2026-10-12,
    Town03 seed 24): it then ran ahead of the ego and parked 60–90 m on, on the ego's route, and
    the ego waited 5.3 m behind it until 60 s. Now, when the route's end (the run-on, or the exit
    pose if the walk dead-ends) is within 2.5 m of the corridor past the junction, the NPC follows
    the corridor to its end and the ego's route stops 60 m short (`egoEndD`, the lead car's rule);
    if its exit lane is not the corridor's, the attempt is refused. Seeds whose old site hit this
    now land elsewhere.
  - **Town04 `cut_in` seed 4: the ego drove through the car that cut in** — same x/y, ego 2.4 m
    higher. `SimpleVehicleControl` commands `velocity.z = 0` every tick, so on a ~5 % downgrade at
    10 m/s the ego left the road (2.8 m up by t = 18.5 s) while the 6.9 m/s NPC kept up. That is
    ScenarioRunner's, not the generator's — see NOTES 1.4 for the numbers and the suggested fix.
    **Check `z` before trusting any CARLA result on a graded road at speed.**
- **`probe_generated_spawns.py`** spawns every actor of a whole batch together in CARLA and destroys
  them again (~5 min for 240 scenarios / ~600 actors; latest 239/240). `--zip batch.zip --out ok.zip` filters a
  downloaded batch down to the scenarios that spawn completely. **Run it before using a batch
  unattended**: ~1% of scenarios (crossing VRUs) hit scenery the `.xodr` does not contain.
- `run_carla_cases.py`'s telemetry sidecar now gets `--port 2010` (`CARLA_PORT`); its default of 3000
  recorded nothing against run.sh's server.
- **Start CARLA yourself before a batch of runs** (`cd ~/yungloon/fail2drive/f2d_carla &&
  ./CarlaUE4.sh -carla-port=2010 -RenderOffScreen`). If `run.sh` has to start it, it also
  stops it at the end of every case, and the telemetry sidecar — which attaches *before*
  run.sh — times out on a server that is still booting: the scenario runs and you get
  „no telemetry".
- **CARLA can segfault on a map switch** (`load_world`); run.sh then starts its own server, and its
  `kill` on exit reaches only the `CarlaUE4.sh` wrapper, so the binary survives on 2010. Check
  `pgrep -af carla-port=2010` after a session. A run whose hero "never spawned" or whose telemetry
  sidecar timed out was a map load, not the scenario — re-run it.

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

**The ego drives itself now — there is no `SCENARIO_GOAL` and no external agent.** `run.sh` starts CARLA on port **2010** (if not already up, from `/home/dellpro2/yungloon/fail2drive/f2d_carla`) and runs `/home/dellpro2/Antonio/scenario_runner/scripts/run_selfref_video_test.py`, which drives that same checkout's `scenario_runner.py` and records FPV/THD/BEV video (see the next paragraph for why the checkout matters).

**There are two ScenarioRunner checkouts on this box and they do not agree — check which one you are editing.** `/home/dellpro2/Antonio/run.sh` executes **`/home/dellpro2/Antonio/scenario_runner`**: it `cd`s there and runs that repo's own `scripts/run_selfref_video_test.py`, which hardcodes `SCENARIO_RUNNER_ROOT` to the same path and `Popen`s its `scenario_runner.py`. `tests/run_carla_cases.py` drives the *same* `run.sh`, so both paths now exercise one install and **`/home/dellpro2/yungloon/scenario_runner-0.9.15` is imported by neither** — only the CARLA server binary and the `agents.navigation.*` package come from yungloon (`CARLA_ROOT=/home/dellpro2/yungloon/fail2drive/f2d_carla` — `/home/dellpro2/yungloon/carla-0.9.15` no longer exists; the server `run.sh` starts on 2010 is that fail2drive build, which ships Town01–07 and Town10HD). Their `atomic_behaviors.py` differ by ~1985 lines, and the yungloon copy is the **locally patched** one (`CHANGES_LOCAL.md` there records it): its `ChangeActorWaypoints.initialise` filters the router's output with a `> 1.0 m` dedup **plus a heading band that drops reversals**. The install `run.sh` actually runs carries the same 2.0/4.3 heading band (verified 2026-08-24 by reading both files), so `simulate.js`'s `_exactRoute` filter (`ROUTE_HEADING_ACCEPT_LO`/`HI`) models what actually executes. **The executed install also carries one further local patch**: `ChangeActorWaypoints.initialise` binds its `ego_next_wp` seed *before* the waypoint loop instead of inside the `i == 0` branch. Unpatched — and stock 0.9.15 is unpatched — a route whose first waypoint is `shortest` and whose second is `fastest` reaches the heading filter's fallback with that variable unbound and kills the run with an `UnboundLocalError`. **The patch is deliberately not load-bearing**: the editor never emits such a route (waypoint 0 is the seed and is always `fastest`, enforced again as a 400 in `validate_scenario_params`), so exports run on an unpatched install either way. It covers hand-written and LLM payloads only. The yungloon copy still has the bug and is executed by nothing. Both resolve `agents.navigation.global_route_planner` to `$CARLA_ROOT/PythonAPI/carla/agents/navigation/`, and the GRP is the `CarlaDataProvider` singleton at sampling resolution **2.0** — the value `probe_carla_lane_graph.py` matches. It takes only `SCENARIO_FILE` — no `--goal` flag exists in this script, and it never launches `automatic_control_1.py` or any other external agent. Every ego manoeuvre — where it goes, when it speeds up, whether it turns at a junction — is now **authored in the editor as an event on the ego**, exactly like an NPC's, and reaches the file as the ego's own `heroBehavior` Act. Without a `follow_trajectory`/`assign_route` event the ego has no plan and drives its spawn lane via `SimpleVehicleControl`'s own `map.get_waypoint(...).next(2.0)` walk, which will not turn at a junction — that is expected, not a bug, and it is why junction/turn scenarios need a path event.

**`set_speed`'s `rate` dimension only works because of a local patch to those two checkouts.** A third checkout, `/home/dellpro2/Antonio/scenario_runner_github`, is **stock 0.9.15** and is executed by nothing here — it is useful precisely as the reference for what is and is not upstream. Both `/home/dellpro2/Antonio/scenario_runner` (what `run.sh` runs) and the yungloon copy carry a `rate` branch in `openscenario_parser.py`'s `SpeedAction` block plus a `rate=` parameter and ramp in `ChangeActorTargetSpeed`; stock has neither. **On stock, `dynamicsDimension="rate"` falls into the `else` and the value is read as a duration in seconds** — a clean file that silently does the wrong thing, not an error. If an export is ever run against an unpatched ScenarioRunner, that is where a "the ramp did nothing" report comes from. Verify with:

```bash
grep -n 'dimension == "rate"' /home/dellpro2/Antonio/scenario_runner/srunner/tools/openscenario_parser.py
```

**Nothing on `run.sh`'s path validates the `.xosc` against the OpenSCENARIO XSD any more.** The `scenario_runner_xosc.py` install that did is no longer what `run.sh` invokes (see above), and `/home/dellpro2/Antonio/scenario_runner` has no XSD check. The mismatch that validator caught is still in the emitter: `event_builders.py` writes `<Vertex relativeTime=...>` where the strict schema wants `time`. Its parser reads `relativeTime` (`openscenario_parser.py:1404`), so a `follow_trajectory` scenario now runs where it used to be rejected outright — do not read a clean CARLA run as evidence the file is schema-valid.

You can still validate by hand — the schema is on this box and `xmllint` is installed, and current exports do pass:

```bash
xmllint --noout --schema /home/dellpro2/Antonio/scenario_runner/srunner/openscenario/OpenSCENARIO.xsd export.xosc
```

Use a scenario **without** a `follow_trajectory` event, or the pre-existing `<Vertex relativeTime=…>` defect above is all you will see. Two other omissions were fixed on 2026-10-12 and are pinned by `test_normalization.py`'s XSD check: `DistanceCondition` now carries the required `alongRoute="false"` (every `distance_to_point` trigger, so every `cut_out` and stop-in-lane walker was invalid) and `FollowTrajectoryAction` a `<TimeReference><None/></TimeReference>`. ScenarioRunner defaults the first to `false` and never reads the second, so neither changes behaviour.

**A storyboard Act needs at least one `<ManeuverGroup>` before its `<StartTrigger>`** — the OpenSCENARIO XSD requires it, and `_inject_traffic_signals`'s fallback (`xml_builder.py`) used to create an empty `ScenarioBehavior` Act unconditionally whenever a scenario had zero NPCs and zero traffic signals. That was harmless under a parser that doesn't validate structure (an empty `ManeuverGroup` loop is a no-op), but is a hard failure under one that does, and an ego-only scenario — no NPCs at all — is now an entirely normal shape to export. Fixed by only creating that Act when there is something to put in it.

`tests/` holds four layers — backend normalization, props, templates, events, actor types, elevation, waypoints, and the Loop2Scenic benchmark cases — see `tests/README.md`:

```bash
bash run.sh 9090                 # terminal 1
bash tests/run_tests.sh          # terminal 2 (EDITOR_URL overrides the target)
```

That runs `test_normalization.py` (182 checks, no browser or server needed — the last ten build a real `.xosc` through the sibling repo to pin cross-actor event-reference resolution, `startTransition`, the hero `SpeedCondition`, the `consider_*` properties and a signal trigger at the pole's road height), then `compare_xodr_lane_graph.py` (also no browser/server/CARLA — validates `backend/lane_graph_builder.py` against the locally probed graphs (gitignored; towns without one are skipped)), then the twenty Playwright suites: props (72), prop yaw (23), templates (296), events (82), ego events (75), triggers (47), signal panel (31), actor types (260, grows with the catalogue), elevation (33), route fidelity (13: the original reversal case plus three routes checked against CARLA), undo (44), waypoints (67), generator (~1420: eight types × three seeds × three towns, plus batch, coverage and dialog checks), preview timeline (36: scrubbing, event ticks, keys, Stop/undo, the overpass layer on Town04/05/01, and the bar at 1024–1600 px), generate here (61), recipe (63), user templates (25), event timeline (17), preview lock (62: trajectory speed, Neues Szenario, per-town scenarios, preview view-only, Laden during a preview, Ablauf playhead and card highlight), actions ext (60: hidden `set_distance`, factor/continuous/self-relative speed, Rückwärts, lane-offset presets and Hin & zurück, Abstand zu Akteur, `relative_speed`, acceleration limits in export and preview, the goal latch). All but the first two drive a real browser against a real server and a real export. **Restart the editor first if you changed `../llm-scenario-gen`** — otherwise the frontend shows new catalogue data while the backend exports the old, which looks like a test bug and is not one.

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

**Without waypoints, the two actor controllers get their direction from completely different places** — and neither failure mode shows up in a speed trace. `PedestrianControl.run_step` sets `control.direction` from the actor's *spawn heading* on every tick, so a walker with only `set_speed` events walks its init `h` forever; the editor's `_roadFacingYaw` (toward the nearest **driving** lane, else the nearest lane of any type — it used to be any type, which from a shoulder or parking bay faced half of all walkers *away* from the road) is the only thing that makes a crossing a crossing, and anything that overwrites that yaw silently converts it into a walk down the carriageway. `SimpleVehicleControl.run_step` ignores heading altogether and builds its own plan from `map.get_waypoint(...).next(2.0)`, i.e. snaps to the nearest lane and drives along it regardless of facing. **`cyclist` aliases to `bike`, a vehicle**, so a `set_speed`-only cyclist can never cross; the `cyclist-crossing` template is therefore a `follow_trajectory` kerb to kerb (see "Scenario templates"). `tests/carla_cases.py` `expect_cyclist_crossing` now expects it to cross — not yet re-run in CARLA.

**A `distance_to_point` trigger's `z` is part of the radius.** ScenarioRunner evaluates `DistanceCondition` through `calculate_distance` → `location.distance(other)`, which is **3-D**. On a graded corridor a point left at the `0.2` default is not merely imprecise: on Town04's on-ramp, where the deck is 7.7–9.8 m up, the whole radius sits below the road and the condition can *never* become true. The editor derives point z on the click (`_setTriggerPoint` → `groundZAt + SPAWN_CLEARANCE.waypoint`, `frontend/js/objects.js`); a seeded case gets the same treatment from `SEED_EVENTS_JS` in `run_carla_cases.py`, which also covers route waypoints and trajectory vertices. **A case must never write a literal `z` — anywhere, including inside a trigger point.** The failure looks like a broken `entity_ref`, not a wrong height.

**A route on its own does not move an actor.** `AssignRouteAction` becomes `ChangeActorWaypoints`, which sets waypoints and nothing else, and `BasicControl._target_speed` stays `0` until a speed action lands. (`FollowTrajectoryAction` is the exception — `openscenario_parser` derives a target speed from the trajectory's `relativeTime` values.) That is usable rather than merely annoying: it is how `bench-highway-cut-in` parks a car on the on-ramp with its route already assigned and releases it on the ego's approach.

**Any actor with `events: []` gets no Act and therefore never moves under its own storyboard, the ego included** — it holds its `initial_speed`, which every case here omits, so it stays put. This reverses the older behaviour, where the same actor fell back to a `constant_speed` chain: a "parked" car in a bench case covered 226 m before that was caught. An actor that *has* events but must stay put still needs an explicit `set_speed 0` — `_parked()` in `tests/carla_cases.py`.

**Traffic lights are emittable *and* obeyed, and obeying is a per-vehicle toggle.** `AppState.trafficSignals` → `_inject_traffic_signals` emits a `TrafficSignalStateAction`, so a signal's state can be forced. Every `simple_vehicle_control` actor carries controller properties — `max_acceleration`, `max_deceleration` (per actor, see "Per-actor acceleration limits"), `consider_trafficlights`, `consider_obstacles`, `proximity_threshold 25.0` — in the NPC controller block of `xml_builder.py` and, for the hero, in `templates/car.xosc` / `pedestrian.xosc` (template text, so a restart is needed after editing it). The two `consider_*` values come from the actor's **`obey_traffic_lights` / `obey_obstacles`** (properties panel, `#obey-row`: „Ampeln beachten" / „Hindernisse beachten", hidden for walkers and props — `PedestrianControl` reads neither). **Absent means `true` in every layer** (`_normalize_actor`, `_obeys` in `xml_builder.py`, the `dumpActor` allow-list, the checkboxes), which is what every export did before the toggle, so old saves, LLM payloads and `tests/carla_cases.py` are unchanged; only a literal `False` turns one off. The hero's are rewritten in place in the template text by `_inject_ego` (`_OBEY_PROPERTIES`), after the placeholder sweep. Measured A/B in CARLA (Town05): with obstacles on an NPC stopped 10.75 m centre-to-centre behind a parked car, with them off it drove into it at 7.9 m/s; with lights on an NPC held 5 s at a forced red, with them off it crossed the stop line at 8 m/s. The preview models neither. **Two of those properties are only safe on the locally patched `simple_vehicle_control.py`** in `/home/dellpro2/Antonio/scenario_runner` (uncommitted working tree): on stock 0.9.15 `max_acceleration` collapses the ego to a crawl after its first turn and `consider_obstacles` latches a stale sensor reading and freezes the actor. Any CARLA case that relied on running a red (e.g. a turning-truck-runs-red scenario) or on actors ignoring each other was measured before this and must be re-checked.

Because of the above, `run_carla_cases.py` overrides a template-placed actor's yaw **only when the case sets `npc_yaw`**. The in-lane vehicle cases pin it to 180 (spawn-point yaw can face back up the road); the crossing cases deliberately omit it and keep what the editor computed. A blanket default there is what made all three crossing cases run parallel to the road while passing every check. `_crossed_the_road` now asserts the direction — Town01 road 1 runs due east-west, so along-the-road is world x and across is world y, and `A.lateral_offset` is the wrong tool (it projects into the actor's own frame, where a crossing reads as longitudinal).

### The Loop2Scenic benchmark suite

`tests/bench/` holds the extracted [Loop2Scenic](https://yuangao-tum.github.io/loop2scenic-bench/) index (all 250 scenarios, `extract_bench.py` + `benchmark_index.{json,csv}` + `tag_census.csv`) and **`COVERAGE.md`, which is the answer to "what can this editor actually express?"** Read it before claiming a scenario shape is or is not supported. Sixteen benchmark entries are rebuilt as `bench-*` CARLA cases; each quotes its source description verbatim and names its fidelity delta.

- The datasheet is one ~10 MB page that inlines every card. Fetch it **raw** with curl — a summarising fetcher truncates it after §1 and the whole thing then looks unavailable. No headless browser or `benchmark_drive/` download is needed.
- **Only 150 of the 250 cards carry visible text.** The image-only and video-only splits keep their annotation solely in the card's `data-search` attribute, lowercased; those rows are flagged `desc_source="data-search"`.
- **The datasheet's own two censuses disagree** — §4's table says 50 types / 301 assignments, the §9 cards say 47 / 315, and 36 types differ in count. `tag_census.csv` records both. Select by card tag, weight by §4.
- Rollup, weighted by §4 mass (**stale — needs re-deriving**): 24% of the benchmark is covered by a green case, 30% partial with a named delta, 26% expressible but not yet built, **21% not expressible**. It blamed 9 of the 11 unreachable tags on two missing capabilities, and **both have since landed**: **ego-manoeuvre authoring** (the ego takes `follow_trajectory`/`assign_route`/`set_speed`/`lane_change`/`lane_offset` events, same as an NPC — the rollup assumed *"the `.xosc` carries an ego spawn pose and nothing else, so every ego turn/swerve/exit is planner-chosen"*) and **`LaneOffsetAction`** (`lane_offset`, see its own section — lane drift and partial-lane hazards are now expressible; oncoming overtakes and parking exits may be too, but nothing has been built or run for them). The rollup percentages and every per-tag "planner-chosen" or "needs `LaneOffsetAction`" delta in `tests/bench/COVERAGE.md` predate both and have not been recomputed.

Two measurement traps the bench cases added:

- **A cross-street actor triggered at act start clears the junction before the ego arrives** (measured on Town05 junction 1863: adversary in at t=1.0 s, ego at t=5.9 s). The paths cross in space and never in time, and every speed and geometry check still passes. Trigger on `distance_to_ego` and assert `closest_approach`.
- **Distance radii need margin for the corner a turning ego cuts.** A `distance_to_ego@35` missed by 0.6 m because a left-turning ego starts its swing before the junction centre; the condition never fired, the actor waited out the 60 s `TimeFallback`, and the run looked like a hang.

`tests/` also holds CARLA measurement probes. `probe_carla_props.py` (private CARLA on 2050, `--all` for every blueprint in the build) is where the catalogue's footprints, pivot offsets and `z` lifts come from, and it reproduces ScenarioRunner's spawn-with-physics sequence; `probe_carla_mesh_dims.py` is its older, 16-prop predecessor. `probe_carla_mesh_facing.py` **is not trustworthy for `yaw_offset`** — it got several props 180° wrong. Determine rotation by running the scenario and looking at it.
