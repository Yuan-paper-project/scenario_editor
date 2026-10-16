/**
 * objects.js — Actor placement, selection, dragging, yaw-arrow rotation,
 *              and path waypoint drawing.
 *
 * Interactions:
 *   - Click on map with active tool → place a vehicle on the nearest lane centre,
 *     facing the lane (Shift: at the cursor). Pedestrians/cyclists stay at the
 *     clicked point and face the nearest road.
 *   - Click on existing actor → select it
 *   - Drag actor body → move actor (vehicles snap to a lane; Shift: free)
 *   - Drag yaw arrow head → rotate actor
 *   - In path drawing mode → click on map to add waypoint
 */
(() => {
  'use strict';

  const {
    svg,
    drag,
    ROAD_FACING_TYPES,
    _propYawFor,
    _roadFacingYaw,
    _roadAlongYaw,
    _nearestLaneProjection,
    _vehicleLaneSnap,
    _clearanceFor,
    _roundZ,
    groundZAt,
    _routeWaypointAt,
    _surfaceZFor,
    startPathMode,
    _addPathPoint,
    defaultTriggerPoint,
    moveTriggerPoint,
    movePathPoint,
    deletePathPoint,
    setPathPointStrategy,
    setPathVelocity,
    clearPath,
  } = ObjectsCore.shared;

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

  // ── SVG click handler ─────────────────────────────────────────────────────────

  svg.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    if (drag.wasDragging) {
      drag.wasDragging = false;
      return;
    }

    const world = MapView.svgToWorld(e);

    const activeType = AppState.routeMode ? 'route' : 'trajectory';
    const activeId = AppState.routeMode ? AppState.activeRouteId : AppState.activeTrajectoryId;
    if ((AppState.trajectoryMode || AppState.routeMode) && activeId) {
      _addPathPoint(activeId, activeType, world.x, world.y, AppState.activePathEventId, e.shiftKey);
      return;
    }

    // "Generate here": the click is the spot the generator builds a conflict
    // at, wherever it lands — on an actor too, since the scenario is replaced.
    if (AppState.pendingGenerate) {
      ScenarioGenerator.generateAtClick(world.x, world.y, e);
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
      AppState.set({ activeTool: null, pendingTemplate: null, pendingProp: null }); // exit placement mode
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

  function _placeActor(type, wx, wy, shiftKey = false) {
    if (type === 'prop') {
      _placeProp(wx, wy, shiftKey);
      return;
    }

    const pendingTemplate = AppState.pendingTemplate;
    const templatePlacement = ScenarioTemplates.placementFor(pendingTemplate);
    const roadFacing = ROAD_FACING_TYPES.has(type);
    const laneSnap =
      templatePlacement?.snap === 'lane-center'
        ? _nearestLaneProjection(wx, wy, new Set(templatePlacement.laneTypes || []), templatePlacement.maxDistance)
        : null;
    const vehicleSnap = roadFacing || templatePlacement || shiftKey ? null : _vehicleLaneSnap(wx, wy);
    const snap = laneSnap || vehicleSnap;
    const x = snap ? snap.x : Math.round(wx * 10) / 10;
    const y = snap ? snap.y : Math.round(wy * 10) / 10;
    // Shift on a vehicle: the position is the click, but it still faces along
    // the nearest lane rather than due east.
    let yaw = roadFacing ? _roadFacingYaw(wx, wy) : shiftKey ? _roadAlongYaw(wx, wy) : 0;
    if (templatePlacement?.orientation === 'along-lane') yaw = _roadAlongYaw(wx, wy);
    if (snap) yaw = snap.yaw ?? snap.laneYaw;
    // A snap already carries the surface height of the exact point it snapped
    // to; free placement has to look it up at the final position.
    const z = _roundZ((snap?.z ?? groundZAt(x, y)) + _clearanceFor(type));

    // Ego and NPCs share the same actor shape — initial_speed and events both
    // mean the same thing for both. Only the storage differs.
    // A walker or cyclist starts still: an Init <SpeedAction> lands on tick 1,
    // so a pedestrian placed at 10 m/s used to sprint off at 36 km/h along its
    // heading before any trigger had a chance to fire. A template may state
    // its own (a parked car's is 0); vehicles keep DEFAULT_INIT_SPEED.
    const tplSpeed = ScenarioTemplates.initialSpeedFor(pendingTemplate);
    const actor = {
      id: AppState.nextId(),
      type,
      x,
      y,
      z,
      yaw,
      initial_speed: tplSpeed ?? (ROAD_FACING_TYPES.has(type) ? 0 : DEFAULT_INIT_SPEED),
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
  const PROP_SNAP_MAX_DIST = 20; // Shift: how far to reach for a lane to snap onto
  const PROP_YAW_MAX_DIST = 25; // how far to reach for a lane to orient against
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
    AppState.set({}); // empty patch: fires 'change' for the array mutation
    MapView.renderAllActors();
  }

  // ── Public interface ─────────────────────────────────────────────────────────
  window.ObjectsManager = {
    startPathMode,
    defaultTriggerPoint,
    moveTriggerPoint,
    movePathPoint,
    deletePathPoint,
    setPathPointStrategy,
    setPathVelocity,
    clearPath,
    groundZAt,
    surfaceZFor: _surfaceZFor,
    // AppState.updateById snaps a moving actor's seed waypoint with this, for
    // the same reason placement does: waypoint 0 is a routing seed and an
    // off-centre one gets projected onto a lane nobody chose.
    routeWaypointAt: _routeWaypointAt,
    // Exposed for simulate.js's lane-follow preview: same projection used for
    // placement/yaw, now also needed to snap an actor onto its spawn lane and
    // to test for a same-direction neighbour lane (lane_change feasibility).
    // Returns {x, y, dist, z, laneYaw, laneId, laneType, road, lane} or null;
    // `road`/`lane` are the actual render-JSON objects, by reference — the
    // caller can walk `lane.directionLine` directly rather than re-querying,
    // which sidesteps the fact that road.lanes is flattened across lane
    // sections with no section marker (see CLAUDE.md).
    nearestLaneProjection: _nearestLaneProjection,
    // The vehicle placement/drag snap: {x, y, z, yaw} on the nearest driving or
    // parking lane centre within 12 m, or null. `prevYaw` breaks ties between
    // overlapping junction connectors (tests/test_vehicle_snap_e2e.py).
    vehicleLaneSnap: _vehicleLaneSnap,
  };
})();
