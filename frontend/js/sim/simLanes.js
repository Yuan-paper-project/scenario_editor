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

  /** Project (x, y) onto `dirLine`: distance, point, segment index (for _walkDirLine) and heading. */
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
   * Geometric same-direction neighbour lane (offset + heading), the fallback when the
   * lane graph has no answer. Like the real atomic it checks a Driving lane exists but
   * not lane-change legality.
   */
  function _findSameDirectionNeighbor(near, direction) {
    const rad = (near.laneYaw * Math.PI) / 180;
    // Right of travel in this y-down frame: heading +x → right is +y.
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

  // ── Cached lane graph ────────────────────────────────────────────────────────
  // Everything below falls back to the geometry above when there is no graph or a lookup misses.

  /** The render-JSON {road, lane} for a {roadId, sectionId, laneId}; a linear scan, run only at forks. */
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
   * The Driving neighbour on `direction`'s side: the graph's get_left/right_lane answer,
   * trusted even when it says none; the geometric guess only without a graph.
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
    const guess = _findSameDirectionNeighbor({ road: cursor.road, lane: cursor.lane, x, y, laneYaw }, direction);
    return guess ? { road: cursor.road, lane: guess.lane, dirLine: guess.dirLine, verified: false } : null;
  }

  /**
   * The one successor to drive onto without a route, or null. A probed graph's
   * successors[0] is next()'s real choice; an xodr-derived graph has no ranking,
   * so a genuine fork stays unresolved. Routes are unaffected (A* sees every branch).
   */
  function _preferredSuccessor(graph, record) {
    const succs = LaneGraph.realSuccessors(record);
    if (!succs.length) return null;
    if (graph.source === 'xodr' && succs.length > 1) return null;
    return succs[0];
  }

  /** The cursor after `cursor`'s dirLine runs out, via the graph's successors; null if none. */
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
   * Advance a lane cursor by `step` m, chaining onto successors like waypoint.next().
   * Returns {cursor, x, y, z, yaw, ranOut}; ranOut only at a real dead end or without a graph.
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
   * Port of generate_target_waypoint_list_multilane (scenario_helper.py), the plan
   * ChangeActorLateralMotion hands the controller: same-lane points every 2 m for 5 m,
   * ONE point `diagTotal` m ahead on the neighbour (the whole lateral move, no curve),
   * then 2 m steps for 10 m in the target lane. Always one lane. Returns
   * {waypoints, endCursor, verified}, or null like the helper's (None, None).
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
