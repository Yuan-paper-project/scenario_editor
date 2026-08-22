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
  const trajBannerText = document.getElementById('traj-banner-text');
  const trajDoneBtn    = document.getElementById('traj-done-btn');
  const trajUndoBtn    = document.getElementById('traj-undo-btn');

  // Speed a newly placed actor starts with, emitted as a SpeedAction in the
  // Storyboard Init. An actor with no events gets no Act at all, so this is the
  // only speed it ever has — placing one at the default means it drives, rather
  // than spawning into a scenario as an invisible obstacle.
  //
  // This is the *placement* default only. An actor loaded from a save file or
  // seeded straight into AppState without the field defaults to 0 instead
  // (AppState._hydrateActor, backend _normalize_actor) — a legacy scenario must
  // not have its stationary actors quietly set in motion.
  const DEFAULT_INIT_SPEED = 10.0;

  // ── Drag state ───────────────────────────────────────────────────────────────
  let _dragState = null;   // { type: 'actor'|'yaw'|'waypoint', actorId, ... }

  // ── SVG click handler ─────────────────────────────────────────────────────────

  svg.addEventListener('click', e => {
    if (e.defaultPrevented) return;
    if (_wasDragging) { _wasDragging = false; return; }

    const world = MapView.svgToWorld(e);

    const activeType = AppState.routeMode ? 'route' : 'trajectory';
    const activeId = AppState.routeMode ? AppState.activeRouteId : AppState.activeTrajectoryId;
    if ((AppState.trajectoryMode || AppState.routeMode) && activeId) {
      _addPathPoint(activeId, activeType, world.x, world.y, AppState.activePathEventId);
      return;
    }

    // A waypoint marker owns its own click: mousedown already marked it (and
    // may have dragged it). Without this the click falls through to the
    // deselect branch at the bottom, which drops the actor whose waypoints are
    // the only reason the marker was reachable in the first place.
    if (e.target.closest('.path-waypoint')) return;

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
    // A snap already carries the surface height of the exact point it snapped
    // to; free placement has to look it up at the final position.
    const z = _roundZ((snap?.z ?? groundZAt(x, y)) + _clearanceFor(type));

    // Ego and NPCs share the same actor shape — initial_speed and events both
    // mean the same thing for both. Only the storage differs.
    const actor = {
      id: AppState.nextId(), type, x, y, z, yaw,
      initial_speed: DEFAULT_INIT_SPEED,
      events: [],
    };
    // No template targets 'ego' (ScenarioTemplates.eventsForActor requires
    // actor.type === template.actorType), so this is a no-op [] for the ego.
    actor.events = ScenarioTemplates.eventsForActor(actor, pendingTemplate);
    if (type === 'ego') {
      AppState.set({ ego: actor });
    } else {
      AppState.npcs = [...AppState.npcs, actor];
      AppState.set({});
    }
    const newId = actor.id;

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
    const x = snap ? Math.round(snap.x * 10) / 10 : Math.round(wx * 10) / 10;
    const y = snap ? Math.round(snap.y * 10) / 10 : Math.round(wy * 10) / 10;
    const prop = {
      id: AppState.nextId(),
      type: 'prop',
      prop: blueprint,
      x,
      y,
      // Catalogue z is an offset from the road surface, not an absolute height.
      z: _roundZ(groundZAt(x, y) + PropCatalog.defaultZ(blueprint)),
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
          const [x0, y0, z0 = 0] = line[i - 1];
          const [x1, y1, z1 = 0] = line[i];
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
              // Road-surface height, lerped along the same segment the position
              // came from. The `= 0` destructuring defaults keep this working
              // against 2-element points, i.e. a cached older render payload.
              z: z0 + t * (z1 - z0),
              laneYaw: Math.atan2(dy, dx) * 180 / Math.PI,
              laneId: lane.laneId, laneType: lane.type,
              road, lane, segIndex: i,
            };
          }
        }
      }
    }
    return best;
  }

  /* Ground height ─────────────────────────────────────────────────────────────
   *
   * Every z the editor writes is the OpenDRIVE road surface at (x, y) plus a
   * per-category clearance. A fixed z (this used to be 0.2 for actors) puts an
   * object metres under the road on any map with a gradient — Town03 road 67
   * climbs to 2.7 m and back to 0 within its own length.
   *
   * Clearance always errs HIGH. Spawning below the surface fails hard in CARLA
   * ("collision at spawn position"); spawning above it is free, because actors
   * spawn with physics and settle within a tick.
   *
   * VRUs get more than vehicles because <elevationProfile> is the *reference
   * line* surface — it models neither kerb height nor sidewalk elevation, and
   * sidewalk lanes carry no directionLine, so a pedestrian standing on a kerb
   * takes its z from the carriageway roughly 0.15 m below it. A pedestrian at
   * z=0.2 clipping geometry and failing to spawn is what this margin is for.
   *
   * Props are NOT given clearance: a <MiscObject> has no settle behaviour, and
   * the catalogue's per-prop z is already a surface-relative offset.
   */
  const SPAWN_CLEARANCE = { vehicle: 0.5, vru: 0.6, waypoint: 0.5 };
  const GROUND_Z_MAX_DIST = 60;   // how far to reach for a lane to take height from

  function _clearanceFor(type) {
    return ROAD_FACING_TYPES.has(type) ? SPAWN_CLEARANCE.vru : SPAWN_CLEARANCE.vehicle;
  }

  /** Round to cm — z is derived, so it should not carry float noise into saves. */
  function _roundZ(z) {
    return Math.round(z * 100) / 100;
  }

  /* Road-surface height at (wx, wy), or 0 when nothing is within reach.
   *
   * A generous radius is safe here in a way it is not for yaw: z has no side or
   * direction semantics, so the nearest lane is always a defensible answer. */
  function groundZAt(wx, wy) {
    const near = _nearestLaneProjection(wx, wy, null, GROUND_Z_MAX_DIST);
    return near ? near.z : 0;
  }

  /* Route waypoints snap to the lane centreline ────────────────────────────
   *
   * A route waypoint is never driven to as authored: AssignRouteAction hands
   * each one to GlobalRoutePlanner, which projects it with map.get_waypoint()
   * and routes to whichever lane centre came out. So a point dropped between
   * two lanes is not "between two lanes" — it silently becomes one of them, and
   * when that is the oncoming carriageway the vehicle drives away from the
   * route and loops back to reach it (weirdLooping.xosc). Snapping at authoring
   * time makes the map show the point CARLA will actually use.
   *
   * follow_trajectory is deliberately NOT snapped: a trajectory is driven
   * literally, vertex by vertex, and its whole purpose is going where lanes do
   * not — a pedestrian crossing, a cyclist bending out, a reversing curve.
   */
  const ROUTE_SNAP_LANE_TYPES = new Set(['driving', 'bidirectional']);
  const ROUTE_SNAP_MAX_DIST   = 25;   // how far to reach for a lane to snap onto

  /**
   * A route waypoint for the click at (wx, wy): the nearest driving-lane
   * centreline point, or the raw click when no lane is within reach.
   *
   * Returns {x, y, z, snapped}. The snapped case takes its z from the same
   * lane segment the position came from, so no separate elevation lookup is
   * needed; the unsnapped case falls back to the ordinary surface query.
   */
  function _routeWaypointAt(wx, wy) {
    const near = _nearestLaneProjection(wx, wy, ROUTE_SNAP_LANE_TYPES, ROUTE_SNAP_MAX_DIST);
    if (!near) {
      const x = Math.round(wx * 10) / 10;
      const y = Math.round(wy * 10) / 10;
      return { x, y, z: _roundZ(groundZAt(x, y) + SPAWN_CLEARANCE.waypoint), snapped: false };
    }
    return {
      x: Math.round(near.x * 10) / 10,
      y: Math.round(near.y * 10) / 10,
      z: _roundZ(near.z + SPAWN_CLEARANCE.waypoint),
      snapped: true,
    };
  }

  /* Height for an object of `type` standing at (x, y): road surface plus the
   * category's clearance, or plus the catalogue offset for a prop. The single
   * entry point for anything that moves an already-placed object. */
  function _surfaceZFor(type, x, y, propBlueprint = null) {
    const base = type === 'prop'
      ? PropCatalog.defaultZ(propBlueprint)
      : _clearanceFor(type);
    return _roundZ(groundZAt(x, y) + base);
  }

  // ── Drag actors ───────────────────────────────────────────────────────────────

  let _wasDragging = false;

  svg.addEventListener('mousedown', e => {
    if (e.button !== 0) return;

    // Nothing on the map is draggable while a tool is armed or a path is being
    // drawn: a click there means "place" or "select", never "edit this pose".
    // The rotate branch below used to lack this guard, so grabbing the handle
    // with a tool armed spun the actor while grabbing its body selected it.
    if (AppState.activeTool || AppState.trajectoryMode || AppState.routeMode) return;

    /* A path waypoint of the SELECTED actor: mark it, and drag it.
     *
     * Only the selected actor's waypoints are hit-testable at all (mapView
     * renders everyone else's with pointer-events: none), so this branch can
     * never steal a mousedown aimed at some other actor's path drawn across
     * the same stretch of road. The mark is set here rather than on click so
     * that a drag marks the point it is about to move.
     */
    const wpEl = e.target.closest('.path-waypoint');
    if (wpEl) {
      const actorId  = wpEl.dataset.actorId;
      const eventId  = wpEl.dataset.eventId;
      const pathType = wpEl.dataset.pathType;
      const index    = Number(wpEl.dataset.wpIdx);
      if (actorId === AppState.selectedId && Number.isFinite(index)) {
        AppState.selectWaypoint({ actorId, eventId, pathType, index });
        _dragState = { type: 'waypoint', actorId, eventId, pathType, index };
        document.body.classList.add('dragging-actor');
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }

    /* Rotate: the yaw handle only.
     *
     * One class, no string-matching on `style` or `class*="arrow"` as this used
     * to do. `.yaw-handle` is placed a real gap outside the body's own hit
     * target (mapView.js _buildYawArrow), so this branch and the body branch
     * below can never both match the same pixel.
     */
    const handle = e.target.closest('.yaw-handle');
    if (handle) {
      const actorId = handle.dataset.actorId ||
                      handle.closest('[data-actor-id]')?.dataset?.actorId;
      const actor   = actorId ? AppState.findById(actorId) : null;
      if (actor) {
        _dragState = {
          type: 'yaw',
          actorId,
          actorPos: { x: actor.x, y: actor.y },
        };
        // The cursor lives on <body> for the duration, not on the handle: every
        // updateById re-renders the actor layer, so the element the drag started
        // on is detached within a frame and :active never survives.
        document.body.classList.add('rotating');
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }

    // Move: the body.
    const actorGroup = e.target.closest('.actor-group');
    if (actorGroup) {
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
        document.body.classList.add('dragging-actor');
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

    } else if (_dragState.type === 'waypoint') {
      ObjectsManager.movePathPoint(
        _dragState.actorId, _dragState.pathType, _dragState.index,
        world.x, world.y, _dragState.eventId,
      );

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
      // Re-derive the height for the position the object was dropped at. This
      // runs on mouseup rather than on every mousemove deliberately:
      // _nearestLaneProjection is a linear scan over every lane segment (~59k
      // points on Town03), so doing it per frame would make dragging stutter —
      // and z has no visual effect at all in a top-down 2D view.
      if (_dragState.type === 'actor') {
        const actor = AppState.findById(_dragState.actorId);
        if (actor) {
          // Not recorded: the drag's own undo entry was taken before the first
          // mousemove and already holds the pre-drag z. Left unsuspended this
          // would be a second entry — different patch keys, so it does not
          // coalesce — and one Strg+Z would put the height back without the
          // position.
          UndoStack.suspend();
          AppState.updateById(actor.id, {
            z: _surfaceZFor(actor.type, actor.x, actor.y, actor.prop),
          });
          UndoStack.resume();
        }
      }
      // Same deal for a dragged trajectory vertex: x/y tracked the cursor every
      // frame, the elevation lookup waited for the drop. A route waypoint needs
      // nothing here — its z came out of the lane snap on every move.
      if (_dragState.type === 'waypoint' && _dragState.pathType !== 'route') {
        const actor = _findActor(_dragState.actorId);
        const path = actor ? _eventPath(actor, _dragState.eventId, _dragState.pathType) : null;
        const pt = path?.[_dragState.index];
        if (pt) {
          UndoStack.suspend();
          ObjectsManager.movePathPoint(
            _dragState.actorId, _dragState.pathType, _dragState.index,
            pt.x, pt.y, _dragState.eventId, true,
          );
          UndoStack.resume();
        }
      }
      _dragState = null;
      document.body.classList.remove('rotating', 'dragging-actor');
      setTimeout(() => { _wasDragging = false; }, 50);
    }
  });

  // ── Path drawing mode ─────────────────────────────────────────────────────────

  // What the banner is currently announcing, so leaving a mode can be detected
  // and acted on. A path event that never got 2 waypoints is discarded here
  // rather than in _finishPathMode(): Esc clears the mode flags directly
  // (mapView.js), so hanging the check off the *button* would miss it.
  let _drawContext = null;   // { actorId, eventId, type }

  AppState.on('change', patch => {
    if (!('trajectoryMode' in patch) && !('activeTrajectoryId' in patch) &&
        !('routeMode' in patch) && !('activeRouteId' in patch) &&
        !('activePathEventId' in patch)) return;

    const pathId = (AppState.trajectoryMode && AppState.activeTrajectoryId) ||
                   (AppState.routeMode && AppState.activeRouteId);
    const next = pathId
      ? {
        actorId: pathId,
        eventId: AppState.activePathEventId,
        type: AppState.routeMode ? 'route' : 'trajectory',
      }
      : null;

    const left = _drawContext;
    _drawContext = next;
    if (left && !(next && next.actorId === left.actorId && next.eventId === left.eventId)) {
      _discardIncompletePath(left);
    }

    const active = !!next;
    trajBanner.classList.toggle('hidden', !active);
    svg.classList.toggle('trajectory-mode', active);
    if (!active) return;

    const actor = AppState.findById(next.actorId);
    const name = actor ? AppState.actorLabel(actor, { short: true }) : next.actorId;
    trajBannerText.innerHTML =
      `${next.type === 'route' ? 'Route' : 'Pfad'} für <strong></strong> zeichnen — auf die Karte klicken, `
      + `um Wegpunkte zu setzen · <b>Enter</b> beendet`;
    trajBannerText.querySelector('strong').textContent = name;
  });

  /**
   * Drop a path event that was left with fewer than 2 waypoints.
   *
   * Such an event is dropped by the emitter anyway (_add_follow_trajectory_action
   * / _add_assign_route_action return False under 2 points) and takes any
   * after_event chained onto it down with it, so the editor removes it at the
   * moment it becomes clear the user is not going to finish drawing.
   * EventPanel.deleteEvent does the re-pointing of those chains.
   */
  function _discardIncompletePath(context) {
    const actor = _findActor(context.actorId);
    if (!actor) return;
    const ev = (actor.events || []).find(item => item.id === context.eventId);
    if (!ev) return;
    const action = ev.action || {};
    const isRoute = action.type === 'assign_route';
    if (action.type !== 'follow_trajectory' && !isRoute) return;
    const points = isRoute ? (action.waypoints || []) : (action.trajectory || []);
    if (points.length >= 2) return;

    EventPanel.deleteEvent(actor, context.eventId);
    Toast.warn(isRoute
      ? 'Event verworfen — eine Route braucht mindestens 2 Wegpunkte'
      : 'Event verworfen — eine Trajektorie braucht mindestens 2 Wegpunkte');
    MapView.renderAllActors();
  }

  // loadJSON clears every mode flag by direct assignment and emits 'stateLoaded'
  // rather than 'change', so the handler above never sees it. Without this the
  // banner would survive a load started mid-draw, and _drawContext would keep
  // pointing at an id from the scenario that was just replaced — ids restart at
  // obj-1/evt-1 in every file, so that is a real collision, not a theoretical one.
  AppState.on('stateLoaded', () => {
    _drawContext = null;
    trajBanner.classList.add('hidden');
    svg.classList.remove('trajectory-mode');
  });

  trajDoneBtn.addEventListener('click', () => {
    _finishPathMode();
  });

  // Enter finishes a path, so drawing one never needs the mouse to leave the
  // map: click the waypoints, press Enter. Esc still cancels (mapView.js).
  // Bound here rather than in mapView's keydown because _finishPathMode and the
  // banner both live in this module.
  window.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    if (!AppState.trajectoryMode && !AppState.routeMode) return;
    // A dialog on top owns Enter, and so does a focused field.
    if (window.Confirm?.isOpen) return;
    const t = e.target.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
    e.preventDefault();
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
    _setEventPath(actor, eventId, type, path.slice(0, -1));
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
    if (!eventId) return null;
    const ev = (actor.events || []).find(item => item.id === eventId);
    const action = ev?.action;
    if (!action) return null;
    return type === 'route' ? action.waypoints : action.trajectory;
  }

  function _setEventPath(actor, eventId, type, points) {
    const events = (actor.events || []).map(ev => {
      if (ev.id !== eventId) return ev;
      const action = ev.action || { type: type === 'route' ? 'assign_route' : 'follow_trajectory' };
      return {
        ...ev,
        action: type === 'route'
          ? { ...action, type: 'assign_route', waypoints: points }
          : { ...action, type: 'follow_trajectory', trajectory: points },
      };
    });
    // Through updateById, not `actor.events = …` directly. This used to be the
    // one scenario mutation in the app that reached neither of AppState's
    // mutators, which put it outside the undo history in the worst possible
    // way: not merely un-undoable, but *destroyed* by the next undo, because
    // the entry pushed after it described a world where the path was never
    // drawn. Undoing an unrelated rotate wiped a five-point trajectory.
    AppState.updateById(actor.id, { events });
  }

  function startPathMode(actorId, type, eventId = null) {
    const actor = _findActor(actorId);
    if (!actor || !eventId) return;
    // Waypoint 1 is the actor's own pose, so it inherits the actor's height too
    // and the first map click already completes a usable 2-point path.
    //
    // On its own that seed is what used to make a forgotten path event silently
    // wrong: one waypoint is below the 2 the emitter needs and draws nothing on
    // the map (mapView skips a path under 2 points), while the card claimed
    // "Pfad gezeichnet". The seed is fine; leaving it *alone* is what is not, so
    // the event is discarded on leaving draw mode instead
    // (_discardIncompletePath), and the card counts against 2 rather than 0.
    let path = _eventPath(actor, eventId, type);
    if (!path || path.length === 0) {
      if (type === 'trajectory') {
        path = [{ x: actor.x, y: actor.y, z: actor.z ?? 0, velocity: 10.0 }];
      } else {
        // Snapped like every other route waypoint. A vehicle sits on a spawn
        // point, which is a lane centre already, so this normally moves the
        // seed by centimetres — but a hand-typed or dragged pose need not be
        // on a lane at all, and leg 0 would then start off the network.
        const snap = _routeWaypointAt(actor.x, actor.y);
        path = [{ x: snap.x, y: snap.y, z: snap.snapped ? snap.z : (actor.z ?? 0) }];
      }
      _setEventPath(actor, eventId, type, path);
    }
    // Drawing into a hidden path would put every click somewhere invisible, so
    // starting a draw un-hides it for good (MapView.showPath flips the stored
    // toggle rather than overriding it, so the card's button stays truthful).
    MapView.showPath(actorId, eventId, type);
    AppState.set({
      activeTool: null,
      pendingTemplate: null,
      trajectoryMode: type === 'trajectory',
      activeTrajectoryId: type === 'trajectory' ? actorId : null,
      routeMode: type === 'route',
      activeRouteId: type === 'route' ? actorId : null,
      activePathEventId: eventId,
    });
    MapView.renderAllActors();
  }

  function _addPathPoint(actorId, type, wx, wy, eventId = null) {
    const actor = _findActor(actorId);
    if (!actor) return;
    let path = _eventPath(actor, eventId, type);
    if (!path) path = [];
    // Waypoints used to carry no z at all and picked up a flat 0.2 downstream,
    // which drags a trajectory across an elevated road straight under it.
    let point;
    if (type === 'route') {
      const snap = _routeWaypointAt(wx, wy);
      if (!snap.snapped) _warnUnsnapped();
      point = { x: snap.x, y: snap.y, z: snap.z };
    } else {
      const x = Math.round(wx * 10) / 10;
      const y = Math.round(wy * 10) / 10;
      point = { x, y, z: _roundZ(groundZAt(x, y) + SPAWN_CLEARANCE.waypoint) };
    }
    if (type === 'trajectory') {
      point.velocity = path.length > 0
        ? path[path.length - 1].velocity
        : 10.0;
    }
    // A NEW array, not path.push(). _eventPath returns the live
    // action.trajectory/waypoints, so mutating it in place would change the
    // actor before updateById is told about it — the patch would then be
    // identical to the state it is patching, the undo history would score it a
    // no-op, and the waypoint would not be undoable.
    _setEventPath(actor, eventId, type, [...path, point]);
  }

  /**
   * A trigger point at (wx, wy) for one event of `actor`, keeping the event's
   * existing name if it already had one.
   *
   * Shared by the marker drag (moveTriggerPoint) and by eventPanel.js, which
   * seeds a point the moment the trigger is selected so it is never null — a
   * point-less distance_to_point used to reach the backend and be silently
   * defaulted to the map origin.
   * DistanceCondition is 3-D, so the z comes from the elevation profile exactly
   * as a waypoint's does; a literal here cannot fire on a graded road.
   */
  function _triggerPointAt(actor, eventId, wx, wy) {
    const events = actor.events || [];
    const currentEvent = events.find(ev => ev.id === eventId);
    const pointIndex = events.reduce((max, ev) => {
      const match = String(ev.trigger?.point?.name || '').match(/^Point\s+(\d+)$/);
      return match ? Math.max(max, parseInt(match[1], 10)) : max;
    }, 0) + 1;
    const px = Math.round(wx * 10) / 10;
    const py = Math.round(wy * 10) / 10;
    return {
      name: currentEvent?.trigger?.point?.name || `Point ${pointIndex}`,
      x: px,
      y: py,
      z: _roundZ(groundZAt(px, py) + SPAWN_CLEARANCE.waypoint),
    };
  }

  /** The point a distance_to_point trigger starts life with: the actor's pose. */
  function defaultTriggerPoint(actorId, eventId) {
    const actor = _findActor(actorId);
    if (!actor) return null;
    return _triggerPointAt(actor, eventId, actor.x, actor.y);
  }

  /**
   * Move an existing trigger point to (wx, wy) — the end of a marker drag on
   * the map (mapView.js). The z is re-derived from the elevation profile here
   * and not on every mousemove, for the same reason an actor's is: the lookup
   * is a linear scan over every lane segment and z has no effect in a top-down
   * view.
   */
  function moveTriggerPoint(actorId, eventId, wx, wy) {
    const actor = _findActor(actorId);
    if (!actor) return;
    const events = actor.events || [];
    const point = _triggerPointAt(actor, eventId, wx, wy);
    const patchedEvents = events.map(ev => {
      if (ev.id !== eventId) return ev;
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
  }

  /* One warning per drawing run, not one per click: building a path across a
   * car park would otherwise stack a toast per waypoint. */
  let _unsnappedWarned = false;
  function _warnUnsnapped() {
    if (_unsnappedWarned) return;
    _unsnappedWarned = true;
    Toast.warn(`Kein Fahrstreifen in ${ROUTE_SNAP_MAX_DIST} m — Wegpunkt nicht eingerastet`);
    setTimeout(() => { _unsnappedWarned = false; }, 4000);
  }

  /**
   * Move one existing waypoint to (wx, wy) — the map drag.
   *
   * A route waypoint is snapped here exactly as it is at placement, so dragging
   * one cannot put it somewhere clicking one could not. `deriveZ` is off during
   * the drag itself for a trajectory point (the elevation lookup is a linear
   * scan over every lane segment, the same reason an actor's z waits for
   * mouseup) — a route point gets its z free, out of the snap.
   */
  function movePathPoint(actorId, type, idx, wx, wy, eventId = null, deriveZ = false) {
    const actor = _findActor(actorId);
    const path = actor ? _eventPath(actor, eventId, type) : null;
    if (!actor || !path?.[idx]) return;

    let patch;
    if (type === 'route') {
      const snap = _routeWaypointAt(wx, wy);
      patch = { x: snap.x, y: snap.y, z: snap.z };
    } else {
      const x = Math.round(wx * 10) / 10;
      const y = Math.round(wy * 10) / 10;
      patch = deriveZ
        ? { x, y, z: _roundZ(groundZAt(x, y) + SPAWN_CLEARANCE.waypoint) }
        : { x, y };
    }
    // Copy rather than write through to the live point — see _addPathPoint.
    _setEventPath(actor, eventId, type, path.map((pt, i) => (
      i === idx ? { ...pt, ...patch } : pt
    )));
  }

  function deletePathPoint(actorId, type, idx, eventId = null) {
    const actor = _findActor(actorId);
    const path = actor ? _eventPath(actor, eventId, type) : null;
    if (!actor || !path) return;
    // Copy rather than splice the live array — see _addPathPoint.
    _setEventPath(actor, eventId, type, path.filter((_, i) => i !== idx));
  }

  function setPathPointVelocity(actorId, type, idx, velocity, eventId = null) {
    if (type !== 'trajectory') return;
    const actor = _findActor(actorId);
    const path = actor ? _eventPath(actor, eventId, type) : null;
    if (!actor || !path?.[idx]) return;
    // Copy rather than write through to the live point — see _addPathPoint.
    _setEventPath(actor, eventId, type, path.map((pt, i) => (
      i === idx ? { ...pt, velocity: parseFloat(velocity) || 10.0 } : pt
    )));
  }

  function clearPath(actorId, type, eventId = null) {
    const actor = _findActor(actorId);
    if (!actor || !eventId) return;
    _setEventPath(actor, eventId, type, []);
  }

  // ── Public interface ─────────────────────────────────────────────────────────
  window.ObjectsManager = {
    startPathMode,
    defaultTriggerPoint,
    moveTriggerPoint,
    movePathPoint,
    deletePathPoint,
    setPathPointVelocity,
    clearPath,
    groundZAt,
    surfaceZFor: _surfaceZFor,
    // Exposed for simulate.js's lane-follow preview: same projection used for
    // placement/yaw, now also needed to snap an actor onto its spawn lane and
    // to test for a same-direction neighbour lane (lane_change feasibility).
    // Returns {x, y, dist, z, laneYaw, laneId, laneType, road, lane} or null;
    // `road`/`lane` are the actual render-JSON objects, by reference — the
    // caller can walk `lane.directionLine` directly rather than re-querying,
    // which sidesteps the fact that road.lanes is flattened across lane
    // sections with no section marker (see CLAUDE.md).
    nearestLaneProjection: _nearestLaneProjection,
  };
})();
