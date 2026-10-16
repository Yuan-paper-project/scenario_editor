/**
 * generatorBuild.js — build/generate/rebuild: turning a type and seed into a scenario.
 *
 * Part of the scenario generator; the design is described in scenarioGenerator.js.
 */
(() => {
  'use strict';

  const {
    ROUTE_TOLERANCE_M,
    MAX_ATTEMPTS,
    Rng,
    r1,
    _network,
    _ctx,
    _p,
    FOCUS_RADIUS_M,
    _focusLanes,
    _corridorAt,
    _corridorWaypoints,
    _vehicle,
    _routeEvent,
    _greenWave,
    _cleanOverrides,
    TYPES,
    _distToPolyline,
    _routeOf,
    _routeFollowsCorridor,
    _spawnsClear,
    assess,
  } = GeneratorCore.shared;

  // ── Public entry point ───────────────────────────────────────────────────────

  /** A well-mixed 32-bit seed for attempt `attempt` of seed `seed`. */
  function _attemptSeed(seed, attempt) {
    let h = (Math.imul(seed >>> 0, 0x9e3779b1) ^ Math.imul(attempt + 1, 0x85ebca6b)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
    return (h ^ (h >>> 16)) >>> 0 || 1;
  }

  function _randomSeed() {
    return Math.floor(Math.random() * 2 ** 31) + 1;
  }

  /**
   * Build a scenario without touching AppState. Returns
   * {ego, npcs, props, info} or null when no attempt fit this map.
   *
   * Every candidate is scored (assess) and dropped when it is trivial or
   * unavoidable.
   *
   * `opts.near` = {x, y} builds it at that spot ("Generate here"): the ego's
   * corridor runs through a lane at the click and the conflict must happen
   * within FOCUS_RADIUS_M of it. Null when no driving lane is near the point.
   */
  function build(typeKey = null, seed = null, opts = {}) {
    const net = _network();
    if (!net) return null;
    if (opts.near) {
      const lanes = _focusLanes(net, opts.near.x, opts.near.y);
      if (!lanes.length) return null;
      _ctx.focus = { x: opts.near.x, y: opts.near.y, radius: opts.near.radius ?? FOCUS_RADIUS_M, lanes };
    }
    _ctx.overrides = _cleanOverrides(typeKey, opts.overrides);
    try {
      return _build(net, typeKey, seed, opts);
    } finally {
      _ctx.focus = null;
      _ctx.overrides = null;
    }
  }

  function _build(net, typeKey, seed, opts) {
    seed = Number.isFinite(Number(seed)) && Number(seed) > 0 ? Math.floor(Number(seed)) : _randomSeed();
    // An array is a subset to pick from (the batch dialog's type selection).
    const keys = Array.isArray(typeKey) ? typeKey : typeKey ? [typeKey] : Object.keys(TYPES);

    // A focus throws away every candidate whose conflict lands elsewhere, so
    // it gets more tries; each costs one headless run (~20 ms) once built.
    const maxAttempts = MAX_ATTEMPTS + (_ctx.focus ? 150 : 0);
    // Every attempt draws from its OWN generator, seeded from (seed, attempt):
    // attempt k is then the same corridor and draws whatever happened in
    // attempts 0..k-1. That is what lets the recipe panel rebuild a scenario
    // with one value pinned on the very site it was on — it retries the
    // original attempt first (opts.firstAttempt). With one shared generator a
    // pin that changed how far an earlier attempt got shifted every later one.
    const first = Number.isInteger(opts.firstAttempt) && opts.firstAttempt >= 0 ? opts.firstAttempt : null;
    const order = first !== null ? [first] : [];
    if (!opts.onlyFirst || first === null) {
      for (let a = 0; a < maxAttempts; a++) if (a !== first) order.push(a);
    }
    for (const attempt of order) {
      const rng = new Rng(_attemptSeed(seed, attempt));
      const key = rng.pick(keys);
      const vEgo = _p('ego_speed', Math.round(rng.range(8, 14) * 2) / 2);
      const res = TYPES[key].build(rng, net, vEgo);
      if (!res) continue;
      const trafficSignals = _greenWave(net, res.corridor, res.conflictD ?? res.corridor.length);

      const c = res.corridor;
      // A type may end the ego's route short of the corridor, so an NPC that
      // follows the same corridor (the lead car) is not parked on the ego's
      // own goal when both routes run out.
      const egoEnd = res.egoEndD ?? c.length;
      // A type may start the ego further up its corridor, with another actor
      // behind it (rear_approach), and give it events of its own after the
      // route. '$ego' in a trigger names the ego, whose id exists only now.
      const egoStart = res.egoStartD ?? 0;
      const ego = _vehicle('ego', _corridorAt(c, egoStart), vEgo);
      ego.events = [_routeEvent(ego, _corridorWaypoints(c, egoStart, egoEnd)), ...(res.egoEvents || [])];
      for (const a of [ego, ...res.npcs]) {
        for (const ev of a.events || []) if (ev.trigger?.entity_ref === '$ego') ev.trigger.entity_ref = ego.id;
      }
      if (!_routeFollowsCorridor(ego, c, egoStart, egoEnd)) continue;

      if (!_spawnsClear(ego, res.npcs, res.props)) continue;

      let ok = true;
      for (const rn of res.routedNpcs) {
        if (rn.corridorFrom !== undefined) {
          ok = _routeFollowsCorridor(rn.actor, c, rn.corridorFrom);
        } else if (rn.passes) {
          const route = _routeOf(rn.actor);
          ok = !!route && _distToPolyline(route, rn.passes.x, rn.passes.y) <= ROUTE_TOLERANCE_M;
        }
        if (!ok) break;
      }
      if (!ok) continue;

      const criticality = assess({
        ego,
        npcs: res.npcs,
        props: res.props,
        sceneryIds: res.sceneryIds,
        onsets: res.onsets,
        threats: res.threats,
        revealedBy: res.revealedBy,
      });
      // Pinned values are the user's call: build what they give rather than
      // moving on to another site.
      if (criticality.verdict === 'no_run') continue;
      if (criticality.verdict !== 'ok' && !_ctx.overrides) continue;
      if (
        _ctx.focus &&
        !(
          criticality.at &&
          Math.hypot(criticality.at.x - _ctx.focus.x, criticality.at.y - _ctx.focus.y) <= _ctx.focus.radius
        )
      )
        continue;

      const info = {
        seed,
        type: key,
        label: TYPES[key].label,
        town: AppState.map,
        attempts: order.indexOf(attempt) + 1,
        attempt,
        ego_speed: vEgo,
        route_m: r1(egoEnd),
        criticality,
        params: res.params,
      };
      info.forced_green_lights = trafficSignals.length;
      if (_ctx.focus) info.near = { x: r1(_ctx.focus.x), y: r1(_ctx.focus.y) };
      if (_ctx.overrides) info.overrides = { ..._ctx.overrides };
      return { ego, npcs: res.npcs, props: res.props, trafficSignals, info };
    }
    return null;
  }

  /** Build and load a scenario into the editor as ONE undo step. */
  function generate(typeKey = null, seed = null, opts = {}) {
    if (!AppState.mapData) {
      Toast.error('Zuerst eine Karte laden');
      return null;
    }
    if (!AppState.laneGraph) {
      Toast.error('Für diese Karte ist kein Spurgraph geladen');
      return null;
    }
    if (typeKey && !TYPES[typeKey]) return null;

    Simulate.stop(); // scoring needs the preview's tick state, see Simulate.stop
    AppState.cancelPlacement();
    const result = opts.prebuilt || build(typeKey, seed, opts);
    if (!result) {
      const what = typeKey ? TYPES[typeKey].label : 'Szenario';
      Toast.error(
        opts.near
          ? `Kein passender Ort für „${what}" an dieser Stelle — eine andere Stelle oder einen anderen Typ versuchen`
          : `Kein passender Ort für „${what}" auf ${AppState.map} gefunden`,
      );
      return null;
    }
    // The recipe: enough to rebuild this scenario with one parameter changed
    // on the same site (recipe panel). A first build that was not anchored to
    // a click is anchored to its own conflict point from now on, so repeated
    // rebuilds cannot drift across the map.
    const info = result.info;
    const recipe = {
      type: info.type,
      label: info.label,
      seed: info.seed,
      town: info.town,
      near: info.near || opts.near || (info.criticality?.at ? { ...info.criticality.at } : null),
      // Built focused (a click, or a rebuild that needed the focus): `attempt`
      // indexes the focused attempts, so rebuilds stay focused. Otherwise it
      // indexes the plain ones, and the plain attempt is retried first.
      anchored: !!info.near,
      attempt: info.attempt,
      overrides: info.overrides || {},
      params: { ego_speed: info.ego_speed, ...info.params },
      criticality: info.criticality,
    };
    UndoStack.group(opts.undoLabel || 'Szenario generiert', () => {
      AppState.select(null);
      AppState.set({
        ego: result.ego,
        npcs: result.npcs,
        staticObjects: result.props,
        trafficSignals: result.trafficSignals,
        generated: recipe,
      });
      recipe.signature = sceneSignature();
      // The overview panel re-renders off an allow-list that does not include
      // ego/npcs; an empty patch is the codebase's "arrays changed" signal it
      // does listen for (properties.js). Inside the group, so still one undo.
      AppState.set({});
    });
    MapView.renderAllActors();
    if (!opts.keepView) _frame(result);

    const problems = [result.ego, ...result.npcs].flatMap((a) =>
      ScenarioRules.problemsOf(a).map((p) => `${AppState.actorLabel(a)}: ${p.problem.message}`),
    );
    if (problems.length) Toast.warn(`Generiertes Szenario hat Probleme: ${problems.join('; ')}`, 8000);
    else if (!opts.quiet) Toast.success(`${result.info.label} generiert · Seed ${result.info.seed}`);

    _ctx.lastInfo = result.info;
    AppState.emit('scenarioGenerated', result.info);
    return result.info;
  }

  /** A short hash of the scenario objects, to tell whether the open scenario
   * is still the one a recipe built (the panel warns before a rebuild would
   * throw hand edits away). Editor-only flags (a collapsed event card) are
   * edits too as far as this knows; it only decides whether to ask. */
  function sceneSignature() {
    const str = JSON.stringify([AppState.ego, AppState.npcs, AppState.staticObjects]);
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  /** True when the open scenario is no longer exactly what the recipe built. */
  function recipeEdited() {
    const r = AppState.generated;
    return !!r && r.signature !== sceneSignature();
  }

  /**
   * Rebuild the open recipe with `changes` merged into its pinned values
   * (null removes a pin), on the same site and seed. `newSeed` makes a
   * variant instead: everything not pinned is drawn afresh. One undo step;
   * on failure the open scenario is left alone and a toast says so.
   */
  function rebuild(changes = {}, { newSeed = false } = {}) {
    const r = AppState.generated;
    if (!r || !TYPES[r.type]) return null;
    if (r.town && r.town !== AppState.map) {
      Toast.error(`Das Rezept gehört zu ${r.town} — erst die Karte wechseln`);
      return null;
    }
    const overrides = { ...(r.overrides || {}) };
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === undefined) delete overrides[k];
      else overrides[k] = v;
    }
    Simulate.stop();
    const result = _buildFromRecipe(r, overrides, newSeed ? _randomSeed() : null);
    if (!result) {
      Toast.error(`„${r.label}" lässt sich mit diesen Werten an dieser Stelle nicht bauen`);
      return null;
    }
    return generate(r.type, result.info.seed, {
      near: r.near,
      prebuilt: result,
      keepView: true,
      undoLabel: newSeed ? 'Variante' : 'Parameter',
    });
  }

  /**
   * Build `r`'s scenario again with `overrides`, without touching AppState.
   * Same seed: an unanchored recipe retries its original plain attempt first
   * (pins never shift the per-attempt RNG, so that is the very same corridor)
   * and keeps it only if the conflict stays within FOCUS_RADIUS_M of where it
   * was; otherwise, and for an anchored recipe, it builds focused on the
   * recipe's spot, original attempt first. `newSeed`: a variant, focused.
   */
  function _buildFromRecipe(r, overrides, newSeed = null) {
    if (newSeed) return build(r.type, newSeed, { near: r.near, overrides });
    if (!r.anchored && Number.isInteger(r.attempt)) {
      const plain = build(r.type, r.seed, { overrides, firstAttempt: r.attempt, onlyFirst: true });
      const at = plain?.info.criticality?.at;
      if (at && (!r.near || Math.hypot(at.x - r.near.x, at.y - r.near.y) <= FOCUS_RADIUS_M)) return plain;
    }
    if (!r.near) return null;
    return build(r.type, r.seed, { near: r.near, overrides, firstAttempt: r.anchored ? r.attempt : undefined });
  }

  /** Frame everything the scenario placed, including the ego's route end. */
  function _frame(result) {
    const pts = [result.ego, ...result.npcs, ...result.props].map((a) => ({ x: a.x, y: a.y }));
    const wps = result.ego.events[0]?.action?.waypoints || [];
    if (wps.length) pts.push(wps[wps.length - 1]);
    MapView.frameBounds(pts);
  }

  GeneratorCore.define({ _randomSeed, build, generate, sceneSignature, recipeEdited, rebuild, _buildFromRecipe });
})();
