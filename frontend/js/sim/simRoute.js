/**
 * simRoute.js — assign_route: the route seed and ChangeActorWaypoints' filter over the routed legs.
 *
 * Part of the in-editor preview (Simulate); see simulate.js.
 */
(() => {
  'use strict';

  const {
    ROUTE_SEED_AHEAD_M,
    ROUTE_DEDUP_MIN_M,
    ROUTE_SHORT_REF_M,
    ROUTE_HEADING_ACCEPT_LO,
    ROUTE_HEADING_ACCEPT_HI,
    _walkDirLine,
    _laneAnchor,
    _findLaneByRef,
    _preferredSuccessor,
  } = SimCore.shared;

  /** A point's lane projection plus the raw point: route() seeds from one, breaks on the other. */
  function _resolveLaneRef(x, y, z) {
    // 3-D like get_waypoint: a point on a bridge deck must not route from the street below.
    const near = _laneAnchor(x, y, z);
    if (!near || !near.road) return null;
    return {
      roadId: Number(near.road.id),
      sectionId: near.lane.sectionId,
      laneId: near.lane.laneId,
      x: near.x,
      y: near.y,
      z: near.z,
      rawX: x,
      rawY: y,
      rawZ: z !== undefined ? z : near.z,
    };
  }

  /**
   * Port of `ego_waypoint.next(1)[0]`, leg 0's seed: 1 m further along the lane,
   * crossing into a successor only if the lane ends within that metre.
   * Returns {ref, headingRad} or null; headingRad seeds the heading filter.
   */
  function _seedAssignRouteStart(sim) {
    const near = _laneAnchor(sim.x, sim.y, sim.z);
    if (!near || !near.road) return null;

    // Built from the lane walked, not re-projected: a boundary point projects back onto
    // the lane just left. Past a lane end CARLA drives round the block to waypoint 0.
    const refOf = (road, lane, p) => ({
      roadId: Number(road.id),
      sectionId: lane.sectionId,
      laneId: lane.laneId,
      x: p.x,
      y: p.y,
      z: p.z,
      rawX: p.x,
      rawY: p.y,
      rawZ: p.z,
    });

    let road = near.road,
      lane = near.lane;
    const dl0 = lane.directionLine;
    const segT =
      Math.hypot(near.x - dl0[near.segIndex - 1][0], near.y - dl0[near.segIndex - 1][1]) /
      (Math.hypot(
        dl0[near.segIndex][0] - dl0[near.segIndex - 1][0],
        dl0[near.segIndex][1] - dl0[near.segIndex - 1][1],
      ) || 1);
    let walked = _walkDirLineS(dl0, near.segIndex, segT, ROUTE_SEED_AHEAD_M);
    if (!walked) {
      // Points carry no s: fall back to arc length.
      const w = _walkDirLine(dl0, near.x, near.y, near.z, near.segIndex, ROUTE_SEED_AHEAD_M);
      walked = { ...w, remaining: ROUTE_SEED_AHEAD_M - w.consumed };
    }
    let headingRad = ((walked.yaw !== null ? walked.yaw : near.laneYaw) * Math.PI) / 180;

    // .next(1.0) walks on through as many successors as the metre reaches.
    for (let hop = 0; walked.ranOut && hop < 8; hop++) {
      const graph = AppState.laneGraph;
      const record = LaneGraph.laneRecord(graph, Number(road.id), lane.sectionId, lane.laneId);
      let succ = _preferredSuccessor(graph, record);
      if (!succ && graph && graph.source === 'xodr') {
        // An unranked fork: the seed must still move on (staying would hide CARLA's loop);
        // next()[0] was the highest road id at 73% of probed forks.
        const succs = LaneGraph.realSuccessors(record);
        succ = succs.length ? succs.reduce((a, b) => (b.roadId > a.roadId ? b : a)) : null;
      }
      const found = succ ? _findLaneByRef(succ) : null;
      if (!found || (found.lane.directionLine || []).length < 2) {
        // No successor: the seed is the actor's own waypoint (CARLA's IndexError path).
        return { ref: refOf(near.road, near.lane, near), headingRad: (near.laneYaw * Math.PI) / 180 };
      }
      road = found.road;
      lane = found.lane;
      const next = _walkDirLineS(lane.directionLine, 1, 0, walked.remaining);
      if (!next) break;
      walked = next;
      if (walked.yaw !== null) headingRad = (walked.yaw * Math.PI) / 180;
    }

    return { ref: refOf(road, lane, walked), headingRad };
  }

  /**
   * Walk `ds` in OpenDRIVE s (what next() advances, not arc length) from `t` along segment
   * `idx`. Returns {x, y, z, yaw, ranOut, remaining}, or null when points carry no s.
   */
  function _walkDirLineS(dirLine, idx, t, ds) {
    if (dirLine.length < 2 || dirLine[0].length < 4) return null;
    const sAt = (i) => dirLine[i][3];
    const sign = sAt(dirLine.length - 1) >= sAt(0) ? 1 : -1;
    const s0 = sAt(idx - 1) + (sAt(idx) - sAt(idx - 1)) * t;
    const target = s0 + sign * ds;
    for (let i = idx; i < dirLine.length; i++) {
      const a = dirLine[i - 1],
        b = dirLine[i];
      // The lane end is exclusive: landing on it is already the successor.
      const last = i === dirLine.length - 1;
      if ((target - b[3]) * sign < (last ? -1e-6 : 1e-9)) {
        const span = b[3] - a[3];
        const f = span ? Math.max(0, Math.min(1, (target - a[3]) / span)) : 1;
        return {
          x: a[0] + (b[0] - a[0]) * f,
          y: a[1] + (b[1] - a[1]) * f,
          z: a[2] + (b[2] - a[2]) * f,
          yaw: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI,
          ranOut: false,
          remaining: 0,
        };
      }
    }
    const a = dirLine[dirLine.length - 2],
      b = dirLine[dirLine.length - 1];
    return {
      x: b[0],
      y: b[1],
      z: b[2],
      yaw: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI,
      ranOut: true,
      remaining: Math.abs(target - b[3]),
    };
  }

  /**
   * Port of ChangeActorWaypoints.initialise (the patched install run.sh runs): one
   * trace_route per waypoint, then its dedup and heading filter over the concatenation,
   * which drop the router's backward points. Null without a graph or a first lane;
   * callers then draw chords.
   */
  function _exactRoute(sim, rawPoints) {
    if (!AppState.laneGraph) return null;
    const seed = _seedAssignRouteStart(sim);
    if (!seed) return null;

    const route = [];
    let fromRef = seed.ref;

    for (const wp of rawPoints) {
      const toRef = _resolveLaneRef(wp.x, wp.y, wp.z);

      // 'shortest' is appended verbatim (no dedup or heading filter). The next 'fastest'
      // leg still starts from it, which makes an off-lane point a routing seed.
      if (wp.strategy === 'shortest') {
        route.push({ x: wp.x, y: wp.y, z: wp.z !== undefined ? wp.z : 0.2 });
        if (toRef) fromRef = toRef;
        continue;
      }

      // No lane or no path: append the raw point and carry on, like CARLA's NetworkXNoPath branch.
      const trace = toRef ? LaneGraph.route(AppState.laneGraph, fromRef, toRef) : null;
      if (!trace) {
        route.push({ x: wp.x, y: wp.y, z: wp.z !== undefined ? wp.z : 0.2 });
        if (toRef) fromRef = toRef;
        continue;
      }

      for (const p of trace) {
        const last = route[route.length - 1];
        if (last && UIUtils.dist3(p, last) > ROUTE_DEDUP_MIN_M) {
          const newHeading = Math.atan2(p.y - last.y, p.x - last.x);
          let lastHeading;
          if (route.length > 1) {
            const prev = route[route.length - 2];
            const rx = last.x - prev.x,
              ry = last.y - prev.y,
              rz = (last.z || 0) - (prev.z || 0);
            if (Math.hypot(rx, ry, rz) < ROUTE_SHORT_REF_M) {
              // Too short for a heading: accept.
              route.push(p);
              continue;
            }
            lastHeading = Math.atan2(ry, rx);
          } else {
            lastHeading = seed.headingRad; // lane tangent, not a router chord
          }
          // Not wrapped to [0, π]: the `> HI` arm catches the wrap-around. Drops ~115–246° reversals.
          const headingDelta = Math.abs(newHeading - lastHeading);
          if (headingDelta < ROUTE_HEADING_ACCEPT_LO || headingDelta > ROUTE_HEADING_ACCEPT_HI) {
            route.push(p);
          }
        } else if (!route.length) {
          route.push(p); // first point of the whole route is unconditional
        }
      }
      fromRef = toRef;
    }
    return route.length >= 2 ? route : null;
  }

  SimCore.define({ _exactRoute });
})();
