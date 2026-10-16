# Cleanup plan

Survey of the codebase as of branch `cleanup` (from `072fe3f`); the to-do list for phases 4–6.

**Line numbers in this file refer to the code before phase 3's formatting (commit `978f715`).** Formatting moved nearly every line; the section names (each file's `// ──` / `# ──` headers) and symbol names still find them. Current sizes after formatting are in §1's "now" column. Rules the cleanup works toward are in `CLAUDE.md` → "Code conventions".

Line counts are `wc -l`. The sibling repo `../llm-scenario-gen` is out of scope here.

## Progress (phase 4: one file per session)

| File | Status |
|---|---|
| `frontend/js/app.js` | done (`cea3aab` undo hooks, `d2da5eb` split, docs after) |
| `frontend/js/propCatalog.js` | done (`86158c7` probe fix, `d8c9f6c` `UIUtils.svgEl`, `3bffdcf` split, docs after) |
| `frontend/js/scenarioGenerator.js` | done (`f263fc8` shared `_ctx`, `ebf9889` split, docs after) |
| `frontend/js/mapView.js` | done (`907ffa0` `UIUtils.sharedScope`, `48a30c2` shared `layers`/`view`/`drag`, `02de785` split, docs after) |
| `frontend/js/simulate.js` | done (`440e1cc` shared `run`/`timeline`, `0940659` split, docs after) |
| `frontend/js/eventPanel.js` | done (`4814fec` shared `panel`, `6faaf9f` split, docs after) |
| `frontend/css/style.css` | done (`4f2bbdd` split, docs after) |
| `frontend/js/objects.js` | done (`3368fb8` shared `drag`, `496f2d5` split, `75dc7a5` smoke test stops at a missing global, docs after) |
| `frontend/js/properties.js` | done (`5ac3c27` shared `scene`, `264d244` `panel.render` hook, `25524a7` split, docs after) |
| `frontend/js/templates.js` | done (`a112e51` split, docs after) |
| `backend/map_renderer.py` | done (`24b0c44` split, docs after) |
| `backend/scenario_io.py` | done (`414b411` split, docs after) |
| `backend/bg_traffic.py`, `lane_graph_builder.py` | open |
| `frontend/js/bgTraffic.js` (561), `backend/main.py` (463) | kept, by decision: each is one cohesive module somewhat over the target; `bgTraffic.js`'s only seam (the keep-out) would not justify a shared scope, and `main.py` is a flat route list that routers would only add indirection to |

How each split was done, and the checks to repeat: propose → approve → (1) any wiring change needed to make the move possible, alone, inside the old file; (2) the move itself, by script, asserting every original line lands in exactly one new file; (3) docs. After each: `bash tools/lint.sh` (no new findings), `bash tests/run_tests.sh --quick`, and the export/generator fingerprint must be byte-identical; a deliberately wrong load order must fail `test_smoke_e2e.py`. Test against a server without `--reload` (port 9091). For a stylesheet, the fingerprint is `tools/css_fingerprint.py` (computed styles, see CLAUDE.md).

## 1. Files over 400 lines

### Frontend JS (the main problem: 9 of the 10 biggest source files)

