/**
 * properties.js — Right panel showing properties of the selected actor.
 *
 * Handles:
 *   - x/y/z/yaw numeric inputs
 *   - Delete button
 *
 * Events are identical for ego and NPCs — rendering the event section itself
 * (path drawing, action/trigger cards) is eventPanel.js's job, called
 * uniformly via EventPanel.render(actor).
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
  const propZAuto = document.getElementById('prop-z-auto');
  const propInitSpeed      = document.getElementById('prop-init-speed');
  const propInitSpeedLabel = document.getElementById('prop-init-speed-label');

  const npcSection     = document.getElementById('props-npc-section');

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
    const withTraj = [AppState.ego, ...AppState.npcs]
      .filter(Boolean)
      .filter(a => AppState.pathPointsOf(a).length >= 2).length;

    const npcBreakdown = {};
    AppState.npcs.forEach(n => { npcBreakdown[n.type] = (npcBreakdown[n.type] || 0) + 1; });

    let html = '<div class="scenario-summary">';
    html += '<h3>Szenario-Übersicht</h3>';
    html += `<div class="summary-row"><span class="label">Karte</span><span class="value">${mapName}</span></div>`;
    html += `<div class="summary-row"><span class="label">Ego-Fahrzeug</span><span class="value">${hasEgo ? 'Platziert' : 'Nicht platziert'}</span></div>`;
    html += `<div class="summary-row"><span class="label">NPCs</span><span class="value">${npcCount}</span></div>`;
    html += `<div class="summary-row"><span class="label">Akteure mit Pfad</span><span class="value">${withTraj}</span></div>`;

    if (npcCount > 0) {
      html += '<div class="summary-section">NPC-Aufschlüsselung</div>';
      for (const [type, count] of Object.entries(npcBreakdown)) {
        html += `<div class="summary-row"><span class="label">${type}</span><span class="value">${count}</span></div>`;
      }
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

    // The ego is a scenario actor with the entity name 'hero', not a special
    // case; a prop is a <MiscObject> and has no speed or events at all.
    const isScenarioActor = !AppState.isProp(actor);

    // Position / yaw / start speed
    _syncing = true;
    propX.value   = actor.x   != null ? actor.x.toFixed(2)   : '';
    propY.value   = actor.y   != null ? actor.y.toFixed(2)    : '';
    propZ.value   = actor.z   != null ? actor.z.toFixed(2)    : '0.20';
    propYaw.value = actor.yaw != null ? Math.round(actor.yaw) : '0';
    propInitSpeed.value = (actor.initial_speed ?? 0).toFixed(1);
    _syncing = false;

    // .props-group is a bare 2-column grid with no per-row wrapper, so the
    // label and the input have to be hidden individually.
    propInitSpeed.classList.toggle('hidden', !isScenarioActor);
    propInitSpeedLabel.classList.toggle('hidden', !isScenarioActor);

    // Type pickers — swap an actor's type / a prop's blueprint in place
    _renderActorTypeRow(actor);
    _renderPropTypeRow(actor);

    // Events: identical for ego and NPCs.
    npcSection.classList.toggle('hidden', !isScenarioActor);

    if (isScenarioActor) {
      EventPanel.render(actor);
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
        const collapsed = section.classList.contains('collapsed');
        const indicator = header.querySelector('.collapse-indicator');
        if (indicator) indicator.textContent = collapsed ? '+' : '-';
        header.setAttribute('aria-expanded', String(!collapsed));
      });
    });
  }

  // ── Input → state bindings ───────────────────────────────────────────────────

  function _onPosChange(e) {
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
    const patch = {
      x:   num(propX.value,   actor.x ?? 0),
      y:   num(propY.value,   actor.y ?? 0),
      z:   num(propZ.value,   actor.z ?? 0),
      yaw: num(propYaw.value, actor.yaw ?? 0),
    };
    // Typing a new X/Y moves the object, so its height is re-derived exactly as
    // it would be by a drag. Keyed on which input fired so this never fights a
    // user typing into the Z box itself — a hand-set z survives until the object
    // is next moved.
    if (e?.target === propX || e?.target === propY) {
      patch.z = ObjectsManager.surfaceZFor(actor.type, patch.x, patch.y, actor.prop);
    }
    AppState.updateById(id, patch);
  }

  [propX, propY, propZ, propYaw].forEach(inp => {
    inp.addEventListener('change', _onPosChange);
  });

  // z is normally derived from the elevation profile on every move, so a
  // hand-typed value is sticky until the object is next moved — with no way
  // back to the surface height short of nudging it. This is that way back.
  // It is a button rather than an always-on indicator on purpose: the derived
  // value comes from _nearestLaneProjection, a linear scan over every lane
  // segment, and a drag re-renders this panel on every mousemove.
  propZAuto?.addEventListener('click', () => {
    const id = AppState.selectedId;
    if (!id) return;
    const actor = AppState.findById(id);
    if (!actor) return;
    AppState.updateById(id, {
      z: ObjectsManager.surfaceZFor(actor.type, actor.x, actor.y, actor.prop),
    });
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
    // defaultZ is an offset from the road surface, so the swap re-derives the
    // absolute height rather than dropping the prop to the catalogue value.
    const p = AppState.findById(id);
    AppState.updateById(id, {
      prop: next,
      z: ObjectsManager.surfaceZFor('prop', p.x, p.y, next),
    });
    MapView.renderAllActors();
    render();
  });

  // ── Start speed ──────────────────────────────────────────────────────────────

  // Emitted as a SpeedAction in the Storyboard Init, so it is the actor's speed
  // on tick 1 — before any Act's SimulationTime>0 start trigger. The first
  // set_speed / follow_trajectory event to fire overwrites it. An actor with
  // events: [] gets no Act at all, so for it this is the only speed it ever
  // has: 0 emits nothing and leaves it parked.
  propInitSpeed.addEventListener('change', () => {
    if (_syncing) return;
    const id = AppState.selectedId;
    if (!id) return;
    // Floor at 0 rather than allowing a negative: ScenarioRunner's
    // _get_actor_speed raises on a negative AbsoluteTargetSpeed in Init.
    const val = Math.max(0, Math.min(100, parseFloat(propInitSpeed.value) || 0));
    propInitSpeed.value = val.toFixed(1);
    AppState.updateById(id, { initial_speed: val });
  });

  btnAddTrafficEvent.addEventListener('click', () => {
    const id = AppState.selectedTrafficLightId;
    if (!id) return;
    const signal = TrafficSignals.actionById(id);
    if (!signal) return;
    const events = [...(signal.events || []), _defaultTrafficSignalEvent(signal)];
    TrafficSignals.update(id, { events });
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
    // Entering or leaving a draw mode changes which event card is marked as the
    // one the map clicks belong to (eventPanel.js `active-draw`).
    if (AppState.selectedId && ('activePathEventId' in patch || 'triggerPointMode' in patch)) {
      render();
    }
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
