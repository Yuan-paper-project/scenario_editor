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

  /* Lead brake: a slower car ahead on the ego's route brakes hard at a time headway. */
  function _leadBrake(rng, net, vEgo) {
    const c = _buildCorridor(rng, net, rng.range(260, 360));
    if (!c) return null;
    // Headway (bumper gap / ego speed) at which it brakes; 1–3 s brackets ACC settings.
    const thw = _p('brake_headway_s', rng.range(1.0, 3.0));
    const type = _p('lead_type', rng.weighted(VEHICLE_MIX));
    const trigger = _centreDistance(Math.max(6, thw * vEgo), type);
    const gap0 = trigger + rng.range(15, 35); // initial gap, ego closes from behind
    if (!_junctionFree(c, gap0 - 6, gap0 + 6)) return null;
    const pose = _corridorAt(c, gap0);
    // A lead at or above the ego's speed is never caught: cap an override.
    const vLead = Math.min(_p('lead_speed', vEgo * rng.range(0.55, 0.8)), vEgo * 0.9);
    const decel = _p('decel', rng.range(2.5, 8));
    // Drawn whether or not pinned, so the seed's site does not depend on the pins.
    const stopDraw = rng.chance(0.7);
    const vEnd = _p('end_speed', stopDraw ? 0 : rng.range(1.5, 4));
    const stopFully = vEnd === 0;
    const hold = _p('hold_s', rng.range(3, 8));

    const lead = _vehicle(type, pose, vLead);
    // It reaches each light before the ego forces it green; waiting there would park it.
    lead.obey_traffic_lights = false;
    const events = [
      _routeEvent(lead, _corridorWaypoints(c, gap0)),
      _speedEvent('evt-2', nearEgo(trigger), vEnd, 'rate', decel),
      _speedEvent('evt-3', after('evt-2'), vEnd, 'time', hold),
    ];
    // A lead that stays stopped blocks the ego all run (CARLA), so most pull away again.
    const resume = _p('resumes', rng.chance(stopFully ? 0.75 : 0.4));
    if (resume) events.push(_speedEvent('evt-4', after('evt-3'), vLead, 'rate', 2.5));
    lead.events = events;
    // Where the ego catches up, closing at vEgo − vLead from gap0 to the trigger.
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

  /* Slower vehicle ahead (Euro NCAP CCRm, UN R171): a truck or motorcycle at a constant low
   * speed in the ego's lane, maybe off-centre. The closing speed is the test. */
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
    // No junction where the ego closes in: a turn makes it another scenario.
    if (!_junctionFree(c, gap0 - 6, gap0 + 6) || !_junctionFree(c, dCatch - 25, dCatch + 10)) return null;
    const offDraw = rng.chance(0.4) ? rng.range(0.3, 1.0) : 0;
    const off = _p('lateral_m', offDraw);
    const side = _p('side', rng.chance(0.5) ? 'right' : 'left');

    const lead = _vehicle(type, _corridorAt(c, gap0), vLead);
    lead.obey_traffic_lights = false;
    const events = [_routeEvent(lead, _corridorWaypoints(c, gap0))];
    if (off > 0) {
      // Once the ego starts closing in, never off a clock; held for the rest of the run.
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
      // Never released: a threat from the start.
      threats: new Map([[lead.id, 'evt-1']]),
    };
  }

  /* Cut-out (Euro NCAP CCRs): the lead the ego follows swerves into a neighbour lane and
   * uncovers a stopped car. The swerve is positional (distance_to_point on the lead itself),
   * so an AV following closer meets the reveal later. The lead ignores obstacles and lights. */
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
    // Swerve start to the stopped car, as late as possible: 6 m run-in, then the bodies stop
    // overlapping ~60% across, plus both half-lengths and a margin (generous was too easy).
    const len = (t) => MapView.actorSize(t).w;
    const cutMargin = _p('cut_margin_m', rng.range(1.5, 10));
    const cutDist = 6 + 0.6 * lcDist + (len(type) + len(stoppedType)) / 2 + cutMargin;
    const dCut = rng.range(Math.max(sg.startD + 2, gap0 + 25), sg.endD - cutDist - 4);
    if (!(dCut > sg.startD) || dCut + cutDist + 4 > sg.endD) return null;
    const dObs = dCut + cutDist;
    if (!_junctionFree(c, 0, dObs + 15)) return null;
    // Land on N with room for 10 m driven there, or ChangeActorLateralMotion hangs.
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
    // Most stopped cars drive off once the ego is behind them, at a 9 m bumper gap: the
    // scripted ego halts ~6.3 m back (CARLA), so 6 m was never reached.
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
      sceneryIds: new Set([lead.id]),
      revealedBy: new Map([[stopped.id, { actorId: lead.id, eventId: 'evt-1' }]]),
    };
  }

  /* Cyclist ahead at the lane's right edge; half swerve toward the centre as the ego nears. */
  function _cyclistAhead(rng, net, vEgo) {
    const c = _buildCorridor(rng, net, rng.range(200, 300));
    if (!c) return null;
    const vBike = _p('speed', rng.range(3, 6));
    const gap0 = _p('initial_gap_m', rng.range(30, 60));
    const tCatch = gap0 / (vEgo - vBike);
    // A cyclist cannot be routed, so it lane-follows: its ride must be junction-free.
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
      // A second offset supersedes the first: from the edge out to `out` m left of centre.
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
