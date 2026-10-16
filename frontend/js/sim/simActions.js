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
      // The Init <SpeedAction>: ChangeActorTargetSpeed(..., init_speed=True)
      // runs in InitialActorSettings on tick 1, before any Act's
      // SimulationTime>0 start trigger, so the actor already has this speed
      // when the story begins. Nothing else is needed to model "unless a later
      // speed action replaces it" — set_speed and follow_trajectory both assign
      // sim.speed when they fire, exactly as BasicControl.update_target_speed()
      // overwrites _target_speed. An actor with no events gets no Act at all,
      // so for it this is the only speed it ever has.
      // `target` is what the atomics command (BasicControl._target_speed), and
      // `speed` what the actor actually drives after SimpleVehicleControl's
      // rate limits. A vehicle spawns at rest and pulls up to its Init speed at
      // max_acceleration; PedestrianControl sets the speed outright, so a walker
      // starts at it.
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
      // ChangeActorLaneOffset — metres right of the driven path's centreline
      // (negative is left), and the event currently holding it. The offset is
      // applied when the pose is written back, NOT to sim.x/sim.y, so the
      // path-following maths keeps running on the centreline exactly as
      // SimpleVehicleControl's own waypoint list does — the controller offsets
      // its aim point, it does not re-plan around the displaced position.
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
    // Mirrors _compute_trajectory_times + openscenario_parser's patched
    // FollowTrajectoryAction handling: per-waypoint velocities are baked into
    // relativeTime, then collapsed back into ONE average speed for the whole
    // path (total_dist / total_time) — the real controller never sees the
    // per-segment values a trajectory was authored with.
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
    sim.speedRelativeFactor = null;
    sim.speedContinuous = false;
    sim.speedRampFrom = 0;
    sim.speedRampTarget = 0;
  }

  /** A lateral/waypoint command lands while a lane offset is running.
   *
   * ChangeActorLaneOffset.update() ends on EITHER of two mismatches, and which
   * one decides whether the offset survives:
   *  - another lane offset (`get_last_lane_offset_command()`) sets `_overwritten`
   *    and returns SUCCESS, so `terminate()` skips its reset and the NEW offset
   *    stands. That is what makes "drift out, then a second event back to 0"
   *    work at all;
   *  - any other waypoint command (a route, a trajectory, a lane change) returns
   *    SUCCESS with `_overwritten` still false, so `terminate()` puts the offset
   *    back to 0.
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

  /** The mirror of the rule above, in the other direction: ActorControl's
   * update_offset() stamps `_last_waypoint_command` as well as its own slot, so
   * starting a lane offset makes a running ChangeActorWaypoints /
   * ChangeActorLateralMotion report SUCCESS immediately.
   *
   * It does NOT call update_waypoints(), so the controller keeps driving the
   * list it already has — only the atomic ends. That is why the waypoints and
   * the lane-change plan are deliberately left untouched here: the visible
   * consequence is that an after_event waiting on that route fires the moment
   * the offset starts rather than when the route finishes. */
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
      // SimpleVehicleControl._reached_goal is a one-way latch: run_step returns
      // zero velocity before it reads any target. The atomic still runs (a
      // timed set_speed even completes), it just moves nothing.
      sim.badge = { icon: '⏹', text: 'Wirkungslos — steht nach Pfadende (CARLA hält das Fahrzeug dort fest)' };
      if (action.type !== 'set_speed') {
        // A path action's ChangeActorWaypoints sees check_reached_waypoint_goal()
        // still true and ends at once; a lane change or offset never gets to.
        if (action.type === 'follow_trajectory' || action.type === 'assign_route') {
          sim.fired.get(ev.id).completedAt = simTime;
        }
        return;
      }
    }

    if (action.type === 'set_speed') {
      _supersedeSpeedEvent(sim, simTime);
      // ChangeActorTargetSpeed.initialise(): a relative target samples the
      // reference ONCE here, but the atomic goes on re-sampling it every tick
      // for the whole duration (see _stepActor), so the parameters are kept.
      const target = action.target || {};
      const isRelative = target.mode === 'relative';
      sim.speedRelativeRef = isRelative ? target.entity_ref || run.egoId : null;
      sim.speedRelativeDelta = isRelative ? (target.delta ?? 0) : 0;
      sim.speedRelativeFactor = isRelative && target.value_type === 'factor' ? (target.factor ?? 1) : null;
      sim.speedContinuous = isRelative && target.continuous === true;
      sim.activeSpeedEventId = ev.id;
      sim.speedEventDuration = (action.dynamics && action.dynamics.value) ?? 5.0;
      // The emitter forces a continuous follow to a plain step ('time'): with
      // continuous="true" the atomic's ramp branch is skipped anyway.
      sim.speedEventDimension = sim.speedContinuous ? 'time' : (action.dynamics && action.dynamics.dimension) || 'time';

      // A negative absolute target is „Rückwärts" — vehicles only (the backend
      // rejects it for a walker, whose controller raises on it).
      const absolute = Math.max(0, target.value ?? 10) * (target.reverse === true && !sim.isWalker ? -1 : 1);
      const resolvedTarget = isRelative ? _relativeTarget(sim) : absolute;

      if (sim.speedEventDimension === 'rate') {
        // The rate branch does NOT step: initialise() commands _start_speed and
        // update() ramps from there. It also snapshots _target_speed once and
        // then overwrites its own per-tick relative re-sample with the ramp, so
        // a relative target stops tracking the moment a rate is used — that is
        // the atomic's real behaviour, not a shortcut taken here.
        // _start_speed is CarlaDataProvider.get_velocity — a magnitude.
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
          sim.waypoints = rawPoints.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0.2 }));
          sim.badge = { icon: '≈', text: 'Route ist ungefähr — kein CARLA-Kartengraph für diese Karte/Punkte' };
        }
      } else {
        // FollowTrajectoryAction parses into a Sequence whose first child is
        // ChangeActorTargetSpeed with its own start_time — a LONGITUDINAL
        // command, so it cancels any running relative-speed tracker. Neither
        // assign_route nor lane_change does (both issue waypoint commands
        // only, stamped on a separate _last_waypoint_command).
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
      // Deliberately not simulated — see file header. Never completes, so any
      // after_event chained onto it never fires here either, matching the
      // real gap-measurement / 100 m/s spike being unknowable without the
      // same lane graph assign_route needs.
      sim.badge = { icon: '−', text: 'set_distance wird in der Vorschau nicht simuliert' };
    }
  }

  /**
   * ChangeActorLaneOffset with an AbsoluteTargetLaneOffset, always
   * continuous="true" — the only mode the emitter writes, and the only one that
   * does anything (see _add_lane_offset_action). So this event never completes
   * on its own; it ends only when something supersedes it, which is exactly what
   * _supersedeLaneOffset models.
   *
   * Positive is right of travel. The editor's payload carries an unsigned
   * `offset` plus a `direction`, the same shape lane_change uses, and the sign
   * is applied here and in the emitter rather than stored.
   */
  function _startLaneOffset(sim, ev, action, simTime) {
    if (!_actionEmits(action, sim.type)) {
      // A walker: PedestrianControl stores the controller offset and never
      // reads it. The backend rejects this payload outright, so it can only
      // arrive in a loaded save file — badge it rather than move the actor
      // sideways in a way CARLA never would.
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
      // Mirrors generate_target_waypoint_list_multilane returning (None,
      // None) — ChangeActorLateralMotion.update then reports FAILURE and the
      // maneuver never completes, so we stop advancing this actor rather
      // than pretend a lane change happened.
      sim.frozen = true;
      sim.speed = 0;
      sim.target = 0;
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
    const source = !plan.verified
      ? 'geschätzt'
      : AppState.laneGraph && AppState.laneGraph.source === 'xodr'
        ? 'aus Kartendatei'
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
      if (rec) rec.completedAt = run.simTime;
    }
    sim.laneFollow = lc.endCursor;
    sim.badge = null;
  }

  SimCore.define({ _makeSimActor, _applyEventAction, _completeLaneChange });
})();
