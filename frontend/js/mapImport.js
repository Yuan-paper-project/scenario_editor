/**
 * mapImport.js — CARLA .xodr Karten-Import.
 * Unterstützt: Datei-Button in der Kopfleiste und Drag-and-drop auf die Karte.
 */
(function () {
  'use strict';

  const fileInput   = document.getElementById('btn-import-map-input');
  const mapSelect   = document.getElementById('map-select');
  const mapStatus   = document.getElementById('map-status');
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

    // Add to dropdown if not already present
    if (!mapSelect.querySelector(`option[value="${CSS.escape(town)}"]`)) {
      const opt = document.createElement('option');
      opt.value       = town;
      opt.textContent = `${town} ★`;   // star marks user-imported maps
      mapSelect.appendChild(opt);
    }

    // Auto-select and render the newly imported map
    mapSelect.value = town;
    mapStatus.textContent = `Lade ${town} …`;
    try {
      const mapData = await Api.getMapRender(town);
      // An uploaded map is never probed against CARLA (tests/probe_carla_lane_graph.py
      // only covers bundled towns), but the upload endpoint derives a lane
      // graph straight from the .xodr (backend/lane_graph_builder.py) — same
      // fetch toolbar.js uses for the normal map-select path. A build
      // failure server-side degrades to null here, same as any other miss.
      const laneGraph = await Api.getLaneGraph(town).catch(() => null);
      AppState.set({ map: town, mapData, laneGraph });
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

  fileInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await importXodr(file);
  });

  // ── Drag-and-drop on map canvas ─────────────────────────────────────────────

  let _dragCounter = 0;

  function _isXodrDrag(e) {
    return Array.from(e.dataTransfer.items || []).some(
      i => i.kind === 'file' && (i.type === '' || i.type.includes('xml') || i.type.includes('xodr'))
    );
  }

  mapContainer.addEventListener('dragenter', e => {
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

  mapContainer.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  mapContainer.addEventListener('drop', async e => {
    e.preventDefault();
    _dragCounter = 0;
    dropOverlay.classList.add('hidden');
    const file = e.dataTransfer.files[0];
    if (file) await importXodr(file);
  });

})();
