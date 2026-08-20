/**
 * toolbar.js — Tool palette buttons and map selector.
 * Sets AppState.activeTool when a tool is clicked.
 */
(function () {
  'use strict';

  const mapSelect = document.getElementById('map-select');
  const mapStatus = document.getElementById('map-status');
  const toolbar   = document.getElementById('toolbar');

  // Almost every town has a lane graph now — a probed one, or (Town10, any
  // uploaded map) one backend/lane_graph_builder.py derives from the .xodr
  // directly at startup/upload — so this always attempts the fetch rather
  // than gating on a town list snapshotted once at page load, which would
  // otherwise go stale the moment a map is uploaded mid-session. A genuine
  // miss (the builder itself failed for that town) still degrades cleanly:
  // Api.getLaneGraph resolves a 404 to null rather than throwing.
  async function _fetchLaneGraph(town) {
    return Api.getLaneGraph(town).catch(() => null);
  }

  // ── Tabs: Akteure | Requisiten ───────────────────────────────────────────────
  // Pure UI state, kept module-local like properties.js `_overviewPanelTab`.

  const propsPanel = toolbar.querySelector('[data-toolbar-panel="props"]');
  if (propsPanel && window.PropCatalog) PropCatalog.renderPanel(propsPanel);

  function setTab(name) {
    toolbar.querySelectorAll('[data-toolbar-tab]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.toolbarTab === name);
    });
    toolbar.querySelectorAll('[data-toolbar-panel]').forEach(panel => {
      panel.classList.toggle('hidden', panel.dataset.toolbarPanel !== name);
    });
  }

  // ── Tool buttons ─────────────────────────────────────────────────────────────
  // Delegated: prop tiles are rendered at load by PropCatalog, so a snapshot of
  // .tool-btn taken here would miss them.

  toolbar.addEventListener('click', e => {
    const tab = e.target.closest('[data-toolbar-tab]');
    if (tab) { setTab(tab.dataset.toolbarTab); return; }

    const btn = e.target.closest('.tool-btn');
    if (!btn) return;

    const tool = btn.dataset.tool;
    const prop = btn.dataset.prop || null;
    const isSame = AppState.activeTool === tool
      && (AppState.pendingProp || null) === prop;

    if (isSame) {
      AppState.set({ activeTool: null, pendingTemplate: null, pendingProp: null });
    } else {
      // Cancel trajectory mode if starting a new tool
      AppState.set({
        activeTool: tool, pendingTemplate: null, pendingProp: prop,
        trajectoryMode: false, activeTrajectoryId: null,
        routeMode: false, activeRouteId: null,
        activePathEventId: null,
      });
    }
  });

  // Update button active state when tool changes
  AppState.on('change', patch => {
    if (!('activeTool' in patch) && !('pendingProp' in patch)) return;
    toolbar.querySelectorAll('.tool-btn').forEach(btn => {
      const match = btn.dataset.tool === AppState.activeTool
        && (btn.dataset.prop || null) === (AppState.pendingProp || null);
      btn.classList.toggle('active', match);
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
      mapSelect.innerHTML = '<option value="">— Karte wählen —</option>';
      maps.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        mapSelect.appendChild(opt);
      });
    } catch (e) {
      mapStatus.textContent = 'Fehler beim Laden der Karten';
      console.error(e);
    }
  }

  mapSelect.addEventListener('change', async () => {
    const town = mapSelect.value;
    if (!town) return;

    mapStatus.textContent = `Lade ${town}…`;
    try {
      const mapData = await Api.getMapRender(town);
      const laneGraph = await _fetchLaneGraph(town);
      AppState.set({ map: town, mapData, laneGraph });
      MapView.renderMap(mapData);
      MapView.renderAllActors();
      mapStatus.textContent = `${town} (${mapData.roads.length} Straßen)`;
    } catch (e) {
      mapStatus.textContent = 'Karte konnte nicht geladen werden';
      console.error(e);
    }
  });

  // Restore map selector when state is loaded
  AppState.on('stateLoaded', async data => {
    if (data.map) {
      mapSelect.value = data.map;
      if (!AppState.mapData) {
        mapStatus.textContent = `Lade ${data.map}…`;
        try {
          const mapData = await Api.getMapRender(data.map);
          const laneGraph = await _fetchLaneGraph(data.map);
          AppState.set({ mapData, laneGraph });
          MapView.renderMap(mapData);
          MapView.renderAllActors();
          mapStatus.textContent = `${data.map} geladen`;
        } catch (e) {
          console.error(e);
        }
      }
    }
  });

  // Initialise map list on page load
  loadMapList();
})();
