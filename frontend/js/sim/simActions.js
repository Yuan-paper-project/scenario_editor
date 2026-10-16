/**
 * simActions.js — the per-actor sim record, starting events and the supersede rules.
 *
 * Part of the in-editor preview (Simulate); see simulate.js.
 */
(() => {
  'use strict';

  const {
    run,
    LEADING_WAYPOINT_DROP_M,
    LANE_CHANGE_SAME_LANE_M,
    LANE_CHANGE_OTHER_LANE_M,
    _dist3,
    DEFAULT_MAX_ACCEL,
    DEFAULT_MAX_DECEL,
    _actionEmits,
    _normalizeEventsForSim,
    _laneAnchor,
    _buildLaneChangePlan,
    _exactRoute,
    _relativeTarget,
  } = SimCore.shared;

  // ── Per-actor sim record ─────────────────────────────────────────────────────

  function _makeSimActor(actor, isEgo) {
    const events = _normalizeEventsForSim(actor);
    return {
      id: actor.id,
      type: actor.type,
      body: AppState.bodyType(actor), // footprint type: the ego's vehicleType
      isEgo,
      isWalker: MapView.isWalkerType(actor.type),
      x: actor.x,
      y: actor.y,
      z: actor.z ?? 0,
      yaw: actor.yaw || 0,
      spawnYaw: actor.yaw || 0,
      // The Init <SpeedAction> lands on tick 1, before any Act; the first Story speed action
      // overwrites it. `target` is what the atomics command, `speed` what the actor drives:
      // a vehicle ramps up at max_acceleration, a walker starts at it.
      target: Math.max(0, actor.initial_speed || 0),
      speed: MapView.isWalkerType(actor.type) ? Math.max(0, actor.initial_speed || 0) : 0,
      lastCmd: null, // SimpleVehicleControl._last_target_speed
      maxAccel: actor.max_acceleration ?? DEFAULT_MAX_ACCEL,
      maxDecel: actor.max_deceleration ?? DEFAULT_MAX_DECEL,
      events,
      fired: new Map(), // eventId → {firedAt, completedAt|null}
      activeSpeedEventId: null,
      speedEventDuration: 0, // dynamics.value: seconds, or m/s² when the dimension is 'rate'
      speedEventDimension: 'time',
      speedRampFrom: 0, // ChangeActorTargetSpeed._start_speed, 'rate' only
      speedRampTarget: 0, // ._target_speed as snapshotted in initialise()
      speedRelativeRef: null, // entity id to keep tracking; null ⇒ absolute target
      speedRelativeDelta: 0,
      speedRelativeFactor: null, // speedTargetValueType="factor"; null ⇒ delta
      speedContinuous: false, // continuous="true": tracks for good, never completes
      activePathEventId: null,
      pathKind: null, // 'follow_trajectory' | 'assign_route'
      waypoints: null,
      activeLaneChangeEventId: null,
      laneChange: null,
      // Lane offset, metres right of the centreline; applied when the pose is written back,
      // never to sim.x/y (the controller offsets its aim point, not its path).
      laneOffset: 0, // the offset actually driven, eased toward laneOffsetTarget
      laneOffsetTarget: 0, // what the controller's _offset is set to
      laneOffsetReturns: false, // continuous="false": completes on reaching, then resets to 0
      activeLaneOffsetEventId: null,
      laneFollow: null, // {lane, dirLine, idx} anchor while path-less
      badge: null,
      traveled: 0,
      frozen: false,
      goalStopped: false, // SimpleVehicleControl._reached_goal — sticky
      hasNoEvents: events.length === 0,
      noEventsBadgeShown: false,
    };
  }

  function _avgTrajectorySpeed(points) {
    // Vertex velocities become relativeTime at export and ScenarioRunner collapses them
    // into ONE average speed (total distance / total time).
    let totalDist = 0,
      totalTime = 0;
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - points[i - 1].x,
        dy = points[i].y - points[i - 1].y;
      const dist = Math.hypot(dx, dy);
      const v1 = points[i - 1].velocity ?? 10,
        v2 = points[i].velocity ?? 10;
      const avgV = (v1 + v2) / 2 || 1;
      totalDist += dist;
      totalTime += dist / avgV;
    }
    return totalTime > 0 ? totalDist / totalTime : 10;
  }

  /** A new longitudinal command ends the running speed atomic, relative tracking included. */
  function _supersedeSpeedEvent(sim, simTime) {
    if (!sim.activeSpeedEventId) return;
    const prev = sim.fired.get(sim.activeSpeedEventId);
    if (prev && prev.completedAt == null) prev.completedAt = simTime;
    sim.activeSpeedEventId = null;
    sim.speedRelativeRef = null;
    sim.speedRelativeDelta = 0;
    sim.speedRelativeFactor = null;
    sim.speedContinuous = false;
    sim.speedRampFrom = 0;
    sim.speedRampTarget = 0;
  }

  /**
   * A command lands on a running lane offset: another offset sets `_overwritten`, so the
   * new value stands (`reset` false); any other waypoint command resets it to 0.
   */
  function _supersedeLaneOffset(sim, simTime, { reset }) {
    if (sim.activeLaneOffsetEventId) {
      const prev = sim.fired.get(sim.activeLaneOffsetEventId);
      if (prev && prev.completedAt == null) prev.completedAt = simTime;
      sim.activeLaneOffsetEventId = null;
    }
    if (reset) sim.laneOffsetTarget = 0;
    sim.laneOffsetReturns = false;
  }

  /**
   * Starting an offset ends a running route/lane-change atomic (update_offset stamps the
   * waypoint slot too), but the controller keeps driving its list — so the waypoints stay
   * and an after_event on the route fires now.
   */
  function _supersedeWaypointEvents(sim, simTime) {
    for (const id of [sim.activePathEventId, sim.activeLaneChangeEventId]) {
      if (!id) continue;
      const rec = sim.fired.get(id);
      if (rec && rec.completedAt == null) rec.completedAt = simTime;
    }
  }

  function _applyEventAction(sim, ev, simTime) {
    sim.fired.set(ev.id, { firedAt: simTime, completedAt: null });
    const action = ev.action;
    if (sim.goalStopped && !sim.isWalker) {
      // The goal latch: the atomic still runs (a timed set_speed even completes), moving nothing.
      sim.badge = { icon: '⏹', text: 'Wirkungslos — steht nach Pfadende (CARLA hält das Fahrzeug dort fest)' };
      if (action.type !== 'set_speed') {
        // A new path completes at once (check_reached_waypoint_goal is still true).
        if (action.type === 'follow_trajectory' || action.type === 'assign_route') {
          sim.fired.get(ev.id).completedAt = simTime;
        }
        return;
      }
    }

    if (action.type === 'set_speed') {
      _supersedeSpeedEvent(sim, simTime);
      // A relative target is re-sampled every tick (see _stepActor), so keep its parameters.
      const target = action.target || {};
      const isRelative = target.mode === 'relative';
      sim.speedRelativeRef = isRelative ? target.entity_ref || run.egoId : null;
      sim.speedRelativeDelta = isRelative ? (target.delta ?? 0) : 0;
      sim.speedRelativeFactor = isRelative && target.value_type === 'factor' ? (target.factor ?? 1) : null;
      sim.speedContinuous = isRelative && target.continuous === true;
      sim.activeSpeedEventId = ev.id;
      sim.speedEventDuration = (action.dynamics && action.dynamics.value) ?? 5.0;
      // A continuous follow is emitted as a plain step: the atomic skips the ramp branch for it.
      sim.speedEventDimension = sim.speedContinuous ? 'time' : (action.dynamics && action.dynamics.dimension) || 'time';

      // Negative = „Rückwärts", vehicles only (PedestrianControl raises on it).
      const absolute = Math.max(0, target.value ?? 10) * (target.reverse === true && !sim.isWalker ? -1 : 1);
      const resolvedTarget = isRelative ? _relativeTarget(sim) : absolute;

      if (sim.speedEventDimension === 'rate') {
        // A rate ramp starts from the current speed (a magnitude) and snapshots its target
        // once, so a relative target stops tracking — the atomic's real behaviour.
        sim.speedRampFrom = Math.abs(sim.speed);
        sim.speedRampTarget = resolvedTarget;
        sim.speedRelativeRef = null;
        sim.target = sim.speedRampFrom;
      } else {
        sim.target = resolvedTarget;
      }
    } else if (action.type === 'follow_trajectory' || action.type === 'assign_route') {
      const isRoute = action.type === 'assign_route';
      const rawPoints = isRoute ? action.waypoints || [] : action.trajectory || [];
      if (!_actionEmits(action, sim.type)) return; // dropped at export — never applies
      _supersedeLaneOffset(sim, simTime, { reset: true });
      sim.activePathEventId = ev.id;
      sim.pathKind = action.type;

      if (isRoute) {
        // A route sets waypoints only: the actor keeps its speed, or stands still at 0.
        const exact = _exactRoute(sim, rawPoints);
        if (exact) {
          sim.waypoints = exact;
          sim.badge = null;
        } else {
          sim.waypoints = rawPoints.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0.2 }));
          sim.badge = { icon: '≈', text: 'Route ist ungefähr — kein CARLA-Kartengraph für diese Karte/Punkte' };
        }
      } else {
        // A trajectory's own ChangeActorTargetSpeed is longitudinal and ends any speed tracker
        // (routes and lane changes are waypoint commands and do not).
        _supersedeSpeedEvent(sim, simTime);
        sim.waypoints = rawPoints.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0.2 }));
        sim.target = _avgTrajectorySpeed(rawPoints);
        if (!sim.goalStopped || sim.isWalker) sim.badge = null;
      }

      while (sim.waypoints.length && _dist3(sim, sim.waypoints[0]) < LEADING_WAYPOINT_DROP_M) {
        sim.waypoints.shift();
      }
    } else if (action.type === 'lane_change') {
      _supersedeLaneOffset(sim, simTime, { reset: true });
      sim.activeLaneChangeEventId = ev.id;
      _startLaneChange(sim, action);
    } else if (action.type === 'lane_offset') {
      _startLaneOffset(sim, ev, action, simTime);
    } else if (action.type === 'set_distance') {
      // Not simulated, so it never completes here either.
      sim.badge = { icon: '−', text: 'set_distance wird in der Vorschau nicht simuliert' };
    }
  }

  /**
   * LaneOffsetAction: `continuous` (default) holds until superseded; `continuous: false`
   * completes on arrival and resets to 0. Positive is right of travel; the payload's
   * unsigned offset + direction is signed here.
   */
  function _startLaneOffset(sim, ev, action, simTime) {
    if (!_actionEmits(action, sim.type)) {
      // A walker never reads the offset; only a loaded file can carry this (the backend 400s).
      sim.badge = { icon: '⚠', text: 'Spurversatz wirkt nicht — nur Fahrzeuge folgen ihm' };
      return;
    }
    _supersedeLaneOffset(sim, simTime, { reset: false });
    _supersedeWaypointEvents(sim, simTime);

    const magnitude = Math.max(0, action.offset ?? 1.0);
    sim.laneOffsetTarget = action.direction === 'right' ? magnitude : -magnitude;
    sim.laneOffsetReturns = action.continuous === false;
    sim.activeLaneOffsetEventId = ev.id;
    if (sim.goalStopped) return;
    sim.badge =
      magnitude > 0
        ? {
            icon: '⇥',
            text: `Spurversatz ${UIUtils.fmt(magnitude)} m ${action.direction === 'right' ? 'rechts' : 'links'} (${sim.laneOffsetReturns ? 'hin & zurück' : 'dauerhaft'})`,
          }
        : { icon: '⇥', text: 'Zurück zur Spurmitte' };
  }

  function _startLaneChange(sim, action) {
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
      // No plan: ChangeActorLateralMotion reports FAILURE and never completes, so freeze.
      sim.frozen = true;
      sim.speed = 0;
      sim.target = 0;
      sim.badge = { icon: '⚠', text: `Spurwechsel ${dirLabel} nicht möglich — keine Nachbarspur in Fahrtrichtung` };
      return;
    }
    // Replaces leftover path waypoints, which would otherwise outrank lane-following afterwards.
    sim.waypoints = plan.waypoints;
    sim.laneChange = { active: true, endCursor: plan.endCursor, eventId: sim.activeLaneChangeEventId };
    const totalM = (LANE_CHANGE_SAME_LANE_M + diagTotal + LANE_CHANGE_OTHER_LANE_M).toFixed(0);
    // verified: the neighbour came from the graph (labelled by graph source), not geometry.
    const source = !plan.verified
      ? 'geschätzt'
      : AppState.laneGraph && AppState.laneGraph.source === 'xodr'
        ? 'aus Kartendatei'
        : 'CARLA-Kartendaten';
    sim.badge = { icon: '↔', text: `Spurwechsel ${dirLabel} läuft (~${totalM} m, ${source})` };
  }

  /** The plan ran out: ChangeActorLateralMotion's SUCCESS, after its other-lane distance. */
  function _completeLaneChange(sim) {
    const lc = sim.laneChange;
    lc.active = false;
    if (lc.eventId) {
      const rec = sim.fired.get(lc.eventId);
      if (rec) rec.completedAt = run.simTime;
    }
    sim.laneFollow = lc.endCursor;
    sim.badge = null;
  }

  SimCore.define({ _makeSimActor, _applyEventAction, _completeLaneChange });
})();
