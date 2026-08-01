/**
 * properties.js — Right panel showing properties of the selected actor.
 *
 * Handles:
 *   - x/y/z/yaw numeric inputs
 *   - NPC behavior checkboxes
 *   - Ego trajectory "Draw Path" button + waypoint list with velocity inputs
 *   - Delete button
 */
(function () {
  'use strict';

  // Elements
  const propsOverview = document.getElementById('props-overview');
  const propsContent = document.getElementById('props-content');
  const propsTitle   = document.getElementById('props-title');
  const propsDelete  = document.getElementById('props-delete');
  const trafficSignalPanel = document.getElementById('traffic-signal-panel');
  const btnAddTrafficEvent = document.getElementById('btn-add-traffic-event');
  const trafficSignalEventList = document.getElementById('traffic-signal-event-list');

  const propX = document.getElementById('prop-x');
  const propY = document.getElementById('prop-y');
  const propZ = document.getElementById('prop-z');
  const propYaw = document.getElementById('prop-yaw');

  const npcSection     = document.getElementById('props-npc-section');
  const behaviorPanel  = document.getElementById('behavior-panel');
  const behaviorBoxes  = document.querySelectorAll('#behavior-checkboxes input[type="checkbox"]');
  const triggerSection  = document.getElementById('trigger-section');
  const propTriggerDist = document.getElementById('prop-trigger-dist');
  const egoRouteHint   = document.getElementById('ego-route-hint');
  const pathSectionLabel = document.getElementById('path-section-label');
  const btnDrawPath    = document.getElementById('btn-draw-path');
  const btnClearPath   = document.getElementById('btn-clear-path');
  const btnTogglePath  = document.getElementById('btn-toggle-path');
  const waypointList   = document.getElementById('waypoint-list');
  const eventSection   = document.getElementById('event-section');

  // Track whether we're syncing to avoid loops
  let _syncing = false;
  let _overviewPanelTab = 'overview';

  // ── Render panel for selected actor ─────────────────────────────────────────

  function _renderOverviewPanel() {
    const activeTab = _overviewPanelTab === 'templates' ? 'templates' : 'overview';
    propsOverview.innerHTML = `
      <div class="props-info-tabs" role="tablist" aria-label="Panel ohne Auswahl">
        <button class="props-info-tab${activeTab === 'overview' ? ' active' : ''}" type="button" role="tab" aria-selected="${activeTab === 'overview'}" data-overview-tab="overview">Übersicht</button>
        <button class="props-info-tab${activeTab === 'templates' ? ' active' : ''}" type="button" role="tab" aria-selected="${activeTab === 'templates'}" data-overview-tab="templates">Templates</button>
      </div>
      <div class="props-info-tab-panel" role="tabpanel">
        ${activeTab === 'overview' ? _summaryHtml() : ScenarioTemplates.renderPanel()}
      </div>
    `;
    propsOverview.querySelectorAll('[data-overview-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        _overviewPanelTab = btn.dataset.overviewTab;
        _renderOverviewPanel();
      });
    });
    ScenarioTemplates.bindPanel(propsOverview);
    _bindCollapsibleHeaders(propsOverview);
  }

  function _summaryHtml() {
    const hasEgo = !!AppState.ego;
    const npcCount = AppState.npcs.length;
    const mapName = AppState.map || 'None';
    const withTraj = AppState.npcs.filter(n => (n.events || []).some(ev => {
      const action = ev.action || {};
      return (action.trajectory || action.waypoints || []).length >= 2;
    })).length;

    const npcBreakdown = {};
    AppState.npcs.forEach(n => { npcBreakdown[n.type] = (npcBreakdown[n.type] || 0) + 1; });

    let html = '<div class="scenario-summary">';
    html += '<h3>Szenario-Übersicht</h3>';
    html += `<div class="summary-row"><span class="label">Karte</span><span class="value">${mapName}</span></div>`;
    html += `<div class="summary-row"><span class="label">Ego-Fahrzeug</span><span class="value">${hasEgo ? 'Platziert' : 'Nicht platziert'}</span></div>`;
    html += `<div class="summary-row"><span class="label">NPCs</span><span class="value">${npcCount}</span></div>`;

    if (npcCount > 0) {
      html += '<div class="summary-section">NPC-Aufschlüsselung</div>';
      for (const [type, count] of Object.entries(npcBreakdown)) {
        html += `<div class="summary-row"><span class="label">${type}</span><span class="value">${count}</span></div>`;
      }
      html += `<div class="summary-row"><span class="label">Mit Trajektorie</span><span class="value">${withTraj}</span></div>`;
    }

    const props = AppState.staticObjects || [];
    html += `<div class="summary-row"><span class="label">Requisiten</span><span class="value">${props.length}</span></div>`;
    if (props.length > 0) {
      const propBreakdown = {};
      props.forEach(p => {
        const name = window.PropCatalog?.label(p.prop) || p.prop;
        propBreakdown[name] = (propBreakdown[name] || 0) + 1;
      });
      html += '<div class="summary-section">Requisiten-Aufschlüsselung</div>';
      for (const [name, count] of Object.entries(propBreakdown)) {
        html += `<div class="summary-row"><span class="label">${name}</span><span class="value">${count}</span></div>`;
      }
    }

    html += `<div class="summary-section">Wetter</div>`;
    html += `<div class="summary-row"><span class="label">Tageszeit</span><span class="value">${AppState.time}</span></div>`;
    const activeWeather = Object.entries(AppState.weather).filter(([, v]) => v > 0);
    if (activeWeather.length > 0) {
      activeWeather.forEach(([k, v]) => {
        html += `<div class="summary-row"><span class="label">${k.replace('_', ' ')}</span><span class="value">${v.toFixed(2)}</span></div>`;
      });
    } else {
      html += `<div class="summary-row"><span class="label">Bedingungen</span><span class="value">Klar</span></div>`;
    }

    html += '<div class="summary-hint">Akteur anklicken, um Eigenschaften zu bearbeiten<br>Drücken Sie <b>?</b> für Tastaturkürzel</div>';
    html += '</div>';

    return html;
  }

  function render() {
    const id    = AppState.selectedId;
    const actor = id ? AppState.findById(id) : null;
    const trafficLightId = AppState.selectedTrafficLightId;
    const trafficLight = trafficLightId ? TrafficSignals.mapSignalById(trafficLightId) : null;

    if (trafficLight) {
      _renderTrafficSignalPanel(trafficLight);
      return;
    }

    if (!actor) {
      propsOverview.classList.remove('hidden');
      propsContent.classList.add('hidden');
      if (trafficSignalPanel) trafficSignalPanel.classList.add('hidden');
      _renderOverviewPanel();
      return;
    }

    propsOverview.classList.add('hidden');
    propsContent.classList.remove('hidden');
    if (trafficSignalPanel) trafficSignalPanel.classList.add('hidden');
    if (propsDelete) propsDelete.classList.remove('hidden');
    document.getElementById('spawn-panel')?.classList.remove('hidden');

    // Title
    propsTitle.textContent = AppState.actorLabel(actor, { ego: 'Ego-Fahrzeug' });

    // Position / yaw
    _syncing = true;
    propX.value   = actor.x   != null ? actor.x.toFixed(2)   : '';
    propY.value   = actor.y   != null ? actor.y.toFixed(2)    : '';
    propZ.value   = actor.z   != null ? actor.z.toFixed(2)    : '0.20';
    propYaw.value = actor.yaw != null ? Math.round(actor.yaw) : '0';
    _syncing = false;

    // Type pickers — swap an actor's type / a prop's blueprint in place
    _renderActorTypeRow(actor);
    _renderPropTypeRow(actor);

    // NPC + Ego trajectory section (show for all scenario actors)
    const isScenarioActor = !AppState.isProp(actor);
    const isNpc = isScenarioActor && actor.type !== 'ego';
    npcSection.classList.toggle('hidden', !isScenarioActor);

    if (isScenarioActor) {
      // Behavior checkboxes — only for NPCs (hide for ego)
      const behaviorSection = document.getElementById('behavior-checkboxes');
      if (behaviorSection) behaviorSection.style.display = isNpc ? '' : 'none';
      if (behaviorPanel) behaviorPanel.classList.toggle('hidden', !isNpc);

      // Trigger distance — only for NPCs
      triggerSection.style.display = isNpc ? '' : 'none';
      eventSection.classList.toggle('hidden', !isNpc);

      pathSectionLabel.classList.toggle('hidden', isNpc);
      btnDrawPath.textContent = 'Zeichnen';
      btnClearPath.textContent = 'Löschen';
      btnDrawPath.parentElement.classList.toggle('hidden', isNpc);
      waypointList.classList.toggle('hidden', isNpc);
      const hasEgoPath = !isNpc && (actor.trajectory || []).length > 0;
      btnTogglePath.classList.toggle('hidden', !hasEgoPath);
      btnClearPath.classList.toggle('hidden', !hasEgoPath);

      // Ego keeps the original trajectory-only route hint.
      egoRouteHint.classList.toggle('hidden', actor.type !== 'ego');

      if (isNpc) {
        _syncing = true;
        behaviorBoxes.forEach(cb => {
          cb.checked = (actor.behaviors || []).includes(cb.value);
        });
        propTriggerDist.value = actor.trigger_distance ?? 400;
        _syncing = false;
      }

      // Toggle path visibility button state
      const pathVisible = MapView.isTrajectoryVisible(actor.id);
      btnTogglePath.textContent = pathVisible ? 'Ausblenden' : 'Einblenden';

      // Waypoint list: ego uses the original global editor; NPCs edit paths inside events.
      if (!isNpc) {
        EventPanel.renderPathList(actor, 'trajectory', waypointList, null);
      } else {
        waypointList.innerHTML = '';
      }

      if (isNpc) {
        EventPanel.render(actor);
      }
    }
  }

  function _renderTrafficSignalPanel(tl) {
    const action = TrafficSignals.actionById(tl.id);
    propsOverview.classList.add('hidden');
    propsContent.classList.remove('hidden');
    propsTitle.textContent = `Ampel ${tl.id}`;
    if (propsDelete) propsDelete.classList.add('hidden');
    document.getElementById('spawn-panel')?.classList.add('hidden');
    npcSection.classList.add('hidden');
    if (trafficSignalPanel) trafficSignalPanel.classList.remove('hidden');
    _renderTrafficSignalEvents(tl, action);
  }

  function _defaultTrafficSignalEvent(action) {
    const events = action?.events || [];
    const idx = UIUtils.nextIndexedId(events, 'traffic-event');
    return {
      id: `traffic-event-${idx}`,
      trigger_distance: 40,
      state: 'red',
    };
  }

  function _renderTrafficSignalEvents(tl, action) {
    if (!trafficSignalEventList) return;
    trafficSignalEventList.innerHTML = '';
    const events = action?.events || [];
    if (events.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'event-empty';
      empty.textContent = 'Noch keine Events definiert.';
      trafficSignalEventList.appendChild(empty);
      return;
    }

    events.forEach(ev => {
      const card = document.createElement('div');
      card.className = 'event-card traffic-event-card';

      const header = document.createElement('div');
      header.className = 'event-card-header traffic-event-header';

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'event-delete';
      deleteBtn.type = 'button';
      deleteBtn.textContent = '×';
      deleteBtn.title = 'Event löschen';
      deleteBtn.addEventListener('click', () => _deleteTrafficSignalEvent(tl.id, ev.id));

      header.appendChild(_trafficStatePicker(tl.id, ev));
      header.appendChild(deleteBtn);
      card.appendChild(header);

      const distanceInput = document.createElement('input');
      distanceInput.type = 'number';
      distanceInput.min = '0';
      distanceInput.step = '1';
      distanceInput.value = ev.trigger_distance ?? 40;
      distanceInput.addEventListener('change', e => {
        _updateTrafficSignalEvent(tl.id, ev.id, {
          trigger_distance: Math.max(0, parseFloat(e.target.value) || 0),
        });
      });
      card.appendChild(UIUtils.paramRow('Ego <=', distanceInput, 'm'));

      trafficSignalEventList.appendChild(card);
    });
  }

  function _trafficStatePicker(signalId, ev) {
    const current = ['red', 'yellow', 'green'].includes(ev.state) ? ev.state : 'red';
    const wrap = document.createElement('div');
    wrap.className = 'traffic-state-picker';
    [
      ['red', 'Rot'],
      ['yellow', 'Gelb'],
      ['green', 'Grün'],
    ].forEach(([state, title]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `traffic-state-option ${state}${state === current ? ' active' : ''}`;
      btn.dataset.state = state;
      btn.title = title;
      btn.addEventListener('click', () => _updateTrafficSignalEvent(signalId, ev.id, { state }));
      wrap.appendChild(btn);
    });
    return wrap;
  }

  function _updateTrafficSignalEvent(signalId, eventId, patch) {
    const signal = TrafficSignals.actionById(signalId);
    if (!signal) return;
    const events = (signal.events || []).map(ev => (
      ev.id === eventId ? { ...ev, ...patch } : ev
    ));
    TrafficSignals.update(signalId, { events });
  }

  function _deleteTrafficSignalEvent(signalId, eventId) {
    const signal = TrafficSignals.actionById(signalId);
    if (!signal) return;
    const events = (signal.events || []).filter(ev => ev.id !== eventId);
    TrafficSignals.update(signalId, { events });
  }

  function _bindCollapsibleHeaders(root) {
    root.querySelectorAll('.collapsible-header[data-collapse-target]').forEach(header => {
      if (header.dataset.collapseBound === 'true') return;
      header.dataset.collapseBound = 'true';
      header.addEventListener('click', e => {
        if (e.target.closest('input, select, button:not(.collapsible-header)')) return;
        const targetId = header.dataset.collapseTarget;
        const target = targetId ? document.getElementById(targetId) : null;
        const section = target ? target.closest('.collapsible-section') : null;
        if (!section) return;
        section.classList.toggle('collapsed');
        const indicator = header.querySelector('.collapse-indicator');
        if (indicator) indicator.textContent = section.classList.contains('collapsed') ? '+' : '-';
      });
    });
  }

  // ── Input → state bindings ───────────────────────────────────────────────────

  function _onPosChange() {
    if (_syncing) return;
    const id = AppState.selectedId;
    if (!id) return;
    const actor = AppState.findById(id);
    if (!actor) return;
    // Fall back to the object's own values, not literals: a prop's correct z is
    // often 0.0, and a hardcoded 0.2 default would silently lift it off the road.
    const num = (raw, fallback) => {
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n : fallback;
    };
    AppState.updateById(id, {
      x:   num(propX.value,   actor.x ?? 0),
      y:   num(propY.value,   actor.y ?? 0),
      z:   num(propZ.value,   actor.z ?? 0),
      yaw: num(propYaw.value, actor.yaw ?? 0),
    });
  }

  [propX, propY, propZ, propYaw].forEach(inp => {
    inp.addEventListener('change', _onPosChange);
  });

  // ── Actor type ───────────────────────────────────────────────────────────────

  const actorTypeRow    = document.getElementById('actor-type-row');
  const actorTypeSelect = document.getElementById('actor-type-select');

  function _renderActorTypeRow(actor) {
    if (!actorTypeRow || !actorTypeSelect) return;
    const group = actor ? AppState.switchGroupFor(actor.type) : null;
    actorTypeRow.classList.toggle('hidden', !group);
    if (!group) return;

    // Rebuilt per render, not once like the prop select: the option set depends
    // on which group the selected actor is in.
    actorTypeSelect.innerHTML = '';
    const sections = AppState.ACTOR_TYPE_GROUPS.find(g => g.id === group).sections;
    for (const section of sections) {
      // A single-section group needs no optgroup heading.
      const parent = sections.length > 1
        ? actorTypeSelect.appendChild(document.createElement('optgroup'))
        : actorTypeSelect;
      if (parent !== actorTypeSelect) parent.label = section.label;
      for (const { type, label } of section.types) {
        const opt = document.createElement('option');
        opt.value = type;
        opt.textContent = label;
        parent.appendChild(opt);
      }
    }
    _syncing = true;
    actorTypeSelect.value = actor.type;
    _syncing = false;
  }

  actorTypeSelect?.addEventListener('change', () => {
    if (_syncing) return;
    const id = AppState.selectedId;
    if (!id) return;
    // switchActorType re-checks the group itself and is a no-op if not allowed.
    if (!AppState.switchActorType(id, actorTypeSelect.value)) {
      render();   // resync the select back to the actor's unchanged type
      return;
    }
    MapView.renderAllActors();
    render();
  });

  // ── Prop type ────────────────────────────────────────────────────────────────

  const propTypeRow    = document.getElementById('prop-type-row');
  const propTypeSelect = document.getElementById('prop-type-select');

  function _renderPropTypeRow(actor) {
    if (!propTypeRow || !propTypeSelect) return;
    const isProp = AppState.isProp(actor);
    propTypeRow.classList.toggle('hidden', !isProp);
    if (!isProp || !window.PropCatalog) return;

    if (!propTypeSelect.options.length) {
      for (const group of PropCatalog.GROUPS) {
        const ids = PropCatalog.ids().filter(id => PropCatalog.get(id).group === group.id);
        if (!ids.length) continue;
        const og = document.createElement('optgroup');
        og.label = group.label;
        for (const id of ids) {
          const opt = document.createElement('option');
          opt.value = id;
          opt.textContent = PropCatalog.label(id);
          og.appendChild(opt);
        }
        propTypeSelect.appendChild(og);
      }
    }
    _syncing = true;
    propTypeSelect.value = actor.prop || '';
    _syncing = false;
  }

  propTypeSelect?.addEventListener('change', () => {
    if (_syncing) return;
    const id = AppState.selectedId;
    if (!id || !AppState.isProp(id)) return;
    const next = propTypeSelect.value;
    if (!window.PropCatalog?.get(next)) return;
    AppState.updateById(id, { prop: next, z: PropCatalog.defaultZ(next) });
    MapView.renderAllActors();
    render();
  });

  behaviorBoxes.forEach(cb => {
    cb.addEventListener('change', () => {
      if (_syncing) return;
      const id = AppState.selectedId;
      if (!id) return;
      const behaviors = Array.from(behaviorBoxes)
        .filter(b => b.checked)
        .map(b => b.value);
      AppState.updateById(id, { behaviors });
    });
  });

  // ── Trigger distance ─────────────────────────────────────────────────────────

  propTriggerDist.addEventListener('change', () => {
    if (_syncing) return;
    const id = AppState.selectedId;
    if (!id) return;
    const val = Math.max(5, Math.min(1000, parseFloat(propTriggerDist.value) || 400));
    propTriggerDist.value = val;
    AppState.updateById(id, { trigger_distance: val });
  });

  btnAddTrafficEvent.addEventListener('click', () => {
    const id = AppState.selectedTrafficLightId;
    if (!id) return;
    const signal = TrafficSignals.actionById(id);
    if (!signal) return;
    const events = [...(signal.events || []), _defaultTrafficSignalEvent(signal)];
    TrafficSignals.update(id, { events });
  });

  // ── Ego path buttons ─────────────────────────────────────────────────────────

  btnDrawPath.addEventListener('click', () => {
    const id = AppState.selectedId;
    if (!id) return;
    ObjectsManager.startPathMode(id, 'trajectory');
  });

  btnClearPath.addEventListener('click', () => {
    const id = AppState.selectedId;
    if (!id) return;
    ObjectsManager.clearPath(id, 'trajectory');
    render();
  });

  btnTogglePath.addEventListener('click', () => {
    const id = AppState.selectedId;
    if (!id) return;
    MapView.toggleTrajectoryVisibility(id);
    const visible = MapView.isTrajectoryVisible(id);
    btnTogglePath.textContent = visible ? 'Ausblenden' : 'Einblenden';
  });

  // ── Delete ──────────────────────────────────────────────────────────────────

  propsDelete.addEventListener('click', async () => {
    const id = AppState.selectedId;
    if (!id) return;
    const actor = AppState.findById(id);
    if (!actor) return;
    const label = AppState.actorLabel(actor, { ego: 'Ego-Fahrzeug' });
    const ok = await Confirm.show(`${label} l\u00f6schen?`, 'L\u00f6schen');
    if (!ok) return;
    UndoStack.push({ action: 'delete', actor: JSON.parse(JSON.stringify(actor)) });
    AppState.removeById(id);
    MapView.renderAllActors();
    render();
    Toast.info(`${label} gel\u00f6scht \u2014 Strg+Z zum R\u00fcckg\u00e4ngigmachen`);
  });

  EventPanel.setRefreshHandler(render);

  // ── Listen for state changes ─────────────────────────────────────────────────

  AppState.on('selectionChanged', () => render());
  AppState.on('trafficSignalSelected', () => render());
  AppState.on('trafficSignalUpdated', () => render());
  AppState.on('actorUpdated',     id => {
    if (id === AppState.selectedId) render();
    else if (!AppState.selectedId) _renderOverviewPanel();
  });
  AppState.on('actorRemoved',     () => render());
  AppState.on('stateLoaded',      () => render());
  AppState.on('change',           patch => {
    if (!AppState.selectedId && ('weather' in patch || 'time' in patch)) _renderOverviewPanel();
    if ('triggerPointMode' in patch) {
      const drawing = AppState.triggerPointMode ||
        (AppState.trajectoryMode && AppState.activeTrajectoryId) ||
        (AppState.routeMode && AppState.activeRouteId);
      MapView.svg.classList.toggle('trajectory-mode', !!drawing);
    }
  });

  _bindCollapsibleHeaders(document);

  // Render initial summary on load
  _renderOverviewPanel();
})();
