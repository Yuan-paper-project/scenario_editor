/**
 * simulate.js — In-editor preview simulation.
 *
 * A per-tick kinematic model of what ScenarioRunner will actually do, not an
 * idealisation of what the author drew. Every actor (ego included) is driven
 * by the same real controllers this scenario exports to
 * (SimpleVehicleControl / PedestrianControl, both in
 * ../../scenario_runner/srunner/scenariomanager/actorcontrols/): they bypass
 * CARLA's vehicle physics entirely and write a target velocity straight onto
 * the actor, so speed is a piecewise-constant step function with no ramps —
 * that is exactly reproducible here, not an approximation. The genuinely
 * unknowable part is road-network topology CARLA's map builder resolves
 * internally (which successor lane a fork-following actor picks, the A*
 * route a `assign_route` action actually drives): this preview does not have
 * that data, so it stops and badges rather than guessing a path it cannot
 * justify. See the "In-editor preview fidelity" plan for the full analysis.
 *
 * All 4 real event triggers (simulation_time, distance_to_ego,
 * distance_to_point, after_event) are evaluated, including the two rewrites
 * the backend applies at export time (assign_route forces its own trigger to
 * simulation_time@0; an after_event chained onto a dropped/assign_route
 * event never fires) — mirrored here so the preview matches the .xosc that
 * export would actually produce, not the raw authored event.
 *
 * set_distance is deliberately NOT simulated (badge only) — its real
 * semantics (a 100 m/s speed spike, then a gap measured in OpenDRIVE `s` or a
 * planned route length) need the same road graph `assign_route` does, and
 * the action may not see real use; simulating it is deferred until it does.
 */
