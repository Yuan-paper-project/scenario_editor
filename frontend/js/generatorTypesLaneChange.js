/**
 * generatorTypesLaneChange.js — scenario types where a vehicle changes into or onto the ego's lane.
 *
 * Part of the scenario generator; the design is described in scenarioGenerator.js.
 */
(() => {
  'use strict';

  const {
    VEHICLE_ACCEL,
    WAYPOINT_CLEARANCE,
    r1,
    r2,
    _wrapDeg,
    _bbox,
    _projectOnLane,
    _p,
    _buildCorridor,
    _corridorAt,
    _junctionFree,
    _lateral,
    _routeWp,
    _corridorWaypoints,
    _vehicle,
    _ignoresTraffic,
    _routeEvent,
    _speedEvent,
    nearEgo,
    after,
    _timeFromRest,
    _egoRunUp,
    _solveTrigger,
    VEHICLE_MIX,
  } = GeneratorCore.shared;

  /** Parking lanes as {pts, cum, length} lines, built once per network. */
  function _parkingLanes(net) {
    if (!net.parking) {
      net.parking = [];
      for (const road of AppState.mapData.roads || []) {
        if (String(road.junction) !== '-1') continue; // the connectors' 'parking' strips
        for (const lane of road.lanes || []) {
          if (lane.type !== 'parking' || (lane.directionLine || []).length < 2) continue;
          const pts = lane.directionLine.map(([x, y, z = 0]) => ({ x, y, z }));
          const cum = [0];
          for (let i = 1; i < pts.length; i++)
            cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
          net.parking.push({ pts, cum, length: cum[cum.length - 1], bbox: _bbox(lane.directionLine) });
        }
      }
    }
    return net.parking;
  }

  /* Pull-out from a parallel parking bay (CARLA leaderboard "parked vehicle
   * exiting a parallel parking bay cuts in front", NHTSA "leaving a parked
   * position"). A car stands in a parking lane beside the ego's lane, ahead
   * of it; when the ego approaches it pulls out into the ego's lane and drives
   * on along the ego's road at a lower speed. Its route is seed -> a merge
   * point on the ego's lane -> the ego's corridor, released by a set_speed on
   * the ego's distance (a route alone does not move an actor). Needs a
   * parking lane, so Town01/02/04 have no site. */
  function _pullOut(rng, net, vEgo) {
    const parking = _parkingLanes(net);
    if (!parking.length) return null;
    const c = _buildCorridor(rng, net, rng.range(220, 320));
    if (!c) return null;
    const dMin = _egoRunUp(vEgo) + vEgo * 3 + 20;
    const sites = [];
    for (let d = dMin; d < c.length - 90; d += 5) {
      if (!_junctionFree(c, d - 8, d + 40)) continue;
      const pose = _corridorAt(c, d);
      for (const side of ['right', 'left']) {
        const probe = _lateral(pose, (side === 'right' ? 1 : -1) * 3.3);
        for (const P of parking) {
          if (
            probe.x < P.bbox.minX - 2 ||
            probe.x > P.bbox.maxX + 2 ||
            probe.y < P.bbox.minY - 2 ||
            probe.y > P.bbox.maxY + 2
          )
            continue;
          const q = _projectOnLane(P, probe.x, probe.y);
          // Beside the ego's lane, facing its way, not at a bay's very end.
          if (!q || q.d > 1.3 || q.s < 4 || q.s > P.length - 4) continue;
          if (Math.abs(_wrapDeg(q.yaw - pose.yaw)) > 20) continue;
          sites.push({ d, q, side });
        }
      }
    }
    if (!sites.length) return null;
    const { d, q, side } = rng.pick(sites);
    const type = _p(
      'npc_type',
      rng.weighted([
        ['car', 6],
        ['van', 2],
        ['truck', 0.5],
      ]),
    );
    const vNpc = _p('npc_speed', vEgo * rng.range(0.45, 0.75));
    const mergeAhead = rng.range(9, 14);
    const dMerge = d + mergeAhead;
    // dt > 0: the car is in the lane that long before the ego reaches the
    // merge point; it then drives on slower, so the ego closes in on it.
    const dt = _p('arrival_offset_s', rng.range(0.3, 2.0));
    const npc = _vehicle(type, { x: q.x, y: q.y, yaw: q.yaw }, 0);
    // The z of the parking lane itself, not of whatever lane is nearest.
    npc.z = r2(q.z + 0.5);
    const tMerge = _timeFromRest(mergeAhead + 2, vNpc);
    const sol = _solveTrigger(c, dMerge, tMerge + dt, vEgo, npc);
    if (!sol) return null;
    // It reaches each light before the ego switches it green (_greenWave).
    npc.obey_traffic_lights = false;
    npc.events = [
      _routeEvent(npc, [_routeWp(_corridorAt(c, dMerge)), ..._corridorWaypoints(c, dMerge + 2)]),
      _speedEvent('evt-2', nearEgo(sol.radius), vNpc, 'rate', VEHICLE_ACCEL),
    ];
    return {
      corridor: c,
      npcs: [npc],
      props: [],
      conflictD: dMerge + 40,
      egoEndD: c.length - 60,
      params: {
        npc_type: type,
        side,
        npc_speed: r1(vNpc),
        merge_m: r1(mergeAhead),
        arrival_offset_s: r2(dt),
        trigger_m: r1(sol.radius),
      },
      routedNpcs: [{ actor: npc, corridorFrom: dMerge + 6 }],
    };
  }

  /* Cut-in. A slower car in a same-direction neighbour lane, ahead of the ego,
   * changes into the ego's lane once the ego has closed in on it. */
  function _cutIn(rng, net, vEgo) {
    // Start on a lane that has a neighbour to cut in from, near enough its
    // beginning that the NPC fits ahead of the ego on the same stretch. A
    // uniformly random start finds one only on multi-lane towns, and rarely.
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
      rng.range(0, Math.max(0.5, start.length - 90)),
    );
    if (!c) return null;
    // A lane on the corridor that has a same-direction driving neighbour —
    // the lane graph's left/right are exactly that (get_left_lane() /
    // get_right_lane() ground truth), which is the only legal lane-change
    // target ChangeActorLateralMotion can reach.
    const candidates = [];
    for (const sg of c.segs) {
      if (sg.L.junction || !sg.L.record) continue;
      for (const side of ['left', 'right']) {
        const ref = sg.L.record[side];
        const N = ref && net.lanes.get(net.refKey(ref));
        if (N && !N.junction) candidates.push({ sg, N, egoSide: side });
      }
    }
    if (!candidates.length) return null;
    const { sg, N, egoSide } = rng.pick(candidates);

    // A clear speed difference and a short initial gap, so the ego closes in
    // within one multi-lane stretch (Town10HD's are ~90-130 m long).
    const vNpc = Math.min(_p('npc_speed', vEgo * rng.range(0.45, 0.7)), vEgo * 0.9);
    const lcDist = _p('lane_change_m', rng.range(10, 22)); // lateral move spread over this many metres
    const trigger = _p('trigger_m', rng.range(8, 26)); // cut in when the ego is this close
    // The NPC spawns beside corridor distance dNpc, i.e. dNpc ahead of the ego,
    // somewhere in this lane visit and far enough ahead that the ego has to
    // close in before the trigger fires.
    const lo = Math.max(sg.startD + 3, trigger + 8);
    const hi = Math.min(sg.endD - 5, trigger + 35);
    if (lo > hi) return null;
    const dNpc = rng.range(lo, hi);
    const gap0 = dNpc;
    const tTrigger = (gap0 - trigger) / (vEgo - vNpc);
    // Corridor distance at which the lateral move is done. It has to happen on
    // N before N ends, and land in the ego's lane before THAT ends:
    // ChangeActorLateralMotion only succeeds after 10 m driven in the target
    // lane, and never fails otherwise, so a change that runs out of lane hangs
    // the run (CLAUDE.md, CARLA behavioural tests).
    const npcTravel = vNpc * tTrigger + lcDist;
    if (dNpc + npcTravel + 20 > sg.endD) return null;
    const egoPose = _corridorAt(c, dNpc);
    const onN = _projectOnLane(N, egoPose.x, egoPose.y);
    if (!onN || onN.d > 6 || onN.s + npcTravel + 15 > N.length) return null;
    // The NPC changes TOWARD the ego lane: N is on the ego's `egoSide`, so the
    // ego lane is on N's opposite side — and the graph must agree.
    const npcDir = egoSide === 'left' ? 'right' : 'left';
    const back = N.record && N.record[npcDir];
    if (!back || net.refKey(back) !== sg.key) return null;

    const type = _p('npc_type', rng.weighted(VEHICLE_MIX.filter(([t]) => t !== 'bus')));
    const npc = _vehicle(type, onN, vNpc);
    const events = [
      {
        id: 'evt-1',
        trigger: nearEgo(trigger),
        action: { type: 'lane_change', direction: npcDir, dynamics: { shape: 'linear', value: r1(lcDist) } },
      },
    ];
    const brakesAfter = _p('brakes_after', rng.chance(0.4));
    if (brakesAfter)
      events.push(_speedEvent('evt-2', after('evt-1'), vNpc * rng.range(0.3, 0.7), 'rate', rng.range(2, 5)));
    npc.events = events;
    return {
      corridor: c,
      npcs: [npc],
      props: [],
      conflictD: dNpc + npcTravel + 20,
      params: {
        npc_type: type,
        from_side: egoSide,
        npc_speed: r1(vNpc),
        initial_gap_m: r1(gap0),
        trigger_m: r1(trigger),
        lane_change_m: r1(lcDist),
        brakes_after: brakesAfter,
      },
      routedNpcs: [],
    };
  }

  /** Corridor-distance the closer gains on the ego in `t` seconds when it
   * ramps at `a` from the ego's speed to `dv` faster. */
  function _closing(t, dv, a = VEHICLE_ACCEL) {
    const tr = dv / a;
    return t <= tr ? (a * t * t) / 2 : (dv * dv) / (2 * a) + dv * (t - tr);
  }

  /* Lane change into a car approaching from behind (UN R171: "must detect and
   * yield to a high-speed vehicle approaching from the rear in the target
   * lane", the blind-spot and filtering-motorcycle cases; NHTSA "misjudged the
   * distance and speed of vehicle B"). The ego's own events say it changes
   * lanes at a point; a car in the target lane behind it, at the ego's speed,
   * surges as the ego nears that point and is beside or just behind it when
   * the ego moves over. An ego that changes regardless is hit; the system
   * under test has to wait until it has passed.
   *
   * Both cars start at the same speed, so they keep their gap through the
   * spawn ramp (the same acceleration limit), and the surge is released by the
   * ego reaching a point (distance_to_point naming the ego), so the timing
   * follows the ego wherever it is. The ego starts `g0` up the corridor and
   * the car beside the corridor's start, on the same lane pair. */
  function _rearApproach(rng, net, vEgo) {
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
      rng.range(0, Math.max(0.5, start.length - 140)),
    );
    if (!c) return null;
    const sg = c.segs[0];
    const sides = ['left', 'right'].filter((side) => {
      const ref = sg.L.record && sg.L.record[side];
      const N = ref && net.lanes.get(net.refKey(ref));
      const back = N && N.record && N.record[side === 'left' ? 'right' : 'left'];
      return N && !N.junction && back && net.refKey(back) === sg.key;
    });
    if (!sides.length) return null;
    const side = _p('side', rng.pick(sides));
    if (!sides.includes(side)) return null;
    const N = net.lanes.get(net.refKey(sg.L.record[side]));

    const type = _p(
      'npc_type',
      rng.weighted([
        ['car', 5],
        ['van', 1],
        ['motorcycle', 2],
        ['truck', 0.5],
      ]),
    );
    const dv = _p('speed_diff', rng.range(3, 8)); // m/s faster than the ego
    const tRel = rng.range(1.5, 3.0); // surge this long before the change
    const gap = _p('gap_at_change_m', rng.range(2, 12)); // centre behind the ego's then
    const lcDist = _p('lane_change_m', rng.range(12, 20));
    const g0 = gap + _closing(tRel, dv);
    // The surge needs the ego at cruise speed, and the change room on both
    // lanes: 6 m same-lane run-in, the move, 10 m driven in the target lane
    // (ChangeActorLateralMotion hangs without it), and a margin.
    const dRel = g0 + (vEgo * vEgo) / (2 * VEHICLE_ACCEL) + rng.range(5, 20);
    const dLc = dRel + vEgo * tRel;
    if (dLc + 6 + lcDist + 25 > sg.endD) return null;
    const onN0 = _projectOnLane(N, c.pts[0].x, c.pts[0].y);
    const lcPose = _corridorAt(c, dLc);
    const onNLc = _projectOnLane(N, lcPose.x, lcPose.y);
    if (!onN0 || onN0.d > 6 || !onNLc || onNLc.s + 6 + lcDist + 25 > N.length) return null;

    const npc = _vehicle(type, onN0, vEgo);
    _ignoresTraffic(npc);
    const relPose = _corridorAt(c, dRel);
    npc.events = [
      {
        id: 'evt-1',
        trigger: {
          type: 'distance_to_point',
          value: 2.0,
          entity_ref: '$ego',
          point: { name: 'Point 1', x: r1(relPose.x), y: r1(relPose.y), z: r2(relPose.z + WAYPOINT_CLEARANCE) },
        },
        action: {
          type: 'set_speed',
          dynamics: { shape: 'linear', dimension: 'rate', value: VEHICLE_ACCEL },
          target: { mode: 'absolute', value: r1(vEgo + dv) },
        },
      },
    ];
    const egoEvents = [
      {
        id: 'evt-2',
        trigger: {
          type: 'distance_to_point',
          value: 2.0,
          entity_ref: '$ego',
          point: { name: 'Point 1', x: r1(lcPose.x), y: r1(lcPose.y), z: r2(lcPose.z + WAYPOINT_CLEARANCE) },
        },
        action: { type: 'lane_change', direction: side, dynamics: { shape: 'linear', value: r1(lcDist) } },
      },
    ];
    return {
      corridor: c,
      npcs: [npc],
      props: [],
      egoStartD: g0,
      egoEndD: Math.min(c.length, dLc + 40),
      egoEvents,
      conflictD: dLc + lcDist + 10,
      params: {
        npc_type: type,
        side,
        speed_diff: r1(dv),
        gap_at_change_m: r1(gap),
        lane_change_m: r1(lcDist),
        surge_before_s: r2(tRel),
      },
      routedNpcs: [],
      threats: new Map([[npc.id, 'evt-1']]),
    };
  }

  GeneratorCore.define({ _pullOut, _cutIn, _rearApproach });
})();
