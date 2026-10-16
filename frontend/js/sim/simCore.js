/**
 * simCore.js — shared run state, the tunables mirroring the real controllers, and small geometry helpers.
 *
 * Part of the in-editor preview (Simulate); see simulate.js.
 */
(() => {
  'use strict';

  window.SimCore = UIUtils.sharedScope('SimCore');

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ── Run state ────────────────────────────────────────────────────────────────

  // One shared object rather than lets, so every preview file sees the same state.
  const run = {
    running: false,
    paused: false,
    simTime: 0, // seconds elapsed in simulation (the stepping clock)
    egoId: null,
    // „Ego bremst"
    reactiveEgo: false,
    staticObstacles: [], // [{x, y, len, wid}] for the run being simulated
  };
  const _originals = new Map(); // actorId → {x, y, z, yaw}, to restore on stop
  const _simActors = new Map(); // actorId → sim actor record (see _makeSimActor)
  const _tickSpeeds = new Map(); // actorId → speed, snapshotted once per tick
  const _tickPoses = new Map(); // actorId → {x, y, z}, snapshotted with it
  // `actorId::eventId` → completedAt, snapshotted per tick so a cross-actor reference does
  // not depend on stepping order (a same-actor one reads sim.fired live).
  const _tickCompleted = new Map();
  // `actorId::eventId` → firedAt, the event_started counterpart of the above.
  const _tickStarted = new Map();

  // ── Tunables mirroring the real controllers ─────────────────────────────────
  // Each is a value cited from simple_vehicle_control.py / pedestrian_control.py /
  // atomic_behaviors.py, not a preview choice.

  const DISTANCE_TO_EGO_FALLBACK_S = 60.0; // event_builders.py fallback_time
  const ACT_TEARDOWN_DISTANCE_M = 500.0; // every Act's StopTrigger
  const VEHICLE_WAYPOINT_ACCEPT_M = 4.0; // SimpleVehicleControl explicit-waypoint advance
  const VRU_WAYPOINT_ACCEPT_M = 1.0; // PedestrianControl advance
  const LEADING_WAYPOINT_DROP_M = 0.5; // both controllers, on activation
  const LANE_CHANGE_SAME_LANE_M = 5.0; // _distance_same_lane constant
  const LANE_CHANGE_OTHER_LANE_M = 10.0; // distance_other_lane, hardcoded in the parser call
  const LANE_NEIGHBOR_MIN_M = 1.5; // plausible adjacent-lane lateral offset band
  const LANE_NEIGHBOR_MAX_M = 6.5;
  const LANE_NEIGHBOR_DIR_TOLERANCE_DEG = 45; // "same direction of travel" tolerance
  const LANE_SEARCH_MAX_DIST_M = 15; // how far to reach for a lane anchor

  // ChangeActorWaypoints.initialise's filter, as in the install run.sh runs (CLAUDE.md, Verification).
  const ROUTE_SEED_AHEAD_M = 1.0; // ego_waypoint.next(1)[0]
  const ROUTE_DEDUP_MIN_M = 1.0; // drop a point closer than this to the last kept one
  const ROUTE_SHORT_REF_M = 0.5; // reference vector too short to give a heading
  const ROUTE_HEADING_ACCEPT_LO = 2.0; // accept when |delta| < LO ...
  const ROUTE_HEADING_ACCEPT_HI = 4.3; // ... or > HI; the band between is a reversal

  // ── Small geometry helpers ───────────────────────────────────────────────────

  function _dist3(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
  }

  /**
   * Where the actor is: sim.x/y stay on the driven centreline and the lane offset is
   * added here, as SimpleVehicleControl offsets only its aim point — storing it would
   * let _walkDirLine walk it back off. Right of travel is positive.
   */
  function _pose(sim) {
    if (!sim || !sim.laneOffset) return sim;
    const rad = ((sim.yaw || 0) * Math.PI) / 180;
    return {
      x: sim.x - sim.laneOffset * Math.sin(rad),
      y: sim.y + sim.laneOffset * Math.cos(rad),
      z: sim.z,
    };
  }

  function _angleDiffDeg(a, b) {
    return Math.abs(((((a - b + 180) % 360) + 360) % 360) - 180);
  }

  /** Advance up to `step` m along `dirLine` from (x, y, z), aiming at dirLine[startIdx] like the controllers. */
  function _walkDirLine(dirLine, x, y, z, startIdx, step) {
    let idx = startIdx;
    let cx = x,
      cy = y,
      cz = z,
      yaw = null;
    let remaining = step;
    while (remaining > 1e-9 && idx < dirLine.length) {
      const [tx, ty, tz = 0] = dirLine[idx];
      const dx = tx - cx,
        dy = ty - cy;
      const dist = Math.hypot(dx, dy);
      if (dist < 1e-6) {
        idx += 1;
        continue;
      }
      const seg = Math.min(remaining, dist);
      const frac = seg / dist;
      cx += dx * frac;
      cy += dy * frac;
      cz += (tz - cz) * frac;
      yaw = (Math.atan2(dy, dx) * 180) / Math.PI;
      remaining -= seg;
      if (seg >= dist - 1e-9) idx += 1;
    }
    return {
      x: cx,
      y: cy,
      z: cz,
      yaw,
      idx,
      consumed: step - remaining, // actual arc length walked, short of `step` if the line ran out
      ranOut: idx >= dirLine.length && remaining > 1e-9,
    };
  }

  // Defaults when the actor states none, as the emitter writes them (xml_builder._DYNAMICS_DEFAULTS).
  const DEFAULT_MAX_ACCEL = 3.0;
  const DEFAULT_MAX_DECEL = 10.0;
  // The controller bumps a positive command to at least this to pull away.
  const SVC_MIN_PULL_AWAY = 0.5;
  // ChangeActorLaneOffset.OFFSET_THRESHOLD (m).
  const LANE_OFFSET_THRESHOLD_M = 0.1;
  // The lateral gap decays as exp(−d / L) with distance driven (halves every ~2 m), measured
  // in CARLA (Town04 road 40, tests/carla/run_actions_ext_carla.py).
  const LANE_OFFSET_APPROACH_M = 3.0;
  const r3 = (v) => Math.round(v * 1000) / 1000;

  SimCore.define({
    SVG_NS,
    run,
    _originals,
    _simActors,
    _tickSpeeds,
    _tickPoses,
    _tickCompleted,
    _tickStarted,
    DISTANCE_TO_EGO_FALLBACK_S,
    ACT_TEARDOWN_DISTANCE_M,
    VEHICLE_WAYPOINT_ACCEPT_M,
    VRU_WAYPOINT_ACCEPT_M,
    LEADING_WAYPOINT_DROP_M,
    LANE_CHANGE_SAME_LANE_M,
    LANE_CHANGE_OTHER_LANE_M,
    LANE_NEIGHBOR_MIN_M,
    LANE_NEIGHBOR_MAX_M,
    LANE_NEIGHBOR_DIR_TOLERANCE_DEG,
    LANE_SEARCH_MAX_DIST_M,
    ROUTE_SEED_AHEAD_M,
    ROUTE_DEDUP_MIN_M,
    ROUTE_SHORT_REF_M,
    ROUTE_HEADING_ACCEPT_LO,
    ROUTE_HEADING_ACCEPT_HI,
    _dist3,
    _pose,
    _angleDiffDeg,
    _walkDirLine,
    DEFAULT_MAX_ACCEL,
    DEFAULT_MAX_DECEL,
    SVC_MIN_PULL_AWAY,
    LANE_OFFSET_THRESHOLD_M,
    LANE_OFFSET_APPROACH_M,
    r3,
  });
})();
