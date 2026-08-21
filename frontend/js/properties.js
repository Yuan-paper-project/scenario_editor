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

  // Scene-list state. Both live here rather than in the DOM because
  // _renderOverviewPanel rebuilds its innerHTML wholesale on every change — a
  // collapsed section would spring back open the moment a prop was placed.
  const _sceneCollapsed = { npcs: false, props: false };
  let _locatedId = null;
  // Which instance each prop type's stepper is pointing at, keyed by blueprint
  // id. Clamped at render time rather than on delete: props are also added and
  // removed from the map and the toolbar, which never touch this.
  const _propCursor = {};

  const TRASH_SVG = `
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.5 2h3M2.5 4.5h11M4.5 4.5l.7 8.2a1 1 0 0 0 1 .8h3.6a1 1 0 0 0 1-.8l.7-8.2M6.7 7v4M9.3 7v4"
            fill="none" stroke="currentColor" stroke-width="1.3"
            stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

  function _esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

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
    _bindSceneList(propsOverview);
  }

  function _summaryHtml() {
    const mapName = AppState.map || 'Keine';
    const withTraj = [AppState.ego, ...AppState.npcs]
      .filter(Boolean)
      .filter(a => AppState.pathPointsOf(a).length >= 2).length;

    let html = '<div class="scenario-summary">';
    html += '<h3>Szenario-Übersicht</h3>';
    html += `<div class="summary-row"><span class="label">Karte</span><span class="value">${_esc(mapName)}</span></div>`;
    // The ego/NPC/prop counts that used to sit here are in the scene list below,
    // which shows the same numbers and lets you reach the objects behind them.
    html += `<div class="summary-row"><span class="label">Akteure mit Pfad</span><span class="value">${withTraj}</span></div>`;

    html += _sceneListHtml();

    html += `<div class="summary-section">Wetter</div>`;
    html += `<div class="summary-row"><span class="label">Tageszeit</span><span class="value">${_esc(AppState.timeLabel(AppState.time))}</span></div>`;
    const activeWeather = Object.entries(AppState.weather).filter(([, v]) => v > 0);
    if (activeWeather.length > 0) {
      activeWeather.forEach(([k, v]) => {
        html += `<div class="summary-row"><span class="label">${_esc(AppState.weatherLabel(k))}</span><span class="value">${v.toFixed(2)}</span></div>`;
      });
    } else {
      html += `<div class="summary-row"><span class="label">Bedingungen</span><span class="value">Klar</span></div>`;
    }

    html += '<div class="summary-hint">Klick zeigt das Objekt auf der Karte<br>'
          + 'Doppelklick (oder <b>Enter</b>) öffnet es<br>'
          + 'Bei Requisiten: <b>◀ ▶</b> blättert durch die Instanzen<br>'
          + 'Drücken Sie <b>?</b> für Tastaturkürzel</div>';
    html += '</div>';

    return html;
  }

  // ── Scene list ──────────────────────────────────────────────────────────────
  //
  // The map draws actors at true world size, so at the town view a car is a
  // handful of pixels and there is no practical way to click one — this list is
  // the way to reach an actor, and MapView.focusActor is the way to see it.

  /** One clickable row per scenario actor. */
  function _sceneRowHtml(actor) {
    const col = MapView.actorColor(actor.type);
    const round = _isWalker(actor.type);   // matches how the map draws it
    const events = (actor.events || []).length;
    const problems = ScenarioRules.problemsOf(actor).length;
    const warn = problems > 0
      ? `<span class="event-warn" title="${problems} Event(s) würden beim Export verworfen">${problems}</span>`
      : '';
    const label = AppState.actorLabel(actor, { short: true });
    return `
      <div class="scene-row${_locatedId === actor.id ? ' located' : ''}"
           role="option" tabindex="0" aria-selected="false"
           data-scene-id="${_esc(actor.id)}"
           title="Klick: auf der Karte zeigen · Doppelklick: bearbeiten">
        <span class="scene-swatch${round ? ' round' : ''}" style="background:${_esc(col.body)}"></span>
        <span class="scene-name">${_esc(label)}</span>
        <span class="scene-meta">${events} Event${events === 1 ? '' : 's'}</span>
        ${warn}
        <button type="button" class="scene-del" data-scene-del="${_esc(actor.id)}"
                title="${_esc(label)} löschen (Strg: ohne Rückfrage)"
                aria-label="${_esc(label)} löschen">${TRASH_SVG}</button>
      </div>`;
  }

  // Mirrors mapView.js WALKER_TYPES — only to pick a round swatch over a square
  // one, so a drift here is cosmetic rather than the usual two-tables trap.
  function _isWalker(type) {
    return type === 'pedestrian' || type === 'child' || type === 'cyclist';
  }

  /**
   * One row per prop TYPE, with a stepper that walks its instances.
   *
   * Two deletes with different blast radii live on this row, so they are kept
   * visually and positionally distinct: `✕` sits with the stepper and takes the
   * instance the stepper points at, the trash stays rightmost — where every
   * other row's trash is — and takes the whole type. Both confirm, and the
   * confirm text names the exact target, which is what actually makes the
   * difference safe rather than the icons.
   */
  function _propRowHtml(blueprint, items) {
    const name  = window.PropCatalog?.label(blueprint) || blueprint;
    const count = items.length;
    // Props are added and removed by the map and the toolbar too, so the cursor
    // is clamped here rather than trusted.
    const cursor = Math.min(Math.max(_propCursor[blueprint] ?? 0, 0), count - 1);
    _propCursor[blueprint] = cursor;
    const current = items[cursor];

    // At one instance a stepper is a control that can only ever say "1/1".
    const stepper = count > 1
      ? `<span class="scene-step">
           <button type="button" class="scene-step-btn" data-prop-step="-1"
                   data-prop-bp="${_esc(blueprint)}"
                   title="Vorherige ${_esc(name)}" aria-label="Vorherige ${_esc(name)}">&#9664;</button>
           <span class="scene-step-pos">${cursor + 1}/${count}</span>
           <button type="button" class="scene-step-btn" data-prop-step="1"
                   data-prop-bp="${_esc(blueprint)}"
                   title="Nächste ${_esc(name)}" aria-label="Nächste ${_esc(name)}">&#9654;</button>
         </span>`
      : `<span class="scene-step"><span class="scene-step-pos">${count}</span></span>`;

    const currentLabel = AppState.actorLabel(current, { short: true });

    // At one instance the two deletes would do the same thing and the bulk one
    // would have to say "Alle 1 × …". So the row collapses to a single trash
    // that takes that instance — exactly like an actor row. The spacer keeps
    // the trash in the same grid column as every other row's.
    const deletes = count > 1
      ? `<button type="button" class="scene-del scene-del-one" data-scene-del="${_esc(current.id)}"
                 title="${_esc(currentLabel)} löschen (Strg: ohne Rückfrage)"
                 aria-label="${_esc(currentLabel)} löschen">&#10005;</button>
         <button type="button" class="scene-del scene-del-all" data-prop-del-all="${_esc(blueprint)}"
                 title="Alle ${count} × ${_esc(name)} löschen (Strg: ohne Rückfrage)"
                 aria-label="Alle ${count} ${_esc(name)} löschen">${TRASH_SVG}</button>`
      : `<span class="scene-del-spacer" aria-hidden="true"></span>
         <button type="button" class="scene-del" data-scene-del="${_esc(current.id)}"
                 title="${_esc(currentLabel)} löschen (Strg: ohne Rückfrage)"
                 aria-label="${_esc(currentLabel)} löschen">${TRASH_SVG}</button>`;

    return `
      <div class="scene-prop-row${_locatedId === current.id ? ' located' : ''}"
           role="option" tabindex="0" aria-selected="false"
           data-scene-id="${_esc(current.id)}" data-prop-bp="${_esc(blueprint)}"
           title="Klick: ${_esc(currentLabel)} auf der Karte zeigen · Doppelklick: bearbeiten">
        <span class="scene-swatch" style="background:var(--accent2)"></span>
        <span class="scene-name">${_esc(name)}</span>
        ${stepper}
        ${deletes}
      </div>`;
  }

  function _sceneSectionHtml(key, label, count, bodyHtml) {
    const collapsed = _sceneCollapsed[key];
    return `
      <div class="scene-section${collapsed ? ' collapsed' : ''}" data-scene-section="${key}">
        <button type="button" class="scene-section-head" data-scene-toggle="${key}"
                aria-expanded="${!collapsed}">
          <span class="scene-head-label">${_esc(label)}</span>
          <span class="scene-head-count">${count}</span>
          <span class="collapse-indicator" aria-hidden="true">${collapsed ? '+' : '-'}</span>
        </button>
        <div class="scene-section-body">${bodyHtml}</div>
      </div>`;
  }

  function _sceneListHtml() {
    let html = '<div class="scene-list" role="listbox" aria-label="Szene">';

    // Ego — one object, so a collapsible section around it would be a control
    // that can only ever hide a single row.
    html += '<div class="scene-section"><div class="scene-section-head">'
          + '<span class="scene-head-label">Ego</span></div>'
          + '<div class="scene-section-body">'
          + (AppState.ego
              ? _sceneRowHtml(AppState.ego)
              : '<div class="scene-empty">Nicht platziert</div>')
          + '</div></div>';

    const npcs = AppState.npcs || [];
    html += _sceneSectionHtml('npcs', 'NPCs', npcs.length,
      npcs.length
        ? npcs.map(_sceneRowHtml).join('')
        : '<div class="scene-empty">Keine NPCs</div>');

    // Props are counted per type, never listed per object: a cone taper is a
    // dozen entries that differ only in position, and they would push the
    // actors — the things you actually navigate to — off the panel. The stepper
    // is how you still reach one particular cone.
    const props = AppState.staticObjects || [];
    const byType = new Map();
    props.forEach(p => {
      if (!byType.has(p.prop)) byType.set(p.prop, []);
      byType.get(p.prop).push(p);
    });
    const propBody = props.length
      ? [...byType.entries()].map(([blueprint, items]) => _propRowHtml(blueprint, items)).join('')
      : '<div class="scene-empty">Keine Requisiten</div>';
    html += _sceneSectionHtml('props', 'Requisiten', props.length, propBody);

    html += '</div>';
    return html;
  }

  const SCENE_ROW_SEL = '.scene-row, .scene-prop-row';

  /** Fly the map to an object without selecting it, and mark its row. */
  function _locateScene(root, id) {
    if (!id || !MapView.focusActor(id)) return;
    _locatedId = id;
    root.querySelectorAll(SCENE_ROW_SEL).forEach(r => {
      r.classList.toggle('located', r.dataset.sceneId === id);
    });
  }

  /** Step a prop type's cursor and fly to whatever it now points at. */
  function _stepProp(blueprint, delta) {
    const items = (AppState.staticObjects || []).filter(p => p.prop === blueprint);
    if (items.length < 2) return;
    const next = ((_propCursor[blueprint] ?? 0) + delta + items.length) % items.length;
    _propCursor[blueprint] = next;
    _locatedId = items[next].id;
    _renderOverviewPanel();          // the row prints "n/N", so it has to redraw
    MapView.focusActor(_locatedId);
    // Keep the keyboard on the row that was just stepped.
    propsOverview.querySelector(`.scene-prop-row[data-prop-bp="${CSS.escape(blueprint)}"]`)
      ?.focus();
  }

  async function _deleteFromScene(id, skipConfirm = false) {
    const actor = AppState.findById(id);
    if (!actor) return;
    const label = AppState.actorLabel(actor, { ego: 'Ego-Fahrzeug' });
    if (!skipConfirm && !await Confirm.show(`${label} löschen?`, 'Löschen')) return;
    AppState.removeById(id);
    if (_locatedId === id) _locatedId = null;
    MapView.renderAllActors();
    render();
    Toast.info(`${label} gelöscht — Strg+Z zum Rückgängigmachen`);
  }

  async function _deleteAllProps(blueprint, skipConfirm = false) {
    const items = (AppState.staticObjects || []).filter(p => p.prop === blueprint);
    if (!items.length) return;
    const name = window.PropCatalog?.label(blueprint) || blueprint;
    if (!skipConfirm
        && !await Confirm.show(`Alle ${items.length} × ${name} löschen?`, 'Löschen')) return;
    items.forEach(p => { if (_locatedId === p.id) _locatedId = null; });
    // One entry for the whole bulk delete. It used to push one per prop, so a
    // taper of twelve cones took twelve presses of Strg+Z to put back; the
    // history holds whole scenario states now, so the group can be atomic.
    UndoStack.group(`${items.length} × ${name} löschen`, () => {
      AppState.staticObjects = AppState.staticObjects.filter(p => p.prop !== blueprint);
      if (AppState.selectedId && !AppState.findById(AppState.selectedId)) AppState.selectedId = null;
      AppState.set({});              // empty patch: the array-mutation signal
    });
    delete _propCursor[blueprint];
    MapView.renderAllActors();
    render();
    Toast.info(`${items.length} × ${name} gelöscht — Strg+Z macht sie zusammen rückgängig`);
  }

  function _bindSceneList(root) {
    const list = root.querySelector('.scene-list');
    if (!list) return;

    list.addEventListener('click', e => {
      const toggle = e.target.closest('[data-scene-toggle]');
      if (toggle) {
        const key = toggle.dataset.sceneToggle;
        _sceneCollapsed[key] = !_sceneCollapsed[key];
        const section = toggle.closest('.scene-section');
        section.classList.toggle('collapsed', _sceneCollapsed[key]);
        toggle.setAttribute('aria-expanded', String(!_sceneCollapsed[key]));
        const ind = toggle.querySelector('.collapse-indicator');
        if (ind) ind.textContent = _sceneCollapsed[key] ? '+' : '-';
        return;
      }
      // Every control below sits inside a row whose own click means "locate",
      // so each one has to claim the event before it gets there. Strg (Cmd on a
      // Mac) is the app-wide "I meant it" modifier: it skips the confirm dialog.
      const skip = e.ctrlKey || e.metaKey;
      const delAll = e.target.closest('[data-prop-del-all]');
      if (delAll) { _deleteAllProps(delAll.dataset.propDelAll, skip); return; }
      const del = e.target.closest('[data-scene-del]');
      if (del) { _deleteFromScene(del.dataset.sceneDel, skip); return; }
      const step = e.target.closest('[data-prop-step]');
      if (step) { _stepProp(step.dataset.propBp, Number(step.dataset.propStep)); return; }

      const row = e.target.closest(SCENE_ROW_SEL);
      if (row) _locateScene(root, row.dataset.sceneId);
    });

    // Selecting swaps this whole panel out for the object's properties, so it is
    // the deliberate gesture: double click, or Enter on a focused row.
    list.addEventListener('dblclick', e => {
      if (e.target.closest('[data-scene-del], [data-prop-del-all], [data-prop-step]')) return;
      const row = e.target.closest(SCENE_ROW_SEL);
      if (row) AppState.select(row.dataset.sceneId);
    });

    list.addEventListener('keydown', e => {
      const row = e.target.closest(SCENE_ROW_SEL);
      if (!row || e.target !== row) return;   // let the row's buttons keep their own keys
      const bp = row.dataset.propBp;
      if (e.key === 'Enter') {
        e.preventDefault();
        AppState.select(row.dataset.sceneId);
      } else if (e.key === ' ') {
        // Only a row the user actually keyboard-focused owns Space; a row left
        // focused by a click does not, or Space would re-locate what that click
        // already located instead of starting the preview (simulate.js reads
        // the same predicate, and defers to the preventDefault below).
        if (!UIUtils.keyboardFocused(row)) return;
        e.preventDefault();
        _locateScene(root, row.dataset.sceneId);
      } else if (bp && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        // On a prop row the horizontal arrows are the stepper, matching the
        // ◀ ▶ buttons sitting in the row itself.
        e.preventDefault();
        _stepProp(bp, e.key === 'ArrowRight' ? 1 : -1);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const rows = [...list.querySelectorAll(`.scene-section:not(.collapsed) :is(${SCENE_ROW_SEL})`)];
        const i = rows.indexOf(row);
        const next = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
        if (next) next.focus();
      }
    });
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

  propsDelete.addEventListener('click', async e => {
    const id = AppState.selectedId;
    if (!id) return;
    const actor = AppState.findById(id);
    if (!actor) return;
    const label = AppState.actorLabel(actor, { ego: 'Ego-Fahrzeug' });
    // Strg (Cmd on a Mac) skips the confirm here exactly as it does on the scene
    // list's trashes \u2014 one modifier, one meaning, everywhere a delete is guarded.
    const ok = e.ctrlKey || e.metaKey || await Confirm.show(`${label} l\u00f6schen?`, 'L\u00f6schen');
    if (!ok) return;
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
  AppState.on('actorRemoved',     id => { if (_locatedId === id) _locatedId = null; render(); });
  // Ids restart at obj-1 in every save file, so a stale _locatedId would mark
  // some unrelated actor's row in the newly loaded scenario.
  AppState.on('stateLoaded',      () => { _locatedId = null; render(); });
  AppState.on('change',           patch => {
    // 'map'/'mapData' are in here because the summary prints the town name and
    // used to sit on "Karte: None" from load until some unrelated event forced
    // a render — which read as intermittent rather than broken.
    //
    // An EMPTY patch is the codebase's signal that one of the state arrays was
    // mutated in place (`AppState.npcs = [...]; AppState.set({})`). It has to be
    // in here for the scene list: placing a prop is the one placement that does
    // not select what it placed, so the overview stays on screen and would
    // otherwise keep showing the pre-placement counts.
    const sceneChanged = Object.keys(patch).length === 0;
    if (!AppState.selectedId
        && (sceneChanged
            || 'weather' in patch || 'time' in patch || 'map' in patch || 'mapData' in patch)) {
      _renderOverviewPanel();
    }
    // Entering or leaving draw mode changes which event card is marked as the
    // one the map clicks belong to (eventPanel.js `active-draw`).
    if (AppState.selectedId && 'activePathEventId' in patch) {
      render();
    }
  });

  _bindCollapsibleHeaders(document);

  // Render initial summary on load
  _renderOverviewPanel();
})();
