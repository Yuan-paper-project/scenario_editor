/**
 * simulate.js — the in-editor preview's public API (Simulate).
 *
 * A per-tick kinematic model of what ScenarioRunner will do: the same controllers
 * (SimpleVehicleControl / PedestrianControl, with their speed limits), all seven
 * triggers, the export-time rewrites, lane_offset and its supersede rules. Where the
 * road topology is unknowable (an unranked fork) it stops and badges instead of
 * guessing. set_distance is not simulated (badge only). Details: CLAUDE.md, "The
 * in-editor preview".
 */
(() => {
  'use strict';

  const {
    run,
    _originals,
    _simActors,
    _tickSpeeds,
    _tickCompleted,
    _tickStarted,
    DISTANCE_TO_EGO_FALLBACK_S,
    ACT_TEARDOWN_DISTANCE_M,
    _pose,
    _exactRoute,
    _makeSimActor,
    _footprintOf,
    _stepActor,
    TAIL_AFTER_ACTIVITY_S,
    timeline,
    _snapshotSpeeds,
    _timeListeners,
    _startSimulation,
    _pauseSimulation,
    _seek,
    _stopSimulation,
    r3,
  } = SimCore.shared;

  /**
   * The points an assign_route actor is driven along: LaneGraph.route between the
   * waypoints, filtered like ChangeActorWaypoints; null without a graph or a first
   * lane. mapPaths.js draws this (and caches it: it scans every lane segment).
   */
  function routeGeometry(actor, ev, rawPoints = null) {
    if (!actor || !ev) return null;
    const points = rawPoints || ev.action?.waypoints || [];
    if (points.length < 2) return null;
    // Through _makeSimActor, so the seed sees the same normalized events, and off the
    // authored pose, so the route does not crawl under a running preview.
    const sim = _makeSimActor({ ...actor, ...(authoredPose(actor.id) || {}) }, actor.type === 'ego');
    return _exactRoute(sim, points);
  }

  /** The actor's pre-preview pose, or null when no preview runs (its pose is the authored one). */
  function authoredPose(actorId) {
    if (!run.running) return null;
    const orig = _originals.get(actorId);
    return orig ? { x: orig.x, y: orig.y, z: orig.z, yaw: orig.yaw } : null;
  }

  /**
   * The whole preview in one call, no rendering, no AppState writes. Returns
   *   { egoId, dt, times, tracks: {actorId: [{x, y, speed}]}, fired, completed, ended }
   * or null while a live preview runs (they share tick state).
   */
  function runHeadless({
    dt = 0.05,
    maxTime = 40,
    ego = AppState.ego,
    npcs = AppState.npcs,
    reactiveEgo = false,
    props = [],
    stopWhenIdle = false,
  } = {}) {
    // `ego`/`npcs` default to the editor's; the generator scores a candidate it has not loaded.
    if (run.running) return null;
    const actors = [ego, ...npcs].filter(Boolean);
    if (!actors.length) return null;
    const savedTime = run.simTime;
    const savedReact = run.reactiveEgo;
    run.reactiveEgo = !!reactiveEgo;
    const savedStatic = run.staticObstacles;
    run.staticObstacles = (props || []).map((o) => ({ x: o.x, y: o.y, ..._footprintOf('prop', o.prop) }));
    _simActors.clear();
    _tickSpeeds.clear();
    _tickCompleted.clear();
    _tickStarted.clear();
    run.egoId = ego ? ego.id : null;
    try {
      for (const a of actors) _simActors.set(a.id, _makeSimActor(a, a.id === run.egoId));
      _snapshotSpeeds();
      const egoSim = run.egoId ? _simActors.get(run.egoId) : null;
      const times = [];
      const tracks = {};
      for (const id of _simActors.keys()) tracks[id] = [];
      let ended = 'time';
      let still = 0;
      const frozenAt = {};
      // stopWhenIdle ends where the preview bar's run does (the Ablauf panel); scoring keeps
      // the generator's own rule.
      const seen = new Set();
      let lastActivity = 0;
      for (run.simTime = 0; run.simTime < maxTime; ) {
        run.simTime += dt;
        const egoPrevPos = egoSim ? { ..._pose(egoSim), z: egoSim.z } : null;
        _snapshotSpeeds();
        for (const sim of _simActors.values()) _stepActor(sim, dt, egoPrevPos, run.simTime);
        times.push(r3(run.simTime));
        let moving = false;
        for (const sim of _simActors.values()) {
          const p = _pose(sim);
          tracks[sim.id].push({ x: p.x, y: p.y, speed: sim.speed });
          if (sim.frozen && frozenAt[sim.id] == null) frozenAt[sim.id] = r3(run.simTime);
          if (Math.abs(sim.speed) > 0.05 && !sim.frozen && !sim.goalStopped) moving = true;
        }
        if (egoSim && egoSim.traveled >= ACT_TEARDOWN_DISTANCE_M) {
          ended = 'teardown';
          break;
        }
        if (stopWhenIdle) {
          let active = moving;
          let pending = false;
          for (const sim of _simActors.values()) {
            for (const ev of sim.events) {
              if (!sim.fired.has(ev.id)) {
                if (!ev.trigger.neverFires && !sim.frozen) pending = true;
              } else if (!seen.has(`${sim.id}::${ev.id}`)) {
                seen.add(`${sim.id}::${ev.id}`);
                active = true;
              }
            }
          }
          if (active) lastActivity = run.simTime;
          if (!pending && run.simTime - lastActivity >= TAIL_AFTER_ACTIVITY_S) {
            ended = 'idle';
            break;
          }
          continue;
        }
        // Still for 10 s with nothing able to move it before the fallback: done.
        still = moving ? 0 : still + dt;
        if (still > 10 && run.simTime > DISTANCE_TO_EGO_FALLBACK_S) {
          ended = 'stopped';
          break;
        }
      }
      const fired = {};
      const completed = {}; // actorId -> eventId -> completedAt (absent while still running)
      const frozen = {}; // actorId -> the badge it froze with (lane ran out, no successor, …)
      for (const sim of _simActors.values()) {
        fired[sim.id] = {};
        completed[sim.id] = {};
        for (const [eventId, rec] of sim.fired) {
          fired[sim.id][eventId] = r3(rec.firedAt);
          if (rec.completedAt != null) completed[sim.id][eventId] = r3(rec.completedAt);
        }
        if (sim.frozen) frozen[sim.id] = sim.badge ? sim.badge.text : 'frozen';
      }
      return { egoId: run.egoId, dt, times, tracks, fired, completed, frozen, frozenAt, ended };
    } finally {
      _simActors.clear();
      _tickSpeeds.clear();
      _tickCompleted.clear();
      _tickStarted.clear();
      run.egoId = null;
      run.simTime = savedTime;
      run.reactiveEgo = savedReact;
      run.staticObstacles = savedStatic;
    }
  }

  window.Simulate = {
    runHeadless,
    get running() {
      return run.running;
    },
    get reactiveEgo() {
      return run.reactiveEgo;
    },
    // Jump to time t, starting a paused preview if none runs (Ablauf block click).
    seek(t) {
      _seek(t);
    },
    stop() {
      if (run.running) _stopSimulation();
    },
    pause() {
      _pauseSimulation();
    },
    play() {
      _startSimulation();
    },
    get paused() {
      return run.paused;
    },
    get time() {
      return run.running ? timeline.viewTime : null;
    },
    get end() {
      return run.running ? timeline.end : null;
    },
    /** fn(t) on every shown frame, fn(null) on Stop. */
    onTime(fn) {
      _timeListeners.push(fn);
    },
    // Test hook (test_route_fidelity_e2e.py): the route without running the animation.
    routeForTesting(actor) {
      const sim = _makeSimActor(actor, actor.type === 'ego');
      const ev = (sim.events || []).find((e) => e.action && e.action.type === 'assign_route');
      if (!ev) return null;
      return _exactRoute(sim, ev.action.waypoints || []);
    },
    routeGeometry,
    authoredPose,
  };
})();
