/**
 * generatorCore.js — lane network index, seeded RNG, the "generate here" focus and the shared state.
 *
 * Part of the scenario generator; the design is described in scenarioGenerator.js.
 */
(() => {
  'use strict';

  window.GeneratorCore = UIUtils.sharedScope('GeneratorCore');

  // ── Physical constants the timing is solved against ──────────────────────────

  // The default max_acceleration every vehicle is exported with: in CARLA the ego ramps up.
  const VEHICLE_ACCEL = 3.0;
  // As objectsCore.js gives a waypoint; DistanceCondition is 3-D.
  const WAYPOINT_CLEARANCE = 0.5;
  // Max stray of the computed route from the corridor: half a ~3.5 m lane.
  const ROUTE_TOLERANCE_M = 2.0;
  // Route waypoints go this far past a junction exit: connectors overlap inside it.
  const POST_JUNCTION_WP_M = 8;
  // Attempts per scenario; most fail cheaply before the headless run.
  const MAX_ATTEMPTS = 150;

  // Lane types a crossing walker must clear; sidewalks are not in here.
  const CARRIAGEWAY_TYPES = new Set([
    'driving',
    'parking',
    'shoulder',
    'bidirectional',
    'median',
    'border',
    'restricted',
    'biking',
    'stop',
    'entry',
    'exit',
    'onRamp',
    'offRamp',
  ]);

  // ── Seeded RNG ───────────────────────────────────────────────────────────────

  /** mulberry32: small, fast, identical in every browser. */
  class Rng {
    constructor(seed) {
      this._s = seed >>> 0 || 1;
    }
    next() {
      // biome-ignore lint/suspicious/noAssignInExpressions: mulberry32 verbatim; any rewrite risks changing every seed
      let t = (this._s = (this._s + 0x6d2b79f5) >>> 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    range(a, b) {
      return a + (b - a) * this.next();
    }
    int(a, b) {
      return Math.floor(this.range(a, b + 1));
    }
    pick(arr) {
      return arr[Math.floor(this.next() * arr.length)];
    }
    chance(p) {
      return this.next() < p;
    }
    /** Pick from [[value, weight], ...]. */
    weighted(pairs) {
      const total = pairs.reduce((s, [, w]) => s + w, 0);
      let r = this.next() * total;
      for (const [v, w] of pairs) {
        // biome-ignore lint/suspicious/noAssignInExpressions: the weighted draw every seed depends on, kept as written
        if ((r -= w) < 0) return v;
      }
      return pairs[pairs.length - 1][0];
    }
  }

  const r1 = (v) => Math.round(v * 10) / 10;
  const r2 = (v) => Math.round(v * 100) / 100;
  const DEG = 180 / Math.PI;

  // ── Lane network index ───────────────────────────────────────────────────────

  const _netCache = new WeakMap(); // mapData -> {graph, net}

  /** Every driving lane with geometry, keyed by (road, section, lane), with successors and predecessors. */
  function _network() {
    const md = AppState.mapData;
    const graph = AppState.laneGraph;
    if (!md || !graph) return null;
    const cached = _netCache.get(md);
    if (cached && cached.graph === graph) return cached.net;

    const lanes = new Map();
    const polys = []; // every lane polygon, for the carriageway-edge search
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
          key,
          road,
          lane,
          pts,
          cum,
          length,
          junction: String(road.junction) !== '-1',
          junctionId: String(road.junction),
          record: LaneGraph.laneRecord(graph, Number(road.id), lane.sectionId, lane.laneId),
        });
      }
    }

    const refKey = (ref) => `${ref.roadId}:${ref.sectionId}:${ref.laneId}`;
    const succ = new Map();
    const pred = new Map();
    for (const L of lanes.values()) {
      const next = LaneGraph.realSuccessors(L.record)
        .map(refKey)
        .filter((k) => lanes.has(k));
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
      lanes,
      polys,
      succ,
      pred,
      byJunction,
      refKey,
      startable: [...lanes.values()].filter((L) => !L.junction && L.length >= 25),
    };
    _netCache.set(md, { graph, net });
    return net;
  }

  function _bbox(poly) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const [x, y] of poly) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }

  /** Pose at arc length `s` along a lane (clamped to its ends). */
  function _laneAt(L, s) {
    s = Math.max(0, Math.min(L.length, s));
    let i = 1;
    while (i < L.cum.length - 1 && L.cum[i] < s) i++;
    const a = L.pts[i - 1],
      b = L.pts[i];
    const seg = L.cum[i] - L.cum[i - 1] || 1;
    const t = Math.max(0, Math.min(1, (s - L.cum[i - 1]) / seg));
    return {
      x: a.x + t * (b.x - a.x),
      y: a.y + t * (b.y - a.y),
      z: a.z + t * (b.z - a.z),
      yaw: Math.atan2(b.y - a.y, b.x - a.x) * DEG,
    };
  }

  /** Nearest point on a lane to (x, y): {s, d, x, y, z, yaw}. */
  function _projectOnLane(L, x, y) {
    let best = null;
    for (let i = 1; i < L.pts.length; i++) {
      const a = L.pts[i - 1],
        b = L.pts[i];
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      if (len2 <= 0) continue;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
      const px = a.x + t * dx,
        py = a.y + t * dy;
      const d = Math.hypot(x - px, y - py);
      if (!best || d < best.d) {
        best = {
          d,
          x: px,
          y: py,
          z: a.z + t * (b.z - a.z),
          s: L.cum[i - 1] + t * Math.sqrt(len2),
          yaw: Math.atan2(dy, dx) * DEG,
        };
      }
    }
    return best;
  }

  // ── "Generate here" focus ────────────────────────────────────────────────────

  // Mutable generator state, one object so every generator file sees the same values.
  const _ctx = {
    // „Konflikt hier erzeugen", for one build() call: {x, y, radius, lanes}. Corridors pass one of
    // `lanes`, and a candidate counts only with its conflict within `radius` of the click.
    focus: null,
    // The recipe panel's pins, for one build() call; _p() returns them in place of a draw.
    overrides: null,
    // The info of the last scenario generate() loaded (ScenarioGenerator.lastInfo).
    lastInfo: null,
  };

  /** `drawn`, unless `key` is pinned. The draw is made either way, so later draws do not shift. */
  function _p(key, drawn) {
    return _ctx.overrides && Object.hasOwn(_ctx.overrides, key) ? _ctx.overrides[key] : drawn;
  }
  const FOCUS_RADIUS_M = 40;
  const FOCUS_LANE_REACH_M = [6, 12]; // driving lanes this close to the click; a wider retry from a kerb

  /** Driving lanes near (x, y), either direction, connectors included, with each nearest s. */
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

  /** A start `back` metres upstream of a focus lane, and the lane path to it (the forced route). */
  function _focusStart(rng, net, targetLen) {
    const { L: F, s: sF } = rng.pick(_ctx.focus.lanes);
    // Room for a run-up and lead-in, while the corridor still runs on past the click.
    const back = rng.range(50, Math.max(60, Math.min(220, targetLen - 60)));
    const path = [F.key];
    if (!F.junction && sF >= back + 2) return { L: F, s: sF - back, path };
    let remaining = back - sF;
    let cur = F;
    for (let hop = 0; hop < 15; hop++) {
      const preds = (net.pred.get(cur.key) || [])
        .map((k) => net.lanes.get(k))
        .filter((P) => P && !path.includes(P.key));
      if (!preds.length) {
        // Dead end upstream: start at the top if it is an ordinary lane with run-up.
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

  GeneratorCore.define({
    VEHICLE_ACCEL,
    WAYPOINT_CLEARANCE,
    ROUTE_TOLERANCE_M,
    POST_JUNCTION_WP_M,
    MAX_ATTEMPTS,
    CARRIAGEWAY_TYPES,
    Rng,
    r1,
    r2,
    DEG,
    _network,
    _bbox,
    _laneAt,
    _projectOnLane,
    _ctx,
    _p,
    FOCUS_RADIUS_M,
    _focusLanes,
    _focusStart,
  });
})();
