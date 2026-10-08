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
      L = net.lanes.get(rng.pick(next));
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
    const thw = rng.range(1.0, 3.0);
    const type = rng.weighted(VEHICLE_MIX);
    const trigger = _centreDistance(Math.max(6, thw * vEgo), type);
    const gap0 = trigger + rng.range(15, 35);   // initial gap, ego closes from behind
    if (!_junctionFree(c, gap0 - 6, gap0 + 6)) return null;
    const pose = _corridorAt(c, gap0);
    const vLead = vEgo * rng.range(0.55, 0.8);
    const decel = rng.range(2.5, 8);
    const stopFully = rng.chance(0.7);
    const vEnd = stopFully ? 0 : rng.range(1.5, 4);
    const hold = rng.range(3, 8);

    const lead = _vehicle(type, pose, vLead);
    const events = [
      _routeEvent(lead, _corridorWaypoints(c, gap0)),
      _speedEvent('evt-2', nearEgo(trigger), vEnd, 'rate', decel),
      _speedEvent('evt-3', after('evt-2'), vEnd, 'time', hold),
    ];
    // A full stop that never drives off blocks the ego's lane for the rest of
    // the run (measured in CARLA: the scripted ego covered 45 m and waited out
    // the 60 s stop trigger), so most full stops pull away again.
    const resume = rng.chance(stopFully ? 0.75 : 0.4);
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
    const vNpc = vEgo * rng.range(0.45, 0.7);
    const lcDist = rng.range(10, 22);           // lateral move spread over this many metres
    const trigger = rng.range(8, 26);           // cut in when the ego is this close
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

    const type = rng.weighted(VEHICLE_MIX.filter(([t]) => t !== 'bus'));
    const npc = _vehicle(type, onN, vNpc);
    const events = [{
      id: 'evt-1',
      trigger: nearEgo(trigger),
      action: { type: 'lane_change', direction: npcDir, dynamics: { shape: 'linear', value: r1(lcDist) } },
    }];
    const brakesAfter = rng.chance(0.4);
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
    const type = rng.weighted([['pedestrian', 5], ['child', 2.5], ['cyclist', 2.5]]);
    const prof = VRU_PROFILES[type];
    const v = rng.range(...prof.speed);
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
    const fromRight = rng.chance(0.65);
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
    const dt = rng.range(-0.5, 0.8);
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
    const hesitates = MapView.isWalkerType(type) && rng.chance(0.3);
    let hold = null;
    if (hesitates) {
      hold = rng.range(1.5, 4);
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
    if (type !== 'cyclist' && rng.chance(0.5)) {
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

  function _signalizedNear(x, y, radius = 30) {
    return (AppState.mapData.trafficLights || []).some(tl => Math.hypot(tl.x - x, tl.y - y) < radius);
  }

  /** True when the corridor passes a signalized junction before corridor
   * distance `dLimit` (other than `exceptKey`'s). Every actor obeys reds, and a
   * four-way cycle holds a red for up to ~40 s: measured in CARLA, the ego sat
   * at one for 44 s and reached the crossing pedestrian only as every Act's
   * 60 s stop trigger ended the run. An AV under test waits there too. */
  function _signalBefore(c, dLimit, exceptKey = null) {
    return c.segs.some(sg => sg.L.junction && sg.startD < dLimit && sg.key !== exceptKey && (() => {
      const mid = _laneAt(sg.L, sg.L.length / 2);
      return _signalizedNear(mid.x, mid.y);
    })());
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
   * reach the crossing point at about the same time. At a signalized junction
   * only oncoming traffic is used (it shares the ego's green phase); every
   * actor here obeys red lights, so a perpendicular conflict there would just
   * be resolved by the signal. */
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
      const signalized = _signalizedNear(X.x, X.y);
      if (signalized && approachDiff < 150) continue;
      options.push({ C, X, signalized, oncoming: approachDiff >= 150 });
    }
    if (!options.length) return null;
    const { C, X, signalized, oncoming } = rng.pick(options);

    // From "waiting at the line, pulls out" (6 m) to "approaching from well
    // back" (55 m): the shorter the run-up, the less warning the ego gets.
    const back = _walkBack(rng, net, C.key, rng.range(6, 55));
    if (!back) return null;
    const npcPose = _laneAt(back.L, back.s);
    const vNpc = rng.range(7, 13);
    const npcToX = back.walked + X.sB;
    const tNpc = _timeFromRest(npcToX, vNpc);
    const dt = rng.range(-0.6, 0.8);   // ego arrives this much after the NPC
    const dX = sg.startD + X.sA;
    const sol = _solveTrigger(c, dX, tNpc + dt, vEgo, npcPose);
    if (!sol) return null;

    // Route: past the junction onto C's successor, so A* reproduces C.
    const exitKey = (net.succ.get(C.key) || [])[0];
    const exitL = exitKey && net.lanes.get(exitKey);
    if (!exitL) return null;
    const exitPose = _laneAt(exitL, Math.min(POST_JUNCTION_WP_M, exitL.length - 0.5));

    const type = rng.weighted([['car', 6], ['van', 2], ['truck', 1], ['motorcycle', 1], ['police', 0.5], ['ambulance', 0.5]]);
    const npc = _vehicle(type, npcPose, 0);
    npc.events = [
      _routeEvent(npc, [_routeWp(exitPose)]),
      // A rate ramp at the controller's own acceleration, so the preview's
      // timing and CARLA's agree (a 'time' step is instant in the preview but
      // ramps at 3 m/s² in CARLA).
      _speedEvent('evt-2', nearEgo(sol.radius), vNpc, 'rate', VEHICLE_ACCEL),
    ];
    return {
      corridor: c, npcs: [npc], props: [],
      // Its own junction may be signalized (oncoming conflicts only, above).
      conflictD: dX, conflictJunctionKey: J.key,
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
    const variant = rng.weighted([['cargo', 1], ['workzone', 1], ['breakdown', 1]]);
    const side = rng.chance(0.7) ? 1 : -1;   // which edge of the lane it sits toward
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

  /* Oncoming drift. A car in the opposite lane drifts over the centre line
   * toward the ego when they are a chosen time apart — an inattentive or
   * overtaking driver. lane_offset, so it holds (see CLAUDE.md: an offset has
   * no end; every Act's stop trigger ends it). */
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
    const vNpc = rng.range(8, 14);
    const runUp = _egoRunUp(vEgo) + 20;
    const options = [];
    for (const sg of c.segs) {
      if (sg.L.junction) continue;
      const O = _oncomingLane(net, sg);
      if (O && !O.junction) options.push({ sg, O });
    }
    if (!options.length) return null;
    const { sg, O } = rng.pick(options);

    // Both drive from t = 0, so they meet where their distances add up to the
    // initial gap: d_meet = dNpc · vEgo / (vEgo + vNpc). The meeting has to be
    // past the ego's run-up and on this two-way stretch.
    const share = vEgo / (vEgo + vNpc);
    const dMeetLo = Math.max(runUp, sg.startD + 15);
    const dNpcLo = dMeetLo / share;
    const dNpcHi = sg.endD - 5;
    if (dNpcLo > dNpcHi) return null;
    const dNpc = rng.range(dNpcLo, dNpcHi);
    const dMeet = dNpc * share;
    const at = _corridorAt(c, dNpc);
    const onO = _projectOnLane(O, at.x, at.y);
    if (!onO || onO.d > 6) return null;
    // The NPC must still be on its lane, driving toward the ego, at the meeting.
    if (onO.s + (dNpc - dMeet) + 10 > O.length) return null;

    const ttc = rng.range(1.2, 3.5);                 // closing time when the drift starts
    const trigger = (vEgo + vNpc) * ttc;
    if (trigger > dNpc - 10) return null;             // would fire at spawn
    // Metres toward the ego's lane. Under ~1.4 m (lane 3.5 m minus a 2.1 m
    // car) the two only brush past; most draws cross that.
    const offset = rng.range(1.2, 2.8);
    const type = rng.weighted([['car', 6], ['van', 2], ['truck', 1], ['motorcycle', 1]]);
    const npc = _vehicle(type, onO, vNpc);
    npc.events = [{
      id: 'evt-1', trigger: nearEgo(trigger),
      // The ego's lane is on the oncoming driver's LEFT; positive offset is
      // right of travel in lane_offset, so the side is stated, not the sign.
      action: { type: 'lane_offset', direction: 'left', offset: r1(offset) },
    }];
    return {
      corridor: c, npcs: [npc], props: [],
      conflictD: dMeet + 10,
      params: {
        npc_type: type, npc_speed: r1(vNpc), spawn_ahead_m: r1(dNpc),
        drift_ttc_s: r2(ttc), trigger_m: r1(trigger), offset_m: r1(offset),
      },
      routedNpcs: [],
    };
  }

  /* Cyclist ahead. A slower cyclist rides at the right edge of the ego's lane;
   * the ego has to follow or pass. Half of them swerve out toward the lane
   * centre as the ego closes in — around a parked car or a pothole. */
  function _cyclistAhead(rng, net, vEgo) {
    const c = _buildCorridor(rng, net, rng.range(200, 300));
    if (!c) return null;
    const vBike = rng.range(3, 6);
    const gap0 = rng.range(30, 60);
    const tCatch = gap0 / (vEgo - vBike);
    // A cyclist has no route (assign_route is for vehicles the planner routes,
    // and `bike` is not one), so it lane-follows: keep its whole ride before
    // the ego catches it on one straight stretch, where there is no fork to
    // guess at.
    if (!_junctionFree(c, gap0 - 8, gap0 + vBike * tCatch + 25)) return null;
    const pose = _corridorAt(c, gap0);
    const edgeOffset = rng.range(0.8, 1.2);
    const bike = _vehicle('cyclist', pose, vBike);
    const events = [{
      id: 'evt-1', trigger: nearEgo(400),   // at once: rides at the edge from the start
      action: { type: 'lane_offset', direction: 'right', offset: r1(edgeOffset) },
    }];
    const swerves = rng.chance(0.5);
    let swerveTtc = null;
    if (swerves) {
      swerveTtc = rng.range(1.2, 3.5);
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

  const TYPES = {
    lead_brake:        { label: 'Vorausfahrzeug bremst', build: _leadBrake },
    cut_in:            { label: 'Einscheren',            build: _cutIn },
    vru_crossing:      { label: 'Querende Person',       build: _vruCrossing },
    junction_conflict: { label: 'Querverkehr Kreuzung',  build: _junctionConflict },
    obstacle:          { label: 'Hindernis auf Spur',    build: _obstacle },
    oncoming_drift:    { label: 'Gegenverkehr driftet',  build: _oncomingDrift },
    cyclist_ahead:     { label: 'Radfahrer voraus',      build: _cyclistAhead },
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

  // ── Criticality (phase 2) ────────────────────────────────────────────────────
  //
  // Every candidate is run through the preview headlessly, with an ego that
  // does NOT react — the preview never brakes for anyone, which is exactly the
  // counterfactual a criticality metric wants: "what happens if the system
  // under test does nothing". From that run:
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
   * {difficulty, ttc_s, decel_mps2, min_gap_m, conflict_with, verdict}
   * where verdict is 'ok' | 'trivial' | 'unavoidable' | 'no_run'.
   */
  function assess(cand) {
    const run = Simulate.runHeadless({ dt: 0.05, maxTime: 45, ego: cand.ego, npcs: cand.npcs });
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
      const trig = (o.a.events || [])
        .filter(e => (threatId ? e.id === threatId : e.trigger?.type === 'distance_to_ego'))
        .map(e => run.fired[o.a.id]?.[e.id]).filter(t => t != null);
      const hasEvents = (o.a.events || []).length > 0;
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
      let contact = null, minGap = Infinity;
      for (let i = i0; i < run.times.length; i++) {
        const ox = o.tr ? o.tr[i].x : o.a.x, oy = o.tr ? o.tr[i].y : o.a.y;
        if (Math.hypot(ox - egoTr[i].x, oy - egoTr[i].y) > 25) continue;   // cheap reject
        const g = _quadGap(_corners(egoTr[i].x, egoTr[i].y, egoH[i], egoFp),
                           _corners(ox, oy, h ? h[i] : o.a.yaw / DEG, fp));
        minGap = Math.min(minGap, g);
        if (g < 0) { contact = i; break; }
      }
      let entry;
      if (contact != null) {
        const ttc = run.times[contact] - (i0 ? run.times[i0] : 0);
        let travel = 0;
        for (let i = i0 + 1; i <= contact; i++) travel += Math.hypot(egoTr[i].x - egoTr[i - 1].x, egoTr[i].y - egoTr[i - 1].y);
        const v = egoTr[i0].speed;
        const decel = v > 0.1 ? v * v / (2 * Math.max(travel - 0.5, 0.25)) : 0;
        entry = { contact: true, ttc_s: r2(ttc), decel_mps2: r1(decel), min_gap_m: 0, with: o.a.type };
      } else {
        entry = { contact: false, ttc_s: null, decel_mps2: 0, min_gap_m: r1(Math.max(0, minGap)), with: o.a.type };
      }
      // The worst conflict is the one that leaves the least time.
      const key = e => (e.contact ? e.ttc_s : 1000 + e.min_gap_m);
      if (!worst || key(entry) < key(worst)) worst = entry;
    }
    if (!worst) return { verdict: 'trivial', difficulty: null };

    let verdict = 'ok';
    if (!worst.contact && worst.min_gap_m > TRIVIAL_GAP_M) verdict = 'trivial';
    if (worst.contact && (worst.ttc_s < UNAVOIDABLE_TTC_S || worst.decel_mps2 > UNAVOIDABLE_DECEL)) verdict = 'unavoidable';
    let difficulty = 'leicht';
    if (worst.contact) {
      if (worst.decel_mps2 >= 5 || worst.ttc_s < 2) difficulty = 'schwer';
      else if (worst.decel_mps2 >= 2.5 || worst.ttc_s < 3.5) difficulty = 'mittel';
    }
    return {
      verdict, difficulty, ttc_s: worst.ttc_s, decel_mps2: worst.decel_mps2,
      min_gap_m: worst.min_gap_m, conflict_with: worst.with,
    };
  }

  /** 'alle' | 'mittel+' | 'schwer' → does this difficulty pass? */
  function _difficultyOk(filter, difficulty) {
    if (!filter || filter === 'alle') return true;
    if (filter === 'schwer') return difficulty === 'schwer';
    if (filter === 'mittel+') return difficulty === 'mittel' || difficulty === 'schwer';
    return difficulty === filter;
  }

  // ── Public entry point ───────────────────────────────────────────────────────

  let _lastInfo = null;

  function _randomSeed() {
    return Math.floor(Math.random() * 2 ** 31) + 1;
  }

  /**
   * Build a scenario without touching AppState. Returns
   * {ego, npcs, props, info} or null when no attempt fit this map.
   *
   * Every candidate is scored (assess) and dropped when it is trivial or
   * unavoidable, or outside `opts.difficulty` ('alle' | 'mittel+' | 'schwer').
   */
  function build(typeKey = null, seed = null, opts = {}) {
    const net = _network();
    if (!net) return null;
    seed = Number.isFinite(Number(seed)) && Number(seed) > 0 ? Math.floor(Number(seed)) : _randomSeed();
    const rng = new Rng(seed);
    const keys = typeKey ? [typeKey] : Object.keys(TYPES);

    // A difficulty filter throws most finished candidates away, so it gets
    // more tries; each costs one headless run (~20 ms) only once it is built.
    const maxAttempts = opts.difficulty && opts.difficulty !== 'alle' ? MAX_ATTEMPTS + 100 : MAX_ATTEMPTS;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const key = rng.pick(keys);
      const vEgo = Math.round(rng.range(8, 14) * 2) / 2;
      const res = TYPES[key].build(rng, net, vEgo);
      if (!res) continue;
      if (_signalBefore(res.corridor, res.conflictD ?? res.corridor.length, res.conflictJunctionKey)) continue;

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
                                   threats: res.threats });
      if (criticality.verdict !== 'ok') continue;
      if (!_difficultyOk(opts.difficulty, criticality.difficulty)) continue;

      const info = {
        seed, type: key, label: TYPES[key].label, town: AppState.map, attempts: attempt + 1,
        ego_speed: vEgo, route_m: r1(egoEnd), criticality, params: res.params,
      };
      return { ego, npcs: res.npcs, props: res.props, info };
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
    const result = build(typeKey, seed, opts);
    if (!result) {
      Toast.error(`Kein passender Ort für „${typeKey ? TYPES[typeKey].label : 'Szenario'}" auf ${AppState.map} gefunden`);
      return null;
    }
    UndoStack.group('Szenario generiert', () => {
      AppState.select(null);
      AppState.set({
        ego: result.ego,
        npcs: result.npcs,
        staticObjects: result.props,
        trafficSignals: [],
      });
      // The overview panel re-renders off an allow-list that does not include
      // ego/npcs; an empty patch is the codebase's "arrays changed" signal it
      // does listen for (properties.js). Inside the group, so still one undo.
      AppState.set({});
    });
    MapView.renderAllActors();
    _frame(result);

    const problems = [result.ego, ...result.npcs]
      .flatMap(a => ScenarioRules.problemsOf(a).map(p => `${AppState.actorLabel(a)}: ${p.problem.message}`));
    if (problems.length) Toast.warn(`Generiertes Szenario hat Probleme: ${problems.join('; ')}`, 8000);
    else Toast.success(`${result.info.label} generiert · ${_criticalityText(result.info.criticality)} · Seed ${result.info.seed}`);

    _lastInfo = result.info;
    AppState.emit('scenarioGenerated', result.info);
    return result.info;
  }

  /** "schwer (1.6 s, 6.2 m/s²)" — the difficulty and why, for a toast. */
  function _criticalityText(c) {
    if (!c) return '';
    const label = c.difficulty.charAt(0).toUpperCase() + c.difficulty.slice(1);
    return c.ttc_s != null
      ? `${label} (${UIUtils.fmt(c.ttc_s)} s bis Kontakt, ${UIUtils.fmt(c.decel_mps2)} m/s²)`
      : `${label} (kein Kontakt, ${UIUtils.fmt(c.min_gap_m)} m Abstand)`;
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
    const plan = [];
    for (let k = 0; k < n; k++) {
      let best = null, bestGain = -1;
      for (let c = 0; c < 40; c++) {
        const combo = Object.fromEntries(names.map(nm => [nm, rng.pick(dims[nm])]));
        const gain = pairKeys(combo).filter(p => !covered.has(p)).length;
        if (gain > bestGain) { best = combo; bestGain = gain; }
      }
      pairKeys(best).forEach(p => covered.add(p));
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
    count = 50, typeKey = null, difficulty = 'alle', seed = null,
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
        let r = build(item.type, s, { difficulty });
        let fellBack = false;
        if (!r && item.type) { r = build(null, s, { difficulty }); fellBack = !!r; }
        if (!r) {
          skipped.push({ town: item.town, type: item.type, seed: s, reason: 'kein passender Ort' });
          onProgress(k + 1, plan.length, entries.length);
          await _tick();
          continue;
        }
        AppState.ego = r.ego;
        AppState.npcs = r.npcs;
        AppState.staticObjects = r.props;
        AppState.trafficSignals = [];
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
        const c = r.info.criticality;
        entries.push({
          name: `${n}_${item.town}_${r.info.type}_${c.difficulty}_s${s}`,
          params: ScenarioIO.buildParams(),
          scenario: AppState.toJSON(),
          meta: {
            index: entries.length + 1, seed: s, town: item.town, type: r.info.type,
            label: r.info.label, type_fallback: fellBack, difficulty: c.difficulty,
            difficulty_filter: difficulty, ttc_s: c.ttc_s, decel_mps2: c.decel_mps2,
            min_gap_m: c.min_gap_m, conflict_with: c.conflict_with,
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
        count, typeKey: val('gen-batch-type') || null, difficulty: val('gen-batch-difficulty'),
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

  // ── Header menu ──────────────────────────────────────────────────────────────

  function _hasScenario() {
    return !!(AppState.ego || AppState.npcs.length || AppState.staticObjects.length);
  }

  async function _onMenuPick(e, typeKey) {
    // Generating replaces the whole scenario. It is one undo step, but a
    // scenario that took an hour to author deserves a question first —
    // Strg/Cmd skips it, the app-wide "skip the confirm" modifier.
    if (_hasScenario() && !(e.ctrlKey || e.metaKey)) {
      const ok = await Confirm.show('Aktuelles Szenario durch ein generiertes ersetzen?', 'Ersetzen');
      if (!ok) return;
    }
    const seedField = document.getElementById('gen-seed');
    const seed = seedField?.value ? Number(seedField.value) : null;
    const info = generate(typeKey, seed);
    // A used seed is cleared so the next click makes a new scenario; the seed
    // that was used is in the toast and on the menu button's tooltip.
    if (info && seedField) {
      seedField.value = '';
      document.getElementById('gen-menu-btn').title =
        `Zufälliges Szenario erzeugen — zuletzt: ${info.label}, Seed ${info.seed}`;
    }
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
    weatherPreset: _weatherOf,
    WEATHER_PRESETS: Object.keys(WEATHER_PRESETS),
    coveragePlan(n, dims, seed = 1) { return coveragePlan(n, dims, new Rng(seed)); },
    get lastInfo() { return _lastInfo; },
  };
})();
