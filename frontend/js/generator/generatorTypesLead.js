/**
 * generatorTypesLead.js — scenario types with a vehicle or bike ahead in the ego's lane.
 *
 * Part of the scenario generator; the design is described in scenarioGenerator.js.
 */
(() => {
  'use strict';

  const {
    WAYPOINT_CLEARANCE,
    r1,
    r2,
    _projectOnLane,
    _p,
    _buildCorridor,
    _corridorAt,
    _junctionFree,
    _corridorWaypoints,
    _vehicle,
    _routeEvent,
    _speedEvent,
    nearEgo,
    _centreDistance,
    after,
    VEHICLE_MIX,
  } = GeneratorCore.shared;

  // ── Scenario types ───────────────────────────────────────────────────────────

  /* Lead vehicle brakes. A slower car ahead in the ego's own lane, following
   * the same route, brakes hard when the ego has closed to a time headway. */
  function _leadBrake(rng, net, vEgo) {
    const c = _buildCorridor(rng, net, rng.range(260, 360));
    if (!c) return null;
    // Time headway (bumper gap / ego speed) at which the lead brakes. 1-3 s
    // brackets the usual ACC settings; an ego following at a longer headway
    // than this never closes in, and the brake waits for the 60 s fallback.
    const thw = _p('brake_headway_s', rng.range(1.0, 3.0));
    const type = _p('lead_type', rng.weighted(VEHICLE_MIX));
    const trigger = _centreDistance(Math.max(6, thw * vEgo), type);
    const gap0 = trigger + rng.range(15, 35); // initial gap, ego closes from behind
    if (!_junctionFree(c, gap0 - 6, gap0 + 6)) return null;
    const pose = _corridorAt(c, gap0);
    // A lead at or above the ego's speed is never caught: cap an override.
    const vLead = Math.min(_p('lead_speed', vEgo * rng.range(0.55, 0.8)), vEgo * 0.9);
    const decel = _p('decel', rng.range(2.5, 8));
    // Each draw is made whether or not it is overridden, so the RNG sequence
    // (and with it the site a seed lands on) does not depend on the overrides.
    const stopDraw = rng.chance(0.7);
    const vEnd = _p('end_speed', stopDraw ? 0 : rng.range(1.5, 4));
    const stopFully = vEnd === 0;
    const hold = _p('hold_s', rng.range(3, 8));

    const lead = _vehicle(type, pose, vLead);
    // The lights on the corridor are forced green by the EGO's approach
    // (_greenWave), and the lead reaches each one first — waiting at a red the
    // ego has not yet switched would park it there and fire its brake trigger
    // early. So it drives through; there is no cross traffic to meet.
    lead.obey_traffic_lights = false;
    const events = [
      _routeEvent(lead, _corridorWaypoints(c, gap0)),
      _speedEvent('evt-2', nearEgo(trigger), vEnd, 'rate', decel),
      _speedEvent('evt-3', after('evt-2'), vEnd, 'time', hold),
    ];
    // A full stop that never drives off blocks the ego's lane for the rest of
    // the run (measured in CARLA: the scripted ego covered 45 m and waited out
    // the 60 s stop trigger), so most full stops pull away again.
    const resume = _p('resumes', rng.chance(stopFully ? 0.75 : 0.4));
    if (resume) events.push(_speedEvent('evt-4', after('evt-3'), vLead, 'rate', 2.5));
    lead.events = events;
    // Where the ego catches up: it closes at vEgo - vLead from gap0 to the trigger.
    const dCatch = gap0 + (vLead * (gap0 - trigger)) / (vEgo - vLead);
    return {
      corridor: c,
      npcs: [lead],
      props: [],
      conflictD: dCatch + 30,
      egoEndD: c.length - 60,
      params: {
        lead_type: type,
        initial_gap_m: r1(gap0),
        lead_speed: r1(vLead),
        brake_headway_s: r2(thw),
        trigger_m: r1(trigger),
        decel: r1(decel),
        end_speed: r1(vEnd),
        hold_s: r1(hold),
        resumes: resume,
      },
      routedNpcs: [{ actor: lead, corridorFrom: gap0 }],
    };
  }

  /* Slower vehicle ahead (Euro NCAP CCRm, UN R171 "slower moving target",
   * NHTSA "closes in on a lead vehicle moving at lower constant speed"): a
   * vehicle in the ego's lane at a constant, much lower speed — a truck, a
   * motorcycle, possibly well off the lane centre — that the ego closes in
   * on. Unlike lead_brake nothing changes when the ego arrives: the closing
   * speed is the test. */
  function _slowLead(rng, net, vEgo) {
    const c = _buildCorridor(rng, net, rng.range(260, 360));
    if (!c) return null;
    const type = _p(
      'lead_type',
      rng.weighted([
        ['car', 4],
        ['van', 1],
        ['truck', 2],
        ['motorcycle', 2],
      ]),
    );
    // A lead at or near the ego's speed is never caught: cap an override.
    const vLead = Math.min(_p('lead_speed', vEgo * rng.range(0.2, 0.55)), vEgo * 0.8);
    const gap0 = _p('initial_gap_m', rng.range(40, 80)); // centre to centre
    const dCatch = gap0 + (vLead * gap0) / (vEgo - vLead);
    if (dCatch > c.length - 70) return null;
    // Where the ego closes in, the lane is not a junction: a turn there makes
    // it a different scenario, and an offset lead cuts the corner.
    if (!_junctionFree(c, gap0 - 6, gap0 + 6) || !_junctionFree(c, dCatch - 25, dCatch + 10)) return null;
    const offDraw = rng.chance(0.4) ? rng.range(0.3, 1.0) : 0;
    const off = _p('lateral_m', offDraw);
    const side = _p('side', rng.chance(0.5) ? 'right' : 'left');

    const lead = _vehicle(type, _corridorAt(c, gap0), vLead);
    // It reaches each light before the ego switches it green (_greenWave).
    lead.obey_traffic_lights = false;
    const events = [_routeEvent(lead, _corridorWaypoints(c, gap0))];
    if (off > 0) {
      // As soon as the ego has started closing in, never off the clock. A
      // held offset, so the lead stays there for the rest of the run.
      events.push({
        id: 'evt-2',
        trigger: nearEgo(gap0 - 3),
        action: { type: 'lane_offset', direction: side, offset: r1(off) },
      });
    }
    lead.events = events;
    return {
      corridor: c,
      npcs: [lead],
      props: [],
      conflictD: dCatch + 20,
      egoEndD: c.length - 60,
      params: {
        lead_type: type,
        lead_speed: r1(vLead),
        speed_diff_kmh: Math.round((vEgo - vLead) * 3.6),
        initial_gap_m: r1(gap0),
        lateral_m: r1(off),
        side,
      },
      routedNpcs: [{ actor: lead, corridorFrom: gap0 }],
      // Nothing releases it: it is a threat from the start.
      threats: new Map([[lead.id, 'evt-1']]),
    };
  }

  /* Cut-out (Euro NCAP CCRs cut-out). The ego follows a lead car in its lane;
   * the lead swerves into a same-direction neighbour lane at the last moment
   * and uncovers a stopped vehicle the ego could not see past it.
   *
   * Timing is ego-relative through the following itself: the lead drives at
   * the ego's speed a time headway ahead, and its lane change fires on its own
   * position (distance_to_point on its own entity — positional, like the
   * walker that stops in the lane). An AV that follows closer or further back
   * meets the reveal with a different time to the obstacle, which is the
   * point. The lead ignores obstacles (its sensor would brake it for the
   * stopped car it is meant to swerve around) and lights (it reaches each
   * forced-green light before the ego switches it). */
  function _cutOut(rng, net, vEgo) {
    if (!net.multiLane) {
      net.multiLane = net.startable.filter(
        (L) =>
          L.length >= 90 &&
          ['left', 'right'].some((side) => {
            const ref = L.record && L.record[side];
            const N = ref && net.lanes.get(net.refKey(ref));
            return N && !N.junction;
          }),
      );
    }
    if (!net.multiLane.length) return null;
    const start = rng.pick(net.multiLane);
    const c = _buildCorridor(
      rng,
      net,
      rng.range(220, 320),
      undefined,
      start,
      rng.range(0, Math.max(0.5, start.length - 120)),
    );
    if (!c) return null;
    const candidates = [];
    for (const sg of c.segs) {
      if (sg.L.junction || !sg.L.record) continue;
      for (const side of ['left', 'right']) {
        const ref = sg.L.record[side];
        const N = ref && net.lanes.get(net.refKey(ref));
        if (!N || N.junction) continue;
        const back = N.record && N.record[side === 'left' ? 'right' : 'left'];
        if (back && net.refKey(back) === sg.key) candidates.push({ sg, N, side });
      }
    }
    if (!candidates.length) return null;
    const { sg, N, side } = rng.pick(candidates);

    const type = _p('lead_type', rng.weighted(VEHICLE_MIX.filter(([t]) => t !== 'bus' && t !== 'motorcycle')));
    const stoppedType = _p(
      'stopped_type',
      rng.weighted([
        ['car', 4],
        ['van', 2],
        ['truck', 1],
      ]),
    );
    const thw = _p('headway_s', rng.range(0.9, 2.0)); // following headway, s
    const gap0 = _centreDistance(thw * vEgo, type); // lead ahead of the ego
    const lcDist = _p('lane_change_m', rng.range(8, 14)); // lateral move spread
    // From the start of the swerve to the stopped car, as late as the lead can
    // make it: the lane change runs 6 m in its own lane, then moves across
    // over lcDist, and the two bodies stop overlapping about 60% of the way
    // over (a 2.1 m car in a 3.5 m lane). Plus both half-lengths and a margin.
    // Drawn generously the ego saw the obstacle 4-7 s out — far too easy.
    const len = (t) => MapView.actorSize(t).w;
    const cutMargin = _p('cut_margin_m', rng.range(1.5, 10));
    const cutDist = 6 + 0.6 * lcDist + (len(type) + len(stoppedType)) / 2 + cutMargin;
    const dCut = rng.range(Math.max(sg.startD + 2, gap0 + 25), sg.endD - cutDist - 4);
    if (!(dCut > sg.startD) || dCut + cutDist + 4 > sg.endD) return null;
    const dObs = dCut + cutDist;
    if (!_junctionFree(c, 0, dObs + 15)) return null;
    // The swerve has to land on N with room for ChangeActorLateralMotion's
    // 10 m driven in the target lane — it never fails, it hangs.
    const cutPose = _corridorAt(c, dCut);
    const onN = _projectOnLane(N, cutPose.x, cutPose.y);
    if (!onN || onN.d > 6 || onN.s + 6 + lcDist + 25 > N.length) return null;

    const vLead = vEgo * rng.range(0.92, 1.0);
    const lead = _vehicle(type, _corridorAt(c, gap0), vLead);
    lead.obey_traffic_lights = false;
    lead.obey_obstacles = false;
    lead.events = [
      {
        id: 'evt-1',
        trigger: {
          type: 'distance_to_point',
          value: 2.0,
          entity_ref: lead.id,
          point: { name: 'Point 1', x: r1(cutPose.x), y: r1(cutPose.y), z: r2(cutPose.z + WAYPOINT_CLEARANCE) },
        },
        action: { type: 'lane_change', direction: side, dynamics: { shape: 'linear', value: r1(lcDist) } },
      },
    ];

    const stopped = _vehicle(stoppedType, _corridorAt(c, dObs), 0);
    // Most stopped cars move off once the ego is right behind them: one that
    // never does blocks the lane until every Act's 60 s stop trigger. The
    // radius is a 9 m bumper gap: the scripted ego halts ~6.3 m behind (10.8 m
    // centre to centre, measured on Town05), so a 6 m one was never reached
    // and the car left only on the 60 s fallback.
    const drivesOff = _p('stopped_drives_off', rng.chance(0.7));
    stopped.events = drivesOff
      ? [_speedEvent('evt-1', nearEgo(_centreDistance(9, stoppedType)), r1(rng.range(6, 10)), 'rate', 2.0)]
      : [];
    return {
      corridor: c,
      npcs: [lead, stopped],
      props: [],
      conflictD: dObs + 10,
      params: {
        lead_type: type,
        stopped_type: stoppedType,
        side,
        headway_s: r2(thw),
        lead_speed: r1(vLead),
        lane_change_m: r1(lcDist),
        cut_to_obstacle_m: r1(cutDist),
        cut_margin_m: r1(cutMargin),
        stopped_drives_off: drivesOff,
      },
      routedNpcs: [],
      // The lead is the reveal, not the conflict.
      sceneryIds: new Set([lead.id]),
      revealedBy: new Map([[stopped.id, { actorId: lead.id, eventId: 'evt-1' }]]),
    };
  }

  /* Cyclist ahead. A slower cyclist rides at the right edge of the ego's lane;
   * the ego has to follow or pass. Half of them swerve out toward the lane
   * centre as the ego closes in — around a parked car or a pothole. */
  function _cyclistAhead(rng, net, vEgo) {
    const c = _buildCorridor(rng, net, rng.range(200, 300));
    if (!c) return null;
    const vBike = _p('speed', rng.range(3, 6));
    const gap0 = _p('initial_gap_m', rng.range(30, 60));
    const tCatch = gap0 / (vEgo - vBike);
    // A cyclist has no route (assign_route is for vehicles the planner routes,
    // and `bike` is not one), so it lane-follows: keep its whole ride before
    // the ego catches it on one straight stretch, where there is no fork to
    // guess at.
    if (!_junctionFree(c, gap0 - 8, gap0 + vBike * tCatch + 25)) return null;
    const pose = _corridorAt(c, gap0);
    const edgeOffset = _p('edge_offset_m', rng.range(0.8, 1.2));
    const bike = _vehicle('cyclist', pose, vBike);
    const events = [
      {
        id: 'evt-1',
        trigger: nearEgo(400), // at once: rides at the edge from the start
        action: { type: 'lane_offset', direction: 'right', offset: r1(edgeOffset) },
      },
    ];
    const swerves = _p('swerves', rng.chance(0.5));
    let swerveTtc = null;
    if (swerves) {
      swerveTtc = _p('swerve_ttc_s', rng.range(1.2, 3.5));
      // A second offset supersedes the first (its _overwritten flag), so this
      // is a move from the edge out to `out` metres left of the lane centre.
      events.push({
        id: 'evt-2',
        trigger: nearEgo(_centreDistance(Math.max(6, (vEgo - vBike) * swerveTtc), 'cyclist')),
        action: { type: 'lane_offset', direction: 'left', offset: r1(rng.range(0.0, 0.8)) },
      });
    }
    bike.events = events;
    return {
      corridor: c,
      npcs: [bike],
      props: [],
      conflictD: gap0 + vBike * tCatch + 10,
      params: {
        speed: r1(vBike),
        initial_gap_m: r1(gap0),
        edge_offset_m: r1(edgeOffset),
        swerves,
        swerve_ttc_s: swerveTtc && r2(swerveTtc),
      },
      routedNpcs: [],
      threats: swerves ? new Map([[bike.id, 'evt-2']]) : null,
    };
  }

  GeneratorCore.define({ _leadBrake, _slowLead, _cutOut, _cyclistAhead });
})();
