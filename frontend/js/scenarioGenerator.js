/**
 * scenarioGenerator.js — one-click random scenarios on the loaded map.
 *
 * Random events on their own almost never make a test: the other actor drives
 * off somewhere and never meets the ego. So nothing here is random at the
 * level of "pick an action". A generator is a SCENARIO TYPE (lead vehicle
 * brakes, cut-in, crossing pedestrian, junction cross traffic, obstacle) with
 * three parts:
 *
 *   1. a site query against the map — the lane graph's same-direction
 *      neighbours for a cut-in, crossing connector lanes for a junction
 *      conflict, the carriageway edge for a crossing pedestrian;
 *   2. parameter ranges (speeds, gaps, decelerations, timing offsets) drawn
 *      from one seeded RNG, so a seed reproduces the scenario exactly;
 *   3. timing that is relative to the EGO, never to the clock.
 *
 * Point 3 is what keeps a generated scenario meaningful when an AV under test
 * drives the ego instead of simple_vehicle_control: every NPC event starts on
 * `distance_to_ego`, with the radius solved from a target time-to-conflict, so
 * the conflict happens wherever and whenever the ego actually arrives. The ego
 * still gets an `assign_route` and a start speed, so the same file also runs
 * with the scripted controller.
 *
 * Everything starts from an ego CORRIDOR: a lane-centre polyline walked
 * forward through the lane graph from a random start, picking a random
 * successor at each fork. The ego's route waypoints are placed on the lane
 * just past each junction, which pins the turn the corridor took; the
 * computed route (Simulate.routeGeometry, i.e. what the preview and CARLA's
 * router would drive) is then checked against the corridor and the attempt is
 * thrown away if they disagree.
 *
 * Needs AppState.laneGraph, which every town has (a probed one or the
 * from-.xodr build in backend/lane_graph_builder.py).
 */
