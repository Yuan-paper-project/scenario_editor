/**
 * generatorCorridor.js — the ego corridor, lane walks, actor/event construction and trigger timing.
 *
 * Part of the scenario generator; the design is described in scenarioGenerator.js.
 */
(() => {
  'use strict';

  const { VEHICLE_ACCEL, WAYPOINT_CLEARANCE, POST_JUNCTION_WP_M, r1, r2, DEG, _wrapDeg, _laneAt, _ctx, _focusStart } =
    GeneratorCore.shared;

  // ── Ego corridor ─────────────────────────────────────────────────────────────

  /**
   * Walk from a lane through random successors for `targetLen` m; null if it dead-ends
   * short of `minLen`. pts: [{x, y, z, d, key, junction}]; segs: [{key, L, startD, endD, s0}].
   */
  function _buildCorridor(rng, net, targetLen, minLen = targetLen * 0.75, startLane = null, startS = null) {
    if (!net.startable.length) return null;
    let L = startLane || rng.pick(net.startable);
    let s = startS ?? rng.range(2, Math.max(2.5, L.length - 15));
    // Under a focus the corridor is forced along the path walked back from the click.
    let forced = null;
    if (_ctx.focus) {
      const start = _focusStart(rng, net, targetLen);
      if (!start) return null;
      ({ L, s } = start);
      forced = start.path;
    }
    const pts = [];
    const segs = [];
    const visited = new Set();
    let total = 0;

    while (L) {
      visited.add(L.key);
      const startD = total;
      const entry = _laneAt(L, s);
      const lanePts = [{ ...entry }];
      for (let i = 0; i < L.pts.length; i++) {
        if (L.cum[i] > s + 0.05) lanePts.push(L.pts[i]);
      }
      for (const p of lanePts) {
        const last = pts[pts.length - 1];
        const step = last ? Math.hypot(p.x - last.x, p.y - last.y) : 0;
        if (last && step < 0.3) continue; // lane joins repeat their boundary vertex
        total += step;
        pts.push({ x: p.x, y: p.y, z: p.z, d: total, key: L.key, junction: L.junction });
        if (total >= targetLen) break;
      }
      segs.push({ key: L.key, L, startD, endD: total, s0: s });
      if (total >= targetLen) break;
      const next = (net.succ.get(L.key) || []).filter((k) => !visited.has(k));
      if (!next.length) break;
      const fi = forced ? forced.indexOf(L.key) : -1;
      const nextKey = fi >= 0 && fi + 1 < forced.length ? forced[fi + 1] : rng.pick(next);
      L = net.lanes.get(nextKey);
      s = 0;
    }
    if (total < minLen || pts.length < 2) return null;
    return { pts, segs, length: total };
  }

  /** Pose at corridor distance `d`. */
  function _corridorAt(c, d) {
    d = Math.max(0, Math.min(c.length, d));
    let i = 1;
    while (i < c.pts.length - 1 && c.pts[i].d < d) i++;
    const a = c.pts[i - 1],
      b = c.pts[i];
    const seg = b.d - a.d || 1;
    const t = Math.max(0, Math.min(1, (d - a.d) / seg));
    return {
      x: a.x + t * (b.x - a.x),
      y: a.y + t * (b.y - a.y),
      z: a.z + t * (b.z - a.z),
      yaw: Math.atan2(b.y - a.y, b.x - a.x) * DEG,
      key: b.key,
      junction: a.junction || b.junction,
      d,
    };
  }

  /** True when no corridor point between d0 and d1 is inside a junction. */
  function _junctionFree(c, d0, d1) {
    return !c.pts.some((p) => p.d >= d0 && p.d <= d1 && p.junction);
  }

  /** A point `off` m right of travel (negative = left); y-down, so right of +x is +y. */
  function _lateral(pose, off) {
    const rad = pose.yaw / DEG;
    return { x: pose.x - Math.sin(rad) * off, y: pose.y + Math.cos(rad) * off };
  }

  // ── Actor construction ───────────────────────────────────────────────────────

  function _routeWp(p, strategy = 'fastest') {
    return { x: r1(p.x), y: r1(p.y), z: r2(p.z + WAYPOINT_CLEARANCE), strategy };
  }

  /** Waypoints pinning the corridor from `dFrom`: one past each junction, one at the end. */
  function _corridorWaypoints(c, dFrom, dTo = c.length) {
    const wps = [];
    for (const sg of c.segs) {
      if (!sg.L.junction) continue;
      const d = sg.endD + POST_JUNCTION_WP_M;
      if (d > dFrom + 3 && d < dTo - 5) wps.push(_routeWp(_corridorAt(c, d)));
    }
    wps.push(_routeWp(_corridorAt(c, dTo - 1)));
    return wps;
  }

  function _vehicle(type, pose, initialSpeed, events = []) {
    const x = r1(pose.x),
      y = r1(pose.y);
    return {
      id: AppState.nextId(),
      type,
      x,
      y,
      z: ObjectsManager.surfaceZFor(type, x, y),
      yaw: Math.round(_wrapDeg(pose.yaw)),
      initial_speed: r1(initialSpeed),
      events,
    };
  }

  /** A conflict vehicle ignores lights and obstacles, or it would brake and defuse its own conflict. */
  function _ignoresTraffic(actor) {
    actor.obey_traffic_lights = false;
    actor.obey_obstacles = false;
    return actor;
  }

  /** An assign_route whose waypoint 0 is the actor's pose ('fastest', as the backend requires). */
  function _routeEvent(actor, waypoints, id = 'evt-1') {
    const seed = ObjectsManager.routeWaypointAt(actor.x, actor.y);
    return {
      id,
      trigger: { type: 'simulation_time', value: 0 },
      action: {
        type: 'assign_route',
        route_strategy: 'fastest',
        waypoints: [{ x: seed.x, y: seed.y, z: seed.snapped ? seed.z : actor.z, strategy: 'fastest' }, ...waypoints],
      },
    };
  }

  function _speedEvent(id, trigger, speed, dimension, value) {
    return {
      id,
      trigger,
      action: {
        type: 'set_speed',
        // 'step' + 'rate' contradict each other; the backend forces 'linear' anyway.
        dynamics: { shape: dimension === 'rate' ? 'linear' : 'step', dimension, value: r1(value) },
        target: { mode: 'absolute', value: r1(speed) },
      },
    };
  }

  const nearEgo = (value) => ({ type: 'distance_to_ego', value: r1(Math.max(4, value)) });

  /** Centre distance for a bumper `gap` to an actor of `type` ahead: distance_to_ego is centre to
   *  centre, and a follower keeps a 5 m bumper gap, so a gap-sized radius never fired. */
  function _centreDistance(gap, type) {
    return gap + (MapView.actorSize('ego').w + MapView.actorSize(type).w) / 2;
  }
  const after = (eventId) => ({ type: 'after_event', event_id: eventId });

  /** Seconds to cover `dist` from standstill, ramping at `accel` to `v`. */
  function _timeFromRest(dist, v, accel = VEHICLE_ACCEL) {
    const rampDist = (v * v) / (2 * accel);
    if (dist <= rampDist) return Math.sqrt((2 * dist) / accel);
    return v / accel + (dist - rampDist) / v;
  }

  /** Distance the ego needs to reach cruise speed, plus a margin. */
  function _egoRunUp(vEgo) {
    return (vEgo * vEgo) / (2 * VEHICLE_ACCEL) + 15;
  }

  /**
   * The distance_to_ego radius that fires `leadTime` s (at cruise) before the ego reaches
   * `dConflict`, measured from the triggering actor's spawn; null if the ego would start inside it.
   */
  function _solveTrigger(c, dConflict, leadTime, vEgo, from) {
    const dEgo = dConflict - vEgo * leadTime;
    if (dEgo < _egoRunUp(vEgo)) return null;
    const at = _corridorAt(c, dEgo);
    const radius = Math.hypot(at.x - from.x, at.y - from.y);
    const atStart = _corridorAt(c, 0);
    if (Math.hypot(atStart.x - from.x, atStart.y - from.y) <= radius + 5) return null;
    return { radius, dEgo };
  }

  const VEHICLE_MIX = [
    ['car', 6],
    ['van', 2],
    ['truck', 1],
    ['bus', 0.5],
    ['motorcycle', 1],
  ];

  /** Proper intersection of two polylines: [{x, y, sA, sB}] (first only). */
  function _polylineCrossing(A, B) {
    for (let i = 1; i < A.pts.length; i++) {
      const p = A.pts[i - 1],
        p2 = A.pts[i];
      const rx = p2.x - p.x,
        ry = p2.y - p.y;
      for (let j = 1; j < B.pts.length; j++) {
        const q = B.pts[j - 1],
          q2 = B.pts[j];
        const sx = q2.x - q.x,
          sy = q2.y - q.y;
        const den = rx * sy - ry * sx;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((q.x - p.x) * sy - (q.y - p.y) * sx) / den;
        const u = ((q.x - p.x) * ry - (q.y - p.y) * rx) / den;
        if (t < 0 || t > 1 || u < 0 || u > 1) continue;
        return {
          x: p.x + t * rx,
          y: p.y + t * ry,
          sA: A.cum[i - 1] + t * Math.hypot(rx, ry),
          sB: B.cum[j - 1] + u * Math.hypot(sx, sy),
        };
      }
    }
    return null;
  }

  /** Walk `dist` m back from lane `key` through predecessors to an ordinary lane: {L, s, walked} or null. */
  function _walkBack(rng, net, key, dist) {
    let walked = 0;
    let cur = key;
    for (let hop = 0; hop < 4; hop++) {
      const preds = (net.pred.get(cur) || []).map((k) => net.lanes.get(k)).filter(Boolean);
      if (!preds.length) return null;
      const P = rng.pick(preds);
      const need = dist - walked;
      if (P.length >= need + 2) {
        return P.junction ? null : { L: P, s: P.length - need, walked: dist };
      }
      walked += P.length;
      cur = P.key;
      // Ran out on a short road lane: its start will do, given enough run-up.
      if (!P.junction && walked >= dist * 0.6 && P.length >= 6) return { L: P, s: 1, walked: walked - 1 };
    }
    return null;
  }

  /** 'left' | 'right' | 'straight' from the heading change across a connector (left is negative, y-down). */
  function _turnKind(L) {
    const d = _wrapDeg(_laneAt(L, L.length).yaw - _laneAt(L, 0).yaw);
    return d < -45 ? 'left' : d > 45 ? 'right' : 'straight';
  }

  /** The innermost oncoming lane beside the ego's (lane 1 vs -1), or null if not innermost or one-way. */
  function _oncomingLane(net, sg) {
    const id = sg.L.lane.laneId;
    if (Math.abs(id) !== 1) return null;
    return net.lanes.get(`${sg.L.road.id}:${sg.L.lane.sectionId}:${-id}`) || null;
  }

  /** Walk `dist` m forward through successors to an ordinary lane; a junction landing carries on to
   *  POST_JUNCTION_WP_M past the exit. {L, s} or null. */
  function _walkForward(rng, net, key, s, dist) {
    let L = net.lanes.get(key);
    let left = dist;
    for (let hop = 0; L && hop < 6; hop++) {
      if (s + left <= L.length - 0.5 && !L.junction) return { L, s: s + left };
      left = Math.max(L.junction ? POST_JUNCTION_WP_M : 0, left - (L.length - s));
      const next = (net.succ.get(L.key) || []).map((k) => net.lanes.get(k)).filter(Boolean);
      if (!next.length) return null;
      L = rng.pick(next);
      s = 0;
    }
    return null;
  }

  function _distToPolyline(route, x, y) {
    let best = Infinity;
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1],
        b = route[i];
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)));
    }
    return best;
  }

  GeneratorCore.define({
    _buildCorridor,
    _corridorAt,
    _junctionFree,
    _lateral,
    _routeWp,
    _corridorWaypoints,
    _vehicle,
    _ignoresTraffic,
    _routeEvent,
    _speedEvent,
    nearEgo,
    _centreDistance,
    after,
    _timeFromRest,
    _egoRunUp,
    _solveTrigger,
    VEHICLE_MIX,
    _polylineCrossing,
    _walkBack,
    _turnKind,
    _oncomingLane,
    _walkForward,
    _distToPolyline,
  });
})();
