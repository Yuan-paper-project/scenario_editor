# Cleanup plan

Survey of the codebase as of branch `cleanup` (from `072fe3f`); the to-do list for phases 4–6.

**Line numbers in this file refer to the code before phase 3's formatting (commit `978f715`).** Formatting moved nearly every line; the section names (each file's `// ──` / `# ──` headers) and symbol names still find them. Current sizes after formatting are in §1's "now" column. Rules the cleanup works toward are in `CLAUDE.md` → "Code conventions".

Line counts are `wc -l`. The sibling repo `../llm-scenario-gen` is out of scope here.

## Progress (phase 4: one file per session)

| File | Status |
|---|---|
| `frontend/js/app.js` | done (`cea3aab` undo hooks, `d2da5eb` split, docs after) |
| `frontend/js/props/propCatalog.js` | done (`86158c7` probe fix, `d8c9f6c` `UIUtils.svgEl`, `3bffdcf` split, docs after) |
| `frontend/js/generator/scenarioGenerator.js` | done (`f263fc8` shared `_ctx`, `ebf9889` split, docs after) |
| `frontend/js/map/mapView.js` | done (`907ffa0` `UIUtils.sharedScope`, `48a30c2` shared `layers`/`view`/`drag`, `02de785` split, docs after) |
| `frontend/js/sim/simulate.js` | done (`440e1cc` shared `run`/`timeline`, `0940659` split, docs after) |
| `frontend/js/events/eventPanel.js` | done (`4814fec` shared `panel`, `6faaf9f` split, docs after) |
| `frontend/css/style.css` | done (`4f2bbdd` split, docs after) |
| `frontend/js/objects/objects.js` | done (`3368fb8` shared `drag`, `496f2d5` split, `75dc7a5` smoke test stops at a missing global, docs after) |
| `frontend/js/properties/properties.js` | done (`5ac3c27` shared `scene`, `264d244` `panel.render` hook, `25524a7` split, docs after) |
| `frontend/js/templates/templates.js` | done (`a112e51` split, docs after) |
| `backend/xodr/map_renderer.py` | done (`24b0c44` split, docs after) |
| `backend/scenario/scenario_io.py` | done (`414b411` split, docs after) |
| `backend/traffic/bg_traffic.py` | done (`76bcd3c` split, docs after) |
| `backend/lane_graph/lane_graph_builder.py` | done (`66c3fa9` split, docs after) |
| `frontend/js/` folders | done (`7abe0ab` move, docs after): nine group folders, file names unchanged |
| `backend/` packages | done (`12110a3` move, docs after): `xodr/`, `lane_graph/`, `traffic/`, `scenario/`, module names unchanged |
| `tests/` folders | done (`eb6cd79` move, docs after): `tests/e2e/`, `tests/carla/`, `tools/probes/` |
| `frontend/js/bgTraffic.js` (561), `backend/main.py` (463) | kept, by decision: each is one cohesive module somewhat over the target; `bgTraffic.js`'s only seam (the keep-out) would not justify a shared scope, and `main.py` is a flat route list that routers would only add indirection to |

How each split was done, and the checks to repeat: propose → approve → (1) any wiring change needed to make the move possible, alone, inside the old file; (2) the move itself, by script, asserting every original line lands in exactly one new file; (3) docs. After each: `bash tools/lint.sh` (no new findings), `bash tests/run_tests.sh --quick`, and the export/generator fingerprint must be byte-identical; a deliberately wrong load order must fail `test_smoke_e2e.py`. Test against a server without `--reload` (port 9091). For a stylesheet, the fingerprint is `tools/css_fingerprint.py` (computed styles, see CLAUDE.md).

## 1. Files over 400 lines

### Frontend JS (the main problem: 9 of the 10 biggest source files)

