/**
 * properties.js — Right panel showing properties of the selected actor.
 *
 * Handles:
 *   - x/y/z/yaw numeric inputs
 *   - NPC behavior checkboxes
 *   - Trajectory "Draw Path" button + waypoint list with velocity inputs
 *   - Delete button
 */
(function () {
  'use strict';

  // Elements
  const propsEmpty   = document.getElementById('props-empty');
  const propsContent = document.getElementById('props-content');
  const propsTitle   = document.getElementById('props-title');
  const propsDelete  = document.getElementById('props-delete');

  const propX = document.getElementById('prop-x');
  const propY = document.getElementById('prop-y');
  const propZ = document.getElementById('prop-z');
  const propYaw = document.getElementById('prop-yaw');

  const npcSection     = document.getElementById('props-npc-section');
  const behaviorBoxes  = document.querySelectorAll('#behavior-checkboxes input[type="checkbox"]');
  const triggerSection  = document.getElementById('trigger-section');
  const propTriggerDist = document.getElementById('prop-trigger-dist');
  const egoRouteHint   = document.getElementById('ego-route-hint');
  const pathSectionLabel = document.getElementById('path-section-label');
  const btnModeTrajectory = document.getElementById('btn-path-mode-trajectory');
  const btnModeRoute      = document.getElementById('btn-path-mode-route');
  const routeSpeedRow     = document.getElementById('route-speed-row');
  const propRouteSpeed    = document.getElementById('prop-route-speed');
  const routeSpeedDynamicsRow  = document.getElementById('route-speed-dynamics-row');
  const propRouteSpeedDynamicsValue = document.getElementById('prop-route-speed-dynamics-value');
  const propRouteSpeedDynamicsUnit  = document.getElementById('prop-route-speed-dynamics-unit');
  const btnDrawPath    = document.getElementById('btn-draw-path');
  const btnClearPath   = document.getElementById('btn-clear-path');
  const btnTogglePath  = document.getElementById('btn-toggle-path');
  const waypointList   = document.getElementById('waypoint-list');

  // Track whether we're syncing to avoid loops
  let _syncing = false;
  const ROUTE_ACTOR_TYPES = new Set(['car', 'truck', 'bus', 'motorcycle']);

  // ── Render panel for selected actor ─────────────────────────────────────────

  function _renderSummary() {
    const hasEgo = !!AppState.ego;
    const npcCount = AppState.npcs.length;
    const mapName = AppState.map || 'None';
    const withTraj = AppState.npcs.filter(n => n.trajectory && n.trajectory.length >= 2).length;

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

    propsEmpty.innerHTML = html;
  }

  function render() {
    const id    = AppState.selectedId;
    const actor = id ? AppState.findById(id) : null;

    if (!actor) {
      propsEmpty.classList.remove('hidden');
      propsContent.classList.add('hidden');
      _renderSummary();
      return;
    }

    propsEmpty.classList.add('hidden');
    propsContent.classList.remove('hidden');

    // Title
    const typeLabel = actor.type === 'ego' ? 'Ego-Fahrzeug' : actor.type.charAt(0).toUpperCase() + actor.type.slice(1);
    propsTitle.textContent = typeLabel;

    // Position / yaw
    _syncing = true;
    propX.value   = actor.x   != null ? actor.x.toFixed(2)   : '';
    propY.value   = actor.y   != null ? actor.y.toFixed(2)    : '';
    propZ.value   = actor.z   != null ? actor.z.toFixed(2)    : '0.20';
    propYaw.value = actor.yaw != null ? Math.round(actor.yaw) : '0';
    _syncing = false;

    // NPC + Ego trajectory section (show for all scenario actors)
    const isScenarioActor = !['tree', 'building'].includes(actor.type);
    const isNpc = isScenarioActor && actor.type !== 'ego';
    npcSection.classList.toggle('hidden', !isScenarioActor);

    if (isScenarioActor) {
      // Behavior checkboxes — only for NPCs (hide for ego)
      const behaviorSection = document.getElementById('behavior-checkboxes');
      const behaviorLabel   = behaviorSection?.previousElementSibling; // .props-group-label
      if (behaviorSection) behaviorSection.style.display = isNpc ? '' : 'none';
      if (behaviorLabel && behaviorLabel.classList.contains('props-group-label'))
        behaviorLabel.style.display = isNpc ? '' : 'none';

      // Trigger distance — only for NPCs
      triggerSection.style.display = isNpc ? '' : 'none';

      const canUseRoute = ROUTE_ACTOR_TYPES.has(actor.type);
      const isRouteMode = _getActorPathMode(actor) === 'route';
      const hasCompleteRoute = isRouteMode && (actor.route || []).length >= 2;

      pathSectionLabel.classList.toggle('hidden', canUseRoute);
      btnModeTrajectory.parentElement.classList.toggle('hidden', !canUseRoute);
      btnModeTrajectory.classList.toggle('active', !isRouteMode);
      btnModeRoute.classList.toggle('active', isRouteMode);
      btnDrawPath.textContent = isRouteMode ? 'Route zeichnen' : 'Pfad zeichnen';
      btnClearPath.textContent = isRouteMode ? 'Route löschen' : 'Pfad löschen';
      routeSpeedRow.classList.toggle('hidden', !hasCompleteRoute);
      routeSpeedDynamicsRow.classList.toggle('hidden', !hasCompleteRoute);

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

      if (isRouteMode) {
        _syncing = true;
        propRouteSpeed.value = (actor.route_velocity ?? 10).toFixed(1);
        propRouteSpeedDynamicsValue.value = (actor.route_speed_dynamics_value ?? 0.0).toFixed(1);
        propRouteSpeedDynamicsUnit.value = actor.route_speed_dynamics_dimension === 'time' ? 'time' : 'distance';
        _syncing = false;
      }

      // Toggle path visibility button state
      const pathVisible = isRouteMode
        ? MapView.isRouteVisible(actor.id)
        : MapView.isTrajectoryVisible(actor.id);
      const pathLabel = isRouteMode ? 'Route' : 'Pfad';
      btnTogglePath.textContent = pathVisible ? `${pathLabel} ausblenden` : `${pathLabel} anzeigen`;

      // Waypoint list (both ego and NPCs)
      if (isRouteMode) _renderRouteList(actor);
      else _renderWaypointList(actor);
    }
  }

  function _renderWaypointList(actor) {
    waypointList.innerHTML = '';
    const traj = actor.trajectory || [];

    if (traj.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text-dim);font-size:11px;padding:4px 0';
      empty.textContent = 'Noch kein Pfad gezeichnet.';
      waypointList.appendChild(empty);
      return;
    }

    traj.forEach((wp, i) => {
      const item = document.createElement('div');
      item.className = 'waypoint-item';

      const num = document.createElement('span');
      num.className = 'wp-num';
      num.textContent = i + 1;

      const coords = document.createElement('span');
      coords.className = 'wp-coords';
      coords.textContent = `(${wp.x.toFixed(1)}, ${wp.y.toFixed(1)})`;

      const velInput = document.createElement('input');
      velInput.type = 'number';
      velInput.min  = '0';
      velInput.max  = '50';
      velInput.step = '0.5';
      velInput.value = (wp.velocity || 10).toFixed(1);
      velInput.title = 'Geschwindigkeit (m/s)';
      velInput.dataset.idx = i;
      velInput.addEventListener('change', ev => {
        ObjectsManager.setWaypointVelocity(actor.id, i, ev.target.value);
      });

      const msSuffix = document.createElement('span');
      msSuffix.style.cssText = 'color:var(--text-dim);font-size:10px;';
      msSuffix.textContent = 'm/s';

      const delBtn = document.createElement('button');
      delBtn.className = 'wp-delete';
      delBtn.textContent = '×';
      delBtn.title = 'Wegpunkt entfernen';
      delBtn.addEventListener('click', () => {
        ObjectsManager.deleteWaypoint(actor.id, i);
      });

      item.appendChild(num);
      item.appendChild(coords);
      item.appendChild(velInput);
      item.appendChild(msSuffix);
      item.appendChild(delBtn);
      waypointList.appendChild(item);
    });
  }

  function _renderRouteList(actor) {
    waypointList.innerHTML = '';
    const route = actor.route || [];

    if (route.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text-dim);font-size:11px;padding:4px 0';
      empty.textContent = 'Noch keine Route gezeichnet.';
      waypointList.appendChild(empty);
      return;
    }

    route.forEach((wp, i) => {
      const item = document.createElement('div');
      item.className = 'waypoint-item route-waypoint-item';

      const num = document.createElement('span');
      num.className = 'wp-num';
      num.textContent = i + 1;

      const coords = document.createElement('span');
      coords.className = 'wp-coords';
      coords.textContent = `(${wp.x.toFixed(1)}, ${wp.y.toFixed(1)})`;

      const delBtn = document.createElement('button');
      delBtn.className = 'wp-delete';
      delBtn.textContent = '×';
      delBtn.title = 'Wegpunkt entfernen';
      delBtn.addEventListener('click', () => {
        ObjectsManager.deleteRouteWaypoint(actor.id, i);
      });

      item.appendChild(num);
      item.appendChild(coords);
      item.appendChild(delBtn);
      waypointList.appendChild(item);
    });
  }

  function _canSelectedActorUseRoute() {
    const id = AppState.selectedId;
    const actor = id ? AppState.findById(id) : null;
    return !!actor && ROUTE_ACTOR_TYPES.has(actor.type);
  }

  function _getActorPathMode(actor) {
    if (!actor || !ROUTE_ACTOR_TYPES.has(actor.type)) return 'trajectory';
    return actor.path_mode === 'route' ? 'route' : 'trajectory';
  }

  function _getSelectedPathMode() {
    const id = AppState.selectedId;
    return _getActorPathMode(id ? AppState.findById(id) : null);
  }

  // ── Input → state bindings ───────────────────────────────────────────────────

  function _onPosChange() {
    if (_syncing) return;
    const id = AppState.selectedId;
    if (!id) return;
    AppState.updateById(id, {
      x:   parseFloat(propX.value)   || 0,
      y:   parseFloat(propY.value)   || 0,
      z:   parseFloat(propZ.value)   || 0.2,
      yaw: parseFloat(propYaw.value) || 0,
    });
  }

  [propX, propY, propZ, propYaw].forEach(inp => {
    inp.addEventListener('change', _onPosChange);
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

  // ── Path mode + buttons ──────────────────────────────────────────────────────

  btnModeTrajectory.addEventListener('click', () => {
    const id = AppState.selectedId;
    if (id) AppState.updateById(id, { path_mode: 'trajectory' });
    AppState.set({ routeMode: false, activeRouteId: null });
    render();
  });

  btnModeRoute.addEventListener('click', () => {
    if (!_canSelectedActorUseRoute()) return;
    const id = AppState.selectedId;
    if (id) AppState.updateById(id, { path_mode: 'route' });
    AppState.set({ trajectoryMode: false, activeTrajectoryId: null });
    render();
  });

  propRouteSpeed.addEventListener('change', () => {
    if (_syncing) return;
    const id = AppState.selectedId;
    if (!id) return;
    const raw = parseFloat(propRouteSpeed.value);
    const val = Math.max(0, Math.min(50, Number.isFinite(raw) ? raw : 10));
    propRouteSpeed.value = val.toFixed(1);
    ObjectsManager.setRouteVelocity(id, val);
  });

  function _onRouteSpeedDynamicsChange() {
    if (_syncing) return;
    const id = AppState.selectedId;
    if (!id) return;
    const raw = parseFloat(propRouteSpeedDynamicsValue.value);
    const val = Math.max(0, Number.isFinite(raw) ? raw : 0.0);
    const dimension = propRouteSpeedDynamicsUnit.value === 'time' ? 'time' : 'distance';
    propRouteSpeedDynamicsValue.value = val.toFixed(1);
    ObjectsManager.setRouteSpeedDynamics(id, val, dimension);
  }

  propRouteSpeedDynamicsValue.addEventListener('change', _onRouteSpeedDynamicsChange);
  propRouteSpeedDynamicsUnit.addEventListener('change', _onRouteSpeedDynamicsChange);

  btnDrawPath.addEventListener('click', () => {
    const id = AppState.selectedId;
    if (!id) return;
    if (_getSelectedPathMode() === 'route') ObjectsManager.startRouteMode(id);
    else ObjectsManager.startTrajectoryMode(id);
  });

  btnClearPath.addEventListener('click', () => {
    const id = AppState.selectedId;
    if (!id) return;
    if (_getSelectedPathMode() === 'route') ObjectsManager.clearRoute(id);
    else ObjectsManager.clearTrajectory(id);
    render();
  });

  btnTogglePath.addEventListener('click', () => {
    const id = AppState.selectedId;
    if (!id) return;
    const routeModeActive = _getSelectedPathMode() === 'route';
    if (routeModeActive) MapView.toggleRouteVisibility(id);
    else MapView.toggleTrajectoryVisibility(id);
    const visible = routeModeActive
      ? MapView.isRouteVisible(id)
      : MapView.isTrajectoryVisible(id);
    const pathLabel = routeModeActive ? 'Route' : 'Pfad';
    btnTogglePath.textContent = visible ? `${pathLabel} ausblenden` : `${pathLabel} anzeigen`;
  });

  // ── Delete ──────────────────────────────────────────────────────────────────

  propsDelete.addEventListener('click', async () => {
    const id = AppState.selectedId;
    if (!id) return;
    const actor = AppState.findById(id);
    if (!actor) return;
    const label = actor.type === 'ego' ? 'Ego-Fahrzeug' : `${actor.type.toUpperCase()} (${actor.id})`;
    const ok = await Confirm.show(`${label} l\u00f6schen?`, 'L\u00f6schen');
    if (!ok) return;
    UndoStack.push({ action: 'delete', actor: JSON.parse(JSON.stringify(actor)) });
    AppState.removeById(id);
    MapView.renderAllActors();
    render();
    Toast.info(`${label} gel\u00f6scht \u2014 Strg+Z zum R\u00fcckg\u00e4ngigmachen`);
  });

  // ── Listen for state changes ─────────────────────────────────────────────────

  AppState.on('selectionChanged', () => render());
  AppState.on('actorUpdated',     id => {
    if (id === AppState.selectedId) render();
    else if (!AppState.selectedId) _renderSummary();
  });
  AppState.on('actorRemoved',     () => render());
  AppState.on('stateLoaded',      () => render());
  AppState.on('change',           patch => {
    if (!AppState.selectedId && ('weather' in patch || 'time' in patch)) _renderSummary();
  });

  // Render initial summary on load
  _renderSummary();
})();
