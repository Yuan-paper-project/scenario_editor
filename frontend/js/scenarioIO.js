/**
 * scenarioIO.js — Speichern / Laden (.json), the export payload and Export .xosc (ScenarioIO).
 */
(() => {
  'use strict';

  const btnSave = document.getElementById('btn-save');
  const btnLoadInput = document.getElementById('btn-load-input');
  const btnExport = document.getElementById('btn-export');
  const btnExportRoute = document.getElementById('btn-export-route');

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
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

    // The backend's rule too: with no events anywhere the storyboard has nothing to run.
    const hasActorEvents = [AppState.ego, ...AppState.npcs].some((a) => a && (a.events || []).length > 0);
    const hasSignalEvents = AppState.trafficSignals.some((sig) => (sig.events || []).length > 0);
    if (!hasActorEvents && !hasSignalEvents) {
      return {
        errors: ['Kein Akteur hat Events — das Szenario würde sofort enden. Bitte mindestens ein Event anlegen.'],
        warnings,
      };
    }

    // A Schaltung on a light CARLA lacks aborts the run ("Unknown traffic light").
    const ghostSignals = AppState.trafficSignals
      .filter((sig) => (sig.events || []).length > 0 && TrafficSignals.mapSignalById(sig.id)?.inCarla === false)
      .map((sig) => sig.id);
    if (ghostSignals.length > 0) {
      return {
        errors: [
          `Diese Ampeln gibt es in CARLA nicht, ihre Schaltungen würden den Lauf abbrechen: ${ghostSignals.join(', ')}`,
        ],
        warnings,
      };
    }

    // Events the emitter would drop (dangling anything chained onto them); for loaded files.
    const incomplete = [AppState.ego, ...AppState.npcs]
      .filter(Boolean)
      .flatMap((actor) =>
        ScenarioRules.problemsOf(actor).map(
          ({ index, problem }) =>
            `${AppState.actorLabel(actor, { ego: 'Ego-Fahrzeug' })} · Event ${index + 1}: ${problem.message}`,
        ),
      );
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

    // Internal id → OSC entity name.
    const entityRef = (id) => {
      if (AppState.ego && id === AppState.ego.id) return 'hero';
      const idx = AppState.npcs.findIndex((n) => n.id === id);
      return idx === 0 ? 'adversary' : idx > 0 ? `adversary${idx}` : 'hero';
    };

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

    // distance_to_point's entity_ref needs the same remap, or the condition never fires.
    const resolveTrigger = (trigger, owner) => {
      if (trigger?.type === 'distance_to_point') {
        return { ...trigger, entity_ref: entityRef(trigger.entity_ref) };
      }
      // These name the OTHER actor; absent on distance_to_ego means the ego and stays absent.
      if ((trigger?.type === 'distance_to_ego' || trigger?.type === 'relative_speed') && trigger.entity_ref) {
        return { ...trigger, entity_ref: entityRef(trigger.entity_ref) };
      }
      // event_id stays verbatim; actor_ref (the event's owner) is remapped and filled in for the
      // acting actor, since the emitter keys its name table on (entity, event_id).
      if (trigger?.type === 'after_event' || trigger?.type === 'event_started') {
        return { ...trigger, actor_ref: entityRef(trigger.actor_ref || owner.id) };
      }
      return trigger;
    };

    const ego = AppState.ego;
    const routePts = AppState.pathPointsOf(ego);

    // One shape for ego and NPCs; `typeOverride` exports the ego as its vehicleType. An explicit
    // allow-list: a field missing here is dropped at export.
    const dumpActor = (actor, typeOverride) => ({
      id: actor.id,
      type: typeOverride || actor.type,
      x: actor.x,
      y: actor.y,
      z: actor.z ?? 0.2,
      yaw: actor.yaw ?? 0,
      initial_speed: actor.initial_speed ?? 0,
      // consider_trafficlights / consider_obstacles; absent means true in every layer.
      obey_traffic_lights: actor.obey_traffic_lights !== false,
      obey_obstacles: actor.obey_obstacles !== false,
      // Rate limits (m/s²), same defaults as every layer; walkers ignore them.
      max_acceleration: actor.max_acceleration ?? 3.0,
      max_deceleration: actor.max_deceleration ?? 10.0,
      events: (actor.events || []).map((ev) => ({
        id: ev.id,
        name: ev.name,
        trigger:
          ev.action?.type === 'assign_route'
            ? { type: 'simulation_time', value: 0 }
            : resolveTrigger(ev.trigger, actor),
        action: resolveAction(ev.action),
      })),
    });

    return {
      schema_version: '1.0',
      map: AppState.map || 'Town01',
      weather: { ...AppState.weather },
      // Drives dateTime and the sun position; without it the backend assumes daytime.
      time: AppState.time || 'daytime',
      ego: dumpActor(ego, AppState.bodyType(ego)),
      trafficSignals: (AppState.trafficSignals || [])
        .filter((sig) => (sig.events || []).length > 0)
        // z is the pole's road height (the trigger is 3-D); older files fall back to the map's light.
        .map((sig) => ({
          id: sig.id,
          x: sig.x,
          y: sig.y,
          z: sig.z ?? TrafficSignals.mapSignalById(sig.id)?.z ?? 0,
          events: sig.events,
        })),
      // Props as ids and pose only: the backend adds category/mass/bbox from the catalogue.
      staticObjects: (AppState.staticObjects || []).map((p) => ({
        prop: p.prop,
        x: p.x,
        y: p.y,
        z: p.z ?? 0,
        yaw: p.yaw ?? 0,
      })),
      npcs: AppState.npcs.map((n) => dumpActor(n)),
      // The ego's route with per-segment yaw (route XML), from its own path event.
      route_waypoints: routePts.map((wp, i, arr) => {
        let yaw = ego.yaw ?? 0;
        const next = arr[i + 1],
          prev = arr[i - 1];
        if (next) yaw = (Math.atan2(next.y - wp.y, next.x - wp.x) * 180) / Math.PI;
        else if (prev) yaw = (Math.atan2(wp.y - prev.y, wp.x - prev.x) * 180) / Math.PI;
        return { x: wp.x, y: wp.y, z: wp.z ?? 0.2, yaw: Math.round(yaw * 100) / 100 };
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

  btnLoadInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      UIUtils.beforeLoadFile(data.map);
      AppState.loadJSON(data);
      e.target.value = '';
      const npcCount = (data.npcs || []).length;
      Toast.success(`Szenario geladen: ${data.map || 'Karte unbekannt'}, ${npcCount} NPC${npcCount !== 1 ? 's' : ''}`);
      // An unknown type 400s at export and the picker offers no way out: warn now.
      const known = new Set(
        AppState.ACTOR_TYPE_GROUPS.flatMap((g) => g.sections.flatMap((s) => s.types.map((t) => t.type))),
      );
      const unknown = [...new Set(AppState.npcs.map((n) => n.type).filter((t) => !known.has(t)))];
      if (unknown.length) {
        Toast.warn(
          `Unbekannter Akteurtyp: ${unknown.join(', ')} — der Export wird abgelehnt. Akteur löschen und neu platzieren.`,
        );
      }
    } catch (err) {
      Toast.error(`Szenario konnte nicht geladen werden: ${err.message}`);
      e.target.value = '';
    }
  });

  // ── Export as .xosc ───────────────────────────────────────────────────────────

  btnExport.addEventListener('click', async () => {
    const { errors, warnings } = _validateScenario();
    if (errors.length > 0) {
      Toast.error(errors[0]);
      return;
    }
    warnings.forEach((w) => Toast.warn(w, 5000));

    let params;
    try {
      params = buildScenarioParams();
    } catch (err) {
      Toast.error(err.message);
      return;
    }

    btnExport.disabled = true;
    btnExport.textContent = 'Exportiere\u2026';

    try {
      const town = AppState.map || 'scenario';
      if (window.BgTraffic && BgTraffic.active) {
        // With background traffic the export is a zip; run.sh picks up <name>.bgtraffic.json.
        const { blob, vehicles } = await BgTraffic.exportBundle(params);
        downloadBlob(blob, `${town}_scenario.zip`);
        Toast.success(
          `Exportiert: ${town}_scenario.zip — .xosc + Hintergrundverkehr (${vehicles} Fahrzeuge). ` +
            'Beide Dateien in denselben Ordner entpacken; run.sh spielt den Verkehr dann mit ab.',
          7000,
        );
      } else {
        const blob = await Api.exportScenario(params);
        downloadBlob(blob, `${town}_scenario.xosc`);
        Toast.success(`Exportiert: ${town}_scenario.xosc`);
      }
    } catch (err) {
      Toast.error(`Export fehlgeschlagen: ${err.message}`);
    } finally {
      btnExport.disabled = false;
      btnExport.textContent = 'Export .xosc';
    }
  });

  // ── Export ego route as XML ─────────────────────────────────────────────────

  // buildParamsForTesting: the payload without the click or the client gate, so a test can hand
  // the backend what a hand-written payload would. buildParams / validate / downloadBlob serve
  // the generator's batch export.
  window.ScenarioIO = {
    buildParamsForTesting: buildScenarioParams,
    buildParams: buildScenarioParams,
    validate: _validateScenario,
    downloadBlob,
  };

  btnExportRoute.addEventListener('click', async () => {
    if (!AppState.ego) {
      Toast.error('Bitte zuerst ein Ego-Fahrzeug platzieren.');
      return;
    }
    if (AppState.pathPointsOf(AppState.ego).length === 0) {
      Toast.warn(
        'Keine Ego-Route vorhanden. Zuerst ein Follow-trajectory- oder Assign-route-Event für das Ego-Fahrzeug anlegen.',
      );
      return;
    }

    let params;
    try {
      params = buildScenarioParams();
    } catch (err) {
      Toast.error(err.message);
      return;
    }

    btnExportRoute.disabled = true;
    btnExportRoute.textContent = 'Exportiere\u2026';

    try {
      const blob = await Api.exportRoute(params);
      const town = AppState.map || 'scenario';
      downloadBlob(blob, `${town}_route.xml`);
      Toast.success(`Exportiert: ${town}_route.xml`);
    } catch (err) {
      Toast.error(`Routen-Export fehlgeschlagen: ${err.message}`);
    } finally {
      btnExportRoute.disabled = false;
      btnExportRoute.textContent = 'Route exportieren';
    }
  });
})();
