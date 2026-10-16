/**
 * generatorTypesObstacle.js — the obstacle and oncoming-drift types.
 *
 * Part of the scenario generator; the design is described in scenarioGenerator.js.
 */
(() => {
  'use strict';

  const {
    VEHICLE_ACCEL,
    r1,
    r2,
    _wrapDeg,
    _laneAt,
    _projectOnLane,
    _p,
    _buildCorridor,
    _corridorAt,
    _junctionFree,
    _lateral,
    _routeWp,
    _vehicle,
    _ignoresTraffic,
    _routeEvent,
    _speedEvent,
    nearEgo,
    _timeFromRest,
    _egoRunUp,
    _solveTrigger,
    _walkBack,
    _oncomingLane,
    _walkForward,
  } = GeneratorCore.shared;

  const CARGO_PROPS = [
    'static.prop.box01',
    'static.prop.box02',
    'static.prop.box03',
    'static.prop.travelcase',
    'static.prop.briefcase',
    'static.prop.guitarcase',
    'static.prop.creasedbox01',
    'static.prop.creasedbox02',
    'static.prop.haybalelb',
  ];
  const CONE_PROPS = ['static.prop.trafficcone01', 'static.prop.constructioncone'];

  function _prop(blueprint, x, y, yaw) {
    if (!PropCatalog.get(blueprint)) return null;
    const px = r1(x),
      py = r1(y);
    return {
      id: AppState.nextId(),
      type: 'prop',
      prop: blueprint,
      x: px,
      y: py,
      z: ObjectsManager.surfaceZFor('prop', px, py, blueprint),
      yaw: Math.round(_wrapDeg(yaw)),
    };
  }

  /** 'curve' where the corridor turns > 12° over the 30 m around `d`, else 'straight'. */
  function _siteKind(c, d) {
    const a = _corridorAt(c, d - 15),
      b = _corridorAt(c, d + 15);
    return Math.abs(_wrapDeg(b.yaw - a.yaw)) > 12 ? 'curve' : 'straight';
  }

  /* Static obstacle in the lane: lost cargo, a work-zone taper, a broken-down vehicle, a standing
   * VRU or a queue. Needs no trigger. */
  function _obstacle(rng, net, vEgo) {
    const c = _buildCorridor(rng, net, rng.range(180, 280));
    if (!c) return null;
    let dObs = rng.range(_egoRunUp(vEgo) + 25, c.length - 30);
    // A pinned site (UN R171/R157: in a curve) moves it to such a stretch; unpinned no extra draw.
    const siteWant = _p('site', null);
    if (siteWant) {
      const fits = [];
      for (let d = _egoRunUp(vEgo) + 25; d < c.length - 30; d += 4) {
        if (_siteKind(c, d) === siteWant && _junctionFree(c, d - 30, d + 15)) fits.push(d);
      }
      if (!fits.length) return null;
      dObs = rng.pick(fits);
    }
    if (!_junctionFree(c, dObs - 30, dObs + 15)) return null;
    const pose = _corridorAt(c, dObs);
    // The last three weights sum to the old 'breakdown' weight, so older seeds are unchanged.
    const variant = _p(
      'variant',
      rng.weighted([
        ['cargo', 1],
        ['workzone', 1],
        ['breakdown', 0.6],
        ['stationary_vru', 0.2],
        ['queue', 0.2],
      ]),
    );
    const side = _p('side', rng.chance(0.7) ? 'right' : 'left') === 'right' ? 1 : -1;
    const props = [];
    const npcs = [];
    const params = { variant };

    if (variant === 'cargo') {
      const n = rng.int(2, 5);
      for (let i = 0; i < n; i++) {
        const at = _lateral(_corridorAt(c, dObs + rng.range(-4, 4)), rng.range(-1.3, 1.3));
        const p = _prop(rng.pick(CARGO_PROPS), at.x, at.y, rng.range(-180, 180));
        if (p) props.push(p);
      }
      params.items = props.length;
    } else if (variant === 'workzone') {
      // Cones run diagonally from the edge to `intrusion` m into the lane, then hold; sign at the head.
      const taper = rng.range(12, 24);
      const intrusion = rng.range(0.8, 2.2);
      const cone = rng.pick(CONE_PROPS);
      const nCones = rng.int(5, 8);
      for (let i = 0; i < nCones; i++) {
        const f = i / (nCones - 1);
        const d = dObs - taper + f * (taper + 6);
        const off = side * (1.75 - Math.min(1, d < dObs ? (d - (dObs - taper)) / taper : 1) * intrusion);
        const at = _lateral(_corridorAt(c, d), off);
        const p = _prop(cone, at.x, at.y, 0);
        if (p) props.push(p);
      }
      const signAt = _lateral(_corridorAt(c, dObs - taper - 4), side * 1.6);
      const sign = _prop('static.prop.warningconstruction', signAt.x, signAt.y, pose.yaw + 180);
      if (sign) props.push(sign);
      Object.assign(params, { taper_m: r1(taper), intrusion_m: r1(intrusion), cones: nCones });
    } else if (variant === 'breakdown') {
      const off = side * _p('lateral_m', rng.range(0, 1.0));
      const at = _lateral(pose, off);
      const type = _p(
        'vehicle_type',
        rng.weighted([
          ['car', 3],
          ['van', 2],
          ['truck', 1],
        ]),
      );
      const skew = rng.range(-8, 8);
      const triAt = _lateral(_corridorAt(c, dObs - rng.range(15, 30)), side * 1.2);
      // Drawn last (earlier draws unchanged). Facing the ego (UN R171) it shows its front.
      const facing = _p('facing', rng.chance(0.15) ? 'oncoming' : 'same');
      npcs.push(_vehicle(type, { x: at.x, y: at.y, yaw: pose.yaw + skew + (facing === 'oncoming' ? 180 : 0) }, 0));
      const tri = _prop('static.prop.warningaccident', triAt.x, triAt.y, pose.yaw + 180);
      if (tri) props.push(tri);
      Object.assign(params, { vehicle_type: type, lateral_m: r1(Math.abs(off)), facing });
    } else if (variant === 'stationary_vru') {
      // A VRU standing in the lane, back to the ego (UN R171); no events, so it stands all run.
      const type = _p(
        'vru_type',
        rng.weighted([
          ['pedestrian', 3],
          ['child', 1],
          ['cyclist', 2],
        ]),
      );
      const off = side * _p('lateral_m', rng.range(0, 0.8));
      const at = _lateral(pose, off);
      const vru = _vehicle(type, { x: at.x, y: at.y, yaw: pose.yaw }, 0);
      npcs.push(vru);
      Object.assign(params, { vru_type: type, lateral_m: r1(Math.abs(off)) });
    } else {
      // A queue (UN R157): a motorcycle, then a car beyond it, both stopped.
      const gap = rng.range(6, 10);
      const first = _p('vehicle_type', 'motorcycle');
      const off = side * _p('lateral_m', rng.range(0, 0.5));
      const a1 = _lateral(pose, off);
      const a2 = _lateral(_corridorAt(c, dObs + gap), 0);
      if (!_junctionFree(c, dObs, dObs + gap + 10)) return null;
      npcs.push(_vehicle(first, { x: a1.x, y: a1.y, yaw: pose.yaw }, 0));
      npcs.push(_vehicle('car', { x: a2.x, y: a2.y, yaw: _corridorAt(c, dObs + gap).yaw }, 0));
      Object.assign(params, { vehicle_type: first, queue_gap_m: r1(gap), lateral_m: r1(Math.abs(off)) });
    }
    params.site = _siteKind(c, dObs);
    params.distance_m = r1(dObs);
    params.side = side > 0 ? 'right' : 'left';
    if (!props.length && !npcs.length) return null;
    return { corridor: c, npcs, props, params, routedNpcs: [], conflictD: dObs };
  }

  /* Oncoming drift: a car swings over the centre line into the ego's lane and back. A route,
   * not a lane_offset (which jumps the aim point in one tick): fastest legs on its own lane,
   * 'shortest' samples tracing a half-cosine swing, then fastest again. The swing must end ON
   * its lane centre, because the next leg is routed from there. It waits at rest and is
   * released by a ramp on distance_to_ego; it ignores lights and obstacles, or it would brake
   * for the ego in the lane it swings into. */
  function _oncomingDrift(rng, net, vEgo) {
    // Start on an innermost lane of a two-way road; a random corridor rarely does.
    if (!net.twoWay) {
      net.twoWay = net.startable.filter(
        (L) => L.length >= 60 && Math.abs(L.lane.laneId) === 1 && _oncomingLane(net, { L }),
      );
    }
    if (!net.twoWay.length) return null;
    const start = rng.pick(net.twoWay);
    const c = _buildCorridor(
      rng,
      net,
      rng.range(220, 320),
      undefined,
      start,
      rng.range(0, Math.max(0.5, start.length - 60)),
    );
    if (!c) return null;
    // The oncoming lane at corridor distance d, per segment: the swing may cross lane sections
    // (Town10HD's are short).
    const oncAt = (d) => {
      const sg = c.segs.find((g) => d >= g.startD && d <= g.endD);
      if (!sg || sg.L.junction) return null;
      const O = _oncomingLane(net, sg);
      if (!O || O.junction) return null;
      const at = _corridorAt(c, d);
      const p = _projectOnLane(O, at.x, at.y);
      if (!p || p.d > 6) return null;
      return { O, s: p.s, pose: _laneAt(O, p.s) };
    };

    const vNpc = _p('npc_speed', rng.range(8, 14));
    const lenIn = vNpc * rng.range(1.0, 2.2); // centre line -> peak
    const lenHold = _p('hold_m', rng.range(0, 6)); // at the peak
    const lenOut = vNpc * rng.range(0.8, 1.8); // back to its own lane
    // Under ~1.4 m (3.5 m lane − 2.1 m car) the two only brush past.
    const offset = _p('offset_m', rng.range(1.2, 2.8));

    // dX is the peak. The car travels DOWN the corridor (swing start at dX + lenIn); the whole
    // swing ±5 m must fit one junction-free two-way stretch, so dX is drawn from those only.
    const stretches = [];
    for (const sg of c.segs) {
      const twoWay = !sg.L.junction && !!_oncomingLane(net, sg);
      const last = stretches[stretches.length - 1];
      if (twoWay && last && Math.abs(last.b - sg.startD) < 0.5) last.b = sg.endD;
      else if (twoWay) stretches.push({ a: sg.startD, b: sg.endD });
    }
    const dMinX = _egoRunUp(vEgo) + vEgo * 3;
    const fits = stretches
      .map((st) => ({ lo: Math.max(st.a + lenHold + lenOut + 5, dMinX), hi: Math.min(st.b, c.length) - lenIn - 5 }))
      .filter((f) => f.hi > f.lo);
    if (!fits.length) return null;
    const fit = rng.weighted(fits.map((f) => [f, f.hi - f.lo]));
    const dX = rng.range(fit.lo, fit.hi);
    const dEnd = dX - lenHold - lenOut;
    if (!_junctionFree(c, dEnd - 5, dX + lenIn + 5)) return null;
    const samples = [];
    const nIn = Math.max(2, Math.round(lenIn / 3));
    const nOut = Math.max(2, Math.round(lenOut / 3));
    samples.push({ d: dX + lenIn, off: 0, strategy: 'fastest' });
    for (let i = 1; i <= nIn; i++) {
      samples.push({
        d: dX + lenIn * (1 - i / nIn),
        off: (offset * (1 - Math.cos((Math.PI * i) / nIn))) / 2,
        strategy: 'shortest',
      });
    }
    if (lenHold > 1) samples.push({ d: dX - lenHold, off: offset, strategy: 'shortest' });
    for (let i = 1; i <= nOut; i++) {
      // Ends at exactly 0: the next leg is routed from here.
      samples.push({
        d: dX - lenHold - (lenOut * i) / nOut,
        off: (offset * (1 + Math.cos((Math.PI * i) / nOut))) / 2,
        strategy: 'shortest',
      });
    }
    const onc = samples.map((sm) => oncAt(sm.d));
    if (onc.some((o) => !o)) return null;
    const swingStart = onc[0],
      swingEnd = onc[onc.length - 1];

    // Back far enough to reach cruise before the swing, and no further (it waits at rest).
    const runUp = (vNpc * vNpc) / (2 * VEHICLE_ACCEL) + rng.range(5, 25);
    let spawn;
    if (swingStart.s - runUp >= 1) {
      spawn = _laneAt(swingStart.O, swingStart.s - runUp);
    } else {
      const back = _walkBack(rng, net, swingStart.O.key, runUp - swingStart.s);
      if (!back) return null;
      spawn = _laneAt(back.L, back.s);
    }
    const toPeak = runUp + lenIn;

    // On past the swing, so the route's end (a dead stop) is behind the ego.
    const exit = _walkForward(rng, net, swingEnd.O.key, swingEnd.s, rng.range(30, 50));
    if (!exit) return null;

    const dt = _p('arrival_offset_s', rng.range(-0.4, 0.6));
    const tNpc = _timeFromRest(toPeak, vNpc);
    const sol = _solveTrigger(c, dX, tNpc + dt, vEgo, spawn);
    if (!sol) return null;

    // Left is negative in _lateral. The first sample stays 'fastest': its leg is the routed run-up.
    const swing = samples.map((sm, i) => {
      const q = _lateral(onc[i].pose, -sm.off);
      return _routeWp({ x: q.x, y: q.y, z: onc[i].pose.z }, sm.strategy);
    });
    const exitPose = _laneAt(exit.L, exit.s);

    const type = _p(
      'npc_type',
      rng.weighted([
        ['car', 6],
        ['van', 2],
        ['truck', 1],
        ['motorcycle', 1],
      ]),
    );
    const npc = _vehicle(type, spawn, 0);
    _ignoresTraffic(npc);
    npc.events = [
      _routeEvent(npc, [...swing, _routeWp(exitPose)]),
      _speedEvent('evt-2', nearEgo(sol.radius), vNpc, 'rate', VEHICLE_ACCEL),
    ];

    // Optionally a car parked at the kerb of its lane that it goes round (CARLA leaderboard),
    // drawn last; pushed out just enough that the swing clears it by 0.4 m, or left out.
    const npcs = [npc];
    const sceneryIds = new Set();
    const causeDraw = rng.chance(0.4);
    const parkType = rng.weighted([
      ['car', 3],
      ['van', 2],
      ['truck', 1],
    ]);
    let cause = _p('cause', causeDraw ? 'parked' : 'none');
    if (cause === 'parked') {
      const kerb = (MapView.actorSize(type).h + MapView.actorSize(parkType).h) / 2 + 0.4 - 0.8 * offset;
      const at = oncAt(dX - lenHold / 2);
      if (at && kerb <= 1.0) {
        const q = _lateral(at.pose, Math.max(0.3, kerb)); // right of the oncoming lane's travel = its kerb
        const parked = _vehicle(parkType, { x: q.x, y: q.y, yaw: at.pose.yaw }, 0);
        npcs.push(parked);
        sceneryIds.add(parked.id);
      } else {
        cause = 'none';
      }
    }
    return {
      corridor: c,
      npcs,
      props: [],
      sceneryIds,
      conflictD: dX + 10,
      params: {
        cause,
        npc_type: type,
        npc_speed: r1(vNpc),
        offset_m: r1(offset),
        swing_in_m: r1(lenIn),
        hold_m: r1(lenHold),
        swing_out_m: r1(lenOut),
        npc_run_up_m: r1(toPeak),
        arrival_offset_s: r2(dt),
        trigger_m: r1(sol.radius),
      },
      routedNpcs: [{ actor: npc, passes: swingStart.pose }],
      // The threat starts when it leaves its lane, not at its release ~100 m away.
      onsets: new Map([[npc.id, swingStart.pose]]),
    };
  }

  GeneratorCore.define({ _obstacle, _oncomingDrift });
})();
