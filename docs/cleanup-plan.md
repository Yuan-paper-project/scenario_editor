# Cleanup plan

Survey of the codebase as of branch `cleanup` (from `072fe3f`). Nothing here has been changed yet; this is the to-do list for phases 4–6. Rules the cleanup works toward are in `CLAUDE.md` → "Code conventions".

Line counts are `wc -l`. The sibling repo `../llm-scenario-gen` is out of scope here.

## 1. Files over 400 lines

### Frontend JS (the main problem: 9 of the 10 biggest source files)

| File | Lines | Natural seams (from its own `// ──` section headers) |
|---|---|---|
| `frontend/js/scenarioGenerator.js` | 3286 | RNG + lane-network index + corridor (≈1–490) · the twelve scenario-type builders (492–1158) · green wave (1159–1300) · PARAMS/TYPES tables (1903–2045) · conflict check / `assess` (2045–2268) · `build`/`generate` (2268–2518) · parameter sweep (2518–2640) · batch + coverage (2640–2844) · batch dialog (2844–3012) · recipe panel (3012–3182) · header menu (3182–) |
| `frontend/js/mapView.js` | 2406 | pan/zoom + ruler · road rendering + overpass + road furniture (196–950) · actor rendering (951–1398) · undo/redo key handling (1399–1578) · path/waypoint rendering (1579–1888) · mouse, view controls, layer toggles (1897–2162) · distance ruler tool (2163–2327) |
| `frontend/js/simulate.js` | 2217 | controls DOM (103–172) · event normalisation mirror + trigger evaluation (238–426) · lane geometry + lane-graph routing (427–877) · per-actor stepping (878–1403) · reacting ego (1404–1540) · lifecycle/timeline/scrubbing (1541–) |
| `frontend/js/eventPanel.js` | 1942 | card rendering (168–492) · action controls (493–780) · summaries/labels (781–886) · after_event references (887–975) · trigger controls (976–1199) · DOM helpers/toggles (1200–1455) · path controls (1456–1711) · event state/delete sweep (1712–) |
| `frontend/js/app.js` | 1649 | `AppState` (84–577) · Toast/Confirm (578–654) · per-town park/unpark (655–715) · `UndoStack` (716–1144) · `ScenarioRules` (1145–1542) · `UIUtils` (1543–) — five separate globals in one file; the easiest split in the repo |
| `frontend/js/propCatalog.js` | 1225 | `PROPS` data table (56–473) · side-view shapes (474–821) · plan-view shapes (822–1008) · `PropCatalog` API + palette panel (1009–). Mostly data. |
| `frontend/js/objects.js` | 1071 | placement + snapping/yaw rules (88–443) · drag (444–626) · path drawing mode (627–1040) |
| `frontend/js/properties.js` | 964 | actor panel · scene list (138–681) · input bindings / type pickers / delete · traffic-signal panel (486–681) |
| `frontend/js/templates.js` | 916 | built-in template table (51–275) · user templates (276–583) · road geometry helpers (584–) |
| `frontend/js/bgTraffic.js` | 492 | keep-out building · fetch/cache · drawing |
| `frontend/css/style.css` | 1677 | split per panel/module to match the JS files |
| `frontend/index.html` | 771 | mostly markup; the inline SVG icons could move out |

### Backend Python

| File | Lines | Seams |
|---|---|---|
| `backend/map_renderer.py` | 1142 | OpenDRIVE geometry/lane maths (76–530) · road marks/polylines (531–591) · signals, signs, crosswalks (592–836) · spawn points (837–947) · render-data assembly (948–) |
| `backend/scenario_io.py` | 1018 | per-event/per-actor normalisation (34–500) · scenario-wide event-reference rules (502–620) · type/prop/signal validation (621–731) · `validate_scenario_params` + export (732–928) · batch zip (929–) |
| `backend/bg_traffic.py` | 883 | SUMO install/net (123–193) · keep-out (194–385) · trip generation and FCD I/O (386–640) · `generate` loop (680–876) |
| `backend/lane_graph_builder.py` | 634 | XML extraction (93–307) · successor resolution (308–392) · `build_lane_graph_from_xodr` (395–) |
| `backend/main.py` | 446 | just over; app setup + map routes vs export/bg-traffic routes |
| `generate_pptx.py` | 680 | slide deck, unrelated to the editor (see §4) |

### Tests (lower priority — split only where it helps)

`tests/carla_cases.py` 2378 (mostly case data), `test_normalization.py` 1302, `test_events_e2e.py` 662, `_harness.py` 631, `test_actor_types_e2e.py` 573, `test_benchmark_e2e.py` 563, `test_generator_e2e.py` 487, `test_actions_ext_e2e.py` 487, `test_templates_e2e.py` 484, `run_carla_cases.py` 474, `test_ego_events_e2e.py` 460, `test_waypoints_e2e.py` 448, `carla_analysis.py` 447.

