/**
 * simCore.js — shared run state, the tunables mirroring the real controllers, and small geometry helpers.
 *
 * Part of the in-editor preview (Simulate); see simulate.js.
 */
(() => {
  'use strict';

  window.SimCore = UIUtils.sharedScope('SimCore');

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ── Playback state ───────────────────────────────────────────────────────────

  // Run state read by every part of the preview — one shared object rather than
  // reassigned lets, so the stepping, the timeline and playback all see one copy.
  const run = {
    running: false,
    paused: false,
    simTime: 0, // seconds elapsed in simulation (the stepping clock)
    egoId: null,
    // „Ego bremst" (see the reacting-ego section)
    reactiveEgo: false,
    staticObstacles: [], // [{x, y, len, wid}] for the run being simulated
  };
  const _originals = new Map(); // actorId → {x, y, z, yaw}, to restore on stop
  const _simActors = new Map(); // actorId → sim actor record (see _makeSimActor)
  const _tickSpeeds = new Map(); // actorId → speed, snapshotted once per tick
  const _tickPoses = new Map(); // actorId → {x, y, z}, snapshotted with it
  // `actorId::eventId` → completedAt, snapshotted once per tick. Same reasoning
  // as _tickSpeeds: a cross-actor after_event that read another actor's live
  // fired-map would resolve differently depending on which actor _stepActor
  // reached first, and CARLA's own blackboard reads are not ordered either.
  // A SAME-actor reference still reads sim.fired live — that is one behaviour
  // tree ticking its own events and has no ordering ambiguity to remove.
  const _tickCompleted = new Map();
  // `actorId::eventId` → firedAt, the event_started counterpart of the above.
  const _tickStarted = new Map();

  // ── Tunables mirroring the real controllers ─────────────────────────────────
  // simple_vehicle_control.py / pedestrian_control.py / atomic_behaviors.py —
  // see file header. Kept as named constants rather than inline literals
  // because each one is a specific, cited real-world value, not a preview
  // choice.

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

  // ChangeActorWaypoints.initialise, as patched in the install run.sh runs
  // (/home/dellpro2/Antonio/scenario_runner — see CLAUDE.md, Verification;
  // the yungloon checkout carries the same filter but is run by nothing). These govern which of
  // the router's points survive into the actor's waypoint list.
  const ROUTE_SEED_AHEAD_M = 1.0; // ego_waypoint.next(1)[0]
  const ROUTE_DEDUP_MIN_M = 1.0; // drop a point closer than this to the last kept one
  const ROUTE_SHORT_REF_M = 0.5; // reference vector too short to give a heading
  const ROUTE_HEADING_ACCEPT_LO = 2.0; // accept when |delta| < LO ...
  const ROUTE_HEADING_ACCEPT_HI = 4.3; // ... or > HI; the band between is a reversal

  // Which actor types AssignRouteAction accepts — mirrors _ROUTE_ACTION_TYPES in
  // ../llm-scenario-gen/generator/event_builders.py. Shared with eventPanel.js
  // (which greys the action out) and the export gate via scenarioRules.js.
  const ROUTE_ACTION_TYPES = ScenarioRules.ROUTE_ACTION_TYPES;

  // ── Small geometry helpers ───────────────────────────────────────────────────

  function _dist3(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
  }

  /**
   * Where the actor actually IS, as opposed to where its path-following maths
   * is: `sim.x`/`sim.y` stay on the driven centreline and a lane offset is
   * added here.
   *
   * The split is not tidiness. SimpleVehicleControl offsets the waypoint it
   * AIMS at (`_offset_waypoint`) and leaves its waypoint list alone, and
   * `_walkDirLine` walks from the position it is handed toward the next
   * centreline point — so storing the displaced position back into sim.x/y
   * would make the actor converge back onto the centreline over the next few
   * ticks and quietly eat the offset.
   *
   * Right of travel is positive, matching `transform.get_right_vector()`: the
   * editor's frame IS CARLA's (the single Y flip happens in the .xodr parser),
   * so forward is (cos yaw, sin yaw) and right is (−sin yaw, cos yaw).
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

  /**
   * Advance up to `step` metres of arc length along `dirLine`, starting from
   * point (x, y, z) aiming at dirLine[startIdx]. Mirrors how both real
   * controllers aim at the next map/route waypoint from wherever the actor
   * currently is, not from the exact point on the line.
   */
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

  // SimpleVehicleControl's rate limits when the actor states none — the same
  // defaults the emitter writes (xml_builder._DYNAMICS_DEFAULTS).
  const DEFAULT_MAX_ACCEL = 3.0;
  const DEFAULT_MAX_DECEL = 10.0;
  // "If the tmp_speed is < 0.5 the vehicle may not properly accelerate" — the
  // controller bumps a positive command to at least this.
  const SVC_MIN_PULL_AWAY = 0.5;
  // ChangeActorLaneOffset.OFFSET_THRESHOLD: a non-continuous offset is reached
  // within this many metres.
  const LANE_OFFSET_THRESHOLD_M = 0.1;
  // How fast the displaced aim point pulls the actor sideways. Measured in CARLA
  // (Town04 road 40, 8 m/s, 1.75 m, tests/run_actions_ext_carla.py): the
  // remaining lateral gap decays exponentially with distance driven — it halves
  // every ~2 m, out and back alike — because SimpleVehicleControl steers
  // straight at a waypoint a few metres ahead. So the gap shrinks by
  // 1 − exp(−d / L) per d metres, with this L.
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
