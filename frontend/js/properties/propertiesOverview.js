/**
 * propertiesOverview.js — the panel shown with nothing selected: the summary, the Templates tab and the scene list.
 *
 * Part of the properties panel; see properties.js.
 */
(() => {
  'use strict';

  const { propsOverview, _sceneCollapsed, scene, panel, _propCursor, _bindCollapsibleHeaders } = PropertiesCore.shared;

  let _overviewPanelTab = 'overview';
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

  // ── The no-selection panel ──────────────────────────────────────────────────

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
    propsOverview.querySelectorAll('[data-overview-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        _overviewPanelTab = btn.dataset.overviewTab;
        _renderOverviewPanel();
      });
    });
    ScenarioTemplates.bindPanel(propsOverview);
    if (window.ScenarioGenerator) ScenarioGenerator.bindRecipe(propsOverview, _renderOverviewPanel);
    _bindCollapsibleHeaders(propsOverview);
    _bindSceneList(propsOverview);
  }

  function _summaryHtml() {
    const mapName = AppState.map || 'Keine';
    const withTraj = [AppState.ego, ...AppState.npcs]
      .filter(Boolean)
      .filter((a) => AppState.pathPointsOf(a).length >= 2).length;

    let html = '<div class="scenario-summary">';
    html += '<h3>Szenario-Übersicht</h3>';
    html += `<div class="summary-row"><span class="label">Karte</span><span class="value">${_esc(mapName)}</span></div>`;
    html += `<div class="summary-row"><span class="label">Akteure mit Pfad</span><span class="value">${withTraj}</span></div>`;

    html += _sceneListHtml();

    if (window.ScenarioGenerator) html += ScenarioGenerator.recipeHtml();

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

    html +=
      '<div class="summary-hint">Klick zeigt das Objekt auf der Karte<br>' +
      'Doppelklick (oder <b>Enter</b>) öffnet es<br>' +
      'Bei Requisiten: <b>◀ ▶</b> blättert durch die Instanzen<br>' +
      'Drücken Sie <b>?</b> für Tastaturkürzel</div>';
    html += '</div>';

    return html;
  }

  // ── Scene list ──────────────────────────────────────────────────────────────
  // At the town view a true-size car is a few pixels; this list is how to reach one.

  /** One row per scenario actor. */
  function _sceneRowHtml(actor) {
    const col = MapView.actorColor(actor.type);
    const round = _isWalker(actor.type); // matches how the map draws it
    const events = (actor.events || []).length;
    const problems = ScenarioRules.problemsOf(actor).length;
    const warn =
      problems > 0
        ? `<span class="event-warn" title="${problems} Event(s) würden beim Export verworfen">${problems}</span>`
        : '';
    const label = AppState.actorLabel(actor, { short: true });
    return `
      <div class="scene-row${scene.locatedId === actor.id ? ' located' : ''}"
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

  // Like mapMarkers.js WALKER_TYPES, only for the swatch shape (a drift is cosmetic).
  function _isWalker(type) {
    return type === 'pedestrian' || type === 'child' || type === 'cyclist';
  }

  /**
   * One row per prop type with a stepper over its instances. `✕` takes the instance, the
   * trash (rightmost) the whole type; both confirm naming their target.
   */
  function _propRowHtml(blueprint, items) {
    const name = window.PropCatalog?.label(blueprint) || blueprint;
    const count = items.length;
    // Clamped here: the map and the toolbar add and remove props too.
    const cursor = Math.min(Math.max(_propCursor[blueprint] ?? 0, 0), count - 1);
    _propCursor[blueprint] = cursor;
    const current = items[cursor];

    const stepper =
      count > 1
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

    // At one instance a single trash takes it; the spacer keeps the column aligned.
    const deletes =
      count > 1
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
      <div class="scene-prop-row${scene.locatedId === current.id ? ' located' : ''}"
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

    // The ego is one row, no collapsible section.
    html +=
      '<div class="scene-section"><div class="scene-section-head">' +
      '<span class="scene-head-label">Ego</span></div>' +
      '<div class="scene-section-body">' +
      (AppState.ego ? _sceneRowHtml(AppState.ego) : '<div class="scene-empty">Nicht platziert</div>') +
      '</div></div>';

    const npcs = AppState.npcs || [];
    html += _sceneSectionHtml(
      'npcs',
      'NPCs',
      npcs.length,
      npcs.length ? npcs.map(_sceneRowHtml).join('') : '<div class="scene-empty">Keine NPCs</div>',
    );

    // Props per type, not per object: a cone taper would push the actors off the panel.
    const props = AppState.staticObjects || [];
    const byType = new Map();
    props.forEach((p) => {
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
    scene.locatedId = id;
    root.querySelectorAll(SCENE_ROW_SEL).forEach((r) => {
      r.classList.toggle('located', r.dataset.sceneId === id);
    });
  }

  /** Step a prop type's cursor and fly to whatever it now points at. */
  function _stepProp(blueprint, delta) {
    const items = (AppState.staticObjects || []).filter((p) => p.prop === blueprint);
    if (items.length < 2) return;
    const next = ((_propCursor[blueprint] ?? 0) + delta + items.length) % items.length;
    _propCursor[blueprint] = next;
    scene.locatedId = items[next].id;
    _renderOverviewPanel(); // the row prints "n/N", so it has to redraw
    MapView.focusActor(scene.locatedId);
    propsOverview.querySelector(`.scene-prop-row[data-prop-bp="${CSS.escape(blueprint)}"]`)?.focus();
  }

  async function _deleteFromScene(id, skipConfirm = false) {
    const actor = AppState.findById(id);
    if (!actor) return;
    const label = AppState.actorLabel(actor, { ego: 'Ego-Fahrzeug' });
    if (!skipConfirm && !(await Confirm.show(`${label} löschen?`, 'Löschen'))) return;
    AppState.removeById(id);
    if (scene.locatedId === id) scene.locatedId = null;
    MapView.renderAllActors();
    panel.render();
    Toast.info(`${label} gelöscht — Strg+Z zum Rückgängigmachen`);
  }

  async function _deleteAllProps(blueprint, skipConfirm = false) {
    const items = (AppState.staticObjects || []).filter((p) => p.prop === blueprint);
    if (!items.length) return;
    const name = window.PropCatalog?.label(blueprint) || blueprint;
    if (!skipConfirm && !(await Confirm.show(`Alle ${items.length} × ${name} löschen?`, 'Löschen'))) return;
    items.forEach((p) => {
      if (scene.locatedId === p.id) scene.locatedId = null;
    });
    // One undo entry for the whole bulk delete.
    UndoStack.group(`${items.length} × ${name} löschen`, () => {
      AppState.staticObjects = AppState.staticObjects.filter((p) => p.prop !== blueprint);
      if (AppState.selectedId && !AppState.findById(AppState.selectedId)) AppState.selectedId = null;
      AppState.set({}); // empty patch: the array-mutation signal
    });
    delete _propCursor[blueprint];
    MapView.renderAllActors();
    panel.render();
    Toast.info(`${items.length} × ${name} gelöscht — Strg+Z macht sie zusammen rückgängig`);
  }

  function _bindSceneList(root) {
    const list = root.querySelector('.scene-list');
    if (!list) return;

    list.addEventListener('click', (e) => {
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
      // Every control sits inside a row whose click locates, so each claims the event. Strg/Cmd skips the confirm.
      const skip = e.ctrlKey || e.metaKey;
      const delAll = e.target.closest('[data-prop-del-all]');
      if (delAll) {
        _deleteAllProps(delAll.dataset.propDelAll, skip);
        return;
      }
      const del = e.target.closest('[data-scene-del]');
      if (del) {
        _deleteFromScene(del.dataset.sceneDel, skip);
        return;
      }
      const step = e.target.closest('[data-prop-step]');
      if (step) {
        _stepProp(step.dataset.propBp, Number(step.dataset.propStep));
        return;
      }

      const row = e.target.closest(SCENE_ROW_SEL);
      if (row) _locateScene(root, row.dataset.sceneId);
    });

    // Selecting swaps this panel out, so it is the deliberate gesture: double click or Enter.
    list.addEventListener('dblclick', (e) => {
      if (e.target.closest('[data-scene-del], [data-prop-del-all], [data-prop-step]')) return;
      const row = e.target.closest(SCENE_ROW_SEL);
      if (row) AppState.select(row.dataset.sceneId);
    });

    list.addEventListener('keydown', (e) => {
      const row = e.target.closest(SCENE_ROW_SEL);
      if (!row || e.target !== row) return; // let the row's buttons keep their own keys
      const bp = row.dataset.propBp;
      if (e.key === 'Enter') {
        e.preventDefault();
        AppState.select(row.dataset.sceneId);
      } else if (e.key === ' ') {
        // Only a keyboard-focused row owns Space (simPlayback.js defers to this preventDefault).
        if (!UIUtils.keyboardFocused(row)) return;
        e.preventDefault();
        _locateScene(root, row.dataset.sceneId);
      } else if (bp && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        // On a prop row ←/→ are the stepper.
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

  PropertiesCore.define({
    _renderOverviewPanel,
  });
})();