(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ── Playback state ───────────────────────────────────────────────────────────

  let _running    = false;
  let _paused     = false;
  let _simTime    = 0;       // seconds elapsed in simulation
  let _lastFrame  = 0;       // timestamp of last rAF
  let _animId     = null;
  let _speed      = 1.0;     // playback speed multiplier
  let _scenarioEnded = false; // ego reached the 500 m Act stop-trigger
  let _horizon    = 60;      // cosmetic-only estimate for the progress bar

  let _egoId      = null;
  let _originals  = new Map();  // actorId → {x, y, z, yaw}, to restore on stop
  let _simActors  = new Map();  // actorId → sim actor record (see _makeSimActor)
  let _tickSpeeds = new Map();  // actorId → speed, snapshotted once per tick
  let _layerSimBadges = null;   // our own SVG layer, appended into #world

  // ── Tunables mirroring the real controllers ─────────────────────────────────
  // simple_vehicle_control.py / pedestrian_control.py / atomic_behaviors.py —
  // see file header. Kept as named constants rather than inline literals
  // because each one is a specific, cited real-world value, not a preview
  // choice.

  const DISTANCE_TO_EGO_FALLBACK_S = 60.0;  // event_builders.py fallback_time
  const ACT_TEARDOWN_DISTANCE_M = 500.0;    // every Act's StopTrigger
  const VEHICLE_WAYPOINT_ACCEPT_M = 4.0;    // SimpleVehicleControl explicit-waypoint advance
  const VRU_WAYPOINT_ACCEPT_M = 1.0;        // PedestrianControl advance
  const LEADING_WAYPOINT_DROP_M = 0.5;      // both controllers, on activation
  const LANE_CHANGE_SAME_LANE_M = 5.0;      // _distance_same_lane constant
  const LANE_CHANGE_OTHER_LANE_M = 10.0;    // distance_other_lane, hardcoded in the parser call
  const LANE_NEIGHBOR_MIN_M = 1.5;          // plausible adjacent-lane lateral offset band
  const LANE_NEIGHBOR_MAX_M = 6.5;
  const LANE_NEIGHBOR_DIR_TOLERANCE_DEG = 45; // "same direction of travel" tolerance
  const LANE_SEARCH_MAX_DIST_M = 15;          // how far to reach for a lane anchor
  const MAX_TICK_DT_S = 0.25;                 // clamp a stalled-tab rAF jump

  // ChangeActorWaypoints.initialise, as patched in the install run.sh runs
  // (/home/dellpro2/yungloon/scenario_runner-0.9.15). These govern which of
  // the router's points survive into the actor's waypoint list.
  const ROUTE_SEED_AHEAD_M = 1.0;             // ego_waypoint.next(1)[0]
  const ROUTE_DEDUP_MIN_M = 1.0;              // drop a point closer than this to the last kept one
  const ROUTE_SHORT_REF_M = 0.5;              // reference vector too short to give a heading
  const ROUTE_HEADING_ACCEPT_LO = 2.0;        // accept when |delta| < LO ...
  const ROUTE_HEADING_ACCEPT_HI = 4.3;        // ... or > HI; the band between is a reversal

  const ROUTE_ACTION_TYPES = new Set([
    'car', 'van', 'truck', 'bus', 'motorcycle', 'scooter',
    'police', 'ambulance', 'firetruck', 'ego',
  ]);

  // ── Controls (created dynamically) ─────────────────────────────────────────

  const controlsHtml = `
    <div id="sim-controls" class="sim-controls hidden">
      <button id="sim-play"  class="btn btn-small btn-primary" title="Play simulation">Play</button>
      <button id="sim-pause" class="btn btn-small btn-secondary hidden" title="Pause">Pause</button>
      <button id="sim-stop"  class="btn btn-small btn-danger hidden" title="Stop and reset">Stop</button>
      <input  id="sim-speed" type="range" min="0.25" max="4" step="0.25" value="1" title="Playback speed">
      <span   id="sim-speed-label" class="sim-speed-label">1.0x</span>
      <span   id="sim-time-label"  class="sim-time-label">0.0s</span>
      <div    id="sim-progress-bar" class="sim-progress-bar"><div id="sim-progress-fill" class="sim-progress-fill"></div></div>
    </div>`;

  // Insert into header-right (before export buttons)
  const headerRight = document.querySelector('.header-right');
  headerRight.insertAdjacentHTML('afterbegin', controlsHtml);

  const simControls  = document.getElementById('sim-controls');
  const btnPlay      = document.getElementById('sim-play');
  const btnPause     = document.getElementById('sim-pause');
  const btnStop      = document.getElementById('sim-stop');
  const speedSlider  = document.getElementById('sim-speed');
  const speedLabel   = document.getElementById('sim-speed-label');
  const timeLabel    = document.getElementById('sim-time-label');
  const progressFill = document.getElementById('sim-progress-fill');

  // Show controls once a map is loaded
  AppState.on('change', patch => {
    if ('mapData' in patch && AppState.mapData) {
      simControls.classList.remove('hidden');
    }
  });

  // ── Small geometry helpers ───────────────────────────────────────────────────

  function _dist3(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
  }

  function _angleDiffDeg(a, b) {
    return Math.abs(((a - b + 180) % 360 + 360) % 360 - 180);
  }

  /**
   * Advance up to `step` metres of arc length along `dirLine`, starting from
   * point (x, y, z) aiming at dirLine[startIdx]. Mirrors how both real
   * controllers aim at the next map/route waypoint from wherever the actor
   * currently is, not from the exact point on the line.
   */
  function _walkDirLine(dirLine, x, y, z, startIdx, step) {
    let idx = startIdx;
    let cx = x, cy = y, cz = z, yaw = null;
    let remaining = step;
    while (remaining > 1e-9 && idx < dirLine.length) {
      const [tx, ty, tz = 0] = dirLine[idx];
      const dx = tx - cx, dy = ty - cy;
      const dist = Math.hypot(dx, dy);
      if (dist < 1e-6) { idx += 1; continue; }
      const seg = Math.min(remaining, dist);
      const frac = seg / dist;
      cx += dx * frac; cy += dy * frac; cz += (tz - cz) * frac;
      yaw = Math.atan2(dy, dx) * 180 / Math.PI;
      remaining -= seg;
      if (seg >= dist - 1e-9) idx += 1;
    }
    return {
      x: cx, y: cy, z: cz, yaw, idx,
      consumed: step - remaining, // actual arc length walked, short of `step` if the line ran out
      ranOut: idx >= dirLine.length && remaining > 1e-9,
    };
  }

  // ── Event normalisation mirror (backend/scenario_io.py) ─────────────────────
  //
  // simulate.js reads AppState's raw, unexported events — but three rewrites
  // happen only at export time and change WHICH TRIGGER GOVERNS AN EVENT, so a
  // preview that skips them predicts a different scenario than export
  // produces. Order matters and matches _normalize_actor exactly: per-event
  // coercion (incl. assign_route forcing its own trigger), then the
  // after_event→assign_route rewrite, then — LAST, so it also catches the
  // just-rewritten case — the ego self-distance rewrite.

  const TRIGGER_TYPES = new Set(['simulation_time', 'distance_to_ego', 'distance_to_point', 'after_event']);
  const ACTION_TYPES  = new Set(['follow_trajectory', 'assign_route', 'set_speed', 'set_distance', 'lane_change']);

  function _actionEmits(action, actorType) {
    if (!action) return false;
    if (action.type === 'follow_trajectory') return (action.trajectory || []).length >= 2;
    if (action.type === 'assign_route') {
      return (action.waypoints || []).length >= 2 && ROUTE_ACTION_TYPES.has(actorType);
    }
    return true; // set_speed / set_distance / lane_change never fail to emit
  }

  function _normalizeEventsForSim(actor) {
    const events = JSON.parse(JSON.stringify(actor.events || []));
    const isEgo = actor.type === 'ego';

    for (const ev of events) {
      const trigger = (ev.trigger && typeof ev.trigger === 'object') ? ev.trigger : {};
      if (!TRIGGER_TYPES.has(trigger.type)) trigger.type = 'simulation_time';
      ev.trigger = trigger;
      const action = (ev.action && typeof ev.action === 'object') ? ev.action : {};
      if (!ACTION_TYPES.has(action.type)) action.type = 'follow_trajectory';
      ev.action = action;
      if (action.type === 'assign_route') ev.trigger = { type: 'simulation_time', value: 0 };
    }

    const assignRouteIds = new Set(
      events.filter(e => e.action.type === 'assign_route').map(e => String(e.id))
    );
    for (const ev of events) {
      if (ev.trigger.type === 'after_event' && assignRouteIds.has(String(ev.trigger.event_id))) {
        ev.trigger = { type: 'distance_to_ego', value: 400 };
      }
    }

    if (isEgo) {
      for (const ev of events) {
        if (ev.trigger.type === 'distance_to_ego') ev.trigger = { type: 'simulation_time', value: 0 };
      }
    }

    // Not a backend rewrite: an after_event pointing at an action that never
    // reaches the .xosc (a <2-point path, or a route on a non-routable type)
    // can never fire there either — the KNOWN defect in
    // build_custom_event_chain (see CLAUDE.md / test_events_e2e.py). Flagging
    // it here rather than pretending the chain proceeds.
    const byId = new Map(events.map(e => [String(e.id), e]));
    for (const ev of events) {
      if (ev.trigger.type !== 'after_event') continue;
      const target = byId.get(String(ev.trigger.event_id));
      if (!target || !_actionEmits(target.action, actor.type)) {
        ev.trigger.neverFires = true;
      }
    }

    return events;
  }

  // ── Trigger evaluation ───────────────────────────────────────────────────────

  function _resolveSimRef(id) {
    return id ? _simActors.get(id) || null : null;
  }

  /** The reference actor's speed as ChangeActorTargetSpeed sees it.
   * CarlaDataProvider.get_velocity reads a velocity map refilled once per world
   * tick, so every atomic in one tick reads the same value whatever the
   * behaviour-tree order — hence the snapshot rather than sim.speed live — and
   * an actor missing from it yields 0.0 (a printed warning, never a raise). */
  function _refSpeed(id) {
    const ref = id || _egoId;  // an omitted entity_ref exports as `hero`
    return _tickSpeeds.has(ref) ? _tickSpeeds.get(ref) : 0;
  }

  /** True the first tick the trigger's condition holds. Level-sensitive, like
   * every real OpenSCENARIO condition (conditionEdge is never read). */
  function _triggerSatisfied(trigger, sim, egoPrevPos, simTime) {
    switch (trigger.type) {
      case 'simulation_time':
        return simTime > (trigger.value ?? 0);
      case 'distance_to_ego': {
        // Both the real distance predicate AND the mandatory 60s OR-fallback
        // (event_builders.py) — a distance_to_ego trigger fires past t=60s
        // regardless of geometry, and a preview that skips this diverges in
        // any scenario that runs that long.
        if (simTime > DISTANCE_TO_EGO_FALLBACK_S) return true;
        if (!egoPrevPos) return false;
        return _dist3(sim, egoPrevPos) < (trigger.value ?? 400);
      }
      case 'distance_to_point': {
        const point = trigger.point;
        if (!point) return false;
        // The triggering entity is whoever entity_ref names (default hero) —
        // NOT necessarily the actor that owns this event.
        const triggerActor = _resolveSimRef(trigger.entity_ref) || _simActors.get(_egoId) || sim;
        return _dist3(triggerActor, { x: point.x, y: point.y, z: point.z ?? 0.2 }) < (trigger.value ?? 20);
      }
      case 'after_event': {
        if (trigger.neverFires) return false;
        const rec = sim.fired.get(trigger.event_id);
        return !!rec && rec.completedAt != null && rec.completedAt <= simTime;
      }
      default:
        return false;
    }
  }

  // ── Lane geometry (vehicle "no waypoints" mode + lane_change) ───────────────

  function _laneAnchor(x, y) {
    return ObjectsManager.nearestLaneProjection(
      x, y, new Set(['driving', 'bidirectional']), LANE_SEARCH_MAX_DIST_M
    );
  }

  /** Project (x, y) onto `dirLine`, returning the nearest point's distance,
   * position, segment index (the target for _walkDirLine) and local heading. */
  function _nearestPointOnDirLine(dirLine, x, y) {
    let best = null;
    for (let i = 1; i < dirLine.length; i++) {
      const [x0, y0] = dirLine[i - 1], [x1, y1] = dirLine[i];
      const dx = x1 - x0, dy = y1 - y0;
      const len2 = dx * dx + dy * dy;
      if (len2 <= 0) continue;
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / len2));
      const px = x0 + t * dx, py = y0 + t * dy;
      const d = Math.hypot(x - px, y - py);
      if (!best || d < best.d) best = { d, px, py, idx: i, yaw: Math.atan2(dy, dx) * 180 / Math.PI };
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
    const rad = near.laneYaw * Math.PI / 180;
    // Right-hand vector in this map's y-down convention (verified: heading
    // +x/east with north-up-on-screen, "right" points +y/south).
    const rightX = -Math.sin(rad), rightY = Math.cos(rad);
    let best = null;

    for (const lane of near.road.lanes || []) {
      if (lane === near.lane) continue;
      if (lane.type !== 'driving' && lane.type !== 'bidirectional') continue;
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
   * backend/lane_graph_builder.py), so a genuine fork — more than one
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
    let cx = x, cy = y, cz = z, yaw = null;
    let remaining = step;
    while (remaining > 1e-9) {
      const r = _walkDirLine(cur.dirLine, cx, cy, cz, cur.idx, remaining);
      cx = r.x; cy = r.y; cz = r.z; if (r.yaw != null) yaw = r.yaw;
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
    let x = near.x, y = near.y, z = near.z;
    const waypoints = [];

    let dist = 0;
    while (dist < LANE_CHANGE_SAME_LANE_M) {
      const r = _walkLaneChained(cursor, x, y, z, STEP);
      if (r.ranOut) return null;
      dist += Math.hypot(r.x - x, r.y - y);
      cursor = r.cursor; x = r.x; y = r.y; z = r.z;
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
    x = proj.px; y = proj.py; z = lc.z;
    dist = 0;
    while (dist < LANE_CHANGE_OTHER_LANE_M) {
      const r = _walkLaneChained(ocursor, x, y, z, STEP);
      if (r.ranOut) return null;
      dist += Math.hypot(r.x - x, r.y - y);
      ocursor = r.cursor; x = r.x; y = r.y; z = r.z;
      waypoints.push({ x, y, z });
    }

    return { waypoints, endCursor: ocursor, verified: neighbor.verified };
  }

  /**
   * The lane-projected form of a raw point, carrying BOTH the projection and
   * the raw location — LaneGraph.route needs the projected point as its
   * `current` seed and the raw one for trace_route's distance break, and they
   * are different points.
   */
  function _resolveLaneRef(x, y, z) {
    const near = _laneAnchor(x, y);
    if (!near || !near.road) return null;
    return {
      roadId: Number(near.road.id), sectionId: near.lane.sectionId, laneId: near.lane.laneId,
      x: near.x, y: near.y, z: near.z,
      rawX: x, rawY: y, rawZ: z !== undefined ? z : near.z,
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
    const near = _laneAnchor(sim.x, sim.y);
    if (!near || !near.road) return null;

    const walked = _walkDirLine(near.lane.directionLine, near.x, near.y, near.z,
                                near.segIndex, ROUTE_SEED_AHEAD_M);
    let seedX = walked.x, seedY = walked.y, seedZ = walked.z;
    let headingRad = (walked.yaw !== null ? walked.yaw : near.laneYaw) * Math.PI / 180;

    if (walked.ranOut) {
      // The lane ended inside that metre — .next() would return the successor.
      const record = LaneGraph.laneRecord(AppState.laneGraph, Number(near.road.id),
                                          near.lane.sectionId, near.lane.laneId);
      const succ = _preferredSuccessor(AppState.laneGraph, record);
      if (succ) {
        const found = _findLaneByRef(succ);
        if (found && (found.lane.directionLine || []).length >= 2) {
          const [sx, sy, sz = 0] = found.lane.directionLine[0];
          seedX = sx; seedY = sy; seedZ = sz;
          const [nx, ny] = found.lane.directionLine[1];
          headingRad = Math.atan2(ny - sy, nx - sx);
        }
      }
      // No usable successor (none, or an unranked xodr fork) -> CARLA's
      // IndexError path: keep the actor's own waypoint.
    }

    const ref = _resolveLaneRef(seedX, seedY, seedZ);
    return ref ? { ref, headingRad } : null;
  }

  /**
   * Faithful port of ChangeActorWaypoints.initialise for a `fastest` route —
   * the locally patched version in the install run.sh actually executes
   * (/home/dellpro2/yungloon/scenario_runner-0.9.15). One trace_route per
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
            const rx = last.x - prev.x, ry = last.y - prev.y, rz = (last.z || 0) - (prev.z || 0);
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

  // ── Per-actor sim record ─────────────────────────────────────────────────────

  function _makeSimActor(actor, isEgo) {
    const events = _normalizeEventsForSim(actor);
    return {
      id: actor.id,
      type: actor.type,
      isEgo,
      isWalker: MapView.isWalkerType(actor.type),
      x: actor.x, y: actor.y, z: actor.z ?? 0, yaw: actor.yaw || 0,
      spawnYaw: actor.yaw || 0,
      // The Init <SpeedAction>: ChangeActorTargetSpeed(..., init_speed=True)
      // runs in InitialActorSettings on tick 1, before any Act's
      // SimulationTime>0 start trigger, so the actor already has this speed
      // when the story begins. Nothing else is needed to model "unless a later
      // speed action replaces it" — set_speed and follow_trajectory both assign
      // sim.speed when they fire, exactly as BasicControl.update_target_speed()
      // overwrites _target_speed. An actor with no events gets no Act at all,
      // so for it this is the only speed it ever has.
      speed: Math.max(0, actor.initial_speed || 0),
      events,
      fired: new Map(),           // eventId → {firedAt, completedAt|null}
      activeSpeedEventId: null,
      speedEventDuration: 0,       // dynamics.value: seconds, or m/s² when the dimension is 'rate'
      speedEventDimension: 'time',
      speedRampFrom: 0,            // ChangeActorTargetSpeed._start_speed, 'rate' only
      speedRampTarget: 0,          // ._target_speed as snapshotted in initialise()
      speedRelativeRef: null,      // entity id to keep tracking; null ⇒ absolute target
      speedRelativeDelta: 0,
      activePathEventId: null,
      pathKind: null,              // 'follow_trajectory' | 'assign_route'
      waypoints: null,
      activeLaneChangeEventId: null,
      laneChange: null,
      laneFollow: null,            // {lane, dirLine, idx} anchor while path-less
      badge: null,
      traveled: 0,
      frozen: false,
      goalStopped: false,          // SimpleVehicleControl._reached_goal — sticky
      hasNoEvents: events.length === 0,
      noEventsBadgeShown: false,
    };
  }

  function _avgTrajectorySpeed(points) {
    // Mirrors _compute_trajectory_times + openscenario_parser's patched
    // FollowTrajectoryAction handling: per-waypoint velocities are baked into
    // relativeTime, then collapsed back into ONE average speed for the whole
    // path (total_dist / total_time) — the real controller never sees the
    // per-segment values a trajectory was authored with.
    let totalDist = 0, totalTime = 0;
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - points[i - 1].x, dy = points[i].y - points[i - 1].y;
      const dist = Math.hypot(dx, dy);
      const v1 = points[i - 1].velocity ?? 10, v2 = points[i].velocity ?? 10;
      const avgV = (v1 + v2) / 2 || 1;
      totalDist += dist;
      totalTime += dist / avgV;
    }
    return totalTime > 0 ? totalDist / totalTime : 10;
  }

  /** A new longitudinal command lands: ChangeActorTargetSpeed.update() sees
   * get_last_longitudinal_command() != its own start_time and reports SUCCESS,
   * so the old atomic stops writing — including any relative tracking. */
  function _supersedeSpeedEvent(sim, simTime) {
    if (!sim.activeSpeedEventId) return;
    const prev = sim.fired.get(sim.activeSpeedEventId);
    if (prev && prev.completedAt == null) prev.completedAt = simTime;
    sim.activeSpeedEventId = null;
    sim.speedRelativeRef = null;
    sim.speedRelativeDelta = 0;
    sim.speedRampFrom = 0;
    sim.speedRampTarget = 0;
  }

  function _applyEventAction(sim, ev, simTime) {
    sim.fired.set(ev.id, { firedAt: simTime, completedAt: null });
    const action = ev.action;

    if (action.type === 'set_speed') {
      _supersedeSpeedEvent(sim, simTime);
      // ChangeActorTargetSpeed.initialise(): a relative target samples the
      // reference ONCE here, but the atomic goes on re-sampling it every tick
      // for the whole duration (see _stepActor), so the parameters are kept.
      const target = action.target || {};
      const isRelative = target.mode === 'relative';
      sim.speedRelativeRef = isRelative ? (target.entity_ref || _egoId) : null;
      sim.speedRelativeDelta = isRelative ? (target.delta ?? 0) : 0;
      sim.activeSpeedEventId = ev.id;
      sim.speedEventDuration = (action.dynamics && action.dynamics.value) ?? 5.0;
      sim.speedEventDimension = (action.dynamics && action.dynamics.dimension) || 'time';

      const resolvedTarget = isRelative
        ? _refSpeed(sim.speedRelativeRef) + sim.speedRelativeDelta
        : Math.max(0, target.value ?? 10);

      if (sim.speedEventDimension === 'rate') {
        // The rate branch does NOT step: initialise() commands _start_speed and
        // update() ramps from there. It also snapshots _target_speed once and
        // then overwrites its own per-tick relative re-sample with the ramp, so
        // a relative target stops tracking the moment a rate is used — that is
        // the atomic's real behaviour, not a shortcut taken here.
        sim.speedRampFrom = sim.speed;
        sim.speedRampTarget = resolvedTarget;
        sim.speedRelativeRef = null;
      } else {
        sim.speed = resolvedTarget;
      }

    } else if (action.type === 'follow_trajectory' || action.type === 'assign_route') {
      const isRoute = action.type === 'assign_route';
      const rawPoints = isRoute ? (action.waypoints || []) : (action.trajectory || []);
      if (!_actionEmits(action, sim.type)) return; // dropped at export — never applies
      sim.activePathEventId = ev.id;
      sim.pathKind = action.type;

      if (isRoute) {
        // AssignRouteAction only sets waypoints, never a speed — so the actor
        // keeps whatever speed it already has. With an Init speed that means it
        // drives the route immediately; with none (initial_speed 0) it does not
        // move at all until some set_speed event gives it a nonzero speed.
        // The stationary case is a real gap in the emitted scenario, not a
        // preview limitation, so it gets no badge: the actor visibly sitting
        // still already says it, exactly like the real run would.
        const exact = _exactRoute(sim, rawPoints);
        if (exact) {
          sim.waypoints = exact;
          sim.badge = null;
        } else {
          sim.waypoints = rawPoints.map(p => ({ x: p.x, y: p.y, z: p.z ?? 0.2 }));
          sim.badge = { icon: '≈', text: 'Route ist ungefähr — kein CARLA-Kartengraph für diese Karte/Punkte' };
        }
      } else {
        // FollowTrajectoryAction parses into a Sequence whose first child is
        // ChangeActorTargetSpeed with its own start_time — a LONGITUDINAL
        // command, so it cancels any running relative-speed tracker. Neither
        // assign_route nor lane_change does (both issue waypoint commands
        // only, stamped on a separate _last_waypoint_command).
        _supersedeSpeedEvent(sim, simTime);
        sim.waypoints = rawPoints.map(p => ({ x: p.x, y: p.y, z: p.z ?? 0.2 }));
        sim.speed = _avgTrajectorySpeed(rawPoints);
        sim.badge = null;
      }

      while (sim.waypoints.length &&
             _dist3(sim, sim.waypoints[0]) < LEADING_WAYPOINT_DROP_M) {
        sim.waypoints.shift();
      }

    } else if (action.type === 'lane_change') {
      sim.activeLaneChangeEventId = ev.id;
      _startLaneChange(sim, action, simTime);

    } else if (action.type === 'set_distance') {
      // Deliberately not simulated — see file header. Never completes, so any
      // after_event chained onto it never fires here either, matching the
      // real gap-measurement / 100 m/s spike being unknowable without the
      // same lane graph assign_route needs.
      sim.badge = { icon: '−', text: 'set_distance wird in der Vorschau nicht simuliert' };
    }
  }

  function _startLaneChange(sim, action, simTime) {
    const near = _laneAnchor(sim.x, sim.y);
    const direction = action.direction === 'right' ? 'right' : 'left';
    const dirLabel = direction === 'left' ? 'links' : 'rechts';
    if (!near) {
      sim.badge = { icon: '⚠', text: `Spurwechsel ${dirLabel} nicht möglich — keine Spur unter dem Fahrzeug` };
      return;
    }
    const diagTotal = Math.max(0, (action.dynamics && action.dynamics.value) ?? 12.0) || 1e-6;
    const plan = _buildLaneChangePlan(near, direction, diagTotal);
    if (!plan) {
      // Mirrors generate_target_waypoint_list_multilane returning (None,
      // None) — ChangeActorLateralMotion.update then reports FAILURE and the
      // maneuver never completes, so we stop advancing this actor rather
      // than pretend a lane change happened.
      sim.frozen = true;
      sim.speed = 0;
      sim.badge = { icon: '⚠', text: `Spurwechsel ${dirLabel} nicht möglich — keine Nachbarspur in Fahrtrichtung` };
      return;
    }
    // Overwrites any waypoints left over from an earlier follow_trajectory/
    // assign_route — those would otherwise outrank lane-following once the
    // change completes (_advancePosition checks sim.waypoints first).
    sim.waypoints = plan.waypoints;
    sim.laneChange = { active: true, endCursor: plan.endCursor, eventId: sim.activeLaneChangeEventId };
    const totalM = (LANE_CHANGE_SAME_LANE_M + diagTotal + LANE_CHANGE_OTHER_LANE_M).toFixed(0);
    // plan.verified only says the neighbour came from the graph rather than a
    // geometric guess — an xodr-derived graph (no live CARLA behind it) still
    // gets its own, less confident label than an actual CARLA probe.
    const source = !plan.verified ? 'geschätzt'
      : (AppState.laneGraph && AppState.laneGraph.source === 'xodr') ? 'aus Kartendatei'
      : 'CARLA-Kartendaten';
    sim.badge = { icon: '↔', text: `Spurwechsel ${dirLabel} läuft (~${totalM} m, ${source})` };
  }

  /** The lane-change plan's waypoints ran out — the same signal
   * ChangeActorLateralMotion.update uses (distance travelled past
   * distance_other_lane) to report SUCCESS and hand the controller 200 fresh
   * lane-follow waypoints. Here the plan's own other-lane leg already IS
   * that distance, so emptying the list and completing are the same event. */
  function _completeLaneChange(sim) {
    const lc = sim.laneChange;
    lc.active = false;
    if (lc.eventId) {
      const rec = sim.fired.get(lc.eventId);
      if (rec) rec.completedAt = _simTime;
    }
    sim.laneFollow = lc.endCursor;
    sim.badge = null;
  }

  function _advanceWaypoints(sim, dt) {
    const acceptR = sim.isWalker ? VRU_WAYPOINT_ACCEPT_M : VEHICLE_WAYPOINT_ACCEPT_M;
    let remaining = sim.speed * dt;
    while (remaining > 1e-9 && sim.waypoints.length) {
      const target = sim.waypoints[0];
      const dx = target.x - sim.x, dy = target.y - sim.y;
      const dist2d = Math.hypot(dx, dy);
      if (dist2d <= acceptR) {
        // Advance to the next waypoint the instant we're within radius —
        // mirrors both controllers switching their aim point without
        // consuming this tick's remaining distance budget on the hop.
        sim.waypoints.shift();
        if (!sim.waypoints.length) {
          if (sim.laneChange && sim.laneChange.active) {
            // CARLA replaces the plan with 200 fresh lane-follow waypoints on
            // SUCCESS rather than stopping — a dead stop here would be wrong.
            _completeLaneChange(sim);
          } else {
            sim.speed = 0; // dead stop on _reached_goal, not a coast
            // _reached_goal is sticky: run_step returns zero velocity from
            // here on whatever target speed the atomics keep writing, so a
            // relative tracker must not drive this actor off again.
            sim.goalStopped = true;
            if (sim.pathKind === 'follow_trajectory') sim.badge = null;
          }
          return;
        }
        continue;
      }
      const step = Math.min(remaining, dist2d);
      const frac = step / dist2d;
      sim.x += dx * frac; sim.y += dy * frac; sim.z += (target.z - sim.z) * frac;
      sim.yaw = Math.atan2(dy, dx) * 180 / Math.PI;
      sim.traveled += step;
      remaining -= step;
    }
  }

  function _advanceStraight(sim, dt) {
    // PedestrianControl with no waypoints walks its CURRENT forward vector —
    // which, having never been given a waypoint, is still the spawn yaw.
    // Exact: no map query, no lane dependency at all.
    const rad = sim.spawnYaw * Math.PI / 180;
    const step = sim.speed * dt;
    sim.x += Math.cos(rad) * step;
    sim.y += Math.sin(rad) * step;
    sim.traveled += step;
  }

  function _ensureLaneFollowAnchor(sim) {
    if (sim.laneFollow) return true;
    const near = _laneAnchor(sim.x, sim.y);
    if (!near) {
      sim.frozen = true;
      sim.badge = { icon: '❓', text: 'Nicht auf einer bekannten Spur — Pfad kann nicht simuliert werden' };
      return false;
    }
    sim.laneFollow = { road: near.road, lane: near.lane, dirLine: near.lane.directionLine, idx: near.segIndex };
    return true;
  }

  /**
   * At the end of known lane geometry, consult the cached graph's real
   * successors for this exact lane via _preferredSuccessor (index 0 is
   * CARLA's own fork choice on a CARLA-probed graph, not a guess; an
   * xodr-derived graph refuses instead of guessing at a genuine fork — see
   * _preferredSuccessor) and re-anchor lane-following onto it. Returns false
   * (leaving the caller to freeze+badge) when there is no graph, no usable
   * successor, or the successor isn't a lane the render JSON carries a
   * directionLine for.
   */
  function _continueLaneFollowAtFork(sim) {
    const next = _nextLaneCursor(sim.laneFollow);
    if (!next) return false;
    sim.laneFollow = next;
    const graphSource = (AppState.laneGraph && AppState.laneGraph.source === 'xodr')
      ? 'aus Kartendatei abgeleitet' : 'CARLA-Kartendaten';
    sim.badge = { icon: '↷', text: `Fährt an bekannter Abzweigung weiter (${graphSource})` };
    return true;
  }

  function _advanceLaneFollow(sim, dt) {
    if (!_ensureLaneFollowAnchor(sim)) return;
    const dirLine = sim.laneFollow.dirLine;
    const r = _walkDirLine(dirLine, sim.x, sim.y, sim.z, sim.laneFollow.idx, sim.speed * dt);
    sim.x = r.x; sim.y = r.y; sim.z = r.z; if (r.yaw != null) sim.yaw = r.yaw;
    sim.laneFollow.idx = r.idx;
    sim.traveled += r.consumed;
    if (r.ranOut) {
      if (_continueLaneFollowAtFork(sim)) return;
      sim.frozen = true;
      sim.speed = 0;
      // Under-predicts on purpose when no graph is cached for this town:
      // without it, this preview cannot tell a genuine fork from a road
      // that simply continues, so it stops at the end of the known lane
      // geometry rather than guess which way CARLA's
      // map.get_waypoint(...).next(2.0)[0] walk would turn.
      sim.badge = { icon: '❓', text: 'Pfad ab hier unbekannt — Route/Trajektorie hinzufügen' };
    }
  }

  function _advancePosition(sim, dt) {
    if (sim.waypoints && sim.waypoints.length) { _advanceWaypoints(sim, dt); return; }
    if (sim.speed <= 0) return; // stationary — also the honest state for an
                                 // assign_route with no set_speed yet
    if (sim.isWalker) _advanceStraight(sim, dt);
    else _advanceLaneFollow(sim, dt);
  }

  function _stepActor(sim, dt, egoPrevPos, simTime) {
    if (sim.frozen) return;

    if (sim.hasNoEvents) {
      // events: [] — no Act is emitted for this actor at all, so the Init
      // <SpeedAction> is the only speed command it ever receives: it holds its
      // start speed for the whole scenario, or stands still at 0. Badged once
      // so an actor that never reacts to anything reads as authored, not broken.
      if (!sim.noEventsBadgeShown) {
        sim.noEventsBadgeShown = true;
        sim.badge = sim.speed > 0
          ? { icon: '▶', text: 'Kein Event — fährt nur mit Startgeschwindigkeit' }
          : { icon: '⏸', text: 'Kein Event — steht still' };
      }
    } else {
      for (const ev of sim.events) {
        if (sim.fired.has(ev.id)) continue;
        if (_triggerSatisfied(ev.trigger, sim, egoPrevPos, simTime)) {
          _applyEventAction(sim, ev, simTime);
        }
      }
      // ChangeActorTargetSpeed.update(), replayed: a RELATIVE target is
      // re-sampled on EVERY tick and BEFORE the duration test, so the final
      // tick of the window still tracks and the controller then holds that
      // last tracked value forever. `continuous` governs only whether duration
      // is allowed to end the atomic at all, and the editor always exports
      // continuous='false' — so this is a bounded follow, not a permanent one.
      // The distance dimension isn't produced by the UI (the Dynamik toggle
      // offers Zeit and Rate only), so a legacy/hand-edited file with it never
      // completes via duration here and simply tracks until overwritten —
      // closer to the real atomic than the old frozen initial sample was.
      // 'rate' is the one branch that is NOT a hold: it ramps and ends on
      // arrival, so duration/distance never get a look-in (if/elif upstream).
      if (sim.activeSpeedEventId) {
        const rec = sim.fired.get(sim.activeSpeedEventId);
        if (rec && rec.completedAt == null) {
          if (sim.speedRelativeRef && !sim.goalStopped) {
            sim.speed = _refSpeed(sim.speedRelativeRef) + sim.speedRelativeDelta;
          }
          if (sim.speedEventDimension === 'rate') {
            // commanded = start ± rate·elapsed, clamped at the target. Not
            // clamped to ≥0 — the target already bounds it, and a negative
            // relative target is deliberately left unclamped (as in the atomic).
            const elapsed = simTime - rec.firedAt;
            const sign = sim.speedRampTarget >= sim.speedRampFrom ? 1 : -1;
            const ramped = sim.speedRampFrom + sign * sim.speedEventDuration * elapsed;
            const commanded = sign > 0
              ? Math.min(ramped, sim.speedRampTarget)
              : Math.max(ramped, sim.speedRampTarget);
            if (!sim.goalStopped) sim.speed = commanded;
            if (commanded === sim.speedRampTarget) rec.completedAt = simTime;
          } else if (sim.speedEventDimension === 'time' &&
              simTime - rec.firedAt >= sim.speedEventDuration) {
            rec.completedAt = simTime;
          }
        }
      }
    }

    _advancePosition(sim, dt);
  }

  // ── Simulation lifecycle ──────────────────────────────────────────────────────

  function _estimatedHorizon() {
    // Cosmetic only — scales the progress bar, never gates any decision.
    let maxDur = 20;
    for (const sim of _simActors.values()) {
      for (const ev of sim.events) {
        if (ev.trigger.type === 'simulation_time') maxDur = Math.max(maxDur, ev.trigger.value || 0);
        // A 'rate' dynamics.value is m/s², not seconds — how long the ramp
        // actually takes depends on the actor's speed when it fires, which is
        // not knowable here. Skip it rather than add an acceleration to a clock.
        if (ev.action.type === 'set_speed' && ev.action.dynamics &&
            ev.action.dynamics.dimension !== 'rate') {
          maxDur = Math.max(maxDur, (ev.trigger.value || 0) + (ev.action.dynamics.value || 0));
        }
      }
    }
    return maxDur + 10;
  }

  function _ensureBadgeLayer() {
    if (_layerSimBadges) return;
    const world = document.getElementById('world');
    _layerSimBadges = document.createElementNS(SVG_NS, 'g');
    _layerSimBadges.id = 'layer-sim-badges';
    world.appendChild(_layerSimBadges);
  }

  function _renderBadges() {
    if (!_layerSimBadges) return;
    while (_layerSimBadges.firstChild) _layerSimBadges.removeChild(_layerSimBadges.firstChild);
    for (const sim of _simActors.values()) {
      if (!sim.badge) continue;
      const size = MapView.actorSize(sim.type);
      const yOff = -Math.max(size.w, size.h) / 2 - 4.5;
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('transform', `translate(${sim.x},${sim.y + yOff})`);
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '1.8');
      text.setAttribute('fill', '#ffd966');
      text.setAttribute('style', 'pointer-events:none; paint-order: stroke; stroke:#1a1a1a; stroke-width:0.35;');
      text.textContent = `${sim.badge.icon} ${sim.badge.text}`;
      g.appendChild(text);
      _layerSimBadges.appendChild(g);
    }
  }

  function _snapshotSpeeds() {
    _tickSpeeds.clear();
    for (const sim of _simActors.values()) _tickSpeeds.set(sim.id, sim.speed);
  }

  function _prepareSimulation() {
    _originals.clear();
    _simActors.clear();
    _tickSpeeds.clear();
    _scenarioEnded = false;
    _egoId = null;

    const actors = [];
    if (AppState.ego) { actors.push(AppState.ego); _egoId = AppState.ego.id; }
    for (const npc of AppState.npcs) actors.push(npc);

    if (actors.length === 0) {
      Toast.warn('Keine Akteure zum Simulieren. Ego oder NPC platzieren.');
      return false;
    }

    for (const actor of actors) {
      _originals.set(actor.id, { x: actor.x, y: actor.y, z: actor.z, yaw: actor.yaw });
      _simActors.set(actor.id, _makeSimActor(actor, actor.id === _egoId));
    }
    _snapshotSpeeds(); // so an event firing on the very first tick reads real
                       // init speeds rather than an empty map
    _ensureBadgeLayer();
    _horizon = _estimatedHorizon();
    return true;
  }

  function _startSimulation() {
    if (_running && !_paused) return;

    if (!_running) {
      if (!_prepareSimulation()) return;
      _simTime = 0;
      _running = true;
    }
    _paused = false;
    _lastFrame = performance.now();

    btnPlay.classList.add('hidden');
    btnPause.classList.remove('hidden');
    btnStop.classList.remove('hidden');

    AppState.select(null);
    document.body.classList.add('simulating');

    _animId = requestAnimationFrame(_tick);
  }

  function _pauseSimulation() {
    if (!_running || _paused) return;
    _paused = true;
    if (_animId) cancelAnimationFrame(_animId);
    _animId = null;

    btnPlay.classList.remove('hidden');
    btnPlay.textContent = 'Resume';
    btnPause.classList.add('hidden');
  }

  function _stopSimulation() {
    _running = false;
    _paused = false;
    if (_animId) cancelAnimationFrame(_animId);
    _animId = null;

    for (const [id, orig] of _originals) {
      AppState.updateById(id, { x: orig.x, y: orig.y, z: orig.z, yaw: orig.yaw });
    }
    _originals.clear();
    _simActors.clear();
    if (_layerSimBadges) while (_layerSimBadges.firstChild) _layerSimBadges.removeChild(_layerSimBadges.firstChild);

    document.body.classList.remove('simulating');
    btnPlay.classList.remove('hidden');
    btnPlay.textContent = 'Play';
    btnPause.classList.add('hidden');
    btnStop.classList.add('hidden');
    timeLabel.textContent = '0.0s';
    progressFill.style.width = '0%';

    MapView.renderAllActors();
  }

  function _tick(now) {
    if (!_running || _paused) return;

    const dt = Math.min(MAX_TICK_DT_S, (now - _lastFrame) / 1000) * _speed;
    _lastFrame = now;
    _simTime += dt;

    // Every actor reads the SAME pre-tick ego position, so trigger checks
    // don't depend on iteration order within this tick. Reference speeds are
    // snapshotted for the same reason — CarlaDataProvider's velocity map is
    // refilled once per world tick, not read live off the other actor.
    const egoSim = _egoId ? _simActors.get(_egoId) : null;
    const egoPrevPos = egoSim ? { x: egoSim.x, y: egoSim.y, z: egoSim.z } : null;
    _snapshotSpeeds();

    for (const sim of _simActors.values()) {
      _stepActor(sim, dt, egoPrevPos, _simTime);
    }

    // Every Act's StopTrigger: hero traveled 500 m tears the whole storyboard
    // down. We stop advancing rather than modelling per-Act teardown
    // separately, since nothing downstream distinguishes them.
    if (egoSim && !_scenarioEnded && egoSim.traveled >= ACT_TEARDOWN_DISTANCE_M) {
      _scenarioEnded = true;
      Toast.info('Vorschau beendet — Ego hat 500 m zurückgelegt (Stop-Trigger jedes Acts)');
    }

    for (const sim of _simActors.values()) {
      AppState.updateById(sim.id, { x: sim.x, y: sim.y, z: sim.z, yaw: sim.yaw });
    }
    _renderBadges();

    timeLabel.textContent = `${_simTime.toFixed(1)}s`;
    progressFill.style.width = `${Math.min(100, (_simTime / _horizon) * 100)}%`;

    _animId = requestAnimationFrame(_tick);
  }

  // ── Event handlers ────────────────────────────────────────────────────────────

  btnPlay.addEventListener('click', _startSimulation);
  btnPause.addEventListener('click', _pauseSimulation);
  btnStop.addEventListener('click', _stopSimulation);

  speedSlider.addEventListener('input', () => {
    _speed = parseFloat(speedSlider.value);
    speedLabel.textContent = `${_speed.toFixed(2)}x`;
  });

  // No click-to-seek: unlike the old pure-interpolation preview, this is a
  // stateful discrete simulation (fired events, lane-change phases, one-shot
  // triggers) — jumping to an arbitrary time would mean replaying everything
  // up to it, not interpolating, so seeking is dropped rather than faked.

  // Stop simulation if user interacts with editing tools
  AppState.on('change', patch => {
    if (_running && ('activeTool' in patch || 'trajectoryMode' in patch || 'routeMode' in patch)) {
      if (AppState.activeTool || AppState.trajectoryMode || AppState.routeMode) {
        _stopSimulation();
        Toast.info('Simulation stopped — editing resumed');
      }
    }
  });

  // The module's only export, and it exists purely for
  // tests/test_route_fidelity_e2e.py: it returns the waypoint list an
  // assign_route would actually be driven along, without running the
  // animation. Asserting on the route directly is deterministic, whereas
  // sampling a moving actor can only ever catch a reversal that happens to
  // straddle two samples. Not used by any UI code.
  window.Simulate = {
    routeForTesting(actor) {
      const sim = _makeSimActor(actor, actor.type === 'ego');
      const ev = (sim.events || []).find(e => e.action && e.action.type === 'assign_route');
      if (!ev) return null;
      return _exactRoute(sim, ev.action.waypoints || []);
    },
  };
})();
