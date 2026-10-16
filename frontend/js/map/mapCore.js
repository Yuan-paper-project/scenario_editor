/**
 * mapCore.js — DOM handles, shared state, pan/zoom, the scale bar, label visibility and coordinate conversion.
 *
 * Part of the map view (MapView); see mapView.js.
 */
(() => {
  'use strict';

  window.MapCore = UIUtils.sharedScope('MapCore');

  const svg = document.getElementById('map-svg');
  const bgRect = document.getElementById('map-background');
  const worldGroup = document.getElementById('world');
  const layerRoads = document.getElementById('layer-roads');
  const layerMarkings = document.getElementById('layer-markings');
  const layerSpawns = document.getElementById('layer-spawns');
  const layerJunctions = document.getElementById('layer-intersections');
  const layerTraj = document.getElementById('layer-trajectories');
  const layerProps = document.getElementById('layer-props');
  const layerActors = document.getElementById('layer-actors');
  const overlayMsg = document.getElementById('map-overlay-msg');

  // Layers recreated by every renderMap; one shared object, since a `let` would go stale across files.
  const layers = {
    crosswalks: null,
    trafficLights: null,
    roadDir: null, // road direction arrows
    overpass: null, // roads that pass over another road, by level
    triggerPoints: null,
    // Landmark dots (maps/special_buildings.csv); below the actors, never hit-tested.
    buildings: null,
    // Stop/Yield signs and speed-limit roundels (map detail, never hit-tested).
    signs: null,
    speeds: null,
    // The selected actor's paths, above the other vehicles, so its waypoints stay reachable.
    pathsTop: null,
    // ...and the selected actor above its own path, or waypoint 1 (on its pose) would hide it.
    actorsTop: null,
  };
  // ── Pan / zoom state ────────────────────────────────────────────────────────
  // view.zoom is 1.0 with the whole town in view. Clamped, because an unbounded zoom
  // could leave the map unrecoverable short of a reload (F / resetView is the way back).
  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 200;
  const ZOOM_STEP = 1.12; // ~26 notches from town view to lane view
  const ZOOM_STEP_COARSE = 1.4; // Shift: the same traversal in ~9
  const ZOOM_TO_SPAN = 90; // metres across the view when framing a selection

  // One size for every object label (actor, prop, landmark, trigger point), in world
  // metres, hidden below LABEL_MIN_PX rather than scaled up: markers are true size.
  // Measurement annotations (waypoint numbers, ruler, badges) keep their own sizes.
  const MAP_LABEL_M = 3.2; // every object label's font-size, in world metres
  const LABEL_MIN_PX = 6; // below this on screen, every object label is hidden
  // ...and capped above this (as --map-label-size on .map-label, overriding each site's attribute).
  const LABEL_MAX_PX = 15;

  const _clampZoom = (z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

  const view = { pan: { x: 0, y: 0 }, zoom: 1.0 };
  // A map pan, or a trigger point / radius being dragged by its marker.
  const drag = { panning: false, triggerPoint: null, triggerRadius: null };
  // ── Scale ruler ──────────────────────────────────────────────────────────────
  const _scaleBar = document.querySelector('.scale-bar');
  const _scaleLabel = document.getElementById('scale-label');
  // Sub-metre steps keep the bar within ~70–170 px, which the bottom controls' fixed strip relies on.
  const _NICE_DISTS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
  const _TARGET_PX = 120; // target bar width in screen pixels

  /** Screen pixels per world metre, or null before the map has a layout. */
  function _pxPerMetre() {
    const ctm = worldGroup.getScreenCTM();
    if (!ctm) return null;
    const px = Math.abs(ctm.a); // scale factor X
    return px > 0 ? px : null;
  }

  function _updateScaleRuler() {
    const pxPerMetre = _pxPerMetre();
    if (pxPerMetre == null) return;

    let bestDist = _NICE_DISTS[0];
    let bestPx = bestDist * pxPerMetre;
    for (const d of _NICE_DISTS) {
      const px = d * pxPerMetre;
      if (Math.abs(px - _TARGET_PX) < Math.abs(bestPx - _TARGET_PX)) {
        bestDist = d;
        bestPx = px;
      }
    }

    const barWidth = Math.round(bestDist * pxPerMetre);
    _scaleBar.style.width = `${barWidth}px`;
    _scaleLabel.textContent = bestDist >= 1000 ? `${bestDist / 1000} km` : `${String(bestDist).replace('.', ',')} m`;
  }

  /** Hide labels below the legibility floor; driven off the live CTM, since view.zoom is per-town. */
  function _updateLabelVisibility() {
    const pxPerMetre = _pxPerMetre();
    if (pxPerMetre == null) return;
    svg.classList.toggle('map-labels-hidden', pxPerMetre * MAP_LABEL_M < LABEL_MIN_PX);
    const size = Math.min(MAP_LABEL_M, LABEL_MAX_PX / pxPerMetre);
    svg.style.setProperty('--map-label-size', `${size.toFixed(3)}px`);
  }

  function _applyTransform() {
    worldGroup.setAttribute('transform', `translate(${view.pan.x},${view.pan.y}) scale(${view.zoom})`);
    _updateScaleRuler();
    _updateLabelVisibility();
    AerialMap.update();
  }

  // ── Coordinate conversion ────────────────────────────────────────────────────
  /** Mouse event → CARLA world coordinates under the current pan/zoom. */
  function svgToWorld(evt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    const ctm = worldGroup.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const inv = ctm.inverse();
    const w = pt.matrixTransform(inv);
    return { x: w.x, y: w.y };
  }

  function _clientToSvg(evt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    return pt.matrixTransform(ctm.inverse());
  }

  function _fitToView(_bounds, _pad) {
    view.pan = { x: 0, y: 0 };
    view.zoom = 1.0;
    _applyTransform();
  }

  /** Put a world point at the centre of the view at `zoom`. */
  function _centreOn(wx, wy, zoom) {
    const vb = svg.viewBox.baseVal;
    if (!vb || !vb.width) return false;
    view.zoom = _clampZoom(zoom);
    view.pan.x = vb.x + vb.width / 2 - wx * view.zoom;
    view.pan.y = vb.y + vb.height / 2 - wy * view.zoom;
    _applyTransform();
    return true;
  }

  /** Zoom about the view centre (a button); the wheel zooms about the cursor. */
  function zoomBy(factor) {
    const vb = svg.viewBox.baseVal;
    if (!vb || !vb.width) {
      view.zoom = _clampZoom(view.zoom * factor);
      _applyTransform();
      return;
    }
    const cx = vb.x + vb.width / 2;
    const cy = vb.y + vb.height / 2;
    const wx = (cx - view.pan.x) / view.zoom; // world point currently at the centre
    const wy = (cy - view.pan.y) / view.zoom;
    _centreOn(wx, wy, view.zoom * factor);
  }

  /** Reset pan/zoom so the whole map fills the view again. */
  function resetView() {
    _fitToView();
  }

  /** Frame the selection at street scale, or reset the view; true if it framed something. */
  function zoomToSelection() {
    const actor = AppState.selectedId ? AppState.findById(AppState.selectedId) : null;
    if (!actor || actor.x == null || actor.y == null) {
      resetView();
      return false;
    }
    return _frameActor(actor);
  }

  /** Put an actor at street scale in the middle of the view. */
  function _frameActor(actor) {
    if (!actor || actor.x == null || actor.y == null) return false;
    const vb = svg.viewBox.baseVal;
    return _centreOn(actor.x, actor.y, vb && vb.width ? vb.width / ZOOM_TO_SPAN : view.zoom);
  }

  /** Fit world points [{x, y}] into the view with `marginM` to spare (a whole generated scenario). */
  function frameBounds(points, marginM = 20) {
    const vb = svg.viewBox.baseVal;
    if (!points?.length || !vb || !vb.width) return false;
    const xs = points.map((p) => p.x),
      ys = points.map((p) => p.y);
    const minX = Math.min(...xs),
      maxX = Math.max(...xs);
    const minY = Math.min(...ys),
      maxY = Math.max(...ys);
    const zoom = Math.min(vb.width / (maxX - minX + 2 * marginM), vb.height / (maxY - minY + 2 * marginM));
    return _centreOn((minX + maxX) / 2, (minY + maxY) / 2, zoom);
  }

  /** Centre the view on a world point with `span` metres across. */
  function centreOn(wx, wy, span = ZOOM_TO_SPAN) {
    const vb = svg.viewBox.baseVal;
    return _centreOn(wx, wy, vb && vb.width ? vb.width / span : view.zoom);
  }

  function _formatSvgNumber(value) {
    return Number(value)
      .toFixed(2)
      .replace(/\.?0+$/, '');
  }

  MapCore.define({
    svg,
    bgRect,
    worldGroup,
    layerRoads,
    layerMarkings,
    layerSpawns,
    layerJunctions,
    layerTraj,
    layerProps,
    layerActors,
    overlayMsg,
    layers,
    ZOOM_STEP,
    ZOOM_STEP_COARSE,
    ZOOM_TO_SPAN,
    MAP_LABEL_M,
    _clampZoom,
    view,
    drag,
    _updateScaleRuler,
    _applyTransform,
    svgToWorld,
    _clientToSvg,
    _fitToView,
    _centreOn,
    zoomBy,
    resetView,
    zoomToSelection,
    _frameActor,
    frameBounds,
    centreOn,
    _formatSvgNumber,
  });
})();
