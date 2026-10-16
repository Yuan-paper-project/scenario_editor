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

  // Extra map-detail layers, recreated by every renderMap and read by every
  // file of the map view — hence one shared object, not reassigned lets.
  const layers = {
    crosswalks: null,
    trafficLights: null,
    roadDir: null, // road direction arrows
    overpass: null, // roads that pass over another road, by level
    triggerPoints: null,
    // Landmark dots from maps/special_buildings.csv. A map-detail layer like the
    // crosswalks, not a scenario layer: it sits below the actors, is never
    // hit-tested, and holds nothing the user can select or move.
    buildings: null,
    // Stop/Yield signs and speed-limit roundels (map detail, never hit-tested).
    signs: null,
    speeds: null,
    // The selected actor's own paths, above layer-actors: a path drawn under the
    // other vehicles is both hard to read and, now that its waypoints are
    // draggable, hard to reach.
    pathsTop: null,
    // ...and the selected actor itself, above its own path. The vehicle stays the
    // top thing on the map — waypoint 1 is seeded on the actor's own pose, so
    // without this the marker sits squarely on the vehicle and hides it, and a
    // grab there would rotate a waypoint instead of moving the car. The waypoint
    // under the vehicle is still reachable from its row in the event card.
    actorsTop: null,
  };
  // ── Pan / zoom state ────────────────────────────────────────────────────────
  //
  // `view.zoom` is 1.0 when the whole town fills the viewBox (renderMap sets the
  // viewBox to the CARLA bounds), so the limits below read as "a quarter of the
  // overview" and "well past lane detail".
  //
  // Clamping is not tidiness: `view.zoom *= factor` was unbounded, 200 wheel notches
  // outward reached scale(0.0000087) — map gone, actors gone — and nothing but
  // renderMap() ever reset the view, so the only way back was a reload, which
  // discards the scenario. resetView() below is the other half of that fix.
  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 200;
  const ZOOM_STEP = 1.12; // ~26 notches from town view to lane view
  const ZOOM_STEP_COARSE = 1.4; // Shift: the same traversal in ~9
  const ZOOM_TO_SPAN = 90; // metres across the view when framing a selection

  // ONE size for every object label on the map — an actor's, a prop's, a
  // landmark's, a trigger point's. They are the same kind of thing (the name of
  // the object under them) and used to be three sizes across four call sites,
  // so a prop's name was visibly smaller than the car's beside it.
  //
  // Drawn in world metres, and HIDDEN below the legibility floor rather than
  // scaled up: markers are drawn at true world size on purpose, and a label that
  // grew as you zoomed out would be the one thing on the map lying about scale.
  // The floor is a screen size, so it is what actually decides how far out a
  // label survives — at 3.2 m / 6 px labels hold to ~1.9 px per world metre,
  // against ~3.2 before, i.e. roughly 1.7x further out.
  //
  // Anything that is NOT an object's name keeps its own size: waypoint numbers
  // and per-waypoint velocities, the ruler's distance readout, the preview's
  // status badges. Those annotate a measurement, not an object.
  const MAP_LABEL_M = 3.2; // every object label's font-size, in world metres
  const LABEL_MIN_PX = 6; // below this on screen, every object label is hidden
  // ...and above this it stops growing. A label is a name, not a measurement,
  // so capping it when zoomed IN tells no lie about scale (the reverse of the
  // floor above) — uncapped, 3.2 m reached ~60 px at lane zoom and a landmark's
  // name sat across the vehicle being edited. Applied as a CSS font-size on
  // `.map-label` via --map-label-size, which overrides every call site's
  // font-size attribute at once.
  const LABEL_MAX_PX = 15;

  const _clampZoom = (z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

  const view = { pan: { x: 0, y: 0 }, zoom: 1.0 };
  // A map pan, or a trigger point / radius being dragged by its marker.
  const drag = { panning: false, triggerPoint: null, triggerRadius: null };
  // ── Scale ruler ──────────────────────────────────────────────────────────────
  const _scaleBar = document.querySelector('.scale-bar');
  const _scaleLabel = document.getElementById('scale-label');
  // Sub-metre steps keep the bar bounded at lane zoom (1 m used to be several
  // hundred px there): with a 1-2-5 ladder the pick stays within ~70-170 px,
  // which is what lets the bottom-centre controls reserve a fixed strip for
  // the ruler (.map-bottom-stack's `left` in map.css).
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

    // Pick the nicest distance that fits close to _TARGET_PX
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

  /**
   * Hide actor labels once they drop under the legibility floor. Driven off the
   * live CTM rather than off `view.zoom`, because `view.zoom` is relative to a viewBox
   * that is the town's own bounds — the same `view.zoom` is a different number of
   * pixels per metre on Town01 and Town04.
   */
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
  /**
   * Convert a mouse event to CARLA world coordinates, accounting for
   * the current pan/zoom transform on #world.
   */
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
    // viewBox is already set to CARLA bounds — SVG handles fitting automatically.
    view.pan = { x: 0, y: 0 };
    view.zoom = 1.0;
    _applyTransform();
  }

  /**
   * Put a world point at the centre of the view at `zoom`.
   *
   * #world is transformed in viewBox units, so centring means placing the point
   * at the viewBox centre; preserveAspectRatio letterboxes that onto the centre
   * of the element for free.
   */
  function _centreOn(wx, wy, zoom) {
    const vb = svg.viewBox.baseVal;
    if (!vb || !vb.width) return false;
    view.zoom = _clampZoom(zoom);
    view.pan.x = vb.x + vb.width / 2 - wx * view.zoom;
    view.pan.y = vb.y + vb.height / 2 - wy * view.zoom;
    _applyTransform();
    return true;
  }

  /**
   * Zoom about the centre of the view — what a zoom BUTTON means, as opposed to
   * the wheel, which zooms about the cursor. Scaling `view.zoom` on its own would
   * zoom about the viewBox origin and walk the map off screen.
   */
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

  /**
   * Frame the selected object at street scale, or reset the view when nothing
   * is selected — so one control always lands on a view that contains
   * something. Returns true if it framed a selection.
   */
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

  /** Fit a set of world points [{x, y}] into the view with `marginM` metres
   * to spare on every side. Used to show a whole generated scenario at once. */
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

  /**
   * Frame the map on one path waypoint and pulse it — the event card's "locate
   * this point" click, the waypoint equivalent of focusActor.
   *
   * Unlike focusActor this DOES mark what it locates: a waypoint has no
   * identity of its own on the map beyond its number, so framing it without
   * saying which of the dots in view it was would answer the wrong question.
   */
  /** Centres the view on a world point with `span` metres across the view. */
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