| File | Lines before (now) | Natural seams (from its own `// ──` section headers) |
|---|---|---|
| ~~`frontend/js/scenarioGenerator.js`~~ | 3286 (3955) | **Done** — split into thirteen files over one internal global, `GeneratorCore`: `generatorCore.js` (358), `generatorCorridor.js` (358), five `generatorTypes*.js` (298–413), `generatorParams.js` (241), `generatorAssess.js` (267), `generatorBuild.js` (324), `generatorBatch.js` (407), `generatorBatchDialog.js` (216), `scenarioGenerator.js` (374, recipe panel, menu, public API). The two just over 400 are so only by their formatted import lists. Imports are detected by script and checked with Biome's `noUndeclaredVariables` (off in `biome.json`, which does not know the shared names): run `biome lint --only=correctness/noUndeclaredVariables frontend/js/generator*.js frontend/js/scenarioGenerator.js` after editing them — only `GeneratorCore` may be reported. |
| ~~`frontend/js/mapView.js`~~ | 2406 (2681) | **Done** — split into eleven files over one internal global, `MapCore` (`UIUtils.sharedScope`, the registry `GeneratorCore` now uses too): `mapCore.js` (317), `mapRoadDetail.js` (349), `mapMarkers.js` (408), `mapFeatures.js` (188), `mapTriggerPoints.js` (143), `mapPaths.js` (449), `mapRender.js` (348), `mapInput.js` (190), `mapRuler.js` (221), `mapKeys.js` (133), `mapView.js` (190, public API). `mapPaths.js` kept over 400 on purpose: route lines, the route cache and waypoint hit/marking share every helper. The keyboard handler is its own file because it calls the ruler, which must load after `mapInput.js` (capture-phase click order). Check with `biome lint --only=correctness/noUndeclaredVariables frontend/js/map*.js` — only `MapCore` may be reported. |
| ~~`frontend/js/simulate.js`~~ | 2217 (2396) | **Done** — split into nine files over one internal global, `SimCore` (`UIUtils.sharedScope`): `simCore.js` (206), `simEvents.js` (215), `simLanes.js` (275), `simRoute.js` (269), `simActions.js` (371), `simMotion.js` (363), `simTimeline.js` (368), `simPlayback.js` (310), `simulate.js` (288, `routeGeometry` / `authoredPose` / `runHeadless` and the public `Simulate`). Check with `biome lint --only=correctness/noUndeclaredVariables frontend/js/sim*.js` — only `SimCore` may be reported. |
| ~~`frontend/js/eventPanel.js`~~ | 1942 (2007) | **Done** — split into nine files over one internal global, `EventPanelCore` (`UIUtils.sharedScope`): `eventPanelCore.js` (239), `eventPanelWidgets.js` (239), `eventPanelSummary.js` (168), `eventPanelChains.js` (298), `eventPanelActions.js` (375), `eventPanelTriggers.js` (276), `eventPanelPaths.js` (248), `eventPanelCards.js` (285), `eventPanel.js` (158, render, the action grid, public API). Check with `biome lint --only=correctness/noUndeclaredVariables frontend/js/eventPanel*.js` — only `EventPanelCore` may be reported. Still open: three doc comments are stacked above `_isChainTarget` in `eventPanelChains.js` (one each for `_repointForeignReferences`, `_canChainOnto`, `_isChainTarget`) and belong over their own functions. |
| ~~`frontend/js/app.js`~~ | 1649 (1767) | **Done** — split into `appState.js` (624), `dialogs.js` (99), `undo.js` (467), `scenarioRules.js` (419), `uiUtils.js` (189). `appState.js` kept over 400 on purpose: `AppState` is one object, and its only clean seam (the save-file code) would need the object assembled from two files and the private id counter exposed. |
| ~~`frontend/js/propCatalog.js`~~ | 1225 (1856) | **Done** — split into `propData.js` (768, data, exempt), `propSideShapes.js` (528), `propPlanShapes.js` (314), `propCatalog.js` (266). `propSideShapes.js` kept over 400 on purpose: it is one `switch` with a `case` per silhouette, and any cut would be at an arbitrary `case`. |
| ~~`frontend/js/objects.js`~~ | 1071 (1130) | **Done** — split into five files over one internal global, `ObjectsCore` (`UIUtils.sharedScope`): `objectsCore.js` (349, lane projection, snaps, ground height, placement yaw, path accessors), `objectsPaths.js` (254, draw mode), `objectsPathEdit.js` (205, trigger points and waypoint edits), `objectsDrag.js` (213), `objects.js` (240, map click, placement, public `ObjectsManager`). Check with `biome lint --only=correctness/noUndeclaredVariables frontend/js/objects*.js` — only `ObjectsCore` may be reported. |
| ~~`frontend/js/properties.js`~~ | 964 (995) | **Done** — split into four files over one internal global, `PropertiesCore` (`UIUtils.sharedScope`): `propertiesCore.js` (shared elements, scene-list state, `panel.render`, collapsible headers), `propertiesOverview.js` (no-selection panel and scene list), `propertiesSignal.js` (traffic-light panel), `properties.js` (render, bindings, type pickers, delete, subscriptions). `properties.js` is just over 400 only by its import list. Check with `biome lint --only=correctness/noUndeclaredVariables frontend/js/properties*.js` — only `PropertiesCore` may be reported. |
| ~~`frontend/js/templates.js`~~ | 916 (1018) | **Done** — split into a chain of four classes over one internal global, `TemplatesCore` (`UIUtils.sharedScope`): `templatesTable.js` (constants, built-in table, event factories), `templatesGeometry.js` (crossing profile and builders), `templatesUser.js` („Eigene Vorlagen" and the relative transform), `templates.js` (panel, placement, public `ScenarioTemplates`). Check with `biome lint --only=correctness/noUndeclaredVariables frontend/js/templates*.js` — only `TemplatesCore` may be reported. |
| `frontend/js/bgTraffic.js` | 492 (561) | keep-out building · fetch/cache · drawing |
| ~~`frontend/css/style.css`~~ | 1677 (3820) | **Done** — split into fourteen stylesheets, loaded in the old file's rule order: `base.css` (67), `header.css` (335), `generator.css` (300), `map.css` (410), `toolbar.css` (197), `properties.css` (364), `eventCards.css` (341), `eventRows.css` (197), `environment.css` (166), `mapMarkers.css` (305), `dialogs.css` (210), `overview.css` (356), `preview.css` (391), `help.css` (198). Stragglers appended at the end of the old file went to their area; every flipped rule pair was checked for a shared property on overlapping selectors, and the one real one (`.menu-btn`'s `display`) settled by keeping buttons with the menus. Verified by diffing `getComputedStyle` of every element over 16 editor states: 0 differences, 34 with `eventRows.css` loaded before `eventCards.css`. `map.css` is 410 only by its header line. |
| `frontend/index.html` | 771 (771) | mostly markup; the inline SVG icons could move out |

