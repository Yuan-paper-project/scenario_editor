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
  const btnDrawPath    = document.getElementById('btn-draw-path');
  const btnClearPath   = document.getElementById('btn-clear-path');
  const btnTogglePath  = document.getElementById('btn-toggle-path');
  const waypointList   = document.getElementById('waypoint-list');

  // Track whether we're syncing to avoid loops
  let _syncing = false;

  // ── Render panel for selected actor ─────────────────────────────────────────

  function _renderSummary() {
    const hasEgo = !!AppState.ego;
    const npcCount = AppState.npcs.length;
    const mapName = AppState.map || 'None';
    const withTraj = AppState.npcs.filter(n => n.trajectory && n.trajectory.length >= 2).length;

    const npcBreakdown = {};
    AppState.npcs.forEach(n => { npcBreakdown[n.type] = (npcBreakdown[n.type] || 0) + 1; });

    let html = '<div class="scenario-summary">';
    html += '<h3>Scenario Overview</h3>';
    html += `<div class="summary-row"><span class="label">Map</span><span class="value">${mapName}</span></div>`;
    html += `<div class="summary-row"><span class="label">Ego Vehicle</span><span class="value">${hasEgo ? 'Placed' : 'Not placed'}</span></div>`;
    html += `<div class="summary-row"><span class="label">NPCs</span><span class="value">${npcCount}</span></div>`;

    if (npcCount > 0) {
      html += '<div class="summary-section">NPC Breakdown</div>';
      for (const [type, count] of Object.entries(npcBreakdown)) {
        html += `<div class="summary-row"><span class="label">${type}</span><span class="value">${count}</span></div>`;
      }
      html += `<div class="summary-row"><span class="label">With trajectory</span><span class="value">${withTraj}</span></div>`;
    }

    html += `<div class="summary-section">Weather</div>`;
    html += `<div class="summary-row"><span class="label">Time</span><span class="value">${AppState.time}</span></div>`;
    const activeWeather = Object.entries(AppState.weather).filter(([, v]) => v > 0);
    if (activeWeather.length > 0) {
      activeWeather.forEach(([k, v]) => {
        html += `<div class="summary-row"><span class="label">${k.replace('_', ' ')}</span><span class="value">${v.toFixed(2)}</span></div>`;
      });
    } else {
      html += `<div class="summary-row"><span class="label">Conditions</span><span class="value">Clear</span></div>`;
    }

    html += '<div class="summary-hint">Click an actor to edit properties<br>Press <b>?</b> for keyboard shortcuts</div>';
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
    const typeLabel = actor.type === 'ego' ? 'Ego Vehicle' : actor.type.charAt(0).toUpperCase() + actor.type.slice(1);
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

      // Ego route hint — only for ego
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
      btnTogglePath.textContent = pathVisible ? 'Hide Path' : 'Show Path';

      // Waypoint list (both ego and NPCs)
      _renderWaypointList(actor);
    }
  }

  function _renderWaypointList(actor) {
    waypointList.innerHTML = '';
    const traj = actor.trajectory || [];

    if (traj.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text-dim);font-size:11px;padding:4px 0';
      empty.textContent = 'No path drawn yet.';
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
      velInput.title = 'Velocity (m/s)';
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
      delBtn.title = 'Remove waypoint';
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

  // ── Trajectory buttons ───────────────────────────────────────────────────────

  btnDrawPath.addEventListener('click', () => {
    const id = AppState.selectedId;
    if (!id) return;
    ObjectsManager.startTrajectoryMode(id);
  });

  btnClearPath.addEventListener('click', () => {
    const id = AppState.selectedId;
    if (!id) return;
    ObjectsManager.clearTrajectory(id);
    render();
  });

  btnTogglePath.addEventListener('click', () => {
    const id = AppState.selectedId;
    if (!id) return;
    MapView.toggleTrajectoryVisibility(id);
    const visible = MapView.isTrajectoryVisible(id);
    btnTogglePath.textContent = visible ? 'Hide Path' : 'Show Path';
  });

  // ── Delete ──────────────────────────────────────────────────────────────────

  propsDelete.addEventListener('click', async () => {
    const id = AppState.selectedId;
    if (!id) return;
    const actor = AppState.findById(id);
    if (!actor) return;
    const label = actor.type === 'ego' ? 'Ego Vehicle' : `${actor.type.toUpperCase()} (${actor.id})`;
    const ok = await Confirm.show(`Delete ${label}?`, 'Delete');
    if (!ok) return;
    // Save to undo stack before removing
    UndoStack.push({ action: 'delete', actor: JSON.parse(JSON.stringify(actor)) });
    AppState.removeById(id);
    MapView.renderAllActors();
    render();
    Toast.info(`Deleted ${label} \u2014 press Ctrl+Z to undo`);
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
