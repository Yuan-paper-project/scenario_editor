/**
 * mapView.js — the public MapView object, renderAllActors and the map's AppState subscriptions.
 *
 * The map view is eleven files sharing MapCore (mapCore.js … mapView.js, in
 * index.html's script order); this one loads last and is the only API.
 *
 * Coordinate system:
 *   The SVG viewBox is set to the CARLA bounding box (metres).
 *   CARLA coords == SVG coords (both Y-positive = downward).
 *   The road polygon data from the backend is already in CARLA coords.
 *   Pan/zoom mutates only the `transform` attribute on <g id="world">.
 *
 * Mouse → world coords:
 *   Use worldGroup.getScreenCTM().inverse() via SVGPoint.matrixTransform().
 */
(() => {
  'use strict';

  const {
    svg,
    layerTraj,
    layerProps,
    layerActors,
    layers,
    view,
    svgToWorld,
    renderMap,
    zoomBy,
    resetView,
    zoomToSelection,
    frameBounds,
    focusActor,
    glowActor,
    centreOn,
    focusWaypoint,
    glowWaypoint,
    _renderTrafficLights,
    ACTOR_COLORS,
    ACTOR_SIZES,
    WALKER_TYPES,
    _renderTriggerPoints,
    _renderSpecialBuildings,
    _pathKey,
    _pathItems,
    _shouldRenderPath,
    showPath,
    _renderActor,
    _renderProp,
    _hiddenTrajectories,
    _hiddenRoutes,
    _renderTrajectory,
    _renderRoute,
  } = MapCore.shared;

  function renderAllActors() {
    while (layerActors.firstChild) layerActors.removeChild(layerActors.firstChild);
    while (layerTraj.firstChild) layerTraj.removeChild(layerTraj.firstChild);
    if (layerProps) {
      while (layerProps.firstChild) layerProps.removeChild(layerProps.firstChild);
    }
    if (layers.triggerPoints) {
      while (layers.triggerPoints.firstChild) layers.triggerPoints.removeChild(layers.triggerPoints.firstChild);
    }
    if (layers.pathsTop) {
      while (layers.pathsTop.firstChild) layers.pathsTop.removeChild(layers.pathsTop.firstChild);
    }
    if (layers.actorsTop) {
      while (layers.actorsTop.firstChild) layers.actorsTop.removeChild(layers.actorsTop.firstChild);
    }

    // Props sit in their own layer beneath the actors
    for (const prop of AppState.staticObjects) _renderProp(prop);

    if (AppState.ego) _renderActor(AppState.ego);
    for (const npc of AppState.npcs) _renderActor(npc);

    // Paths live inside event actions for every scenario actor, ego included.
    const allActors = AppState.ego ? [AppState.ego, ...AppState.npcs] : [...AppState.npcs];
    const withTraj = allActors.flatMap((a) => _pathItems(a, 'trajectory')).filter((item) => _shouldRenderPath(item));
    const withRoute = allActors.flatMap((a) => _pathItems(a, 'route')).filter((item) => _shouldRenderPath(item));
    const selId = AppState.selectedId;

    // Non-selected trajectories first (underneath)
    for (const item of withTraj) {
      if (item.actor.id !== selId) _renderTrajectory(item);
    }
    // Selected trajectory last (on top)
    for (const item of withTraj) {
      if (item.actor.id === selId) _renderTrajectory(item);
    }

    // Routes are separate from trajectories; render them after trajectories.
    for (const item of withRoute) {
      if (item.actor.id !== selId) _renderRoute(item);
    }
    for (const item of withRoute) {
      if (item.actor.id === selId) _renderRoute(item);
    }

    _renderTriggerPoints();
  }

  // ── Public interface ─────────────────────────────────────────────────────────

  const MapView = {
    renderMap,
    renderAllActors,
    svgToWorld,
    resetView,
    zoomToSelection,
    zoomBy,
    frameBounds,
    focusActor,
    glowActor,
    focusWaypoint,
    centreOn,
    glowWaypoint,
    showPath,
    get zoom() {
      return view.zoom;
    },
    get svg() {
      return svg;
    },
    toggleTrajectoryVisibility(actorId, eventId = null) {
      const key = _pathKey(actorId, eventId, 'trajectory');
      if (_hiddenTrajectories.has(key)) _hiddenTrajectories.delete(key);
      else _hiddenTrajectories.add(key);
      renderAllActors();
    },
    isTrajectoryVisible(actorId, eventId = null) {
      return !_hiddenTrajectories.has(_pathKey(actorId, eventId, 'trajectory'));
    },
    toggleRouteVisibility(actorId, eventId = null) {
      const key = _pathKey(actorId, eventId, 'route');
      if (_hiddenRoutes.has(key)) _hiddenRoutes.delete(key);
      else _hiddenRoutes.add(key);
      renderAllActors();
    },
    isRouteVisible(actorId, eventId = null) {
      return !_hiddenRoutes.has(_pathKey(actorId, eventId, 'route'));
    },
    // Exposed so simulate.js's badge overlay can match actor colours/sizes
    // without duplicating these tables (which would drift from the real
    // renderer over time).
    actorColor(type) {
      return ACTOR_COLORS[type] || ACTOR_COLORS.car;
    },
    actorSize(type) {
      return ACTOR_SIZES[type] || ACTOR_SIZES.car;
    },
    isWalkerType(type) {
      return WALKER_TYPES.has(type);
    },
  };

  window.MapView = MapView;

  // ── React to state changes ───────────────────────────────────────────────────
  AppState.on('actorUpdated', () => MapView.renderAllActors());
  AppState.on('actorRemoved', () => MapView.renderAllActors());
  AppState.on('selectionChanged', () => {
    MapView.renderAllActors();
    _renderTrafficLights();
  });
  // The mark is drawn into the waypoint groups at render time, so moving it
  // has to redraw them. Fired by a click, never per frame.
  //
  // Marking also un-hides the path it belongs to: a marked waypoint you cannot
  // see is a mark on nothing, and Entf would then delete a point with no
  // visible consequence. Reached from the event card's row, which is the one
  // way to mark a waypoint on a path that is currently hidden.
  AppState.on('change', (patch) => {
    if (!('selectedWaypoint' in patch)) return;
    const sel = AppState.selectedWaypoint;
    if (sel) showPath(sel.actorId, sel.eventId, sel.pathType);
    MapView.renderAllActors();
  });
  // specialBuildings arrives once, asynchronously, and may land before or after
  // the first map render — hence both this and the call inside renderMap.
  AppState.on('change', (patch) => {
    if ('specialBuildings' in patch) _renderSpecialBuildings();
  });
  AppState.on('trafficSignalSelected', () => _renderTrafficLights());
  AppState.on('trafficSignalUpdated', () => _renderTrafficLights());
  AppState.on('stateLoaded', () => {
    if (AppState.mapData) MapView.renderAllActors();
    _renderTrafficLights();
  });
})();
