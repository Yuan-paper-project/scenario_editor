/* ══════════════════════════════════════════════════════════════════
   specialBuildings.js — landmark reference points on the map

   maps/special_buildings.csv (bus stops, parks, shops, …) is bundled with
   the repo and served as JSON by GET /api/special_buildings. This module
   does nothing but fetch it once at page load and hand it to AppState;
   mapView.js owns the drawing (layer-buildings) and the "Sonderorte"
   checkbox in the Ebenen menu.

   The file holds every town's rows at once and is small (~130), so it is
   fetched once and filtered per town at render time — switching maps costs
   no request. It is reference data, not scenario data: it never reaches
   toJSON(), the export payload or the undo stack.

   To change what is shown, edit the CSV — the backend reads it per request,
   so a browser reload is enough; no server restart.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const SpecialBuildings = {
    /** The rows for one town, in file order. */
    forTown(town) {
      return (AppState.specialBuildings || []).filter(b => b.town === town);
    },

    /**
     * Fetch the landmarks and publish them. Failure is deliberately quiet: the
     * overlay is decoration and the editor is fully usable without it, so a
     * missing CSV or a 500 must not put an error toast in front of the user.
     */
    async load() {
      let buildings;
      try {
        buildings = await Api.getSpecialBuildings();
      } catch (err) {
        console.warn('[buildings] not loaded:', err.message);
        return;
      }
      if (!buildings.length) return;
      // Not a scenario key, so this records no undo entry (_isScenarioPatch).
      AppState.set({ specialBuildings: buildings });
    },
  };

  window.SpecialBuildings = SpecialBuildings;
  SpecialBuildings.load();
})();
