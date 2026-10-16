/**
 * mapPaths.js — trajectory and route lines, waypoints, and which paths are shown.
 *
 * Part of the map view (MapView); see mapView.js.
 */
(() => {
  'use strict';

  const { svg, layerTraj, layers, ZOOM_TO_SPAN, view, _centreOn, GLOW_MS, ACTOR_COLORS, _buildSelectionMarks } =
    MapCore.shared;

  /** Frame one waypoint and mark it (the event card's locate click); unlike focusActor it marks. */
  function focusWaypoint(sel) {
    const path = AppState.waypointPathOf(sel);
    const wp = path && path[sel.index];
    if (!wp) return false;
    const vb = svg.viewBox.baseVal;
    _centreOn(wp.x, wp.y, vb && vb.width ? vb.width / ZOOM_TO_SPAN : view.zoom);
    glowWaypoint(sel);
    return true;
  }

  let _wpGlowTimer = null;

  /** Brief pulse on one waypoint marker; GLOW_MS, like glowActor. */
  function glowWaypoint(sel) {
    clearTimeout(_wpGlowTimer);
    svg.querySelectorAll('.wp-locating').forEach((el) => el.classList.remove('wp-locating'));
    if (!sel) return;
    const g = svg.querySelector(
      `.path-waypoint[data-actor-id="${CSS.escape(String(sel.actorId))}"]` +
        `[data-event-id="${CSS.escape(String(sel.eventId))}"]` +
        `[data-path-type="${CSS.escape(String(sel.pathType))}"]` +
        `[data-wp-idx="${CSS.escape(String(sel.index))}"]`,
    );
    if (!g) return;
    g.getBoundingClientRect(); // reflow, so re-locating the same point replays it
    g.classList.add('wp-locating');
    _wpGlowTimer = setTimeout(() => g.classList.remove('wp-locating'), GLOW_MS);
  }

  function _pathKey(actorId, eventId, pathType) {
    return `${actorId}:${eventId || 'actor'}:${pathType}`;
  }

  function _pathItems(actor, pathType) {
    return (actor.events || []).flatMap((ev) => {
      const action = ev.action || {};
      const points =
        pathType === 'route'
          ? action.type === 'assign_route'
            ? action.waypoints || []
            : []
          : action.type === 'follow_trajectory'
            ? action.trajectory || []
            : [];
      return points.length >= 2 ? [{ actor, eventId: ev.id, pathType, points }] : [];
    });
  }

  /** Ausblenden hides a path whether or not its actor is selected; selection only styles shown ones. */
  function _shouldRenderPath(item) {
    const hidden = item.pathType === 'route' ? _hiddenRoutes : _hiddenTrajectories;
    return !hidden.has(_pathKey(item.actor.id, item.eventId, item.pathType));
  }

  /** Un-hide a path by flipping the stored toggle (so its button tells the truth); true if it changed. */
  function showPath(actorId, eventId, pathType) {
    const hidden = pathType === 'route' ? _hiddenRoutes : _hiddenTrajectories;
    return hidden.delete(_pathKey(actorId, eventId, pathType));
  }

  /** Over the vehicles for the selected actor's path, under them otherwise. */
  function _pathLayerFor(actor) {
    return actor.id === AppState.selectedId && layers.pathsTop ? layers.pathsTop : layerTraj;
  }

  // ── Trajectory rendering ─────────────────────────────────────────────────────

  /* World metres, well under a lane's width: several paths over a town view is a lot of ink. */
  const PATH_WIDTH = 0.35; // an unselected actor's path
  const PATH_WIDTH_SEL = 0.6; // the selected actor's

  const _hiddenTrajectories = new Set();
  const _hiddenRoutes = new Set();

  /* Memoised lane-following route geometry: the computation scans every lane segment and
   * renders run every drag frame. Keyed on the points and the actor's pose (leg 0 seeds from it). */
  const _routeGeomCache = new Map(); // pathKey -> {sig, points}

  /* Uses the authored pose, which a running preview does not move, so the route stays put. */
  function _routeSignature(actor, points) {
    const pose = (window.Simulate && Simulate.authoredPose && Simulate.authoredPose(actor.id)) || actor;
    // The strategy is part of the key: 'Gerade' changes the line, not the coordinates.
    return `${pose.x},${pose.y}|` + points.map((p) => `${p.x},${p.y},${p.strategy || 'fastest'}`).join(';');
  }

  /** The route as CARLA drives it, or null for straight chords (no lane graph, or off the network). */
  function _laneFollowingRoute(item) {
    if (!window.Simulate || !Simulate.routeGeometry) return null;
    const key = _pathKey(item.actor.id, item.eventId, 'route');
    const sig = _routeSignature(item.actor, item.points);
    const hit = _routeGeomCache.get(key);
    if (hit && hit.sig === sig) return hit.points;

    let points = null;
    const ev = (item.actor.events || []).find((e) => e.id === item.eventId);
    if (ev) {
      try {
        points = Simulate.routeGeometry(item.actor, ev, item.points);
      } catch (err) {
        // A broken graph must not take the map render down; chords are always drawable.
        console.warn('[MapView] lane-following route failed', err);
        points = null;
      }
    }
    if (!points || points.length < 2) points = null;
    _routeGeomCache.set(key, { sig, points });
    return points;
  }

  /* ── Waypoint markers ───────────────────────────────────────────────────────
   * One group shape for both kinds; `.path-waypoint` plus four data attributes are the
   * contract with objectsDrag.js and the event card. Only the selected actor's are interactive. */
  function _waypointGroup(item, i, isSel) {
    const wg = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const marked = isSel && _isMarkedWaypoint(item, i);
    // Waypoint 1 is the vehicle itself, never interactive, so clicks on it reach the car.
    const interactive = isSel && i > 0;
    wg.setAttribute(
      'class',
      `path-waypoint ${item.pathType === 'route' ? 'route-waypoint' : 'traj-waypoint'}` +
        `${interactive ? ' waypoint-interactive' : ''}${marked ? ' waypoint-marked' : ''}`,
    );
    wg.setAttribute('data-actor-id', item.actor.id);
    wg.setAttribute('data-event-id', item.eventId);
    wg.setAttribute('data-path-type', item.pathType);
    wg.setAttribute('data-wp-idx', i);
    // Kept for anything still querying by the older attribute.
    wg.setAttribute(item.pathType === 'route' ? 'data-route-id' : 'data-traj-id', item.actor.id);
    return wg;
  }

  function _isMarkedWaypoint(item, i) {
    const sel = AppState.selectedWaypoint;
    return (
      !!sel &&
      sel.actorId === item.actor.id &&
      sel.eventId === item.eventId &&
      sel.pathType === item.pathType &&
      sel.index === i
    );
  }

  /** Invisible grab radius: the drawn dot is sub-pixel at town zoom. */
  const WAYPOINT_HIT_R = 2.2;

  function _appendWaypointHit(wg, wp) {
    wg.appendChild(
      UIUtils.svgEl('circle', {
        cx: wp.x,
        cy: wp.y,
        r: WAYPOINT_HIT_R,
        fill: 'transparent',
        class: 'wp-hit',
      }),
    );
  }

  /** The selection corner marks on a waypoint; wrapped in a translate, since waypoint shapes are absolute. */
  function _appendWaypointMark(wg, wp, size) {
    const holder = UIUtils.svgEl('g', { transform: `translate(${wp.x},${wp.y})` });
    holder.appendChild(_buildSelectionMarks(size, size));
    wg.appendChild(holder);
  }

  function _renderTrajectory(item) {
    const actor = item.actor;
    const col = ACTOR_COLORS[actor.type] || ACTOR_COLORS.car;
    const traj = item.points;
    if (!traj || traj.length < 2) return;

    const isSel = AppState.selectedId === actor.id;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('data-traj-id', actor.id);
    g.setAttribute('class', `traj-group${isSel ? ' traj-selected' : ''}`);

    const groupOpacity = isSel ? '1.0' : '0.3';
    g.setAttribute('opacity', groupOpacity);

    const pts = traj.map((wp) => `${wp.x},${wp.y}`).join(' ');
    const line = UIUtils.svgEl('polyline', {
      points: pts,
      class: 'traj-line',
      stroke: col.body,
      'stroke-width': isSel ? PATH_WIDTH_SEL : PATH_WIDTH,
    });
    g.appendChild(line);

    traj.forEach((wp, i) => {
      const wg = _waypointGroup(item, i, isSel);
      if (isSel) _appendWaypointHit(wg, wp);

      const dotR = isSel ? 1.2 : 0.8;
      const c = UIUtils.svgEl('circle', {
        cx: wp.x,
        cy: wp.y,
        r: dotR,
        fill: col.body,
        opacity: '0.9',
        stroke: '#fff',
        'stroke-width': 0.2,
        class: 'wp-dot',
      });
      wg.appendChild(c);
      if (isSel && _isMarkedWaypoint(item, i)) _appendWaypointMark(wg, wp, dotR * 2);

      // Velocity label: selected actor only, first/last and every 3rd.
      if (isSel && (i === 0 || i === traj.length - 1 || i % 3 === 0)) {
        const vel = UIUtils.svgEl('text', {
          x: wp.x + 1.8,
          y: wp.y - 1.2,
          'font-size': '1.8',
          fill: '#fff',
          style: 'pointer-events:none',
        });
        vel.textContent = `${(wp.velocity || 10).toFixed(0)} m/s`;
        wg.appendChild(vel);
      }

      if (isSel) {
        const num = UIUtils.svgEl('text', {
          x: wp.x,
          y: wp.y + 0.5,
          'text-anchor': 'middle',
          'font-size': '1.2',
          fill: '#fff',
          'font-weight': 'bold',
          style: 'pointer-events:none',
        });
        num.textContent = i + 1;
        wg.appendChild(num);
      }

      g.appendChild(wg);
    });

    _pathLayerFor(actor).appendChild(g);
  }

  function _renderRoute(item) {
    const actor = item.actor;
    const col = ACTOR_COLORS[actor.type] || ACTOR_COLORS.car;
    const route = item.points;
    if (!route || route.length < 2) return;

    const isSel = AppState.selectedId === actor.id;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('data-route-id', actor.id);
    g.setAttribute('class', `route-group${isSel ? ' route-selected' : ''}`);

    g.setAttribute('opacity', isSel ? '1.0' : '0.35');

    /* The lane-following route as CARLA drives it, not the chords between the clicks;
     * chords only as the fallback. */
    const driven = _laneFollowingRoute(item);
    const linePoints = driven || route;
    const line = UIUtils.svgEl('polyline', {
      points: linePoints.map((wp) => `${wp.x},${wp.y}`).join(' '),
      class: `route-line${driven ? '' : ' route-line-approx'}`,
      stroke: col.body,
      'stroke-width': isSel ? PATH_WIDTH_SEL : PATH_WIDTH,
    });
    const title = UIUtils.svgEl('title', {});
    title.textContent = driven ? 'Route entlang der Fahrspuren' : 'Luftlinie — keine Fahrspurdaten für diese Route';
    line.appendChild(title);
    g.appendChild(line);

    route.forEach((wp, i) => {
      const wg = _waypointGroup(item, i, isSel);
      if (isSel) _appendWaypointHit(wg, wp);

      // 'shortest': turned 45° and outlined orange (shape reads at town zoom); the fill stays the actor's.
      const shortest = wp.strategy === 'shortest';
      const half = isSel ? 1.1 : 0.75;
      const dot = UIUtils.svgEl('rect', {
        x: wp.x - half,
        y: wp.y - half,
        width: half * 2,
        height: half * 2,
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
        const num = UIUtils.svgEl('text', {
          x: wp.x,
          y: wp.y + 0.5,
          'text-anchor': 'middle',
          'font-size': '1.2',
          fill: '#fff',
          'font-weight': 'bold',
          style: 'pointer-events:none',
        });
        num.textContent = i + 1;
        wg.appendChild(num);
      }

      g.appendChild(wg);
    });

    if (isSel) {
      const speed = UIUtils.svgEl('text', {
        x: route[0].x + 2,
        y: route[0].y - 2,
        'font-size': '1.8',
        fill: '#fff',
        style: 'pointer-events:none',
      });
      speed.textContent = '10 m/s';
      g.appendChild(speed);
    }

    _pathLayerFor(actor).appendChild(g);
  }

  MapCore.define({
    focusWaypoint,
    glowWaypoint,
    _pathKey,
    _pathItems,
    _shouldRenderPath,
    showPath,
    _hiddenTrajectories,
    _hiddenRoutes,
    _routeGeomCache,
    _renderTrajectory,
    _renderRoute,
  });
})();
