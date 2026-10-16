/**
 * mapPaths.js — trajectory and route lines, waypoints, and which paths are shown.
 *
 * Part of the map view (MapView); see mapView.js.
 */
(() => {
  'use strict';

  const { svg, layerTraj, layers, ZOOM_TO_SPAN, view, _centreOn, GLOW_MS, ACTOR_COLORS, _buildSelectionMarks } =
    MapCore.shared;

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

  /** Brief pulse on one waypoint marker. Same 900 ms budget as glowActor, and
   *  the same rule: the class must not outlive its keyframes. */
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
    return actor.id === AppState.selectedId && layers.pathsTop ? layers.pathsTop : layerTraj;
  }

  // ── Trajectory rendering ─────────────────────────────────────────────────────

  /* Path line widths, in world metres. Deliberately well under a lane's
   * ~3.5 m: several actors' paths over a town view is a lot of ink, and the
   * line only has to be followable, not emphatic. */
  const PATH_WIDTH = 0.35; // an unselected actor's path
  const PATH_WIDTH_SEL = 0.6; // the selected actor's

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
  const _routeGeomCache = new Map(); // pathKey -> {sig, points}

  /* The AUTHORED pose, not the live one: a running preview rewrites actor.x/y
   * every tick, which invalidated this signature on every frame and made the
   * drawn route crawl along under the moving vehicle. A follow_trajectory line
   * is the authored vertices and never moved; a route has no business moving
   * either. Simulate.authoredPose returns null when nothing is running, when
   * the actor's own pose already IS the authored one. */
  function _routeSignature(actor, points) {
    const pose = (window.Simulate && Simulate.authoredPose && Simulate.authoredPose(actor.id)) || actor;
    // The strategy is part of the signature, not decoration: it decides whether
    // a leg is routed or drawn as a chord, and toggling a waypoint to 'Gerade'
    // leaves its coordinates untouched — so keying on position alone left the
    // drawn route showing the lane-following line it no longer is.
    return `${pose.x},${pose.y}|` + points.map((p) => `${p.x},${p.y},${p.strategy || 'fastest'}`).join(';');
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
    const ev = (item.actor.events || []).find((e) => e.id === item.eventId);
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
   * One group shape for both path kinds, so objectsDrag.js's drag matches a single
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
    wg.setAttribute(
      'class',
      `path-waypoint ${item.pathType === 'route' ? 'route-waypoint' : 'traj-waypoint'}` +
        `${interactive ? ' waypoint-interactive' : ''}${marked ? ' waypoint-marked' : ''}`,
    );
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
    return (
      !!sel &&
      sel.actorId === item.actor.id &&
      sel.eventId === item.eventId &&
      sel.pathType === item.pathType &&
      sel.index === i
    );
  }

  /** Invisible grab target — the drawn dot is ~1 m across and sub-pixel at town
   *  zoom, the same problem the trigger-point marker has. */
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

    // Non-selected trajectories render dimmed; selected at full opacity
    const groupOpacity = isSel ? '1.0' : '0.3';
    g.setAttribute('opacity', groupOpacity);

    // Dashed path line
    const pts = traj.map((wp) => `${wp.x},${wp.y}`).join(' ');
    const line = UIUtils.svgEl('polyline', {
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

      // Velocity label — only for selected actor, every 3rd wp or first/last
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

      // Number label inside circle — only for selected actor
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

    // The selected actor's path goes over the vehicles, everyone else's under.
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

      // A 'shortest' waypoint is turned 45 degrees and outlined in the same
      // orange the event card's toggle uses. Two cues rather than one: at town
      // zoom the marker is a couple of pixels across, where a stroke colour
      // alone is invisible and the silhouette still reads. The FILL stays the
      // actor's own colour either way — that is what says whose path this is,
      // and the strategy must not cost that.
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
