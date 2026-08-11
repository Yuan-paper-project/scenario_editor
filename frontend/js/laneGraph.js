/**
 * laneGraph.js — CARLA-verified routing + lane topology, cached per town by
 * tests/probe_carla_lane_graph.py (phase 2 of the "in-editor preview
 * fidelity" plan). Loaded once per map into AppState.laneGraph by
 * toolbar.js/mapImport.js; every lookup here degrades to null when the
 * cache is absent (Town10, any uploaded map), and simulate.js falls back to
 * its phase-1 geometric approximations in that case. This module never
 * guesses — it only serves what the cache actually contains.
 *
 * The routing graph is literally agents.navigation.global_route_planner's
 * internal topology (the SAME class atomic_behaviors.py builds for
 * AssignRouteAction and KeepLongitudinalGap's distance planner), dumped
 * as-is by the probe — so porting only needs A* search and path
 * reconstruction, not topology extraction. See probe_carla_lane_graph.py's
 * docstring for the full mapping.
 */
(function () {
  'use strict';

  // ── Graph indexing (built once per loaded lane graph object) ────────────────

  const _indexed = new WeakMap(); // laneGraph -> {nodeById, adjacency, edgeByPair, lanesByKey}

  function _laneKey(roadId, sectionId, laneId) {
    return `${roadId}:${sectionId}:${laneId}`;
  }

  function _index(graph) {
    let idx = _indexed.get(graph);
    if (idx) return idx;

    const nodeById = new Map(graph.nodes.map(n => [n.id, n]));
    const adjacency = new Map();   // nodeId -> [{to, edge}]
    const edgeByPair = new Map();  // "from:to" -> edge
    for (const edge of graph.edges) {
      if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
      adjacency.get(edge.from).push({ to: edge.to, edge });
      edgeByPair.set(`${edge.from}:${edge.to}`, edge);
    }
    const lanesByKey = new Map(graph.lanes.map(l => [_laneKey(l.roadId, l.sectionId, l.laneId), l]));

    idx = { nodeById, adjacency, edgeByPair, lanesByKey };
    _indexed.set(graph, idx);
    return idx;
  }

  function _edgeForLane(graph, roadId, sectionId, laneId) {
    const bySection = graph.roadIdToEdge[String(roadId)];
    const byLane = bySection && bySection[String(sectionId)];
    return byLane && byLane[String(laneId)];
  }

  // ── Per-lane lookups (lane_change feasibility, path-less fork resolution) ──

  /** The cached per-lane record for (roadId, sectionId, laneId) — or null if
   * this town has no cache, or the probe's generate_waypoints pass never
   * sampled this exact lane (e.g. a lane type it happened to skip). */
  function laneRecord(graph, roadId, sectionId, laneId) {
    if (!graph) return null;
    return _index(graph).lanesByKey.get(_laneKey(roadId, sectionId, laneId)) || null;
  }

  /**
   * A record's successors, minus the dead-end self-reference case: the
   * probe's bounded fork-walk (_walk_to_fork) gives up after max_hops without
   * the lane identity ever changing when a road simply has no continuation
   * (a driveway or spur) — that shows up as "successor = itself", which
   * means the same thing as an empty list: no real progress past this point.
   */
  function realSuccessors(record) {
    if (!record) return [];
    return record.successors.filter(s => !(
      s.roadId === record.roadId && s.sectionId === record.sectionId && s.laneId === record.laneId
    ));
  }

  // ── A* routing (ports agents.navigation.global_route_planner._path_search) ─

  // GlobalRoutePlanner(map, 2.0) — the CarlaDataProvider singleton every
  // AssignRouteAction goes through (carla_data_provider.py set_world()).
  const SAMPLING_RESOLUTION_M = 2.0;
  // trace_route's `closest_index + 5` hop across a lane-change edge.
  const LANE_CHANGE_SKIP_AHEAD = 5;

  function _dist3(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
  }

  function _heuristic(a, b) {
    return _dist3(a, b);
  }

  /** Ports _find_closest_in_list — index of the entry nearest `cur`. */
  function _closestIndex(cur, list) {
    let bestIdx = -1, bestDist = Infinity;
    for (let i = 0; i < list.length; i++) {
      const d = _dist3(list[i], cur);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    return bestIdx;
  }

  /** Plain-array A* — these graphs run to hundreds of nodes, not the tens of
   * thousands a binary heap would be worth. Returns an array of node ids, or
   * null if no path connects them. */
  function _astar(idx, startId, goalId) {
    const goalNode = idx.nodeById.get(goalId);
    if (!idx.nodeById.has(startId) || !goalNode) return null;

    const open = new Set([startId]);
    const cameFrom = new Map();
    const gScore = new Map([[startId, 0]]);
    const fScore = new Map([[startId, _heuristic(idx.nodeById.get(startId), goalNode)]]);

    while (open.size) {
      let current = null, currentF = Infinity;
      for (const n of open) {
        const f = fScore.has(n) ? fScore.get(n) : Infinity;
        if (f < currentF) { currentF = f; current = n; }
      }
      if (current === goalId) {
        const path = [current];
        while (cameFrom.has(current)) { current = cameFrom.get(current); path.unshift(current); }
        return path;
      }
      open.delete(current);
      for (const { to, edge } of idx.adjacency.get(current) || []) {
        const tentativeG = gScore.get(current) + (edge.length || 1);
        if (tentativeG < (gScore.has(to) ? gScore.get(to) : Infinity)) {
          cameFrom.set(to, current);
          gScore.set(to, tentativeG);
          fScore.set(to, tentativeG + _heuristic(idx.nodeById.get(to), goalNode));
          open.add(to);
        }
      }
    }
    return null;
  }

  /**
   * Faithful port of GlobalRoutePlanner.trace_route (the CARLA build run.sh
   * uses: yungloon/carla-0.9.15/PythonAPI/carla/agents/navigation/).
   *
   * The three things that make this NOT a simple "concatenate every edge's
   * points" loop, each of which produced a visible backwards excursion when
   * it was missing:
   *   1. `current` is carried across ALL edges and every lane-follow edge is
   *      trimmed to start at the point nearest it — not just the first edge,
   *      or each later edge restarts at its own beginning, behind the actor.
   *   2. A lane-change edge emits exactly TWO points — where we are, then a
   *      bare ~12 m jump `LANE_CHANGE_SKIP_AHEAD` samples into the target
   *      lane. There is no interpolation; that chord is genuine CARLA output.
   *   3. The two destination break conditions stop a leg near its goal.
   *      Without them every leg overshoots to its final edge's exit and the
   *      next leg then jumps back to the authored waypoint.
   *
   * `from` — the LANE-PROJECTED origin {roadId, sectionId, laneId, x, y, z};
   *   trace_route starts from `self._wmap.get_waypoint(origin)`, not the raw
   *   location.
   * `to` — the destination's lane projection in {roadId, sectionId, laneId,
   *   x, y, z} PLUS the raw authored location in {rawX, rawY, rawZ}. Both are
   *   needed and they are different points: the distance break measures
   *   against the raw `destination`, the lane-identity break against the
   *   projected `destination_waypoint`.
   *
   * Returns an array of {x,y,z} in driving order, or null if the graph has
   * no path — including when it doesn't cover one of the two endpoints at
   * all (an off-network lane type, or a town with no cache).
   */
  function route(graph, from, to) {
    if (!graph) return null;
    const idx = _index(graph);
    const fromEdge = _edgeForLane(graph, from.roadId, from.sectionId, from.laneId);
    const toEdge = _edgeForLane(graph, to.roadId, to.sectionId, to.laneId);
    if (!fromEdge || !toEdge) return null;

    const routeNodes = _astar(idx, fromEdge[0], toEdge[0]);
    if (!routeNodes) return null;
    routeNodes.push(toEdge[1]); // _path_search appends the destination edge's own exit node

    const destination = {
      x: to.rawX !== undefined ? to.rawX : to.x,
      y: to.rawY !== undefined ? to.rawY : to.y,
      z: to.rawZ !== undefined ? to.rawZ : (to.z || 0),
    };
    const destinationWaypoint = { x: to.x, y: to.y, z: to.z || 0 };

    let current = { x: from.x, y: from.y, z: from.z || 0 };
    const trace = [];

    for (let i = 0; i < routeNodes.length - 1; i++) {
      const edge = idx.edgeByPair.get(`${routeNodes[i]}:${routeNodes[i + 1]}`);
      if (!edge) return null; // graph inconsistency — bail rather than emit a broken route

      if (edge.type !== 'LANEFOLLOW' && edge.type !== 'VOID') {
        trace.push(current);
        const exitRef = edge.exit;
        const nextPair = _edgeForLane(graph, exitRef.roadId, exitRef.sectionId, exitRef.laneId);
        const nextEdge = nextPair ? idx.edgeByPair.get(`${nextPair[0]}:${nextPair[1]}`) : null;
        if (nextEdge && nextEdge.path.length) {
          const ci = Math.min(nextEdge.path.length - 1,
                              _closestIndex(current, nextEdge.path) + LANE_CHANGE_SKIP_AHEAD);
          current = nextEdge.path[ci];
        } else if (nextEdge) {
          current = nextEdge.exit;
        }
        trace.push(current);
        continue;
      }

      const path = [edge.entry, ...edge.path, edge.exit];
      const closestIndex = _closestIndex(current, path);
      // Every point of one lane-follow edge belongs to that edge's own lane —
      // _build_topology walks a single lane from entry to exit — so the entry's
      // lane ref identifies the whole path. The cache does not stamp a lane ref
      // on individual path points, which is why this uses the edge's.
      const onDestinationLane = edge.entry.roadId === to.roadId
        && edge.entry.sectionId === to.sectionId
        && edge.entry.laneId === to.laneId;

      for (let j = closestIndex; j < path.length; j++) {
        current = path[j];
        trace.push(current);
        if (routeNodes.length - i <= 2
            && _dist3(current, destination) < 2 * SAMPLING_RESOLUTION_M) break;
        if (routeNodes.length - i <= 2 && onDestinationLane) {
          // Compares the loop's START index, not j — faithful to CARLA, which
          // uses `closest_index` here rather than the running index.
          if (closestIndex > _closestIndex(destinationWaypoint, path)) break;
        }
      }
    }
    return trace;
  }

  window.LaneGraph = {
    laneRecord,
    realSuccessors,
    route,
  };
})();
