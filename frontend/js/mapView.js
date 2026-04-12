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
  const layerActors      = document.getElementById('layer-actors');
  const overlayMsg       = document.getElementById('map-overlay-msg');

  // Extra map-detail layers (inserted into #world by renderMap)
  let layerCrosswalks    = null;
  let layerTrafficLights = null;
  let layerRoadDir       = null;   // road direction arrows

  // ── Pan / zoom state ────────────────────────────────────────────────────────
  let _pan  = { x: 0, y: 0 };
  let _zoom = 1.0;
  let _dragging = false;
  let _dragStart = null;
  let _panStart  = null;

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
    layerCrosswalks    = _svgEl('g', { id: 'layer-crosswalks' });
    layerTrafficLights = _svgEl('g', { id: 'layer-trafficlights' });
    layerRoadDir       = _svgEl('g', { id: 'layer-roaddir' });
    const layerTrajEl  = document.getElementById('layer-trajectories');
    worldGroup.insertBefore(layerRoadDir,       layerTrajEl);
    worldGroup.insertBefore(layerCrosswalks,    layerTrajEl);
    worldGroup.insertBefore(layerTrafficLights, layerTrajEl);

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
    bgRect.setAttribute('fill',   grassColor || '#2d5a2d');

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
            if (lane.directionLine && lane.directionLine.length > 1) {
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
      _renderTrafficLight(tl.x, tl.y);
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
          points: '-2,0 2,-1.2 2,1.2',
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

    const STRIPE_W   = 1.8;   // stripe thickness (across-road direction) (m)
    const STRIPE_GAP = 1.4;   // gap between stripes (m)
    const STRIPE_LEN = 12.0;  // stripe length along-road direction (m)
    const NUM_STRIPES = 6;
    const totalStep  = STRIPE_W + STRIPE_GAP;
    const startOff   = -(NUM_STRIPES * totalStep) / 2;

    const g = _svgEl('g', { class: 'crosswalk-group' });

    for (let i = 0; i < NUM_STRIPES; i++) {
      // Space stripes along the perpendicular (across-road) axis
      const offset = startOff + i * totalStep + STRIPE_W / 2;
      const cx = cw.x + px * offset;
      const cy = cw.y + py * offset;
      const hw = STRIPE_W / 2;   // half-width in perpendicular direction
      const hl = STRIPE_LEN / 2; // half-length in road-forward direction
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

  function _renderTrafficLight(x, y) {
    // Simplified traffic-light icon: a bright coloured dot with glow,
    // large enough to be visible at the default zoom level.
    const g = _svgEl('g', { transform: `translate(${x},${y})`, class: 'traffic-light' });

    // Outer glow
    g.appendChild(_svgEl('circle', {
      cx: '0', cy: '0', r: '4',
      fill: '#ff2222', 'fill-opacity': '0.15',
    }));
    // Main red dot — the most visible element
    g.appendChild(_svgEl('circle', {
      cx: '0', cy: '0', r: '2.2',
      fill: '#ff3333',
      stroke: '#ffffff', 'stroke-width': '0.5',
    }));
    // Small inner highlight
    g.appendChild(_svgEl('circle', {
      cx: '-0.4', cy: '-0.4', r: '0.7',
      fill: '#ff8888', 'fill-opacity': '0.6',
    }));

    layerTrafficLights.appendChild(g);
  }

  // ── Actor rendering ──────────────────────────────────────────────────────────

  const ACTOR_COLORS = {
    ego:         { body: '#4488ff', text: '#fff' },
    car:         { body: '#ff9933', text: '#222' },
    truck:       { body: '#cc5522', text: '#fff' },
    bus:         { body: '#ddaa00', text: '#222' },
    motorcycle:  { body: '#ff7755', text: '#fff' },
    pedestrian:  { body: '#cc66cc', text: '#fff' },
    cyclist:     { body: '#33bb88', text: '#fff' },
  };

  const ACTOR_SIZES = {
    ego:        { w: 4.5, h: 2.1 },
    car:        { w: 4.5, h: 2.1 },
    truck:      { w: 7.0, h: 2.6 },
    bus:        { w: 9.0, h: 2.8 },
    motorcycle: { w: 2.2, h: 1.0 },
    pedestrian: { w: 1.0, h: 1.0 },
    cyclist:    { w: 2.0, h: 0.8 },
  };

  function renderAllActors() {
    while (layerActors.firstChild) layerActors.removeChild(layerActors.firstChild);
    while (layerTraj.firstChild)   layerTraj.removeChild(layerTraj.firstChild);

    if (AppState.ego) _renderActor(AppState.ego);
    for (const npc of AppState.npcs) _renderActor(npc);

    // Trajectories: render non-selected first, selected last (on top)
    const allActors = AppState.ego ? [AppState.ego, ...AppState.npcs] : [...AppState.npcs];
    const withTraj  = allActors.filter(a => a.trajectory && a.trajectory.length >= 2);
    const selId     = AppState.selectedId;

    // Non-selected trajectories first (underneath)
    for (const actor of withTraj) {
      if (actor.id !== selId) _renderTrajectory(actor);
    }
    // Selected trajectory last (on top)
    for (const actor of withTraj) {
      if (actor.id === selId) _renderTrajectory(actor);
    }
  }

  function _renderActor(actor) {
    const col  = ACTOR_COLORS[actor.type] || ACTOR_COLORS.car;
    const size = ACTOR_SIZES[actor.type]  || ACTOR_SIZES.car;
    const sel  = AppState.selectedId === actor.id;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', `actor-group${sel ? ' actor-selected' : ''}`);
    g.setAttribute('data-id', actor.id);
    g.setAttribute('transform', `translate(${actor.x},${actor.y}) rotate(${actor.yaw || 0})`);

    if (actor.type === 'pedestrian') {
      // Pedestrian: filled circle
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
    label.textContent = actor.type === 'ego' ? 'EGO' : actor.type.toUpperCase();
    g.appendChild(label);

    // Yaw arrow (vehicles and pedestrians — not static objects)
    if (true) {  // all scenario actors get a yaw arrow
      const arrow = _buildYawArrow(actor, col.body, size);
      g.appendChild(arrow);
    }

    layerActors.appendChild(g);
  }

  function _buildYawArrow(actor, color, size) {
    const arrowLen = Math.max(size.w, 4.5) * 0.8;
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

  function _ensureArrowMarker(actorId, color) {
    // Create a per-actor arrow marker so each trajectory gets its own color
    const markerId = `arrow-traj-${actorId}`;
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

  function _renderTrajectory(actor) {
    const col  = ACTOR_COLORS[actor.type] || ACTOR_COLORS.car;
    const traj = actor.trajectory;
    if (!traj || traj.length < 2) return;

    const isSel    = AppState.selectedId === actor.id;
    const isHidden = _hiddenTrajectories.has(actor.id);

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('data-traj-id', actor.id);
    g.setAttribute('class', `traj-group${isSel ? ' traj-selected' : ''}`);

    // Hidden trajectories: skip rendering entirely
    if (isHidden && !isSel) {
      layerTraj.appendChild(g);
      return;
    }

    // Non-selected trajectories render dimmed; selected at full opacity
    const groupOpacity = isSel ? '1.0' : '0.3';
    g.setAttribute('opacity', groupOpacity);

    // Per-actor arrow marker color
    const markerId = _ensureArrowMarker(actor.id, col.body);

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
    // Only pan if no active tool and click is not on an actor
    if (AppState.activeTool || AppState.trajectoryMode) return;
    if (e.target.closest('.actor-group') || e.target.closest('.yaw-arrow')) return;

    _dragging  = true;
    _dragStart = { x: e.clientX, y: e.clientY };
    _panStart  = { ...(_pan) };
    svg.style.cursor = 'grabbing';
    e.preventDefault();
  });

  window.addEventListener('mousemove', e => {
    if (!_dragging) return;
    _pan.x = _panStart.x + (e.clientX - _dragStart.x);
    _pan.y = _panStart.y + (e.clientY - _dragStart.y);
    _applyTransform();
  });

  window.addEventListener('mouseup', () => {
    if (_dragging) {
      _dragging = false;
      svg.style.cursor = '';
    }
  });

  // Zoom with mouse wheel
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const rect   = svg.getBoundingClientRect();

    // Zoom around mouse position (in SVG element coords)
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    _pan.x  = mx - factor * (mx - _pan.x);
    _pan.y  = my - factor * (my - _pan.y);
    _zoom  *= factor;

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
      AppState.set({ activeTool: null, trajectoryMode: false, activeTrajectoryId: null });
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
      AppState.set({ activeTool: newTool, trajectoryMode: false, activeTrajectoryId: null });
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
        } else if (['tree', 'building'].includes(actor.type)) {
          AppState.staticObjects = [...AppState.staticObjects, actor];
          AppState.set({});
        } else {
          AppState.npcs = [...AppState.npcs, actor];
          AppState.set({});
        }
        AppState.select(actor.id);
        MapView.renderAllActors();
        Toast.success(`Restored ${actor.type.toUpperCase()}`);
      }
      return;
    }

    // Delete / Backspace — remove selected object (with undo)
    if ((e.key === 'Delete' || e.key === 'Backspace') && AppState.selectedId) {
      const actor = AppState.findById(AppState.selectedId);
      if (actor) {
        UndoStack.push({ action: 'delete', actor: JSON.parse(JSON.stringify(actor)) });
        const label = actor.type === 'ego' ? 'Ego Vehicle' : actor.type.toUpperCase();
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
    if (AppState.activeTool !== 'ruler' || !_rulerStart) return;
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
    toggleTrajectoryVisibility(actorId) {
      if (_hiddenTrajectories.has(actorId)) _hiddenTrajectories.delete(actorId);
      else _hiddenTrajectories.add(actorId);
      renderAllActors();
    },
    isTrajectoryVisible(actorId) {
      return !_hiddenTrajectories.has(actorId);
    },
    clearAllRulers: _clearAllRulers,
  };

  window.MapView = MapView;

  // ── React to state changes ───────────────────────────────────────────────────
  AppState.on('actorUpdated',  () => MapView.renderAllActors());
  AppState.on('actorRemoved',  () => MapView.renderAllActors());
  AppState.on('selectionChanged', () => MapView.renderAllActors());
  AppState.on('stateLoaded',   () => {
    if (AppState.mapData) MapView.renderAllActors();
  });
})();