| File | Lines before (now) | Natural seams (from its own `// ──` section headers) |
|---|---|---|
| ~~`frontend/js/generator/scenarioGenerator.js`~~ | 3286 (3955) | **Done** — split into thirteen files over one internal global, `GeneratorCore`: `generatorCore.js` (358), `generatorCorridor.js` (358), five `generatorTypes*.js` (298–413), `generatorParams.js` (241), `generatorAssess.js` (267), `generatorBuild.js` (324), `generatorBatch.js` (407), `generatorBatchDialog.js` (216), `scenarioGenerator.js` (374, recipe panel, menu, public API). The two just over 400 are so only by their formatted import lists. Imports are detected by script and checked with Biome's `noUndeclaredVariables` (off in `biome.json`, which does not know the shared names): run `biome lint --only=correctness/noUndeclaredVariables frontend/js/generator/*.js frontend/js/generator/scenarioGenerator.js` after editing them — only `GeneratorCore` may be reported. |
| ~~`frontend/js/map/mapView.js`~~ | 2406 (2681) | **Done** — split into eleven files over one internal global, `MapCore` (`UIUtils.sharedScope`, the registry `GeneratorCore` now uses too): `mapCore.js` (317), `mapRoadDetail.js` (349), `mapMarkers.js` (408), `mapFeatures.js` (188), `mapTriggerPoints.js` (143), `mapPaths.js` (449), `mapRender.js` (348), `mapInput.js` (190), `mapRuler.js` (221), `mapKeys.js` (133), `mapView.js` (190, public API). `mapPaths.js` kept over 400 on purpose: route lines, the route cache and waypoint hit/marking share every helper. The keyboard handler is its own file because it calls the ruler, which must load after `mapInput.js` (capture-phase click order). Check with `biome lint --only=correctness/noUndeclaredVariables frontend/js/map/map*.js` — only `MapCore` may be reported. |
| ~~`frontend/js/sim/simulate.js`~~ | 2217 (2396) | **Done** — split into nine files over one internal global, `SimCore` (`UIUtils.sharedScope`): `simCore.js` (206), `simEvents.js` (215), `simLanes.js` (275), `simRoute.js` (269), `simActions.js` (371), `simMotion.js` (363), `simTimeline.js` (368), `simPlayback.js` (310), `simulate.js` (288, `routeGeometry` / `authoredPose` / `runHeadless` and the public `Simulate`). Check with `biome lint --only=correctness/noUndeclaredVariables frontend/js/sim/sim*.js` — only `SimCore` may be reported. |
| ~~`frontend/js/events/eventPanel.js`~~ | 1942 (2007) | **Done** — split into nine files over one internal global, `EventPanelCore` (`UIUtils.sharedScope`): `eventPanelCore.js` (239), `eventPanelWidgets.js` (239), `eventPanelSummary.js` (168), `eventPanelChains.js` (298), `eventPanelActions.js` (375), `eventPanelTriggers.js` (276), `eventPanelPaths.js` (248), `eventPanelCards.js` (285), `eventPanel.js` (158, render, the action grid, public API). Check with `biome lint --only=correctness/noUndeclaredVariables frontend/js/events/*.js` — only `EventPanelCore` may be reported. The three doc comments once stacked above `_isChainTarget` now sit over their own functions. |
| ~~`frontend/js/app.js`~~ | 1649 (1767) | **Done** — split into `appState.js` (624), `dialogs.js` (99), `undo.js` (467), `scenarioRules.js` (419), `uiUtils.js` (189). `appState.js` kept over 400 on purpose: `AppState` is one object, and its only clean seam (the save-file code) would need the object assembled from two files and the private id counter exposed. |
| ~~`frontend/js/props/propCatalog.js`~~ | 1225 (1856) | **Done** — split into `propData.js` (768, data, exempt), `propSideShapes.js` (528), `propPlanShapes.js` (314), `propCatalog.js` (266). `propSideShapes.js` kept over 400 on purpose: it is one `switch` with a `case` per silhouette, and any cut would be at an arbitrary `case`. |
| ~~`frontend/js/objects/objects.js`~~ | 1071 (1130) | **Done** — split into five files over one internal global, `ObjectsCore` (`UIUtils.sharedScope`): `objectsCore.js` (349, lane projection, snaps, ground height, placement yaw, path accessors), `objectsPaths.js` (254, draw mode), `objectsPathEdit.js` (205, trigger points and waypoint edits), `objectsDrag.js` (213), `objects.js` (240, map click, placement, public `ObjectsManager`). Check with `biome lint --only=correctness/noUndeclaredVariables frontend/js/objects/*.js` — only `ObjectsCore` may be reported. |
| ~~`frontend/js/properties/properties.js`~~ | 964 (995) | **Done** — split into four files over one internal global, `PropertiesCore` (`UIUtils.sharedScope`): `propertiesCore.js` (shared elements, scene-list state, `panel.render`, collapsible headers), `propertiesOverview.js` (no-selection panel and scene list), `propertiesSignal.js` (traffic-light panel), `properties.js` (render, bindings, type pickers, delete, subscriptions). `properties.js` is just over 400 only by its import list. Check with `biome lint --only=correctness/noUndeclaredVariables frontend/js/properties/*.js` — only `PropertiesCore` may be reported. |
| ~~`frontend/js/templates/templates.js`~~ | 916 (1018) | **Done** — split into a chain of four classes over one internal global, `TemplatesCore` (`UIUtils.sharedScope`): `templatesTable.js` (constants, built-in table, event factories), `templatesGeometry.js` (crossing profile and builders), `templatesUser.js` („Eigene Vorlagen" and the relative transform), `templates.js` (panel, placement, public `ScenarioTemplates`). Check with `biome lint --only=correctness/noUndeclaredVariables frontend/js/templates/*.js` — only `TemplatesCore` may be reported. |
| ~~`frontend/js/bgTraffic.js`~~ | 492 (561) | **Kept by decision** — one cohesive module; its only real seam (the keep-out) would not justify a shared scope. |
| ~~`frontend/css/style.css`~~ | 1677 (3820) | **Done** — split into fourteen stylesheets, loaded in the old file's rule order: `base.css` (67), `header.css` (335), `generator.css` (300), `map.css` (410), `toolbar.css` (197), `properties.css` (364), `eventCards.css` (341), `eventRows.css` (197), `environment.css` (166), `mapMarkers.css` (305), `dialogs.css` (210), `overview.css` (356), `preview.css` (391), `help.css` (198). Stragglers appended at the end of the old file went to their area; every flipped rule pair was checked for a shared property on overlapping selectors, and the one real one (`.menu-btn`'s `display`) settled by keeping buttons with the menus. Verified by diffing `getComputedStyle` of every element over 16 editor states: 0 differences, 34 with `eventRows.css` loaded before `eventCards.css`. `map.css` is 410 only by its header line. |
| `frontend/index.html` | 771 (771) | mostly markup; the inline SVG icons could move out |

