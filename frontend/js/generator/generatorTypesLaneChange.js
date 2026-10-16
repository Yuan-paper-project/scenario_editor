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

  /* Pull-out from a parallel parking bay (CARLA leaderboard, NHTSA): routes seed → merge
   * on the ego's lane → the ego's corridor, released by a set_speed on the ego's distance.
   * No site on towns without parking lanes. */
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
          if (!q || q.d > 1.3 || q.s < 4 || q.s > P.length - 4) continue;
          if (Math.abs(UIUtils.wrapDeg(q.yaw - pose.yaw)) > 20) continue;
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
    // It is in the lane dt s before the ego reaches the merge, then slower.
    const dt = _p('arrival_offset_s', rng.range(0.3, 2.0));
    const npc = _vehicle(type, { x: q.x, y: q.y, yaw: q.yaw }, 0);
    npc.z = r2(q.z + 0.5);
    const tMerge = _timeFromRest(mergeAhead + 2, vNpc);
    const sol = _solveTrigger(c, dMerge, tMerge + dt, vEgo, npc);
    if (!sol) return null;
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

  /* Cut-in: a slower car in a neighbour lane ahead changes into the ego's once it closes in. */
  function _cutIn(rng, net, vEgo) {
    // Start on a lane with a neighbour, near its beginning; a random start rarely finds one.
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
    // A corridor lane with a same-direction neighbour per the graph's left/right: the only
    // targets ChangeActorLateralMotion can reach.
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

    // Clear speed difference and short gap, so the ego closes in within one stretch.
    const vNpc = Math.min(_p('npc_speed', vEgo * rng.range(0.45, 0.7)), vEgo * 0.9);
    const lcDist = _p('lane_change_m', rng.range(10, 22)); // lateral move spread over this many metres
    const trigger = _p('trigger_m', rng.range(8, 26)); // cut in when the ego is this close
    // Spawned dNpc ahead in this lane visit, far enough that the ego must close in first.
    const lo = Math.max(sg.startD + 3, trigger + 8);
    const hi = Math.min(sg.endD - 5, trigger + 35);
    if (lo > hi) return null;
    const dNpc = rng.range(lo, hi);
    const gap0 = dNpc;
    const tTrigger = (gap0 - trigger) / (vEgo - vNpc);
    // The change must finish on N and land with 10 m of the ego's lane left, or it hangs.
    const npcTravel = vNpc * tTrigger + lcDist;
    if (dNpc + npcTravel + 20 > sg.endD) return null;
    const egoPose = _corridorAt(c, dNpc);
    const onN = _projectOnLane(N, egoPose.x, egoPose.y);
    if (!onN || onN.d > 6 || onN.s + npcTravel + 15 > N.length) return null;
    // Toward the ego's lane, i.e. away from `egoSide` — and the graph must agree.
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

  /** Distance the closer gains on the ego in `t` s, ramping at `a` to `dv` faster. */
  function _closing(t, dv, a = VEHICLE_ACCEL) {
    const tr = dv / a;
    return t <= tr ? (a * t * t) / 2 : (dv * dv) / (2 * a) + dv * (t - tr);
  }

  /* Lane change into a car from behind (UN R171, NHTSA): the ego's own events change lanes at
   * a point; a car in the target lane behind it surges as the ego nears that point. Both start
   * at the same speed, so the spawn ramp keeps their gap; the surge is released by the ego
   * reaching a point, so it follows the ego wherever it is. */
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
    // The ego at cruise, plus room on both lanes: 6 m run-in, the move, 10 m in the target lane.
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
