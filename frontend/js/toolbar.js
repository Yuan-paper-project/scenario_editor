/**
 * toolbar.js — Tool palette buttons and map selector.
 * Sets AppState.activeTool when a tool is clicked.
 */
(function () {
  'use strict';

  const mapSelect   = document.getElementById('map-select');
  const mapStatus   = document.getElementById('map-status');
  const toolButtons = document.querySelectorAll('.tool-btn');

  // ── Tool buttons ─────────────────────────────────────────────────────────────

  toolButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      if (AppState.activeTool === tool) {
        // Toggle off
        AppState.set({ activeTool: null });
      } else {
        // Cancel trajectory mode if starting a new tool
        AppState.set({ activeTool: tool, trajectoryMode: false, activeTrajectoryId: null });
      }
    });
  });

  // Update button active state when tool changes
  AppState.on('change', patch => {
    if (!('activeTool' in patch)) return;
    toolButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === AppState.activeTool);
    });
    // Update cursor
    const svg = MapView.svg;
    if (AppState.activeTool) {
      svg.classList.add('placing');
    } else {
      svg.classList.remove('placing');
    }
  });

  // ── Map selector ──────────────────────────────────────────────────────────────

  async function loadMapList() {
    try {
      const { maps } = await Api.getMaps();
      mapSelect.innerHTML = '<option value="">— Select Map —</option>';
      maps.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        mapSelect.appendChild(opt);
      });
    } catch (e) {
      mapStatus.textContent = 'Error loading maps';
      console.error(e);
    }
  }

  mapSelect.addEventListener('change', async () => {
    const town = mapSelect.value;
    if (!town) return;

    mapStatus.textContent = `Loading ${town}…`;
    try {
      const mapData = await Api.getMapRender(town);
      AppState.set({ map: town, mapData });
      MapView.renderMap(mapData);
      MapView.renderAllActors();
      mapStatus.textContent = `${town} (${mapData.roads.length} roads)`;
    } catch (e) {
      mapStatus.textContent = 'Failed to load map';
      console.error(e);
    }
  });

  // Restore map selector when state is loaded
  AppState.on('stateLoaded', async data => {
    if (data.map) {
      mapSelect.value = data.map;
      if (!AppState.mapData) {
        mapStatus.textContent = `Loading ${data.map}…`;
        try {
          const mapData = await Api.getMapRender(data.map);
          AppState.set({ mapData });
          MapView.renderMap(mapData);
          MapView.renderAllActors();
          mapStatus.textContent = `${data.map} loaded`;
        } catch (e) {
          console.error(e);
        }
      }
    }
  });

  // Initialise map list on page load
  loadMapList();
})();