### Backend Python

| File | Lines before (now) | Seams |
|---|---|---|
| ~~`backend/xodr/map_renderer.py`~~ | 1142 (1183) | **Done** — split into `xodr_geometry.py` (263, reference-line maths: offsets, elevation, sampling, lateral points, `_eval_geometry_at_s`), `xodr_lanes.py` (332, lane sections, widths, centres, polygons, road marks), `xodr_features.py` (226, lights, signs, crosswalks), `spawn_points.py` (139, with the `_LLMGEN` lookup only it uses), `map_renderer.py` (291, path scans, colours, `_process_root_to_render_data`, public API). Imports only go downward in that order. No re-exports: `lane_graph_builder.py` imports from `xodr_lanes`. Verified by hashing every town's render JSON and xodr-derived lane graph directly (`build_lane_graph_from_xodr` on all towns, since the API serves probed graphs for most) plus the browser fingerprint. `_process_root_to_render_data` (169 lines) moved whole. |
| ~~`backend/scenario/scenario_io.py`~~ | 1018 (1027) | **Done** — split into `event_rules.py` (260: the type/trigger whitelists, `ROUTE_STRATEGIES`, `_entity_ref`, `_never_completes`, `_normalize_after_event_chains`), `event_normalize.py` (364: `_normalize_waypoints`, `_normalize_structured_event`, `_normalize_actor`), `batch_export.py` (95), `scenario_io.py` (328: `_LLMGEN`, type/prop/signal checks, `validate_scenario_params`, both exports). `_entity_ref` went to the rules rather than with its only caller to keep `event_normalize.py` under 400 — it is a rule in its own right (a dangling or self ref is a 400). The batch zip was checked separately (old vs new `export_batch_zip` on a real 5-entry batch with one failing entry): identical. |
| ~~`backend/traffic/bg_traffic.py`~~ | 883 (1045) | **Done** — split into `bg_sumo.py` (261: install, net, sumolib, `_simulate`, FCD, vtypes/blueprints, `BgTrafficError`, the window constants `WARMUP_S`/`DURATION_S`/`STEP_S`), `bg_keepout.py` (181), `bg_trips.py` (249, with `BUBBLE_INSERT_CLEAR_M`), `bg_traffic.py` (404: docstring, tunables, cache, `normalize_request`, `generate`). `bg_traffic.py` is over 400 only by its formatted import lists; the real remaining bulk is `generate` (238 lines), phase-5 material. Verified by running `generate` from the old module (git) and the new ones on the same two editor requests (bubble, whole map): identical. |
| ~~`backend/lane_graph/lane_graph_builder.py`~~ | 634 (701) | **Done** — split into `xodr_links.py` (194, lane/road/junction links and lane-change marks), `lane_graph_parts.py` (153, `_carla_round`, `_UnionFind`, `_carla_path`, successor and left/right resolution), `lane_graph_builder.py` (378, docstring, constants, `build_lane_graph_from_xodr` — 295 lines on its own, phase-5 material). Every town's xodr-derived graph byte-identical. |
| ~~`backend/main.py`~~ | 446 (394) | **Kept by decision** — a flat list of routes with no shared state; FastAPI routers would add indirection. Under 400 since the `/api/presentation.pptx` route went (phase 6). |
| ~~`generate_pptx.py`~~ | 680 (917) | **Moved** to `docs/presentation/` (phase 6), no longer linted. |

