/**
 * objects.js — the map click handler (place, select, deselect), actor and prop placement,
 * and the public ObjectsManager.
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

  // A placed vehicle's start speed (the Init SpeedAction). Placement only: an actor loaded
  // without the field gets 0, so an old scenario's parked actors stay parked.
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

    // „Konflikt hier erzeugen": the click is the spot, even on an actor (the scenario is replaced).
    if (AppState.pendingGenerate) {
      ScenarioGenerator.generateAtClick(world.x, world.y, e);
      return;
    }

    // A waypoint owns its click (mousedown marked it); falling through would deselect its actor.
    if (e.target.closest('.path-waypoint')) return;

    // An actor click selects, even with a tool armed — except the sticky prop tool, which places.
    const actorGroup = e.target.closest('.actor-group');
    if (actorGroup && AppState.activeTool !== 'prop') {
      const id = actorGroup.dataset.id;
      AppState.set({ activeTool: null, pendingTemplate: null, pendingProp: null }); // exit placement mode
      AppState.select(AppState.selectedId === id ? null : id);
      e.preventDefault();
      return;
    }

    if (AppState.activeTool && AppState.activeTool !== 'ruler') {
      _placeActor(AppState.activeTool, world.x, world.y, e.shiftKey);
      return;
    }

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
    // Shift on a vehicle: at the click, but facing along the nearest lane.
    let yaw = roadFacing ? _roadFacingYaw(wx, wy) : shiftKey ? _roadAlongYaw(wx, wy) : 0;
    if (templatePlacement?.orientation === 'along-lane') yaw = _roadAlongYaw(wx, wy);
    if (snap) yaw = snap.yaw ?? snap.laneYaw;
    const z = _roundZ((snap?.z ?? groundZAt(x, y)) + _clearanceFor(type));

    // Walkers start still: the Init speed lands on tick 1, before any trigger could fire.
    // A template may state its own; vehicles get DEFAULT_INIT_SPEED.
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
    actor.events = ScenarioTemplates.eventsForActor(actor, pendingTemplate);
    if (type === 'ego') {
      AppState.set({ ego: actor });
    } else {
      AppState.npcs = [...AppState.npcs, actor];
      AppState.set({});
    }
    const newId = actor.id;

    AppState.set({ activeTool: null, pendingTemplate: null, pendingProp: null });
    AppState.select(newId);
    MapView.renderAllActors();
    const label = ScenarioTemplates.label(pendingTemplate);
    if (label) {
      Toast.success(`${label}-Template erstellt`);
    }
  }

  /* Props are placed freely (Shift snaps to a lane centre); the tool stays armed and the new
   * prop is not selected, so a cone line is one click per cone. */
  const PROP_SNAP_MAX_DIST = 20; // Shift: how far to reach for a lane to snap onto
  const PROP_YAW_MAX_DIST = 25; // how far to reach for a lane to orient against
  function _placeProp(wx, wy, shiftKey) {
    const blueprint = AppState.pendingProp;
    if (!blueprint || !window.PropCatalog?.get(blueprint)) {
      Toast.error('Keine Requisite ausgewählt');
      AppState.set({ activeTool: null, pendingProp: null });
      return;
    }

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
    // Also used by AppState.updateById to snap a moving actor's seed waypoint.
    routeWaypointAt: _routeWaypointAt,
    // {x, y, dist, z, laneYaw, laneId, laneType, road, lane} or null; road/lane are the
    // render-JSON objects themselves, so callers can walk lane.directionLine directly.
    nearestLaneProjection: _nearestLaneProjection,
    // {x, y, z, yaw} on the nearest driving/parking lane within 12 m, or null; `prevYaw` breaks ties.
    vehicleLaneSnap: _vehicleLaneSnap,
  };
})();
