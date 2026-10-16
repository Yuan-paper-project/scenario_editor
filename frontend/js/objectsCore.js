/**
 * objectsCore.js — lane projection and snapping, ground height, placement yaw, and the path accessors every part shares.
 *
 * Part of ObjectsManager; see objects.js.
 */
(() => {
  'use strict';

  window.ObjectsCore = UIUtils.sharedScope('ObjectsCore');

  const svg = MapView.svg;
  // Set by the drag handlers and read by the click handler: the click that ends
  // a drag is not a placement. An object rather than a reassigned let, so both
  // sides see one copy.
  const drag = { wasDragging: false };

  const ROAD_FACING_TYPES = new Set(['pedestrian', 'child', 'cyclist', 'bicycle']);

  /** Normalise degrees into [-180, 180). */
  function _wrapDeg(deg) {
    return ((((deg + 180) % 360) + 360) % 360) - 180;
  }

  /* Placement orientation for a prop, from the OpenDRIVE direction of the
   * specific lane nearest the click. `near.laneYaw` is true lane *travel*
   * direction — map_renderer reverses directionLine for left-side lanes — so
   * on a two-way road the two carriageways give yaws 180° apart and an
   * 'oncoming' prop on each side faces its own lane's traffic.
   *
   * wx/wy must be the ORIGINAL click point, not a snapped position: Shift puts
   * the prop on the lane centreline, where "which side of the lane" degenerates.
   */
  function _propYawFor(blueprint, wx, wy, near) {
    const rule = PropCatalog.facing(blueprint);
    if (rule === 'none' || !near) return 0;

    const toRoad = (Math.atan2(near.y - wy, near.x - wx) * 180) / Math.PI;

    switch (rule) {
      case 'oncoming':
        return Math.round(_wrapDeg(near.laneYaw + 180));
      case 'along':
        return Math.round(_wrapDeg(near.laneYaw));
      case 'toward-road':
        return Math.round(_wrapDeg(toRoad));
      case 'alongside': {
        // Long axis stays parallel to the kerb; pick the flip that turns the
        // object's open side (local +Y, i.e. yaw + 90) toward the carriageway.
        const openAt = _wrapDeg(near.laneYaw + 90);
        const flip = Math.abs(_wrapDeg(openAt - toRoad)) > 90;
        return Math.round(_wrapDeg(near.laneYaw + (flip ? 180 : 0)));
      }
      default:
        return 0;
    }
  }

  function _roadFacingYaw(wx, wy) {
    // Face the nearest DRIVING lane when there is one in reach: from a
    // shoulder, parking bay or kerb the nearest lane of any type is often the
    // one under the walker's feet, and "perpendicular to that" faced half of
    // all crossings away from the road.
    const nearest = _nearestLaneProjection(wx, wy, new Set(['driving']), 30) || _nearestLaneProjection(wx, wy);
    if (!nearest) return 0;
    const towardRoad = (Math.atan2(nearest.y - wy, nearest.x - wx) * 180) / Math.PI;
    if (Math.hypot(nearest.x - wx, nearest.y - wy) > 0.2) return Math.round(towardRoad);
    return Math.round(nearest.laneYaw + 90);
  }

  function _roadAlongYaw(wx, wy) {
    const nearest = _nearestLaneProjection(wx, wy);
    return nearest ? Math.round(nearest.laneYaw) : 0;
  }

  /** `wz`, when given, makes the distance 3-D — what CARLA's get_waypoint()
   * does, and the only way to tell a deck from the street under it. Placement
   * height deliberately stays 2-D (see groundZAt); route projection does not. */
  function _nearestLaneProjection(wx, wy, laneTypes = null, maxDistance = Infinity, wz = null) {
    let best = null;
    for (const road of AppState.mapData?.roads || []) {
      for (const lane of road.lanes || []) {
        if (laneTypes?.size && !laneTypes.has(lane.type)) continue;
        const line = lane.directionLine || [];
        for (let i = 1; i < line.length; i++) {
          const [x0, y0, z0 = 0] = line[i - 1];
          const [x1, y1, z1 = 0] = line[i];
          const dx = x1 - x0;
          const dy = y1 - y0;
          const len2 = dx * dx + dy * dy;
          if (len2 <= 0) continue;
          const t = Math.max(0, Math.min(1, ((wx - x0) * dx + (wy - y0) * dy) / len2));
          const x = x0 + t * dx;
          const y = y0 + t * dy;
          const dist =
            wz === null || wz === undefined
              ? Math.hypot(wx - x, wy - y)
              : Math.hypot(wx - x, wy - y, wz - (z0 + t * (z1 - z0)));
          if (dist <= maxDistance && (!best || dist < best.dist)) {
            best = {
              x,
              y,
              dist,
              // Road-surface height, lerped along the same segment the position
              // came from. The `= 0` destructuring defaults keep this working
              // against 2-element points, i.e. a cached older render payload.
              z: z0 + t * (z1 - z0),
              laneYaw: (Math.atan2(dy, dx) * 180) / Math.PI,
              laneId: lane.laneId,
              laneType: lane.type,
              road,
              lane,
              segIndex: i,
            };
          }
        }
      }
    }
    return best;
  }

  /* Vehicle lane snap ─────────────────────────────────────────────────────────
   *
   * A vehicle (ego included) is placed and dragged onto the nearest driving or
   * parking lane centreline, facing that lane's travel direction; Shift places
   * or drags it freely and leaves its yaw alone. Walkers and props are never
   * snapped — they belong on kerbs and crossings.
   *
   * Placement used to snap to the nearest *spawn point* within 12 m — a
   * discrete sample, so a car could land metres from the click — and a drag did
   * not snap at all: the car kept its old yaw wherever it was dropped, across
   * lanes and onto the verge.
   *
   * Inside a junction several connectors overlap, and "nearest" flips between
   * them from one mousemove to the next. So among the lanes within
   * VEHICLE_SNAP_TIE_M of the nearest one, the one whose heading is closest to
   * `prevYaw` (the vehicle's current yaw on a drag) wins: dragging a car through
   * a junction keeps it on the connector it is already following.
   */
  const VEHICLE_SNAP_LANE_TYPES = new Set(['driving', 'parking']); // not 'bidirectional', a wall
  const VEHICLE_SNAP_MAX_DIST = 12;
  const VEHICLE_SNAP_TIE_M = 1.0;

  function _vehicleLaneSnap(wx, wy, prevYaw = null) {
    const perLane = [];
    for (const road of AppState.mapData?.roads || []) {
      for (const lane of road.lanes || []) {
        if (!VEHICLE_SNAP_LANE_TYPES.has(lane.type)) continue;
        const line = lane.directionLine || [];
        let best = null;
        for (let i = 1; i < line.length; i++) {
          const [x0, y0, z0 = 0] = line[i - 1];
          const [x1, y1, z1 = 0] = line[i];
          // Cheap reject before the projection: the segment's box, grown by
          // the snap radius, must contain the point.
          if (
            wx < Math.min(x0, x1) - VEHICLE_SNAP_MAX_DIST ||
            wx > Math.max(x0, x1) + VEHICLE_SNAP_MAX_DIST ||
            wy < Math.min(y0, y1) - VEHICLE_SNAP_MAX_DIST ||
            wy > Math.max(y0, y1) + VEHICLE_SNAP_MAX_DIST
          )
            continue;
          const dx = x1 - x0,
            dy = y1 - y0;
          const len2 = dx * dx + dy * dy;
          if (len2 <= 0) continue;
          const t = Math.max(0, Math.min(1, ((wx - x0) * dx + (wy - y0) * dy) / len2));
          const x = x0 + t * dx,
            y = y0 + t * dy;
          const dist = Math.hypot(wx - x, wy - y);
          if (dist <= VEHICLE_SNAP_MAX_DIST && (!best || dist < best.dist)) {
            best = { x, y, z: z0 + t * (z1 - z0), dist, laneYaw: (Math.atan2(dy, dx) * 180) / Math.PI };
          }
        }
        if (best) perLane.push(best);
      }
    }
    if (!perLane.length) return null;
    const nearest = Math.min(...perLane.map((c) => c.dist));
    const close = perLane.filter((c) => c.dist <= nearest + VEHICLE_SNAP_TIE_M);
    let pick = close.reduce((a, b) => (a.dist <= b.dist ? a : b));
    if (Number.isFinite(prevYaw) && close.length > 1) {
      const turn = (c) => Math.abs(_wrapDeg(c.laneYaw - prevYaw));
      pick = close.reduce((a, b) => (turn(a) <= turn(b) ? a : b));
    }
    return {
      x: Math.round(pick.x * 10) / 10,
      y: Math.round(pick.y * 10) / 10,
      z: pick.z,
      yaw: Math.round(_wrapDeg(pick.laneYaw) * 10) / 10,
    };
  }

  /* Ground height ─────────────────────────────────────────────────────────────
   *
   * Every z the editor writes is the OpenDRIVE road surface at (x, y) plus a
   * per-category clearance. A fixed z (this used to be 0.2 for actors) puts an
   * object metres under the road on any map with a gradient — Town03 road 67
   * climbs to 2.7 m and back to 0 within its own length.
   *
   * Clearance always errs HIGH. Spawning below the surface fails hard in CARLA
   * ("collision at spawn position"); spawning above it is free, because actors
   * spawn with physics and settle within a tick.
   *
   * VRUs get more than vehicles because <elevationProfile> is the *reference
   * line* surface — it models neither kerb height nor sidewalk elevation, and
   * sidewalk lanes carry no directionLine, so a pedestrian standing on a kerb
   * takes its z from the carriageway roughly 0.15 m below it. A pedestrian at
   * z=0.2 clipping geometry and failing to spawn is what this margin is for.
   *
   * Props are NOT given clearance: a <MiscObject> has no settle behaviour, and
   * the catalogue's per-prop z is already a surface-relative offset.
   */
  const SPAWN_CLEARANCE = { vehicle: 0.5, vru: 0.6, waypoint: 0.5 };
  const GROUND_Z_MAX_DIST = 60; // how far to reach for a lane to take height from

  function _clearanceFor(type) {
    return ROAD_FACING_TYPES.has(type) ? SPAWN_CLEARANCE.vru : SPAWN_CLEARANCE.vehicle;
  }

  /** Round to cm — z is derived, so it should not carry float noise into saves. */
  function _roundZ(z) {
    return Math.round(z * 100) / 100;
  }

  /* Road-surface height at (wx, wy), or 0 when nothing is within reach.
   *
   * A generous radius is safe here in a way it is not for yaw: z has no side or
   * direction semantics, so the nearest lane is always a defensible answer. */
  function groundZAt(wx, wy) {
    const near = _nearestLaneProjection(wx, wy, null, GROUND_Z_MAX_DIST);
    return near ? near.z : 0;
  }

  /* Route waypoints snap to the lane centreline ────────────────────────────
   *
   * A route waypoint is never driven to as authored: AssignRouteAction hands
   * each one to GlobalRoutePlanner, which projects it with map.get_waypoint()
   * and routes to whichever lane centre came out. So a point dropped between
   * two lanes is not "between two lanes" — it silently becomes one of them, and
   * when that is the oncoming carriageway the vehicle drives away from the
   * route and loops back to reach it (weirdLooping.xosc). Snapping at authoring
   * time makes the map show the point CARLA will actually use.
   *
   * follow_trajectory is deliberately NOT snapped: a trajectory is driven
   * literally, vertex by vertex, and its whole purpose is going where lanes do
   * not — a pedestrian crossing, a cyclist bending out, a reversing curve.
   */
  const ROUTE_SNAP_LANE_TYPES = new Set(['driving']); // CARLA's get_waypoint default; Town03's 'bidirectional' is a wall
  const ROUTE_SNAP_MAX_DIST = 25; // how far to reach for a lane to snap onto

  /**
   * A route waypoint for the click at (wx, wy): the nearest driving-lane
   * centreline point, or the raw click when no lane is within reach.
   *
   * Returns {x, y, z, snapped}. The snapped case takes its z from the same
   * lane segment the position came from, so no separate elevation lookup is
   * needed; the unsnapped case falls back to the ordinary surface query.
   */
  function _routeWaypointAt(wx, wy) {
    const near = _nearestLaneProjection(wx, wy, ROUTE_SNAP_LANE_TYPES, ROUTE_SNAP_MAX_DIST);
    if (!near) {
      const x = Math.round(wx * 10) / 10;
      const y = Math.round(wy * 10) / 10;
      return { x, y, z: _roundZ(groundZAt(x, y) + SPAWN_CLEARANCE.waypoint), snapped: false };
    }
    return {
      x: Math.round(near.x * 10) / 10,
      y: Math.round(near.y * 10) / 10,
      z: _roundZ(near.z + SPAWN_CLEARANCE.waypoint),
      snapped: true,
    };
  }

  /* Height for an object of `type` standing at (x, y): road surface plus the
   * category's clearance, or plus the catalogue offset for a prop. The single
   * entry point for anything that moves an already-placed object. */
  function _surfaceZFor(type, x, y, propBlueprint = null) {
    const base = type === 'prop' ? PropCatalog.defaultZ(propBlueprint) : _clearanceFor(type);
    return _roundZ(groundZAt(x, y) + base);
  }

  /** Find any actor (ego or NPC) that supports path drawing. */
  function _findActor(id) {
    if (AppState.ego && AppState.ego.id === id) return AppState.ego;
    return AppState.npcs.find((n) => n.id === id) || null;
  }

  function _eventPath(actor, eventId, type) {
    if (!eventId) return null;
    const ev = (actor.events || []).find((item) => item.id === eventId);
    const action = ev?.action;
    if (!action) return null;
    return type === 'route' ? action.waypoints : action.trajectory;
  }

  function _setEventPath(actor, eventId, type, points) {
    const events = (actor.events || []).map((ev) => {
      if (ev.id !== eventId) return ev;
      const action = ev.action || { type: type === 'route' ? 'assign_route' : 'follow_trajectory' };
      return {
        ...ev,
        action:
          type === 'route'
            ? { ...action, type: 'assign_route', waypoints: points }
            : { ...action, type: 'follow_trajectory', trajectory: points },
      };
    });
    // Through updateById, not `actor.events = …` directly. This used to be the
    // one scenario mutation in the app that reached neither of AppState's
    // mutators, which put it outside the undo history in the worst possible
    // way: not merely un-undoable, but *destroyed* by the next undo, because
    // the entry pushed after it described a world where the path was never
    // drawn. Undoing an unrelated rotate wiped a five-point trajectory.
    AppState.updateById(actor.id, { events });
  }

  /* One warning per drawing run, not one per click: building a path across a
   * car park would otherwise stack a toast per waypoint. */
  let _unsnappedWarned = false;
  function _warnUnsnapped() {
    if (_unsnappedWarned) return;
    _unsnappedWarned = true;
    Toast.warn(`Kein Fahrstreifen in ${ROUTE_SNAP_MAX_DIST} m — Wegpunkt nicht eingerastet`);
    setTimeout(() => {
      _unsnappedWarned = false;
    }, 4000);
  }

  ObjectsCore.define({
    svg,
    drag,
    ROAD_FACING_TYPES,
    _propYawFor,
    _roadFacingYaw,
    _roadAlongYaw,
    _nearestLaneProjection,
    _vehicleLaneSnap,
    SPAWN_CLEARANCE,
    _clearanceFor,
    _roundZ,
    groundZAt,
    _routeWaypointAt,
    _surfaceZFor,
    _findActor,
    _eventPath,
    _setEventPath,
    _warnUnsnapped,
  });
})();