### Tests (lower priority — split only where it helps)

`test_normalization.py` 1302, `test_events_e2e.py` 662, `_harness.py` 631, `test_actor_types_e2e.py` 573, `test_benchmark_e2e.py` 563, `test_generator_e2e.py` 487, `test_actions_ext_e2e.py` 487, `test_templates_e2e.py` 484, `test_ego_events_e2e.py` 460, `test_waypoints_e2e.py` 448, `carla_analysis.py` 447.

### Over-long functions (≥ 90 lines)

Python — **done** (phase 5, step 4). Split, each checked byte-identical on real output: `build_lane_graph_from_xodr` into its stages (all nine towns' graphs), `_process_root_to_render_data` (`_lane_entry`, `_road_centreline`; all nine towns' render JSON), `bg_traffic.generate` (`_trip_edges`, `_vet_tracks`, `_vehicle_entries`; four captured requests). Kept whole on purpose and marked with an inline `pylint: disable` and its reason: `_normalize_structured_event` (a flat list of per-field clamps), `validate_scenario_params` and `_normalize_after_event_chains` (ordered rules), and `generate`'s round loop (shared state across rounds). `max-nested-blocks` is 6 (three XML walks sat at exactly 6). Pylint no longer runs on `tests/` — suites are long check sequences by design — and now runs `--recursive`, since without it `tools/` (no `__init__.py`) was never checked. Since phase 6 it reports nothing.

JS: not measured by any tool; most are render functions building one panel. Left alone unless one gets in the way.

Measured at the start, for reference — `propSideShapes.sideShapes` (336, data), `eventPanelTriggers._appendEventTriggerControls` (219), `mapRender.renderMap` (221), `propPlanShapes.planShapes` (166, data), `generatorTypesObstacle._oncomingDrift` (159), `ScenarioRules.eventProblem` (156), `generatorTypesVru._vruCrossingAt` (134), `eventPanelCards._renderEventList` (133), `eventPanelActions._appendSpeedActionControls` (116), `eventPanelPaths._renderPathList` (116), `scenarioIO.buildScenarioParams` (116), `simActions._applyEventAction` (114), `generatorTypesJunction._junctionConflict` (104), `propCatalog.renderPanel` (103), `generatorTypesObstacle._obstacle` (100), `simulate.runHeadless` (97), `eventPanel._renderEventActionGrid` (96), `mapPaths._renderRoute` (95).

## 2. Duplicated logic

Ordered by how safe the merge is. Check each pair's bodies before merging; several differ in small ways that matter.

