/**
 * generatorTypesVru.js — scenario types with a pedestrian or cyclist crossing the road.
 *
 * Part of the scenario generator; the design is described in scenarioGenerator.js.
 */
(() => {
  'use strict';

  const {
    WAYPOINT_CLEARANCE,
    CARRIAGEWAY_TYPES,
    r1,
    r2,
    DEG,
    _wrapDeg,
    _inPoly,
    _p,
    _buildCorridor,
    _corridorAt,
    _junctionFree,
    _lateral,
    _vehicle,
    _speedEvent,
    nearEgo,
    after,
    _egoRunUp,
    _solveTrigger,
    _turnKind,
  } = GeneratorCore.shared;

  /** Lateral offsets (right positive) at which a line across the road at
   * `pose` leaves the carriageway on each side — or null where it does not
   * within `maxM`. */
  function _carriagewayEdges(net, pose, maxM = 25) {
    const near = net.polys.filter(
      (p) =>
        CARRIAGEWAY_TYPES.has(p.type) &&
        p.bbox.minX - maxM <= pose.x &&
        p.bbox.maxX + maxM >= pose.x &&
        p.bbox.minY - maxM <= pose.y &&
        p.bbox.maxY + maxM >= pose.y,
    );
    const onRoad = (off) => {
      const q = _lateral(pose, off);
      return near.some(
        (p) =>
          q.x >= p.bbox.minX &&
          q.x <= p.bbox.maxX &&
          q.y >= p.bbox.minY &&
          q.y <= p.bbox.maxY &&
          _inPoly(p.poly, q.x, q.y),
      );
    };
    const edge = (sign) => {
      for (let t = 0.25; t <= maxM; t += 0.25) if (!onRoad(sign * t)) return sign * t;
      return null;
    };
    return { right: edge(1), left: edge(-1) };
  }

  // Sidewalk only. A shoulder or parking lane looks walkable but on Town04's
  // highways the shoulder ends at a guardrail, and CARLA refused a pedestrian
  // spawned against it; nobody crosses a road from there anyway.
  const WALKABLE_TYPES = new Set(['sidewalk']);
  const KERB_ALLOWANCE = 0.4; // extra spawn height for an actor starting off the carriageway
  function _onWalkable(net, q) {
    return net.polys.some(
      (p) =>
        WALKABLE_TYPES.has(p.type) &&
        q.x >= p.bbox.minX &&
        q.x <= p.bbox.maxX &&
        q.y >= p.bbox.minY &&
        q.y <= p.bbox.maxY &&
        _inPoly(p.poly, q.x, q.y),
    );
  }

  const VRU_PROFILES = {
    pedestrian: { speed: [1.2, 2.6], maxCross: 22 }, // strolling to hurrying
    child: { speed: [1.6, 4.0], maxCross: 22 }, // up to a sprint
    cyclist: { speed: [3.0, 5.5], maxCross: 30 },
  };

  /* Crossing VRU. A pedestrian, child or cyclist crosses the ego's lane,
   * released so that it enters the ego's path a chosen time before or after
   * the ego reaches it. Pedestrians may step out from behind a parked
   * vehicle. */
  function _vruCrossing(rng, net, vEgo) {
    const c = _buildCorridor(rng, net, rng.range(160, 260));
    if (!c) return null;
    const type = _p(
      'vru_type',
      rng.weighted([
        ['pedestrian', 5],
        ['child', 2.5],
        ['cyclist', 2.5],
      ]),
    );
    const prof = VRU_PROFILES[type];
    const v = _p('speed', rng.range(...prof.speed));
    const dMin = _egoRunUp(vEgo) + vEgo * 4;

    // Prefer a painted crosswalk on the corridor; otherwise anywhere straight.
    let dConflict = null;
    const crosswalks = (AppState.mapData.crosswalks || [])
      .map((cw) => {
        let best = null;
        for (const p of c.pts) {
          const dd = Math.hypot(p.x - cw.x, p.y - cw.y);
          if (dd < 6 && (!best || dd < best.dd)) best = { dd, d: p.d };
        }
        return best;
      })
      .filter((b) => b && b.d > dMin && b.d < c.length - 20);
    const onCrosswalk = crosswalks.length > 0 && rng.chance(0.6);
    if (onCrosswalk) dConflict = rng.pick(crosswalks).d;
    else dConflict = rng.range(dMin, c.length - 20);
    // The crossing runs perpendicular to the corridor, which only means
    // "across the road" on a straight lane — inside a junction connector the
    // corridor is turning and the line would cut the corner diagonally.
    const clearance = onCrosswalk ? 3 : 12;
    if (!_junctionFree(c, dConflict - clearance, dConflict + clearance)) return null;
    return _vruCrossingAt(rng, net, vEgo, c, dConflict, type, v, { onCrosswalk });
  }

  /** The crossing itself, across the corridor at `dConflict`: kerb to kerb
   * perpendicular to the corridor there, released on the ego's distance so the
   * VRU enters the ego's path `arrival_offset_s` before it does. Shared by the
   * straight-road crossing and the one on the road the ego turns into; the
   * draws are in the order _vruCrossing always made them, so its seeds are
   * unchanged. `opts.occluder` false skips the parked-van option (no draw). */
  function _vruCrossingAt(rng, net, vEgo, c, dConflict, type, v, opts = {}) {
    const prof = VRU_PROFILES[type];
    const onCrosswalk = !!opts.onCrosswalk;
    // A caller may give the crossing line itself (a crosswalk at a turn,
    // which need not be square to the ego's path there): `pose` is where it
    // meets the ego's lane, and its yaw the road direction along it.
    const pose = opts.pose || _corridorAt(c, dConflict);
    const edges = _carriagewayEdges(net, pose);
    if (edges.right === null || edges.left === null) return null;
    const fromRight = _p('from', rng.chance(0.65) ? 'right' : 'left') === 'right';
    // Start and finish on something walkable just past the carriageway edge.
    // "Past the edge" alone is not enough: on Town10HD it was a building
    // wall, CARLA refused to spawn the cyclist there, and the whole run
    // failed with "Unable to add actors".
    const kerbOff = (edgeOff) => {
      const sign = Math.sign(edgeOff);
      for (const k of [1.2, 0.8, 1.6, 0.5, 2.0]) {
        if (!_onWalkable(net, _lateral(pose, edgeOff + sign * k))) continue;
        // A cyclist starts at the road edge, not on the sidewalk: it is a 1.8 m
        // <Vehicle> set across the road, and from 1.2 m onto a narrow sidewalk
        // its back end reached the wall behind it — CARLA refused 3 of 160
        // crossing cyclists that way (tests/probe_generated_spawns.py). The
        // sidewalk is still required: without it the site was a guardrailed
        // Town07 bridge, where the guardrail refused the spawn instead.
        return type === 'cyclist' ? edgeOff - sign * 0.8 : edgeOff + sign * k;
      }
      return null;
    };
    const startOff = kerbOff(fromRight ? edges.right : edges.left);
    const endOff = kerbOff(fromRight ? edges.left : edges.right);
    if (startOff === null || endOff === null) return null;
    const crossLen = Math.abs(endOff - startOff);
    if (crossLen > prof.maxCross) return null;
    const start = _lateral(pose, startOff);
    const end = _lateral(pose, endOff);
    const kerbEdge = _lateral(pose, fromRight ? edges.right : edges.left);

    // dt > 0: the VRU is already in the lane when the ego arrives (must brake);
    // dt < 0: the ego arrives first and the VRU steps out just behind/in front.
    const tVru = Math.abs(startOff) / v;
    // A walker clears a 2 m-wide car's path in ~1.3 s, so an offset much past
    // +0.8 s is mostly a near miss rather than a conflict.
    const dt = _p('arrival_offset_s', rng.range(-0.5, 0.8));
    const sol = _solveTrigger(c, dConflict, tVru + dt, vEgo, start);
    if (!sol) return null;

    const sx = r1(start.x),
      sy = r1(start.y),
      ex = r1(end.x),
      ey = r1(end.y);
    const heading = Math.atan2(ey - sy, ex - sx) * DEG;
    const vru = {
      id: AppState.nextId(),
      type,
      x: sx,
      y: sy,
      // The start is on the sidewalk, which the elevation profile does not
      // model: Town02's is 0.32 m above the road there, the walker's capsule
      // reached into it at the editor's usual 0.6 m and CARLA refused the
      // spawn (tests/probe_generated_spawns.py). High is free — it settles.
      // Height from the corridor at the crossing, not from the nearest lane:
      // next to an overpass the nearest lane is the wrong level (a cyclist on
      // Town03 came out at z 5.8 and could not spawn).
      z: r2(pose.z + 0.6 + KERB_ALLOWANCE),
      yaw: Math.round(heading),
      initial_speed: 0,
      events: [],
    };
    // follow_trajectory, not set_speed: a cyclist is a <Vehicle>, and
    // SimpleVehicleControl ignores heading and lane-follows, so a set_speed
    // cyclist rides along the road instead of across it (CLAUDE.md).
    const vertex = (x, y) => ({ x, y, z: r2(pose.z + WAYPOINT_CLEARANCE), velocity: r1(v) });
    vru.events = [
      {
        id: 'evt-1',
        trigger: nearEgo(sol.radius),
        action: { type: 'follow_trajectory', trajectory: [vertex(sx, sy), vertex(ex, ey)] },
      },
    ];
    // A walker that stops dead in the ego's lane, then carries on. A set_speed
    // changes only the target speed; the trajectory's waypoints keep running
    // underneath it, so speed 0 then speed v resumes the same path (measured
    // in CARLA: stopped 3 s at mid-road, then walked on to the far kerb). The
    // stop is triggered by the walker reaching the ego lane's centre itself —
    // distance_to_point on its own entity. 1.5 m because the condition is 3-D
    // and the walker's centre sits ~0.9 m above the point.
    const isWalker = MapView.isWalkerType(type);
    const hesitDraw = isWalker && rng.chance(0.3);
    const holdDraw = hesitDraw ? rng.range(1.5, 4) : 0;
    let hold = isWalker ? _p('stops_in_lane_s', holdDraw) : 0;
    const hesitates = hold > 0;
    if (!hesitates) hold = null;
    if (hesitates) {
      vru.events.push(
        {
          id: 'evt-2',
          trigger: {
            type: 'distance_to_point',
            value: 1.5,
            entity_ref: vru.id,
            point: { name: 'Point 1', x: r1(pose.x), y: r1(pose.y), z: r2(pose.z + WAYPOINT_CLEARANCE) },
          },
          action: {
            type: 'set_speed',
            dynamics: { shape: 'step', dimension: 'time', value: r1(hold) },
            target: { mode: 'absolute', value: 0 },
          },
        },
        _speedEvent('evt-3', after('evt-2'), v, 'time', 20),
      );
    }
    vru.events.push(_speedEvent(hesitates ? 'evt-4' : 'evt-2', after('evt-1'), 0, 'time', 5));

    // Occluder: a parked van or truck just upstream on the VRU's side, so the
    // VRU is hidden until it steps out. Only where there is a parking lane to
    // stand it in: a shoulder is often under a metre wide, and a van centred
    // on one sticks into the ego's lane.
    const npcs = [vru];
    const sceneryIds = new Set();
    let occluded = false;
    const canOcclude = type !== 'cyclist' && opts.occluder !== false;
    const occDraw = canOcclude && rng.chance(0.5);
    if (canOcclude && _p('occluded', occDraw)) {
      const upstream = _corridorAt(c, dConflict - rng.range(5, 9));
      const edgeOff = fromRight ? edges.right : edges.left;
      const probe = _lateral(upstream, edgeOff - Math.sign(edgeOff) * 1.5);
      const lane = ObjectsManager.nearestLaneProjection(probe.x, probe.y, new Set(['parking']), 2.5);
      if (lane) {
        const occType = rng.weighted([
          ['van', 3],
          ['truck', 1],
          ['car', 1],
        ]);
        const occ = _vehicle(occType, { x: lane.x, y: lane.y, yaw: upstream.yaw }, 0);
        npcs.push(occ);
        sceneryIds.add(occ.id);
        occluded = true;
      }
    }
    return {
      corridor: c,
      npcs,
      props: [],
      conflictD: dConflict,
      params: {
        vru_type: type,
        speed: r1(v),
        from: fromRight ? 'right' : 'left',
        crossing_m: r1(crossLen),
        on_crosswalk: onCrosswalk,
        arrival_offset_s: r2(dt),
        trigger_m: r1(sol.radius),
        occluded,
        stops_in_lane_s: hold && r1(hold),
      },
      routedNpcs: [],
      sceneryIds,
      onsets: new Map([[vru.id, kerbEdge]]),
    };
  }

  /* VRU crossing where the ego turns. The ego turns left or right at a
   * junction, and a pedestrian or cyclist crosses the road it turns into just
   * past the junction exit — on the crosswalk there when the map paints one —
   * released so it is in the ego's path as the ego comes out of the turn.
   * Euro NCAP CPTA / CBTA, NHTSA pre-crash "turning, encounters a pedestrian /
   * pedalcyclist", the CARLA leaderboard's "turn yielding to bicycles". */
  function _turnVru(rng, net, vEgo) {
    const c = _buildCorridor(rng, net, rng.range(200, 300));
    if (!c) return null;
    const type = _p(
      'vru_type',
      rng.weighted([
        ['pedestrian', 5],
        ['child', 2],
        ['cyclist', 3],
      ]),
    );
    const v = _p('speed', rng.range(...VRU_PROFILES[type].speed));
    const turnWant = _p('turn', null);
    const dMin = _egoRunUp(vEgo) + vEgo * 3;
    const turns = c.segs.filter(
      (sg) =>
        sg.L.junction &&
        sg.startD > dMin &&
        sg.endD < c.length - 30 &&
        _turnKind(sg.L) !== 'straight' &&
        (!turnWant || _turnKind(sg.L) === turnWant),
    );
    if (!turns.length) return null;
    const sg = rng.pick(turns);
    // The crosswalk across the exit road, when the map paints one: that is
    // where people cross at a corner, and where the kerb has no railing. A
    // crossing moved a few metres off it (onto the exit road proper) put a
    // walker against a Town05 corner barrier the .xodr does not have, and in
    // CARLA it never moved.
    const crosswalks = (AppState.mapData.crosswalks || [])
      .map((cw) => {
        let best = null;
        for (const p of c.pts) {
          if (p.d < sg.endD - 6 || p.d > sg.endD + 15) continue;
          const dd = Math.hypot(p.x - cw.x, p.y - cw.y);
          if (dd < 6 && (!best || dd < best.dd)) best = { dd, d: p.d, cw };
        }
        return best;
      })
      .filter(Boolean);
    const onCrosswalk = crosswalks.length > 0;
    let dConflict,
      pose = null;
    if (onCrosswalk) {
      const { d, cw } = rng.pick(crosswalks);
      dConflict = d;
      // The crossing runs along the crosswalk. Its `heading` is either the
      // walking or the stripe direction; the road direction is whichever of
      // the two axes is closer to the exit road's, signed like it.
      const roadYaw = _corridorAt(c, Math.max(d, sg.endD + 3)).yaw;
      const yaw = [cw.heading, cw.heading + 90, cw.heading + 180, cw.heading + 270].reduce((b, y) =>
        Math.abs(_wrapDeg(y - roadYaw)) < Math.abs(_wrapDeg(b - roadYaw)) ? y : b,
      );
      if (Math.abs(_wrapDeg(yaw - roadYaw)) > 30) return null;
      // Where the crosswalk's axis meets the ego's lane: nearest point on it
      // to the corridor at d.
      const at = _corridorAt(c, d);
      const ux = -Math.sin(yaw / DEG),
        uy = Math.cos(yaw / DEG); // across the road
      const t = (at.x - cw.x) * ux + (at.y - cw.y) * uy;
      pose = { x: cw.x + t * ux, y: cw.y + t * uy, z: at.z, yaw: _wrapDeg(yaw) };
    } else {
      // Kerb to kerb is perpendicular to the corridor, so the exit road has to
      // be out of the junction and straight across the crossing.
      dConflict = sg.endD + rng.range(3, 9);
      if (!_junctionFree(c, dConflict - 2, dConflict + 8)) return null;
      const a = _corridorAt(c, dConflict - 2),
        b = _corridorAt(c, dConflict + 6);
      if (Math.abs(_wrapDeg(b.yaw - a.yaw)) > 15) return null;
    }

    const res = _vruCrossingAt(rng, net, vEgo, c, dConflict, type, v, { onCrosswalk, occluder: false, pose });
    if (!res) return null;
    const { occluded, ...params } = res.params;
    res.params = { turn: _turnKind(sg.L), junction: sg.L.junctionId, ...params };
    return res;
  }

  GeneratorCore.define({ _vruCrossing, _turnVru });
})();
