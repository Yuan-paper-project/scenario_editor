/**
 * generatorTypesDrift.js — the oncoming-drift type.
 *
 * Part of the scenario generator; the design is described in scenarioGenerator.js.
 */
(() => {
  'use strict';

  const {
    VEHICLE_ACCEL,
    r1,
    r2,
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

  /* Oncoming drift into the ego's lane. 'swing': a route whose 'shortest' samples trace the swing
   * (it must end ON its lane centre, the next leg is routed from there); fixed in space, so a slow
   * ego can miss it. 'offset': a lane_offset on distance_to_ego, so it follows the ego. Both wait
   * at rest, are released on ego distance and ignore lights and obstacles (or they would brake
   * for the ego). */
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
    const styleDraw = rng.chance(0.5) ? 'offset' : 'swing';
    const returnDraw = rng.chance(0.7) ? 0 : rng.range(0.4, 1.2);
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
    const style = _p('style', styleDraw);
    let returnTtc = null;
    if (style === 'offset') {
      const outRadius = _offsetStyle(npc, { c, sol, vEgo, vNpc, runUp, swingStart, swingEnd, exitPose, offset });
      // Steering back beside the parked car would put it into that car.
      const ttc = cause === 'parked' ? 0 : _p('return_ttc_s', returnDraw);
      returnTtc = _offsetReturn(npc, outRadius, ttc, vEgo, vNpc, type);
    }
    const shape =
      style === 'offset'
        ? { return_ttc_s: r1(returnTtc) }
        : { swing_in_m: r1(lenIn), hold_m: r1(lenHold), swing_out_m: r1(lenOut) };
    return {
      corridor: c,
      npcs,
      props: [],
      sceneryIds,
      conflictD: dX + 10,
      params: {
        style,
        cause,
        npc_type: type,
        npc_speed: r1(vNpc),
        offset_m: r1(offset),
        ...shape,
        npc_run_up_m: r1(toPeak),
        arrival_offset_s: r2(dt),
        trigger_m: r1(sol.radius),
      },
      routedNpcs: [{ actor: npc, passes: swingStart.pose }],
      // The threat starts when it leaves its lane, not at its release ~100 m away.
      onsets: new Map([[npc.id, swingStart.pose]]),
    };
  }

  // Travel before it may turn back: two ~2 m halvings of the offset gap = 3/4 of the way out.
  const OFFSET_SETTLE_M = 6;

  /** 'offset' style: a plain route plus a lane_offset fired at the swing start; returns its radius. */
  function _offsetStyle(npc, { c, sol, vEgo, vNpc, runUp, swingStart, swingEnd, exitPose, offset }) {
    const egoAt = _corridorAt(c, sol.dEgo + vEgo * _timeFromRest(runUp, vNpc));
    const radius = Math.hypot(egoAt.x - swingStart.pose.x, egoAt.y - swingStart.pose.y);
    npc.events = [
      _routeEvent(npc, [_routeWp(swingStart.pose), _routeWp(swingEnd.pose), _routeWp(exitPose)]),
      npc.events[1],
      {
        id: 'evt-3',
        trigger: nearEgo(radius),
        // Left of the oncoming car's travel is the centre line, then the ego's lane.
        action: { type: 'lane_offset', direction: 'left', offset: r1(offset) },
      },
    ];
    return radius;
  }

  /** Steer back (offset 0) `ttc` s before meeting, no earlier than OFFSET_SETTLE_M; returns the ttc used, 0 = holds. */
  function _offsetReturn(npc, outRadius, ttc, vEgo, vNpc, type) {
    if (!(ttc > 0)) return 0;
    const closing = vEgo + vNpc;
    const touch = (MapView.actorSize('ego').w + MapView.actorSize(type).w) / 2;
    const latest = outRadius - (OFFSET_SETTLE_M * closing) / vNpc;
    const radius = Math.min(touch + ttc * closing, latest);
    const used = (radius - touch) / closing;
    if (used < 0.3) return 0;
    npc.events.push({
      id: 'evt-4',
      trigger: nearEgo(radius),
      action: { type: 'lane_offset', direction: 'left', offset: 0 },
    });
    return used;
  }

  GeneratorCore.define({ _oncomingDrift });
})();
