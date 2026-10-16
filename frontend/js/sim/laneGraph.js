/**
 * laneGraph.js — routing and lane topology over AppState.laneGraph: GlobalRoutePlanner's
 * own graph, probed from CARLA or derived from the .xodr (backend lane_graph/). Only A*
 * and route reconstruction are ported; every lookup returns null when the graph lacks
 * the answer, never a guess.
 */
(() => {
  'use strict';

  // ── Graph indexing (built once per loaded lane graph object) ────────────────

  const _indexed = new WeakMap(); // laneGraph -> {nodeById, adjacency, edgeByPair, lanesByKey}

  function _laneKey(roadId, sectionId, laneId) {
    return `${roadId}:${sectionId}:${laneId}`;
  }

  function _index(graph) {
    let idx = _indexed.get(graph);
    if (idx) return idx;

    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    const adjacency = new Map(); // nodeId -> [{to, edge}]
    const edgeByPair = new Map(); // "from:to" -> edge
    for (const edge of graph.edges) {
      if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
      const pair = `${edge.from}:${edge.to}`;
      const list = adjacency.get(edge.from);
      // networkx keeps one edge per pair; a repeat updates it in place, keeping its adjacency
      // position, which A*'s tie-breaking depends on.
      const existing = edgeByPair.has(pair) ? list.findIndex((a) => a.to === edge.to) : -1;
      if (existing >= 0) list[existing] = { to: edge.to, edge };
      else list.push({ to: edge.to, edge });
      edgeByPair.set(pair, edge);
    }
    const lanesByKey = new Map(graph.lanes.map((l) => [_laneKey(l.roadId, l.sectionId, l.laneId), l]));

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

  /** The per-lane record for (roadId, sectionId, laneId), or null if the graph lacks it. */
  function laneRecord(graph, roadId, sectionId, laneId) {
    if (!graph) return null;
    return _index(graph).lanesByKey.get(_laneKey(roadId, sectionId, laneId)) || null;
  }

  /** A record's successors without a probed graph's self-reference (its dead-end marker). */
  function realSuccessors(record) {
    if (!record) return [];
    return record.successors.filter(
      (s) => !(s.roadId === record.roadId && s.sectionId === record.sectionId && s.laneId === record.laneId),
    );
  }

  // ── A* routing (ports agents.navigation.global_route_planner._path_search) ─

  // GlobalRoutePlanner(map, 2.0), the CarlaDataProvider singleton AssignRouteAction uses.
  const SAMPLING_RESOLUTION_M = 2.0;
  // trace_route's `closest_index + 5` hop across a lane-change edge.
  const LANE_CHANGE_SKIP_AHEAD = 5;

  /** _distance_heuristic, as sqrt(dot) so the float is bit-identical (A* ties hinge on it). */
  function _heuristic(a, b) {
    const dx = a.x - b.x,
      dy = a.y - b.y,
      dz = (a.z || 0) - (b.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** Ports _find_closest_in_list — index of the entry nearest `cur`. */
  function _closestIndex(cur, list) {
    let bestIdx = -1,
      bestDist = Infinity;
    for (let i = 0; i < list.length; i++) {
      const d = UIUtils.dist3(list[i], cur);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  /**
   * Literal port of networkx.astar_path 2.8.8 including its tie-breaking (heap order
   * (f, counter), then adjacency order): lengths are integer sample counts and lane
   * changes cost 0, so equal-cost routes are common. Node ids, or null.
   */
  function _astar(idx, startId, goalId) {
    const goalNode = idx.nodeById.get(goalId);
    if (!idx.nodeById.has(startId) || !goalNode) return null;

    // Binary min-heap of [f, counter, node, dist, parent].
    const heap = [];
    const less = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
    const push = (item) => {
      heap.push(item);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!less(heap[i], heap[p])) break;
        [heap[i], heap[p]] = [heap[p], heap[i]];
        i = p;
      }
    };
    const pop = () => {
      const top = heap[0],
        last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1,
            r = l + 1;
          let m = i;
          if (l < heap.length && less(heap[l], heap[m])) m = l;
          if (r < heap.length && less(heap[r], heap[m])) m = r;
          if (m === i) break;
          [heap[i], heap[m]] = [heap[m], heap[i]];
          i = m;
        }
      }
      return top;
    };

    let counter = 0;
    push([0, counter++, startId, 0, null]);
    const enqueued = new Map(); // node -> [cost, h]
    const explored = new Map(); // node -> parent

    while (heap.length) {
      const [, , cur, dist, parent] = pop();
      if (cur === goalId) {
        const path = [cur];
        for (let n = parent; n !== null; n = explored.get(n)) path.push(n);
        return path.reverse();
      }
      if (explored.has(cur)) {
        if (explored.get(cur) === null) continue;
        if (enqueued.get(cur)[0] < dist) continue;
      }
      explored.set(cur, parent);
      for (const { to, edge } of idx.adjacency.get(cur) || []) {
        const ncost = dist + edge.length;
        let h;
        if (enqueued.has(to)) {
          const [qcost, qh] = enqueued.get(to);
          if (qcost <= ncost) continue;
          h = qh;
        } else {
          h = _heuristic(idx.nodeById.get(to), goalNode);
        }
        enqueued.set(to, [ncost, h]);
        push([ncost + h, counter++, to, ncost, cur]);
      }
    }
    return null;
  }

  /**
   * Port of GlobalRoutePlanner.trace_route. What matters: `current` is carried across
   * all edges and each lane-follow edge is trimmed to start nearest it; a lane-change
   * edge is two points (a bare ~12 m chord); and both destination breaks stop a leg
   * near its goal. `from` is a lane projection {roadId, sectionId, laneId, x, y, z};
   * `to` is the same plus the raw point {rawX, rawY, rawZ} (the distance break uses
   * it). Returns [{x, y, z}] in driving order, or null when there is no path.
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
      z: to.rawZ !== undefined ? to.rawZ : to.z || 0,
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
          const ci = Math.min(nextEdge.path.length - 1, _closestIndex(current, nextEdge.path) + LANE_CHANGE_SKIP_AHEAD);
          current = nextEdge.path[ci];
        } else if (nextEdge) {
          current = nextEdge.exit;
        }
        trace.push(current);
        continue;
      }

      const path = [edge.entry, ...edge.path, edge.exit];
      const closestIndex = _closestIndex(current, path);
      // A lane-follow edge is one lane, so the entry's lane ref covers all its points.
      const onDestinationLane =
        edge.entry.roadId === to.roadId && edge.entry.sectionId === to.sectionId && edge.entry.laneId === to.laneId;

      for (let j = closestIndex; j < path.length; j++) {
        current = path[j];
        trace.push(current);
        if (routeNodes.length - i <= 2 && UIUtils.dist3(current, destination) < 2 * SAMPLING_RESOLUTION_M) break;
        if (routeNodes.length - i <= 2 && onDestinationLane) {
          // The loop's START index, as CARLA compares (closest_index, not j).
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
