/**
 * mapImport.js — importing a .xodr map, from the header button or by drag-and-drop.
 */
(() => {
  'use strict';

  const fileInput = document.getElementById('btn-import-map-input');
  const mapSelect = document.getElementById('map-select');
  const mapStatus = document.getElementById('map-status');
  const dropOverlay = document.getElementById('map-drop-overlay');
  const mapContainer = document.getElementById('map-container');

  // ── Core upload + load handler ──────────────────────────────────────────────

  async function importXodr(file) {
    if (!file || !file.name.toLowerCase().endsWith('.xodr')) {
      Toast.error('Bitte eine .xodr Datei auswählen.');
      return;
    }

    mapStatus.textContent = `Importiere ${file.name} …`;
    Toast.info(`Importiere ${file.name} …`, 10000);

    let result;
    try {
      result = await Api.uploadMap(file);
    } catch (err) {
      mapStatus.textContent = 'Import fehlgeschlagen';
      Toast.error(`Import fehlgeschlagen: ${err.message}`);
      return;
    }

    const { town, roads } = result;
    Toast.success(`„${town}" importiert — ${roads} Straßen`);

    if (!mapSelect.querySelector(`option[value="${CSS.escape(town)}"]`)) {
      const opt = document.createElement('option');
      opt.value = town;
      opt.textContent = `${town} ★`; // star marks user-imported maps
      mapSelect.appendChild(opt);
    }

    // The current town's scenario is parked, as on any map switch.
    mapSelect.value = town;
    mapStatus.textContent = `Lade ${town} …`;
    try {
      const mapData = await Api.getMapRender(town);
      // An uploaded map gets a lane graph derived from its .xodr; a failure degrades to null.
      const laneGraph = await Api.getLaneGraph(town).catch(() => null);
      const switching = town !== AppState.map;
      if (switching) UIUtils.leaveMap();
      AppState.set({ map: town, mapData, laneGraph });
      if (switching) UIUtils.enterMap(town);
      MapView.renderMap(mapData);
      MapView.renderAllActors();
      mapStatus.textContent = `${mapData.roads.length} Straßen`;
      const layerToggles = document.getElementById('layer-toggles');
      if (layerToggles) layerToggles.classList.remove('hidden');
    } catch (err) {
      mapStatus.textContent = 'Kartendarstellung fehlgeschlagen';
      Toast.error(`Kartendarstellung fehlgeschlagen: ${err.message}`);
    }
  }

  // ── File-input button ───────────────────────────────────────────────────────

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await importXodr(file);
  });

  // ── Drag-and-drop on map canvas ─────────────────────────────────────────────

  let _dragCounter = 0;

  mapContainer.addEventListener('dragenter', (e) => {
    e.preventDefault();
    _dragCounter++;
    if (_dragCounter === 1) dropOverlay.classList.remove('hidden');
  });

  mapContainer.addEventListener('dragleave', () => {
    _dragCounter--;
    if (_dragCounter <= 0) {
      _dragCounter = 0;
      dropOverlay.classList.add('hidden');
    }
  });

  mapContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  mapContainer.addEventListener('drop', async (e) => {
    e.preventDefault();
    _dragCounter = 0;
    dropOverlay.classList.add('hidden');
    const file = e.dataTransfer.files[0];
    if (file) await importXodr(file);
  });
})();
