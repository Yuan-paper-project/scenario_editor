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
    _dist3,
    _walkDirLine,
    _laneAnchor,
    _findLaneByRef,
    _preferredSuccessor,
  } = SimCore.shared;

  /**
   * The lane-projected form of a raw point, carrying BOTH the projection and
   * the raw location — LaneGraph.route needs the projected point as its
   * `current` seed and the raw one for trace_route's distance break, and they
   * are different points.
   */
  function _resolveLaneRef(x, y, z) {
    // 3-D, like the map.get_waypoint() every trace_route endpoint goes through:
    // a waypoint on a bridge deck must not route from the street beneath it.
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
   * Ports `ego_waypoint.next(1)[0]` — the seed for leg 0 only
   * (atomic_behaviors.py ChangeActorWaypoints.initialise).
   *
   * `.next(1.0)` means "1 metre further ALONG THE ROAD", which almost always
   * stays inside the current lane and only crosses into a successor when the
   * lane actually ends within that metre. Reading the cached `successors`
   * list from an arbitrary mid-lane position instead — as this used to — jumps
   * the seed past the whole rest of the current lane, which put leg 0 on the
   * wrong lane entirely and was the main cause of the ego visibly driving
   * backwards for the first second or two.
   *
   * Returns {ref, headingRad} or null; `headingRad` is the lane tangent at the
   * seed, which the runtime's heading filter uses as its initial reference.
   */
  function _seedAssignRouteStart(sim) {
    const near = _laneAnchor(sim.x, sim.y, sim.z);
    if (!near || !near.road) return null;

    // The seed is a waypoint ON a known lane, so its ref is built from that lane
    // rather than re-projected: a seed that has crossed into a successor sits
    // on the shared boundary point, where the nearest-lane projection hands
    // back the lane it just left. That mattered — standing within 1 m of a lane
    // end, CARLA's seed is in the successor, waypoint 0 (the actor's own pose)
    // is then BEHIND it, and the real route drives round the block to come
    // back to it (Town03 road 5 is a 0.8 m stub: a 194 m loop the preview did
    // not show).
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
      // no s on this payload's points — fall back to arc length
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
        // An unranked fork. Path-less driving refuses to guess here, but the
        // seed cannot: past ANY successor, waypoint 0 (the actor's pose) is
        // behind the seed and CARLA routes round to it, so keeping the actor's
        // own point would hide a loop CARLA certainly drives. next()[0] was
        // the highest-numbered road at 73% of the forks in the 8 probed towns.
        const succs = LaneGraph.realSuccessors(record);
        succ = succs.length ? succs.reduce((a, b) => (b.roadId > a.roadId ? b : a)) : null;
      }
      const found = succ ? _findLaneByRef(succ) : null;
      if (!found || (found.lane.directionLine || []).length < 2) {
        // No successor -> CARLA's IndexError path: the seed is the actor's
        // own waypoint.
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
   * Walk `ds` along a lane in OpenDRIVE s — what Waypoint.next(d) advances —
   * from `t` of the way along segment `idx` (dirLine[idx-1] -> dirLine[idx]).
   * Not arc length: on the inside of a curve a lane is shorter than its s
   * span, so an arc-length metre runs off the end of a lane that next(1)
   * stays inside (Town04's ramps). Returns {x, y, z, yaw, ranOut, remaining}
   * with `remaining` the s still to walk past the end, or null when the
   * points carry no s (an older render payload).
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
      // The lane's own end is exclusive: next() landing exactly on it already
      // returns the successor (a generated actor 1 m before a fork does this).
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
   * Faithful port of ChangeActorWaypoints.initialise for a `fastest` route —
   * the locally patched version in the install run.sh actually executes
   * (/home/dellpro2/Antonio/scenario_runner). One trace_route per
   * authored waypoint, then a filter applied to the CONCATENATED result.
   *
   * That filter is not cosmetic: the router genuinely emits points that go
   * backwards (a lane change is a bare ~12 m chord, and a leg can overshoot
   * its goal), and the runtime drops them. Reproducing the routing without
   * the filter is what made the preview show a turn-around that CARLA
   * never performs.
   *
   * Returns the waypoint list, or null if the graph is absent or the very
   * first lane lookup fails — callers then fall back to the raw clicked
   * polyline, badged as approximate.
   */
  function _exactRoute(sim, rawPoints) {
    if (!AppState.laneGraph) return null;
    const seed = _seedAssignRouteStart(sim);
    if (!seed) return null;

    const route = [];
    let fromRef = seed.ref;

    for (const wp of rawPoints) {
      const toRef = _resolveLaneRef(wp.x, wp.y, wp.z);

      // A waypoint's strategy governs the leg that ENDS at it. 'shortest' is
      // appended verbatim — ChangeActorWaypoints does `route.append(element)`
      // outside the routed branch, so neither the >1 m dedup nor the heading
      // filter applies to it, and the actor drives the straight line as drawn.
      //
      // The next 'fastest' leg still starts HERE: CARLA seeds it from
      // carla_route_elements[i - 1] whatever that element's own strategy was,
      // which is exactly what makes an off-lane 'shortest' point before a
      // 'fastest' one a routing seed rather than a free excursion.
      if (wp.strategy === 'shortest') {
        route.push({ x: wp.x, y: wp.y, z: wp.z !== undefined ? wp.z : 0.2 });
        if (toRef) fromRef = toRef;
        continue;
      }

      // No lane under this waypoint, or no path to it: CARLA's NetworkXNoPath
      // branch appends the raw authored point and moves on, rather than
      // abandoning the whole route.
      const trace = toRef ? LaneGraph.route(AppState.laneGraph, fromRef, toRef) : null;
      if (!trace) {
        route.push({ x: wp.x, y: wp.y, z: wp.z !== undefined ? wp.z : 0.2 });
        if (toRef) fromRef = toRef;
        continue;
      }

      for (const p of trace) {
        const last = route[route.length - 1];
        if (last && _dist3(p, last) > ROUTE_DEDUP_MIN_M) {
          const newHeading = Math.atan2(p.y - last.y, p.x - last.x);
          let lastHeading;
          if (route.length > 1) {
            const prev = route[route.length - 2];
            const rx = last.x - prev.x,
              ry = last.y - prev.y,
              rz = (last.z || 0) - (prev.z || 0);
            if (Math.hypot(rx, ry, rz) < ROUTE_SHORT_REF_M) {
              // Too short to yield a meaningful heading; accepting beats
              // rejecting the rest of an otherwise legitimate route.
              route.push(p);
              continue;
            }
            lastHeading = Math.atan2(ry, rx);
          } else {
            lastHeading = seed.headingRad; // lane tangent, not a router chord
          }
          // Deliberately NOT wrapped to [0, pi]: the `> HI` arm is what
          // catches the wrap-around cases, so the raw difference is what the
          // band is calibrated against. Rejects only genuine reversals
          // (~115-246 deg).
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
