/**
 * simulate.js — In-editor preview simulation.
 *
 * A per-tick kinematic model of what ScenarioRunner will actually do, not an
 * idealisation of what the author drew. Every actor (ego included) is driven
 * by the same real controllers this scenario exports to
 * (SimpleVehicleControl / PedestrianControl, both in
 * ../../scenario_runner/srunner/scenariomanager/actorcontrols/): they bypass
 * CARLA's vehicle physics entirely and write a target velocity straight onto
 * the actor. A walker's speed is therefore exactly what was commanded; a
 * vehicle's is the commanded speed after SimpleVehicleControl's own per-tick
 * max_acceleration / max_deceleration clamp (_applyControllerLimits) — both
 * are exactly reproducible here, not approximations. The genuinely
 * unknowable part is road-network topology CARLA's map builder resolves
 * internally (which successor lane a fork-following actor picks, the A*
 * route a `assign_route` action actually drives): this preview does not have
 * that data, so it stops and badges rather than guessing a path it cannot
 * justify. See the "In-editor preview fidelity" plan for the full analysis.
 *
 * All 7 real event triggers (simulation_time, distance_to_ego,
 * distance_to_point, ego_speed, relative_speed, after_event, event_started)
 * are evaluated, including the two rewrites
 * the backend applies at export time (assign_route forces its own trigger to
 * simulation_time@0; an after_event chained onto a dropped/assign_route
 * event never fires) — mirrored here so the preview matches the .xosc that
 * export would actually produce, not the raw authored event.
 *
 * lane_offset IS simulated: the actor's path-following maths keeps running on
 * the driven centreline and the offset is added when the pose is written back
 * (_pose), which is what SimpleVehicleControl does — it displaces the waypoint
 * it aims at and never touches its waypoint list. The atomic's supersede rules
 * are mirrored exactly, because they decide whether the offset survives the
 * next action (_supersedeLaneOffset).
 *
 * set_distance is deliberately NOT simulated (badge only) — its real
 * semantics (a 100 m/s speed spike, then a gap measured in OpenDRIVE `s` or a
 * planned route length) need the same road graph `assign_route` does, and
 * the action may not see real use; simulating it is deferred until it does.
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
   * The point list an assign_route actor is actually driven along: the cached
   * lane graph routed between the authored waypoints (LaneGraph.route, a port
   * of GlobalRoutePlanner.trace_route) and then filtered exactly as
   * ChangeActorWaypoints filters it. Returns null when the town has no lane
   * graph or the very first lane lookup fails.
   *
   * `rawPoints` defaults to the event's own waypoints. mapPaths.js draws this
   * instead of the straight chords between the clicks — the clicks are where
   * the route must PASS, not the shape it takes to get there, and a straight
   * line between two of them crosses buildings and oncoming lanes it will
   * never touch. It caches the result, because this walks every lane segment
   * on the map once per authored waypoint and renderAllActors runs per frame
   * during a drag.
   */
  function routeGeometry(actor, ev, rawPoints = null) {
    if (!actor || !ev) return null;
    const points = rawPoints || ev.action?.waypoints || [];
    if (points.length < 2) return null;
    // Through _makeSimActor so the seed sees the same normalized events (and
    // the same initial pose) the preview would; _exactRoute reads only the
    // actor's position off it, but building it by hand would be a second,
    // drifting definition of what a sim actor is.
    //
    // ...off the AUTHORED pose, though, never the live one. A running preview
    // rewrites actor.x/y every tick, and leg 0 is seeded from the actor's own
    // position — so computing this from the live pose made the drawn route
    // crawl along underneath the moving vehicle, redrawn every frame. The
    // route is a property of the scenario, not of where the car has got to.
    const sim = _makeSimActor({ ...actor, ...(authoredPose(actor.id) || {}) }, actor.type === 'ego');
    return _exactRoute(sim, points);
  }

  /**
   * The pose an actor had before the preview picked it up, or null when no
   * preview is running (in which case the actor's own pose IS the authored
   * one). mapPaths.js needs it for the same reason routeGeometry does: its
   * cache signature keys on the pose, and a live pose would invalidate the
   * entry on every tick.
   */
  function authoredPose(actorId) {
    if (!run.running) return null;
    const orig = _originals.get(actorId);
    return orig ? { x: orig.x, y: orig.y, z: orig.z, yaw: orig.yaw } : null;
  }

  /**
   * The whole preview, run to completion in one call, with no rendering and
   * no writes to AppState — the same _makeSimActor / _stepActor the Play
   * button drives, at a fixed `dt`. Returns
   *   { egoId, dt, times: [t…], tracks: {actorId: [{x, y, speed}…]},
   *     fired: {actorId: {eventId: firedAt}}, ended: 'teardown'|'time'|'stopped' }
   * or null while a live preview is running (the two share this module's
   * tick state). generatorAssess.js measures conflicts off the tracks.
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
    // `ego`/`npcs` default to the editor's scenario; the generator passes a
    // candidate it has not loaded, so it can score one before committing it.
    // _makeSimActor reads only the actor it is given, and cross-actor lookups
    // go through _simActors, so nothing here needs the candidate in AppState.
    if (run.running) return null;
    const actors = [ego, ...npcs].filter(Boolean);
    if (!actors.length) return null;
    const savedTime = run.simTime;
    // Scoring wants the ego that does nothing, whatever the preview's switch says.
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
      // stopWhenIdle ends the run where the preview's own timeline does
      // (_simulateTimeline): nothing moved and no event fired for
      // TAIL_AFTER_ACTIVITY_S, and none is left that could still fire. The
      // Ablauf panel asks for it so its axis matches the preview bar's; the
      // generator's scoring keeps the old rule.
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
        // Everything has been standing still for 10 s and no event can still
        // move it before the distance fallback — nothing more will happen.
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
    // The generator stops a running preview before it replaces the scenario:
    // runHeadless refuses to run beside it, and the preview's Stop would then
    // try to put back poses on actors that no longer exist.
    get running() {
      return run.running;
    },
    get reactiveEgo() {
      return run.reactiveEgo;
    },
    // Jump the preview to time t (starting it paused if none runs) — the
    // event timeline's block click (eventTimeline.js).
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
    // routeForTesting exists purely for tests/test_route_fidelity_e2e.py: it
    // returns the route without running the animation. Asserting on the route
    // directly is deterministic, whereas sampling a moving actor can only ever
    // catch a reversal that happens to straddle two samples.
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