### Over-long functions (≥ 90 lines)

Python: `scenario_io._normalize_structured_event` (259), `lane_graph_builder.build_lane_graph_from_xodr` (240), `bg_traffic.generate` (195), `map_renderer._process_root_to_render_data` (165), `scenario_io.validate_scenario_params` (124), `scenario_io._normalize_after_event_chains` (117).

JS: `propCatalog.sideShapes` (336, data), `eventPanel._appendEventTriggerControls` (219), `mapView.renderMap` (221), `propCatalog.planShapes` (166, data), `scenarioGenerator._oncomingDrift` (159), `ScenarioRules.eventProblem` (156), `scenarioGenerator._vruCrossingAt` (134), `eventPanel._renderEventList` (133), `eventPanel._appendSpeedActionControls` (116), `eventPanel._renderPathList` (116), `scenarioIO.buildScenarioParams` (116), `simulate._applyEventAction` (114), `scenarioGenerator._junctionConflict` (104), `propCatalog.renderPanel` (103), `scenarioGenerator._obstacle` (100), `simulate.runHeadless` (97), `eventPanel._renderEventActionGrid` (96), `mapView._renderRoute` (95).

## 2. Duplicated logic

Ordered by how safe the merge is. Check each pair's bodies before merging; several differ in small ways that matter.

| What | Where | Notes |
|---|---|---|
| Point-in-polygon (ray casting) | `mapView.js:441`, `templates.js:822`, inline in `scenarioGenerator.js:~180` | Byte-identical. Move to `UIUtils` (or a small `geom.js`). |
| `_wrapDeg` | `objects.js:163`, `scenarioGenerator.js:95` | Identical. |
| `_dist3` | `simulate.js:175`, `laneGraph.js:92` | Differ: `?? 0` vs `\|\| 0` (same result for numbers, differs for `NaN`). |
| HTML escaping | `app.js:602` `_escHtml`, `properties.js:69` `_esc` (DOM-based), `eventTimeline.js:46` `_esc`, `templates.js:832` `_attr`, `scenarioGenerator.js:3019` `_escHtml` (regex) | **Not equivalent**: the DOM-based two do not escape `"`, so they are unsafe in attributes. A shared helper must be the regex version. |
| `_el(tag, attrs)` SVG element builder | `aerialMap.js:220`, `propCatalog.js:468`; `mapView.js` has its own "SVG helper" (1889) | Compare signatures first. |
| Walker type sets | `mapView.js:1004` `WALKER_TYPES`, `app.js:1175` `WALKER_ACTION_TYPES`, `properties.js:172` `_isWalker` (includes `cyclist`!), `templates.js:818`, `objects.js:90` `ROAD_FACING_TYPES` (includes `cyclist`, `bicycle`) | Some differences are deliberate (CLAUDE.md, "Actor types"). Within the frontend, the pedestrian/child pair could come from one constant in `ScenarioRules`. The backend/emitter copies are cross-repo; leave them. |
| Weather presets | `weather.js:19` `PRESETS`, `scenarioGenerator.js:2645` `WEATHER_PRESETS` | CLAUDE.md says "keep the two in step". Make one the source. |
| Road `<link>` parsing | `map_renderer._get_road_link` (393), `lane_graph_builder._parse_road_links` (133) | **Not identical**: the builder casts `elementId` to `int` and defaults `contactPoint` to `'start'`. It was copied on purpose to keep the module independent. Could share a parser and keep the differences in the callers. |
| Road-mark parsing | `map_renderer._get_road_marks` / `_get_center_marks`, `lane_graph_builder._parse_lane_change_marks` / `_parse_mark_records` | Same XML read twice for different fields. Investigate before merging. |
| Nearest-point-on-lane | `objects._nearestLaneProjection` (251), `scenarioGenerator._projectOnLane` (203), `simulate._nearestPointOnDirLine` (437) | Different inputs and outputs; probably a shared segment-projection kernel underneath. Investigate. |
| Test boilerplate | 4 e2e suites (`test_props`, `test_prop_yaw`, `test_elevation`, `test_undo`) don't import `_harness` and launch the browser themselves; `seed`/`place`/`load_map`/`speed_event` helpers are redefined in several suites | Move the shared ones into `_harness.py`. |

Event/actor rules mirrored across frontend, backend and emitter (`ScenarioRules` ↔ `scenario_io.py` ↔ `event_builders.py`) are deliberate cross-layer copies, documented in CLAUDE.md. They are out of scope for this cleanup.

