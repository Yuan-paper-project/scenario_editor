/**
 * simMotion.js — per-tick motion, the controller limits, the reacting ego and _stepActor.
 *
 * Part of the in-editor preview (Simulate); see simulate.js.
 */
(() => {
  'use strict';

  const {
    run,
    _simActors,
    VEHICLE_WAYPOINT_ACCEPT_M,
    VRU_WAYPOINT_ACCEPT_M,
    _pose,
    _walkDirLine,
    SVC_MIN_PULL_AWAY,
    LANE_OFFSET_THRESHOLD_M,
    LANE_OFFSET_APPROACH_M,
    _triggerSatisfied,
    _laneAnchor,
    _nextLaneCursor,
    _applyEventAction,
    _completeLaneChange,
    _relativeTarget,
  } = SimCore.shared;

  function _advanceWaypoints(sim, dt) {
    const acceptR = sim.isWalker ? VRU_WAYPOINT_ACCEPT_M : VEHICLE_WAYPOINT_ACCEPT_M;
    let remaining = sim.speed * dt;
    while (remaining > 1e-9 && sim.waypoints.length) {
      const target = sim.waypoints[0];
      const dx = target.x - sim.x,
        dy = target.y - sim.y;
      const dist2d = Math.hypot(dx, dy);
      if (dist2d <= acceptR) {
        // Switch aim the moment it is within radius, without spending this tick's distance.
        sim.waypoints.shift();
        if (!sim.waypoints.length) {
          if (sim.laneChange && sim.laneChange.active) {
            // CARLA hands over fresh lane-follow waypoints on SUCCESS; no stop here.
            _completeLaneChange(sim);
          } else {
            sim.speed = 0; // dead stop on _reached_goal, not a coast
            sim.target = 0;
            // ChangeActorWaypoints succeeds on reaching the goal, so an after_event on it fires now.
            const pathRec = sim.activePathEventId && sim.fired.get(sim.activePathEventId);
            if (pathRec && pathRec.completedAt == null) pathRec.completedAt = run.simTime;
            // The goal latch: zero velocity from here on, whatever the atomics write.
            sim.goalStopped = true;
            if (sim.pathKind === 'follow_trajectory') sim.badge = null;
          }
          return;
        }
        continue;
      }
      const step = Math.min(remaining, dist2d);
      const frac = step / dist2d;
      sim.x += dx * frac;
      sim.y += dy * frac;
      sim.z += (target.z - sim.z) * frac;
      sim.yaw = (Math.atan2(dy, dx) * 180) / Math.PI;
      sim.traveled += step;
      remaining -= step;
    }
  }

  /** Reversing: straight back along the heading, without turning; waypoints and anchor are kept. */
  function _advanceReverse(sim, dt) {
    const rad = ((sim.yaw || 0) * Math.PI) / 180;
    const step = sim.speed * dt; // negative
    sim.x += Math.cos(rad) * step;
    sim.y += Math.sin(rad) * step;
    sim.traveled += Math.abs(step);
  }

  /**
   * SimpleVehicleControl._set_new_velocity's limits, literally: per tick at most
   * max_deceleration·dt down / max_acceleration·dt up from the LAST COMMANDED speed,
   * with the 0.5 m/s pull-away bump; a reverse target always takes the deceleration
   * branch. Walkers have no limits. `want` is the target after reacting-ego braking.
   */
  function _applyControllerLimits(sim, want, dt) {
    if (sim.isWalker) {
      sim.speed = Math.max(0, want);
      return;
    }
    const current = Math.abs(sim.speed);
    if (sim.lastCmd == null) sim.lastCmd = current;
    let cmd = want;
    if (want < current) {
      cmd = Math.max(want, sim.lastCmd - dt * sim.maxDecel);
    } else {
      const tmp = Math.min(want, sim.lastCmd + dt * sim.maxAccel);
      cmd = Math.max(tmp, Math.min(SVC_MIN_PULL_AWAY, want));
    }
    sim.lastCmd = cmd;
    sim.speed = cmd;
  }

  /** Ease the driven offset toward the target per metre travelled; a non-continuous offset
   *  completes within OFFSET_THRESHOLD and resets to 0 (the patched atomic). */
  function _advanceLaneOffset(sim, travelled, simTime) {
    const diff = sim.laneOffsetTarget - sim.laneOffset;
    if (diff !== 0) {
      sim.laneOffset += diff * (1 - Math.exp(-travelled / LANE_OFFSET_APPROACH_M));
      if (Math.abs(sim.laneOffsetTarget - sim.laneOffset) < 0.005) sim.laneOffset = sim.laneOffsetTarget;
    }
    if (
      sim.laneOffsetReturns &&
      sim.activeLaneOffsetEventId &&
      Math.abs(sim.laneOffset - sim.laneOffsetTarget) < LANE_OFFSET_THRESHOLD_M
    ) {
      const rec = sim.fired.get(sim.activeLaneOffsetEventId);
      if (rec && rec.completedAt == null) rec.completedAt = simTime;
      sim.activeLaneOffsetEventId = null;
      sim.laneOffsetReturns = false;
      sim.laneOffsetTarget = 0;
      sim.badge = { icon: '⇥', text: 'Spurversatz erreicht — zurück zur Spurmitte' };
    }
  }

  function _advanceStraight(sim, dt) {
    // A walker without waypoints walks its forward vector, i.e. its spawn yaw.
    const rad = (sim.spawnYaw * Math.PI) / 180;
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

  /** At the end of the lane, re-anchor onto the graph's preferred successor; false if none. */
  function _continueLaneFollowAtFork(sim) {
    const next = _nextLaneCursor(sim.laneFollow);
    if (!next) return false;
    sim.laneFollow = next;
    const graphSource =
      AppState.laneGraph && AppState.laneGraph.source === 'xodr' ? 'aus Kartendatei abgeleitet' : 'CARLA-Kartendaten';
    sim.badge = { icon: '↷', text: `Fährt an bekannter Abzweigung weiter (${graphSource})` };
    return true;
  }

  function _advanceLaneFollow(sim, dt) {
    if (!_ensureLaneFollowAnchor(sim)) return;
    const dirLine = sim.laneFollow.dirLine;
    const r = _walkDirLine(dirLine, sim.x, sim.y, sim.z, sim.laneFollow.idx, sim.speed * dt);
    sim.x = r.x;
    sim.y = r.y;
    sim.z = r.z;
    if (r.yaw != null) sim.yaw = r.yaw;
    sim.laneFollow.idx = r.idx;
    sim.traveled += r.consumed;
    if (r.ranOut) {
      if (_continueLaneFollowAtFork(sim)) return;
      sim.frozen = true;
      sim.speed = 0;
      sim.target = 0;
      // Stops rather than guess which way CARLA's next(2.0)[0] would turn.
      sim.badge = { icon: '❓', text: 'Pfad ab hier unbekannt — Route/Trajektorie hinzufügen' };
    }
  }

  function _advancePosition(sim, dt) {
    // The vehicle goal latch: nothing moves it again (see _applyEventAction).
    if (sim.goalStopped && !sim.isWalker) {
      sim.speed = 0;
      return;
    }
    if (sim.speed < 0) {
      _advanceReverse(sim, dt);
      return;
    }
    if (sim.waypoints && sim.waypoints.length) {
      _advanceWaypoints(sim, dt);
      return;
    }
    if (sim.speed <= 0) return; // stationary — also the honest state for an
    if (sim.isWalker) _advanceStraight(sim, dt);
    else _advanceLaneFollow(sim, dt);
  }

  // ── Reacting ego („Ego bremst", preview only) ──────────────────────────────
  // Caps the ego's commanded target by the braking room to anything in its path
  // (stopping REACT_STANDOFF_M short); the controller limits do the braking, so the
  // event logic never sees it. Not a model of CARLA's consider_obstacles.
  const REACT_PLAN_DECEL = 6.0; // m/s², what it plans a stop with
  const REACT_STANDOFF_M = 2.0; // bumper gap it stops at
  const REACT_LOOKAHEAD_M = 60;

  function _footprintOf(type, prop) {
    if (type === 'prop') {
      const ps = window.PropCatalog?.planSize ? PropCatalog.planSize(prop) : null;
      return { len: ps?.len || 1, wid: ps?.wid || 1 };
    }
    const sz = MapView.actorSize(type) || { w: 4.5, h: 2.1 };
    return { len: sz.w, wid: sz.h || sz.w };
  }

  /** Braking-room speed to the nearest thing in the ego's path; Infinity when clear. */
  function _egoAllowedSpeed(ego) {
    const p = _pose(ego);
    const rad = ((ego.yaw || 0) * Math.PI) / 180;
    const cx = Math.cos(rad),
      cy = Math.sin(rad);
    const me = _footprintOf(ego.body || 'ego');
    let gapMin = Infinity;
    const consider = (x, y, len, wid) => {
      const dx = x - p.x,
        dy = y - p.y;
      const lon = dx * cx + dy * cy;
      const lat = -dx * cy + dy * cx;
      if (lon <= 0 || lon > REACT_LOOKAHEAD_M) return;
      // Its extent across the path, whatever its heading: conservative.
      if (Math.abs(lat) > me.wid / 2 + Math.max(len, wid) / 2 + 0.3) return;
      gapMin = Math.min(gapMin, lon - me.len / 2 - Math.min(len, wid) / 2);
    };
    for (const o of _simActors.values()) {
      if (o === ego) continue;
      const q = _pose(o);
      const fp = _footprintOf(o.body || o.type);
      consider(q.x, q.y, fp.len, fp.wid);
    }
    for (const o of run.staticObstacles) consider(o.x, o.y, o.len, o.wid);
    if (!Number.isFinite(gapMin)) return Infinity;
    return Math.sqrt(Math.max(0, 2 * REACT_PLAN_DECEL * (gapMin - REACT_STANDOFF_M)));
  }

  /** The ego's commanded target, capped by the braking room (only ever lowered). */
  function _reactEgoTarget(sim) {
    const want = Math.min(sim.target, _egoAllowedSpeed(sim));
    const braking = want < sim.target - 0.3;
    if (braking && !sim.reactBadge) {
      sim.reactBadge = true;
      sim.badge = { icon: '⏹', text: 'Ego bremst — Hindernis im Fahrweg' };
    } else if (!braking && sim.reactBadge) {
      sim.reactBadge = false;
      if (sim.badge && sim.badge.text.startsWith('Ego bremst')) sim.badge = null;
    }
    return want;
  }

  function _stepActor(sim, dt, egoPrevPos, simTime) {
    if (sim.frozen) return;

    if (sim.hasNoEvents) {
      // No events → no Act: it holds its start speed for the whole run. Badged once.
      if (!sim.noEventsBadgeShown) {
        sim.noEventsBadgeShown = true;
        sim.badge =
          sim.target > 0
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
      // ChangeActorTargetSpeed.update(): a relative target is re-sampled every tick before
      // the duration test, so the last tracked value is held after the window. `rate`
      // ramps and ends on arrival instead; continuous never ends on its own.
      if (sim.activeSpeedEventId) {
        const rec = sim.fired.get(sim.activeSpeedEventId);
        if (rec && rec.completedAt == null) {
          if (sim.speedRelativeRef && !sim.goalStopped) sim.target = _relativeTarget(sim);
          if (sim.speedEventDimension === 'rate') {
            // start ± rate·elapsed, clamped at the target (a negative relative target is not clamped).
            const elapsed = simTime - rec.firedAt;
            const sign = sim.speedRampTarget >= sim.speedRampFrom ? 1 : -1;
            const ramped = sim.speedRampFrom + sign * sim.speedEventDuration * elapsed;
            const commanded = sign > 0 ? Math.min(ramped, sim.speedRampTarget) : Math.max(ramped, sim.speedRampTarget);
            if (!sim.goalStopped) sim.target = commanded;
            if (commanded === sim.speedRampTarget) rec.completedAt = simTime;
          } else if (sim.speedContinuous) {
          } else if (sim.speedEventDimension === 'time' && simTime - rec.firedAt >= sim.speedEventDuration) {
            rec.completedAt = simTime;
          }
        }
      }
    }

    const want = run.reactiveEgo && sim.isEgo ? _reactEgoTarget(sim) : sim.target;
    if (!(sim.goalStopped && !sim.isWalker)) _applyControllerLimits(sim, want, dt);
    const before = sim.traveled;
    _advancePosition(sim, dt);
    _advanceLaneOffset(sim, sim.traveled - before, simTime);
  }

  SimCore.define({ _footprintOf, _stepActor });
})();