| What | Where | Notes |
|---|---|---|
| ~~Point-in-polygon (ray casting)~~ | | **Done**: `UIUtils.pointInPoly`. |
| ~~`_wrapDeg`~~ | | **Done**: `UIUtils.wrapDeg`. |
| ~~`_dist3`~~ | | **Done**: `UIUtils.dist3` (`?? 0`). |
| ~~HTML escaping~~ | | **Done**: `UIUtils.escapeHtml`, the regex version, replacing all five. |
| ~~`_el(tag, attrs)` SVG element builder~~ | | **Done**: `aerialMap.js` uses `UIUtils.svgEl`. |
| Walker type sets | `mapMarkers.js` `WALKER_TYPES`, `scenarioRules.js` `WALKER_ACTION_TYPES`, `properties.js:172` `_isWalker` (includes `cyclist`!), `templates.js:818`, `objects.js:90` `ROAD_FACING_TYPES` (includes `cyclist`, `bicycle`) | Some differences are deliberate (CLAUDE.md, "Actor types"). Within the frontend, the pedestrian/child pair could come from one constant in `ScenarioRules`. The backend/emitter copies are cross-repo; leave them. |
| ~~Weather presets~~ | | **Done**: `AppState.WEATHER_PRESETS`, read by `weather.js` and `generatorBatch.js`. |
| Road `<link>` parsing | `xodr_lanes._get_road_link`, `xodr_links._parse_road_links` | **Not identical**: the builder casts `elementId` to `int` and defaults `contactPoint` to `'start'`. It was copied on purpose to keep the module independent. Could share a parser and keep the differences in the callers. |
| Road-mark parsing | `xodr_lanes._get_road_marks` / `_get_center_marks`, `xodr_links._parse_lane_change_marks` / `_parse_mark_records` | Same XML read twice for different fields. Investigate before merging. |
| Nearest-point-on-lane | `objects._nearestLaneProjection` (251), `generatorCore._projectOnLane`, `simLanes._nearestPointOnDirLine` | Different inputs and outputs; probably a shared segment-projection kernel underneath. Investigate. |
| ~~Test boilerplate~~ | | **Done** as far as it goes: every suite uses `Checks`, `select_map` and `world_to_screen` from `_harness`, and `speed_event` lives there. Left in the suites on purpose: the four older suites' browser setup (an init script before load, a JS-error check before any map, `pageerror`-only listening — `open_editor` would change what they test), `seed` (a different signature in each of five suites) and `place` (screen vs world coordinates, a Shift variant). Moving `load_map` exposed a `select_map` bug: it trusted `AppState.map`, which `loadJSON` sets without fetching the geometry, so it skipped the load; it now checks `mapData.town`. |

Event/actor rules mirrored across frontend, backend and emitter (`ScenarioRules` ↔ `event_rules.py` / `event_normalize.py` ↔ `event_builders.py`) are deliberate cross-layer copies, documented in CLAUDE.md. They are out of scope for this cleanup.

## 3. Dead code

**Done** (phase 5, step 1): `AppState.nearestSpawn`, `AppState.switchTypesFor`, `_isXodrDrag`, `SpecialBuildings.forTown` and `_overpassCount` deleted, and the two superseded probes `probe_carla_mesh_dims.py` / `probe_carla_mesh_facing.py`. `Simulate.routeForTesting` and `ScenarioIO.buildParamsForTesting` are test hooks and stay.

## 4. Messy areas

