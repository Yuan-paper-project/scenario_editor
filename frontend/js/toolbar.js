/**
 * toolbar.js — Tool palette buttons and map selector.
 * Sets AppState.activeTool when a tool is clicked.
 */
(function () {
  'use strict';

  const mapSelect = document.getElementById('map-select');
  const mapStatus = document.getElementById('map-status');
  const toolbar = document.getElementById('toolbar');

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
    toolbar.querySelectorAll('[data-toolbar-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.toolbarTab === name);
    });
    toolbar.querySelectorAll('[data-toolbar-panel]').forEach((panel) => {
      panel.classList.toggle('hidden', panel.dataset.toolbarPanel !== name);
    });
  }

  // ── Tool buttons ─────────────────────────────────────────────────────────────
  // Delegated: prop tiles are rendered at load by PropCatalog, so a snapshot of
  // .tool-btn taken here would miss them.

  toolbar.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-toolbar-tab]');
    if (tab) {
      setTab(tab.dataset.toolbarTab);
      return;
    }

    const btn = e.target.closest('.tool-btn');
    if (!btn) return;

    const tool = btn.dataset.tool;
    const prop = btn.dataset.prop || null;
    const isSame = AppState.activeTool === tool && (AppState.pendingProp || null) === prop;

    if (isSame) {
      AppState.set({ activeTool: null, pendingTemplate: null, pendingProp: null });
    } else {
      // Cancel trajectory mode if starting a new tool
      AppState.set({
        activeTool: tool,
        pendingTemplate: null,
        pendingProp: prop,
        trajectoryMode: false,
        activeTrajectoryId: null,
        routeMode: false,
        activeRouteId: null,
        activePathEventId: null,
      });
    }
  });

  // Update button active state when tool changes
  AppState.on('change', (patch) => {
    if (!('activeTool' in patch) && !('pendingProp' in patch) && !('pendingGenerate' in patch)) return;
    toolbar.querySelectorAll('.tool-btn').forEach((btn) => {
      const match =
        btn.dataset.tool === AppState.activeTool && (btn.dataset.prop || null) === (AppState.pendingProp || null);
      btn.classList.toggle('active', match);
    });
    // Update cursor
    const svg = MapView.svg;
    if (AppState.activeTool || AppState.pendingGenerate) {
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
      maps.forEach((name) => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        mapSelect.appendChild(opt);
      });
      _renderQuickPick(maps);
    } catch (e) {
      mapStatus.textContent = 'Fehler beim Laden der Karten';
      console.error(e);
    }
  }

  // One-click town buttons on the empty map — the same path as the dropdown,
  // which stays the source of truth (it is what a loaded file writes back).
  function _renderQuickPick(maps) {
    const pick = document.getElementById('map-quick-pick');
    if (!pick) return;
    pick.innerHTML = '';
    maps.forEach((name) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'map-quick-btn';
      b.textContent = name;
      b.addEventListener('click', () => {
        mapSelect.value = name;
        mapSelect.dispatchEvent(new Event('change'));
      });
      pick.appendChild(b);
    });
  }

  mapSelect.addEventListener('change', async () => {
    const town = mapSelect.value;
    // The batch generator swaps maps under a scenario it saved and puts back
    // itself (scenarioGenerator.js _loadMap) — that switch must not park it.
    const keepScenario = mapSelect.dataset.keepScenario === '1';
    delete mapSelect.dataset.keepScenario;
    if (!town) {
      mapSelect.value = AppState.map || '';
      return;
    }
    const switching = !keepScenario && town !== AppState.map;

    mapStatus.textContent = `Lade ${town}…`;
    try {
      const mapData = await Api.getMapRender(town);
      const laneGraph = await _fetchLaneGraph(town);
      // Each town keeps its own scenario (UIUtils.leaveMap / enterMap): the
      // one being left is parked, the one arrived at comes back or is empty.
      if (switching) UIUtils.leaveMap();
      AppState.set({ map: town, mapData, laneGraph });
      const restored = switching && UIUtils.enterMap(town);
      MapView.renderMap(mapData);
      MapView.renderAllActors();
      mapStatus.textContent = `${mapData.roads.length} Straßen`;
      if (restored) Toast.info(`Szenario auf ${town} wiederhergestellt`);
    } catch (e) {
      mapStatus.textContent = 'Karte konnte nicht geladen werden';
      mapSelect.value = AppState.map || '';
      console.error(e);
    }
  });

  // Mark the towns that hold a parked scenario in the selector: „Town03 ●".
  const PARKED_MARK = ' ●';
  function _markParkedTowns() {
    const parked = new Set(UIUtils.parkedTowns());
    for (const opt of mapSelect.options) {
      if (!opt.value) continue;
      const base = opt.textContent.replace(/ ●$/, '');
      opt.textContent = parked.has(opt.value) ? base + PARKED_MARK : base;
      opt.title = parked.has(opt.value) ? 'Auf dieser Karte liegt ein Szenario — Wechsel holt es zurück' : '';
    }
  }
  AppState.on('mapScenariosChanged', _markParkedTowns);

  // Restore map selector when state is loaded. The geometry is re-fetched when
  // the file is for another town than the one on screen — it used to be
  // fetched only when none was loaded, so a Town05 file opened over Town03
  // drew its actors on Town03's roads.
  AppState.on('stateLoaded', async (data) => {
    if (data.map) {
      mapSelect.value = data.map;
      if (!AppState.mapData || AppState.mapData.town !== data.map) {
        mapStatus.textContent = `Lade ${data.map}…`;
        try {
          const mapData = await Api.getMapRender(data.map);
          const laneGraph = await _fetchLaneGraph(data.map);
          AppState.set({ mapData, laneGraph });
          MapView.renderMap(mapData);
          MapView.renderAllActors();
          mapStatus.textContent = `${mapData.roads.length} Straßen`;
        } catch (e) {
          console.error(e);
        }
      }
    }
  });

  // ── Datei → Neues Szenario ─────────────────────────────────────────────────
  // Strg/Cmd skips the confirm, as on every other delete in the app. Undoable.
  document.getElementById('btn-new-scenario')?.addEventListener('click', async (e) => {
    if (!AppState.hasScenarioContent) {
      Toast.info('Das Szenario ist bereits leer');
      return;
    }
    const skip = e.ctrlKey || e.metaKey;
    if (
      !skip &&
      !(await Confirm.show(
        `Alles auf ${AppState.map || 'dieser Karte'} entfernen? Ego, NPCs, Requisiten und ` +
          'Ampelschaltungen werden gelöscht (Strg+Z holt sie zurück).',
        'Alles entfernen',
      ))
    )
      return;
    window.Simulate?.stop();
    AppState.clearScenario();
    Toast.success('Szenario geleert');
  });

  // Initialise map list on page load
  loadMapList();
})();
