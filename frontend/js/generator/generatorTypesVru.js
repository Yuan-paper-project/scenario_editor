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

  /** Lateral offsets (right positive) where a line across the road at `pose` leaves the carriageway; null beyond `maxM`. */
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
          UIUtils.pointInPoly(q.x, q.y, p.poly),
      );
    };
    const edge = (sign) => {
      for (let t = 0.25; t <= maxM; t += 0.25) if (!onRoad(sign * t)) return sign * t;
      return null;
    };
    return { right: edge(1), left: edge(-1) };
  }

  // Sidewalk only: a shoulder can end at a guardrail (Town04), where CARLA refuses the spawn.
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
        UIUtils.pointInPoly(q.x, q.y, p.poly),
    );
  }

  const VRU_PROFILES = {
    pedestrian: { speed: [1.2, 2.6], maxCross: 22 }, // strolling to hurrying
    child: { speed: [1.6, 4.0], maxCross: 22 }, // up to a sprint
    cyclist: { speed: [3.0, 5.5], maxCross: 30 },
  };

  /* Crossing VRU: a pedestrian, child or cyclist crosses the ego's lane, entering its path a
   * chosen time before or after the ego; pedestrians may step out from behind a parked van. */
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
    // Perpendicular to the corridor is only "across" on a straight lane, not in a connector.
    const clearance = onCrosswalk ? 3 : 12;
    if (!_junctionFree(c, dConflict - clearance, dConflict + clearance)) return null;
    return _vruCrossingAt(rng, net, vEgo, c, dConflict, type, v, { onCrosswalk });
  }

  /** The crossing at `dConflict`, kerb to kerb, released on the ego's distance. Shared with the
   *  turn crossing; the draw order is _vruCrossing's, so its seeds are unchanged. `opts.occluder`
   *  false skips the parked van (no draw). */
  function _vruCrossingAt(rng, net, vEgo, c, dConflict, type, v, opts = {}) {
    const prof = VRU_PROFILES[type];
    const onCrosswalk = !!opts.onCrosswalk;
    // A caller may give the crossing line (a crosswalk at a turn): `pose` where it meets the
    // ego's lane, its yaw the road direction.
    const pose = opts.pose || _corridorAt(c, dConflict);
    const edges = _carriagewayEdges(net, pose);
    if (edges.right === null || edges.left === null) return null;
    const fromRight = _p('from', rng.chance(0.65) ? 'right' : 'left') === 'right';
    // Start and finish on a sidewalk past the edge: "just past" was a building wall on Town10HD.
    const kerbOff = (edgeOff) => {
      const sign = Math.sign(edgeOff);
      for (const k of [1.2, 0.8, 1.6, 0.5, 2.0]) {
        if (!_onWalkable(net, _lateral(pose, edgeOff + sign * k))) continue;
        // A cyclist starts 0.8 m inside the edge: from the sidewalk its back end reached the wall
        // behind it. The sidewalk is still required (else a guardrailed bridge was picked).
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

    // dt > 0: the VRU is in the lane when the ego arrives; dt < 0: the ego is first.
    const tVru = Math.abs(startOff) / v;
    // A walker clears a car's path in ~1.3 s, so beyond +0.8 s it is mostly a near miss.
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
      // From the corridor at the crossing (not the nearest lane, which may be an overpass),
      // raised for the unmodelled kerb (Town02's is 0.32 m) — high is free, it settles.
      z: r2(pose.z + 0.6 + KERB_ALLOWANCE),
      yaw: Math.round(heading),
      initial_speed: 0,
      events: [],
    };
    // A trajectory, since a set_speed cyclist would ride along the lane.
    const vertex = (x, y) => ({ x, y, z: r2(pose.z + WAYPOINT_CLEARANCE), velocity: r1(v) });
    vru.events = [
      {
        id: 'evt-1',
        trigger: nearEgo(sol.radius),
        action: { type: 'follow_trajectory', trajectory: [vertex(sx, sy), vertex(ex, ey)] },
      },
    ];
    // A walker that stops in the ego's lane, then walks on: set_speed only changes the target, so
    // the trajectory resumes (CARLA). Triggered on its own entity at the lane centre; 1.5 m
    // because the condition is 3-D and the walker's centre is ~0.9 m up.
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

    // Occluder: a van just upstream on the VRU's side, only in a real parking lane (a shoulder
    // is too narrow; the van would stick into the ego's lane).
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

  /* A pedestrian or cyclist crossing the road the ego turns into, just past the exit (on its
   * crosswalk when painted). Euro NCAP CPTA / CBTA, NHTSA, the CARLA leaderboard. */
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
    // The exit road's crosswalk when painted: a few metres off it a Town05 walker stood
    // against corner scenery the .xodr lacks and never moved in CARLA.
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
      // Along the crosswalk: of its two axes, the one closer to the exit road's direction.
      const roadYaw = _corridorAt(c, Math.max(d, sg.endD + 3)).yaw;
      const yaw = [cw.heading, cw.heading + 90, cw.heading + 180, cw.heading + 270].reduce((b, y) =>
        Math.abs(UIUtils.wrapDeg(y - roadYaw)) < Math.abs(UIUtils.wrapDeg(b - roadYaw)) ? y : b,
      );
      if (Math.abs(UIUtils.wrapDeg(yaw - roadYaw)) > 30) return null;
      const at = _corridorAt(c, d);
      const ux = -Math.sin(yaw / DEG),
        uy = Math.cos(yaw / DEG); // across the road
      const t = (at.x - cw.x) * ux + (at.y - cw.y) * uy;
      pose = { x: cw.x + t * ux, y: cw.y + t * uy, z: at.z, yaw: UIUtils.wrapDeg(yaw) };
    } else {
      // Without a crosswalk the exit must be clear of the junction and straight.
      dConflict = sg.endD + rng.range(3, 9);
      if (!_junctionFree(c, dConflict - 2, dConflict + 8)) return null;
      const a = _corridorAt(c, dConflict - 2),
        b = _corridorAt(c, dConflict + 6);
      if (Math.abs(UIUtils.wrapDeg(b.yaw - a.yaw)) > 15) return null;
    }

    const res = _vruCrossingAt(rng, net, vEgo, c, dConflict, type, v, { onCrosswalk, occluder: false, pose });
    if (!res) return null;
    const { occluded, ...params } = res.params;
    res.params = { turn: _turnKind(sg.L), junction: sg.L.junctionId, ...params };
    return res;
  }

  GeneratorCore.define({ _vruCrossing, _turnVru });
})();
