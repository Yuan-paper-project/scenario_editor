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
    if (!AppState.map) warnings.push('No map selected');
    if (!AppState.ego) return { errors: ['Place an Ego vehicle before exporting.'], warnings };

    for (const npc of AppState.npcs) {
      const label = `${npc.type.toUpperCase()} (${npc.id})`;
      if ((!npc.behaviors || npc.behaviors.length === 0) && (!npc.trajectory || npc.trajectory.length < 2)) {
        warnings.push(`${label} has no behaviors and no trajectory`);
      }
    }
    return { errors: [], warnings };
  }

  function buildScenarioParams() {
    if (!AppState.ego) {
      throw new Error('Place an Ego vehicle before exporting.');
    }
    return {
      map:       AppState.map || 'Town01',
      road_type: 'road',
      weather:   { ...AppState.weather },
      time:      AppState.time,
      ego: {
        type: AppState.ego.type === 'ego' ? 'car' : AppState.ego.type,
        x:    AppState.ego.x,
        y:    AppState.ego.y,
        z:    AppState.ego.z || 0.2,
        yaw:  AppState.ego.yaw || 0,
      },
      npcs: AppState.npcs.map(n => ({
        type:             n.type,
        x:                n.x,
        y:                n.y,
        z:                n.z || 0.2,
        yaw:              n.yaw || 0,
        behaviors:        n.behaviors || ['constant_speed'],
        trigger_distance: n.trigger_distance ?? 400,
        trajectory: (n.trajectory || []).map(wp => ({
          x:        wp.x,
          y:        wp.y,
          z:        wp.z || 0.2,
          velocity: wp.velocity || 10.0,
        })),
      })),
      // Ego trajectory → route waypoints for the route XML
      // Compute per-waypoint heading from direction to next waypoint
      route_waypoints: (AppState.ego.trajectory || []).map((wp, i, arr) => {
        let yaw = AppState.ego.yaw || 0;
        if (i < arr.length - 1) {
          const dx = arr[i + 1].x - wp.x;
          const dy = arr[i + 1].y - wp.y;
          yaw = Math.atan2(dy, dx) * 180 / Math.PI;  // degrees for route XML
        } else if (i > 0) {
          // Last waypoint: use same heading as previous segment
          const dx = wp.x - arr[i - 1].x;
          const dy = wp.y - arr[i - 1].y;
          yaw = Math.atan2(dy, dx) * 180 / Math.PI;
        }
        return { x: wp.x, y: wp.y, z: wp.z || 0.2, yaw: Math.round(yaw * 100) / 100 };
      }),
    };
  }

  // ── Save as JSON ─────────────────────────────────────────────────────────────

  btnSave.addEventListener('click', () => {
    const data = AppState.toJSON();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const town = AppState.map || 'scenario';
    downloadBlob(blob, `${town}_scenario.json`);
    Toast.success(`Scenario saved as ${town}_scenario.json`);
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
      Toast.success(`Loaded scenario: ${data.map || 'unknown map'}, ${npcCount} NPC${npcCount !== 1 ? 's' : ''}`);
    } catch (err) {
      Toast.error(`Failed to load scenario: ${err.message}`);
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
    btnExport.textContent = 'Exporting\u2026';

    try {
      const blob = await Api.exportScenario(params);
      const town = AppState.map || 'scenario';
      downloadBlob(blob, `${town}_scenario.xosc`);
      Toast.success(`Exported ${town}_scenario.xosc`);
    } catch (err) {
      Toast.error(`Export failed: ${err.message}`);
    } finally {
      btnExport.disabled   = false;
      btnExport.textContent = 'Export .xosc';
    }
  });

  // ── Export ego route as XML ─────────────────────────────────────────────────

  btnExportRoute.addEventListener('click', async () => {
    if (!AppState.ego) {
      Toast.error('Place an Ego vehicle first.');
      return;
    }
    const egoTraj = AppState.ego.trajectory || [];
    if (egoTraj.length === 0) {
      Toast.warn('No ego route drawn. Draw a path on the Ego vehicle first.');
      return;
    }

    let params;
    try { params = buildScenarioParams(); } catch (err) { Toast.error(err.message); return; }

    btnExportRoute.disabled    = true;
    btnExportRoute.textContent = 'Exporting\u2026';

    try {
      const blob = await Api.exportRoute(params);
      const town = AppState.map || 'scenario';
      downloadBlob(blob, `${town}_route.xml`);
      Toast.success(`Exported ${town}_route.xml`);
    } catch (err) {
      Toast.error(`Route export failed: ${err.message}`);
    } finally {
      btnExportRoute.disabled    = false;
      btnExportRoute.textContent = 'Export Route';
    }
  });
})();
