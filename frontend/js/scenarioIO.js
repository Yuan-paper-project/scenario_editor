/**
 * scenarioIO.js — Save scenario as JSON, load from JSON, export as .xosc.
 */
(function () {
  'use strict';

  const btnSave        = document.getElementById('btn-save');
  const btnLoadInput   = document.getElementById('btn-load-input');
  const btnExport      = document.getElementById('btn-export');
  const btnExportRoute = document.getElementById('btn-export-route');

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function _validateScenario() {
    const warnings = [];
    if (!AppState.map) warnings.push('Keine Karte ausgewählt');
    if (!AppState.ego) return { errors: ['Bitte zuerst ein Ego-Fahrzeug platzieren.'], warnings };

    // Client-side half of the backend's own rejection. An actor with no events
    // gets no Act, so a scenario in which nothing has events emits a storyboard
    // with nothing to run and ends the moment it starts.
    const hasActorEvents = [AppState.ego, ...AppState.npcs]
      .some(a => a && (a.events || []).length > 0);
    const hasSignalEvents = AppState.trafficSignals
      .some(sig => (sig.events || []).length > 0);
    if (!hasActorEvents && !hasSignalEvents) {
      return {
        errors: ['Kein Akteur hat Events — das Szenario würde sofort enden. Bitte mindestens ein Event anlegen.'],
        warnings,
      };
    }

    // Events the emitter would silently drop, taking any after_event chained
    // onto them along too. The editor no longer lets you *create* one, so this
    // catches a loaded .json or a scenario built before that guard existed.
    const incomplete = [AppState.ego, ...AppState.npcs]
      .filter(Boolean)
      .flatMap(actor => ScenarioRules.problemsOf(actor).map(({ index, problem }) =>
        `${AppState.actorLabel(actor, { ego: 'Ego-Fahrzeug' })} · Event ${index + 1}: ${problem.message}`));
    if (incomplete.length > 0) {
      return {
        errors: [`Unvollständige Events — sie würden beim Export verworfen:\n${incomplete.join('\n')}`],
        warnings,
      };
    }
    return { errors: [], warnings };
  }

  function buildScenarioParams() {
    if (!AppState.ego) throw new Error('Bitte zuerst ein Ego-Fahrzeug platzieren.');

    // Map internal actor id → OSC entity ref name
    const entityRef = id => {
      if (AppState.ego && id === AppState.ego.id) return 'hero';
      const idx = AppState.npcs.findIndex(n => n.id === id);
      return idx === 0 ? 'adversary' : idx > 0 ? `adversary${idx}` : 'hero';
    };

    // Actions are already in the correct new format in state — just resolve entity_refs
    const resolveAction = (action) => {
      if (!action) return { type: 'follow_trajectory', trajectory: [] };
      if (action.type === 'set_speed' && action.target?.mode === 'relative') {
        return { ...action, target: { ...action.target, entity_ref: entityRef(action.target.entity_ref) } };
      }
      if (action.type === 'set_distance') {
        return { ...action, entity_ref: entityRef(action.entity_ref) };
      }
      return action;
    };

    // Triggers carry an entity ref too — distance_to_point names the actor whose
    // proximity to the point is measured, and eventPanel defaults it to the ego
    // id. Same obj-N → OSC ref remap as actions; without it the .xosc gets a
    // dangling <EntityRef entityRef="obj-N"/> and the condition never fires.
    const resolveTrigger = (trigger, owner) => {
      if (trigger?.type === 'distance_to_point') {
        return { ...trigger, entity_ref: entityRef(trigger.entity_ref) };
      }
      // after_event's `event_id` is a storyboard element name and stays as it
      // is, but `actor_ref` names WHICH actor owns that event and needs the
      // same obj-N → OSC remap: the emitter keys its cross-actor name table on
      // (entity, event_id). Absent means the acting actor, so it is filled in
      // here rather than left out — the emitter would default it to the acting
      // entity anyway, and sending it makes the payload say what it means.
      if (trigger?.type === 'after_event') {
        return { ...trigger, actor_ref: entityRef(trigger.actor_ref || owner.id) };
      }
      return trigger;
    };

    const ego = AppState.ego;
    const routePts = AppState.pathPointsOf(ego);

    // Shared shape for the ego and every NPC — the ego is a scenario actor
    // with events exactly like an NPC, not a special case. `typeOverride`
    // exists only because the ego's internal type ('ego') is coerced to 'car'
    // at export; the backend and emitter never see the literal 'ego'.
    const dumpActor = (actor, typeOverride) => ({
      id: actor.id, type: typeOverride || actor.type,
      x: actor.x, y: actor.y, z: actor.z??0.2, yaw: actor.yaw??0,
      initial_speed:    actor.initial_speed??0,
      events: (actor.events||[]).map(ev => ({
        id: ev.id, name: ev.name,
        trigger: ev.action?.type === 'assign_route'
          ? { type: 'simulation_time', value: 0 }
          : resolveTrigger(ev.trigger, actor),
        action: resolveAction(ev.action),
      })),
    });

    return {
      schema_version: '1.0',
      map:     AppState.map || 'Town01',
      weather: { ...AppState.weather },
      // Drives dateTime + sun azimuth/elevation via compute_weather(). Without
      // it the backend defaults to 'daytime' and the dropdown does nothing.
      time:    AppState.time || 'daytime',
      ego: dumpActor(ego, ego.type === 'ego' ? 'car' : ego.type),
      trafficSignals: (AppState.trafficSignals||[])
        .filter(sig => (sig.events||[]).length > 0)
        .map(sig => ({ id: sig.id, x: sig.x, y: sig.y, events: sig.events })),
      // Static props: ids and pose only. The backend enriches each entry with
      // miscObjectCategory / mass / bbox from config/prop_catalog.yaml, so the
      // client is never the source of truth for what gets emitted.
      staticObjects: (AppState.staticObjects||[]).map(p => ({
        prop: p.prop, x: p.x, y: p.y, z: p.z??0, yaw: p.yaw??0,
      })),
      npcs: AppState.npcs.map(n => dumpActor(n)),
      // Ego route waypoints with per-segment yaw (used by route XML export),
      // derived from the ego's own follow_trajectory/assign_route event —
      // there is no actor-level ego.trajectory any more.
      route_waypoints: routePts.map((wp, i, arr) => {
        let yaw = ego.yaw??0;
        const next = arr[i+1], prev = arr[i-1];
        if (next)      yaw = Math.atan2(next.y-wp.y, next.x-wp.x)*180/Math.PI;
        else if (prev) yaw = Math.atan2(wp.y-prev.y, wp.x-prev.x)*180/Math.PI;
        return { x: wp.x, y: wp.y, z: wp.z??0.2, yaw: Math.round(yaw*100)/100 };
      }),
    };
  }

  // ── Save as JSON ─────────────────────────────────────────────────────────────

  btnSave.addEventListener('click', () => {
    const data = AppState.toJSON();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const town = AppState.map || 'scenario';
    downloadBlob(blob, `${town}_scenario.json`);
    Toast.success(`Szenario gespeichert als ${town}_scenario.json`);
  });

  // ── Load from JSON ────────────────────────────────────────────────────────────

  btnLoadInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      AppState.loadJSON(data);
      e.target.value = '';
      const npcCount = (data.npcs || []).length;
      Toast.success(`Szenario geladen: ${data.map || 'Karte unbekannt'}, ${npcCount} NPC${npcCount !== 1 ? 's' : ''}`);
    } catch (err) {
      Toast.error(`Szenario konnte nicht geladen werden: ${err.message}`);
      e.target.value = '';
    }
  });

  // ── Export as .xosc ───────────────────────────────────────────────────────────

  btnExport.addEventListener('click', async () => {
    // Pre-export validation
    const { errors, warnings } = _validateScenario();
    if (errors.length > 0) {
      Toast.error(errors[0]);
      return;
    }
    warnings.forEach(w => Toast.warn(w, 5000));

    let params;
    try {
      params = buildScenarioParams();
    } catch (err) {
      Toast.error(err.message);
      return;
    }

    btnExport.disabled   = true;
    btnExport.textContent = 'Exportiere\u2026';

    try {
      const blob = await Api.exportScenario(params);
      const town = AppState.map || 'scenario';
      downloadBlob(blob, `${town}_scenario.xosc`);
      Toast.success(`Exportiert: ${town}_scenario.xosc`);
    } catch (err) {
      Toast.error(`Export fehlgeschlagen: ${err.message}`);
    } finally {
      btnExport.disabled   = false;
      btnExport.textContent = 'Export .xosc';
    }
  });

  // ── Export ego route as XML ─────────────────────────────────────────────────

  // The export payload, without the click and without the client-side gate —
  // the only way a test can hand the backend a payload the gate refuses, which
  // is exactly what a hand-written or LLM-generated payload does. Same shape of
  // hook as Simulate.routeForTesting; no UI code calls it.
  window.ScenarioIO = { buildParamsForTesting: buildScenarioParams };

  btnExportRoute.addEventListener('click', async () => {
    if (!AppState.ego) {
      Toast.error('Bitte zuerst ein Ego-Fahrzeug platzieren.');
      return;
    }
    if (AppState.pathPointsOf(AppState.ego).length === 0) {
      Toast.warn('Keine Ego-Route vorhanden. Zuerst ein Follow-trajectory- oder Assign-route-Event für das Ego-Fahrzeug anlegen.');
      return;
    }

    let params;
    try { params = buildScenarioParams(); } catch (err) { Toast.error(err.message); return; }

    btnExportRoute.disabled    = true;
    btnExportRoute.textContent = 'Exportiere\u2026';

    try {
      const blob = await Api.exportRoute(params);
      const town = AppState.map || 'scenario';
      downloadBlob(blob, `${town}_route.xml`);
      Toast.success(`Exportiert: ${town}_route.xml`);
    } catch (err) {
      Toast.error(`Routen-Export fehlgeschlagen: ${err.message}`);
    } finally {
      btnExportRoute.disabled    = false;
      btnExportRoute.textContent = 'Route exportieren';
    }
  });
})();
