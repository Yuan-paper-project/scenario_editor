/**
 * objects.js — Actor placement, selection, dragging, yaw-arrow rotation,
 *              and path waypoint drawing.
 *
 * Interactions:
 *   - Click on map with active tool → place actor at nearest spawn point (or cursor)
 *     Pedestrians/cyclists stay at the clicked point and face the nearest road.
 *   - Click on existing actor → select it
 *   - Drag actor body → move actor
 *   - Drag yaw arrow head → rotate actor
 *   - In path drawing mode → click on map to add waypoint
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

    if (AppState.triggerPointMode) {
      _setTriggerPoint(AppState.triggerPointMode, world.x, world.y);
      return;
    }

    const activeType = AppState.routeMode ? 'route' : 'trajectory';
    const activeId = AppState.routeMode ? AppState.activeRouteId : AppState.activeTrajectoryId;
    if ((AppState.trajectoryMode || AppState.routeMode) && activeId) {
      _addPathPoint(activeId, activeType, world.x, world.y, AppState.activePathEventId);
      return;
    }

    // ── Check for actor click first (even with tool active — clicking existing actor selects it) ──
    // Exception: the prop tool is sticky, so it keeps placing over existing
    // objects rather than selecting them — you build a cone line by clicking.
    const actorGroup = e.target.closest('.actor-group');
    if (actorGroup && AppState.activeTool !== 'prop') {
      const id = actorGroup.dataset.id;
      AppState.set({ activeTool: null, pendingTemplate: null, pendingProp: null });   // exit placement mode
      AppState.select(AppState.selectedId === id ? null : id);
      e.preventDefault();
      return;
    }

    // ── Tool active: place actor on empty space (skip non-placement tools) ──
    if (AppState.activeTool && AppState.activeTool !== 'ruler') {
      _placeActor(AppState.activeTool, world.x, world.y, e.shiftKey);
      return;
    }

    // Click on empty space with no tool: deselect
    AppState.select(null);
  });

  // ── Place actor ──────────────────────────────────────────────────────────────

  const ROAD_FACING_TYPES = new Set(['pedestrian', 'child', 'cyclist', 'bicycle']);

  function _placeActor(type, wx, wy, shiftKey = false) {
    if (type === 'prop') { _placeProp(wx, wy, shiftKey); return; }

    const pendingTemplate = AppState.pendingTemplate;
    const templatePlacement = ScenarioTemplates.placementFor(pendingTemplate);
    const roadFacing = ROAD_FACING_TYPES.has(type);
    const laneSnap = templatePlacement?.snap === 'lane-center'
      ? _nearestLaneProjection(
          wx,
          wy,
          new Set(templatePlacement.laneTypes || []),
          templatePlacement.maxDistance
        )
      : null;
    const spawnSnap = roadFacing || templatePlacement ? null : AppState.nearestSpawn(wx, wy, 12);
    const snap = laneSnap || spawnSnap;
    const x = snap ? snap.x : Math.round(wx * 10) / 10;
    const y = snap ? snap.y : Math.round(wy * 10) / 10;
    let yaw = roadFacing ? _roadFacingYaw(wx, wy) : 0;
    if (templatePlacement?.orientation === 'along-lane') yaw = _roadAlongYaw(wx, wy);
    if (snap) yaw = snap.yaw ?? snap.laneYaw;

    let newId;
    if (type === 'ego') {
      const actor = {
        id: AppState.nextId(), type: 'ego', x, y, z: 0.2, yaw,
        trajectory: [],
        events: [],
      };
      AppState.set({ ego: actor });
      newId = actor.id;
    } else {
      const actor = {
        id: AppState.nextId(), type, x, y, z: 0.2, yaw,
        behaviors: ['constant_speed'],
        trigger_distance: 400,
        events: [],
      };
      actor.events = ScenarioTemplates.eventsForActor(actor, pendingTemplate);
      AppState.npcs = [...AppState.npcs, actor];
      AppState.set({});
      newId = actor.id;
    }

    // Deactivate tool after placing so user can immediately drag/select
    AppState.set({ activeTool: null, pendingTemplate: null, pendingProp: null });
    AppState.select(newId);
    MapView.renderAllActors();
    const label = ScenarioTemplates.label(pendingTemplate);
    if (label) {
      Toast.success(`${label}-Template erstellt`);
    }
  }

  /* Static props: free placement by default — cones, barriers and containers
   * belong on shoulders, tapers and sidewalks, not on lane centres. Shift snaps
   * to the nearest lane centreline and aligns yaw to lane direction.
   *
   * Unlike actors this is sticky (the tool stays armed) and does not select the
   * new prop, so a cone line is one click per cone.
   */
  const PROP_SNAP_MAX_DIST = 20;   // Shift: how far to reach for a lane to snap onto
  const PROP_YAW_MAX_DIST  = 25;   // how far to reach for a lane to orient against

  /** Normalise degrees into [-180, 180). */
  function _wrapDeg(deg) {
    return ((deg + 180) % 360 + 360) % 360 - 180;
  }

  /* Placement orientation for a prop, from the OpenDRIVE direction of the
   * specific lane nearest the click. `near.laneYaw` is true lane *travel*
   * direction — map_renderer reverses directionLine for left-side lanes — so
   * on a two-way road the two carriageways give yaws 180° apart and an
   * 'oncoming' prop on each side faces its own lane's traffic.
   *
   * wx/wy must be the ORIGINAL click point, not a snapped position: Shift puts
   * the prop on the lane centreline, where "which side of the lane" degenerates.
   */
  function _propYawFor(blueprint, wx, wy, near) {
    const rule = PropCatalog.facing(blueprint);
    if (rule === 'none' || !near) return 0;

    const toRoad = Math.atan2(near.y - wy, near.x - wx) * 180 / Math.PI;

    switch (rule) {
      case 'oncoming':
        return Math.round(_wrapDeg(near.laneYaw + 180));
      case 'along':
        return Math.round(_wrapDeg(near.laneYaw));
      case 'toward-road':
        return Math.round(_wrapDeg(toRoad));
      case 'alongside': {
        // Long axis stays parallel to the kerb; pick the flip that turns the
        // object's open side (local +Y, i.e. yaw + 90) toward the carriageway.
        const openAt = _wrapDeg(near.laneYaw + 90);
        const flip   = Math.abs(_wrapDeg(openAt - toRoad)) > 90;
        return Math.round(_wrapDeg(near.laneYaw + (flip ? 180 : 0)));
      }
      default:
        return 0;
    }
  }

  function _placeProp(wx, wy, shiftKey) {
    const blueprint = AppState.pendingProp;
    if (!blueprint || !window.PropCatalog?.get(blueprint)) {
      Toast.error('Keine Requisite ausgewählt');
      AppState.set({ activeTool: null, pendingProp: null });
      return;
    }

    // Orientation always applies; Shift only controls POSITION.
    const near = _nearestLaneProjection(wx, wy, null, PROP_YAW_MAX_DIST);
    const snap = shiftKey && near && near.dist <= PROP_SNAP_MAX_DIST ? near : null;
    const prop = {
      id: AppState.nextId(),
      type: 'prop',
      prop: blueprint,
      x: snap ? Math.round(snap.x * 10) / 10 : Math.round(wx * 10) / 10,
      y: snap ? Math.round(snap.y * 10) / 10 : Math.round(wy * 10) / 10,
      z: PropCatalog.defaultZ(blueprint),
      yaw: _propYawFor(blueprint, wx, wy, near),
    };

    AppState.staticObjects = [...AppState.staticObjects, prop];
    AppState.set({});          // empty patch: fires 'change' for the array mutation
    MapView.renderAllActors();
  }

  function _roadFacingYaw(wx, wy) {
    const nearest = _nearestLaneProjection(wx, wy);
    if (!nearest) return 0;
    const towardRoad = Math.atan2(nearest.y - wy, nearest.x - wx) * 180 / Math.PI;
    if (Math.hypot(nearest.x - wx, nearest.y - wy) > 0.2) return Math.round(towardRoad);
    return Math.round(nearest.laneYaw + 90);
  }

  function _roadAlongYaw(wx, wy) {
    const nearest = _nearestLaneProjection(wx, wy);
    return nearest ? Math.round(nearest.laneYaw) : 0;
  }

  function _nearestLaneProjection(wx, wy, laneTypes = null, maxDistance = Infinity) {
    let best = null;
    for (const road of AppState.mapData?.roads || []) {
      for (const lane of road.lanes || []) {
        if (laneTypes?.size && !laneTypes.has(lane.type)) continue;
        const line = lane.directionLine || [];
        for (let i = 1; i < line.length; i++) {
          const [x0, y0] = line[i - 1];
          const [x1, y1] = line[i];
          const dx = x1 - x0;
          const dy = y1 - y0;
          const len2 = dx * dx + dy * dy;
          if (len2 <= 0) continue;
          const t = Math.max(0, Math.min(1, ((wx - x0) * dx + (wy - y0) * dy) / len2));
          const x = x0 + t * dx;
          const y = y0 + t * dy;
          const dist = Math.hypot(wx - x, wy - y);
          if (dist <= maxDistance && (!best || dist < best.dist)) {
            best = {
              x, y, dist,
              laneYaw: Math.atan2(dy, dx) * 180 / Math.PI,
              laneId: lane.laneId, laneType: lane.type,
            };
          }
        }
      }
    }
    return best;
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
    if (actorGroup && !AppState.activeTool && !AppState.trajectoryMode && !AppState.routeMode) {
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

  // ── Path drawing mode ─────────────────────────────────────────────────────────

  AppState.on('change', patch => {
    if (!('trajectoryMode' in patch) && !('activeTrajectoryId' in patch) &&
        !('routeMode' in patch) && !('activeRouteId' in patch) &&
        !('activePathEventId' in patch)) return;
    const activeId = (AppState.trajectoryMode && AppState.activeTrajectoryId) ||
                     (AppState.routeMode && AppState.activeRouteId);
    const active = !!activeId;
    trajBanner.classList.toggle('hidden', !active);
    svg.classList.toggle('trajectory-mode', !!active);
    if (active) {
      const actor = AppState.findById(activeId);
      trajBannerName.textContent = actor ? AppState.actorLabel(actor, { ego: 'EGO' }) : activeId;
    }
  });

  trajDoneBtn.addEventListener('click', () => {
    _finishPathMode();
  });

  trajUndoBtn.addEventListener('click', () => {
    const type = AppState.routeMode ? 'route' : 'trajectory';
    const id = AppState.routeMode ? AppState.activeRouteId : AppState.activeTrajectoryId;
    const eventId = AppState.activePathEventId;
    if (!id) return;
    const actor = _findActor(id);
    const path = actor ? _eventPath(actor, eventId, type) : null;
    if (!path?.length) return;
    if (eventId && actor.type !== 'ego') _setEventPath(actor, eventId, type, path.slice(0, -1));
    else if (type === 'trajectory') actor.trajectory = path.slice(0, -1);
    AppState.emit('actorUpdated', id);
  });

  function _finishPathMode() {
    AppState.set({ trajectoryMode: false, activeTrajectoryId: null, routeMode: false, activeRouteId: null, activePathEventId: null });
  }

  /** Find any actor (ego or NPC) that supports path drawing. */
  function _findActor(id) {
    if (AppState.ego && AppState.ego.id === id) return AppState.ego;
    return AppState.npcs.find(n => n.id === id) || null;
  }

  function _eventPath(actor, eventId, type) {
    if (!eventId || actor.type === 'ego') {
      return type === 'trajectory' ? actor.trajectory : null;
    }
    const ev = (actor.events || []).find(item => item.id === eventId);
    const action = ev?.action;
    if (!action) return null;
    return type === 'route' ? action.waypoints : action.trajectory;
  }

  function _setEventPath(actor, eventId, type, points) {
    actor.events = (actor.events || []).map(ev => {
      if (ev.id !== eventId) return ev;
      const action = ev.action || { type: type === 'route' ? 'assign_route' : 'follow_trajectory' };
      return {
        ...ev,
        action: type === 'route'
          ? { ...action, type: 'assign_route', waypoints: points }
          : { ...action, type: 'follow_trajectory', trajectory: points },
      };
    });
  }

  function startPathMode(actorId, type, eventId = null) {
    const actor = _findActor(actorId);
    if (!actor) return;
    if (type === 'route' && (!eventId || actor.type === 'ego')) return;
    let path = _eventPath(actor, eventId, type);
    if (!path || path.length === 0) {
      path = type === 'trajectory'
        ? [{ x: actor.x, y: actor.y, velocity: 10.0 }]
        : [{ x: actor.x, y: actor.y }];
      if (eventId && actor.type !== 'ego') _setEventPath(actor, eventId, type, path);
      else if (type === 'trajectory') actor.trajectory = path;
    }
    AppState.set({
      activeTool: null,
      pendingTemplate: null,
      trajectoryMode: type === 'trajectory',
      activeTrajectoryId: type === 'trajectory' ? actorId : null,
      routeMode: type === 'route',
      activeRouteId: type === 'route' ? actorId : null,
      activePathEventId: eventId,
      triggerPointMode: null,
    });
    MapView.renderAllActors();
  }

  function _addPathPoint(actorId, type, wx, wy, eventId = null) {
    const actor = _findActor(actorId);
    if (!actor) return;
    let path = _eventPath(actor, eventId, type);
    if (!path) path = [];
    const point = { x: Math.round(wx * 10) / 10, y: Math.round(wy * 10) / 10 };
    if (type === 'trajectory') {
      point.velocity = path.length > 0
        ? path[path.length - 1].velocity
        : 10.0;
    }
    path.push(point);
    if (eventId && actor.type !== 'ego') _setEventPath(actor, eventId, type, path);
    else if (type === 'trajectory') actor.trajectory = path;
    AppState.emit('actorUpdated', actorId);
  }

  function _setTriggerPoint(target, wx, wy) {
    const actor = _findActor(target.actorId);
    if (!actor) return;
    const events = actor.events || [];
    const currentEvent = events.find(ev => ev.id === target.eventId);
    const pointIndex = events.reduce((max, ev) => {
      const match = String(ev.trigger?.point?.name || '').match(/^Point\s+(\d+)$/);
      return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0) + 1;
    const point = {
      name: currentEvent?.trigger?.point?.name || `Point ${pointIndex}`,
      x: Math.round(wx * 10) / 10,
      y: Math.round(wy * 10) / 10,
      z: 0.2,
    };
    const patchedEvents = events.map(ev => {
      if (ev.id !== target.eventId) return ev;
      return {
        ...ev,
        trigger: {
          type: 'distance_to_point',
          value: ev.trigger?.value ?? 20,
          entity_ref: ev.trigger?.entity_ref || AppState.ego?.id || actor.id,
          point,
        },
      };
    });
    AppState.updateById(actor.id, { events: patchedEvents });
    AppState.set({ triggerPointMode: null });
  }

  function deletePathPoint(actorId, type, idx, eventId = null) {
    const actor = _findActor(actorId);
    const path = actor ? _eventPath(actor, eventId, type) : null;
    if (!actor || !path) return;
    path.splice(idx, 1);
    if (eventId && actor.type !== 'ego') _setEventPath(actor, eventId, type, path);
    else if (type === 'trajectory') actor.trajectory = path;
    AppState.emit('actorUpdated', actorId);
  }

  function setPathPointVelocity(actorId, type, idx, velocity, eventId = null) {
    if (type !== 'trajectory') return;
    const actor = _findActor(actorId);
    const path = actor ? _eventPath(actor, eventId, type) : null;
    if (!actor || !path?.[idx]) return;
    path[idx].velocity = parseFloat(velocity) || 10.0;
    if (eventId && actor.type !== 'ego') _setEventPath(actor, eventId, type, path);
    else actor.trajectory = path;
    AppState.emit('actorUpdated', actorId);
  }

  function clearPath(actorId, type, eventId = null) {
    const actor = _findActor(actorId);
    if (!actor) return;
    if (eventId && actor.type !== 'ego') _setEventPath(actor, eventId, type, []);
    else if (type === 'trajectory') actor.trajectory = [];
    AppState.emit('actorUpdated', actorId);
  }

  // ── Public interface ─────────────────────────────────────────────────────────
  window.ObjectsManager = {
    startPathMode,
    deletePathPoint,
    setPathPointVelocity,
    clearPath,
  };
})();
