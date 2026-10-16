/**
 * mapView.js — the public MapView, renderAllActors and the map's AppState subscriptions.
 *
 * The map view is eleven files over MapCore (mapCore.js … mapView.js); this one loads
 * last and is the only API. The SVG viewBox is the CARLA bounds, so SVG and CARLA
 * coordinates coincide (y down); pan/zoom only transforms <g id="world">.
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

    for (const prop of AppState.staticObjects) _renderProp(prop);

    if (AppState.ego) _renderActor(AppState.ego);
    for (const npc of AppState.npcs) _renderActor(npc);

    const allActors = AppState.ego ? [AppState.ego, ...AppState.npcs] : [...AppState.npcs];
    const withTraj = allActors.flatMap((a) => _pathItems(a, 'trajectory')).filter((item) => _shouldRenderPath(item));
    const withRoute = allActors.flatMap((a) => _pathItems(a, 'route')).filter((item) => _shouldRenderPath(item));
    const selId = AppState.selectedId;

    for (const item of withTraj) {
      if (item.actor.id !== selId) _renderTrajectory(item);
    }
    for (const item of withTraj) {
      if (item.actor.id === selId) _renderTrajectory(item);
    }

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
    // For the preview's badges, so the colour table is not duplicated.
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
  // Redraw on a mark change, and un-hide its path: a mark on an invisible point is a mark on nothing.
  AppState.on('change', (patch) => {
    if (!('selectedWaypoint' in patch)) return;
    const sel = AppState.selectedWaypoint;
    if (sel) showPath(sel.actorId, sel.eventId, sel.pathType);
    MapView.renderAllActors();
  });
  // The landmarks may arrive before or after the first render, hence this and renderMap's call.
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
