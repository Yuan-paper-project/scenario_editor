/**
 * simLanes.js — lane geometry and the cached lane graph: anchors, neighbours, successors, lane-change plans.
 *
 * Part of the in-editor preview (Simulate); see simulate.js.
 */
(() => {
  'use strict';

  const {
    LANE_CHANGE_SAME_LANE_M,
    LANE_CHANGE_OTHER_LANE_M,
    LANE_NEIGHBOR_MIN_M,
    LANE_NEIGHBOR_MAX_M,
    LANE_NEIGHBOR_DIR_TOLERANCE_DEG,
    LANE_SEARCH_MAX_DIST_M,
    _angleDiffDeg,
    _walkDirLine,
  } = SimCore.shared;

  // ── Lane geometry (vehicle "no waypoints" mode + lane_change) ───────────────

  function _laneAnchor(x, y, z = null) {
    return ObjectsManager.nearestLaneProjection(x, y, new Set(['driving']), LANE_SEARCH_MAX_DIST_M, z);
  }

  /** Project (x, y) onto `dirLine`, returning the nearest point's distance,
   * position, segment index (the target for _walkDirLine) and local heading. */
  function _nearestPointOnDirLine(dirLine, x, y) {
    let best = null;
    for (let i = 1; i < dirLine.length; i++) {
      const [x0, y0] = dirLine[i - 1],
        [x1, y1] = dirLine[i];
      const dx = x1 - x0,
        dy = y1 - y0;
      const len2 = dx * dx + dy * dy;
      if (len2 <= 0) continue;
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / len2));
      const px = x0 + t * dx,
        py = y0 + t * dy;
      const d = Math.hypot(x - px, y - py);
      if (!best || d < best.d) best = { d, px, py, idx: i, yaw: (Math.atan2(dy, dx) * 180) / Math.PI };
    }
    return best;
  }

  /**
   * A same-direction neighbour lane on the same road, found geometrically
   * (lateral offset + heading alignment) rather than from OpenDRIVE's `side`/
   * laneChange fields, which map_renderer does not emit to the frontend.
   * Mirrors generate_target_waypoint_list_multilane's feasibility gate
   * (a Driving lane must exist) but not its `check=` legality gate, which the
   * real atomic also skips (check=False).
   *
   * This is the phase-1 fallback, used only when AppState.laneGraph has
   * nothing to say (no cache for this town, or the ground truth itself
   * reports no neighbour) — see _laneNeighbor.
   */
  function _findSameDirectionNeighbor(near, direction) {
    const rad = (near.laneYaw * Math.PI) / 180;
    // Right-hand vector in this map's y-down convention (verified: heading
    // +x/east with north-up-on-screen, "right" points +y/south).
    const rightX = -Math.sin(rad),
      rightY = Math.cos(rad);
    let best = null;

    for (const lane of near.road.lanes || []) {
      if (lane === near.lane) continue;
      if (lane.type !== 'driving') continue;
      const dirLine = lane.directionLine;
      if (!dirLine || dirLine.length < 2) continue;

      const bestSeg = _nearestPointOnDirLine(dirLine, near.x, near.y);
      if (!bestSeg) continue;
      if (bestSeg.d < LANE_NEIGHBOR_MIN_M || bestSeg.d > LANE_NEIGHBOR_MAX_M) continue;
      if (_angleDiffDeg(bestSeg.yaw, near.laneYaw) > LANE_NEIGHBOR_DIR_TOLERANCE_DEG) continue;
      const side = (bestSeg.px - near.x) * rightX + (bestSeg.py - near.y) * rightY > 0 ? 'right' : 'left';
      if (side !== direction) continue;
      if (!best || bestSeg.d < best.dist) best = { lane, segIndex: bestSeg.idx, dist: bestSeg.d, dirLine };
    }
    return best;
  }

  // ── Cached CARLA lane graph (phase 2) ────────────────────────────────────────
  //
  // Everything below degrades to the phase-1 approximations above whenever
  // AppState.laneGraph is null (Town10, an uploaded map) or a specific lookup
  // misses — never a crash, never a guess dressed up as ground truth.

  /** The render-JSON {road, lane} pair for a CARLA lane reference
   * {roadId, sectionId, laneId} — a one-time linear scan, acceptable because
   * it only runs when a fork or lane change is actually being resolved, not
   * per frame (same allowance _nearestLaneProjection already relies on). */
  function _findLaneByRef(ref) {
    for (const road of AppState.mapData?.roads || []) {
      if (String(road.id) !== String(ref.roadId)) continue;
      for (const lane of road.lanes || []) {
        if (lane.sectionId === ref.sectionId && lane.laneId === ref.laneId) return { road, lane };
      }
    }
    return null;
  }

  /**
   * The Driving neighbour lane on `direction`'s side of `cursor`'s lane at
   * point (x, y) — CARLA-verified graph data (get_left_lane()/
   * get_right_lane() ground truth) preferred over the geometric guess.
   *
   * If the graph exists and confidently reports no Driving neighbour on this
   * side, that verdict is trusted outright rather than falling back to a
   * geometric guess that might disagree with it.
   *
   * Returns {road, lane, dirLine, verified} or null.
   */
  function _laneNeighbor(cursor, x, y, laneYaw, direction) {
    const graph = AppState.laneGraph;
    if (graph && cursor.road) {
      const record = LaneGraph.laneRecord(graph, Number(cursor.road.id), cursor.lane.sectionId, cursor.lane.laneId);
      if (record) {
        const ref = record[direction]; // {roadId, sectionId, laneId} or null
        if (!ref) return null; // ground truth: no Driving neighbour here — trust it
        const found = _findLaneByRef(ref);
        if (found && found.lane.directionLine && found.lane.directionLine.length >= 2) {
          return { road: found.road, lane: found.lane, dirLine: found.lane.directionLine, verified: true };
        }
      }
    }
    // _findSameDirectionNeighbor only ever searches cursor.road.lanes, so a
    // geometric guess is always on the same road as the current lane.
    const guess = _findSameDirectionNeighbor({ road: cursor.road, lane: cursor.lane, x, y, laneYaw }, direction);
    return guess ? { road: cursor.road, lane: guess.lane, dirLine: guess.dirLine, verified: false } : null;
  }

  /**
   * The one successor to advance onto without an authored route to
   * disambiguate with — or null when there isn't exactly one usable
   * candidate. A CARLA-probed graph's successors[0] is next()'s own real
   * fork choice, so any non-empty list is usable; an xodr-derived graph
   * (graph.source === 'xodr') makes no such claim about ordering (see
   * backend/lane_graph/lane_graph_builder.py), so a genuine fork — more than one
   * candidate — is left unresolved here rather than guessed. Explicit
   * assign_route waypoints are unaffected by this: LaneGraph.route()'s A*
   * already considers every candidate as a real edge and finds whichever
   * branch reaches the target, with no need to guess first.
   */
  function _preferredSuccessor(graph, record) {
    const succs = LaneGraph.realSuccessors(record);
    if (!succs.length) return null;
    if (graph.source === 'xodr' && succs.length > 1) return null;
    return succs[0];
  }

  /** The next lane cursor after `cursor`'s dirLine runs out, via the cached
   * graph's real successors — or null when there is no graph, no usable
   * successor (see _preferredSuccessor), or the successor isn't a lane the
   * render JSON carries a directionLine for. Shared by lane-following
   * (_continueLaneFollowAtFork) and the lane-change plan builder
   * (_walkLaneChained), which hit exactly the same situation: a lane's
   * polyline ends mid-maneuver and the real controller would simply have
   * continued via waypoint.next(). */
  function _nextLaneCursor(cursor) {
    const graph = AppState.laneGraph;
    const { road, lane } = cursor;
    if (!graph || !road) return null;
    const record = LaneGraph.laneRecord(graph, Number(road.id), lane.sectionId, lane.laneId);
    const succ = _preferredSuccessor(graph, record);
    if (!succ) return null;
    const found = _findLaneByRef(succ);
    if (!found || !found.lane.directionLine || found.lane.directionLine.length < 2) return null;
    return { road: found.road, lane: found.lane, dirLine: found.lane.directionLine, idx: 0 };
  }

  /**
   * Advances a lane cursor {road, lane, dirLine, idx} by up to `step` metres
   * of arc length, chaining onto _nextLaneCursor() whenever the polyline
   * runs out — the lane-change equivalent of waypoint.next(step) crossing a
   * lane-section boundary, which _walkDirLine alone cannot do (it only knows
   * about the one lane it was given).
   *
   * Returns {cursor, x, y, z, yaw, ranOut}; ranOut is true only when the
   * step could not be completed AND there was no successor to continue onto
   * — a genuine dead end, or no lane graph for this town.
   */
  function _walkLaneChained(cursor, x, y, z, step) {
    let cur = cursor;
    let cx = x,
      cy = y,
      cz = z,
      yaw = null;
    let remaining = step;
    while (remaining > 1e-9) {
      const r = _walkDirLine(cur.dirLine, cx, cy, cz, cur.idx, remaining);
      cx = r.x;
      cy = r.y;
      cz = r.z;
      if (r.yaw != null) yaw = r.yaw;
      cur = { ...cur, idx: r.idx };
      remaining -= r.consumed;
      if (!r.ranOut) break;
      const next = _nextLaneCursor(cur);
      if (!next) return { cursor: cur, x: cx, y: cy, z: cz, yaw, ranOut: true };
      cur = next;
    }
    return { cursor: cur, x: cx, y: cy, z: cz, yaw, ranOut: false };
  }

  /**
   * Ports generate_target_waypoint_list_multilane (scenario_runner's
   * scenario_helper.py) — the exact plan ChangeActorLateralMotion.initialise
   * hands to the vehicle controller, rather than a lateral blend approximating
   * its output. Three legs, step_distance=2 throughout, matching the real
   * defaults ChangeActorLateralMotion passes (_distance_same_lane=5 hardcoded,
   * distance_other_lane=10 hardcoded by the parser call):
   *   - same-lane waypoints every 2 m until 5 m accumulate,
   *   - ONE waypoint `diagTotal` m ahead, projected onto the neighbour lane —
   *     the entire lateral move happens on this single hop; CARLA does not
   *     interpolate a curve here either,
   *   - target-lane waypoints every 2 m until 10 m accumulate.
   * `lane_changes` is always 1 — the editor only ever authors a single lane
   * shift (`RelativeTargetLane/@value` is always ±1 at export).
   *
   * Returns {waypoints, endCursor, verified} or null when a next()-equivalent
   * runs off a genuine dead end (no lane graph for this town, or the
   * successor chain truly ends, or no Driving neighbour on `direction`'s
   * side) — mirrors the helper's `return None, None`.
   */
  function _buildLaneChangePlan(near, direction, diagTotal) {
    const STEP = 2.0;
    let cursor = { road: near.road, lane: near.lane, dirLine: near.lane.directionLine, idx: near.segIndex };
    let x = near.x,
      y = near.y,
      z = near.z;
    const waypoints = [];

    let dist = 0;
    while (dist < LANE_CHANGE_SAME_LANE_M) {
      const r = _walkLaneChained(cursor, x, y, z, STEP);
      if (r.ranOut) return null;
      dist += Math.hypot(r.x - x, r.y - y);
      cursor = r.cursor;
      x = r.x;
      y = r.y;
      z = r.z;
      waypoints.push({ x, y, z });
    }

    const lc = _walkLaneChained(cursor, x, y, z, diagTotal);
    if (lc.ranOut) return null;
    const lcYaw = (_nearestPointOnDirLine(lc.cursor.dirLine, lc.x, lc.y) || {}).yaw ?? near.laneYaw;
    const neighbor = _laneNeighbor(lc.cursor, lc.x, lc.y, lcYaw, direction);
    if (!neighbor) return null;
    const proj = _nearestPointOnDirLine(neighbor.dirLine, lc.x, lc.y);
    if (!proj) return null;
    waypoints.push({ x: proj.px, y: proj.py, z: lc.z });

    let ocursor = { road: neighbor.road, lane: neighbor.lane, dirLine: neighbor.dirLine, idx: proj.idx };
    x = proj.px;
    y = proj.py;
    z = lc.z;
    dist = 0;
    while (dist < LANE_CHANGE_OTHER_LANE_M) {
      const r = _walkLaneChained(ocursor, x, y, z, STEP);
      if (r.ranOut) return null;
      dist += Math.hypot(r.x - x, r.y - y);
      ocursor = r.cursor;
      x = r.x;
      y = r.y;
      z = r.z;
      waypoints.push({ x, y, z });
    }

    return { waypoints, endCursor: ocursor, verified: neighbor.verified };
  }

  SimCore.define({ _laneAnchor, _findLaneByRef, _preferredSuccessor, _nextLaneCursor, _buildLaneChangePlan });
})();