### Backend Python

| File | Lines before (now) | Seams |
|---|---|---|
| ~~`backend/map_renderer.py`~~ | 1142 (1183) | **Done** — split into `xodr_geometry.py` (263, reference-line maths: offsets, elevation, sampling, lateral points, `_eval_geometry_at_s`), `xodr_lanes.py` (332, lane sections, widths, centres, polygons, road marks), `xodr_features.py` (226, lights, signs, crosswalks), `spawn_points.py` (139, with the `_LLMGEN` lookup only it uses), `map_renderer.py` (291, path scans, colours, `_process_root_to_render_data`, public API). Imports only go downward in that order. No re-exports: `lane_graph_builder.py` imports from `xodr_lanes`. Verified by hashing every town's render JSON and xodr-derived lane graph directly (`build_lane_graph_from_xodr` on all towns, since the API serves probed graphs for most) plus the browser fingerprint. `_process_root_to_render_data` (169 lines) moved whole. |
| ~~`backend/scenario_io.py`~~ | 1018 (1027) | **Done** — split into `event_rules.py` (260: the type/trigger whitelists, `ROUTE_STRATEGIES`, `_entity_ref`, `_never_completes`, `_normalize_after_event_chains`), `event_normalize.py` (364: `_normalize_waypoints`, `_normalize_structured_event`, `_normalize_actor`), `batch_export.py` (95), `scenario_io.py` (328: `_LLMGEN`, type/prop/signal checks, `validate_scenario_params`, both exports). `_entity_ref` went to the rules rather than with its only caller to keep `event_normalize.py` under 400 — it is a rule in its own right (a dangling or self ref is a 400). The batch zip was checked separately (old vs new `export_batch_zip` on a real 5-entry batch with one failing entry): identical. |
| `backend/bg_traffic.py` | 883 (1045) | SUMO install/net (123–193) · keep-out (194–385) · trip generation and FCD I/O (386–640) · `generate` loop (680–876) |
| `backend/lane_graph_builder.py` | 634 (701) | XML extraction (93–307) · successor resolution (308–392) · `build_lane_graph_from_xodr` (395–) |
| `backend/main.py` | 446 (463) | just over; app setup + map routes vs export/bg-traffic routes |
| `generate_pptx.py` | 680 (917) | slide deck, unrelated to the editor (see §4) |

### Tests (lower priority — split only where it helps)

`tests/carla_cases.py` 2378 (mostly case data), `test_normalization.py` 1302, `test_events_e2e.py` 662, `_harness.py` 631, `test_actor_types_e2e.py` 573, `test_benchmark_e2e.py` 563, `test_generator_e2e.py` 487, `test_actions_ext_e2e.py` 487, `test_templates_e2e.py` 484, `run_carla_cases.py` 474, `test_ego_events_e2e.py` 460, `test_waypoints_e2e.py` 448, `carla_analysis.py` 447.

