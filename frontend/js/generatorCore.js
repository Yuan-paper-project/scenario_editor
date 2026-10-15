/**
 * generatorCore.js — lane network index, seeded RNG, the "generate here" focus and the shared state.
 *
 * Part of the scenario generator; the design is described in scenarioGenerator.js.
 */
(() => {
  'use strict';

  // Every generator file reads what earlier ones defined through `shared` and
  // adds its own with define(). Reading a name that is not defined yet throws,
  // so a file loaded before the one it depends on fails at load, not later.
  const _shared = {};
  window.GeneratorCore = {
    define(names) {
      for (const [k, v] of Object.entries(names)) {
        if (Object.hasOwn(_shared, k)) throw new Error(`GeneratorCore: ${k} defined twice`);
        _shared[k] = v;
      }
    },
    shared: new Proxy(_shared, {
      get(target, k) {
        if (!Object.hasOwn(target, k)) {
          throw new Error(`GeneratorCore: ${String(k)} is not defined yet (check the script order in index.html)`);
        }
        return target[k];
      },
    }),
  };

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

  /** mulberry32 — tiny, fast, and identical in every browser, which is all a
   * reproducible seed needs. */
  class Rng {
    constructor(seed) {
      this._s = seed >>> 0 || 1;
    }
    next() {
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
        if ((r -= w) < 0) return v;
      }
      return pairs[pairs.length - 1][0];
    }
  }

  const r1 = (v) => Math.round(v * 10) / 10;
  const r2 = (v) => Math.round(v * 100) / 100;
  const DEG = 180 / Math.PI;

  function _wrapDeg(deg) {
    return ((((deg + 180) % 360) + 360) % 360) - 180;
  }

  // ── Lane network index ───────────────────────────────────────────────────────

  const _netCache = new WeakMap(); // mapData -> {graph, net}

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
      // Ordinary road lanes long enough to start a corridor on.
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

  function _inPoly(poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i],
        [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
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

  // Mutable generator state, in one object so every generator file sees the
  // same values.
  const _ctx = {
    // Set by build() for one call when the user picked a spot on the map:
    // {x, y, radius, lanes: [{L, s}]}. Every corridor then runs through one of
    // `lanes`, and a candidate is kept only when its conflict happens within
    // `radius` of the click (assess's `at`).
    focus: null,
    // Set by build() for one call: {key: value} the user pinned in the recipe
    // panel (already validated against PARAMS by _cleanOverrides). _p() hands
    // a pinned value back in place of the random draw.
    overrides: null,
    // The info of the last scenario generate() loaded (ScenarioGenerator.lastInfo).
    lastInfo: null,
  };

  /** The random `drawn` value, unless the user pinned `key`. The draw is made
   * either way, so pinning one parameter does not shift every later draw. */
  function _p(key, drawn) {
    return _ctx.overrides && Object.hasOwn(_ctx.overrides, key) ? _ctx.overrides[key] : drawn;
  }
  const FOCUS_RADIUS_M = 40;
  const FOCUS_LANE_REACH_M = [6, 12]; // driving lanes this close to the click; a wider retry from a kerb

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
    const { L: F, s: sF } = rng.pick(_ctx.focus.lanes);
    // Far enough back for a run-up and the conflict's own lead-in, short
    // enough that the corridor still runs on well past the click.
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
    _wrapDeg,
    _network,
    _bbox,
    _inPoly,
    _laneAt,
    _projectOnLane,
    _ctx,
    _p,
    FOCUS_RADIUS_M,
    _focusLanes,
    _focusStart,
  });
})();