- ~~**Comments.**~~ **Done** (phase 5, step 2, seven commits listed in `.git-blame-ignore-revs`): every comment and docstring in `frontend/js`, `backend` and `tools/*.py` cut to its reason, restatements and change-log wording removed, and the stale ones corrected (lane_offset modes, continuous follow, the fixed storyboardElementRef defect, physics-off puppets, the lane graph's two sources). Frontend JS went from 4,359 comment lines to roughly 1,700. Checked by stripping comments (and Python docstrings) from old and new and requiring the code to be identical, plus a scan for trailing comments cut mid-sentence. Tests, CSS and `tools/probes/` were left out.
- ~~**"phase 1/2/3" in code and headers.**~~ Done with the comments.
- ~~**Two READMEs.**~~ **Done** (phase 6): one `README.md`, rewritten for the current editor — both old ones described a flat `backend/`, an ego trajectory field and a trigger-blind preview.
- ~~**Presentation material in the app repo.**~~ **Done** (phase 6): the route is gone and the script, `presentation.html` and the `.pptx` live in `docs/presentation/`. `python-pptx` is still in neither requirements file.
- ~~**`tests/` mixes four kinds of thing.**~~ Done: `tests/e2e/`, `tests/carla/`, `tools/probes/`.
- ~~**`test_bg_traffic_e2e.py`'s shortfall check**~~ **Done** (phase 6) — and it was the module after all: `BgTraffic.ensure()`'s cached return skipped `_renderStatus`, so a debounced regeneration that hit the client cache left „Wird erzeugt …" on screen for good. Fails on a re-run without the fix, passes three in a row with it.
- ~~**`tests/carla/carla_cases.py` and `run_carla_cases.py`**~~ **Deleted** (phase 6). The shared `run_case` moved to `tests/carla/carla_run.py` first, for the five runners still in use; `tests/README.md`, `COVERAGE.md` and CLAUDE.md keep the traps that are still true.
- **CLAUDE.md is 2300 lines.** It is the main orientation document, and much of it is history ("used to…", dated measurements). It is exempt from the 400-line rule, but trimming history out of it follows the same spirit. Do this last, so it describes the cleaned code.
- ~~**`map_renderer.py` header comment**~~ Gone with the comment pass.

## Phase 6 (lint findings), done

One commit per kind: F841/B007 (`5f06d6a`; none hid a bug — `_lane_entry`'s `sign` is recomputed in `_lane_centre`), B904 (`4379785`), B008 (`636837f`, FastAPI's `Annotated[UploadFile, File()]`), E402 (`fa36745`, a reasoned `noqa`: the probe needs its `sys.path` line first), Biome `noSparseArray` in `recipeHtml` (`893969a`, with a tooltip check in `test_recipe_e2e.py` that fails without the label lookup), and the config (`a97b018`): `E731`, `UP031`, `useOptionalChain`, `useIterableCallbackReturn`, `useTemplate` disabled with a reason each, `biome.json` → `biome.jsonc` for those comments, and inline ignores on the RNG and the CSS fallback. `biome migrate` replaced the deprecated `recommended` field. `bash tools/lint.sh` now passes with no findings at all. Already gone before this phase: the duplicate `actorColor` key and the four unused JS variables were already gone.

## 5. Notes for the later phases

- **Phase 2 is done.** `bash tests/run_tests.sh --quick` (~40 s: normalization, render geometry, `test_smoke_e2e.py`, events, undo) is the check to run after each split. `test_smoke_e2e.py` was shown to fail by name when a script throws at load.
- **Lint baseline at the end of phase 2** (`bash tools/lint.sh`): ruff format would reformat 55 of 62 Python files; ruff check 124 findings (mostly fixable: import order, unused imports, `raise … from`); pylint 19 modules over 400 lines, 14 functions over 60 statements, 8 over 15 branches; Biome would reformat all 24 frontend files and reports 44 errors / 101 warnings (most of them formatting, gone after phase 3). Of the Biome findings worth a look in phase 6: the duplicate `actorColor` key (above), 15 `useIterableCallbackReturn`, 2 `noAssignInExpressions` (both deliberate, in the seeded RNG), a sparse array literal in `scenarioGenerator.js` (`recipeHtml`). The duplicate `stroke-width` in `style.css:1029` is a deliberate fallback.
- **Run the e2e suites against a server without `--reload`** while editing files. See CLAUDE.md: `--reload` restarting under a running suite has wedged the server before.
- **Phase 3 is done** in four commits: `ruff format`, ruff's safe fixes, Biome format, Biome's safe fixes. Each was checked with `--quick` plus a fingerprint script that hashes every town's render JSON and lane graph and the export payload and `.xosc` of the example file and 12 generated scenarios (17 distinct files): byte-identical after every step. Formatting `style.css` was checked by screenshotting four editor states with the old and new stylesheet: pixel-identical.
- **Formatting made files longer.** Biome puts one property per line, so `style.css` went from 1677 to 3820 lines and the prop table in `propCatalog.js` from one line per prop to five. Neither can be configured away. Splitting will absorb most of it: CSS per panel, and the `PROPS` table into a data file of its own.
- **Lint after phase 3** (`bash tools/lint.sh`, formatting clean): ruff 32 findings needing judgement (17 `E702` semicolon statements, 11 `B904` `raise … from`, unused variables/loop variables, `E731` lambdas). Pylint: 20 modules over 400 lines, 14 functions over 60 statements, 8 over 15 branches, 3 too deeply nested, 4 duplicate-code blocks. Biome: 20 errors / 64 warnings — 59 `useOptionalChain` (an unsafe fix, so by hand), 15 `useIterableCallbackReturn`, 4 unused variables, plus the duplicate key, the sparse array and the two deliberate assignments in expressions noted above.
- **`ruff format` will be a large diff** (hand-aligned lines; quotes are preserved by config). Commit it alone, as planned. `pylint max-module-lines=400` will fail on the five big backend files until phase 4.
- **Phase 4 for JS** means: a new file per module, each an IIFE that attaches to the *existing* global (e.g. `ScenarioGenerator`), or a new global, plus an `index.html` script-order update. The order is the Progress table at the top.
