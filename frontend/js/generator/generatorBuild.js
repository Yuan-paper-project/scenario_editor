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
   * Build a scenario without touching AppState: {ego, npcs, props, info}, or null when nothing
   * fits this map. Trivial and unavoidable candidates are dropped. `opts.near` = {x, y} builds it
   * at that spot, with the conflict within FOCUS_RADIUS_M.
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
    const keys = Array.isArray(typeKey) ? typeKey : typeKey ? [typeKey] : Object.keys(TYPES);

    // A focus discards candidates whose conflict lands elsewhere, so it gets more tries.
    const maxAttempts = MAX_ATTEMPTS + (_ctx.focus ? 150 : 0);
    // Each attempt has its own RNG from (seed, attempt), so attempt k is the same corridor
    // whatever earlier attempts drew — which lets a pinned rebuild stay on the same site.
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
      // A type may end the ego's route short, so a lead on the same corridor does not park on its goal.
      const egoEnd = res.egoEndD ?? c.length;
      // ...or start the ego up the corridor and give it events; '$ego' resolves now its id exists.
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
      // With pins, build what they give rather than moving on to another site.
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
    // The recipe, to rebuild with a parameter changed on the same site; an unanchored first build
    // is anchored to its own conflict point so rebuilds cannot drift.
    const info = result.info;
    const recipe = {
      type: info.type,
      label: info.label,
      seed: info.seed,
      town: info.town,
      near: info.near || opts.near || (info.criticality?.at ? { ...info.criticality.at } : null),
      // Focused builds index the focused attempts; otherwise the plain attempt is retried first.
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
      // The empty patch is the overview's "arrays changed" signal; inside the group, one undo.
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

  /** A short hash of the scenario objects, to tell whether it was edited since the recipe built it. */
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
   * Rebuild the recipe with `changes` merged into its pins (null unpins), same site and seed;
   * `newSeed` draws a variant. One undo step; on failure the scenario stays and a toast says so.
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
   * Build `r` again with `overrides`, without touching AppState. Unanchored: the original plain
   * attempt first, kept if the conflict stays within FOCUS_RADIUS_M; otherwise (and when
   * anchored) focused on the recipe's spot. `newSeed`: a focused variant.
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