### Over-long functions (≥ 90 lines)

Python: `event_normalize._normalize_structured_event` (259), `lane_graph_builder.build_lane_graph_from_xodr` (240), `bg_traffic.generate` (195), `map_renderer._process_root_to_render_data` (169), `scenario_io.validate_scenario_params` (124), `event_rules._normalize_after_event_chains` (117).

JS: `propSideShapes.sideShapes` (336, data), `eventPanelTriggers._appendEventTriggerControls` (219), `mapRender.renderMap` (221), `propPlanShapes.planShapes` (166, data), `generatorTypesObstacle._oncomingDrift` (159), `ScenarioRules.eventProblem` (156), `generatorTypesVru._vruCrossingAt` (134), `eventPanelCards._renderEventList` (133), `eventPanelActions._appendSpeedActionControls` (116), `eventPanelPaths._renderPathList` (116), `scenarioIO.buildScenarioParams` (116), `simActions._applyEventAction` (114), `generatorTypesJunction._junctionConflict` (104), `propCatalog.renderPanel` (103), `generatorTypesObstacle._obstacle` (100), `simulate.runHeadless` (97), `eventPanel._renderEventActionGrid` (96), `mapPaths._renderRoute` (95).

## 2. Duplicated logic

Ordered by how safe the merge is. Check each pair's bodies before merging; several differ in small ways that matter.

| What | Where | Notes |
|---|---|---|
| Point-in-polygon (ray casting) | `mapRoadDetail.js` `_pointInPoly`, `templates.js:822`, `generatorCore.js` `_inPoly` | Byte-identical. Move to `UIUtils` (or a small `geom.js`). |
| `_wrapDeg` | `objects.js:163`, `generatorCore.js` `_wrapDeg` | Identical. |
| `_dist3` | `simCore.js` `_dist3`, `laneGraph.js:92` | Differ: `?? 0` vs `\|\| 0` (same result for numbers, differs for `NaN`). |
| HTML escaping | `dialogs.js` `_escHtml`, `properties.js:69` `_esc` (DOM-based), `eventTimeline.js:46` `_esc`, `templates.js:832` `_attr`, `scenarioGenerator.js` `_escHtml` (regex) | **Not equivalent**: the DOM-based two do not escape `"`, so they are unsafe in attributes. A shared helper must be the regex version. |
| `_el(tag, attrs)` SVG element builder | `aerialMap.js:238`; the prop and map files use `UIUtils.svgEl` | Same behaviour (`for…in` vs `Object.entries` over plain objects). Point `aerialMap.js` at `UIUtils.svgEl`. |
| Walker type sets | `mapMarkers.js` `WALKER_TYPES`, `scenarioRules.js` `WALKER_ACTION_TYPES`, `properties.js:172` `_isWalker` (includes `cyclist`!), `templates.js:818`, `objects.js:90` `ROAD_FACING_TYPES` (includes `cyclist`, `bicycle`) | Some differences are deliberate (CLAUDE.md, "Actor types"). Within the frontend, the pedestrian/child pair could come from one constant in `ScenarioRules`. The backend/emitter copies are cross-repo; leave them. |
| Weather presets | `weather.js:19` `PRESETS`, `generatorBatch.js` `WEATHER_PRESETS` | CLAUDE.md says "keep the two in step". Make one the source. |
| Road `<link>` parsing | `xodr_lanes._get_road_link`, `lane_graph_builder._parse_road_links` (133) | **Not identical**: the builder casts `elementId` to `int` and defaults `contactPoint` to `'start'`. It was copied on purpose to keep the module independent. Could share a parser and keep the differences in the callers. |
| Road-mark parsing | `xodr_lanes._get_road_marks` / `_get_center_marks`, `lane_graph_builder._parse_lane_change_marks` / `_parse_mark_records` | Same XML read twice for different fields. Investigate before merging. |
| Nearest-point-on-lane | `objects._nearestLaneProjection` (251), `generatorCore._projectOnLane`, `simLanes._nearestPointOnDirLine` | Different inputs and outputs; probably a shared segment-projection kernel underneath. Investigate. |
| Test boilerplate | 4 e2e suites (`test_props`, `test_prop_yaw`, `test_elevation`, `test_undo`) don't import `_harness` and launch the browser themselves; `seed`/`place`/`load_map`/`speed_event` helpers are redefined in several suites | Move the shared ones into `_harness.py`. |

