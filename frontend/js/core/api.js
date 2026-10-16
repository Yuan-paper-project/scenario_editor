/**
 * api.js — Thin HTTP client over the FastAPI backend.
 */
(() => {
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

    // A 404 is normal (no graph) and resolves to null.
    async getLaneGraph(town) {
      const res = await fetch(`/api/maps/${encodeURIComponent(town)}/lane_graph`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`getLaneGraph(${town}) failed: ${res.status}`);
      return res.json();
    },

    // 404 is normal for Town10 and uploaded maps; resolves to null.
    async getAerialMeta(town) {
      const res = await fetch(`/api/maps/${encodeURIComponent(town)}/aerial`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`getAerialMeta(${town}) failed: ${res.status}`);
      return res.json();
    },

    // All towns at once; any failure resolves to an empty list (decoration only).
    async getSpecialBuildings() {
      const res = await fetch('/api/special_buildings');
      if (!res.ok) throw new Error(`getSpecialBuildings failed: ${res.status}`);
      const data = await res.json();
      return data.buildings || [];
    },

    async exportScenario(params) {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(`Export failed (${res.status}): ${msg}`);
      }
      return res.blob();
    },

    async exportRoute(params) {
      const res = await fetch('/api/export/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(`Route export failed (${res.status}): ${msg}`);
      }
      return res.blob();
    },

    /** POST many generated scenarios; resolves to {blob, ok, failed}. */
    async exportBatch(body) {
      const res = await fetch('/api/export/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(`Batch export failed (${res.status}): ${msg}`);
      }
      return {
        blob: await res.blob(),
        ok: Number(res.headers.get('X-Scenarios-Ok') || 0),
        failed: Number(res.headers.get('X-Scenarios-Failed') || 0),
      };
    },

    async uploadMap(file) {
      const form = new FormData();
      form.append('file', file, file.name);
      const res = await fetch('/api/maps/upload', { method: 'POST', body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(body.detail || `Upload failed: ${res.status}`);
      }
      return res.json(); // { town, roads }
    },
  };

  window.Api = Api;
})();
