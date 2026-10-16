/**
 * specialBuildings.js — fetches maps/special_buildings.csv (all towns) once into
 * AppState; mapFeatures.js draws it. Reference data, not scenario state. Edit the
 * CSV and reload the tab: the backend reads it per request.
 */
(() => {
  'use strict';

  const SpecialBuildings = {
    /** Fetch and publish the landmarks; a failure stays quiet (decoration only). */
    async load() {
      let buildings;
      try {
        buildings = await Api.getSpecialBuildings();
      } catch (err) {
        console.warn('[buildings] not loaded:', err.message);
        return;
      }
      if (!buildings.length) return;
      AppState.set({ specialBuildings: buildings });
    },
  };

  window.SpecialBuildings = SpecialBuildings;
  SpecialBuildings.load();
})();
