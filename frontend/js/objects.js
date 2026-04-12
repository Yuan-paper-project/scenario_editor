/**
 * objects.js — Actor placement, selection, dragging, yaw-arrow rotation,
 *              and trajectory waypoint drawing.
 *
 * Interactions:
 *   - Click on map with active tool → place actor at nearest spawn point (or cursor)
 *   - Click on existing actor → select it
 *   - Drag actor body → move actor
 *   - Drag yaw arrow head → rotate actor
 *   - In trajectory mode → click on map to add waypoint
 */
(function () {
  'use strict';

  const svg        = MapView.svg;
  const trajBanner = document.getElementById('traj-banner');
  const trajBannerName = document.getElementById('traj-banner-name');
  const trajDoneBtn    = document.getElementById('traj-done-btn');
  const trajUndoBtn    = document.getElementById('traj-undo-btn');

  // ── Drag state ───────────────────────────────────────────────────────────────
  let _dragState = null;   // { type: 'actor'|'yaw', actorId, startWorld, startActorPos, startYaw }

  // ── SVG click handler ─────────────────────────────────────────────────────────

  svg.addEventListener('click', e => {
    if (e.defaultPrevented) return;
    if (_wasDragging) { _wasDragging = false; return; }

    const world = MapView.svgToWorld(e);

    // ── Trajectory mode: add waypoint ──
    if (AppState.trajectoryMode && AppState.activeTrajectoryId) {
      _addWaypoint(AppState.activeTrajectoryId, world.x, world.y);
      return;
    }

    // ── Check for actor click first (even with tool active — clicking existing actor selects it) ──
    const actorGroup = e.target.closest('.actor-group');
    if (actorGroup) {
      const id = actorGroup.dataset.id;
      AppState.set({ activeTool: null });   // exit placement mode
      AppState.select(AppState.selectedId === id ? null : id);
      e.preventDefault();
      return;
    }

    // ── Tool active: place actor on empty space (skip non-placement tools) ──
    if (AppState.activeTool && AppState.activeTool !== 'ruler') {
      _placeActor(AppState.activeTool, world.x, world.y);
      return;
    }

    // Click on empty space with no tool: deselect
    AppState.select(null);
  });

  // ── Place actor ──────────────────────────────────────────────────────────────

  function _placeActor(type, wx, wy) {
    // Snap to nearest spawn point
    const snap = AppState.nearestSpawn(wx, wy, 12);
    const x   = snap ? snap.x   : Math.round(wx * 10) / 10;
    const y   = snap ? snap.y   : Math.round(wy * 10) / 10;
    const yaw = snap ? snap.yaw : 0;

    let newId;
    if (type === 'ego') {
      const actor = { id: AppState.nextId(), type: 'ego', x, y, z: 0.2, yaw, trajectory: [] };
      AppState.set({ ego: actor });
      newId = actor.id;
    } else if (['tree', 'building'].includes(type)) {
      const actor = { id: AppState.nextId(), type, x, y };
      AppState.staticObjects = [...AppState.staticObjects, actor];
      AppState.set({});
      newId = actor.id;
    } else {
      const actor = {
        id: AppState.nextId(), type, x, y, z: 0.2, yaw,
        behaviors: ['constant_speed'],
        trigger_distance: 400,
        trajectory: [],
      };
      AppState.npcs = [...AppState.npcs, actor];
      AppState.set({});
      newId = actor.id;
    }

    // Deactivate tool after placing so user can immediately drag/select
    AppState.set({ activeTool: null });
    AppState.select(newId);
    MapView.renderAllActors();
  }

  // ── Drag actors ───────────────────────────────────────────────────────────────

  let _wasDragging = false;

  svg.addEventListener('mousedown', e => {
    if (e.button !== 0) return;

    // Yaw arrow head drag
    const arrowHit = e.target.closest('.yaw-arrow') ||
                     (e.target.getAttribute && e.target.getAttribute('data-actor-id') && e.target.closest('[class*="arrow"]'));
    if (arrowHit || (e.target.getAttribute && e.target.getAttribute('class') === 'arrow-head') ||
        (e.target.getAttribute && e.target.getAttribute('style') === 'cursor:grab')) {
      const actorId = e.target.dataset.actorId ||
                      e.target.closest('[data-actor-id]')?.dataset?.actorId;
      if (actorId) {
        const actor = AppState.findById(actorId);
        if (actor) {
          _dragState = {
            type: 'yaw',
            actorId,
            actorPos: { x: actor.x, y: actor.y },
          };
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
    }

    // Actor body drag
    const actorGroup = e.target.closest('.actor-group');
    if (actorGroup && !AppState.activeTool && !AppState.trajectoryMode) {
      const id     = actorGroup.dataset.id;
      const actor  = AppState.findById(id);
      const world  = MapView.svgToWorld(e);
      if (actor) {
        _dragState = {
          type: 'actor',
          actorId: id,
          startWorld: { ...world },
          startActorPos: { x: actor.x, y: actor.y },
        };
        AppState.select(id);
        e.preventDefault();
        e.stopPropagation();
      }
    }
  });

  window.addEventListener('mousemove', e => {
    if (!_dragState) return;
    _wasDragging = true;

    const world = MapView.svgToWorld(e);

    if (_dragState.type === 'actor') {
      const dx = world.x - _dragState.startWorld.x;
      const dy = world.y - _dragState.startWorld.y;
      AppState.updateById(_dragState.actorId, {
        x: Math.round((_dragState.startActorPos.x + dx) * 10) / 10,
        y: Math.round((_dragState.startActorPos.y + dy) * 10) / 10,
      });

    } else if (_dragState.type === 'yaw') {
      // Compute angle from actor centre to current mouse position
      const dx = world.x - _dragState.actorPos.x;
      const dy = world.y - _dragState.actorPos.y;
      // atan2 gives angle in radians; convert to degrees; SVG Y is flipped so Y is already correct
      let yaw = Math.round(Math.atan2(dy, dx) * 180 / Math.PI);
      AppState.updateById(_dragState.actorId, { yaw });
    }
  });

  window.addEventListener('mouseup', () => {
    if (_dragState) {
      _dragState = null;
      setTimeout(() => { _wasDragging = false; }, 50);
    }
  });

  // ── Trajectory mode ───────────────────────────────────────────────────────────

  AppState.on('change', patch => {
    if (!('trajectoryMode' in patch) && !('activeTrajectoryId' in patch)) return;
    const active = AppState.trajectoryMode && AppState.activeTrajectoryId;
    trajBanner.classList.toggle('hidden', !active);
    svg.classList.toggle('trajectory-mode', !!active);
    if (active) {
      const actor = AppState.findById(AppState.activeTrajectoryId);
      trajBannerName.textContent = actor
        ? `${actor.type.toUpperCase()} (${actor.id})`
        : AppState.activeTrajectoryId;
    }
  });

  trajDoneBtn.addEventListener('click', () => {
    AppState.set({ trajectoryMode: false, activeTrajectoryId: null });
  });

  trajUndoBtn.addEventListener('click', () => {
    const id = AppState.activeTrajectoryId;
    if (!id) return;
    const actor = _findActor(id);
    if (!actor || !actor.trajectory || !actor.trajectory.length) return;
    actor.trajectory = actor.trajectory.slice(0, -1);
    AppState.emit('actorUpdated', id);
  });

  /** Find any actor (ego or NPC) that supports trajectory. */
  function _findActor(id) {
    if (AppState.ego && AppState.ego.id === id) return AppState.ego;
    return AppState.npcs.find(n => n.id === id) || null;
  }

  /** Enter trajectory drawing mode for any actor (ego or NPC). */
  function startTrajectoryMode(actorId) {
    const actor = _findActor(actorId);
    if (!actor) return;
    // Ensure trajectory array exists; pre-seed with actor position if empty
    if (!actor.trajectory || actor.trajectory.length === 0) {
      actor.trajectory = [{ x: actor.x, y: actor.y, velocity: 10.0 }];
    }
    AppState.set({
      activeTool: null,
      trajectoryMode: true,
      activeTrajectoryId: actorId,
    });
    MapView.renderAllActors();
  }

  function _addWaypoint(actorId, wx, wy) {
    const actor = _findActor(actorId);
    if (!actor) return;
    const lastVel = actor.trajectory.length > 0
      ? actor.trajectory[actor.trajectory.length - 1].velocity
      : 10.0;
    actor.trajectory.push({ x: Math.round(wx * 10) / 10, y: Math.round(wy * 10) / 10, velocity: lastVel });
    AppState.emit('actorUpdated', actorId);
  }

  /** Delete a waypoint by index. */
  function deleteWaypoint(actorId, idx) {
    const actor = _findActor(actorId);
    if (!actor) return;
    actor.trajectory.splice(idx, 1);
    AppState.emit('actorUpdated', actorId);
  }

  /** Update a waypoint's velocity. */
  function setWaypointVelocity(actorId, idx, velocity) {
    const actor = _findActor(actorId);
    if (!actor || !actor.trajectory[idx]) return;
    actor.trajectory[idx].velocity = parseFloat(velocity) || 10.0;
    AppState.emit('actorUpdated', actorId);
  }

  /** Clear all waypoints for an actor. */
  function clearTrajectory(actorId) {
    const actor = _findActor(actorId);
    if (!actor) return;
    actor.trajectory = [];
    AppState.emit('actorUpdated', actorId);
  }

  // ── Public interface ─────────────────────────────────────────────────────────
  window.ObjectsManager = {
    startTrajectoryMode,
    deleteWaypoint,
    setWaypointVelocity,
    clearTrajectory,
  };
})();