Event/actor rules mirrored across frontend, backend and emitter (`ScenarioRules` ↔ `event_rules.py` / `event_normalize.py` ↔ `event_builders.py`) are deliberate cross-layer copies, documented in CLAUDE.md. They are out of scope for this cleanup.

## 3. Dead code

Found by searching each definition's name across the frontend, `index.html`, `help.html` and the tests. No unreferenced Python function turned up.

| Symbol | Where | Evidence |
|---|---|---|
| `AppState.nearestSpawn` | `appState.js` | no caller anywhere (placement snaps to lanes now, not spawn points) |
| `AppState.switchTypesFor` | `appState.js` | no caller |
| `_isXodrDrag` | `mapImport.js:84` | defined, never called |
| `SpecialBuildings.forTown` | `specialBuildings.js:23` | no caller (`mapFeatures.js` filters by town itself) |
| `_overpassCount` | `mapRender.js` (`renderMap`) | assigned, never read |

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

- **Phase 2 is done.** `bash tests/run_tests.sh --quick` (~40 s: normalization, render geometry, `test_smoke_e2e.py`, events, undo) is the check to run after each split. `test_smoke_e2e.py` was shown to fail by name when a script throws at load.
- **Lint baseline at the end of phase 2** (`bash tools/lint.sh`): ruff format would reformat 55 of 62 Python files; ruff check 124 findings (mostly fixable: import order, unused imports, `raise … from`); pylint 19 modules over 400 lines, 14 functions over 60 statements, 8 over 15 branches; Biome would reformat all 24 frontend files and reports 44 errors / 101 warnings (most of them formatting, gone after phase 3). Of the Biome findings worth a look in phase 6: the duplicate `actorColor` key (above), 15 `useIterableCallbackReturn`, 2 `noAssignInExpressions` (both deliberate, in the seeded RNG), a sparse array literal in `scenarioGenerator.js` (`recipeHtml`). The duplicate `stroke-width` in `style.css:1029` is a deliberate fallback.
- **Run the e2e suites against a server without `--reload`** while editing files. See CLAUDE.md: `--reload` restarting under a running suite has wedged the server before.
- **Phase 3 is done** in four commits: `ruff format`, ruff's safe fixes, Biome format, Biome's safe fixes. Each was checked with `--quick` plus a fingerprint script that hashes every town's render JSON and lane graph and the export payload and `.xosc` of the example file and 12 generated scenarios (17 distinct files): byte-identical after every step. Formatting `style.css` was checked by screenshotting four editor states with the old and new stylesheet: pixel-identical.
- **Formatting made files longer.** Biome puts one property per line, so `style.css` went from 1677 to 3820 lines and the prop table in `propCatalog.js` from one line per prop to five. Neither can be configured away. Splitting will absorb most of it: CSS per panel, and the `PROPS` table into a data file of its own.
- **Lint after phase 3** (`bash tools/lint.sh`, formatting clean): ruff 32 findings needing judgement (17 `E702` semicolon statements, 11 `B904` `raise … from`, unused variables/loop variables, `E731` lambdas). Pylint: 20 modules over 400 lines, 14 functions over 60 statements, 8 over 15 branches, 3 too deeply nested, 4 duplicate-code blocks. Biome: 20 errors / 64 warnings — 59 `useOptionalChain` (an unsafe fix, so by hand), 15 `useIterableCallbackReturn`, 4 unused variables, plus the duplicate key, the sparse array and the two deliberate assignments in expressions noted above.
- **`ruff format` will be a large diff** (hand-aligned lines; quotes are preserved by config). Commit it alone, as planned. `pylint max-module-lines=400` will fail on the five big backend files until phase 4.
- **Phase 4 for JS** means: a new file per module, each an IIFE that attaches to the *existing* global (e.g. `ScenarioGenerator`), or a new global, plus an `index.html` script-order update. The order is the Progress table at the top.
