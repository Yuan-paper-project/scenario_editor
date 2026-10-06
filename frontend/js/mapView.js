/**
 * mapView.js — SVG map renderer with pan/zoom and coordinate conversion.
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
(function () {
  'use strict';

  const svg          = document.getElementById('map-svg');
  const bgRect       = document.getElementById('map-background');
  const worldGroup   = document.getElementById('world');
  const layerRoads   = document.getElementById('layer-roads');
  const layerMarkings    = document.getElementById('layer-markings');
  const layerSpawns      = document.getElementById('layer-spawns');
  const layerJunctions   = document.getElementById('layer-intersections');
  const layerTraj        = document.getElementById('layer-trajectories');
  const layerProps       = document.getElementById('layer-props');
  const layerActors      = document.getElementById('layer-actors');
  const overlayMsg       = document.getElementById('map-overlay-msg');

  // Extra map-detail layers (inserted into #world by renderMap)
  let layerCrosswalks    = null;
  let layerTrafficLights = null;
  let layerRoadDir       = null;   // road direction arrows
  let layerTriggerPoints = null;
  // Landmark dots from maps/special_buildings.csv. A map-detail layer like the
  // crosswalks, not a scenario layer: it sits below the actors, is never
  // hit-tested, and holds nothing the user can select or move.
  let layerBuildings     = null;
  // The selected actor's own paths, above layer-actors: a path drawn under the
  // other vehicles is both hard to read and, now that its waypoints are
  // draggable, hard to reach.
  let layerPathsTop      = null;
  // ...and the selected actor itself, above its own path. The vehicle stays the
  // top thing on the map — waypoint 1 is seeded on the actor's own pose, so
  // without this the marker sits squarely on the vehicle and hides it, and a
  // grab there would rotate a waypoint instead of moving the car. The waypoint
  // under the vehicle is still reachable from its row in the event card.
  let layerActorsTop     = null;

  // ── Pan / zoom state ────────────────────────────────────────────────────────
  //
  // `_zoom` is 1.0 when the whole town fills the viewBox (renderMap sets the
  // viewBox to the CARLA bounds), so the limits below read as "a quarter of the
  // overview" and "well past lane detail".
  //
  // Clamping is not tidiness: `_zoom *= factor` was unbounded, 200 wheel notches
  // outward reached scale(0.0000087) — map gone, actors gone — and nothing but
  // renderMap() ever reset the view, so the only way back was a reload, which
  // discards the scenario. resetView() below is the other half of that fix.
  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 200;
  const ZOOM_STEP        = 1.12;   // ~26 notches from town view to lane view
  const ZOOM_STEP_COARSE = 1.40;   // Shift: the same traversal in ~9
  const ZOOM_TO_SPAN     = 90;     // metres across the view when framing a selection

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
  const MAP_LABEL_M  = 3.2;   // every object label's font-size, in world metres
  const LABEL_MIN_PX = 6;     // below this on screen, every object label is hidden


  const _clampZoom = z => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

  let _pan  = { x: 0, y: 0 };
  let _zoom = 1.0;
  let _dragging = false;
  let _dragStart = null;
  let _panStart  = null;
  let _panMoved = false;
  let _suppressNextClick = false;
  const _PAN_CLICK_THRESHOLD = 4;
  let _triggerRadiusDrag = null;
  let _triggerPointDrag  = null;

  // ── Scale ruler ──────────────────────────────────────────────────────────────
  const _scaleBar   = document.querySelector('.scale-bar');
  const _scaleLabel = document.getElementById('scale-label');
  const _NICE_DISTS = [5, 10, 20, 50, 100, 200, 500, 1000, 2000];
  const _TARGET_PX  = 120;  // target bar width in screen pixels

  /** Screen pixels per world metre, or null before the map has a layout. */
  function _pxPerMetre() {
    const ctm = worldGroup.getScreenCTM();
    if (!ctm) return null;
    const px = Math.abs(ctm.a);   // scale factor X
    return px > 0 ? px : null;
  }

  function _updateScaleRuler() {
    const pxPerMetre = _pxPerMetre();
    if (pxPerMetre == null) return;

    // Pick the nicest distance that fits close to _TARGET_PX
    let bestDist = _NICE_DISTS[0];
    let bestPx   = bestDist * pxPerMetre;
    for (const d of _NICE_DISTS) {
      const px = d * pxPerMetre;
      if (Math.abs(px - _TARGET_PX) < Math.abs(bestPx - _TARGET_PX)) {
        bestDist = d;
        bestPx   = px;
      }
    }

    const barWidth = Math.round(bestDist * pxPerMetre);
    _scaleBar.style.width = `${barWidth}px`;
    _scaleLabel.textContent = bestDist >= 1000 ? `${bestDist / 1000} km` : `${bestDist} m`;
  }

  /**
   * Hide actor labels once they drop under the legibility floor. Driven off the
   * live CTM rather than off `_zoom`, because `_zoom` is relative to a viewBox
   * that is the town's own bounds — the same `_zoom` is a different number of
   * pixels per metre on Town01 and Town04.
   */
  function _updateLabelVisibility() {
    const pxPerMetre = _pxPerMetre();
    if (pxPerMetre == null) return;
    svg.classList.toggle('map-labels-hidden', pxPerMetre * MAP_LABEL_M < LABEL_MIN_PX);
  }

  function _applyTransform() {
    worldGroup.setAttribute('transform',
      `translate(${_pan.x},${_pan.y}) scale(${_zoom})`
    );
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
    const w   = pt.matrixTransform(inv);
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

  // ── Road rendering ───────────────────────────────────────────────────────────
  function _polyToPoints(polygon) {
    return polygon.map(p => `${p[0]},${p[1]}`).join(' ');
  }

  function renderMap(mapData) {
    // Clear all layers
    [layerRoads, layerMarkings, layerSpawns, layerJunctions].forEach(
      g => { while (g.firstChild) g.removeChild(g.firstChild); }
    );

    // Create/reset dynamic detail layers (inserted before trajectories)
    if (layerCrosswalks)    layerCrosswalks.remove();
    if (layerTrafficLights) layerTrafficLights.remove();
    if (layerRoadDir)       layerRoadDir.remove();
    if (layerTriggerPoints) layerTriggerPoints.remove();
    if (layerBuildings)     layerBuildings.remove();
    if (layerPathsTop)      layerPathsTop.remove();
    if (layerActorsTop)     layerActorsTop.remove();
    // Cached route geometry is lane geometry, i.e. specific to the town that
    // is being replaced. Ids restart at obj-1/evt-1 in every save file, so a
    // stale entry is a real collision rather than a theoretical one.
    _routeGeomCache.clear();
    layerCrosswalks    = _svgEl('g', { id: 'layer-crosswalks' });
    layerTrafficLights = _svgEl('g', { id: 'layer-trafficlights' });
    layerRoadDir       = _svgEl('g', { id: 'layer-roaddir' });
    layerTriggerPoints = _svgEl('g', { id: 'layer-trigger-points' });
    layerBuildings     = _svgEl('g', { id: 'layer-buildings' });
    layerPathsTop      = _svgEl('g', { id: 'layer-paths-top' });
    layerActorsTop     = _svgEl('g', { id: 'layer-actors-top' });
    const layerTrajEl  = document.getElementById('layer-trajectories');
    worldGroup.insertBefore(layerRoadDir,       layerTrajEl);
    worldGroup.insertBefore(layerCrosswalks,    layerTrajEl);
    worldGroup.insertBefore(layerTrafficLights, layerTrajEl);
    worldGroup.insertBefore(layerBuildings,     layerTrajEl);
    // These three go last, i.e. above layer-actors, and in this order: the
    // selected actor's path sits over the other vehicles, the actor itself sits
    // over its own path, and its trigger points sit over everything. Paint
    // order here is DOM order of the layers, not the order renderAllActors
    // happens to fill them in.
    worldGroup.appendChild(layerPathsTop);
    worldGroup.appendChild(layerActorsTop);
    worldGroup.appendChild(layerTriggerPoints);

    const { bounds, roads, spawnPoints, intersections, trafficLights, crosswalks, grassColor } = mapData;
    const w = bounds.xMax - bounds.xMin;
    const h = bounds.yMax - bounds.yMin;
    const pad = Math.max(w, h) * 0.03;

    // Set SVG viewBox to CARLA bounds
    const vb = `${bounds.xMin - pad} ${bounds.yMin - pad} ${w + pad*2} ${h + pad*2}`;
    svg.setAttribute('viewBox', vb);

    // Background
    bgRect.setAttribute('x',      bounds.xMin - pad);
    bgRect.setAttribute('y',      bounds.yMin - pad);
    bgRect.setAttribute('width',  w + pad*2);
    bgRect.setAttribute('height', h + pad*2);
    bgRect.setAttribute('fill',   'transparent');

    // Reset pan/zoom so new map fills the view
    _pan  = { x: 0, y: 0 };
    _zoom = 1.0;
    _applyTransform();

    // Sort roads: junctions on top
    const normal    = roads.filter(r => r.junction === '-1');
    const junctions = roads.filter(r => r.junction !== '-1');

    for (const road of [...normal, ...junctions]) {
      for (const lane of road.lanes) {
        // Lane polygon with thin edge outline for visual definition
        const poly = _svgEl('polygon', {
          points: _polyToPoints(lane.polygon),
          fill:   lane.color,
          stroke: _laneStrokeColor(lane.type),
          'stroke-width': '0.3',
          'stroke-linejoin': 'round',
        });
        layerRoads.appendChild(poly);
      }

      // Road markings + direction arrows (non-junction roads only)
      if (road.junction === '-1' && road.centerline.length > 1) {
        const hasDriving = road.lanes.some(l => l.type === 'driving' || l.type === 'bidirectional');
        if (hasDriving) {
          // Yellow dashed centerline
          const cl = _svgEl('polyline', {
            points: road.centerline.map(p => `${p[0]},${p[1]}`).join(' '),
            fill: 'none',
            stroke: 'rgba(255,210,80,0.5)',
            'stroke-width': '0.35',
            'stroke-dasharray': '3,5',
            'stroke-linecap': 'round',
          });
          layerMarkings.appendChild(cl);

          // Per-lane direction arrows (each lane has its own directionLine
          // with correct travel direction — left lanes are reversed)
          for (const lane of road.lanes) {
            if ((lane.type === 'driving' || lane.type === 'bidirectional') &&
                lane.directionLine && lane.directionLine.length > 1) {
              _renderRoadDirArrows(lane.directionLine);
            }
          }
        }
      }
    }

    // Spawn point dots
    for (const sp of spawnPoints) {
      const c = _svgEl('circle', { cx: sp.x, cy: sp.y, r: '1.5', class: 'spawn-dot' });
      layerSpawns.appendChild(c);
    }

    // Junction zone circles (subtle highlight)
    for (const junc of (intersections || [])) {
      const c = _svgEl('circle', { cx: junc.cx, cy: junc.cy, r: '14', class: 'junction-zone' });
      layerJunctions.appendChild(c);
    }

    // ── Crosswalks: zebra stripes perpendicular to road ──────────────────────
    console.log(`[MapView] Rendering ${(crosswalks || []).length} crosswalks`);
    for (const cw of (crosswalks || [])) {
      _renderCrosswalk(cw);
    }
    console.log(`[MapView] layer-crosswalks children: ${layerCrosswalks.children.length}`);

    // ── Traffic lights ─────────────────────────────────────────────────────
    console.log(`[MapView] Rendering ${(trafficLights || []).length} traffic lights`);
    for (const tl of (trafficLights || [])) {
      _renderTrafficLight(tl);
    }
    console.log(`[MapView] layer-trafficlights children: ${layerTrafficLights.children.length}`);

    // Landmarks for whichever town this is. renderMap replaces the layer
    // wholesale, so this has to run here as well as on the fetch completing.
    _renderSpecialBuildings();

    // Aerial image under everything (aerialMap.js); fetched async, a town
    // without a capture simply stays on the vector map.
    AerialMap.load(AppState.map);

    // Fit the map to screen
    _fitToView(bounds, pad);

    // Wire up layer visibility toggles
    _setupLayerToggles();

    overlayMsg.style.display = 'none';

    // Initial scale ruler update (defer to let layout settle)
    requestAnimationFrame(() => _updateScaleRuler());
  }

  /** Render small direction-arrow chevrons along a road centerline. */
  function _renderRoadDirArrows(centerline) {
    // Place a small arrow every ~30m along the road
    const INTERVAL = 30;
    let accum = 0;
    for (let i = 1; i < centerline.length; i++) {
      const [x0, y0] = centerline[i - 1];
      const [x1, y1] = centerline[i];
      const dx = x1 - x0, dy = y1 - y0;
      const segLen = Math.sqrt(dx * dx + dy * dy);
      accum += segLen;
      if (accum >= INTERVAL) {
        accum -= INTERVAL;
        // Place arrow at midpoint of this segment
        const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
        const angle = Math.atan2(dy, dx) * 180 / Math.PI;
        // Small chevron triangle
        const arrow = _svgEl('polygon', {
          points: '2,0 -2,-1.2 -2,1.2',
          fill: 'rgba(255,255,255,0.30)',
          transform: `translate(${mx.toFixed(1)},${my.toFixed(1)}) rotate(${angle.toFixed(1)})`,
        });
        layerRoadDir.appendChild(arrow);
      }
    }
  }

  /** Return a subtle edge stroke colour for a given lane type. */
  function _laneStrokeColor(type) {
    switch (type) {
      case 'driving':
      case 'bidirectional': return '#3a3a3a';
      case 'sidewalk':      return '#b0a07a';
      case 'shoulder':      return '#555555';
      default:              return '#444444';
    }
  }

  function _fitToView(_bounds, _pad) {
    // viewBox is already set to CARLA bounds — SVG handles fitting automatically.
    _pan  = { x: 0, y: 0 };
    _zoom = 1.0;
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
    _zoom = _clampZoom(zoom);
    _pan.x = (vb.x + vb.width  / 2) - wx * _zoom;
    _pan.y = (vb.y + vb.height / 2) - wy * _zoom;
    _applyTransform();
    return true;
  }

  /**
   * Zoom about the centre of the view — what a zoom BUTTON means, as opposed to
   * the wheel, which zooms about the cursor. Scaling `_zoom` on its own would
   * zoom about the viewBox origin and walk the map off screen.
   */
  function zoomBy(factor) {
    const vb = svg.viewBox.baseVal;
    if (!vb || !vb.width) { _zoom = _clampZoom(_zoom * factor); _applyTransform(); return; }
    const cx = vb.x + vb.width  / 2;
    const cy = vb.y + vb.height / 2;
    const wx = (cx - _pan.x) / _zoom;   // world point currently at the centre
    const wy = (cy - _pan.y) / _zoom;
    _centreOn(wx, wy, _zoom * factor);
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
    if (!actor || actor.x == null || actor.y == null) { resetView(); return false; }
    return _frameActor(actor);
  }

  /** Put an actor at street scale in the middle of the view. */
  function _frameActor(actor) {
    if (!actor || actor.x == null || actor.y == null) return false;
    const vb = svg.viewBox.baseVal;
    return _centreOn(actor.x, actor.y, vb && vb.width ? vb.width / ZOOM_TO_SPAN : _zoom);
  }

  /**
   * Frame an actor, WITHOUT selecting it.
   *
   * This is the scene list's single click. Selecting instead would be the
   * obvious implementation and the wrong one: the overview panel that holds the
   * list is only rendered while nothing is selected, so selecting would close
   * the list on the first click and you could never walk down it. Selection is
   * the double click, which is a deliberate act.
   *
   * Flying the view is the whole feature — markers are drawn at true world size,
   * so at the town view an actor is a few pixels and no amount of highlighting
   * would find it for you.
   */
  function focusActor(id) {
    const actor = id ? AppState.findById(id) : null;
    if (!_frameActor(actor)) return false;
    glowActor(id);
    return true;
  }

  // Total life of the locate glow: brightens, holds ~0.5 s, then fades out.
  // Must match the actor-glow-fade keyframes, or the class outlives the
  // animation and leaves the object sitting bright.
  const GLOW_MS = 900;
  let _glowTimer = null;

  /**
   * Briefly brighten one map object — the "it is right here" cue the scene list
   * fires when a row locates something.
   *
   * It is the object's own body brightening, the same `filter` it gets when
   * hovered directly on the map; no ring, nothing added to the group at render
   * time. Deliberately tied to the *click*, not to hover: hovering a list to
   * read it should not set things flashing on the map.
   */
  function glowActor(id) {
    clearTimeout(_glowTimer);
    // Query off the <svg> and not off layerActors: the layers are null until a
    // map has been rendered, and a prop lives in a different layer entirely.
    svg.querySelectorAll('.actor-glow').forEach(el => el.classList.remove('actor-glow'));
    if (!id) return;
    const g = svg.querySelector(`.actor-group[data-id="${CSS.escape(String(id))}"]`);
    if (!g) return;
    g.getBoundingClientRect();      // reflow, so re-locating the same object replays it
    g.classList.add('actor-glow');
    _glowTimer = setTimeout(() => g.classList.remove('actor-glow'), GLOW_MS);
  }

  /**
   * Frame the map on one path waypoint and pulse it — the event card's "locate
   * this point" click, the waypoint equivalent of focusActor.
   *
   * Unlike focusActor this DOES mark what it locates: a waypoint has no
   * identity of its own on the map beyond its number, so framing it without
   * saying which of the dots in view it was would answer the wrong question.
   */
  function focusWaypoint(sel) {
    const path = AppState.waypointPathOf(sel);
    const wp = path && path[sel.index];
    if (!wp) return false;
    const vb = svg.viewBox.baseVal;
    _centreOn(wp.x, wp.y, vb && vb.width ? vb.width / ZOOM_TO_SPAN : _zoom);
    glowWaypoint(sel);
    return true;
  }

  let _wpGlowTimer = null;

  /** Brief pulse on one waypoint marker. Same 900 ms budget as glowActor, and
   *  the same rule: the class must not outlive its keyframes. */
  function glowWaypoint(sel) {
    clearTimeout(_wpGlowTimer);
    svg.querySelectorAll('.wp-locating').forEach(el => el.classList.remove('wp-locating'));
    if (!sel) return;
    const g = svg.querySelector(
      `.path-waypoint[data-actor-id="${CSS.escape(String(sel.actorId))}"]`
      + `[data-event-id="${CSS.escape(String(sel.eventId))}"]`
      + `[data-path-type="${CSS.escape(String(sel.pathType))}"]`
      + `[data-wp-idx="${CSS.escape(String(sel.index))}"]`);
    if (!g) return;
    g.getBoundingClientRect();      // reflow, so re-locating the same point replays it
    g.classList.add('wp-locating');
    _wpGlowTimer = setTimeout(() => g.classList.remove('wp-locating'), GLOW_MS);
  }

  // ── Crosswalk rendering ────────────────────────────────────────────────────

  function _renderCrosswalk(cw) {
    // Zebra stripes across the road (perpendicular to heading).
    // Stripes are spaced along the perpendicular axis and each stripe
    // is a thin rectangle whose long side runs parallel to the road.
    const rad = (cw.heading * Math.PI) / 180;
    const fx = Math.cos(rad), fy = Math.sin(rad);   // road-forward unit vector
    const px = -fy, py = fx;                         // perpendicular (across road)

    const crosswalkWidth = Math.max(1.0, Number(cw.width) || 3.0);   // along-road direction (m)
    const crosswalkLength = Math.max(2.0, Number(cw.length) || 12.0); // across-road direction (m)
    const STRIPE_W = Math.min(1.2, Math.max(0.55, crosswalkLength / 12));
    const STRIPE_GAP = STRIPE_W * 0.75;
    const totalStep = STRIPE_W + STRIPE_GAP;
    const NUM_STRIPES = Math.max(2, Math.floor((crosswalkLength + STRIPE_GAP) / totalStep));
    const usedLength = (NUM_STRIPES * STRIPE_W) + ((NUM_STRIPES - 1) * STRIPE_GAP);
    const startOff = -usedLength / 2;

    const g = _svgEl('g', { class: 'crosswalk-group' });

    for (let i = 0; i < NUM_STRIPES; i++) {
      // Space stripes along the perpendicular (across-road) axis
      const offset = startOff + i * totalStep + STRIPE_W / 2;
      const cx = cw.x + px * offset;
      const cy = cw.y + py * offset;
      const hw = STRIPE_W / 2;   // half-width in perpendicular direction
      const hl = crosswalkWidth / 2; // half-length in road-forward direction
      // Rectangle: long side along road (fx), short side across road (px)
      const pts = [
        [cx + fx*hl + px*hw, cy + fy*hl + py*hw],
        [cx + fx*hl - px*hw, cy + fy*hl - py*hw],
        [cx - fx*hl - px*hw, cy - fy*hl - py*hw],
        [cx - fx*hl + px*hw, cy - fy*hl + py*hw],
      ].map(p => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');

      g.appendChild(_svgEl('polygon', {
        points: pts,
        fill: '#ffffff',
        'fill-opacity': '0.85',
      }));
    }

    layerCrosswalks.appendChild(g);
  }

  // ── Traffic light rendering ────────────────────────────────────────────────

  function _renderTrafficLight(tl) {
    const x = tl.x;
    const y = tl.y;
    const id = String(tl.id ?? `${x},${y}`);
    const action = TrafficSignals.actionById(id);
    const selected = String(AppState.selectedTrafficLightId || '') === id;
    const configured = (action?.events || []).length > 0;
    const lastEvent = configured ? action.events[action.events.length - 1] : null;

    // Simplified traffic-light icon: a bright coloured dot with glow,
    // large enough to be visible at the default zoom level.
    const g = _svgEl('g', {
      transform: `translate(${x},${y})`,
      class: `traffic-light${selected ? ' selected' : ''}`,
      'data-traffic-light-id': id,
    });
    g.addEventListener('click', e => {
      if (AppState.activeTool || AppState.trajectoryMode || AppState.routeMode) return;
      e.preventDefault();
      e.stopPropagation();
      TrafficSignals.select(id);
    });

    // Selection marks, sized to the glyph's own r=4 glow below. Same helper as
    // actors and props: one selection language for everything on the map.
    g.appendChild(_buildSelectionMarks(8, 8));

    // Outer glow
    g.appendChild(_svgEl('circle', {
      cx: '0', cy: '0', r: '4',
      class: 'traffic-light-glow',
      fill: configured ? '#4488ff' : 'red', 'fill-opacity': '0.15',
    }));

    // Main circle dot — the most visible element
    g.appendChild(_svgEl('circle', {
      cx: '0', cy: '0', r: '2.2',
      class: 'traffic-light-dot',
      fill: configured ? '#4488ff' : 'red',
      stroke: '#ffffff', 'stroke-width': '0.5',
    }));

    layerTrafficLights.appendChild(g);
  }

  function _renderTrafficLights() {
    if (!layerTrafficLights || !AppState.mapData) return;
    while (layerTrafficLights.firstChild) layerTrafficLights.removeChild(layerTrafficLights.firstChild);
    for (const tl of (AppState.mapData.trafficLights || [])) {
      _renderTrafficLight(tl);
    }
  }

  // ── Actor rendering ──────────────────────────────────────────────────────────

  const ACTOR_COLORS = {
    ego:         { body: '#4488ff', text: '#fff' },
    car:         { body: '#ff9933', text: '#222' },
    van:         { body: '#8899aa', text: '#222' },
    truck:       { body: '#cc5522', text: '#fff' },
    bus:         { body: '#ddaa00', text: '#222' },
    motorcycle:  { body: '#ff7755', text: '#fff' },
    scooter:     { body: '#b8d600', text: '#222' },
    police:      { body: '#223f9e', text: '#fff' },
    ambulance:   { body: '#f0f4f8', text: '#222' },
    firetruck:   { body: '#c62828', text: '#fff' },
    pedestrian:  { body: '#cc66cc', text: '#fff' },
    child:       { body: '#e69ae6', text: '#222' },
    cyclist:     { body: '#33bb88', text: '#fff' },
  };

  const ACTOR_SIZES = {
    ego:        { w: 4.5, h: 2.1 },
    car:        { w: 4.5, h: 2.1 },
    van:        { w: 5.8, h: 2.2 },
    truck:      { w: 7.0, h: 2.6 },
    bus:        { w: 9.0, h: 2.8 },
    motorcycle: { w: 2.2, h: 1.0 },
    scooter:    { w: 1.7, h: 0.8 },
    police:     { w: 5.0, h: 2.1 },
    ambulance:  { w: 6.0, h: 2.4 },
    firetruck:  { w: 8.5, h: 2.8 },
    pedestrian: { w: 1.0, h: 1.0 },
    child:      { w: 0.6, h: 0.6 },
    cyclist:    { w: 2.0, h: 0.8 },
  };

  /* Yaw-handle geometry (world metres).
   *
   * The rotate handle must never overlap the body, or a drag meant to MOVE the
   * object spins it instead — which is exactly what the old hand-tuned
   * `max(w, 4.5) * 0.8` did to every car (grab circle inner edge 2.1 m against a
   * 2.25 m half-length) and to every small prop (the r=1.5 circle swallowed the
   * marker whole). So the length is derived from the body's own hit radius
   * instead of guessed, and the invariant — handle inner edge = bodyRadius +
   * YAW_HANDLE_GAP, always positive — holds by construction for any size.
   *
   * The handle radius is capped at both ends: big enough to hit on a child or a
   * cone, never so big on a bus that it swings back over the roof. */
  const YAW_HANDLE_GAP   = 0.6;   // clear air between body edge and handle edge
  const YAW_HANDLE_R_MAX = 1.2;   // grab radius of the rotate handle
  const YAW_HANDLE_R_MIN = 0.7;

  // Drawn as a circle rather than a rectangle. Mirrors _PEDESTRIAN_TYPES in
  // ../llm-scenario-gen's xml_builder, which decides the same split for the
  // exported entity — keep the two in step.
  const WALKER_TYPES = new Set(['pedestrian', 'child']);

  function renderAllActors() {
    while (layerActors.firstChild) layerActors.removeChild(layerActors.firstChild);
    while (layerTraj.firstChild)   layerTraj.removeChild(layerTraj.firstChild);
    if (layerProps) {
      while (layerProps.firstChild) layerProps.removeChild(layerProps.firstChild);
    }
    if (layerTriggerPoints) {
      while (layerTriggerPoints.firstChild) layerTriggerPoints.removeChild(layerTriggerPoints.firstChild);
    }
    if (layerPathsTop) {
      while (layerPathsTop.firstChild) layerPathsTop.removeChild(layerPathsTop.firstChild);
    }
    if (layerActorsTop) {
      while (layerActorsTop.firstChild) layerActorsTop.removeChild(layerActorsTop.firstChild);
    }

    // Props sit in their own layer beneath the actors
    for (const prop of AppState.staticObjects) _renderProp(prop);

    if (AppState.ego) _renderActor(AppState.ego);
    for (const npc of AppState.npcs) _renderActor(npc);

    // Paths live inside event actions for every scenario actor, ego included.
    const allActors = AppState.ego ? [AppState.ego, ...AppState.npcs] : [...AppState.npcs];
    const withTraj  = allActors.flatMap(a => _pathItems(a, 'trajectory')).filter(item => _shouldRenderPath(item));
    const withRoute = allActors.flatMap(a => _pathItems(a, 'route')).filter(item => _shouldRenderPath(item));
    const selId     = AppState.selectedId;

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

  function _renderTriggerPoints() {
    if (!layerTriggerPoints) return;
    // findById also matches props, but a prop has no .events, so the forEach
    // below is a no-op for one — no extra guard needed.
    const actor = AppState.findById(AppState.selectedId);
    if (!actor) return;
    (actor.events || []).forEach(ev => {
      const point = ev.trigger?.point;
      if (!point) return;
      const radius = Math.max(0, Number(ev.trigger?.value ?? 20));
      const g = _svgEl('g', { class: 'trigger-point', transform: `translate(${point.x},${point.y})` });
      const ring = _svgEl('circle', {
        cx: '0', cy: '0', r: _formatSvgNumber(radius),
        fill: 'rgba(0, 0, 0, 0.05)',
        stroke: '#808080',
        'stroke-width': '0.3',
        'stroke-dasharray': '1,1',
        class: 'trigger-radius-control trigger-radius-ring',
      });
      _attachTriggerRadiusDrag(ring, actor.id, ev.id, point);
      g.appendChild(ring);
      const marker = _svgEl('g', { class: 'trigger-point-control' });
      // Invisible hit target — the drawn marker is 0.7 m across, which is a
      // sub-pixel click target at whole-town zoom.
      marker.appendChild(_svgEl('circle', {
        cx: '0', cy: '0', r: '2.2', fill: 'transparent',
      }));
      marker.appendChild(_svgEl('circle', {
        cx: '0', cy: '0', r: '0.7',
        fill: '#ffffff00',
        stroke: '#ffffff',
        'stroke-width': '0.5',
      }));
      _attachTriggerPointDrag(marker, actor.id, ev.id);
      g.appendChild(marker);
      const label = _svgEl('text', {
        x: '0', y: '-4.5',
        'text-anchor': 'middle',
        'font-size': String(MAP_LABEL_M),
        class: 'map-label',
        fill: '#fff',
        style: 'pointer-events:none',
      });
      label.textContent = point.name || 'Point';
      g.appendChild(label);
      const handle = _svgEl('rect', {
        x: _formatSvgNumber(radius - 0.7),
        y: '-0.7',
        width: '1.4',
        height: '1.4',
        fill: '#ffffff',
        stroke: '#808080',
        'stroke-width': '0.3',
        class: 'trigger-radius-control trigger-radius-handle',
      });
      _attachTriggerRadiusDrag(handle, actor.id, ev.id, point);
      g.appendChild(handle);
      layerTriggerPoints.appendChild(g);
    });
  }

  /**
   * Landmark dots for the current town (maps/special_buildings.csv, fetched by
   * specialBuildings.js into AppState.specialBuildings — every town's rows at
   * once, so this filters).
   *
   * The CSV's x/y are CARLA world coordinates, i.e. exactly the frame the render
   * JSON and every actor pose are already in — the single Y flip happens in
   * backend/map_renderer.py and nothing downstream repeats it. Plot verbatim.
   *
   * Drawn like the trigger point's centre marker (a small dot) but with a white
   * casing under it, because the map runs from a near-white verge to a near-black
   * carriageway and no single colour survives both. Nothing here is hit-testable:
   * a landmark is reference decoration, and a hit target here would swallow
   * clicks aimed at the road under it.
   */
  function _renderSpecialBuildings() {
    if (!layerBuildings) return;
    while (layerBuildings.firstChild) layerBuildings.removeChild(layerBuildings.firstChild);
    const town = AppState.map;
    if (!town) return;
    for (const b of (AppState.specialBuildings || [])) {
      if (b.town !== town) continue;
      const g = _svgEl('g', {
        class: 'special-building',
        transform: `translate(${_formatSvgNumber(b.x)},${_formatSvgNumber(b.y)})`,
      });
      g.appendChild(_svgEl('circle', { cx: '0', cy: '0', r: '1.5', class: 'building-dot-casing' }));
      g.appendChild(_svgEl('circle', { cx: '0', cy: '0', r: '1.0', class: 'building-dot' }));
      const label = _svgEl('text', {
        x: '0', y: '-2.8',
        'text-anchor': 'middle',
        'font-size': String(MAP_LABEL_M),
        class: 'map-label building-label',
      });
      label.textContent = b.type;
      g.appendChild(label);
      // Not a tooltip the user can hover for (the group is pointer-events:none)
      // — it is there for anyone reading the DOM, and costs nothing.
      const title = _svgEl('title', {});
      title.textContent = b.name ? `${b.type} — ${b.name}` : b.type;
      g.appendChild(title);
      layerBuildings.appendChild(g);
    }
  }

  function _formatSvgNumber(value) {
    return Number(value).toFixed(2).replace(/\.?0+$/, '');
  }

  function _attachTriggerPointDrag(el, actorId, eventId) {
    el.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      _triggerPointDrag = { actorId, eventId };
      e.preventDefault();
      e.stopPropagation();
    });
  }

  /**
   * Live-move the point while the mouse is down. Only x/y are written here —
   * ObjectsManager.moveTriggerPoint re-derives z on mouseup, matching how an
   * actor's height is handled (the lookup scans every lane segment, and z is
   * invisible in a top-down view anyway).
   */
  function _updateTriggerPointDrag(e) {
    const actor = AppState.findById(_triggerPointDrag.actorId);
    if (!actor) return;
    const world = svgToWorld(e);
    const x = Math.round(world.x * 10) / 10;
    const y = Math.round(world.y * 10) / 10;
    const events = (actor.events || []).map(ev => {
      if (ev.id !== _triggerPointDrag.eventId || !ev.trigger?.point) return ev;
      return { ...ev, trigger: { ...ev.trigger, point: { ...ev.trigger.point, x, y } } };
    });
    _triggerPointDrag.moved = { x, y };
    AppState.updateById(actor.id, { events });
  }

  function _attachTriggerRadiusDrag(el, actorId, eventId, point) {
    el.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      _triggerRadiusDrag = { actorId, eventId, point: { ...point } };
      e.preventDefault();
      e.stopPropagation();
    });
  }

  function _updateTriggerRadiusDrag(e) {
    const actor = AppState.findById(_triggerRadiusDrag.actorId);
    if (!actor) return;
    const world = svgToWorld(e);
    const p = _triggerRadiusDrag.point;
    const distance = Math.round(Math.hypot(world.x - p.x, world.y - p.y) * 10) / 10;
    const events = (actor.events || []).map(ev => {
      if (ev.id !== _triggerRadiusDrag.eventId) return ev;
      return {
        ...ev,
        trigger: {
          ...ev.trigger,
          type: 'distance_to_point',
          value: distance,
        },
      };
    });
    AppState.updateById(actor.id, { events });
  }

  function _pathKey(actorId, eventId, pathType) {
    return `${actorId}:${eventId || 'actor'}:${pathType}`;
  }

  function _pathItems(actor, pathType) {
    return (actor.events || []).flatMap(ev => {
      const action = ev.action || {};
      const points = pathType === 'route'
        ? (action.type === 'assign_route' ? (action.waypoints || []) : [])
        : (action.type === 'follow_trajectory' ? (action.trajectory || []) : []);
      return points.length >= 2 ? [{ actor, eventId: ev.id, pathType, points }] : [];
    });
  }

  /**
   * Ausblenden means hidden, full stop — whether or not its actor is selected.
   *
   * Selection governs only how a *shown* path looks: full opacity and the top
   * layer when selected, dimmed and underneath when not. Letting selection
   * override the toggle was tried and is worse: a path deliberately hidden to
   * clear the map came back the moment you clicked its vehicle, which is
   * exactly when you are most likely to be clicking around it.
   *
   * What keeps that from stranding anyone is `showPath` — drawing a path, or
   * marking one of its waypoints, un-hides it for good (see the callers).
   */
  function _shouldRenderPath(item) {
    const hidden = item.pathType === 'route' ? _hiddenRoutes : _hiddenTrajectories;
    return !hidden.has(_pathKey(item.actor.id, item.eventId, item.pathType));
  }

  /**
   * Force one path visible, flipping the stored toggle rather than overriding
   * it temporarily: the button then reads `Ausblenden` and states the truth.
   * A temporary override would leave the card saying `Anzeigen` beside a path
   * plainly on screen, and the path would vanish again on deselect.
   *
   * Returns true if it actually changed something, so a caller can avoid a
   * redundant re-render.
   */
  function showPath(actorId, eventId, pathType) {
    const hidden = pathType === 'route' ? _hiddenRoutes : _hiddenTrajectories;
    return hidden.delete(_pathKey(actorId, eventId, pathType));
  }

  /** The layer a path belongs in: over the vehicles when it is the selected
   *  actor's, under them otherwise. */
  function _pathLayerFor(actor) {
    return (actor.id === AppState.selectedId && layerPathsTop) ? layerPathsTop : layerTraj;
  }

  function _renderActor(actor) {
    const col  = ACTOR_COLORS[actor.type] || ACTOR_COLORS.car;
    const size = ACTOR_SIZES[actor.type]  || ACTOR_SIZES.car;
    const sel  = AppState.selectedId === actor.id;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', `actor-group${sel ? ' actor-selected' : ''}`);
    g.setAttribute('data-id', actor.id);
    g.setAttribute('transform', `translate(${actor.x},${actor.y}) rotate(${actor.yaw || 0})`);

    if (WALKER_TYPES.has(actor.type)) {
      // Walker: filled circle. A rectangle plus windshield would read as a
      // very small car, which is exactly the wrong thing for a child.
      const c = _svgEl('circle', { r: size.w / 2, fill: col.body, class: 'actor-body' });
      g.appendChild(c);
    } else {
      // Vehicle: rectangle with windshield highlight
      const rect = _svgEl('rect', {
        x: -size.w/2, y: -size.h/2, width: size.w, height: size.h,
        rx: 0.4, fill: col.body, class: 'actor-body'
      });
      g.appendChild(rect);
      // Windshield (front-right highlight)
      const ws = _svgEl('rect', {
        x: size.w/2 - 1.4, y: -size.h/2 + 0.2, width: 1.2, height: size.h - 0.4,
        rx: 0.2, fill: 'rgba(200,230,255,0.4)'
      });
      g.appendChild(ws);
    }

    // Selection marks, framing what is actually drawn: a walker is a circle of
    // diameter size.w, so its box is square rather than size.w × size.h.
    g.appendChild(_buildSelectionMarks(
      size.w, WALKER_TYPES.has(actor.type) ? size.w : size.h));

    // Label. `.map-label` is what _updateLabelVisibility hides below the
    // legibility floor; `.actor-label` carries nothing but this one's styling.
    const label = _svgEl('text', {
      x: 0, y: -Math.max(size.w, size.h) / 2 - 2.0,
      'text-anchor': 'middle', 'font-size': String(MAP_LABEL_M),
      class: 'map-label actor-label',
      fill: '#fff', style: 'pointer-events:none'
    });
    label.textContent = _actorMapLabel(actor);
    g.appendChild(label);

    // Yaw arrow (vehicles and pedestrians — not static objects). The radius
    // passed is the marker's own, so the rotate handle lands outside it.
    g.appendChild(_buildYawArrow(actor, col.body, Math.max(size.w, size.h) / 2));

    // The selected actor goes in the top layer, above its own path — the
    // vehicle you are working on is never buried under anything.
    ((sel && layerActorsTop) ? layerActorsTop : layerActors).appendChild(g);
  }

  /* Static props. Shares the .actor-group class so selection, body dragging and
   * the pan-exclusion list all apply without duplicating that wiring; the extra
   * .prop-group class is there for prop-specific styling.
   *
   * The marker is a TOP-DOWN footprint, matching the rest of the map — roads,
   * lane markings and the vehicle rectangles in _renderActor are all plan view,
   * and like those it rotates with yaw. (The palette tiles use side-view
   * silhouettes instead; see PropCatalog.) Footprints are clamped to a floor by
   * PropCatalog.planSize() — a 0.4 m cone is otherwise invisible on a map
   * spanning hundreds of metres.
   */
  function _renderProp(prop) {
    if (!layerProps) return;
    const cat = window.PropCatalog;
    if (!cat) return;

    const color = cat.color(prop.prop);
    const fp    = cat.planSize(prop.prop);
    const size  = Math.max(fp.len, fp.wid);
    const sel   = AppState.selectedId === prop.id;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', `actor-group prop-group${sel ? ' actor-selected' : ''}`);
    g.setAttribute('data-id', prop.id);
    g.setAttribute('transform', `translate(${prop.x},${prop.y}) rotate(${prop.yaw || 0})`);

    // Invisible grab target: a real cone is ~4 px wide at default zoom, too
    // small to click or drag reliably. Same trick as the yaw-arrow handle.
    // Named, because the yaw handle is placed clear of exactly this circle.
    const grabR = Math.max(size * 0.6, 1.2);
    g.appendChild(_svgEl('circle', { r: grabR, fill: 'transparent' }));

    // planRotate is cosmetic: for props whose yaw means "the way the face
    // points", the body sits ACROSS that direction (a barrier blocks the lane
    // rather than lying along it). Applied to the body alone, so the selection
    // ring, hit target and yaw arrow all still track the true facing.
    const spin = cat.planRotate(prop.prop);
    const body = _svgEl('g', {
      class: 'actor-body',
      ...(spin ? { transform: `rotate(${spin})` } : {}),
    });
    cat.planShapes(prop.prop).forEach(s => body.appendChild(s));
    g.appendChild(body);

    // The body is drawn spun by planRotate, which swaps its extent — frame what
    // is on screen, not the catalogue's unrotated footprint.
    const spun = Math.abs(spin % 180) === 90;
    g.appendChild(_buildSelectionMarks(
      spun ? fp.wid : fp.len, spun ? fp.len : fp.wid));

    // Label only while selected: props are placed in runs (a six-cone taper),
    // and one label per cone buries the glyphs it is meant to annotate.
    if (sel) {
      const label = _svgEl('text', {
        x: 0, y: -size / 2 - 1.8, 'text-anchor': 'middle',
        'font-size': String(MAP_LABEL_M), class: 'map-label',
        fill: '#fff', style: 'pointer-events:none',
      });
      label.textContent = _actorMapLabel(prop);
      g.appendChild(label);
    }

    // Only oriented props get a yaw handle — a cone or barrel has no heading.
    if (cat.oriented(prop.prop)) {
      g.appendChild(_buildYawArrow(prop, color, grabR));
    }

    layerProps.appendChild(g);
  }

  function _actorMapLabel(actor) {
    return AppState.actorLabel(actor, { short: true });
  }

  /* The selection mark: four corner brackets on the object's own box.
   *
   * Deliberately not a ring any more. A yellow circle competed with the map's
   * own furniture — lane paint is yellow, the ruler is `#ffee55`, a bus body is
   * `#ddaa00` — so around a bus on a painted road it was ambiguous what it even
   * marked; and being one radius it could say "something here" but never what,
   * giving a 9 m bus and a 0.9 m cone the same circle. It also drew straight
   * through the actor's own label. Crop marks are a shape a road map never
   * draws, they frame the object instead of covering it, and they stay
   * readable at any size.
   *
   * `w`/`h` are the DRAWN extent in the object's own rotated frame, so the
   * marks turn with it and read as an oriented bounding box. Black over a white
   * casing rather than a single accent colour: the map runs from a `#e8edf2`
   * verge to a near-black carriageway, and only the casing carries both.
   *
   * The stroke is `non-scaling-stroke` (see `.sel-mark-*` in style.css), so the
   * corners follow the box while the line keeps its width on screen. That is
   * what keeps a cone legible — a scaled 2 px line goes sub-pixel long before
   * the object it frames does.
   */
  const SEL_PAD_MIN  = 0.6;    // world m of air between the body and the mark
  const SEL_PAD_FRAC = 0.18;   // …or this much of the box, whichever is larger
  const SEL_ARM_FRAC = 0.3;    // corner arm, as a fraction of its own side
  const SEL_ARM_MAX  = 1.6;    // world m — a long arm on a bus is just a box

  function _buildSelectionMarks(w, h) {
    const pad = Math.max(SEL_PAD_MIN, Math.max(w, h) * SEL_PAD_FRAC);
    const x = w / 2 + pad, y = h / 2 + pad;
    const ax = Math.min(2 * x * SEL_ARM_FRAC, SEL_ARM_MAX);
    const ay = Math.min(2 * y * SEL_ARM_FRAC, SEL_ARM_MAX);
    const corners = [
      `M${-x},${-y + ay} L${-x},${-y} L${-x + ax},${-y}`,
      `M${x - ax},${-y} L${x},${-y} L${x},${-y + ay}`,
      `M${x},${y - ay} L${x},${y} L${x - ax},${y}`,
      `M${-x + ax},${y} L${-x},${y} L${-x},${y - ay}`,
    ];
    const g = _svgEl('g', { class: 'actor-select-marks' });
    // Every casing first, then every line — one path drawn twice, so no corner
    // can end up with its casing painted over the neighbouring corner's line.
    for (const cls of ['sel-mark-casing', 'sel-mark-line']) {
      for (const d of corners) g.appendChild(_svgEl('path', { d, class: cls }));
    }
    return g;
  }

  /* The rotate handle.
   *
   * `bodyRadius` is the radius of the caller's OWN hit target — half the marker
   * for an actor, the invisible grab circle for a prop — and everything here is
   * placed outside it. That is the whole point: drag and rotate are two disjoint
   * zones, and the gap between them is real, empty map. The shaft is decoration
   * only (`.yaw-shaft` is pointer-events:none in CSS) and starts at the body's
   * edge rather than at its centre, where it used to hit-test as "rotate" right
   * across the marker.
   *
   * `.yaw-handle` is the one selector objects.js's mousedown looks for; the
   * ring draws that same circle on hover so the zone is visible before you
   * commit to a drag.
   */
  function _buildYawArrow(actor, color, bodyRadius) {
    const handleR  = Math.min(YAW_HANDLE_R_MAX, Math.max(YAW_HANDLE_R_MIN, bodyRadius));
    const arrowLen = bodyRadius + YAW_HANDLE_GAP + handleR;
    const headLen  = Math.min(1.2, handleR);

    // Arrow group: drawn in local (rotated) coords of the actor
    // so the arrow always points in the actor's heading direction (+X axis = forward)
    const ag = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    ag.setAttribute('class', 'yaw-arrow');
    ag.setAttribute('data-actor-id', actor.id);

    // Shaft — decoration, never a hit target (see .yaw-shaft in style.css)
    const line = _svgEl('line', {
      x1: bodyRadius, y1: 0, x2: arrowLen, y2: 0,
      stroke: color, 'stroke-width': 0.5, 'stroke-opacity': 0.9,
      class: 'yaw-shaft'
    });
    ag.appendChild(line);

    // Arrowhead: the direction cue, and part of the handle. Scaled with the
    // handle so it stays clear of the body on a 0.6 m child too.
    const head = _svgEl('polygon', {
      points: `${arrowLen},0 ${arrowLen-headLen},${-headLen/2} ${arrowLen-headLen},${headLen/2}`,
      fill: color, class: 'arrow-head yaw-handle', 'data-actor-id': actor.id
    });
    ag.appendChild(head);

    // Boundary of the grab zone, shown on hover only.
    ag.appendChild(_svgEl('circle', {
      cx: arrowLen, cy: 0, r: handleR,
      fill: 'none', stroke: color, 'stroke-width': 0.15,
      class: 'yaw-handle-ring'
    }));

    // Invisible hit area, last so it sits on top of the drawn parts.
    ag.appendChild(_svgEl('circle', {
      cx: arrowLen, cy: 0, r: handleR,
      fill: 'transparent', 'data-actor-id': actor.id,
      class: 'yaw-handle'
    }));

    return ag;
  }

  // ── Trajectory rendering ─────────────────────────────────────────────────────

  /* Path line widths, in world metres. Deliberately well under a lane's
   * ~3.5 m: several actors' paths over a town view is a lot of ink, and the
   * line only has to be followable, not emphatic. */
  const PATH_WIDTH     = 0.35;   // an unselected actor's path
  const PATH_WIDTH_SEL = 0.6;    // the selected actor's

  // Track which actors have their trajectory hidden (toggled off by user)
  const _hiddenTrajectories = new Set();
  const _hiddenRoutes = new Set();

  /* Lane-following route geometry, memoised ──────────────────────────────────
   *
   * Simulate.routeGeometry walks every lane segment on the map once per
   * authored waypoint and runs an A* per leg on top. renderAllActors runs on
   * every mousemove of a drag, so the result is cached against everything it
   * depends on: the authored points, and the actor's own pose — leg 0 is
   * seeded from `map.get_waypoint(actor_location).next(1)[0]`, so moving the
   * vehicle really does change the route without any waypoint moving.
   */
  const _routeGeomCache = new Map();   // pathKey -> {sig, points}

  /* The AUTHORED pose, not the live one: a running preview rewrites actor.x/y
   * every tick, which invalidated this signature on every frame and made the
   * drawn route crawl along under the moving vehicle. A follow_trajectory line
   * is the authored vertices and never moved; a route has no business moving
   * either. Simulate.authoredPose returns null when nothing is running, when
   * the actor's own pose already IS the authored one. */
  function _routeSignature(actor, points) {
    const pose = (window.Simulate && Simulate.authoredPose
                  && Simulate.authoredPose(actor.id)) || actor;
    // The strategy is part of the signature, not decoration: it decides whether
    // a leg is routed or drawn as a chord, and toggling a waypoint to 'Gerade'
    // leaves its coordinates untouched — so keying on position alone left the
    // drawn route showing the lane-following line it no longer is.
    return `${pose.x},${pose.y}|`
         + points.map(p => `${p.x},${p.y},${p.strategy || 'fastest'}`).join(';');
  }

  /** The route as CARLA will drive it, or null to fall back to straight chords
   *  (no lane graph for this town, or no lane under one of the waypoints). */
  function _laneFollowingRoute(item) {
    if (!window.Simulate || !Simulate.routeGeometry) return null;
    const key = _pathKey(item.actor.id, item.eventId, 'route');
    const sig = _routeSignature(item.actor, item.points);
    const hit = _routeGeomCache.get(key);
    if (hit && hit.sig === sig) return hit.points;

    let points = null;
    const ev = (item.actor.events || []).find(e => e.id === item.eventId);
    if (ev) {
      try {
        points = Simulate.routeGeometry(item.actor, ev, item.points);
      } catch (err) {
        // A broken graph must not take the whole map render down with it — the
        // straight-chord fallback is always a usable drawing.
        console.warn('[MapView] lane-following route failed', err);
        points = null;
      }
    }
    if (!points || points.length < 2) points = null;
    _routeGeomCache.set(key, { sig, points });
    return points;
  }

  /* Paths carry NO direction arrows, and the per-path <marker> that drew them
   * is gone with them.
   *
   * They used to come from `marker-mid`, a triangle at every interior vertex.
   * That was tolerable while a route line WAS its handful of authored
   * waypoints, but the lane-following line is sampled at CARLA's own 2 m
   * resolution, so the same attribute drew a dozen overlapping triangles per
   * 25 m and the route read as a sawtooth band. Sampling a sparse guide fixed
   * the band and still left the map crowded — several paths plus their arrows
   * over a town view is more ink than the roads underneath. Direction is
   * carried by the numbered waypoints instead, which is where anyone reading
   * the order looks anyway.
   */

  /* ── Waypoint markers ───────────────────────────────────────────────────────
   *
   * One group shape for both path kinds, so objects.js's drag matches a single
   * class (`.path-waypoint`) and the four data attributes below are the whole
   * contract between the map and the event card's waypoint list.
   *
   * Interactivity is scoped to the SELECTED actor: CSS turns pointer-events off
   * for everyone else's waypoints, so one actor's path drawn across another's
   * cannot swallow a mousedown aimed at the path being edited.
   */
  function _waypointGroup(item, i, isSel) {
    const wg = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const marked = isSel && _isMarkedWaypoint(item, i);
    // Waypoint 1 is never interactive, selected actor or not: it is the
    // vehicle's own position and tracks it (AppState.updateById), so it is the
    // vehicle you drag, and the vehicle you delete. Leaving it grabbable would
    // offer a drag that the next actor move silently undoes, and a mark that
    // Entf then refuses to act on. Its own marker sits squarely on the actor,
    // so dropping pointer-events also hands those clicks back to the car.
    const interactive = isSel && i > 0;
    wg.setAttribute('class',
      `path-waypoint ${item.pathType === 'route' ? 'route-waypoint' : 'traj-waypoint'}`
      + `${interactive ? ' waypoint-interactive' : ''}${marked ? ' waypoint-marked' : ''}`);
    wg.setAttribute('data-actor-id', item.actor.id);
    wg.setAttribute('data-event-id', item.eventId);
    wg.setAttribute('data-path-type', item.pathType);
    wg.setAttribute('data-wp-idx', i);
    // Legacy attribute the old renderers wrote; kept so nothing that queried
    // by it silently stops matching.
    wg.setAttribute(item.pathType === 'route' ? 'data-route-id' : 'data-traj-id', item.actor.id);
    return wg;
  }

  function _isMarkedWaypoint(item, i) {
    const sel = AppState.selectedWaypoint;
    return !!sel && sel.actorId === item.actor.id && sel.eventId === item.eventId
        && sel.pathType === item.pathType && sel.index === i;
  }

  /** Invisible grab target — the drawn dot is ~1 m across and sub-pixel at town
   *  zoom, the same problem the trigger-point marker has. */
  const WAYPOINT_HIT_R = 2.2;

  function _appendWaypointHit(wg, wp) {
    wg.appendChild(_svgEl('circle', {
      cx: wp.x, cy: wp.y, r: WAYPOINT_HIT_R, fill: 'transparent', class: 'wp-hit',
    }));
  }

  /**
   * "This is the waypoint the panel row is talking about" — the same four
   * corner crop marks every other selectable object on the map wears.
   *
   * _buildSelectionMarks draws around the origin, because its usual callers
   * (_renderActor, _renderProp, _renderTrafficLight) sit inside a translated,
   * rotated group. A waypoint group is not translated — its shapes carry
   * absolute coordinates — so the marks are wrapped in a translate of their
   * own. `size` is the waypoint's DRAWN extent, which is what the marks frame.
   */
  function _appendWaypointMark(wg, wp, size) {
    const holder = _svgEl('g', { transform: `translate(${wp.x},${wp.y})` });
    holder.appendChild(_buildSelectionMarks(size, size));
    wg.appendChild(holder);
  }

  function _renderTrajectory(item) {
    const actor = item.actor;
    const col  = ACTOR_COLORS[actor.type] || ACTOR_COLORS.car;
    const traj = item.points;
    if (!traj || traj.length < 2) return;

    const isSel    = AppState.selectedId === actor.id;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('data-traj-id', actor.id);
    g.setAttribute('class', `traj-group${isSel ? ' traj-selected' : ''}`);

    // Non-selected trajectories render dimmed; selected at full opacity
    const groupOpacity = isSel ? '1.0' : '0.3';
    g.setAttribute('opacity', groupOpacity);

    // Dashed path line
    const pts = traj.map(wp => `${wp.x},${wp.y}`).join(' ');
    const line = _svgEl('polyline', {
      points: pts,
      class: 'traj-line',
      stroke: col.body,
      'stroke-width': isSel ? PATH_WIDTH_SEL : PATH_WIDTH,
    });
    g.appendChild(line);

    // Waypoint circles + velocity labels
    traj.forEach((wp, i) => {
      const wg = _waypointGroup(item, i, isSel);
      if (isSel) _appendWaypointHit(wg, wp);

      const dotR = isSel ? 1.2 : 0.8;
      const c = _svgEl('circle', {
        cx: wp.x, cy: wp.y, r: dotR,
        fill: col.body, opacity: '0.9', stroke: '#fff', 'stroke-width': 0.2,
        class: 'wp-dot',
      });
      wg.appendChild(c);
      if (isSel && _isMarkedWaypoint(item, i)) _appendWaypointMark(wg, wp, dotR * 2);

      // Velocity label — only for selected actor, every 3rd wp or first/last
      if (isSel && (i === 0 || i === traj.length - 1 || i % 3 === 0)) {
        const vel = _svgEl('text', {
          x: wp.x + 1.8, y: wp.y - 1.2,
          'font-size': '1.8', fill: '#fff',
          style: 'pointer-events:none'
        });
        vel.textContent = `${(wp.velocity || 10).toFixed(0)} m/s`;
        wg.appendChild(vel);
      }

      // Number label inside circle — only for selected actor
      if (isSel) {
        const num = _svgEl('text', {
          x: wp.x, y: wp.y + 0.5,
          'text-anchor': 'middle', 'font-size': '1.2', fill: '#fff',
          'font-weight': 'bold', style: 'pointer-events:none'
        });
        num.textContent = i + 1;
        wg.appendChild(num);
      }

      g.appendChild(wg);
    });

    // The selected actor's path goes over the vehicles, everyone else's under.
    _pathLayerFor(actor).appendChild(g);
  }

  function _renderRoute(item) {
    const actor = item.actor;
    const col = ACTOR_COLORS[actor.type] || ACTOR_COLORS.car;
    const route = item.points;
    if (!route || route.length < 2) return;

    const isSel    = AppState.selectedId === actor.id;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('data-route-id', actor.id);
    g.setAttribute('class', `route-group${isSel ? ' route-selected' : ''}`);

    g.setAttribute('opacity', isSel ? '1.0' : '0.35');

    /* The drawn line is the LANE-FOLLOWING route, not the chords between the
     * clicks. An authored waypoint says where the route must pass, never what
     * shape it takes to get there — GlobalRoutePlanner routes lane by lane, so
     * a straight chord between two clicks crosses buildings, junctions and
     * oncoming carriageways the vehicle never touches, and reads as a plan it
     * is about to violate. Falls back to the chords when the town has no lane
     * graph or a waypoint sits off the network.
     */
    const driven = _laneFollowingRoute(item);
    const linePoints = driven || route;
    const line = _svgEl('polyline', {
      points: linePoints.map(wp => `${wp.x},${wp.y}`).join(' '),
      class: `route-line${driven ? '' : ' route-line-approx'}`,
      stroke: col.body,
      'stroke-width': isSel ? PATH_WIDTH_SEL : PATH_WIDTH,
    });
    const title = _svgEl('title', {});
    title.textContent = driven
      ? 'Route entlang der Fahrspuren'
      : 'Luftlinie — keine Fahrspurdaten für diese Route';
    line.appendChild(title);
    g.appendChild(line);

    route.forEach((wp, i) => {
      const wg = _waypointGroup(item, i, isSel);
      if (isSel) _appendWaypointHit(wg, wp);

      // A 'shortest' waypoint is turned 45 degrees and outlined in the same
      // orange the event card's toggle uses. Two cues rather than one: at town
      // zoom the marker is a couple of pixels across, where a stroke colour
      // alone is invisible and the silhouette still reads. The FILL stays the
      // actor's own colour either way — that is what says whose path this is,
      // and the strategy must not cost that.
      const shortest = wp.strategy === 'shortest';
      const half = isSel ? 1.1 : 0.75;
      const dot = _svgEl('rect', {
        x: wp.x - half, y: wp.y - half,
        width: half * 2, height: half * 2,
        rx: 0.2,
        fill: col.body,
        opacity: '0.9',
        stroke: shortest ? '#e07a00' : '#fff',
        'stroke-width': shortest ? 0.35 : 0.2,
        class: 'wp-dot',
      });
      if (shortest) dot.setAttribute('transform', `rotate(45 ${wp.x} ${wp.y})`);
      wg.appendChild(dot);
      if (isSel && i > 0) {
        const wpTitle = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        wpTitle.textContent = shortest
          ? `Wegpunkt ${i + 1}: gerade Linie vom vorherigen Wegpunkt`
          : `Wegpunkt ${i + 1}: folgt der Fahrspur ab dem vorherigen Wegpunkt`;
        wg.appendChild(wpTitle);
      }
      if (isSel && _isMarkedWaypoint(item, i)) _appendWaypointMark(wg, wp, isSel ? 2.2 : 1.5);

      if (isSel) {
        const num = _svgEl('text', {
          x: wp.x, y: wp.y + 0.5,
          'text-anchor': 'middle', 'font-size': '1.2', fill: '#fff',
          'font-weight': 'bold', style: 'pointer-events:none'
        });
        num.textContent = i + 1;
        wg.appendChild(num);
      }

      g.appendChild(wg);
    });

    if (isSel) {
      const speed = _svgEl('text', {
        x: route[0].x + 2, y: route[0].y - 2,
        'font-size': '1.8', fill: '#fff',
        style: 'pointer-events:none'
      });
      speed.textContent = '10 m/s';
      g.appendChild(speed);
    }

    _pathLayerFor(actor).appendChild(g);
  }

  // ── SVG helper ───────────────────────────────────────────────────────────────

  function _svgEl(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  // ── Mouse interaction ────────────────────────────────────────────────────────

  // Pan with left-drag on the background (not on actors)
  svg.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('.actor-group') ||
        e.target.closest('.yaw-arrow') ||
        e.target.closest('.trigger-radius-control') ||
        e.target.closest('.trigger-point-control') ||
        // This handler is capture-phase on the same <svg> objects.js binds on
        // the bubble phase, so it runs FIRST: without the waypoint here the pan
        // is already under way by the time the drag handler sees the mousedown.
        e.target.closest('.path-waypoint')) return;

    _dragging  = true;
    _dragStart = { x: e.clientX, y: e.clientY };
    _panStart  = { ...(_pan) };
    _panMoved = false;
    svg.style.cursor = 'grabbing';
    e.preventDefault();
  }, true);

  window.addEventListener('mousemove', e => {
    if (_triggerPointDrag) {
      _updateTriggerPointDrag(e);
      return;
    }
    if (_triggerRadiusDrag) {
      _updateTriggerRadiusDrag(e);
      return;
    }
    if (!_dragging) return;
    const dx = e.clientX - _dragStart.x;
    const dy = e.clientY - _dragStart.y;
    if (!_panMoved && Math.hypot(dx, dy) <= _PAN_CLICK_THRESHOLD) return;
    _panMoved = true;
    _pan.x = _panStart.x + dx;
    _pan.y = _panStart.y + dy;
    _applyTransform();
  });

  window.addEventListener('mouseup', () => {
    if (_triggerPointDrag) {
      const { actorId, eventId, moved } = _triggerPointDrag;
      _triggerPointDrag = null;
      if (moved) {
        ObjectsManager.moveTriggerPoint(actorId, eventId, moved.x, moved.y);
        // The marker is re-rendered on every mousemove, so by mouseup the
        // element the drag started on is detached and the browser may not
        // dispatch a click at all — the flag has to expire on its own or it
        // swallows an unrelated map click much later (a placement, a waypoint).
        _suppressNextClick = true;
        setTimeout(() => { _suppressNextClick = false; }, 50);
      }
      return;
    }
    if (_triggerRadiusDrag) {
      _triggerRadiusDrag = null;
      _suppressNextClick = true;
      return;
    }
    if (_dragging) {
      if (_panMoved) _suppressNextClick = true;
      _dragging = false;
      _panMoved = false;
      svg.style.cursor = '';
    }
  });

  svg.addEventListener('click', e => {
    if (!_suppressNextClick) return;
    _suppressNextClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // Zoom with mouse wheel
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const step   = e.shiftKey ? ZOOM_STEP_COARSE : ZOOM_STEP;
    const factor = e.deltaY < 0 ? step : 1 / step;
    const cursor = _clientToSvg(e);
    if (!cursor) return;

    // Keep the world point under the cursor fixed while zooming. The pan has to
    // be derived from the CLAMPED zoom and not the requested one — otherwise
    // wheeling at either limit stops scaling but keeps translating the map,
    // which walks it off screen just as effectively as no clamp at all.
    const world = svgToWorld(e);
    _zoom = _clampZoom(_zoom * factor);
    _pan.x = cursor.x - world.x * _zoom;
    _pan.y = cursor.y - world.y * _zoom;

    _applyTransform();
  }, { passive: false });

  // ── Map view controls ──────────────────────────────────────────────────────
  // Buttons zoom about the view centre; the wheel zooms about the cursor.
  document.getElementById('btn-zoom-in')
    ?.addEventListener('click', () => zoomBy(ZOOM_STEP_COARSE));
  document.getElementById('btn-zoom-out')
    ?.addEventListener('click', () => zoomBy(1 / ZOOM_STEP_COARSE));
  document.getElementById('btn-zoom-fit')
    ?.addEventListener('click', () => {
      Toast.info(zoomToSelection() ? 'Auf Auswahl gezoomt' : 'Ansicht zur\u00fcckgesetzt');
    });

  // Keyboard shortcuts
  const _shortcutsOverlay = document.getElementById('shortcuts-overlay');

  window.addEventListener('keydown', e => {
    // Don't intercept when typing in inputs (except Escape)
    const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT';

    // Escape — cancel active tool / trajectory mode / close overlays
    if (e.key === 'Escape') {
      if (!_shortcutsOverlay.classList.contains('hidden')) {
        _shortcutsOverlay.classList.add('hidden');
        return;
      }
      AppState.cancelPlacement();
      return;
    }

    if (inInput) return;

    // ? — show keyboard shortcuts
    if (e.key === '?') {
      _shortcutsOverlay.classList.toggle('hidden');
      return;
    }

    // R — toggle ruler tool
    if (e.key === 'r' && !e.ctrlKey && !e.metaKey) {
      const newTool = AppState.activeTool === 'ruler' ? null : 'ruler';
      AppState.cancelPlacement({ activeTool: newTool });
      return;
    }

    // F — frame the selection, or reset the view when nothing is selected.
    // Together with the zoom clamp this is the way back from a view that no
    // longer contains the map.
    if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      Toast.info(zoomToSelection() ? 'Auf Auswahl gezoomt' : 'Ansicht zur\u00fcckgesetzt');
      return;
    }

    // Shift+R — clear all ruler measurements
    if (e.key === 'R' && !e.ctrlKey && !e.metaKey) {
      _clearAllRulers();
      Toast.info('Alle Messungen gel\u00f6scht');
      return;
    }

    // Ctrl+Z / Ctrl+Shift+Z — undo and redo any scenario edit.
    //
    // UndoStack.undo() restores its snapshot and emits the re-render signals
    // itself, so there is nothing to reconstruct here. This handler used to
    // rebuild the deleted actor by hand, because the stack held one deleted
    // actor per entry and understood no other kind of edit.
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      const wantRedo = e.shiftKey;
      const step = wantRedo ? UndoStack.redo() : UndoStack.undo();
      if (!step) {
        Toast.info(wantRedo ? 'Nichts zu wiederholen' : 'Nichts r\u00fcckg\u00e4ngig zu machen');
        return;
      }
      const verb = wantRedo ? 'Wiederholt' : 'R\u00fcckg\u00e4ngig';
      Toast.info(step.label ? `${verb}: ${step.label}` : verb);
      return;
    }

    // Ctrl+Y — redo, for the keyboards that expect it there.
    if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
      e.preventDefault();
      const step = UndoStack.redo();
      Toast.info(step
        ? (step.label ? `Wiederholt: ${step.label}` : 'Wiederholt')
        : 'Nichts zu wiederholen');
      return;
    }

    // Delete / Backspace — remove the selected object (with undo).
    //
    // Strg (Cmd on a Mac) is the app-wide "skip the confirm" modifier, honoured
    // identically by the properties trash and every scene-list trash: plain Entf
    // asks first, Strg+Entf does not. This key path used to delete outright,
    // which was the one place in the app where a delete was unguarded.
    // A marked waypoint takes Entf/Backspace ahead of the actor, and takes it
    // WITHOUT the confirm every other delete in the app asks for. The two are
    // not comparable acts: deleting an actor throws away its pose, its whole
    // event chain and anything chained onto those, while a waypoint is one
    // click of a path and comes back with one more — and the mark then moves
    // to the point that took its place, so holding the key walks the path.
    if ((e.key === 'Delete' || e.key === 'Backspace') && AppState.selectedWaypoint) {
      e.preventDefault();
      const sel = AppState.selectedWaypoint;
      ObjectsManager.deletePathPoint(sel.actorId, sel.pathType, sel.index, sel.eventId);
      const left = (AppState.waypointPathOf(sel) || []).length;
      AppState.selectWaypoint(left
        ? { ...sel, index: Math.min(sel.index, left - 1) }
        : null);
      return;
    }

    if ((e.key === 'Delete' || e.key === 'Backspace') && AppState.selectedId) {
      const id    = AppState.selectedId;
      const actor = AppState.findById(id);
      if (!actor) return;
      const label = AppState.actorLabel(actor);

      const commit = () => {
        // The dialog is awaited, so re-read instead of trusting the captured
        // actor: it can be deleted, or the selection moved, while it was open.
        const still = AppState.findById(id);
        if (!still) return;
        AppState.removeById(id);
        MapView.renderAllActors();
        Toast.info(`${label} gelöscht — Strg+Z zum Rückgängigmachen`);
      };

      if (e.ctrlKey || e.metaKey) commit();
      else Confirm.show(`${label} löschen?`, 'Löschen').then(ok => { if (ok) commit(); });
    }
  });

  // ── Layer visibility toggles ──────────────────────────────────────────────

  const layerTogglesEl = document.getElementById('layer-toggles');

  function _setupLayerToggles() {
    // Show toggle bar once a map is loaded
    layerTogglesEl.classList.remove('hidden');
    // Same gate for the zoom cluster: neither means anything without a map.
    document.getElementById('map-view-controls')?.classList.remove('hidden');

    const pairs = [
      { id: 'toggle-crosswalks',     get layer() { return layerCrosswalks; } },
      { id: 'toggle-trafficlights',  get layer() { return layerTrafficLights; } },
      { id: 'toggle-spawns',         layer: layerSpawns },
      { id: 'toggle-markings',       layer: layerMarkings },
      { id: 'toggle-roaddir',        get layer() { return layerRoadDir; } },
      { id: 'toggle-props',          layer: layerProps },
      { id: 'toggle-buildings',      get layer() { return layerBuildings; } },
    ];

    for (const p of pairs) {
      const cb = document.getElementById(p.id);
      if (!cb) continue;
      // Apply current checkbox state
      const target = p.layer;
      if (target) target.style.display = cb.checked ? '' : 'none';
      // Avoid duplicate listeners by replacing element (simple approach)
      cb.onchange = () => {
        const t = p.layer;
        if (t) t.style.display = cb.checked ? '' : 'none';
      };
    }
  }

  // ── Ruler (measure distance) ────────────────────────────────────────────────

  let _rulerActive  = false;
  let _rulerStart   = null;   // {x, y} world coords
  let _rulerEnd     = null;
  let _rulerGroup   = null;   // SVG group for ruler graphics
  let _rulerPinned  = [];     // Array of pinned measurements [{x1,y1,x2,y2,dist}]

  function _ensureRulerLayer() {
    if (!_rulerGroup) {
      _rulerGroup = _svgEl('g', { id: 'layer-ruler' });
      worldGroup.appendChild(_rulerGroup);
    }
  }

  function _renderRulerLine(x1, y1, x2, y2, pinned) {
    const dist = Math.hypot(x2 - x1, y2 - y1);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
    const color = pinned ? '#ffcc00' : '#ffee55';

    const g = _svgEl('g', { class: 'ruler-measurement' });

    // Main line
    g.appendChild(_svgEl('line', {
      x1, y1, x2, y2,
      stroke: color, 'stroke-width': '0.6', 'stroke-dasharray': '2,1.5',
      opacity: pinned ? '0.8' : '1',
    }));

    // End markers (small crosshairs)
    for (const [px, py] of [[x1, y1], [x2, y2]]) {
      g.appendChild(_svgEl('circle', {
        cx: px, cy: py, r: '1.2',
        fill: 'none', stroke: color, 'stroke-width': '0.4',
      }));
      g.appendChild(_svgEl('circle', {
        cx: px, cy: py, r: '0.4', fill: color,
      }));
    }

    // Distance label background
    const labelFontSize = 2.5;
    const textLen = dist.toFixed(1).length + 2; // "+ m"
    const bgW = textLen * labelFontSize * 0.65;
    const bgH = labelFontSize * 1.6;
    g.appendChild(_svgEl('rect', {
      x: mx - bgW / 2, y: my - bgH / 2 - labelFontSize * 0.3,
      width: bgW, height: bgH, rx: '0.8',
      fill: 'rgba(0,0,0,0.75)', stroke: color, 'stroke-width': '0.3',
    }));

    // Distance label text
    const label = _svgEl('text', {
      x: mx, y: my + labelFontSize * 0.3,
      'text-anchor': 'middle', 'font-size': labelFontSize,
      fill: color, 'font-weight': 'bold',
      style: 'pointer-events:none',
    });
    label.textContent = `${dist.toFixed(1)} m`;
    g.appendChild(label);

    // Remove button for pinned rulers
    if (pinned) {
      const delBtn = _svgEl('circle', {
        cx: x2, cy: y2 - 2.5, r: '1.5',
        fill: '#cc3333', stroke: '#fff', 'stroke-width': '0.3',
        style: 'cursor:pointer', class: 'ruler-delete',
      });
      g.appendChild(delBtn);
      const delX = _svgEl('text', {
        x: x2, y: y2 - 2.0,
        'text-anchor': 'middle', 'font-size': '2', fill: '#fff',
        'font-weight': 'bold', style: 'pointer-events:none',
      });
      delX.textContent = '\u00d7';
      g.appendChild(delX);
    }

    return g;
  }

  function _redrawRuler() {
    _ensureRulerLayer();
    while (_rulerGroup.firstChild) _rulerGroup.removeChild(_rulerGroup.firstChild);

    // Pinned measurements
    _rulerPinned.forEach((r, idx) => {
      const g = _renderRulerLine(r.x1, r.y1, r.x2, r.y2, true);
      g.dataset.rulerIdx = idx;
      // Click handler on delete button
      g.querySelector('.ruler-delete')?.addEventListener('click', e => {
        e.stopPropagation();
        e.preventDefault();
        _rulerPinned.splice(idx, 1);
        _redrawRuler();
      });
      _rulerGroup.appendChild(g);
    });

    // Active measurement (being drawn)
    if (_rulerStart && _rulerEnd) {
      _rulerGroup.appendChild(
        _renderRulerLine(_rulerStart.x, _rulerStart.y, _rulerEnd.x, _rulerEnd.y, false)
      );
    }
  }

  function _clearAllRulers() {
    _rulerPinned = [];
    _rulerStart = null;
    _rulerEnd = null;
    _redrawRuler();
  }

  // Ruler interactions — handled via the tool system
  // When ruler tool is active:
  //   - First click: set start point
  //   - Mouse move: preview line with live distance
  //   - Second click: pin the measurement and start a new one
  //   - Escape / tool change: cancel current measurement

  svg.addEventListener('click', e => {
    if (AppState.activeTool !== 'ruler') return;
    if (e.defaultPrevented) return;

    const world = svgToWorld(e);
    e.preventDefault();
    e.stopPropagation();

    if (!_rulerStart) {
      // First click — set start
      _rulerStart = { x: world.x, y: world.y };
      _rulerEnd = null;
    } else {
      // Second click — pin the measurement
      _rulerPinned.push({
        x1: _rulerStart.x, y1: _rulerStart.y,
        x2: world.x, y2: world.y,
        dist: Math.hypot(world.x - _rulerStart.x, world.y - _rulerStart.y),
      });
      _rulerStart = null;
      _rulerEnd = null;
      _redrawRuler();
    }
  }, true);  // capture phase so it fires before the objects.js click handler

  svg.addEventListener('mousemove', e => {
    if (AppState.activeTool !== 'ruler' || !_rulerStart || _dragging) return;
    const world = svgToWorld(e);
    _rulerEnd = { x: world.x, y: world.y };
    _redrawRuler();
  });

  // Cancel ruler on tool change
  AppState.on('change', patch => {
    if ('activeTool' in patch) {
      if (AppState.activeTool !== 'ruler') {
        _rulerStart = null;
        _rulerEnd = null;
        _redrawRuler();
      }
    }
  });

  // ── Public interface ─────────────────────────────────────────────────────────

  const MapView = {
    renderMap,
    renderAllActors,
    svgToWorld,
    resetView,
    zoomToSelection,
    zoomBy,
    focusActor,
    glowActor,
    focusWaypoint,
    glowWaypoint,
    showPath,
    actorColor(type) { return ACTOR_COLORS[type] || ACTOR_COLORS.car; },
    get zoom() { return _zoom; },
    get svg() { return svg; },
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
    actorColor(type) { return ACTOR_COLORS[type] || ACTOR_COLORS.car; },
    actorSize(type) { return ACTOR_SIZES[type] || ACTOR_SIZES.car; },
    isWalkerType(type) { return WALKER_TYPES.has(type); },
  };

  window.MapView = MapView;

  // ── React to state changes ───────────────────────────────────────────────────
  AppState.on('actorUpdated',  () => MapView.renderAllActors());
  AppState.on('actorRemoved',  () => MapView.renderAllActors());
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
  AppState.on('change', patch => {
    if (!('selectedWaypoint' in patch)) return;
    const sel = AppState.selectedWaypoint;
    if (sel) showPath(sel.actorId, sel.eventId, sel.pathType);
    MapView.renderAllActors();
  });
  // specialBuildings arrives once, asynchronously, and may land before or after
  // the first map render — hence both this and the call inside renderMap.
  AppState.on('change', patch => {
    if ('specialBuildings' in patch) _renderSpecialBuildings();
  });
  AppState.on('trafficSignalSelected', () => _renderTrafficLights());
  AppState.on('trafficSignalUpdated', () => _renderTrafficLights());
  AppState.on('stateLoaded',   () => {
    if (AppState.mapData) MapView.renderAllActors();
    _renderTrafficLights();
  });
})();