## 3. Dead code

Found by searching each definition's name across the frontend, `index.html`, `help.html` and the tests. No unreferenced Python function turned up.

| Symbol | Where | Evidence |
|---|---|---|
| `AppState.nearestSpawn` | `app.js:275` | no caller anywhere (placement snaps to lanes now, not spawn points) |
| `AppState.switchTypesFor` | `app.js:383` | no caller |
| `_isXodrDrag` | `mapImport.js:84` | defined, never called |
| `SpecialBuildings.forTown` | `specialBuildings.js:23` | no caller (`mapView` filters by town itself) |

Also check:

- `tests/probe_carla_mesh_dims.py`: superseded by `probe_carla_props.py` (per CLAUDE.md).
- `tests/probe_carla_mesh_facing.py`: CLAUDE.md calls it untrustworthy for `yaw_offset`.
- `Simulate.routeForTesting` and `ScenarioIO.buildParamsForTesting`: test hooks only. Keep them.

## 4. Messy areas

- **Comments.** About 25–30% of lines in the big JS files are comments (`scenarioGenerator.js` 708 of 3286, `simulate.js` 684 of 2217, `mapView.js` 584 of 2406). Many are good *why* comments. A grep for change-log wording (`used to`, `previously`, `no longer`, dates) finds ~50 lines across 14 files, led by `mapView.js` (9), `objects.js` (8), `simulate.js` (5). Phase 5 material.
- **"phase 1/2/3" in code and headers** (`// ── Batch generation (phase 2) and coverage sampling (phase 3)`, `Cached CARLA lane graph (phase 2)`). These refer to past project plans and mean nothing to a reader now.
- **Two READMEs.** `README.md` and `README_UPDATED.md` overlap. Merge them into one.
- **Presentation material in the app repo.** `generate_pptx.py` (680 lines), `frontend/presentation.html` (758), the committed `OpenSCENARIO_Editor_Praesentation.pptx`, and the `/api/presentation.pptx` route in `main.py`. Unrelated to the editor. Candidate to move to `docs/` or a separate repo (your decision).
- **`tests/` mixes four kinds of thing.** Fast tests, Playwright e2e suites, CARLA runners (`run_*_carla.py`) and one-off CARLA probes (`probe_*.py`, `capture_carla_aerial.py`) sit in one flat directory. Suggest subfolders such as `tests/e2e/`, `tests/carla/` and `tools/probes/`. This changes paths that `run_tests.sh`, `tests/README.md` and CLAUDE.md cite, so it needs its own commit.
- **`tests/carla_cases.py` and `run_carla_cases.py` are stale by their own admission** (CLAUDE.md "CARLA behavioural tests": not re-baselined, `SCENARIO_GOAL` is dead). Decide whether to re-baseline or delete.
- **CLAUDE.md is 2300 lines.** It is the main orientation document, and much of it is history ("used to…", dated measurements). It is exempt from the 400-line rule, but trimming history out of it follows the same spirit. Do this last, so it describes the cleaned code.
- **`map_renderer.py` header comment** says the colours are "matched to SafetyPool Studio dark palette". Check it is still true.

## 5. Notes for the later phases

- **Phase 2 (safety net) is mostly already there.** `bash tests/run_tests.sh` runs `test_normalization.py` (182 checks, no server), `compare_xodr_lane_graph.py`, `check_render_geometry.py` and 25 Playwright suites against a live editor. What is missing is a fast smoke run. The full run takes a long time, mostly in `test_generator_e2e.py` (~2000 checks). A `--quick` subset (normalization + render geometry + props + events + undo) would be enough to run after each split.
- **Run the e2e suites against a server without `--reload`** while editing files. See CLAUDE.md: `--reload` restarting under a running suite has wedged the server before.
- **Phase 3 (`ruff`) only covers Python**, which is about 15% of the code. The big files are JS. There is no npm or build step by design, so a JS formatter (Prettier, Biome) would be the project's first Node dependency. Decide before phase 3. Biome ships as a single binary and could run without npm.
- **`ruff format` on the backend will be a large diff.** The code uses single quotes and hand-aligned lines in places. Commit it alone, as planned. `pylint max-module-lines=400` will fail on the five big backend files until phase 4.
- **Phase 4 for JS** means: a new file per module, each an IIFE that attaches to the *existing* global (e.g. `ScenarioGenerator`), or a new global, plus an `index.html` script-order update. Suggested order, easiest and safest first: `app.js` (already five globals), `propCatalog.js` (data vs code), `scenarioGenerator.js` (UI vs generation), `mapView.js`, `simulate.js`, `eventPanel.js`.
