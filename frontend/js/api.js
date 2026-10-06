/**
 * api.js — Thin HTTP client over the FastAPI backend.
 */
(function () {
  'use strict';

  const Api = {
    async getMaps() {
      const res = await fetch('/api/maps');
      if (!res.ok) throw new Error(`getMaps failed: ${res.status}`);
      return res.json();
    },

    async getMapRender(town) {
      const res = await fetch(`/api/maps/${encodeURIComponent(town)}/render`);
      if (!res.ok) throw new Error(`getMapRender(${town}) failed: ${res.status}`);
      return res.json();
    },

    // A 404 here is a normal, common outcome (no CARLA counterpart to probe,
    // or an uploaded map) — not an error, so it resolves to null rather than
    // throwing. Callers should treat null exactly like "no cache available".
    async getLaneGraph(town) {
      const res = await fetch(`/api/maps/${encodeURIComponent(town)}/lane_graph`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`getLaneGraph(${town}) failed: ${res.status}`);
      return res.json();
    },

    // Aerial image pyramid meta (tests/capture_carla_aerial.py). 404 is the
    // normal answer for Town10 and uploaded maps, so it resolves to null.
    async getAerialMeta(town) {
      const res = await fetch(`/api/maps/${encodeURIComponent(town)}/aerial`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`getAerialMeta(${town}) failed: ${res.status}`);
      return res.json();
    },

    // Landmark reference points for every town at once (maps/special_buildings.csv
    // via the backend). Small enough to fetch once at page load and filter
    // client-side by town, so switching maps costs no request. Any failure
    // resolves to an empty list — the overlay is decoration, never a blocker.
    async getSpecialBuildings() {
      const res = await fetch('/api/special_buildings');
      if (!res.ok) throw new Error(`getSpecialBuildings failed: ${res.status}`);
      const data = await res.json();
      return data.buildings || [];
    },

    async exportScenario(params) {
      const res = await fetch('/api/export', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(params),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(`Export failed (${res.status}): ${msg}`);
      }
      return res.blob();
    },

    async exportRoute(params) {
      const res = await fetch('/api/export/route', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(params),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(`Route export failed (${res.status}): ${msg}`);
      }
      return res.blob();
    },

    async uploadMap(file) {
      const form = new FormData();
      form.append('file', file, file.name);
      const res = await fetch('/api/maps/upload', { method: 'POST', body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(body.detail || `Upload failed: ${res.status}`);
      }
      return res.json();   // { town, roads }
    },
  };

  window.Api = Api;
})();
