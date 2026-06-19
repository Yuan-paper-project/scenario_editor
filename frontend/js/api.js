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
