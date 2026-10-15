/**
 * generatorTypesJunction.js — the green wave and the junction cross-traffic type.
 *
 * Part of the scenario generator; the design is described in scenarioGenerator.js.
 */
(() => {
  'use strict';

  const {
    VEHICLE_ACCEL,
    POST_JUNCTION_WP_M,
    r1,
    r2,
    _wrapDeg,
    _laneAt,
    _p,
    _buildCorridor,
    _corridorAt,
    _routeWp,
    _corridorWaypoints,
    _vehicle,
    _ignoresTraffic,
    _routeEvent,
    _speedEvent,
    nearEgo,
    _timeFromRest,
    _egoRunUp,
    _solveTrigger,
    _polylineCrossing,
    _walkBack,
    _turnKind,
    _walkForward,
    _distToPolyline,
  } = GeneratorCore.shared;

  // ── Traffic lights: a green wave for the ego ─────────────────────────────────
  //
  // The ego obeys reds, and a four-way cycle holds one for up to ~40 s: in
  // CARLA the ego sat 44 s at a red and reached the crossing pedestrian only as
  // every Act's 60 s stop trigger ended the run. The preview models no lights,
  // so it predicted a clean conflict. An AV under test waits there too.
  //
  // So every light the ego meets before the conflict is forced GREEN as it
  // approaches, with the editor's own signal events (a Schaltung: ego within N m
  // of the pole -> state). The light governing a connector lane comes straight
  // from the .xodr — each junction connector carries a <signalReference> to
  // exactly one light (map_renderer._extract_traffic_lights, `roads`).
  //
  // One forced state is not enough: TrafficLightStateSetter is a bare
  // set_state, and the light's group controller overwrites it at its next
  // phase change (a forced red lasted ~13 s in a Town05 run). simple_vehicle_
  // control stops only for RED and only inside the light's trigger volume, just
  // before the stop line — so the green is re-asserted at several distances,
  // the last a few metres short of the line, leaving no window for a phase
  // change to catch the ego there.
  const GREEN_WAVE_BEFORE_M = [55, 38, 24, 13, 5];

  /** Lights by the connector road they govern (CARLA lights only). */
  function _lightIndex(net) {
    if (net.lightByRoad) return net.lightByRoad;
    net.lightByRoad = new Map();
    for (const tl of AppState.mapData.trafficLights || []) {
      if (tl.inCarla === false) continue;
      for (const roadId of tl.roads || []) net.lightByRoad.set(String(roadId), tl);
    }
    return net.lightByRoad;
  }

  /** The lights an actor entering junction lane J has to obey: the one on J's
   * own road, plus any on a connector sharing J's entry point. A light's
   * trigger volume covers the approach lane, so a turn that is not itself
   * referenced still stops at its neighbour's red. */
  function _lightsFor(net, J) {
    const idx = _lightIndex(net);
    const entry = _laneAt(J, 0);
    const out = new Map();
    for (const C of net.byJunction.get(J.junctionId) || [J]) {
      const e = _laneAt(C, 0);
      if (C.key !== J.key && Math.hypot(e.x - entry.x, e.y - entry.y) > 2) continue;
      const tl = idx.get(String(C.road.id));
      if (tl) out.set(tl.id, tl);
    }
    return [...out.values()];
  }

  /** Does any light govern junction `junctionId` at all? */
  function _junctionSignalized(net, junctionId) {
    const idx = _lightIndex(net);
    return (net.byJunction.get(junctionId) || []).some((C) => idx.has(String(C.road.id)));
  }

  /** trafficSignals entries forcing every light on the corridor before
   * `dLimit` green as the ego approaches. Each Schaltung's radius is the 3-D
   * distance from the pole (at road height, z from the map) to the corridor
   * point that many metres before the stop line: ReachPositionCondition is a
   * plain location.distance(). */
  function _greenWave(net, c, dLimit) {
    const signals = new Map();
    for (const sg of c.segs) {
      if (!sg.L.junction || sg.startD >= dLimit) continue;
      for (const tl of _lightsFor(net, sg.L)) {
        const sig = signals.get(tl.id) || { id: tl.id, x: tl.x, y: tl.y, z: tl.z ?? 0, events: [] };
        for (const back of GREEN_WAVE_BEFORE_M) {
          const d = sg.startD - back;
          if (d < 0) continue;
          const p = _corridorAt(c, d);
          const r = Math.hypot(p.x - tl.x, p.y - tl.y, p.z - (tl.z ?? 0));
          sig.events.push({
            id: `traffic-event-${sig.events.length + 1}`,
            state: 'green',
            trigger_distance: r1(r + 0.3),
          });
        }
        // An entry at the very start of the corridor gets at least one.
        if (!sig.events.length) {
          sig.events.push({ id: 'traffic-event-1', state: 'green', trigger_distance: 1000 });
        }
        signals.set(tl.id, sig);
      }
    }
    return [...signals.values()];
  }

  // The conflict shapes the regulations and crash typologies name (Euro NCAP
  // CCFtap / CCFhol, NHTSA LTAP/OD and SCP, UN R171's turn-across-path and
  // crossing cases). `ego`/`npc` are the turn each one makes; `approach` is
  // where the NPC comes from relative to the ego.
  const JUNCTION_LAYOUTS = {
    crossing: { label: 'Querverkehr, beide geradeaus', ego: 'straight', npc: 'straight', approach: 'side' },
    ego_left_oncoming: {
      label: 'Ego biegt links ab, Gegenverkehr',
      ego: 'left',
      npc: 'straight',
      approach: 'oncoming',
    },
    npc_left_oncoming: { label: 'Gegenverkehr biegt links ab', ego: 'straight', npc: 'left', approach: 'oncoming' },
    ego_left_crossing: { label: 'Ego biegt links ab, Querverkehr', ego: 'left', npc: 'straight', approach: 'side' },
    ego_right_crossing: { label: 'Ego biegt rechts ab, Querverkehr', ego: 'right', npc: 'straight', approach: 'side' },
  };

  /** Where the NPC comes from, seen from the ego approaching the junction:
   * 'left' | 'right' | 'oncoming' | 'behind'. One coming from the ego's left
   * travels toward its right, i.e. a heading +90° from the ego's (y-down). */
  function _npcFrom(J, C) {
    const d = _wrapDeg(_laneAt(C, 0).yaw - _laneAt(J, 0).yaw);
    if (Math.abs(d) >= 135) return 'oncoming';
    if (Math.abs(d) <= 45) return 'behind';
    return d > 0 ? 'left' : 'right';
  }

  /** Which JUNCTION_LAYOUTS entry an ego connector J and an NPC connector C
   * make, or 'other'. */
  function _junctionLayout(J, C, approachDiff) {
    const e = _turnKind(J),
      n = _turnKind(C);
    const app = approachDiff >= 150 ? 'oncoming' : approachDiff >= 50 && approachDiff <= 130 ? 'side' : null;
    if (app === 'side' && n === 'straight') return e === 'straight' ? 'crossing' : `ego_${e}_crossing`;
    if (app === 'oncoming' && e === 'left' && n === 'straight') return 'ego_left_oncoming';
    if (app === 'oncoming' && e === 'straight' && n === 'left') return 'npc_left_oncoming';
    return 'other';
  }

  /* Junction cross traffic. The ego's corridor crosses a junction; another
   * vehicle approaches on a connector that crosses the ego's, released so both
   * reach the crossing point at about the same time. The NPC ignores lights
   * and obstacles (_ignoresTraffic), so it neither waits at a red nor brakes
   * for the ego crossing in front of it; the ego's own light is forced green
   * by build() (_greenWave), so at a signalized junction a perpendicular
   * conflict is a red-light runner. */
  function _junctionConflict(rng, net, vEgo) {
    const c = _buildCorridor(rng, net, rng.range(200, 300));
    if (!c) return null;
    const dMin = _egoRunUp(vEgo) + vEgo * 3;
    // A pinned layout narrows the junctions to ones where the ego makes the
    // turn it needs. Unpinned, nothing is filtered and no extra draw is made,
    // so every seed still builds what it built before the layout existed.
    const wantLayout = _p('layout', null);
    const egoNeeds = JUNCTION_LAYOUTS[wantLayout]?.ego;
    const wantFrom = _p('npc_from', null);
    const juncSegs = c.segs.filter(
      (sg) =>
        sg.L.junction && sg.startD > dMin && sg.endD < c.length - 15 && (!egoNeeds || _turnKind(sg.L) === egoNeeds),
    );
    if (!juncSegs.length) return null;
    const sg = rng.pick(juncSegs);
    const J = sg.L;
    const jStart = _laneAt(J, 0);

    const options = [];
    for (const C of net.byJunction.get(J.junctionId) || []) {
      if (C.key === J.key) continue;
      const X = _polylineCrossing(J, C);
      if (!X || X.sA < 1 || X.sA > J.length - 1 || X.sB < 1 || X.sB > C.length - 1) continue;
      const cStart = _laneAt(C, 0);
      if (Math.hypot(cStart.x - jStart.x, cStart.y - jStart.y) < 3) continue; // same approach
      const approachDiff = Math.abs(_wrapDeg(cStart.yaw - jStart.yaw));
      if (approachDiff < 30) continue;
      const layout = _junctionLayout(J, C, approachDiff);
      if (wantLayout && layout !== wantLayout) continue;
      const from = _npcFrom(J, C);
      if (wantFrom && from !== wantFrom) continue;
      options.push({ C, X, oncoming: approachDiff >= 150, layout, from });
    }
    if (!options.length) return null;
    const { C, X, oncoming, layout, from } = rng.pick(options);
    // At a signalized junction the ego gets a forced green (_greenWave) and
    // the NPC ignores lights, so a perpendicular conflict there is a
    // red-light runner — a real case, not an artefact.
    const signalized = _junctionSignalized(net, J.junctionId);

    // From "waiting at the line, pulls out" (6 m) to "approaching from well
    // back" (55 m): the shorter the run-up, the less warning the ego gets.
    const back = _walkBack(rng, net, C.key, rng.range(6, 55));
    if (!back) return null;
    const npcPose = _laneAt(back.L, back.s);
    const vNpc = _p('npc_speed', rng.range(7, 13));
    const npcToX = back.walked + X.sB;
    const tNpc = _timeFromRest(npcToX, vNpc);
    const dt = _p('arrival_offset_s', rng.range(-0.6, 0.8)); // ego arrives this much after the NPC
    const dX = sg.startD + X.sA;
    const sol = _solveTrigger(c, dX, tNpc + dt, vEgo, npcPose);
    if (!sol) return null;

    // Route: past the junction onto C's successor, so A* reproduces C.
    const exitKey = (net.succ.get(C.key) || [])[0];
    const exitL = exitKey && net.lanes.get(exitKey);
    if (!exitL) return null;
    const exitS = Math.min(POST_JUNCTION_WP_M, exitL.length - 0.5);
    const exitPose = _laneAt(exitL, exitS);
    // ...and well on past it. The route's end is where SimpleVehicleControl
    // stops dead (_reached_goal), and right after the exit is often the road
    // the ego turns onto: measured in CARLA (Town03 junction 238) the NPC
    // parked 5 m past the junction, the ego stopped 8.7 m behind it and sat
    // there until every Act's 60 s stop trigger, its own route never complete.
    const runOn = _walkForward(rng, net, exitL.key, exitS, rng.range(60, 90));
    const runOnPose = runOn && _laneAt(runOn.L, runOn.s);
    // ...unless "on past it" is the ego's own road. An NPC that turns into the
    // ego's lane runs ahead of it, and 60–90 m on it parks on the ego's route:
    // measured in CARLA (Town03 junction 655, seed 24) the scripted ego stopped
    // 5.3 m behind it and waited out the 60 s stop trigger. Then it follows the
    // corridor to its end and the ego's route ends 60 m short of that, as with
    // the lead car; a run-on that merges into the ego's path later is refused.
    let npcWps = runOnPose ? [_routeWp(exitPose), _routeWp(runOnPose)] : [_routeWp(exitPose)];
    let egoEndD;
    const endPose = runOnPose || exitPose; // the walk can dead-end: then the route stops at the exit
    const pastJ = c.pts.filter((p) => p.d > sg.endD);
    if (pastJ.length > 1 && _distToPolyline(pastJ, endPose.x, endPose.y) < 2.5) {
      const joinSeg = c.segs.find((s2) => s2.L.key === exitL.key && s2.startD >= sg.endD - 1);
      if (!joinSeg || c.length - 60 < dX + 30) return null;
      npcWps = [_routeWp(exitPose), ..._corridorWaypoints(c, joinSeg.startD + exitS)];
      egoEndD = c.length - 60;
    }

    const type = _p(
      'npc_type',
      rng.weighted([
        ['car', 6],
        ['van', 2],
        ['truck', 1],
        ['motorcycle', 1],
        ['police', 0.5],
        ['ambulance', 0.5],
      ]),
    );
    const npc = _vehicle(type, npcPose, 0);
    _ignoresTraffic(npc);
    npc.events = [
      _routeEvent(npc, npcWps),
      // A rate ramp at the controller's own acceleration, so the preview's
      // timing and CARLA's agree (a 'time' step is instant in the preview but
      // ramps at 3 m/s² in CARLA).
      _speedEvent('evt-2', nearEgo(sol.radius), vNpc, 'rate', VEHICLE_ACCEL),
    ];
    return {
      corridor: c,
      npcs: [npc],
      props: [],
      conflictD: dX,
      egoEndD,
      params: {
        layout,
        npc_from: from,
        npc_type: type,
        junction: J.junctionId,
        signalized,
        oncoming,
        npc_speed: r1(vNpc),
        npc_run_up_m: r1(npcToX),
        arrival_offset_s: r2(dt),
        trigger_m: r1(sol.radius),
      },
      routedNpcs: [{ actor: npc, passes: X }],
      onsets: new Map([[npc.id, _laneAt(C, 0)]]),
    };
  }

  GeneratorCore.define({ _greenWave, JUNCTION_LAYOUTS, _junctionConflict });
})();
