/**
 * generatorTypesObstacle.js — the obstacle type.
 *
 * Part of the scenario generator; the design is described in scenarioGenerator.js.
 */
(() => {
  'use strict';

  const { r1, _p, _buildCorridor, _corridorAt, _junctionFree, _lateral, _vehicle, _egoRunUp } = GeneratorCore.shared;

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
      yaw: Math.round(UIUtils.wrapDeg(yaw)),
    };
  }

  /** 'curve' where the corridor turns > 12° over the 30 m around `d`, else 'straight'. */
  function _siteKind(c, d) {
    const a = _corridorAt(c, d - 15),
      b = _corridorAt(c, d + 15);
    return Math.abs(UIUtils.wrapDeg(b.yaw - a.yaw)) > 12 ? 'curve' : 'straight';
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

  GeneratorCore.define({ _obstacle });
})();
