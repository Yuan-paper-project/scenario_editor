/**
 * toolbar.js — the tool palette (Akteure | Requisiten) and the map selector.
 */
(() => {
  'use strict';

  const mapSelect = document.getElementById('map-select');
  const mapStatus = document.getElementById('map-status');
  const toolbar = document.getElementById('toolbar');

  // Always fetched: nearly every town has a graph (probed or xodr-derived, uploads included);
  // a miss resolves to null.
  async function _fetchLaneGraph(town) {
    return Api.getLaneGraph(town).catch(() => null);
  }

  // ── Tabs: Akteure | Requisiten ───────────────────────────────────────────────

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
  // Delegated: the prop tiles are rendered later, so a snapshot of .tool-btn would miss them.

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

  AppState.on('change', (patch) => {
    if (!('activeTool' in patch) && !('pendingProp' in patch) && !('pendingGenerate' in patch)) return;
    toolbar.querySelectorAll('.tool-btn').forEach((btn) => {
      const match =
        btn.dataset.tool === AppState.activeTool && (btn.dataset.prop || null) === (AppState.pendingProp || null);
      btn.classList.toggle('active', match);
    });
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

  // Town buttons on the empty map; they go through the dropdown, the single source of truth.
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
    // The batch generator swaps maps itself and restores its scenario: no parking then.
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

  // On load, re-fetch the geometry when the file is for another town than the one shown.
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
  // Strg/Cmd skips the confirm. Undoable.
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

  loadMapList();
})();
