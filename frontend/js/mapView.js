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

  // ── Pan / zoom state ────────────────────────────────────────────────────────
  let _pan  = { x: 0, y: 0 };
  let _zoom = 1.0;
  let _dragging = false;
  let _dragStart = null;
  let _panStart  = null;
  let _panMoved = false;
  let _suppressNextClick = false;
  const _PAN_CLICK_THRESHOLD = 4;
  let _triggerRadiusDrag = null;

  // ── Scale ruler ──────────────────────────────────────────────────────────────
  const _scaleBar   = document.querySelector('.scale-bar');
  const _scaleLabel = document.getElementById('scale-label');
  const _NICE_DISTS = [5, 10, 20, 50, 100, 200, 500, 1000, 2000];
  const _TARGET_PX  = 120;  // target bar width in screen pixels

  function _updateScaleRuler() {
    // Use the CTM to find how many screen pixels = 1 world metre
    const ctm = worldGroup.getScreenCTM();
    if (!ctm) return;
    const pxPerMetre = Math.abs(ctm.a);  // scale factor X
    if (pxPerMetre <= 0) return;

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

  function _applyTransform() {
    worldGroup.setAttribute('transform',
      `translate(${_pan.x},${_pan.y}) scale(${_zoom})`
    );
    _updateScaleRuler();
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
    layerCrosswalks    = _svgEl('g', { id: 'layer-crosswalks' });
    layerTrafficLights = _svgEl('g', { id: 'layer-trafficlights' });
    layerRoadDir       = _svgEl('g', { id: 'layer-roaddir' });
    layerTriggerPoints = _svgEl('g', { id: 'layer-trigger-points' });
    const layerTrajEl  = document.getElementById('layer-trajectories');
    worldGroup.insertBefore(layerRoadDir,       layerTrajEl);
    worldGroup.insertBefore(layerCrosswalks,    layerTrajEl);
    worldGroup.insertBefore(layerTrafficLights, layerTrajEl);
    worldGroup.insertBefore(layerTriggerPoints, layerTrajEl);

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
      if (AppState.activeTool || AppState.trajectoryMode || AppState.routeMode || AppState.triggerPointMode) return;
      e.preventDefault();
      e.stopPropagation();
      TrafficSignals.select(id);
    });

    // Selection ring
    g.appendChild(_svgEl('circle', {
      cx: '0', cy: '0', r: '4.5',
      fill: 'none',
      stroke: '#ffff00',
      'stroke-width': '0.6',
      class: 'traffic-light-select-ring',
    }));

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

    // Props sit in their own layer beneath the actors
    for (const prop of AppState.staticObjects) _renderProp(prop);

    if (AppState.ego) _renderActor(AppState.ego);
    for (const npc of AppState.npcs) _renderActor(npc);

    // Paths: ego path is actor-level; NPC paths live inside event actions.
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
    const actor = AppState.npcs.find(n => n.id === AppState.selectedId);
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
      g.appendChild(_svgEl('circle', {
        cx: '0', cy: '0', r: '0.7',
        fill: '#ffffff00',
        stroke: '#ffffff',
        'stroke-width': '0.5',
      }));
      const label = _svgEl('text', {
        x: '0', y: '-4',
        'text-anchor': 'middle',
        'font-size': '2.2',
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

  function _formatSvgNumber(value) {
    return Number(value).toFixed(2).replace(/\.?0+$/, '');
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
    const actor = AppState.npcs.find(n => n.id === _triggerRadiusDrag.actorId);
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
    if (actor.type === 'ego') {
      const points = pathType === 'trajectory' ? (actor.trajectory || []) : [];
      return points.length >= 2 ? [{ actor, eventId: null, pathType, points }] : [];
    }
    return (actor.events || []).flatMap(ev => {
      const action = ev.action || {};
      const points = pathType === 'route'
        ? (action.type === 'assign_route' ? (action.waypoints || []) : [])
        : (action.type === 'follow_trajectory' ? (action.trajectory || []) : []);
      return points.length >= 2 ? [{ actor, eventId: ev.id, pathType, points }] : [];
    });
  }

  function _shouldRenderPath(item) {
    const hidden = item.pathType === 'route' ? _hiddenRoutes : _hiddenTrajectories;
    return !hidden.has(_pathKey(item.actor.id, item.eventId, item.pathType));
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

    // Selection ring
    const ring = _svgEl('circle', {
      r: Math.max(size.w, size.h) * 0.7 + 1,
      fill: 'none', stroke: '#ffff00', 'stroke-width': 0.6,
      class: 'actor-select-ring'
    });
    g.appendChild(ring);

    // Label
    const label = _svgEl('text', {
      x: 0, y: -Math.max(size.w, size.h) / 2 - 1.5,
      'text-anchor': 'middle', 'font-size': '2.2',
      fill: '#fff', style: 'pointer-events:none'
    });
    label.textContent = _actorMapLabel(actor);
    g.appendChild(label);

    // Yaw arrow (vehicles and pedestrians — not static objects)
    if (true) {  // all scenario actors get a yaw arrow
      const arrow = _buildYawArrow(actor, col.body, size);
      g.appendChild(arrow);
    }

    layerActors.appendChild(g);
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
    g.appendChild(_svgEl('circle', {
      r: Math.max(size * 0.6, 1.2), fill: 'transparent',
    }));

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

    g.appendChild(_svgEl('circle', {
      r: size * 0.7 + 1, fill: 'none', stroke: '#ffff00',
      'stroke-width': 0.6, class: 'actor-select-ring',
    }));

    // Label only while selected: props are placed in runs (a six-cone taper),
    // and one label per cone buries the glyphs it is meant to annotate.
    if (sel) {
      const label = _svgEl('text', {
        x: 0, y: -size / 2 - 1.2, 'text-anchor': 'middle', 'font-size': '1.8',
        fill: '#fff', style: 'pointer-events:none',
      });
      label.textContent = _actorMapLabel(prop);
      g.appendChild(label);
    }

    // Only oriented props get a yaw handle — a cone or barrel has no heading.
    if (cat.oriented(prop.prop)) {
      g.appendChild(_buildYawArrow(prop, color, { w: size, h: size },
        Math.max(fp.len * 0.75, 1.6)));
    }

    layerProps.appendChild(g);
  }

  function _actorMapLabel(actor) {
    return AppState.actorLabel(actor, {ego: 'EGO'});
  }

  // lenOverride: props are far smaller than a 4.5 m car, and the actor floor
  // below would draw an arrow longer than the prop it belongs to.
  function _buildYawArrow(actor, color, size, lenOverride) {
    const arrowLen = lenOverride ?? Math.max(size.w, 4.5) * 0.8;
    // Arrow group: drawn in local (rotated) coords of the actor
    // so the arrow always points in the actor's heading direction (+X axis = forward)
    const ag = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    ag.setAttribute('class', 'yaw-arrow');
    ag.setAttribute('data-actor-id', actor.id);

    // Shaft
    const line = _svgEl('line', {
      x1: 0, y1: 0, x2: arrowLen, y2: 0,
      stroke: color, 'stroke-width': 0.5, 'stroke-opacity': 0.9
    });
    ag.appendChild(line);

    // Arrowhead (draggable)
    const head = _svgEl('polygon', {
      points: `${arrowLen},0 ${arrowLen-1.2},-0.6 ${arrowLen-1.2},0.6`,
      fill: color, class: 'arrow-head', 'data-actor-id': actor.id
    });
    ag.appendChild(head);

    // Invisible large hit area for easier grabbing
    const hit = _svgEl('circle', {
      cx: arrowLen, cy: 0, r: 1.5,
      fill: 'transparent', 'data-actor-id': actor.id,
      style: 'cursor:grab'
    });
    ag.appendChild(hit);

    return ag;
  }

  // ── Trajectory rendering ─────────────────────────────────────────────────────

  // Track which actors have their trajectory hidden (toggled off by user)
  const _hiddenTrajectories = new Set();
  const _hiddenRoutes = new Set();

  function _ensureArrowMarker(actorId, color) {
    // Create a per-actor arrow marker so each trajectory gets its own color
    const markerId = `arrow-traj-${String(actorId).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    if (!document.getElementById(markerId)) {
      const defs = svg.querySelector('defs');
      const marker = _svgEl('marker', {
        id: markerId, markerWidth: '4', markerHeight: '4',
        refX: '2', refY: '2', orient: 'auto', markerUnits: 'strokeWidth',
      });
      marker.appendChild(_svgEl('polygon', {
        points: '0,0 4,2 0,4', fill: color, opacity: '0.8',
      }));
      defs.appendChild(marker);
    }
    return markerId;
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

    // Per-actor arrow marker color
    const markerId = _ensureArrowMarker(_pathKey(actor.id, item.eventId, 'trajectory'), col.body);

    // Dashed path line
    const pts = traj.map(wp => `${wp.x},${wp.y}`).join(' ');
    const lineWidth = isSel ? '1.2' : '0.7';
    const line = _svgEl('polyline', {
      points: pts,
      class: 'traj-line',
      stroke: col.body,
      'stroke-width': lineWidth,
      'marker-mid': `url(#${markerId})`,
    });
    g.appendChild(line);

    // Waypoint circles + velocity labels
    traj.forEach((wp, i) => {
      const wg = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      wg.setAttribute('class', 'traj-waypoint');
      wg.setAttribute('data-traj-id', actor.id);
      wg.setAttribute('data-wp-idx', i);

      const dotR = isSel ? 1.2 : 0.8;
      const c = _svgEl('circle', {
        cx: wp.x, cy: wp.y, r: dotR,
        fill: col.body, opacity: '0.9', stroke: '#fff', 'stroke-width': 0.2
      });
      wg.appendChild(c);

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

    // Selected trajectory renders on top (appended last)
    layerTraj.appendChild(g);
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

    const markerId = _ensureArrowMarker(_pathKey(actor.id, item.eventId, 'route'), col.body);

    const pts = route.map(wp => `${wp.x},${wp.y}`).join(' ');
    const line = _svgEl('polyline', {
      points: pts,
      class: 'route-line',
      stroke: col.body,
      'stroke-width': isSel ? '1.4' : '0.8',
      'marker-mid': `url(#${markerId})`,
    });
    g.appendChild(line);

    route.forEach((wp, i) => {
      const wg = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      wg.setAttribute('class', 'route-waypoint');
      wg.setAttribute('data-route-id', actor.id);
      wg.setAttribute('data-wp-idx', i);

      wg.appendChild(_svgEl('rect', {
        x: wp.x - (isSel ? 1.1 : 0.75),
        y: wp.y - (isSel ? 1.1 : 0.75),
        width: isSel ? 2.2 : 1.5,
        height: isSel ? 2.2 : 1.5,
        rx: 0.2,
        fill: col.body,
        opacity: '0.9',
        stroke: '#fff',
        'stroke-width': 0.2,
      }));

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

    layerTraj.appendChild(g);
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
        e.target.closest('.trigger-radius-control')) return;

    _dragging  = true;
    _dragStart = { x: e.clientX, y: e.clientY };
    _panStart  = { ...(_pan) };
    _panMoved = false;
    svg.style.cursor = 'grabbing';
    e.preventDefault();
  }, true);

  window.addEventListener('mousemove', e => {
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
    const factor = e.deltaY < 0 ? 1.06 : 1 / 1.06;
    const cursor = _clientToSvg(e);
    if (!cursor) return;

    // Keep the world point under the cursor fixed while zooming.
    const world = svgToWorld(e);
    _zoom *= factor;
    _pan.x = cursor.x - world.x * _zoom;
    _pan.y = cursor.y - world.y * _zoom;

    _applyTransform();
  }, { passive: false });

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
      AppState.set({ activeTool: null, pendingTemplate: null, pendingProp: null, trajectoryMode: false, activeTrajectoryId: null, routeMode: false, activeRouteId: null, activePathEventId: null, triggerPointMode: null });
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
      AppState.set({ activeTool: newTool, pendingTemplate: null, pendingProp: null, trajectoryMode: false, activeTrajectoryId: null, routeMode: false, activeRouteId: null, activePathEventId: null });
      return;
    }

    // Shift+R — clear all ruler measurements
    if (e.key === 'R' && !e.ctrlKey && !e.metaKey) {
      _clearAllRulers();
      Toast.info('All measurements cleared');
      return;
    }

    // Ctrl+Z — undo last delete
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      const entry = UndoStack.pop();
      if (!entry) { Toast.info('Nothing to undo'); return; }
      if (entry.action === 'delete') {
        const actor = entry.actor;
        if (actor.type === 'ego') {
          AppState.set({ ego: actor });
        } else if (actor.type === 'prop') {
          AppState.staticObjects = [...AppState.staticObjects, actor];
          AppState.set({});
        } else {
          AppState.npcs = [...AppState.npcs, actor];
          AppState.set({});
        }
        AppState.select(actor.id);
        MapView.renderAllActors();
        Toast.success(`Restored ${AppState.actorLabel(actor, { ego: 'EGO' })}`);
      }
      return;
    }

    // Delete / Backspace — remove selected object (with undo)
    if ((e.key === 'Delete' || e.key === 'Backspace') && AppState.selectedId) {
      const actor = AppState.findById(AppState.selectedId);
      if (actor) {
        UndoStack.push({ action: 'delete', actor: JSON.parse(JSON.stringify(actor)) });
        const label = AppState.actorLabel(actor, { ego: 'Ego Vehicle' });
        AppState.removeById(AppState.selectedId);
        MapView.renderAllActors();
        Toast.info(`Deleted ${label} \u2014 Ctrl+Z to undo`);
      }
    }
  });

  // ── Layer visibility toggles ──────────────────────────────────────────────

  const layerTogglesEl = document.getElementById('layer-toggles');

  function _setupLayerToggles() {
    // Show toggle bar once a map is loaded
    layerTogglesEl.classList.remove('hidden');

    const pairs = [
      { id: 'toggle-crosswalks',     get layer() { return layerCrosswalks; } },
      { id: 'toggle-trafficlights',  get layer() { return layerTrafficLights; } },
      { id: 'toggle-spawns',         layer: layerSpawns },
      { id: 'toggle-markings',       layer: layerMarkings },
      { id: 'toggle-roaddir',        get layer() { return layerRoadDir; } },
      { id: 'toggle-props',          layer: layerProps },
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
  };

  window.MapView = MapView;

  // ── React to state changes ───────────────────────────────────────────────────
  AppState.on('actorUpdated',  () => MapView.renderAllActors());
  AppState.on('actorRemoved',  () => MapView.renderAllActors());
  AppState.on('selectionChanged', () => {
    MapView.renderAllActors();
    _renderTrafficLights();
  });
  AppState.on('trafficSignalSelected', () => _renderTrafficLights());
  AppState.on('trafficSignalUpdated', () => _renderTrafficLights());
  AppState.on('stateLoaded',   () => {
    if (AppState.mapData) MapView.renderAllActors();
    _renderTrafficLights();
  });
})();
