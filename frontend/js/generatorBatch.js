/**
 * generatorBatch.js — parameter sweeps, batch generation and pairwise coverage.
 *
 * Part of the scenario generator; the design is described in scenarioGenerator.js.
 */
(() => {
  'use strict';

  const { Rng, EGO_SPEED, PARAMS, TYPES, _randomSeed, build, _buildFromRecipe } = GeneratorCore.shared;

  // ── Parameter sweep (a series from one recipe) ───────────────────────────────

  const SWEEP_MAX = 200;

  /** The values a sweep over `spec` visits: every option of a choice or a
   * bool, else `steps` evenly spaced from..to, rounded to the field's step. */
  function _sweepValues(spec, from, to, steps) {
    if (spec.kind === 'bool') return [false, true];
    if (spec.kind === 'choice') return spec.options.map(([k]) => k);
    const clamp = (v) => Math.min(spec.max, Math.max(spec.min, v));
    const a = clamp(Number(from)),
      b = clamp(Number(to));
    const n = Math.max(2, Math.min(25, Math.floor(Number(steps) || 2)));
    const out = [];
    for (let i = 0; i < n; i++) {
      const v = Math.round((a + ((b - a) * i) / (n - 1)) / spec.step) * spec.step;
      const rv = Math.round(v * 1000) / 1000;
      if (!out.includes(rv)) out.push(rv);
    }
    return out;
  }

  /**
   * One scenario per value of `key` (× every weather preset when `weathers`),
   * built from the open recipe on its site, as batch-export entries. The
   * editor's own scenario is swapped out and put back exactly as
   * generateBatch does it: plain assignment, undo suspended, `change {}`.
   */
  async function sweepFromRecipe({
    key,
    from,
    to,
    steps = 5,
    weathers = false,
    onProgress = () => {},
    isCancelled = () => false,
  } = {}) {
    const r = AppState.generated;
    if (!r || !PARAMS[r.type]) return null;
    const spec = [EGO_SPEED, ...PARAMS[r.type]].find((sp) => sp.key === key);
    if (!spec) return null;
    const values = _sweepValues(spec, from, to, steps);
    const wx = weathers ? Object.keys(WEATHER_PRESETS) : [null];
    const plan = values.flatMap((v) => wx.map((w) => ({ v, w }))).slice(0, SWEEP_MAX);

    Simulate.stop();
    const saved = JSON.parse(
      JSON.stringify({
        ego: AppState.ego,
        npcs: AppState.npcs,
        staticObjects: AppState.staticObjects,
        trafficSignals: AppState.trafficSignals,
        weather: AppState.weather,
        time: AppState.time,
        generated: AppState.generated,
      }),
    );
    AppState.cancelPlacement();
    AppState.select(null);
    UndoStack.suspend();
    const entries = [],
      skipped = [];
    const cache = new Map(); // one build per value, reused across weathers
    try {
      for (let k = 0; k < plan.length; k++) {
        if (isCancelled()) break;
        const { v, w } = plan[k];
        const ck = JSON.stringify(v);
        if (!cache.has(ck)) cache.set(ck, _buildFromRecipe(r, { ...(r.overrides || {}), [key]: v }));
        const res = cache.get(ck);
        if (!res) {
          skipped.push({ value: v, reason: 'an dieser Stelle nicht baubar' });
          continue;
        }
        const copy = JSON.parse(
          JSON.stringify({ ego: res.ego, npcs: res.npcs, props: res.props, sig: res.trafficSignals }),
        );
        AppState.ego = copy.ego;
        AppState.npcs = copy.npcs;
        AppState.staticObjects = copy.props;
        AppState.trafficSignals = copy.sig;
        AppState.weather = w ? _weatherOf(w) : JSON.parse(JSON.stringify(saved.weather));
        AppState.time = saved.time;
        const problems = ScenarioIO.validate().errors;
        if (problems.length) {
          skipped.push({ value: v, reason: problems[0] });
          continue;
        }
        const n = String(entries.length + 1).padStart(4, '0');
        const vName = String(v).replace(/[^\w.-]/g, '');
        entries.push({
          name: `${n}_${r.type}_${key}-${vName}${w ? '_' + w : ''}_s${res.info.seed}`,
          params: ScenarioIO.buildParams(),
          scenario: AppState.toJSON(),
          meta: {
            index: entries.length + 1,
            seed: res.info.seed,
            town: AppState.map,
            type: r.type,
            label: r.label,
            sweep_param: key,
            sweep_value: v,
            weather: w || 'editor',
            time: AppState.time,
            ego_speed: res.info.ego_speed,
            params: res.info.params,
            pinned: { ...(r.overrides || {}), [key]: v },
          },
        });
        onProgress(k + 1, plan.length, entries.length);
        await _tick();
      }
    } finally {
      Object.assign(AppState, saved);
      UndoStack.resume();
      AppState.emit('change', {});
      MapView.renderAllActors();
    }
    return { entries, skipped, values, cancelled: isCancelled() };
  }

  let _sweepRunning = false;

  async function _runSweep(opts) {
    if (_sweepRunning) return;
    _sweepRunning = true;
    try {
      const res = await sweepFromRecipe(opts);
      if (!res) return;
      if (!res.entries.length) {
        Toast.error('Serie: kein Wert ließ sich an dieser Stelle bauen');
        return;
      }
      const r = AppState.generated;
      const filename = `serie_${AppState.map}_${r.type}_${opts.key}_${res.entries.length}.zip`;
      const out = await Api.exportBatch({ scenarios: res.entries, filename });
      ScenarioIO.downloadBlob(out.blob, filename);
      const notes = [];
      if (res.skipped.length) notes.push(`${res.skipped.length} übersprungen`);
      if (out.failed) notes.push(`${out.failed} Export fehlgeschlagen (siehe manifest)`);
      Toast.success(`Serie: ${out.ok} Szenarien exportiert${notes.length ? ' · ' + notes.join(' · ') : ''}`, 8000);
    } catch (err) {
      Toast.error(`Serie fehlgeschlagen: ${err.message}`);
    } finally {
      _sweepRunning = false;
    }
  }

  // ── Batch generation (phase 2) and coverage sampling (phase 3) ──────────────

  // Physically consistent conditions, rather than independent sliders: rain
  // without a wet road, or fog with a clear sky, is not a condition anyone
  // drives in. Snow and dust are left out — CARLA 0.9.15 renders neither.
  const WEATHER_PRESETS = {
    klar: {},
    bewoelkt: { cloudy: 0.8 },
    regen: { cloudy: 0.8, rainy: 0.6, wet_road: 0.8 },
    starkregen: { cloudy: 1.0, rainy: 1.0, wet_road: 1.0, fog: 0.2 },
    nebel: { cloudy: 0.5, fog: 0.7 },
    nass: { cloudy: 0.3, wet_road: 0.7 },
  };
  const TIMES = ['daytime', 'morning', 'dusk', 'nighttime'];
  // The towns the CARLA build run.sh starts actually ships (Town10 is a
  // georeferenced map with no CARLA asset; uploaded maps have none either).
  const CARLA_TOWNS = ['Town01', 'Town02', 'Town03', 'Town04', 'Town05', 'Town06', 'Town07', 'Town10HD'];

  function _weatherOf(preset) {
    const w = { fog: 0, rainy: 0, cloudy: 0, sunny: 0, wet_road: 0, snowy: 0, dust_storm: 0 };
    return { ...w, ...(WEATHER_PRESETS[preset] || {}) };
  }

  /**
   * N combinations of the given dimensions ({name: [values]}) chosen greedily
   * so every PAIR of values across two dimensions appears as early as
   * possible (AETG-style pairwise coverage). Most interactions that break a
   * system involve two factors — "cut-in at night", "pedestrian in fog" — so
   * covering pairs is the cheap substitute for the full cross product, which
   * here would be 5 × 8 × 6 × 4 = 960 scenarios.
   */
  function coveragePlan(n, dims, rng) {
    const names = Object.keys(dims);
    const covered = new Set();
    const pairKeys = (combo) => {
      const keys = [];
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          keys.push(`${names[i]}=${combo[names[i]]}|${names[j]}=${combo[names[j]]}`);
        }
      }
      return keys;
    };
    // Ties on new pairs go to the combination whose values have been used
    // least so far. Without it the plan covered pairs but not values: with
    // eight scenario types a 9-item all-maps batch landed on only 6 of the 8
    // towns, three of them twice.
    const used = new Map();
    const usage = (combo) => names.reduce((sum, nm) => sum + (used.get(`${nm}=${combo[nm]}`) || 0), 0);
    const plan = [];
    for (let k = 0; k < n; k++) {
      let best = null,
        bestScore = -Infinity;
      for (let c = 0; c < 40; c++) {
        const combo = Object.fromEntries(names.map((nm) => [nm, rng.pick(dims[nm])]));
        const gain = pairKeys(combo).filter((p) => !covered.has(p)).length;
        const score = gain * 1000 - usage(combo);
        if (score > bestScore) {
          best = combo;
          bestScore = score;
        }
      }
      pairKeys(best).forEach((p) => covered.add(p));
      names.forEach((nm) => used.set(`${nm}=${best[nm]}`, (used.get(`${nm}=${best[nm]}`) || 0) + 1));
      plan.push(best);
    }
    return plan;
  }

  /** Switch the editor's map through the real selector and wait for both the
   * render data and the lane graph — the same path a user's pick takes, so
   * nothing about the map is set up differently for a batch. */
  async function _loadMap(town) {
    if (AppState.map === town && AppState.mapData && AppState.laneGraph) return true;
    const select = document.getElementById('map-select');
    if (![...select.options].some((o) => o.value === town)) return false;
    select.value = town;
    select.dataset.keepScenario = '1'; // toolbar.js: this switch must not clear
    select.dispatchEvent(new Event('change'));
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if (AppState.map === town && AppState.mapData && AppState.laneGraph) return true;
    }
    return false;
  }

  const _tick = () => new Promise((r) => setTimeout(r, 0));

  /**
   * Generate `count` scenarios and return {entries, skipped}: one export entry
   * per scenario, {name, params, scenario, meta}, ready for /api/export/batch.
   *
   * The editor's own scenario (actors, weather, time, map) is put back exactly
   * at the end, and nothing here records an undo entry. Each candidate is
   * swapped into AppState by plain assignment, not set(): buildScenarioParams
   * and toJSON read AppState, but nothing needs to render or record them.
   */
  async function generateBatch({
    count = 50,
    typeKey = null,
    typeKeys = null,
    seed = null,
    balance = true,
    varyWeather = true,
    maps = 'current',
    onProgress = () => {},
    isCancelled = () => false,
  } = {}) {
    const baseSeed = Number(seed) > 0 ? Math.floor(Number(seed)) : _randomSeed();
    const rng = new Rng(baseSeed);
    // `maps`: 'current', 'carla', or an array of town names (the dialog's
    // selection). Towns missing from #map-select are dropped.
    const available = new Set([...document.getElementById('map-select').options].map((o) => o.value));
    const towns = Array.isArray(maps)
      ? maps.filter((t) => available.has(t))
      : maps === 'carla'
        ? CARLA_TOWNS.filter((t) => available.has(t))
        : [AppState.map];
    if (!towns.length) towns.push(AppState.map);
    // `typeKeys`: the selected subset; `typeKey` (one type) is the older form.
    const allTypes = Object.keys(TYPES);
    let types = (typeKeys || (typeKey ? [typeKey] : allTypes)).filter((k) => TYPES[k]);
    if (!types.length) types = allTypes;
    const subset = types.length < allTypes.length ? types : null;
    const dims = {
      town: towns,
      type: types,
      weather: varyWeather ? Object.keys(WEATHER_PRESETS) : ['__keep'],
      time: varyWeather ? TIMES : ['__keep'],
    };
    let plan = coveragePlan(count, dims, rng);
    // Without balancing the type is the generator's own random pick instead,
    // from the selected subset (one selected type stays that type).
    if (!balance && types.length > 1) plan = plan.map((p) => ({ ...p, type: subset }));
    // One map load per town, not one per scenario.
    plan = plan.map((p, i) => ({ ...p, i })).sort((a, b) => towns.indexOf(a.town) - towns.indexOf(b.town) || a.i - b.i);

    Simulate.stop();
    const saved = {
      map: AppState.map,
      state: JSON.parse(
        JSON.stringify({
          ego: AppState.ego,
          npcs: AppState.npcs,
          staticObjects: AppState.staticObjects,
          trafficSignals: AppState.trafficSignals,
          weather: AppState.weather,
          time: AppState.time,
        }),
      ),
    };
    AppState.cancelPlacement();
    AppState.select(null);
    UndoStack.suspend();
    const entries = [];
    const skipped = [];
    try {
      for (let k = 0; k < plan.length; k++) {
        if (isCancelled()) break;
        const item = plan[k];
        if (!(await _loadMap(item.town)) || !AppState.laneGraph) {
          skipped.push({ town: item.town, type: item.type, reason: 'Karte nicht geladen' });
          continue;
        }
        const s = baseSeed + item.i;
        // A type this map cannot host (cut-in on single-lane Town01) falls
        // back to another SELECTED type rather than leaving a hole in the
        // batch; with a single type selected there is nothing to fall back to.
        let r = build(item.type, s);
        let fellBack = false;
        if (!r && typeof item.type === 'string' && types.length > 1) {
          r = build(subset, s);
          fellBack = !!r;
        }
        if (!r) {
          skipped.push({
            town: item.town,
            type: Array.isArray(item.type) ? null : item.type,
            seed: s,
            reason: 'kein passender Ort',
          });
          onProgress(k + 1, plan.length, entries.length);
          await _tick();
          continue;
        }
        AppState.ego = r.ego;
        AppState.npcs = r.npcs;
        AppState.staticObjects = r.props;
        AppState.trafficSignals = r.trafficSignals;
        if (item.weather !== '__keep') {
          AppState.weather = _weatherOf(item.weather);
          AppState.time = item.time;
        } else {
          AppState.weather = JSON.parse(JSON.stringify(saved.state.weather));
          AppState.time = saved.state.time;
        }
        const problems = ScenarioIO.validate().errors;
        if (problems.length) {
          skipped.push({ town: item.town, type: r.info.type, seed: s, reason: problems[0] });
          continue;
        }
        const n = String(entries.length + 1).padStart(4, '0');
        entries.push({
          name: `${n}_${item.town}_${r.info.type}_s${s}`,
          params: ScenarioIO.buildParams(),
          scenario: AppState.toJSON(),
          meta: {
            index: entries.length + 1,
            seed: s,
            town: item.town,
            type: r.info.type,
            label: r.info.label,
            type_fallback: fellBack,
            weather: item.weather === '__keep' ? 'editor' : item.weather,
            time: AppState.time,
            ego_speed: r.info.ego_speed,
            route_m: r.info.route_m,
            attempts: r.info.attempts,
            params: r.info.params,
          },
        });
        onProgress(k + 1, plan.length, entries.length);
        await _tick(); // let the progress bar paint, and Abbrechen be clicked
      }
    } finally {
      if (saved.map && saved.map !== AppState.map) await _loadMap(saved.map);
      Object.assign(AppState, saved.state);
      UndoStack.resume();
      // emit, not set(): no undo entry. NOT 'stateLoaded' — undo.js clears the
      // undo history on that. The weather sliders need no resync either: only
      // AppState.weather was swapped, never the DOM, and it is back as it was.
      AppState.emit('change', {});
      MapView.renderAllActors();
    }
    return { entries, skipped, seed: baseSeed, cancelled: isCancelled() };
  }

  GeneratorCore.define({
    SWEEP_MAX,
    _sweepValues,
    sweepFromRecipe,
    _runSweep,
    WEATHER_PRESETS,
    CARLA_TOWNS,
    _weatherOf,
    coveragePlan,
    generateBatch,
  });
})();
