/**
 * objectsCore.js — lane projection and snapping, ground height, placement yaw, and the path accessors every part shares.
 *
 * Part of ObjectsManager; see objects.js.
 */
(() => {
  'use strict';

  window.ObjectsCore = UIUtils.sharedScope('ObjectsCore');

  const svg = MapView.svg;
  // Set by the drags, read by the click handler: the click ending a drag places nothing.
  const drag = { wasDragging: false };

  const ROAD_FACING_TYPES = new Set(['pedestrian', 'child', 'cyclist', 'bicycle']);

  /** Normalise degrees into [-180, 180). */
  function _wrapDeg(deg) {
    return ((((deg + 180) % 360) + 360) % 360) - 180;
  }

  /* A prop's placement yaw from the nearest lane's travel direction (left lanes' directionLines
   * are reversed). wx/wy is the original click, not the snapped point, so the side is known. */
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
        // Long axis along the kerb; flip so the open side (local +Y) faces the carriageway.
        const openAt = _wrapDeg(near.laneYaw + 90);
        const flip = Math.abs(_wrapDeg(openAt - toRoad)) > 90;
        return Math.round(_wrapDeg(near.laneYaw + (flip ? 180 : 0)));
      }
      default:
        return 0;
    }
  }

  function _roadFacingYaw(wx, wy) {
    // Face the nearest DRIVING lane in reach; the nearest lane of any type is often underfoot.
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

  /** With `wz` the distance is 3-D, like get_waypoint (deck vs street below); placement height stays 2-D. */
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
              // Height lerped along the same segment; the destructuring defaults allow 2-element points.
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
   * Vehicles (ego included) snap to the nearest driving/parking lane centre facing its
   * travel direction; Shift is free. Overlapping junction connectors tie-break on
   * `prevYaw`, so a drag stays on the connector it follows. */
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
          // Cheap reject: the segment's box, grown by the snap radius, must contain the point.
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
   * z = road surface + a clearance that errs HIGH: below the surface CARLA refuses the
   * spawn, above it the actor settles. VRUs get more (the profile models no kerbs);
   * props get none — the catalogue's z is their own offset. */
  const SPAWN_CLEARANCE = { vehicle: 0.5, vru: 0.6, waypoint: 0.5 };
  const GROUND_Z_MAX_DIST = 60; // how far to reach for a lane to take height from

  function _clearanceFor(type) {
    return ROAD_FACING_TYPES.has(type) ? SPAWN_CLEARANCE.vru : SPAWN_CLEARANCE.vehicle;
  }

  /** Round to cm, so derived z carries no float noise into saves. */
  function _roundZ(z) {
    return Math.round(z * 100) / 100;
  }

  /* Road-surface height at (wx, wy), or 0 out of reach. */
  function groundZAt(wx, wy) {
    const near = _nearestLaneProjection(wx, wy, null, GROUND_Z_MAX_DIST);
    return near ? near.z : 0;
  }

  /* Route waypoints snap to the lane centreline ────────────────────────────
   * The route planner projects a 'fastest' waypoint onto a lane anyway (possibly the
   * oncoming one), so the map shows the point CARLA will use. Trajectories are driven
   * literally and never snapped. */
  const ROUTE_SNAP_LANE_TYPES = new Set(['driving']); // CARLA's get_waypoint default; Town03's 'bidirectional' is a wall
  const ROUTE_SNAP_MAX_DIST = 25; // how far to reach for a lane to snap onto

  /** A route waypoint for a click: the nearest driving-lane centre, or the raw point. Returns {x, y, z, snapped}. */
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

  /* Surface height plus clearance (or a prop's catalogue offset): for anything that moves an object. */
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
    // Through updateById, so the path is in the undo history (outside it, the next undo wiped it).
    AppState.updateById(actor.id, { events });
  }

  /* One warning per drawing run, not one per click. */
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
