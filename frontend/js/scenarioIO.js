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

    for (const npc of AppState.npcs) {
      const label = AppState.actorLabel(npc);
      if ((!npc.behaviors || npc.behaviors.length === 0) && (!npc.events || npc.events.length === 0)) {
        warnings.push(`${label} hat kein Verhalten und keine Events`);
      }
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

    const ego = AppState.ego;
    const traj = ego.trajectory || [];

    return {
      schema_version: '1.0',
      map:     AppState.map || 'Town01',
      weather: { ...AppState.weather },
      // Drives dateTime + sun azimuth/elevation via compute_weather(). Without
      // it the backend defaults to 'daytime' and the dropdown does nothing.
      time:    AppState.time || 'daytime',
      ego: {
        type: ego.type === 'ego' ? 'car' : ego.type,
        x: ego.x, y: ego.y, z: ego.z??0.2, yaw: ego.yaw??0,
      },
      trafficSignals: (AppState.trafficSignals||[])
        .filter(sig => (sig.events||[]).length > 0)
        .map(sig => ({ id: sig.id, x: sig.x, y: sig.y, events: sig.events })),
      // Static props: ids and pose only. The backend enriches each entry with
      // miscObjectCategory / mass / bbox from config/prop_catalog.yaml, so the
      // client is never the source of truth for what gets emitted.
      staticObjects: (AppState.staticObjects||[]).map(p => ({
        prop: p.prop, x: p.x, y: p.y, z: p.z??0, yaw: p.yaw??0,
      })),
      npcs: AppState.npcs.map(n => ({
        id: n.id, type: n.type,
        x: n.x, y: n.y, z: n.z??0.2, yaw: n.yaw??0,
        behaviors:        n.behaviors||['constant_speed'],
        trigger_distance: n.trigger_distance??400,
        events: (n.events||[]).map(ev => ({
          id: ev.id, name: ev.name,
          trigger: ev.action?.type === 'assign_route' ? { type: 'simulation_time', value: 0 } : ev.trigger,
          action: resolveAction(ev.action),
        })),
      })),
      // Ego route waypoints with per-segment yaw (used by route XML export)
      route_waypoints: traj.map((wp, i, arr) => {
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

  btnExportRoute.addEventListener('click', async () => {
    if (!AppState.ego) {
      Toast.error('Bitte zuerst ein Ego-Fahrzeug platzieren.');
      return;
    }
    const egoTraj = AppState.ego.trajectory || [];
    if (egoTraj.length === 0) {
      Toast.warn('Keine Ego-Route gezeichnet. Zuerst einen Pfad für das Ego-Fahrzeug zeichnen.');
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