(function () {
  'use strict';

  // ── Physical constants the timing is solved against ──────────────────────────

  // simple_vehicle_control's hardcoded max_acceleration (xml_builder.py / the
  // car.xosc template). A vehicle reaches any commanded speed at this rate, so
  // the ego is NOT at its start speed on tick 1 in CARLA.
  const VEHICLE_ACCEL = 3.0;
  // Same clearance objects.js gives a waypoint: the router projects it anyway,
  // and DistanceCondition is 3-D, so a point under the road would never fire.
  const WAYPOINT_CLEARANCE = 0.5;
  // How far the computed route may stray from the corridor before the attempt
  // is rejected. A lane is ~3.5 m wide; anything past half of that is a
  // different lane or a different turn.
  const ROUTE_TOLERANCE_M = 2.0;
  // Put the route waypoint this far onto the lane after a junction. Inside the
  // junction connector lanes overlap, and a waypoint there could project onto
  // the wrong one; just past the exit the lane is unambiguous.
  const POST_JUNCTION_WP_M = 8;
  // Attempts per scenario. Most fail cheaply (no site on this corridor); the
  // expensive part, the headless preview run, only happens to the survivors.
  const MAX_ATTEMPTS = 150;

  // Lane types a pedestrian is "off the road" from. Sidewalks are not in here,
  // so the crossing start lands on the kerb rather than in a parking lane.
  const CARRIAGEWAY_TYPES = new Set([
    'driving', 'parking', 'shoulder', 'bidirectional', 'median', 'border',
    'restricted', 'biking', 'stop', 'entry', 'exit', 'onRamp', 'offRamp',
  ]);

  // ── Seeded RNG ───────────────────────────────────────────────────────────────

  /** mulberry32 — tiny, fast, and identical in every browser, which is all a
   * reproducible seed needs. */
  class Rng {
    constructor(seed) { this._s = (seed >>> 0) || 1; }
    next() {
      let t = (this._s = (this._s + 0x6D2B79F5) >>> 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    range(a, b) { return a + (b - a) * this.next(); }
    int(a, b) { return Math.floor(this.range(a, b + 1)); }
    pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
    chance(p) { return this.next() < p; }
    /** Pick from [[value, weight], ...]. */
    weighted(pairs) {
      const total = pairs.reduce((s, [, w]) => s + w, 0);
      let r = this.next() * total;
      for (const [v, w] of pairs) { if ((r -= w) < 0) return v; }
      return pairs[pairs.length - 1][0];
    }
  }

  const r1 = v => Math.round(v * 10) / 10;
  const r2 = v => Math.round(v * 100) / 100;
  const DEG = 180 / Math.PI;

  function _wrapDeg(deg) {
    return ((deg + 180) % 360 + 360) % 360 - 180;
  }

  // ── Lane network index ───────────────────────────────────────────────────────

  const _netCache = new WeakMap();   // mapData -> {graph, net}

  /**
   * Every driving lane with geometry, keyed by CARLA's (road, section, lane)
   * triple — the same join key the lane graph and simulate.js use — plus the
   * graph's successors resolved to keys and inverted into predecessors.
   */
  function _network() {
    const md = AppState.mapData;
    const graph = AppState.laneGraph;
    if (!md || !graph) return null;
    const cached = _netCache.get(md);
    if (cached && cached.graph === graph) return cached.net;

    const lanes = new Map();
    const polys = [];   // every lane polygon, for the carriageway-edge search
    for (const road of md.roads || []) {
      for (const lane of road.lanes || []) {
        if (Array.isArray(lane.polygon) && lane.polygon.length >= 3) {
          polys.push({ type: lane.type, poly: lane.polygon, bbox: _bbox(lane.polygon) });
        }
        if (lane.type !== 'driving') continue;
        const line = lane.directionLine || [];
        if (line.length < 2) continue;
        const pts = line.map(([x, y, z = 0]) => ({ x, y, z }));
        const cum = [0];
        for (let i = 1; i < pts.length; i++) {
          cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
        }
        const length = cum[cum.length - 1];
        if (length < 0.5) continue;
        const key = `${road.id}:${lane.sectionId}:${lane.laneId}`;
        lanes.set(key, {
          key, road, lane, pts, cum, length,
          junction: String(road.junction) !== '-1',
          junctionId: String(road.junction),
          record: LaneGraph.laneRecord(graph, Number(road.id), lane.sectionId, lane.laneId),
        });
      }
    }

    const refKey = ref => `${ref.roadId}:${ref.sectionId}:${ref.laneId}`;
    const succ = new Map();
    const pred = new Map();
    for (const L of lanes.values()) {
      const next = LaneGraph.realSuccessors(L.record).map(refKey).filter(k => lanes.has(k));
      succ.set(L.key, next);
      for (const k of next) {
        if (!pred.has(k)) pred.set(k, []);
        pred.get(k).push(L.key);
      }
    }

    const byJunction = new Map();
    for (const L of lanes.values()) {
      if (!L.junction) continue;
      if (!byJunction.has(L.junctionId)) byJunction.set(L.junctionId, []);
      byJunction.get(L.junctionId).push(L);
    }

    const net = {
      lanes, polys, succ, pred, byJunction, refKey,
      // Ordinary road lanes long enough to start a corridor on.
      startable: [...lanes.values()].filter(L => !L.junction && L.length >= 25),
    };
    _netCache.set(md, { graph, net });
    return net;
  }

  function _bbox(poly) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of poly) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }

  function _inPoly(poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /** Pose at arc length `s` along a lane (clamped to its ends). */
  function _laneAt(L, s) {
    s = Math.max(0, Math.min(L.length, s));
    let i = 1;
    while (i < L.cum.length - 1 && L.cum[i] < s) i++;
    const a = L.pts[i - 1], b = L.pts[i];
    const seg = L.cum[i] - L.cum[i - 1] || 1;
    const t = Math.max(0, Math.min(1, (s - L.cum[i - 1]) / seg));
    return {
      x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), z: a.z + t * (b.z - a.z),
      yaw: Math.atan2(b.y - a.y, b.x - a.x) * DEG,
    };
  }

  /** Nearest point on a lane to (x, y): {s, d, x, y, z, yaw}. */
  function _projectOnLane(L, x, y) {
    let best = null;
    for (let i = 1; i < L.pts.length; i++) {
      const a = L.pts[i - 1], b = L.pts[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      if (len2 <= 0) continue;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
      const px = a.x + t * dx, py = a.y + t * dy;
      const d = Math.hypot(x - px, y - py);
      if (!best || d < best.d) {
        best = {
          d, x: px, y: py, z: a.z + t * (b.z - a.z),
          s: L.cum[i - 1] + t * Math.sqrt(len2),
          yaw: Math.atan2(dy, dx) * DEG,
        };
      }
    }
    return best;
  }

  // ── "Generate here" focus ────────────────────────────────────────────────────

  // Set by build() for one call when the user picked a spot on the map:
  // {x, y, radius, lanes: [{L, s}]}. Every corridor then runs through one of
  // `lanes`, and a candidate is kept only when its conflict happens within
  // `radius` of the click (assess's `at`).
  let _focus = null;
  // Set by build() for one call: {key: value} the user pinned in the recipe
  // panel (already validated against PARAMS by _cleanOverrides). _p() hands
  // a pinned value back in place of the random draw.
  let _overrides = null;

  /** The random `drawn` value, unless the user pinned `key`. The draw is made
   * either way, so pinning one parameter does not shift every later draw. */
  function _p(key, drawn) {
    return _overrides && Object.prototype.hasOwnProperty.call(_overrides, key) ? _overrides[key] : drawn;
  }
  const FOCUS_RADIUS_M = 40;
  const FOCUS_LANE_REACH_M = [6, 12];   // driving lanes this close to the click; a wider retry from a kerb

  /** Driving lanes (either direction, junction connectors included) passing
   * near (x, y), each with the arc length of its nearest point. */
  function _focusLanes(net, x, y) {
    for (const reach of FOCUS_LANE_REACH_M) {
      const out = [];
      for (const L of net.lanes.values()) {
        const p = _projectOnLane(L, x, y);
        if (p && p.d <= reach) out.push({ L, s: p.s });
      }
      if (out.length) return out;
    }
    return [];
  }

  /** A corridor start `back` metres upstream of a focus lane, and the lane
   * keys from there to that lane — the path _buildCorridor is forced along. */
  function _focusStart(rng, net, targetLen) {
    const { L: F, s: sF } = rng.pick(_focus.lanes);
    // Far enough back for a run-up and the conflict's own lead-in, short
    // enough that the corridor still runs on well past the click.
    const back = rng.range(50, Math.max(60, Math.min(220, targetLen - 60)));
    const path = [F.key];
    if (!F.junction && sF >= back + 2) return { L: F, s: sF - back, path };
    let remaining = back - sF;
    let cur = F;
    for (let hop = 0; hop < 15; hop++) {
      const preds = (net.pred.get(cur.key) || [])
        .map(k => net.lanes.get(k)).filter(P => P && !path.includes(P.key));
      if (!preds.length) {
        // A dead end upstream: start at the top of what was walked, if that is
        // an ordinary lane and leaves some run-up.
        return !cur.junction && back - remaining >= 40 ? { L: cur, s: 1, path } : null;
      }
      const P = rng.pick(preds);
      path.unshift(P.key);
      if (!P.junction && P.length >= remaining + 2) return { L: P, s: P.length - remaining, path };
      remaining -= P.length;
      cur = P;
    }
    return null;
  }

  // ── Ego corridor ─────────────────────────────────────────────────────────────

  /**
   * Walk forward from a random lane through random successors until
   * `targetLen` metres are covered. Returns {pts, segs, length} or null when
   * the walk dead-ends short of `minLen`.
   *
   * pts:  [{x, y, z, d, key, junction}] — d is arc length along the corridor
   * segs: [{key, L, startD, endD, s0}]  — one per lane visited, s0 being where
   *       on that lane the corridor entered it
   */
  function _buildCorridor(rng, net, targetLen, minLen = targetLen * 0.75, startLane = null, startS = null) {
    if (!net.startable.length) return null;
    let L = startLane || rng.pick(net.startable);
    let s = startS ?? rng.range(2, Math.max(2.5, L.length - 15));
    // "Generate here": the corridor is walked BACK from a lane at the click
    // and then forced along that same path, so it passes the clicked spot. A
    // type's own start lane (a multi-lane or two-way stretch) is a bias for a
    // random draw, not a requirement — its site search runs on the corridor.
    let forced = null;
    if (_focus) {
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
      // First point is the exact entry pose, then every lane vertex past it.
      const entry = _laneAt(L, s);
      const lanePts = [{ ...entry }];
      for (let i = 0; i < L.pts.length; i++) {
        if (L.cum[i] > s + 0.05) lanePts.push(L.pts[i]);
      }
      for (const p of lanePts) {
        const last = pts[pts.length - 1];
        const step = last ? Math.hypot(p.x - last.x, p.y - last.y) : 0;
        if (last && step < 0.3) continue;   // lane joins repeat their boundary vertex
        total += step;
        pts.push({ x: p.x, y: p.y, z: p.z, d: total, key: L.key, junction: L.junction });
        if (total >= targetLen) break;
      }
      segs.push({ key: L.key, L, startD, endD: total, s0: s });
      if (total >= targetLen) break;
      const next = (net.succ.get(L.key) || []).filter(k => !visited.has(k));
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
    const a = c.pts[i - 1], b = c.pts[i];
    const seg = b.d - a.d || 1;
    const t = Math.max(0, Math.min(1, (d - a.d) / seg));
    return {
      x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), z: a.z + t * (b.z - a.z),
      yaw: Math.atan2(b.y - a.y, b.x - a.x) * DEG,
      key: b.key, junction: a.junction || b.junction, d,
    };
  }

  /** True when no corridor point between d0 and d1 is inside a junction. */
  function _junctionFree(c, d0, d1) {
    return !c.pts.some(p => p.d >= d0 && p.d <= d1 && p.junction);
  }

  /** A point `off` metres to the right of travel (negative = left). The map is
   * y-down, so heading +x has its right-hand side at +y. */
  function _lateral(pose, off) {
    const rad = pose.yaw / DEG;
    return { x: pose.x - Math.sin(rad) * off, y: pose.y + Math.cos(rad) * off };
  }

  // ── Actor construction ───────────────────────────────────────────────────────

  function _routeWp(p, strategy = 'fastest') {
    return { x: r1(p.x), y: r1(p.y), z: r2(p.z + WAYPOINT_CLEARANCE), strategy };
  }

  /** Waypoints that pin the corridor's path from `dFrom` on: one just past
   * every junction and one at the corridor's end. */
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
    const x = r1(pose.x), y = r1(pose.y);
    return {
      id: AppState.nextId(), type, x, y,
      z: ObjectsManager.surfaceZFor(type, x, y),
      yaw: Math.round(_wrapDeg(pose.yaw)),
      initial_speed: r1(initialSpeed),
      events,
    };
  }

  /** A conflict vehicle that must not defuse its own conflict: it runs reds
   * and does not brake for what is ahead (simple_vehicle_control's
   * consider_trafficlights / consider_obstacles, exported per actor). A
   * crossing car that stops for the ego's car in front of it, or at a light
   * the ego has green, is not cross traffic any more. */
  function _ignoresTraffic(actor) {
    actor.obey_traffic_lights = false;
    actor.obey_obstacles = false;
    return actor;
  }

  /** An assign_route event whose waypoint 0 is the actor's own pose — the
   * seed objects.js places and the backend requires to be 'fastest'. */
  function _routeEvent(actor, waypoints, id = 'evt-1') {
    const seed = ObjectsManager.routeWaypointAt(actor.x, actor.y);
    return {
      id,
      trigger: { type: 'simulation_time', value: 0 },
      action: {
        type: 'assign_route',
        route_strategy: 'fastest',
        waypoints: [
          { x: seed.x, y: seed.y, z: seed.snapped ? seed.z : actor.z, strategy: 'fastest' },
          ...waypoints,
        ],
      },
    };
  }

  function _speedEvent(id, trigger, speed, dimension, value) {
    return {
      id, trigger,
      action: {
        type: 'set_speed',
        // 'step' + 'rate' is self-contradictory; the backend forces 'linear'
        // for a rate event, so say so here too (same as templates.js).
        dynamics: { shape: dimension === 'rate' ? 'linear' : 'step', dimension, value: r1(value) },
        target: { mode: 'absolute', value: r1(speed) },
      },
    };
  }

  const nearEgo = value => ({ type: 'distance_to_ego', value: r1(Math.max(4, value)) });

  /** Centre-to-centre distance for a bumper-to-bumper `gap` between the ego
   * and an actor of `type` straight ahead of it. distance_to_ego is measured
   * between actor CENTRES (RelativeDistanceCondition, cartesian, freespace
   * false), while a headway is a gap. Using the gap as the radius made the
   * lead's brake unreachable: simple_vehicle_control follows at a 5 m
   * bumper gap (DEFAULT_STANDOFF_DISTANCE), ~9.5 m centre to centre for two
   * cars, so any radius below that never fired before the 60 s fallback. */
  function _centreDistance(gap, type) {
    return gap + (MapView.actorSize('ego').w + MapView.actorSize(type).w) / 2;
  }
  const after = eventId => ({ type: 'after_event', event_id: eventId });

  /** Seconds to cover `dist` from standstill, ramping at `accel` to `v`. */
  function _timeFromRest(dist, v, accel = VEHICLE_ACCEL) {
    const rampDist = v * v / (2 * accel);
    if (dist <= rampDist) return Math.sqrt(2 * dist / accel);
    return v / accel + (dist - rampDist) / v;
  }

  /** Corridor distance the ego needs before it is at cruise speed, plus a
   * margin. A conflict placed earlier than this is solved against a speed the
   * ego has not reached yet. */
  function _egoRunUp(vEgo) {
    return vEgo * vEgo / (2 * VEHICLE_ACCEL) + 15;
  }

  /**
   * The distance_to_ego radius that puts the ego `leadTime` seconds (at cruise
   * speed) before corridor distance `dConflict` when it fires, measured from
   * the triggering actor's spawn — RelativeDistanceCondition is plain
   * cartesian distance between the two actors. Returns null when the ego
   * would already be inside the radius at spawn (the event would fire on tick
   * 1 and the timing would be meaningless).
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

  // ── Scenario types ───────────────────────────────────────────────────────────

  const VEHICLE_MIX = [['car', 6], ['van', 2], ['truck', 1], ['bus', 0.5], ['motorcycle', 1]];

  /* Lead vehicle brakes. A slower car ahead in the ego's own lane, following
   * the same route, brakes hard when the ego has closed to a time headway. */
  function _leadBrake(rng, net, vEgo) {
    const c = _buildCorridor(rng, net, rng.range(260, 360));
    if (!c) return null;
    // Time headway (bumper gap / ego speed) at which the lead brakes. 1-3 s
    // brackets the usual ACC settings; an ego following at a longer headway
    // than this never closes in, and the brake waits for the 60 s fallback.
    const thw = _p('brake_headway_s', rng.range(1.0, 3.0));
    const type = _p('lead_type', rng.weighted(VEHICLE_MIX));
    const trigger = _centreDistance(Math.max(6, thw * vEgo), type);
    const gap0 = trigger + rng.range(15, 35);   // initial gap, ego closes from behind
    if (!_junctionFree(c, gap0 - 6, gap0 + 6)) return null;
    const pose = _corridorAt(c, gap0);
    // A lead at or above the ego's speed is never caught: cap an override.
    const vLead = Math.min(_p('lead_speed', vEgo * rng.range(0.55, 0.8)), vEgo * 0.9);
    const decel = _p('decel', rng.range(2.5, 8));
    // Each draw is made whether or not it is overridden, so the RNG sequence
    // (and with it the site a seed lands on) does not depend on the overrides.
    const stopDraw = rng.chance(0.7);
    const vEnd = _p('end_speed', stopDraw ? 0 : rng.range(1.5, 4));
    const stopFully = vEnd === 0;
    const hold = _p('hold_s', rng.range(3, 8));

    const lead = _vehicle(type, pose, vLead);
    // The lights on the corridor are forced green by the EGO's approach
    // (_greenWave), and the lead reaches each one first — waiting at a red the
    // ego has not yet switched would park it there and fire its brake trigger
    // early. So it drives through; there is no cross traffic to meet.
    lead.obey_traffic_lights = false;
    const events = [
      _routeEvent(lead, _corridorWaypoints(c, gap0)),
      _speedEvent('evt-2', nearEgo(trigger), vEnd, 'rate', decel),
      _speedEvent('evt-3', after('evt-2'), vEnd, 'time', hold),
    ];
    // A full stop that never drives off blocks the ego's lane for the rest of
    // the run (measured in CARLA: the scripted ego covered 45 m and waited out
    // the 60 s stop trigger), so most full stops pull away again.
    const resume = _p('resumes', rng.chance(stopFully ? 0.75 : 0.4));
    if (resume) events.push(_speedEvent('evt-4', after('evt-3'), vLead, 'rate', 2.5));
    lead.events = events;
    // Where the ego catches up: it closes at vEgo - vLead from gap0 to the trigger.
    const dCatch = gap0 + vLead * (gap0 - trigger) / (vEgo - vLead);
    return {
      corridor: c, npcs: [lead], props: [],
      conflictD: dCatch + 30,
      egoEndD: c.length - 60,
      params: {
        lead_type: type, initial_gap_m: r1(gap0), lead_speed: r1(vLead),
        brake_headway_s: r2(thw), trigger_m: r1(trigger), decel: r1(decel),
        end_speed: r1(vEnd), hold_s: r1(hold), resumes: resume,
      },
      routedNpcs: [{ actor: lead, corridorFrom: gap0 }],
    };
  }

  /* Cut-in. A slower car in a same-direction neighbour lane, ahead of the ego,
   * changes into the ego's lane once the ego has closed in on it. */
  function _cutIn(rng, net, vEgo) {
    // Start on a lane that has a neighbour to cut in from, near enough its
    // beginning that the NPC fits ahead of the ego on the same stretch. A
    // uniformly random start finds one only on multi-lane towns, and rarely.
    if (!net.multiLane) {
      net.multiLane = net.startable.filter(L => L.length >= 90 && ['left', 'right'].some(side => {
        const ref = L.record && L.record[side];
        const N = ref && net.lanes.get(net.refKey(ref));
        return N && !N.junction;
      }));
    }
    if (!net.multiLane.length) return null;
    const start = rng.pick(net.multiLane);
    const c = _buildCorridor(rng, net, rng.range(220, 320), undefined,
                             start, rng.range(0, Math.max(0.5, start.length - 90)));
    if (!c) return null;
    // A lane on the corridor that has a same-direction driving neighbour —
    // the lane graph's left/right are exactly that (get_left_lane() /
    // get_right_lane() ground truth), which is the only legal lane-change
    // target ChangeActorLateralMotion can reach.
    const candidates = [];
    for (const sg of c.segs) {
      if (sg.L.junction || !sg.L.record) continue;
      for (const side of ['left', 'right']) {
        const ref = sg.L.record[side];
        const N = ref && net.lanes.get(net.refKey(ref));
        if (N && !N.junction) candidates.push({ sg, N, egoSide: side });
      }
    }
    if (!candidates.length) return null;
    const { sg, N, egoSide } = rng.pick(candidates);

    // A clear speed difference and a short initial gap, so the ego closes in
    // within one multi-lane stretch (Town10HD's are ~90-130 m long).
    const vNpc = Math.min(_p('npc_speed', vEgo * rng.range(0.45, 0.7)), vEgo * 0.9);
    const lcDist = _p('lane_change_m', rng.range(10, 22));   // lateral move spread over this many metres
    const trigger = _p('trigger_m', rng.range(8, 26));       // cut in when the ego is this close
    // The NPC spawns beside corridor distance dNpc, i.e. dNpc ahead of the ego,
    // somewhere in this lane visit and far enough ahead that the ego has to
    // close in before the trigger fires.
    const lo = Math.max(sg.startD + 3, trigger + 8);
    const hi = Math.min(sg.endD - 5, trigger + 35);
    if (lo > hi) return null;
    const dNpc = rng.range(lo, hi);
    const gap0 = dNpc;
    const tTrigger = (gap0 - trigger) / (vEgo - vNpc);
    // Corridor distance at which the lateral move is done. It has to happen on
    // N before N ends, and land in the ego's lane before THAT ends:
    // ChangeActorLateralMotion only succeeds after 10 m driven in the target
    // lane, and never fails otherwise, so a change that runs out of lane hangs
    // the run (CLAUDE.md, CARLA behavioural tests).
    const npcTravel = vNpc * tTrigger + lcDist;
    if (dNpc + npcTravel + 20 > sg.endD) return null;
    const egoPose = _corridorAt(c, dNpc);
    const onN = _projectOnLane(N, egoPose.x, egoPose.y);
    if (!onN || onN.d > 6 || onN.s + npcTravel + 15 > N.length) return null;
    // The NPC changes TOWARD the ego lane: N is on the ego's `egoSide`, so the
    // ego lane is on N's opposite side — and the graph must agree.
    const npcDir = egoSide === 'left' ? 'right' : 'left';
    const back = N.record && N.record[npcDir];
    if (!back || net.refKey(back) !== sg.key) return null;

    const type = _p('npc_type', rng.weighted(VEHICLE_MIX.filter(([t]) => t !== 'bus')));
    const npc = _vehicle(type, onN, vNpc);
    const events = [{
      id: 'evt-1',
      trigger: nearEgo(trigger),
      action: { type: 'lane_change', direction: npcDir, dynamics: { shape: 'linear', value: r1(lcDist) } },
    }];
    const brakesAfter = _p('brakes_after', rng.chance(0.4));
    if (brakesAfter) events.push(_speedEvent('evt-2', after('evt-1'), vNpc * rng.range(0.3, 0.7), 'rate', rng.range(2, 5)));
    npc.events = events;
    return {
      corridor: c, npcs: [npc], props: [],
      conflictD: dNpc + npcTravel + 20,
      params: {
        npc_type: type, from_side: egoSide, npc_speed: r1(vNpc), initial_gap_m: r1(gap0),
        trigger_m: r1(trigger), lane_change_m: r1(lcDist), brakes_after: brakesAfter,
      },
      routedNpcs: [],
    };
  }

  /** Lateral offsets (right positive) at which a line across the road at
   * `pose` leaves the carriageway on each side — or null where it does not
   * within `maxM`. */
  function _carriagewayEdges(net, pose, maxM = 25) {
    const near = net.polys.filter(p => CARRIAGEWAY_TYPES.has(p.type)
      && p.bbox.minX - maxM <= pose.x && p.bbox.maxX + maxM >= pose.x
      && p.bbox.minY - maxM <= pose.y && p.bbox.maxY + maxM >= pose.y);
    const onRoad = off => {
      const q = _lateral(pose, off);
      return near.some(p => q.x >= p.bbox.minX && q.x <= p.bbox.maxX
        && q.y >= p.bbox.minY && q.y <= p.bbox.maxY && _inPoly(p.poly, q.x, q.y));
    };
    const edge = sign => {
      for (let t = 0.25; t <= maxM; t += 0.25) if (!onRoad(sign * t)) return sign * t;
      return null;
    };
    return { right: edge(1), left: edge(-1) };
  }

  // Sidewalk only. A shoulder or parking lane looks walkable but on Town04's
  // highways the shoulder ends at a guardrail, and CARLA refused a pedestrian
  // spawned against it; nobody crosses a road from there anyway.
  const WALKABLE_TYPES = new Set(['sidewalk']);
  const KERB_ALLOWANCE = 0.4;   // extra spawn height for an actor starting off the carriageway
  function _onWalkable(net, q) {
    return net.polys.some(p => WALKABLE_TYPES.has(p.type)
      && q.x >= p.bbox.minX && q.x <= p.bbox.maxX && q.y >= p.bbox.minY && q.y <= p.bbox.maxY
      && _inPoly(p.poly, q.x, q.y));
  }

  const VRU_PROFILES = {
    pedestrian: { speed: [1.2, 2.6], maxCross: 22 },   // strolling to hurrying
    child:      { speed: [1.6, 4.0], maxCross: 22 },   // up to a sprint
    cyclist:    { speed: [3.0, 5.5], maxCross: 30 },
  };

  /* Crossing VRU. A pedestrian, child or cyclist crosses the ego's lane,
   * released so that it enters the ego's path a chosen time before or after
   * the ego reaches it. Pedestrians may step out from behind a parked
   * vehicle. */
  function _vruCrossing(rng, net, vEgo) {
    const c = _buildCorridor(rng, net, rng.range(160, 260));
    if (!c) return null;
    const type = _p('vru_type', rng.weighted([['pedestrian', 5], ['child', 2.5], ['cyclist', 2.5]]));
    const prof = VRU_PROFILES[type];
    const v = _p('speed', rng.range(...prof.speed));
    const dMin = _egoRunUp(vEgo) + vEgo * 4;

    // Prefer a painted crosswalk on the corridor; otherwise anywhere straight.
    let dConflict = null;
    const crosswalks = (AppState.mapData.crosswalks || []).map(cw => {
      let best = null;
      for (const p of c.pts) {
        const dd = Math.hypot(p.x - cw.x, p.y - cw.y);
        if (dd < 6 && (!best || dd < best.dd)) best = { dd, d: p.d };
      }
      return best;
    }).filter(b => b && b.d > dMin && b.d < c.length - 20);
    const onCrosswalk = crosswalks.length > 0 && rng.chance(0.6);
    if (onCrosswalk) dConflict = rng.pick(crosswalks).d;
    else dConflict = rng.range(dMin, c.length - 20);
    // The crossing runs perpendicular to the corridor, which only means
    // "across the road" on a straight lane — inside a junction connector the
    // corridor is turning and the line would cut the corner diagonally.
    const clearance = onCrosswalk ? 3 : 12;
    if (!_junctionFree(c, dConflict - clearance, dConflict + clearance)) return null;

    const pose = _corridorAt(c, dConflict);
    const edges = _carriagewayEdges(net, pose);
    if (edges.right === null || edges.left === null) return null;
    const fromRight = _p('from', rng.chance(0.65) ? 'right' : 'left') === 'right';
    // Start and finish on something walkable just past the carriageway edge.
    // "Past the edge" alone is not enough: on Town10HD it was a building
    // wall, CARLA refused to spawn the cyclist there, and the whole run
    // failed with "Unable to add actors".
    const kerbOff = edgeOff => {
      const sign = Math.sign(edgeOff);
      for (const k of [1.2, 0.8, 1.6, 0.5, 2.0]) {
        if (!_onWalkable(net, _lateral(pose, edgeOff + sign * k))) continue;
        // A cyclist starts at the road edge, not on the sidewalk: it is a 1.8 m
        // <Vehicle> set across the road, and from 1.2 m onto a narrow sidewalk
        // its back end reached the wall behind it — CARLA refused 3 of 160
        // crossing cyclists that way (tests/probe_generated_spawns.py). The
        // sidewalk is still required: without it the site was a guardrailed
        // Town07 bridge, where the guardrail refused the spawn instead.
        return type === 'cyclist' ? edgeOff - sign * 0.8 : edgeOff + sign * k;
      }
      return null;
    };
    const startOff = kerbOff(fromRight ? edges.right : edges.left);
    const endOff = kerbOff(fromRight ? edges.left : edges.right);
    if (startOff === null || endOff === null) return null;
    const crossLen = Math.abs(endOff - startOff);
    if (crossLen > prof.maxCross) return null;
    const start = _lateral(pose, startOff);
    const end = _lateral(pose, endOff);
    const kerbEdge = _lateral(pose, fromRight ? edges.right : edges.left);

    // dt > 0: the VRU is already in the lane when the ego arrives (must brake);
    // dt < 0: the ego arrives first and the VRU steps out just behind/in front.
    const tVru = Math.abs(startOff) / v;
    // A walker clears a 2 m-wide car's path in ~1.3 s, so an offset much past
    // +0.8 s is mostly a near miss rather than a conflict.
    const dt = _p('arrival_offset_s', rng.range(-0.5, 0.8));
    const sol = _solveTrigger(c, dConflict, tVru + dt, vEgo, start);
    if (!sol) return null;

    const sx = r1(start.x), sy = r1(start.y), ex = r1(end.x), ey = r1(end.y);
    const heading = Math.atan2(ey - sy, ex - sx) * DEG;
    const vru = {
      id: AppState.nextId(), type, x: sx, y: sy,
      // The start is on the sidewalk, which the elevation profile does not
      // model: Town02's is 0.32 m above the road there, the walker's capsule
      // reached into it at the editor's usual 0.6 m and CARLA refused the
      // spawn (tests/probe_generated_spawns.py). High is free — it settles.
      // Height from the corridor at the crossing, not from the nearest lane:
      // next to an overpass the nearest lane is the wrong level (a cyclist on
      // Town03 came out at z 5.8 and could not spawn).
      z: r2(pose.z + 0.6 + KERB_ALLOWANCE),
      yaw: Math.round(heading),
      initial_speed: 0,
      events: [],
    };
    // follow_trajectory, not set_speed: a cyclist is a <Vehicle>, and
    // SimpleVehicleControl ignores heading and lane-follows, so a set_speed
    // cyclist rides along the road instead of across it (CLAUDE.md).
    const vertex = (x, y) => ({ x, y, z: r2(pose.z + WAYPOINT_CLEARANCE), velocity: r1(v) });
    vru.events = [
      {
        id: 'evt-1', trigger: nearEgo(sol.radius),
        action: { type: 'follow_trajectory', trajectory: [vertex(sx, sy), vertex(ex, ey)] },
      },
    ];
    // A walker that stops dead in the ego's lane, then carries on. A set_speed
    // changes only the target speed; the trajectory's waypoints keep running
    // underneath it, so speed 0 then speed v resumes the same path (measured
    // in CARLA: stopped 3 s at mid-road, then walked on to the far kerb). The
    // stop is triggered by the walker reaching the ego lane's centre itself —
    // distance_to_point on its own entity. 1.5 m because the condition is 3-D
    // and the walker's centre sits ~0.9 m above the point.
    const isWalker = MapView.isWalkerType(type);
    const hesitDraw = isWalker && rng.chance(0.3);
    const holdDraw = hesitDraw ? rng.range(1.5, 4) : 0;
    let hold = isWalker ? _p('stops_in_lane_s', holdDraw) : 0;
    const hesitates = hold > 0;
    if (!hesitates) hold = null;
    if (hesitates) {
      vru.events.push(
        {
          id: 'evt-2',
          trigger: { type: 'distance_to_point', value: 1.5, entity_ref: vru.id,
                     point: { name: 'Point 1', x: r1(pose.x), y: r1(pose.y), z: r2(pose.z + WAYPOINT_CLEARANCE) } },
          action: { type: 'set_speed', dynamics: { shape: 'step', dimension: 'time', value: r1(hold) },
                    target: { mode: 'absolute', value: 0 } },
        },
        _speedEvent('evt-3', after('evt-2'), v, 'time', 20),
      );
    }
    vru.events.push(_speedEvent(hesitates ? 'evt-4' : 'evt-2', after('evt-1'), 0, 'time', 5));

    // Occluder: a parked van or truck just upstream on the VRU's side, so the
    // VRU is hidden until it steps out. Only where there is a parking lane to
    // stand it in: a shoulder is often under a metre wide, and a van centred
    // on one sticks into the ego's lane.
    const npcs = [vru];
    const sceneryIds = new Set();
    let occluded = false;
    const occDraw = type !== 'cyclist' && rng.chance(0.5);
    if (type !== 'cyclist' && _p('occluded', occDraw)) {
      const upstream = _corridorAt(c, dConflict - rng.range(5, 9));
      const edgeOff = fromRight ? edges.right : edges.left;
      const probe = _lateral(upstream, edgeOff - Math.sign(edgeOff) * 1.5);
      const lane = ObjectsManager.nearestLaneProjection(probe.x, probe.y, new Set(['parking']), 2.5);
      if (lane) {
        const occType = rng.weighted([['van', 3], ['truck', 1], ['car', 1]]);
        const occ = _vehicle(occType, { x: lane.x, y: lane.y, yaw: upstream.yaw }, 0);
        npcs.push(occ);
        sceneryIds.add(occ.id);
        occluded = true;
      }
    }
    return {
      corridor: c, npcs, props: [],
      conflictD: dConflict,
      params: {
        vru_type: type, speed: r1(v), from: fromRight ? 'right' : 'left', crossing_m: r1(crossLen),
        on_crosswalk: onCrosswalk, arrival_offset_s: r2(dt), trigger_m: r1(sol.radius), occluded,
        stops_in_lane_s: hold && r1(hold),
      },
      routedNpcs: [],
      sceneryIds,
      onsets: new Map([[vru.id, kerbEdge]]),
    };
  }

  /** Proper intersection of two polylines: [{x, y, sA, sB}] (first only). */
  function _polylineCrossing(A, B) {
    for (let i = 1; i < A.pts.length; i++) {
      const p = A.pts[i - 1], p2 = A.pts[i];
      const rx = p2.x - p.x, ry = p2.y - p.y;
      for (let j = 1; j < B.pts.length; j++) {
        const q = B.pts[j - 1], q2 = B.pts[j];
        const sx = q2.x - q.x, sy = q2.y - q.y;
        const den = rx * sy - ry * sx;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((q.x - p.x) * sy - (q.y - p.y) * sx) / den;
        const u = ((q.x - p.x) * ry - (q.y - p.y) * rx) / den;
        if (t < 0 || t > 1 || u < 0 || u > 1) continue;
        return {
          x: p.x + t * rx, y: p.y + t * ry,
          sA: A.cum[i - 1] + t * Math.hypot(rx, ry),
          sB: B.cum[j - 1] + u * Math.hypot(sx, sy),
        };
      }
    }
    return null;
  }

  // ── Traffic lights: a green wave for the ego ─────────────────────────────────
  //
  // The ego obeys reds, and a four-way cycle holds one for up to ~40 s: in
  // CARLA the ego sat 44 s at a red and reached the crossing pedestrian only as
  // every Act's 60 s stop trigger ended the run. The preview models no lights,
  // so it predicted a clean conflict. An AV under test waits there too.
  //
  // So every light the ego meets before the conflict is forced GREEN as it
  // approaches, with the editor's own signal events (a Schaltung: ego within N m
  // of the pole -> state). The light governing a connector lane comes straight
  // from the .xodr — each junction connector carries a <signalReference> to
  // exactly one light (map_renderer._extract_traffic_lights, `roads`).
  //
  // One forced state is not enough: TrafficLightStateSetter is a bare
  // set_state, and the light's group controller overwrites it at its next
  // phase change (a forced red lasted ~13 s in a Town05 run). simple_vehicle_
  // control stops only for RED and only inside the light's trigger volume, just
  // before the stop line — so the green is re-asserted at several distances,
  // the last a few metres short of the line, leaving no window for a phase
  // change to catch the ego there.
  const GREEN_WAVE_BEFORE_M = [55, 38, 24, 13, 5];

  /** Lights by the connector road they govern (CARLA lights only). */
  function _lightIndex(net) {
    if (net.lightByRoad) return net.lightByRoad;
    net.lightByRoad = new Map();
    for (const tl of AppState.mapData.trafficLights || []) {
      if (tl.inCarla === false) continue;
      for (const roadId of tl.roads || []) net.lightByRoad.set(String(roadId), tl);
    }
    return net.lightByRoad;
  }

  /** The lights an actor entering junction lane J has to obey: the one on J's
   * own road, plus any on a connector sharing J's entry point. A light's
   * trigger volume covers the approach lane, so a turn that is not itself
   * referenced still stops at its neighbour's red. */
  function _lightsFor(net, J) {
    const idx = _lightIndex(net);
    const entry = _laneAt(J, 0);
    const out = new Map();
    for (const C of net.byJunction.get(J.junctionId) || [J]) {
      const e = _laneAt(C, 0);
      if (C.key !== J.key && Math.hypot(e.x - entry.x, e.y - entry.y) > 2) continue;
      const tl = idx.get(String(C.road.id));
      if (tl) out.set(tl.id, tl);
    }
    return [...out.values()];
  }

  /** Does any light govern junction `junctionId` at all? */
  function _junctionSignalized(net, junctionId) {
    const idx = _lightIndex(net);
    return (net.byJunction.get(junctionId) || []).some(C => idx.has(String(C.road.id)));
  }

  /** trafficSignals entries forcing every light on the corridor before
   * `dLimit` green as the ego approaches. Each Schaltung's radius is the 3-D
   * distance from the pole (at road height, z from the map) to the corridor
   * point that many metres before the stop line: ReachPositionCondition is a
   * plain location.distance(). */
  function _greenWave(net, c, dLimit) {
    const signals = new Map();
    for (const sg of c.segs) {
      if (!sg.L.junction || sg.startD >= dLimit) continue;
      for (const tl of _lightsFor(net, sg.L)) {
        const sig = signals.get(tl.id)
          || { id: tl.id, x: tl.x, y: tl.y, z: tl.z ?? 0, events: [] };
        for (const back of GREEN_WAVE_BEFORE_M) {
          const d = sg.startD - back;
          if (d < 0) continue;
          const p = _corridorAt(c, d);
          const r = Math.hypot(p.x - tl.x, p.y - tl.y, p.z - (tl.z ?? 0));
          sig.events.push({
            id: `traffic-event-${sig.events.length + 1}`,
            state: 'green',
            trigger_distance: r1(r + 0.3),
          });
        }
        // An entry at the very start of the corridor gets at least one.
        if (!sig.events.length) {
          sig.events.push({ id: 'traffic-event-1', state: 'green', trigger_distance: 1000 });
        }
        signals.set(tl.id, sig);
      }
    }
    return [...signals.values()];
  }

  /** Walk `dist` metres back from the start of lane `key` through
   * predecessors, ending on an ordinary road lane. Returns {L, s, walked} or
   * null. */
  function _walkBack(rng, net, key, dist) {
    let walked = 0;
    let cur = key;
    for (let hop = 0; hop < 4; hop++) {
      const preds = (net.pred.get(cur) || []).map(k => net.lanes.get(k)).filter(Boolean);
      if (!preds.length) return null;
      const P = rng.pick(preds);
      const need = dist - walked;
      if (P.length >= need + 2) {
        return P.junction ? null : { L: P, s: P.length - need, walked: dist };
      }
      walked += P.length;
      cur = P.key;
      // Ran out on a short road lane: spawning at its start is fine as long
      // as there is a usable run-up.
      if (!P.junction && walked >= dist * 0.6 && P.length >= 6) return { L: P, s: 1, walked: walked - 1 };
    }
    return null;
  }

  /* Junction cross traffic. The ego's corridor crosses a junction; another
   * vehicle approaches on a connector that crosses the ego's, released so both
   * reach the crossing point at about the same time. The NPC ignores lights
   * and obstacles (_ignoresTraffic), so it neither waits at a red nor brakes
   * for the ego crossing in front of it; the ego's own light is forced green
   * by build() (_greenWave), so at a signalized junction a perpendicular
   * conflict is a red-light runner. */
  function _junctionConflict(rng, net, vEgo) {
    const c = _buildCorridor(rng, net, rng.range(200, 300));
    if (!c) return null;
    const dMin = _egoRunUp(vEgo) + vEgo * 3;
    const juncSegs = c.segs.filter(sg => sg.L.junction && sg.startD > dMin && sg.endD < c.length - 15);
    if (!juncSegs.length) return null;
    const sg = rng.pick(juncSegs);
    const J = sg.L;
    const jStart = _laneAt(J, 0);

    const options = [];
    for (const C of net.byJunction.get(J.junctionId) || []) {
      if (C.key === J.key) continue;
      const X = _polylineCrossing(J, C);
      if (!X || X.sA < 1 || X.sA > J.length - 1 || X.sB < 1 || X.sB > C.length - 1) continue;
      const cStart = _laneAt(C, 0);
      if (Math.hypot(cStart.x - jStart.x, cStart.y - jStart.y) < 3) continue;   // same approach
      const approachDiff = Math.abs(_wrapDeg(cStart.yaw - jStart.yaw));
      if (approachDiff < 30) continue;
      options.push({ C, X, oncoming: approachDiff >= 150 });
    }
    if (!options.length) return null;
    const { C, X, oncoming } = rng.pick(options);
    // At a signalized junction the ego gets a forced green (_greenWave) and
    // the NPC ignores lights, so a perpendicular conflict there is a
    // red-light runner — a real case, not an artefact.
    const signalized = _junctionSignalized(net, J.junctionId);

    // From "waiting at the line, pulls out" (6 m) to "approaching from well
    // back" (55 m): the shorter the run-up, the less warning the ego gets.
    const back = _walkBack(rng, net, C.key, rng.range(6, 55));
    if (!back) return null;
    const npcPose = _laneAt(back.L, back.s);
    const vNpc = _p('npc_speed', rng.range(7, 13));
    const npcToX = back.walked + X.sB;
    const tNpc = _timeFromRest(npcToX, vNpc);
    const dt = _p('arrival_offset_s', rng.range(-0.6, 0.8));   // ego arrives this much after the NPC
    const dX = sg.startD + X.sA;
    const sol = _solveTrigger(c, dX, tNpc + dt, vEgo, npcPose);
    if (!sol) return null;

    // Route: past the junction onto C's successor, so A* reproduces C.
    const exitKey = (net.succ.get(C.key) || [])[0];
    const exitL = exitKey && net.lanes.get(exitKey);
    if (!exitL) return null;
    const exitS = Math.min(POST_JUNCTION_WP_M, exitL.length - 0.5);
    const exitPose = _laneAt(exitL, exitS);
    // ...and well on past it. The route's end is where SimpleVehicleControl
    // stops dead (_reached_goal), and right after the exit is often the road
    // the ego turns onto: measured in CARLA (Town03 junction 238) the NPC
    // parked 5 m past the junction, the ego stopped 8.7 m behind it and sat
    // there until every Act's 60 s stop trigger, its own route never complete.
    const runOn = _walkForward(rng, net, exitL.key, exitS, rng.range(60, 90));
    const runOnPose = runOn && _laneAt(runOn.L, runOn.s);
    // ...unless "on past it" is the ego's own road. An NPC that turns into the
    // ego's lane runs ahead of it, and 60–90 m on it parks on the ego's route:
    // measured in CARLA (Town03 junction 655, seed 24) the scripted ego stopped
    // 5.3 m behind it and waited out the 60 s stop trigger. Then it follows the
    // corridor to its end and the ego's route ends 60 m short of that, as with
    // the lead car; a run-on that merges into the ego's path later is refused.
    let npcWps = runOnPose ? [_routeWp(exitPose), _routeWp(runOnPose)] : [_routeWp(exitPose)];
    let egoEndD;
    const endPose = runOnPose || exitPose;   // the walk can dead-end: then the route stops at the exit
    const pastJ = c.pts.filter(p => p.d > sg.endD);
    if (pastJ.length > 1 && _distToPolyline(pastJ, endPose.x, endPose.y) < 2.5) {
      const joinSeg = c.segs.find(s2 => s2.L.key === exitL.key && s2.startD >= sg.endD - 1);
      if (!joinSeg || c.length - 60 < dX + 30) return null;
      npcWps = [_routeWp(exitPose), ..._corridorWaypoints(c, joinSeg.startD + exitS)];
      egoEndD = c.length - 60;
    }

    const type = _p('npc_type', rng.weighted([['car', 6], ['van', 2], ['truck', 1], ['motorcycle', 1], ['police', 0.5], ['ambulance', 0.5]]));
    const npc = _vehicle(type, npcPose, 0);
    _ignoresTraffic(npc);
    npc.events = [
      _routeEvent(npc, npcWps),
      // A rate ramp at the controller's own acceleration, so the preview's
      // timing and CARLA's agree (a 'time' step is instant in the preview but
      // ramps at 3 m/s² in CARLA).
      _speedEvent('evt-2', nearEgo(sol.radius), vNpc, 'rate', VEHICLE_ACCEL),
    ];
    return {
      corridor: c, npcs: [npc], props: [],
      conflictD: dX,
      egoEndD,
      params: {
        npc_type: type, junction: J.junctionId, signalized, oncoming,
        npc_speed: r1(vNpc), npc_run_up_m: r1(npcToX), arrival_offset_s: r2(dt), trigger_m: r1(sol.radius),
      },
      routedNpcs: [{ actor: npc, passes: X }],
      onsets: new Map([[npc.id, _laneAt(C, 0)]]),
    };
  }

  const CARGO_PROPS = ['static.prop.box01', 'static.prop.box02', 'static.prop.box03',
    'static.prop.travelcase', 'static.prop.briefcase', 'static.prop.guitarcase',
    'static.prop.creasedbox01', 'static.prop.creasedbox02', 'static.prop.haybalelb'];
  const CONE_PROPS = ['static.prop.trafficcone01', 'static.prop.constructioncone'];

  function _prop(blueprint, x, y, yaw) {
    if (!PropCatalog.get(blueprint)) return null;
    const px = r1(x), py = r1(y);
    return {
      id: AppState.nextId(), type: 'prop', prop: blueprint, x: px, y: py,
      z: ObjectsManager.surfaceZFor('prop', px, py, blueprint),
      yaw: Math.round(_wrapDeg(yaw)),
    };
  }

  /* Obstacle in the lane: lost cargo, a work-zone taper narrowing the lane,
   * or a broken-down vehicle with a warning triangle. Static, so it needs no
   * trigger at all. */
  function _obstacle(rng, net, vEgo) {
    const c = _buildCorridor(rng, net, rng.range(180, 280));
    if (!c) return null;
    const dObs = rng.range(_egoRunUp(vEgo) + 25, c.length - 30);
    if (!_junctionFree(c, dObs - 30, dObs + 15)) return null;
    const pose = _corridorAt(c, dObs);
    const variant = _p('variant', rng.weighted([['cargo', 1], ['workzone', 1], ['breakdown', 1]]));
    // which edge of the lane it sits toward
    const side = _p('side', rng.chance(0.7) ? 'right' : 'left') === 'right' ? 1 : -1;
    const props = [];
    const npcs = [];
    const params = { variant };

    if (variant === 'cargo') {
      const n = rng.int(2, 5);
      for (let i = 0; i < n; i++) {
        const at = _lateral(_corridorAt(c, dObs + rng.range(-4, 4)), rng.range(-1.3, 1.3));
        const p = _prop(rng.pick(CARGO_PROPS), at.x, at.y, rng.range(-180, 180));
        if (p) props.push(p);
      }
      params.items = props.length;
    } else if (variant === 'workzone') {
      // Cones run diagonally from the lane edge to `intrusion` metres into the
      // lane over the taper length, then hold, with a sign at the head.
      const taper = rng.range(12, 24);
      const intrusion = rng.range(0.8, 2.2);
      const cone = rng.pick(CONE_PROPS);
      const nCones = rng.int(5, 8);
      for (let i = 0; i < nCones; i++) {
        const f = i / (nCones - 1);
        const d = dObs - taper + f * (taper + 6);
        const off = side * (1.75 - Math.min(1, d < dObs ? (d - (dObs - taper)) / taper : 1) * intrusion);
        const at = _lateral(_corridorAt(c, d), off);
        const p = _prop(cone, at.x, at.y, 0);
        if (p) props.push(p);
      }
      const signAt = _lateral(_corridorAt(c, dObs - taper - 4), side * 1.6);
      const sign = _prop('static.prop.warningconstruction', signAt.x, signAt.y, pose.yaw + 180);
      if (sign) props.push(sign);
      Object.assign(params, { taper_m: r1(taper), intrusion_m: r1(intrusion), cones: nCones });
    } else {
      const off = side * rng.range(0, 1.0);
      const at = _lateral(pose, off);
      const type = rng.weighted([['car', 3], ['van', 2], ['truck', 1]]);
      npcs.push(_vehicle(type, { x: at.x, y: at.y, yaw: pose.yaw + rng.range(-8, 8) }, 0));
      const triAt = _lateral(_corridorAt(c, dObs - rng.range(15, 30)), side * 1.2);
      const tri = _prop('static.prop.warningaccident', triAt.x, triAt.y, pose.yaw + 180);
      if (tri) props.push(tri);
      Object.assign(params, { vehicle_type: type, lateral_m: r1(off) });
    }
    params.distance_m = r1(dObs);
    params.side = side > 0 ? 'right' : 'left';
    if (!props.length && !npcs.length) return null;
    return { corridor: c, npcs, props, params, routedNpcs: [], conflictD: dObs };
  }

  /** The innermost opposite-direction lane beside the ego's lane at this lane
   * visit — lane 1 opposite lane -1 on the same road section — or null when
   * the ego is not in the innermost lane or the road is one-way. */
  function _oncomingLane(net, sg) {
    const id = sg.L.lane.laneId;
    if (Math.abs(id) !== 1) return null;
    return net.lanes.get(`${sg.L.road.id}:${sg.L.lane.sectionId}:${-id}`) || null;
  }

  /** Walk `dist` metres forward from (lane `key`, arc length `s`) through
   * successors, ending on an ordinary road lane: a landing inside a junction
   * is carried on to POST_JUNCTION_WP_M past its exit, where a route waypoint
   * is unambiguous. Returns {L, s} or null at a dead end. */
  function _walkForward(rng, net, key, s, dist) {
    let L = net.lanes.get(key);
    let left = dist;
    for (let hop = 0; L && hop < 6; hop++) {
      if (s + left <= L.length - 0.5 && !L.junction) return { L, s: s + left };
      left = Math.max(L.junction ? POST_JUNCTION_WP_M : 0, left - (L.length - s));
      const next = (net.succ.get(L.key) || []).map(k => net.lanes.get(k)).filter(Boolean);
      if (!next.length) return null;
      L = rng.pick(next);
      s = 0;
    }
    return null;
  }

  /* Oncoming drift. A car in the opposite lane drifts over the centre line
   * into the ego's lane and back — an inattentive or overtaking driver.
   *
   * The drift is a ROUTE, not a lane_offset: fastest legs along its own lane,
   * then a run of 'shortest' waypoints tracing a smooth (half-cosine) swing
   * out, a short hold, and a swing back, then fastest again. A shortest leg is
   * driven verbatim, so the swing is as gradual as its samples — where a
   * lane_offset jumps the controller's aim point sideways in one tick. The
   * swing ends ON its own lane's centre before the next fastest waypoint,
   * because that waypoint's leg is routed from the previous point and an
   * off-lane seed projects onto whatever lane is nearest (CLAUDE.md,
   * per-waypoint routeStrategy) — here, the ego's lane, the wrong way.
   *
   * A route is fixed in space, so the timing comes from the release: the car
   * waits at 0 m/s on its lane and a set_speed ramp fires on distance_to_ego,
   * solved so it reaches the swing's peak as the ego does (the junction
   * conflict's pattern). Ego-relative, so an AV-driven ego still meets it.
   * It ignores lights and obstacles: its obstacle sensor would otherwise see
   * the ego head-on in the lane it is swinging into and brake out of the
   * conflict it exists to create. */
  function _oncomingDrift(rng, net, vEgo) {
    // Start on an innermost lane of a two-way road, as cut-in starts on a
    // multi-lane one: a random corridor rarely puts the ego there.
    if (!net.twoWay) {
      net.twoWay = net.startable.filter(L => L.length >= 60
        && Math.abs(L.lane.laneId) === 1 && _oncomingLane(net, { L }));
    }
    if (!net.twoWay.length) return null;
    const start = rng.pick(net.twoWay);
    const c = _buildCorridor(rng, net, rng.range(220, 320), undefined,
                             start, rng.range(0, Math.max(0.5, start.length - 60)));
    if (!c) return null;
    // The oncoming lane beside corridor distance d: the segment's own
    // opposite lane, projected. The swing may run across several lane
    // sections — Town10HD splits its two-way roads into short ones, and
    // requiring the whole swing on one lane found no site there at all.
    const oncAt = d => {
      const sg = c.segs.find(g => d >= g.startD && d <= g.endD);
      if (!sg || sg.L.junction) return null;
      const O = _oncomingLane(net, sg);
      if (!O || O.junction) return null;
      const at = _corridorAt(c, d);
      const p = _projectOnLane(O, at.x, at.y);
      if (!p || p.d > 6) return null;
      return { O, s: p.s, pose: _laneAt(O, p.s) };
    };

    const vNpc = _p('npc_speed', rng.range(8, 14));
    // The swing, in metres of travel.
    const lenIn = vNpc * rng.range(1.0, 2.2);         // centre line -> peak
    const lenHold = _p('hold_m', rng.range(0, 6));    // at the peak
    const lenOut = vNpc * rng.range(0.8, 1.8);        // back to its own lane
    // Metres toward the ego's lane. Under ~1.4 m (lane 3.5 m minus a 2.1 m
    // car) the two only brush past; most draws cross that.
    const offset = _p('offset_m', rng.range(1.2, 2.8));

    // dX is the corridor distance of the peak. The oncoming car travels toward
    // the ego, i.e. DOWN the corridor: it meets the swing's start at dX + lenIn
    // and is back on its lane at dEnd. The whole swing (+5 m each end) has to
    // sit on one junction-free two-way stretch, so dX is drawn only from where
    // it fits — a uniform draw along the corridor landed next to a junction
    // on most of Town03's attempts.
    const stretches = [];
    for (const sg of c.segs) {
      const twoWay = !sg.L.junction && !!_oncomingLane(net, sg);
      const last = stretches[stretches.length - 1];
      if (twoWay && last && Math.abs(last.b - sg.startD) < 0.5) last.b = sg.endD;
      else if (twoWay) stretches.push({ a: sg.startD, b: sg.endD });
    }
    const dMinX = _egoRunUp(vEgo) + vEgo * 3;
    const fits = stretches
      .map(st => ({ lo: Math.max(st.a + lenHold + lenOut + 5, dMinX), hi: Math.min(st.b, c.length) - lenIn - 5 }))
      .filter(f => f.hi > f.lo);
    if (!fits.length) return null;
    const fit = rng.weighted(fits.map(f => [f, f.hi - f.lo]));
    const dX = rng.range(fit.lo, fit.hi);
    const dEnd = dX - lenHold - lenOut;
    if (!_junctionFree(c, dEnd - 5, dX + lenIn + 5)) return null;
    // Every sample has to find an oncoming lane, not just the ends.
    const samples = [];
    const nIn = Math.max(2, Math.round(lenIn / 3));
    const nOut = Math.max(2, Math.round(lenOut / 3));
    samples.push({ d: dX + lenIn, off: 0, strategy: 'fastest' });
    for (let i = 1; i <= nIn; i++) {
      samples.push({ d: dX + lenIn * (1 - i / nIn),
                     off: offset * (1 - Math.cos(Math.PI * i / nIn)) / 2, strategy: 'shortest' });
    }
    if (lenHold > 1) samples.push({ d: dX - lenHold, off: offset, strategy: 'shortest' });
    for (let i = 1; i <= nOut; i++) {
      // Ends at exactly 0: the next leg is routed from this point.
      samples.push({ d: dX - lenHold - lenOut * i / nOut,
                     off: offset * (1 + Math.cos(Math.PI * i / nOut)) / 2, strategy: 'shortest' });
    }
    const onc = samples.map(sm => oncAt(sm.d));
    if (onc.some(o => !o)) return null;
    const swingStart = onc[0], swingEnd = onc[onc.length - 1];

    // Spawn far enough back to reach cruise speed before the swing starts —
    // and no further: the car waits at rest, so every metre here pushes the
    // conflict further down the corridor.
    const runUp = vNpc * vNpc / (2 * VEHICLE_ACCEL) + rng.range(5, 25);
    let spawn;
    if (swingStart.s - runUp >= 1) {
      spawn = _laneAt(swingStart.O, swingStart.s - runUp);
    } else {
      const back = _walkBack(rng, net, swingStart.O.key, runUp - swingStart.s);
      if (!back) return null;
      spawn = _laneAt(back.L, back.s);
    }
    const toPeak = runUp + lenIn;

    // Continue well past the swing, so the route's end — where the controller
    // stops dead (_reached_goal) — is behind the ego, not in its lane.
    const exit = _walkForward(rng, net, swingEnd.O.key, swingEnd.s, rng.range(30, 50));
    if (!exit) return null;

    // Ego arrives at the peak this much after the car does (negative: before).
    const dt = _p('arrival_offset_s', rng.range(-0.4, 0.6));
    const tNpc = _timeFromRest(toPeak, vNpc);
    const sol = _solveTrigger(c, dX, tNpc + dt, vEgo, spawn);
    if (!sol) return null;

    // Left of the car's travel is negative in _lateral (right positive). The
    // first sample is the swing's start on the lane centre and stays
    // 'fastest' — its leg is the routed run from the spawn.
    const swing = samples.map((sm, i) => {
      const q = _lateral(onc[i].pose, -sm.off);
      return _routeWp({ x: q.x, y: q.y, z: onc[i].pose.z }, sm.strategy);
    });
    const exitPose = _laneAt(exit.L, exit.s);

    const type = _p('npc_type', rng.weighted([['car', 6], ['van', 2], ['truck', 1], ['motorcycle', 1]]));
    const npc = _vehicle(type, spawn, 0);
    _ignoresTraffic(npc);
    npc.events = [
      _routeEvent(npc, [...swing, _routeWp(exitPose)]),
      _speedEvent('evt-2', nearEgo(sol.radius), vNpc, 'rate', VEHICLE_ACCEL),
    ];
    return {
      corridor: c, npcs: [npc], props: [],
      conflictD: dX + 10,
      params: {
        npc_type: type, npc_speed: r1(vNpc), offset_m: r1(offset),
        swing_in_m: r1(lenIn), hold_m: r1(lenHold), swing_out_m: r1(lenOut),
        npc_run_up_m: r1(toPeak), arrival_offset_s: r2(dt), trigger_m: r1(sol.radius),
      },
      // The routed leg up to the swing must actually reach it.
      routedNpcs: [{ actor: npc, passes: swingStart.pose }],
      // The threat starts when the car leaves its lane, not when it is
      // released ~100 m away.
      onsets: new Map([[npc.id, swingStart.pose]]),
    };
  }

  /* Cut-out (Euro NCAP CCRs cut-out). The ego follows a lead car in its lane;
   * the lead swerves into a same-direction neighbour lane at the last moment
   * and uncovers a stopped vehicle the ego could not see past it.
   *
   * Timing is ego-relative through the following itself: the lead drives at
   * the ego's speed a time headway ahead, and its lane change fires on its own
   * position (distance_to_point on its own entity — positional, like the
   * walker that stops in the lane). An AV that follows closer or further back
   * meets the reveal with a different time to the obstacle, which is the
   * point. The lead ignores obstacles (its sensor would brake it for the
   * stopped car it is meant to swerve around) and lights (it reaches each
   * forced-green light before the ego switches it). */
  function _cutOut(rng, net, vEgo) {
    if (!net.multiLane) {
      net.multiLane = net.startable.filter(L => L.length >= 90 && ['left', 'right'].some(side => {
        const ref = L.record && L.record[side];
        const N = ref && net.lanes.get(net.refKey(ref));
        return N && !N.junction;
      }));
    }
    if (!net.multiLane.length) return null;
    const start = rng.pick(net.multiLane);
    const c = _buildCorridor(rng, net, rng.range(220, 320), undefined,
                             start, rng.range(0, Math.max(0.5, start.length - 120)));
    if (!c) return null;
    const candidates = [];
    for (const sg of c.segs) {
      if (sg.L.junction || !sg.L.record) continue;
      for (const side of ['left', 'right']) {
        const ref = sg.L.record[side];
        const N = ref && net.lanes.get(net.refKey(ref));
        if (!N || N.junction) continue;
        const back = N.record && N.record[side === 'left' ? 'right' : 'left'];
        if (back && net.refKey(back) === sg.key) candidates.push({ sg, N, side });
      }
    }
    if (!candidates.length) return null;
    const { sg, N, side } = rng.pick(candidates);

    const type = _p('lead_type', rng.weighted(VEHICLE_MIX.filter(([t]) => t !== 'bus' && t !== 'motorcycle')));
    const stoppedType = _p('stopped_type', rng.weighted([['car', 4], ['van', 2], ['truck', 1]]));
    const thw = _p('headway_s', rng.range(0.9, 2.0));       // following headway, s
    const gap0 = _centreDistance(thw * vEgo, type);           // lead ahead of the ego
    const lcDist = _p('lane_change_m', rng.range(8, 14));     // lateral move spread
    // From the start of the swerve to the stopped car, as late as the lead can
    // make it: the lane change runs 6 m in its own lane, then moves across
    // over lcDist, and the two bodies stop overlapping about 60% of the way
    // over (a 2.1 m car in a 3.5 m lane). Plus both half-lengths and a margin.
    // Drawn generously the ego saw the obstacle 4-7 s out — far too easy.
    const len = t => MapView.actorSize(t).w;
    const cutMargin = _p('cut_margin_m', rng.range(1.5, 10));
    const cutDist = 6 + 0.6 * lcDist + (len(type) + len(stoppedType)) / 2 + cutMargin;
    const dCut = rng.range(Math.max(sg.startD + 2, gap0 + 25), sg.endD - cutDist - 4);
    if (!(dCut > sg.startD) || dCut + cutDist + 4 > sg.endD) return null;
    const dObs = dCut + cutDist;
    if (!_junctionFree(c, 0, dObs + 15)) return null;
    // The swerve has to land on N with room for ChangeActorLateralMotion's
    // 10 m driven in the target lane — it never fails, it hangs.
    const cutPose = _corridorAt(c, dCut);
    const onN = _projectOnLane(N, cutPose.x, cutPose.y);
    if (!onN || onN.d > 6 || onN.s + 6 + lcDist + 25 > N.length) return null;

    const vLead = vEgo * rng.range(0.92, 1.0);
    const lead = _vehicle(type, _corridorAt(c, gap0), vLead);
    lead.obey_traffic_lights = false;
    lead.obey_obstacles = false;
    lead.events = [{
      id: 'evt-1',
      trigger: { type: 'distance_to_point', value: 2.0, entity_ref: lead.id,
                 point: { name: 'Point 1', x: r1(cutPose.x), y: r1(cutPose.y),
                          z: r2(cutPose.z + WAYPOINT_CLEARANCE) } },
      action: { type: 'lane_change', direction: side,
                dynamics: { shape: 'linear', value: r1(lcDist) } },
    }];

    const stopped = _vehicle(stoppedType, _corridorAt(c, dObs), 0);
    // Most stopped cars move off once the ego is right behind them: one that
    // never does blocks the lane until every Act's 60 s stop trigger. The
    // radius is a 9 m bumper gap: the scripted ego halts ~6.3 m behind (10.8 m
    // centre to centre, measured on Town05), so a 6 m one was never reached
    // and the car left only on the 60 s fallback.
    const drivesOff = _p('stopped_drives_off', rng.chance(0.7));
    stopped.events = drivesOff
      ? [_speedEvent('evt-1', nearEgo(_centreDistance(9, stoppedType)), r1(rng.range(6, 10)), 'rate', 2.0)]
      : [];
    return {
      corridor: c, npcs: [lead, stopped], props: [],
      conflictD: dObs + 10,
      params: {
        lead_type: type, stopped_type: stoppedType, side, headway_s: r2(thw),
        lead_speed: r1(vLead), lane_change_m: r1(lcDist), cut_to_obstacle_m: r1(cutDist),
        cut_margin_m: r1(cutMargin),
        stopped_drives_off: drivesOff,
      },
      routedNpcs: [],
      // The lead is the reveal, not the conflict.
      sceneryIds: new Set([lead.id]),
      revealedBy: new Map([[stopped.id, { actorId: lead.id, eventId: 'evt-1' }]]),
    };
  }

  /* Cyclist ahead. A slower cyclist rides at the right edge of the ego's lane;
   * the ego has to follow or pass. Half of them swerve out toward the lane
   * centre as the ego closes in — around a parked car or a pothole. */
  function _cyclistAhead(rng, net, vEgo) {
    const c = _buildCorridor(rng, net, rng.range(200, 300));
    if (!c) return null;
    const vBike = _p('speed', rng.range(3, 6));
    const gap0 = _p('initial_gap_m', rng.range(30, 60));
    const tCatch = gap0 / (vEgo - vBike);
    // A cyclist has no route (assign_route is for vehicles the planner routes,
    // and `bike` is not one), so it lane-follows: keep its whole ride before
    // the ego catches it on one straight stretch, where there is no fork to
    // guess at.
    if (!_junctionFree(c, gap0 - 8, gap0 + vBike * tCatch + 25)) return null;
    const pose = _corridorAt(c, gap0);
    const edgeOffset = _p('edge_offset_m', rng.range(0.8, 1.2));
    const bike = _vehicle('cyclist', pose, vBike);
    const events = [{
      id: 'evt-1', trigger: nearEgo(400),   // at once: rides at the edge from the start
      action: { type: 'lane_offset', direction: 'right', offset: r1(edgeOffset) },
    }];
    const swerves = _p('swerves', rng.chance(0.5));
    let swerveTtc = null;
    if (swerves) {
      swerveTtc = _p('swerve_ttc_s', rng.range(1.2, 3.5));
      // A second offset supersedes the first (its _overwritten flag), so this
      // is a move from the edge out to `out` metres left of the lane centre.
      events.push({
        id: 'evt-2', trigger: nearEgo(_centreDistance(Math.max(6, (vEgo - vBike) * swerveTtc), 'cyclist')),
        action: { type: 'lane_offset', direction: 'left', offset: r1(rng.range(0.0, 0.8)) },
      });
    }
    bike.events = events;
    return {
      corridor: c, npcs: [bike], props: [],
      conflictD: gap0 + vBike * tCatch + 10,
      params: {
        speed: r1(vBike), initial_gap_m: r1(gap0), edge_offset_m: r1(edgeOffset),
        swerves, swerve_ttc_s: swerveTtc && r2(swerveTtc),
      },
      routedNpcs: [],
      threats: swerves ? new Map([[bike.id, 'evt-2']]) : null,
    };
  }

  // ── Editable parameters per type (the recipe panel) ──────────────────────────
  //
  // `key` is both the _p() override key and the key in the build's `params`,
  // which is where the panel reads the value the build actually used. Ranges
  // are the generator's own draw ranges: outside them a site check or the
  // trigger solve fails more often than it builds.
  const num = (key, label, unit, min, max, step) => ({ key, label, unit, kind: 'num', min, max, step });
  const bool = (key, label) => ({ key, label, kind: 'bool' });
  const choice = (key, label, options) => ({ key, label, kind: 'choice', options });
  const VEHICLE_OPTS = [['car', 'Auto'], ['van', 'Transporter'], ['truck', 'Lkw'], ['bus', 'Bus'], ['motorcycle', 'Motorrad']];
  const SIDE_OPTS = [['right', 'rechts'], ['left', 'links']];
  const EGO_SPEED = num('ego_speed', 'Ego-Tempo', 'm/s', 5, 20, 0.5);
  const PARAMS = {
    lead_brake: [
      choice('lead_type', 'Vorausfahrzeug', VEHICLE_OPTS),
      num('lead_speed', 'Tempo', 'm/s', 2, 14, 0.5),
      num('brake_headway_s', 'Bremst bei', 's Abstand', 1, 3, 0.1),
      num('decel', 'Verzögerung', 'm/s²', 2.5, 8, 0.5),
      num('end_speed', 'Bremst auf', 'm/s', 0, 4, 0.5),
      num('hold_s', 'Hält', 's', 1, 10, 0.5),
      bool('resumes', 'Fährt wieder an'),
    ],
    cut_in: [
      choice('npc_type', 'Fahrzeug', VEHICLE_OPTS.filter(([k]) => k !== 'bus')),
      num('npc_speed', 'Tempo', 'm/s', 3, 10, 0.5),
      num('trigger_m', 'Schert ein bei', 'm', 8, 26, 1),
      num('lane_change_m', 'Spurwechsel über', 'm', 10, 22, 1),
      bool('brakes_after', 'Bremst danach'),
    ],
    vru_crossing: [
      choice('vru_type', 'Person', [['pedestrian', 'Fußgänger'], ['child', 'Kind'], ['cyclist', 'Radfahrer']]),
      num('speed', 'Tempo', 'm/s', 0.8, 6, 0.1),
      choice('from', 'Kommt von', SIDE_OPTS),
      num('arrival_offset_s', 'Zeitversatz', 's', -0.5, 0.8, 0.05),
      bool('occluded', 'Verdeckt (parkendes Fahrzeug)'),
      num('stops_in_lane_s', 'Bleibt stehen', 's (0 = nein)', 0, 4, 0.5),
    ],
    junction_conflict: [
      choice('npc_type', 'Fahrzeug', [...VEHICLE_OPTS.filter(([k]) => k !== 'bus'), ['police', 'Polizei'], ['ambulance', 'Rettungswagen']]),
      num('npc_speed', 'Tempo', 'm/s', 7, 13, 0.5),
      num('arrival_offset_s', 'Zeitversatz', 's', -0.6, 0.8, 0.05),
    ],
    obstacle: [
      choice('variant', 'Art', [['cargo', 'Ladung'], ['workzone', 'Baustelle'], ['breakdown', 'Pannenfahrzeug']]),
      choice('side', 'Seite', SIDE_OPTS),
    ],
    oncoming_drift: [
      choice('npc_type', 'Fahrzeug', VEHICLE_OPTS.filter(([k]) => k !== 'bus')),
      num('npc_speed', 'Tempo', 'm/s', 8, 14, 0.5),
      num('offset_m', 'Ausschwenken', 'm', 1.2, 2.8, 0.1),
      num('hold_m', 'Bleibt drüben', 'm', 0, 6, 0.5),
      num('arrival_offset_s', 'Zeitversatz', 's', -0.4, 0.6, 0.05),
    ],
    cut_out: [
      choice('lead_type', 'Vorausfahrzeug', [['car', 'Auto'], ['van', 'Transporter'], ['truck', 'Lkw']]),
      choice('stopped_type', 'Stehendes Fahrzeug', [['car', 'Auto'], ['van', 'Transporter'], ['truck', 'Lkw']]),
      num('headway_s', 'Folgeabstand', 's', 0.9, 2, 0.1),
      num('lane_change_m', 'Spurwechsel über', 'm', 8, 14, 1),
      num('cut_margin_m', 'Reserve', 'm', 1.5, 10, 0.5),
      bool('stopped_drives_off', 'Stehendes fährt an'),
    ],
    cyclist_ahead: [
      num('speed', 'Tempo', 'm/s', 3, 6, 0.5),
      num('initial_gap_m', 'Vorsprung', 'm', 30, 60, 1),
      num('edge_offset_m', 'Randabstand', 'm', 0.8, 1.2, 0.1),
      bool('swerves', 'Schwenkt aus'),
      num('swerve_ttc_s', 'Schwenkt bei', 's', 1.2, 3.5, 0.1),
    ],
  };

  /** Keep only overrides that name a parameter of this type, coerced and
   * clamped to it. A save file or a stale recipe can carry anything. */
  function _cleanOverrides(typeKey, raw) {
    if (!raw || !typeKey || !PARAMS[typeKey]) return null;
    const out = {};
    for (const spec of [EGO_SPEED, ...PARAMS[typeKey]]) {
      if (!Object.prototype.hasOwnProperty.call(raw, spec.key)) continue;
      const v = raw[spec.key];
      if (spec.kind === 'num') {
        const n = Number(v);
        if (Number.isFinite(n)) out[spec.key] = Math.min(spec.max, Math.max(spec.min, n));
      } else if (spec.kind === 'bool') {
        out[spec.key] = v === true || v === 'true';
      } else if (spec.options.some(([k]) => k === v)) {
        out[spec.key] = v;
      }
    }
    return Object.keys(out).length ? out : null;
  }

  const TYPES = {
    lead_brake:        { label: 'Vorausfahrzeug bremst', build: _leadBrake },
    cut_in:            { label: 'Einscheren',            build: _cutIn },
    vru_crossing:      { label: 'Querende Person',       build: _vruCrossing },
    junction_conflict: { label: 'Querverkehr Kreuzung',  build: _junctionConflict },
    obstacle:          { label: 'Hindernis auf Spur',    build: _obstacle },
    oncoming_drift:    { label: 'Gegenverkehr driftet',  build: _oncomingDrift },
    cyclist_ahead:     { label: 'Radfahrer voraus',      build: _cyclistAhead },
    cut_out:           { label: 'Ausscheren vor Stauende', build: _cutOut },
  };

  // ── Checks ───────────────────────────────────────────────────────────────────

  function _distToPolyline(route, x, y) {
    let best = Infinity;
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1], b = route[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)));
    }
    return best;
  }

  function _routeOf(actor) {
    const ev = actor.events.find(e => e.action?.type === 'assign_route');
    return ev ? Simulate.routeGeometry(actor, ev) : null;
  }

  /** The route the preview (and CARLA's router) would drive stays on the
   * corridor from dFrom to its end. */
  function _routeFollowsCorridor(actor, c, dFrom, dTo = c.length) {
    const route = _routeOf(actor);
    if (!route || route.length < 2) return false;
    for (let d = dFrom + 4; d < dTo - 4; d += 4) {
      const p = _corridorAt(c, d);
      if (_distToPolyline(route, p.x, p.y) > ROUTE_TOLERANCE_M) return false;
    }
    return true;
  }

  /** No two actors spawn inside each other — CARLA refuses the second one
   * ("collision at spawn position") and the whole run fails — and the ego does
   * not start on top of an obstacle. Measured centre to centre against a
   * radius per actor kind, which is conservative for a 4.5 m car. */
  const SPAWN_RADIUS = { walker: 0.8, vehicle: 2.6, prop: 1.0 };
  function _spawnsClear(ego, npcs, props) {
    const r = a => (a.type === 'prop' ? SPAWN_RADIUS.prop
      : MapView.isWalkerType(a.type) ? SPAWN_RADIUS.walker : SPAWN_RADIUS.vehicle);
    const actors = [ego, ...npcs];
    for (let i = 0; i < actors.length; i++) {
      for (let j = i + 1; j < actors.length; j++) {
        const a = actors[i], b = actors[j];
        if (Math.hypot(a.x - b.x, a.y - b.y) < r(a) + r(b) + 0.5) return false;
      }
      for (const p of props) {
        // Props cluster on purpose (a cone taper), so only actor-vs-prop counts;
        // the ego gets a run-up on top, so it does not spawn staring at one.
        const clear = actors[i] === ego ? 15 : r(actors[i]) + SPAWN_RADIUS.prop + 0.5;
        if (Math.hypot(actors[i].x - p.x, actors[i].y - p.y) < clear) return false;
      }
    }
    return true;
  }

  // ── Conflict check (internal) ────────────────────────────────────────────────
  //
  // Every candidate is run through the preview headlessly, with an ego that
  // does NOT react: "what happens if the system under test does nothing".
  // Only used to drop candidates where nothing happens or nothing could be
  // avoided, and to locate the conflict (`at`) for a map-click build — it is
  // never shown, graded or exported. From that run:
  //
  //   ttc_s        seconds from the NPC's trigger to first contact. The time
  //                the system under test has to notice and act.
  //   decel_mps2   constant deceleration the ego would need, starting at the
  //                trigger, to stop short of the contact point. Upper bound for
  //                a moving NPC (it ignores the NPC's own escape).
  //   min_gap_m    smallest footprint-to-footprint distance when there is no
  //                contact at all (a near miss even without reacting).
  //
  // An obstacle has no trigger; it is "triggered" at t = 0, so its numbers
  // are about having seen it from the start.

  // No contact and never closer than this: nothing to test.
  const TRIVIAL_GAP_M = 2.0;
  // Contact sooner than this after the trigger, or needing more than this
  // braking: no system could avoid it, so it tests nothing either.
  const UNAVOIDABLE_TTC_S = 1.0;
  const UNAVOIDABLE_DECEL = 9.0;

  function _footprint(a) {
    if (a.type === 'prop') {
      const s = PropCatalog.planSize(a.prop);
      return { l: s.len, w: s.wid };
    }
    const s = MapView.actorSize(a.type);
    return { l: s.w, w: s.h };
  }

  /** Corners of a footprint centred at (x, y), heading `yaw` radians. */
  function _corners(x, y, yaw, fp) {
    const c = Math.cos(yaw), s = Math.sin(yaw), hl = fp.l / 2, hw = fp.w / 2;
    return [[hl, hw], [hl, -hw], [-hl, -hw], [-hl, hw]]
      .map(([u, v]) => [x + u * c - v * s, y + u * s + v * c]);
  }

  /** Separating-axis gap between two convex quads: < 0 means overlap. */
  function _quadGap(A, B) {
    let gap = -Infinity;
    for (const P of [A, B]) {
      for (let i = 0; i < 4; i++) {
        const [x1, y1] = P[i], [x2, y2] = P[(i + 1) % 4];
        const nx = y2 - y1, ny = x1 - x2, n = Math.hypot(nx, ny) || 1;
        let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
        for (const [x, y] of A) { const d = (x * nx + y * ny) / n; aMin = Math.min(aMin, d); aMax = Math.max(aMax, d); }
        for (const [x, y] of B) { const d = (x * nx + y * ny) / n; bMin = Math.min(bMin, d); bMax = Math.max(bMax, d); }
        gap = Math.max(gap, bMin - aMax, aMin - bMax);
      }
    }
    return gap;
  }

  /** Heading per sample from motion, holding the last one while stationary. */
  function _headings(track, yaw0Deg) {
    const out = [];
    let h = yaw0Deg / DEG;
    for (let i = 0; i < track.length; i++) {
      const a = track[Math.max(0, i - 1)], b = track[i];
      if (Math.hypot(b.x - a.x, b.y - a.y) > 0.005) h = Math.atan2(b.y - a.y, b.x - a.x);
      out.push(h);
    }
    return out;
  }

  /**
   * Score a candidate {ego, npcs, props}. Returns
   * {verdict, ttc_s, decel_mps2, min_gap_m, conflict_with, at}
   * where verdict is 'ok' | 'trivial' | 'unavoidable' | 'no_run'.
   */
  function assess(cand) {
    cand = { props: [], ...cand };
    const run = Simulate.runHeadless({ dt: 0.05, maxTime: 45, ego: cand.ego, npcs: cand.npcs, props: cand.props });
    if (!run) return { verdict: 'no_run' };
    const egoTr = run.tracks[run.egoId];
    const egoH = _headings(egoTr, cand.ego.yaw);
    const egoFp = _footprint(cand.ego);

    // What the ego can hit: every NPC (moving or parked) and every prop.
    // Scenery (the van a pedestrian steps out from behind) is part of the
    // set-up, not the conflict: a parked car beside the ego's lane would
    // otherwise score as a near miss.
    const scenery = cand.sceneryIds || new Set();
    const others = [
      ...cand.npcs.filter(n => !scenery.has(n.id)).map(n => ({ a: n, tr: run.tracks[n.id] })),
      ...cand.props.map(p => ({ a: p, tr: null })),
    ];
    let worst = null;
    for (const o of others) {
      const fp = _footprint(o.a);
      const h = o.tr ? _headings(o.tr, o.a.yaw) : null;
      // Trigger = the first ego-relative event this actor fired; a static
      // thing (prop, parked car) is in view from the start.
      // A type can name the event that IS the threat (the cyclist's swerve,
      // not its riding at the kerb from t = 0); otherwise the first one.
      const threatId = cand.threats && cand.threats.get(o.a.id);
      // Or another actor's event is what exposes it: the stopped car a lead
      // cuts out from in front of is a threat from the cut, not from t = 0
      // and not from its own (much later) drive-off.
      const rev = cand.revealedBy && cand.revealedBy.get(o.a.id);
      const trig = rev
        ? [run.fired[rev.actorId]?.[rev.eventId]].filter(t => t != null)
        : (o.a.events || [])
          .filter(e => (threatId ? e.id === threatId : e.trigger?.type === 'distance_to_ego'))
          .map(e => run.fired[o.a.id]?.[e.id]).filter(t => t != null);
      const hasEvents = !!rev || (o.a.events || []).length > 0;
      if (hasEvents && !trig.length) continue;   // never released: not this actor's conflict
      let t0 = trig.length ? Math.min(...trig) : 0;
      // Threat onset, where the type knows a better moment than the release:
      // the crossing car passing the line into the junction, the pedestrian
      // stepping off the kerb. Until then nothing says it will not stop.
      const onset = cand.onsets && cand.onsets.get(o.a.id);
      if (onset && o.tr) {
        const k = o.tr.findIndex((p, i) => run.times[i] >= t0 && Math.hypot(p.x - onset.x, p.y - onset.y) < 1.5);
        if (k >= 0) t0 = run.times[k];
      }
      const i0 = Math.max(0, run.times.findIndex(t => t >= t0));
      let contact = null, minGap = Infinity, minAt = null;
      for (let i = i0; i < run.times.length; i++) {
        const ox = o.tr ? o.tr[i].x : o.a.x, oy = o.tr ? o.tr[i].y : o.a.y;
        if (Math.hypot(ox - egoTr[i].x, oy - egoTr[i].y) > 25) continue;   // cheap reject
        const g = _quadGap(_corners(egoTr[i].x, egoTr[i].y, egoH[i], egoFp),
                           _corners(ox, oy, h ? h[i] : o.a.yaw / DEG, fp));
        if (g < minGap) { minGap = g; minAt = i; }
        if (g < 0) { contact = i; break; }
      }
      // Where it happens: the ego at contact, or at its closest approach.
      const atI = contact ?? minAt;
      const at = atI != null ? { x: r1(egoTr[atI].x), y: r1(egoTr[atI].y) } : null;
      let entry;
      if (contact != null) {
        const ttc = run.times[contact] - (i0 ? run.times[i0] : 0);
        let travel = 0;
        for (let i = i0 + 1; i <= contact; i++) travel += Math.hypot(egoTr[i].x - egoTr[i - 1].x, egoTr[i].y - egoTr[i - 1].y);
        const v = egoTr[i0].speed;
        const decel = v > 0.1 ? v * v / (2 * Math.max(travel - 0.5, 0.25)) : 0;
        entry = { contact: true, ttc_s: r2(ttc), decel_mps2: r1(decel), min_gap_m: 0, with: o.a.type, at };
      } else {
        entry = { contact: false, ttc_s: null, decel_mps2: 0, min_gap_m: r1(Math.max(0, minGap)), with: o.a.type, at };
      }
      // The worst conflict is the one that leaves the least time.
      const key = e => (e.contact ? e.ttc_s : 1000 + e.min_gap_m);
      if (!worst || key(entry) < key(worst)) worst = entry;
    }
    if (!worst) return { verdict: 'trivial' };

    let verdict = 'ok';
    if (!worst.contact && worst.min_gap_m > TRIVIAL_GAP_M) verdict = 'trivial';
    if (worst.contact && (worst.ttc_s < UNAVOIDABLE_TTC_S || worst.decel_mps2 > UNAVOIDABLE_DECEL)) verdict = 'unavoidable';
    return {
      verdict, ttc_s: worst.ttc_s, decel_mps2: worst.decel_mps2,
      min_gap_m: worst.min_gap_m, conflict_with: worst.with, at: worst.at,
    };
  }

  // ── Public entry point ───────────────────────────────────────────────────────

  /** A well-mixed 32-bit seed for attempt `attempt` of seed `seed`. */
  function _attemptSeed(seed, attempt) {
    let h = (Math.imul(seed >>> 0, 0x9E3779B1) ^ Math.imul(attempt + 1, 0x85EBCA6B)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7FEB352D) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x846CA68B) >>> 0;
    return (h ^ (h >>> 16)) >>> 0 || 1;
  }

  let _lastInfo = null;

  function _randomSeed() {
    return Math.floor(Math.random() * 2 ** 31) + 1;
  }

  /**
   * Build a scenario without touching AppState. Returns
   * {ego, npcs, props, info} or null when no attempt fit this map.
   *
   * Every candidate is scored (assess) and dropped when it is trivial or
   * unavoidable.
   *
   * `opts.near` = {x, y} builds it at that spot ("Generate here"): the ego's
   * corridor runs through a lane at the click and the conflict must happen
   * within FOCUS_RADIUS_M of it. Null when no driving lane is near the point.
   */
  function build(typeKey = null, seed = null, opts = {}) {
    const net = _network();
    if (!net) return null;
    if (opts.near) {
      const lanes = _focusLanes(net, opts.near.x, opts.near.y);
      if (!lanes.length) return null;
      _focus = { x: opts.near.x, y: opts.near.y, radius: opts.near.radius ?? FOCUS_RADIUS_M, lanes };
    }
    _overrides = _cleanOverrides(typeKey, opts.overrides);
    try {
      return _build(net, typeKey, seed, opts);
    } finally {
      _focus = null;
      _overrides = null;
    }
  }

  function _build(net, typeKey, seed, opts) {
    seed = Number.isFinite(Number(seed)) && Number(seed) > 0 ? Math.floor(Number(seed)) : _randomSeed();
    const keys = typeKey ? [typeKey] : Object.keys(TYPES);

    // A focus throws away every candidate whose conflict lands elsewhere, so
    // it gets more tries; each costs one headless run (~20 ms) once built.
    const maxAttempts = MAX_ATTEMPTS + (_focus ? 150 : 0);
    // Every attempt draws from its OWN generator, seeded from (seed, attempt):
    // attempt k is then the same corridor and draws whatever happened in
    // attempts 0..k-1. That is what lets the recipe panel rebuild a scenario
    // with one value pinned on the very site it was on — it retries the
    // original attempt first (opts.firstAttempt). With one shared generator a
    // pin that changed how far an earlier attempt got shifted every later one.
    const first = Number.isInteger(opts.firstAttempt) && opts.firstAttempt >= 0 ? opts.firstAttempt : null;
    const order = first !== null ? [first] : [];
    if (!opts.onlyFirst || first === null) {
      for (let a = 0; a < maxAttempts; a++) if (a !== first) order.push(a);
    }
    for (const attempt of order) {
      const rng = new Rng(_attemptSeed(seed, attempt));
      const key = rng.pick(keys);
      const vEgo = _p('ego_speed', Math.round(rng.range(8, 14) * 2) / 2);
      const res = TYPES[key].build(rng, net, vEgo);
      if (!res) continue;
      const trafficSignals = _greenWave(net, res.corridor, res.conflictD ?? res.corridor.length);

      const c = res.corridor;
      // A type may end the ego's route short of the corridor, so an NPC that
      // follows the same corridor (the lead car) is not parked on the ego's
      // own goal when both routes run out.
      const egoEnd = res.egoEndD ?? c.length;
      const ego = _vehicle('ego', _corridorAt(c, 0), vEgo);
      ego.events = [_routeEvent(ego, _corridorWaypoints(c, 0, egoEnd))];
      if (!_routeFollowsCorridor(ego, c, 0, egoEnd)) continue;

      if (!_spawnsClear(ego, res.npcs, res.props)) continue;

      let ok = true;
      for (const rn of res.routedNpcs) {
        if (rn.corridorFrom !== undefined) {
          ok = _routeFollowsCorridor(rn.actor, c, rn.corridorFrom);
        } else if (rn.passes) {
          const route = _routeOf(rn.actor);
          ok = !!route && _distToPolyline(route, rn.passes.x, rn.passes.y) <= ROUTE_TOLERANCE_M;
        }
        if (!ok) break;
      }
      if (!ok) continue;

      const criticality = assess({ ego, npcs: res.npcs, props: res.props,
                                   sceneryIds: res.sceneryIds, onsets: res.onsets,
                                   threats: res.threats, revealedBy: res.revealedBy });
      // Pinned values are the user's call: build what they give rather than
      // moving on to another site.
      if (criticality.verdict === 'no_run') continue;
      if (criticality.verdict !== 'ok' && !_overrides) continue;
      if (_focus && !(criticality.at
          && Math.hypot(criticality.at.x - _focus.x, criticality.at.y - _focus.y) <= _focus.radius)) continue;

      const info = {
        seed, type: key, label: TYPES[key].label, town: AppState.map, attempts: order.indexOf(attempt) + 1, attempt,
        ego_speed: vEgo, route_m: r1(egoEnd), criticality, params: res.params,
      };
      info.forced_green_lights = trafficSignals.length;
      if (_focus) info.near = { x: r1(_focus.x), y: r1(_focus.y) };
      if (_overrides) info.overrides = { ..._overrides };
      return { ego, npcs: res.npcs, props: res.props, trafficSignals, info };
    }
    return null;
  }

  /** Build and load a scenario into the editor as ONE undo step. */
  function generate(typeKey = null, seed = null, opts = {}) {
    if (!AppState.mapData) { Toast.error('Zuerst eine Karte laden'); return null; }
    if (!AppState.laneGraph) { Toast.error('Für diese Karte ist kein Spurgraph geladen'); return null; }
    if (typeKey && !TYPES[typeKey]) return null;

    Simulate.stop();   // scoring needs the preview's tick state, see Simulate.stop
    AppState.cancelPlacement();
    const result = opts.prebuilt || build(typeKey, seed, opts);
    if (!result) {
      const what = typeKey ? TYPES[typeKey].label : 'Szenario';
      Toast.error(opts.near
        ? `Kein passender Ort für „${what}" an dieser Stelle — eine andere Stelle oder einen anderen Typ versuchen`
        : `Kein passender Ort für „${what}" auf ${AppState.map} gefunden`);
      return null;
    }
    // The recipe: enough to rebuild this scenario with one parameter changed
    // on the same site (recipe panel). A first build that was not anchored to
    // a click is anchored to its own conflict point from now on, so repeated
    // rebuilds cannot drift across the map.
    const info = result.info;
    const recipe = {
      type: info.type, label: info.label, seed: info.seed, town: info.town,
      near: info.near || opts.near || (info.criticality?.at ? { ...info.criticality.at } : null),
      // Built focused (a click, or a rebuild that needed the focus): `attempt`
      // indexes the focused attempts, so rebuilds stay focused. Otherwise it
      // indexes the plain ones, and the plain attempt is retried first.
      anchored: !!info.near,
      attempt: info.attempt,
      overrides: info.overrides || {},
      params: { ego_speed: info.ego_speed, ...info.params },
      criticality: info.criticality,
    };
    UndoStack.group(opts.undoLabel || 'Szenario generiert', () => {
      AppState.select(null);
      AppState.set({
        ego: result.ego,
        npcs: result.npcs,
        staticObjects: result.props,
        trafficSignals: result.trafficSignals,
        generated: recipe,
      });
      recipe.signature = sceneSignature();
      // The overview panel re-renders off an allow-list that does not include
      // ego/npcs; an empty patch is the codebase's "arrays changed" signal it
      // does listen for (properties.js). Inside the group, so still one undo.
      AppState.set({});
    });
    MapView.renderAllActors();
    if (!opts.keepView) _frame(result);

    const problems = [result.ego, ...result.npcs]
      .flatMap(a => ScenarioRules.problemsOf(a).map(p => `${AppState.actorLabel(a)}: ${p.problem.message}`));
    if (problems.length) Toast.warn(`Generiertes Szenario hat Probleme: ${problems.join('; ')}`, 8000);
    else if (!opts.quiet) Toast.success(`${result.info.label} generiert · Seed ${result.info.seed}`);

    _lastInfo = result.info;
    AppState.emit('scenarioGenerated', result.info);
    return result.info;
  }

  /** A short hash of the scenario objects, to tell whether the open scenario
   * is still the one a recipe built (the panel warns before a rebuild would
   * throw hand edits away). Editor-only flags (a collapsed event card) are
   * edits too as far as this knows; it only decides whether to ask. */
  function sceneSignature() {
    const str = JSON.stringify([AppState.ego, AppState.npcs, AppState.staticObjects]);
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  /** True when the open scenario is no longer exactly what the recipe built. */
  function recipeEdited() {
    const r = AppState.generated;
    return !!r && r.signature !== sceneSignature();
  }

  /**
   * Rebuild the open recipe with `changes` merged into its pinned values
   * (null removes a pin), on the same site and seed. `newSeed` makes a
   * variant instead: everything not pinned is drawn afresh. One undo step;
   * on failure the open scenario is left alone and a toast says so.
   */
  function rebuild(changes = {}, { newSeed = false } = {}) {
    const r = AppState.generated;
    if (!r || !TYPES[r.type]) return null;
    if (r.town && r.town !== AppState.map) {
      Toast.error(`Das Rezept gehört zu ${r.town} — erst die Karte wechseln`);
      return null;
    }
    const overrides = { ...(r.overrides || {}) };
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === undefined) delete overrides[k];
      else overrides[k] = v;
    }
    Simulate.stop();
    const result = _buildFromRecipe(r, overrides, newSeed ? _randomSeed() : null);
    if (!result) {
      Toast.error(`„${r.label}" lässt sich mit diesen Werten an dieser Stelle nicht bauen`);
      return null;
    }
    return generate(r.type, result.info.seed, {
      near: r.near, prebuilt: result, keepView: true,
      undoLabel: newSeed ? 'Variante' : 'Parameter',
    });
  }

  /**
   * Build `r`'s scenario again with `overrides`, without touching AppState.
   * Same seed: an unanchored recipe retries its original plain attempt first
   * (pins never shift the per-attempt RNG, so that is the very same corridor)
   * and keeps it only if the conflict stays within FOCUS_RADIUS_M of where it
   * was; otherwise, and for an anchored recipe, it builds focused on the
   * recipe's spot, original attempt first. `newSeed`: a variant, focused.
   */
  function _buildFromRecipe(r, overrides, newSeed = null) {
    if (newSeed) return build(r.type, newSeed, { near: r.near, overrides });
    if (!r.anchored && Number.isInteger(r.attempt)) {
      const plain = build(r.type, r.seed, { overrides, firstAttempt: r.attempt, onlyFirst: true });
      const at = plain?.info.criticality?.at;
      if (at && (!r.near || Math.hypot(at.x - r.near.x, at.y - r.near.y) <= FOCUS_RADIUS_M)) return plain;
    }
    if (!r.near) return null;
    return build(r.type, r.seed, { near: r.near, overrides, firstAttempt: r.anchored ? r.attempt : undefined });
  }

  // ── Parameter sweep (a series from one recipe) ───────────────────────────────

  const SWEEP_MAX = 200;

  /** The values a sweep over `spec` visits: every option of a choice or a
   * bool, else `steps` evenly spaced from..to, rounded to the field's step. */
  function _sweepValues(spec, from, to, steps) {
    if (spec.kind === 'bool') return [false, true];
    if (spec.kind === 'choice') return spec.options.map(([k]) => k);
    const clamp = v => Math.min(spec.max, Math.max(spec.min, v));
    const a = clamp(Number(from)), b = clamp(Number(to));
    const n = Math.max(2, Math.min(25, Math.floor(Number(steps) || 2)));
    const out = [];
    for (let i = 0; i < n; i++) {
      const v = Math.round((a + (b - a) * i / (n - 1)) / spec.step) * spec.step;
      const rv = Math.round(v * 1000) / 1000;
      if (!out.includes(rv)) out.push(rv);
    }
    return out;
  }

  /**
   * One scenario per value of `key` (× every weather preset when `weathers`),
   * built from the open recipe on its site, as batch-export entries. The
   * editor's own scenario is swapped out and put back exactly as
   * generateBatch does it: plain assignment, undo suspended, `change {}`.
   */
  async function sweepFromRecipe({ key, from, to, steps = 5, weathers = false,
                                   onProgress = () => {}, isCancelled = () => false } = {}) {
    const r = AppState.generated;
    if (!r || !PARAMS[r.type]) return null;
    const spec = [EGO_SPEED, ...PARAMS[r.type]].find(sp => sp.key === key);
    if (!spec) return null;
    const values = _sweepValues(spec, from, to, steps);
    const wx = weathers ? Object.keys(WEATHER_PRESETS) : [null];
    const plan = values.flatMap(v => wx.map(w => ({ v, w }))).slice(0, SWEEP_MAX);

    Simulate.stop();
    const saved = JSON.parse(JSON.stringify({
      ego: AppState.ego, npcs: AppState.npcs, staticObjects: AppState.staticObjects,
      trafficSignals: AppState.trafficSignals, weather: AppState.weather, time: AppState.time,
      generated: AppState.generated,
    }));
    AppState.cancelPlacement();
    AppState.select(null);
    UndoStack.suspend();
    const entries = [], skipped = [];
    const cache = new Map();   // one build per value, reused across weathers
    try {
      for (let k = 0; k < plan.length; k++) {
        if (isCancelled()) break;
        const { v, w } = plan[k];
        const ck = JSON.stringify(v);
        if (!cache.has(ck)) cache.set(ck, _buildFromRecipe(r, { ...(r.overrides || {}), [key]: v }));
        const res = cache.get(ck);
        if (!res) { skipped.push({ value: v, reason: 'an dieser Stelle nicht baubar' }); continue; }
        const copy = JSON.parse(JSON.stringify({ ego: res.ego, npcs: res.npcs, props: res.props, sig: res.trafficSignals }));
        AppState.ego = copy.ego;
        AppState.npcs = copy.npcs;
        AppState.staticObjects = copy.props;
        AppState.trafficSignals = copy.sig;
        AppState.weather = w ? _weatherOf(w) : JSON.parse(JSON.stringify(saved.weather));
        AppState.time = saved.time;
        const problems = ScenarioIO.validate().errors;
        if (problems.length) { skipped.push({ value: v, reason: problems[0] }); continue; }
        const n = String(entries.length + 1).padStart(4, '0');
        const vName = String(v).replace(/[^\w.-]/g, '');
        entries.push({
          name: `${n}_${r.type}_${key}-${vName}${w ? '_' + w : ''}_s${res.info.seed}`,
          params: ScenarioIO.buildParams(),
          scenario: AppState.toJSON(),
          meta: {
            index: entries.length + 1, seed: res.info.seed, town: AppState.map, type: r.type,
            label: r.label, sweep_param: key, sweep_value: v,
            weather: w || 'editor', time: AppState.time, ego_speed: res.info.ego_speed,
            params: res.info.params, pinned: { ...(r.overrides || {}), [key]: v },
          },
        });
        onProgress(k + 1, plan.length, entries.length);
        await _tick();
      }
    } finally {
      Object.assign(AppState, saved);
      UndoStack.resume();
      AppState.emit('change', {});
      MapView.renderAllActors();
    }
    return { entries, skipped, values, cancelled: isCancelled() };
  }

  let _sweepRunning = false;

  async function _runSweep(opts) {
    if (_sweepRunning) return;
    _sweepRunning = true;
    try {
      const res = await sweepFromRecipe(opts);
      if (!res) return;
      if (!res.entries.length) { Toast.error('Serie: kein Wert ließ sich an dieser Stelle bauen'); return; }
      const r = AppState.generated;
      const filename = `serie_${AppState.map}_${r.type}_${opts.key}_${res.entries.length}.zip`;
      const out = await Api.exportBatch({ scenarios: res.entries, filename });
      ScenarioIO.downloadBlob(out.blob, filename);
      const notes = [];
      if (res.skipped.length) notes.push(`${res.skipped.length} übersprungen`);
      if (out.failed) notes.push(`${out.failed} Export fehlgeschlagen (siehe manifest)`);
      Toast.success(`Serie: ${out.ok} Szenarien exportiert${notes.length ? ' · ' + notes.join(' · ') : ''}`, 8000);
    } catch (err) {
      Toast.error(`Serie fehlgeschlagen: ${err.message}`);
    } finally {
      _sweepRunning = false;
    }
  }

  /** Frame everything the scenario placed, including the ego's route end. */
  function _frame(result) {
    const pts = [result.ego, ...result.npcs, ...result.props].map(a => ({ x: a.x, y: a.y }));
    const wps = result.ego.events[0]?.action?.waypoints || [];
    if (wps.length) pts.push(wps[wps.length - 1]);
    MapView.frameBounds(pts);
  }

  // ── Batch generation (phase 2) and coverage sampling (phase 3) ──────────────

  // Physically consistent conditions, rather than independent sliders: rain
  // without a wet road, or fog with a clear sky, is not a condition anyone
  // drives in. Snow and dust are left out — CARLA 0.9.15 renders neither.
  const WEATHER_PRESETS = {
    klar:       {},
    bewoelkt:   { cloudy: 0.8 },
    regen:      { cloudy: 0.8, rainy: 0.6, wet_road: 0.8 },
    starkregen: { cloudy: 1.0, rainy: 1.0, wet_road: 1.0, fog: 0.2 },
    nebel:      { cloudy: 0.5, fog: 0.7 },
    nass:       { cloudy: 0.3, wet_road: 0.7 },
  };
  const TIMES = ['daytime', 'morning', 'dusk', 'nighttime'];
  // The towns the CARLA build run.sh starts actually ships (Town10 is a
  // georeferenced map with no CARLA asset; uploaded maps have none either).
  const CARLA_TOWNS = ['Town01', 'Town02', 'Town03', 'Town04', 'Town05', 'Town06', 'Town07', 'Town10HD'];

  function _weatherOf(preset) {
    const w = { fog: 0, rainy: 0, cloudy: 0, sunny: 0, wet_road: 0, snowy: 0, dust_storm: 0 };
    return { ...w, ...(WEATHER_PRESETS[preset] || {}) };
  }

  /**
   * N combinations of the given dimensions ({name: [values]}) chosen greedily
   * so every PAIR of values across two dimensions appears as early as
   * possible (AETG-style pairwise coverage). Most interactions that break a
   * system involve two factors — "cut-in at night", "pedestrian in fog" — so
   * covering pairs is the cheap substitute for the full cross product, which
   * here would be 5 × 8 × 6 × 4 = 960 scenarios.
   */
  function coveragePlan(n, dims, rng) {
    const names = Object.keys(dims);
    const covered = new Set();
    const pairKeys = combo => {
      const keys = [];
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          keys.push(`${names[i]}=${combo[names[i]]}|${names[j]}=${combo[names[j]]}`);
        }
      }
      return keys;
    };
    // Ties on new pairs go to the combination whose values have been used
    // least so far. Without it the plan covered pairs but not values: with
    // eight scenario types a 9-item all-maps batch landed on only 6 of the 8
    // towns, three of them twice.
    const used = new Map();
    const usage = combo => names.reduce((sum, nm) => sum + (used.get(`${nm}=${combo[nm]}`) || 0), 0);
    const plan = [];
    for (let k = 0; k < n; k++) {
      let best = null, bestScore = -Infinity;
      for (let c = 0; c < 40; c++) {
        const combo = Object.fromEntries(names.map(nm => [nm, rng.pick(dims[nm])]));
        const gain = pairKeys(combo).filter(p => !covered.has(p)).length;
        const score = gain * 1000 - usage(combo);
        if (score > bestScore) { best = combo; bestScore = score; }
      }
      pairKeys(best).forEach(p => covered.add(p));
      names.forEach(nm => used.set(`${nm}=${best[nm]}`, (used.get(`${nm}=${best[nm]}`) || 0) + 1));
      plan.push(best);
    }
    return plan;
  }

  /** Switch the editor's map through the real selector and wait for both the
   * render data and the lane graph — the same path a user's pick takes, so
   * nothing about the map is set up differently for a batch. */
  async function _loadMap(town) {
    if (AppState.map === town && AppState.mapData && AppState.laneGraph) return true;
    const select = document.getElementById('map-select');
    if (![...select.options].some(o => o.value === town)) return false;
    select.value = town;
    select.dataset.keepScenario = '1';   // toolbar.js: this switch must not clear
    select.dispatchEvent(new Event('change'));
    for (let i = 0; i < 600; i++) {
      await new Promise(r => setTimeout(r, 50));
      if (AppState.map === town && AppState.mapData && AppState.laneGraph) return true;
    }
    return false;
  }

  const _tick = () => new Promise(r => setTimeout(r, 0));

  /**
   * Generate `count` scenarios and return {entries, skipped}: one export entry
   * per scenario, {name, params, scenario, meta}, ready for /api/export/batch.
   *
   * The editor's own scenario (actors, weather, time, map) is put back exactly
   * at the end, and nothing here records an undo entry. Each candidate is
   * swapped into AppState by plain assignment, not set(): buildScenarioParams
   * and toJSON read AppState, but nothing needs to render or record them.
   */
  async function generateBatch({
    count = 50, typeKey = null, seed = null,
    balance = true, varyWeather = true, maps = 'current',
    onProgress = () => {}, isCancelled = () => false,
  } = {}) {
    const baseSeed = Number(seed) > 0 ? Math.floor(Number(seed)) : _randomSeed();
    const rng = new Rng(baseSeed);
    const towns = maps === 'carla'
      ? CARLA_TOWNS.filter(t => [...document.getElementById('map-select').options].some(o => o.value === t))
      : [AppState.map];
    const dims = {
      town: towns,
      type: typeKey ? [typeKey] : Object.keys(TYPES),
      weather: varyWeather ? Object.keys(WEATHER_PRESETS) : ['__keep'],
      time: varyWeather ? TIMES : ['__keep'],
    };
    let plan = coveragePlan(count, dims, rng);
    // Without balancing the type is the generator's own random pick instead.
    if (!balance && !typeKey) plan = plan.map(p => ({ ...p, type: null }));
    // One map load per town, not one per scenario.
    plan = plan.map((p, i) => ({ ...p, i })).sort((a, b) => towns.indexOf(a.town) - towns.indexOf(b.town) || a.i - b.i);

    Simulate.stop();
    const saved = {
      map: AppState.map,
      state: JSON.parse(JSON.stringify({
        ego: AppState.ego, npcs: AppState.npcs, staticObjects: AppState.staticObjects,
        trafficSignals: AppState.trafficSignals, weather: AppState.weather, time: AppState.time,
      })),
    };
    AppState.cancelPlacement();
    AppState.select(null);
    UndoStack.suspend();
    const entries = [];
    const skipped = [];
    try {
      for (let k = 0; k < plan.length; k++) {
        if (isCancelled()) break;
        const item = plan[k];
        if (!(await _loadMap(item.town)) || !AppState.laneGraph) {
          skipped.push({ town: item.town, type: item.type, reason: 'Karte nicht geladen' });
          continue;
        }
        const s = baseSeed + item.i;
        // A type this map cannot host (cut-in on single-lane Town01) falls
        // back to any type rather than leaving a hole in the batch.
        let r = build(item.type, s);
        let fellBack = false;
        if (!r && item.type) { r = build(null, s); fellBack = !!r; }
        if (!r) {
          skipped.push({ town: item.town, type: item.type, seed: s, reason: 'kein passender Ort' });
          onProgress(k + 1, plan.length, entries.length);
          await _tick();
          continue;
        }
        AppState.ego = r.ego;
        AppState.npcs = r.npcs;
        AppState.staticObjects = r.props;
        AppState.trafficSignals = r.trafficSignals;
        if (item.weather !== '__keep') {
          AppState.weather = _weatherOf(item.weather);
          AppState.time = item.time;
        } else {
          AppState.weather = JSON.parse(JSON.stringify(saved.state.weather));
          AppState.time = saved.state.time;
        }
        const problems = ScenarioIO.validate().errors;
        if (problems.length) {
          skipped.push({ town: item.town, type: r.info.type, seed: s, reason: problems[0] });
          continue;
        }
        const n = String(entries.length + 1).padStart(4, '0');
        entries.push({
          name: `${n}_${item.town}_${r.info.type}_s${s}`,
          params: ScenarioIO.buildParams(),
          scenario: AppState.toJSON(),
          meta: {
            index: entries.length + 1, seed: s, town: item.town, type: r.info.type,
            label: r.info.label, type_fallback: fellBack,
            weather: item.weather === '__keep' ? 'editor' : item.weather,
            time: AppState.time, ego_speed: r.info.ego_speed, route_m: r.info.route_m,
            attempts: r.info.attempts, params: r.info.params,
          },
        });
        onProgress(k + 1, plan.length, entries.length);
        await _tick();   // let the progress bar paint, and Abbrechen be clicked
      }
    } finally {
      if (saved.map && saved.map !== AppState.map) await _loadMap(saved.map);
      Object.assign(AppState, saved.state);
      UndoStack.resume();
      // emit, not set(): no undo entry. NOT 'stateLoaded' — app.js clears the
      // undo history on that. The weather sliders need no resync either: only
      // AppState.weather was swapped, never the DOM, and it is back as it was.
      AppState.emit('change', {});
      MapView.renderAllActors();
    }
    return { entries, skipped, seed: baseSeed, cancelled: isCancelled() };
  }

  // ── Batch dialog ─────────────────────────────────────────────────────────────

  let _batchRunning = false;
  let _batchCancel = false;

  function _openBatch() {
    if (!AppState.mapData) { Toast.error('Zuerst eine Karte laden'); return; }
    const sel = document.getElementById('gen-batch-type');
    if (!sel.options.length) {
      sel.add(new Option('Beliebig', ''));
      for (const [key, t] of Object.entries(TYPES)) sel.add(new Option(t.label, key));
    }
    document.getElementById('gen-batch-progress').classList.add('hidden');
    document.getElementById('gen-batch-overlay').classList.remove('hidden');
    document.getElementById('gen-batch-count').focus();
  }

  function _closeBatch() {
    if (_batchRunning) { _batchCancel = true; return; }
    document.getElementById('gen-batch-overlay').classList.add('hidden');
  }

  async function _runBatch(e) {
    e.preventDefault();
    if (_batchRunning) return;
    const val = id => document.getElementById(id).value;
    const count = Math.max(1, Math.min(1000, Math.floor(Number(val('gen-batch-count')) || 0)));
    const startBtn = document.getElementById('gen-batch-start');
    const status = document.getElementById('gen-batch-status');
    const fill = document.getElementById('gen-batch-bar-fill');
    document.getElementById('gen-batch-progress').classList.remove('hidden');
    _batchRunning = true;
    _batchCancel = false;
    startBtn.disabled = true;
    try {
      const res = await generateBatch({
        count, typeKey: val('gen-batch-type') || null,
        seed: val('gen-batch-seed') || null, maps: val('gen-batch-maps'),
        balance: document.getElementById('gen-batch-balance').checked,
        varyWeather: document.getElementById('gen-batch-weather').checked,
        onProgress: (done, total, made) => {
          fill.style.width = `${Math.round(done / total * 100)}%`;
          status.textContent = `${done} / ${total} geplant · ${made} erzeugt`;
        },
        isCancelled: () => _batchCancel,
      });
      // Abbrechen means abort: nothing is downloaded, not a partial batch.
      if (res.cancelled) {
        Toast.info('Stapel-Generierung abgebrochen — nichts heruntergeladen');
        document.getElementById('gen-batch-overlay').classList.add('hidden');
        return;
      }
      if (!res.entries.length) {
        Toast.error('Kein Szenario erzeugt — keine passenden Orte für diese Auswahl');
        return;
      }
      status.textContent = `${res.entries.length} Szenarien werden exportiert …`;
      const town = val('gen-batch-maps') === 'carla' ? 'alle_karten' : AppState.map;
      const filename = `szenarien_${town}_${res.entries.length}_s${res.seed}.zip`;
      const out = await Api.exportBatch({ scenarios: res.entries, filename });
      ScenarioIO.downloadBlob(out.blob, filename);
      const notes = [];
      if (res.skipped.length) notes.push(`${res.skipped.length} ohne passenden Ort übersprungen`);
      if (out.failed) notes.push(`${out.failed} Export fehlgeschlagen (siehe manifest)`);
      Toast.success(`${out.ok} Szenarien exportiert${notes.length ? ' · ' + notes.join(' · ') : ''}`, 8000);
      document.getElementById('gen-batch-overlay').classList.add('hidden');
    } catch (err) {
      Toast.error(`Stapel-Generierung fehlgeschlagen: ${err.message}`);
    } finally {
      _batchRunning = false;
      startBtn.disabled = false;
    }
  }

  (function _bindBatchDialog() {
    const form = document.getElementById('gen-batch-form');
    if (!form) return;
    form.addEventListener('submit', _runBatch);
    document.getElementById('gen-batch-cancel').addEventListener('click', _closeBatch);
    // Capture + stopPropagation, like the confirm dialog: Esc closes this and
    // must not also cancel a tool or a path being drawn behind it.
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || document.getElementById('gen-batch-overlay').classList.contains('hidden')) return;
      e.stopPropagation();
      _closeBatch();
    }, true);
  })();

  // ── Recipe panel (Übersicht tab) ─────────────────────────────────────────────
  //
  // The generated scenario's parameters as editable fields. Changing one pins
  // it and rebuilds the scenario on the same site and seed; „Variante würfeln"
  // keeps the pins and draws everything else afresh. Rendered by properties.js
  // (recipeHtml / bindRecipe), like the template panel.

  const _escHtml = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /** The value the build actually used — not the pin, which the site may
   * not have allowed (an occluder needs a parking lane; a lead faster than
   * the ego is capped). _recipeMismatch says when the two differ. */
  function _recipeValue(r, spec) {
    const v = r.params?.[spec.key];
    if (spec.kind === 'bool') return !!v;
    if (spec.kind === 'num') {
      if (v === null || v === undefined || v === false) return spec.key === 'stops_in_lane_s' ? 0 : '';
      return v;
    }
    return v ?? '';
  }

  function _recipeControl(r, spec) {
    const v = _recipeValue(r, spec);
    const attr = `data-recipe-key="${spec.key}" aria-label="${_escHtml(spec.label)}"`;
    if (spec.kind === 'bool') return `<input type="checkbox" ${attr}${v ? ' checked' : ''}>`;
    if (spec.kind === 'choice') {
      const opts = spec.options.map(([k, l]) => `<option value="${k}"${k === v ? ' selected' : ''}>${_escHtml(l)}</option>`).join('');
      return `<select ${attr}>${opts}</select>`;
    }
    return `<input type="number" ${attr} min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${v === '' ? '' : _escHtml(v)}">`;
  }

  function _recipeMismatch(r, spec) {
    if (!Object.prototype.hasOwnProperty.call(r.overrides || {}, spec.key)) return false;
    const want = r.overrides[spec.key], got = _recipeValue(r, spec);
    if (spec.kind === 'num') return got === '' || Math.abs(Number(got) - want) > spec.step / 2 + 1e-6;
    return got !== want;
  }

  /** The recipe block for the overview panel, or '' when nothing generated. */
  function recipeHtml() {
    const r = AppState.generated;
    if (!r || !PARAMS[r.type]) return '';
    const pins = r.overrides || {};
    const rows = [EGO_SPEED, ...PARAMS[r.type]].map(spec => {
      const pinned = Object.prototype.hasOwnProperty.call(pins, spec.key);
      const unpin = pinned
        ? `<button type="button" class="gen-recipe-unpin" data-recipe-unpin="${spec.key}" title="Festgelegten Wert lösen — wieder zufällig aus dem Seed">×</button>`
        : '<span></span>';
      const miss = _recipeMismatch(r, spec);
      const missTitle = miss
        ? ` title="Festgelegt auf ${_escHtml(spec.kind === 'choice' ? (spec.options.find(([k]) => k === pins[spec.key]) || [, pins[spec.key]])[1] : pins[spec.key])}, an dieser Stelle nicht möglich"`
        : '';
      return `<div class="gen-recipe-row${pinned ? ' pinned' : ''}${miss ? ' unmet' : ''}" data-recipe-row="${spec.key}">
        <span class="gen-recipe-label"${missTitle}>${_escHtml(spec.label)}${miss ? ' ⚠' : ''}</span>
        ${_recipeControl(r, spec)}
        <span class="gen-recipe-unit">${_escHtml(spec.unit || '')}</span>
        ${unpin}
      </div>`;
    }).join('');
    const wrongTown = r.town && r.town !== AppState.map;
    const warn = wrongTown
      ? `<div class="gen-recipe-warn">Gebaut auf ${_escHtml(r.town)} — Karte wechseln, um neu zu bauen.</div>`
      : recipeEdited()
        ? '<div class="gen-recipe-warn">Seit dem Generieren von Hand bearbeitet — eine Änderung hier baut neu und verwirft das.</div>'
        : '';
    return `<div class="gen-recipe" data-recipe>
      <div class="summary-section">Generiert</div>
      <div class="gen-recipe-head"><b>${_escHtml(r.label)}</b><span>Seed ${_escHtml(r.seed)}</span></div>
      ${warn}
      <div class="gen-recipe-grid">${rows}</div>
      <div class="gen-recipe-actions">
        <button type="button" class="btn btn-small btn-secondary" data-recipe-variant
                title="Neuer Seed an derselben Stelle; fest eingestellte Werte bleiben">Variante würfeln</button>
      </div>
      ${wrongTown ? '' : _sweepHtml(r)}
      <div class="summary-hint">Ein geänderter Wert wird festgelegt (●) und das Szenario an derselben Stelle neu gebaut.</div>
    </div>`;
  }

  // Remembered across re-renders: the overview rebuilds its innerHTML wholesale.
  const _sweepUi = { open: false, key: null, from: null, to: null, steps: 5, weathers: false };

  function _sweepHtml(r) {
    const specs = [EGO_SPEED, ...PARAMS[r.type]];
    if (!specs.some(sp => sp.key === _sweepUi.key)) {
      const firstNum = specs.find(sp => sp.kind === 'num' && sp.key !== 'ego_speed') || specs[0];
      Object.assign(_sweepUi, { key: firstNum.key, from: firstNum.min, to: firstNum.max });
    }
    const spec = specs.find(sp => sp.key === _sweepUi.key);
    const values = _sweepValues(spec, _sweepUi.from, _sweepUi.to, _sweepUi.steps);
    const total = Math.min(SWEEP_MAX, values.length * (_sweepUi.weathers ? Object.keys(WEATHER_PRESETS).length : 1));
    const opts = specs.map(sp => `<option value="${sp.key}"${sp.key === spec.key ? ' selected' : ''}>${_escHtml(sp.label)}</option>`).join('');
    const range = spec.kind === 'num'
      ? `<label>Von</label><input type="number" data-sweep-from min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${_sweepUi.from}">
         <label>Bis</label><input type="number" data-sweep-to min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${_sweepUi.to}">
         <label>Werte</label><input type="number" data-sweep-steps min="2" max="25" step="1" value="${_sweepUi.steps}">`
      : `<span class="gen-sweep-all">alle Werte: ${values.map(v => _escHtml(spec.kind === 'bool' ? (v ? 'ja' : 'nein') : spec.options.find(([k]) => k === v)[1])).join(', ')}</span>`;
    return `<details class="gen-sweep" data-sweep${_sweepUi.open ? ' open' : ''}>
      <summary>Serie exportieren</summary>
      <div class="gen-sweep-grid">
        <label>Parameter</label><select data-sweep-key>${opts}</select>
        ${range}
      </div>
      <label class="gen-sweep-weather"><input type="checkbox" data-sweep-weather${_sweepUi.weathers ? ' checked' : ''}> × alle Wetter (${Object.keys(WEATHER_PRESETS).length})</label>
      <div class="gen-recipe-actions">
        <button type="button" class="btn btn-small btn-primary" data-sweep-run
                title="Ein Szenario pro Wert an derselben Stelle, als ZIP mit manifest">${total} Szenarien exportieren</button>
      </div>
    </details>`;
  }

  async function _confirmDiscardEdits() {
    if (!recipeEdited()) return true;
    return Confirm.show('Von Hand gemachte Änderungen am Szenario verwerfen und neu bauen?', 'Neu bauen');
  }

  /** Wire the block recipeHtml() rendered. `rerender` redraws the panel, so
   * a rebuild that failed shows the old values again. */
  function bindRecipe(root, rerender) {
    const box = root.querySelector('[data-recipe]');
    if (!box) return;
    const r = AppState.generated;
    const specs = Object.fromEntries([EGO_SPEED, ...(PARAMS[r?.type] || [])].map(sp => [sp.key, sp]));
    const run = async (changes, opts) => {
      if (!(await _confirmDiscardEdits())) { rerender(); return; }
      if (!rebuild(changes, opts)) rerender();
    };
    box.querySelectorAll('[data-recipe-key]').forEach(el => {
      el.addEventListener('change', () => {
        const spec = specs[el.dataset.recipeKey];
        if (!spec) return;
        let v;
        if (spec.kind === 'bool') v = el.checked;
        else if (spec.kind === 'num') {
          if (el.value === '') { rerender(); return; }
          v = Math.min(spec.max, Math.max(spec.min, Number(el.value)));
        } else v = el.value;
        run({ [spec.key]: v });
      });
    });
    box.querySelectorAll('[data-recipe-unpin]').forEach(btn => {
      btn.addEventListener('click', () => run({ [btn.dataset.recipeUnpin]: null }));
    });
    box.querySelector('[data-recipe-variant]')?.addEventListener('click', () => run({}, { newSeed: true }));

    const sweep = box.querySelector('[data-sweep]');
    if (!sweep) return;
    // Recorded on the summary click, not on 'toggle': toggle is dispatched as a
    // later task, and a panel re-render in between draws the box closed again.
    sweep.querySelector('summary').addEventListener('click', () => { _sweepUi.open = !sweep.open; });
    sweep.querySelector('[data-sweep-key]').addEventListener('change', e => {
      const sp = specs[e.target.value];
      Object.assign(_sweepUi, { key: sp.key, from: sp.min, to: sp.max });
      rerender();
    });
    for (const [attr, field] of [['data-sweep-from', 'from'], ['data-sweep-to', 'to'], ['data-sweep-steps', 'steps']]) {
      sweep.querySelector(`[${attr}]`)?.addEventListener('change', e => { _sweepUi[field] = Number(e.target.value); rerender(); });
    }
    sweep.querySelector('[data-sweep-weather]').addEventListener('change', e => { _sweepUi.weathers = e.target.checked; rerender(); });
    sweep.querySelector('[data-sweep-run]').addEventListener('click', () => _runSweep({ ..._sweepUi }));
  }

  // ── Header menu ──────────────────────────────────────────────────────────────

  function _hasScenario() {
    return !!(AppState.ego || AppState.npcs.length || AppState.staticObjects.length);
  }

  /** Generating replaces the whole scenario. It is one undo step, but a
   * scenario that took an hour to author deserves a question first —
   * Strg/Cmd skips it, the app-wide "skip the confirm" modifier. */
  async function _confirmReplace(e) {
    if (!_hasScenario() || e.ctrlKey || e.metaKey) return true;
    return Confirm.show('Aktuelles Szenario durch ein generiertes ersetzen?', 'Ersetzen');
  }

  function _seedFromField() {
    const seedField = document.getElementById('gen-seed');
    return seedField?.value ? Number(seedField.value) : null;
  }

  /** A used seed is cleared so the next click makes a new scenario; the seed
   * that was used is in the toast and on the menu button's tooltip. */
  function _noteUsedSeed(info) {
    const seedField = document.getElementById('gen-seed');
    if (!info || !seedField) return;
    seedField.value = '';
    document.getElementById('gen-menu-btn').title =
      `Zufälliges Szenario erzeugen — zuletzt: ${info.label}, Seed ${info.seed}`;
  }

  /** Arm "Generate here": the next map click builds `typeKey` (null = any
   * type) at that spot. Esc disarms, like every other placement mode. */
  function armAt(typeKey = null) {
    if (!AppState.mapData) { Toast.error('Zuerst eine Karte laden'); return; }
    if (typeKey && !TYPES[typeKey]) return;
    AppState.cancelPlacement({ pendingGenerate: typeKey || 'any' });
    Toast.info(`„${typeKey ? TYPES[typeKey].label : 'Beliebiger Typ'}": Stelle des Konflikts auf der Karte anklicken (Esc bricht ab)`);
  }

  async function generateAtClick(x, y, e) {
    const pending = AppState.pendingGenerate;
    if (!pending) return null;
    const typeKey = pending === 'any' ? null : pending;
    AppState.cancelPlacement();
    if (!(await _confirmReplace(e))) return null;
    const info = generate(typeKey, _seedFromField(), { near: { x, y } });
    // No site here: stay armed, so the next click tries another spot.
    if (!info) AppState.set({ pendingGenerate: pending });
    _noteUsedSeed(info);
    return info;
  }

  async function _onMenuPick(e, typeKey) {
    if (document.getElementById('gen-pick-spot')?.checked) { armAt(typeKey); return; }
    if (!(await _confirmReplace(e))) return;
    _noteUsedSeed(generate(typeKey, _seedFromField()));
  }

  (function _bindMenu() {
    const holder = document.getElementById('gen-menu-types');
    if (!holder) return;
    const row = (label, key, extraClass = '') => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `menu-item ${extraClass}`.trim();
      btn.setAttribute('role', 'menuitem');
      btn.dataset.menuItem = '';
      btn.textContent = label;
      btn.title = 'Strg+Klick ersetzt ohne Rückfrage';
      btn.addEventListener('click', e => _onMenuPick(e, key));
      holder.appendChild(btn);
    };
    row('Beliebiger Typ', null, 'gen-any');
    for (const [key, t] of Object.entries(TYPES)) row(t.label, key);
    const batch = document.createElement('button');
    batch.type = 'button';
    batch.className = 'menu-item gen-batch-item';
    batch.setAttribute('role', 'menuitem');
    batch.dataset.menuItem = '';
    batch.textContent = 'Mehrere generieren …';
    batch.title = 'Viele Szenarien auf einmal erzeugen und als ZIP herunterladen';
    batch.addEventListener('click', _openBatch);
    holder.appendChild(batch);
  })();

  window.ScenarioGenerator = {
    TYPES: Object.fromEntries(Object.entries(TYPES).map(([k, t]) => [k, t.label])),
    build,
    generate,
    assess,
    generateBatch,
    armAt,
    generateAtClick,
    rebuild,
    recipeHtml,
    bindRecipe,
    sweepFromRecipe,
    sceneSignature,
    recipeEdited,
    PARAMS: Object.fromEntries(Object.entries(PARAMS).map(([k, v]) => [k, [EGO_SPEED, ...v].map(sp => sp.key)])),
    weatherPreset: _weatherOf,
    WEATHER_PRESETS: Object.keys(WEATHER_PRESETS),
    coveragePlan(n, dims, seed = 1) { return coveragePlan(n, dims, new Rng(seed)); },
    get lastInfo() { return _lastInfo; },
  };
})();
