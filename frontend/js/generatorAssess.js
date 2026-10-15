/**
 * generatorAssess.js — route and spawn checks and the internal conflict check.
 *
 * Part of the scenario generator; the design is described in scenarioGenerator.js.
 */
(() => {
  'use strict';

  const { ROUTE_TOLERANCE_M, r1, r2, DEG, _corridorAt, _distToPolyline } = GeneratorCore.shared;

  // ── Checks ───────────────────────────────────────────────────────────────────

  function _routeOf(actor) {
    const ev = actor.events.find((e) => e.action?.type === 'assign_route');
    return ev ? Simulate.routeGeometry(actor, ev) : null;
  }

  /** The route the preview (and CARLA's router) would drive stays on the
   * corridor from dFrom to its end. */
  function _routeFollowsCorridor(actor, c, dFrom, dTo = c.length) {
    const route = _routeOf(actor);
    if (!route || route.length < 2) return false;
    // ...and does not leave it. Every corridor point being near the route
    // does not rule out a detour: a last waypoint just short of a junction can
    // project onto a connector the router only reaches by driving round the
    // block (Town03 slow_lead seed 2: a ~300 m corridor, a 1 km route), and
    // that loop then runs past other actors' route ends.
    let len = 0;
    for (let i = 1; i < route.length; i++) len += Math.hypot(route[i].x - route[i - 1].x, route[i].y - route[i - 1].y);
    if (len > dTo - dFrom + 40) return false;
    for (let d = dFrom + 4; d < dTo - 4; d += 4) {
      const p = _corridorAt(c, d);
      if (_distToPolyline(route, p.x, p.y) > ROUTE_TOLERANCE_M) return false;
    }
    return true;
  }

  /** No two actors spawn inside each other — CARLA refuses the second one
   * ("collision at spawn position") and the whole run fails — and the ego does
   * not start on top of an obstacle. Measured centre to centre against a
   * radius per actor kind, which is conservative for a 4.5 m car. */
  const SPAWN_RADIUS = { walker: 0.8, vehicle: 2.6, prop: 1.0 };
  function _spawnsClear(ego, npcs, props) {
    const r = (a) =>
      a.type === 'prop' ? SPAWN_RADIUS.prop : MapView.isWalkerType(a.type) ? SPAWN_RADIUS.walker : SPAWN_RADIUS.vehicle;
    const actors = [ego, ...npcs];
    for (let i = 0; i < actors.length; i++) {
      for (let j = i + 1; j < actors.length; j++) {
        const a = actors[i],
          b = actors[j];
        if (Math.hypot(a.x - b.x, a.y - b.y) < r(a) + r(b) + 0.5) return false;
      }
      for (const p of props) {
        // Props cluster on purpose (a cone taper), so only actor-vs-prop counts;
        // the ego gets a run-up on top, so it does not spawn staring at one.
        const clear = actors[i] === ego ? 15 : r(actors[i]) + SPAWN_RADIUS.prop + 0.5;
        if (Math.hypot(actors[i].x - p.x, actors[i].y - p.y) < clear) return false;
      }
    }
    return true;
  }

  // ── Conflict check (internal) ────────────────────────────────────────────────
  //
  // Every candidate is run through the preview headlessly, with an ego that
  // does NOT react: "what happens if the system under test does nothing".
  // Only used to drop candidates where nothing happens or nothing could be
  // avoided, and to locate the conflict (`at`) for a map-click build — it is
  // never shown, graded or exported. From that run:
  //
  //   ttc_s        seconds from the NPC's trigger to first contact. The time
  //                the system under test has to notice and act.
  //   decel_mps2   constant deceleration the ego would need, starting at the
  //                trigger, to stop short of the contact point. Upper bound for
  //                a moving NPC (it ignores the NPC's own escape).
  //   min_gap_m    smallest footprint-to-footprint distance when there is no
  //                contact at all (a near miss even without reacting).
  //
  // An obstacle has no trigger; it is "triggered" at t = 0, so its numbers
  // are about having seen it from the start.

  // No contact and never closer than this: nothing to test.
  const TRIVIAL_GAP_M = 2.0;
  // Contact sooner than this after the trigger, or needing more than this
  // braking: no system could avoid it, so it tests nothing either.
  const UNAVOIDABLE_TTC_S = 1.0;
  const UNAVOIDABLE_DECEL = 9.0;

  function _footprint(a) {
    if (a.type === 'prop') {
      const s = PropCatalog.planSize(a.prop);
      return { l: s.len, w: s.wid };
    }
    const s = MapView.actorSize(AppState.bodyType(a));
    return { l: s.w, w: s.h };
  }

  /** Corners of a footprint centred at (x, y), heading `yaw` radians. */
  function _corners(x, y, yaw, fp) {
    const c = Math.cos(yaw),
      s = Math.sin(yaw),
      hl = fp.l / 2,
      hw = fp.w / 2;
    return [
      [hl, hw],
      [hl, -hw],
      [-hl, -hw],
      [-hl, hw],
    ].map(([u, v]) => [x + u * c - v * s, y + u * s + v * c]);
  }

  /** Separating-axis gap between two convex quads: < 0 means overlap. */
  function _quadGap(A, B) {
    let gap = -Infinity;
    for (const P of [A, B]) {
      for (let i = 0; i < 4; i++) {
        const [x1, y1] = P[i],
          [x2, y2] = P[(i + 1) % 4];
        const nx = y2 - y1,
          ny = x1 - x2,
          n = Math.hypot(nx, ny) || 1;
        let aMin = Infinity,
          aMax = -Infinity,
          bMin = Infinity,
          bMax = -Infinity;
        for (const [x, y] of A) {
          const d = (x * nx + y * ny) / n;
          aMin = Math.min(aMin, d);
          aMax = Math.max(aMax, d);
        }
        for (const [x, y] of B) {
          const d = (x * nx + y * ny) / n;
          bMin = Math.min(bMin, d);
          bMax = Math.max(bMax, d);
        }
        gap = Math.max(gap, bMin - aMax, aMin - bMax);
      }
    }
    return gap;
  }

  /** Heading per sample from motion, holding the last one while stationary. */
  function _headings(track, yaw0Deg) {
    const out = [];
    let h = yaw0Deg / DEG;
    for (let i = 0; i < track.length; i++) {
      const a = track[Math.max(0, i - 1)],
        b = track[i];
      if (Math.hypot(b.x - a.x, b.y - a.y) > 0.005) h = Math.atan2(b.y - a.y, b.x - a.x);
      out.push(h);
    }
    return out;
  }

  /**
   * Score a candidate {ego, npcs, props}. Returns
   * {verdict, ttc_s, decel_mps2, min_gap_m, conflict_with, at}
   * where verdict is 'ok' | 'trivial' | 'unavoidable' | 'no_run'.
   */
  function assess(cand) {
    cand = { props: [], ...cand };
    const run = Simulate.runHeadless({ dt: 0.05, maxTime: 45, ego: cand.ego, npcs: cand.npcs, props: cand.props });
    if (!run) return { verdict: 'no_run' };
    const egoTr = run.tracks[run.egoId];
    const egoH = _headings(egoTr, cand.ego.yaw);
    const egoFp = _footprint(cand.ego);

    // What the ego can hit: every NPC (moving or parked) and every prop.
    // Scenery (the van a pedestrian steps out from behind) is part of the
    // set-up, not the conflict: a parked car beside the ego's lane would
    // otherwise score as a near miss.
    const scenery = cand.sceneryIds || new Set();
    const others = [
      ...cand.npcs.filter((n) => !scenery.has(n.id)).map((n) => ({ a: n, tr: run.tracks[n.id] })),
      ...cand.props.map((p) => ({ a: p, tr: null })),
    ];
    let worst = null;
    for (const o of others) {
      const fp = _footprint(o.a);
      const h = o.tr ? _headings(o.tr, o.a.yaw) : null;
      // Trigger = the first ego-relative event this actor fired; a static
      // thing (prop, parked car) is in view from the start.
      // A type can name the event that IS the threat (the cyclist's swerve,
      // not its riding at the kerb from t = 0); otherwise the first one.
      const threatId = cand.threats && cand.threats.get(o.a.id);
      // Or another actor's event is what exposes it: the stopped car a lead
      // cuts out from in front of is a threat from the cut, not from t = 0
      // and not from its own (much later) drive-off.
      const rev = cand.revealedBy && cand.revealedBy.get(o.a.id);
      const trig = rev
        ? [run.fired[rev.actorId]?.[rev.eventId]].filter((t) => t != null)
        : (o.a.events || [])
            .filter((e) => (threatId ? e.id === threatId : e.trigger?.type === 'distance_to_ego'))
            .map((e) => run.fired[o.a.id]?.[e.id])
            .filter((t) => t != null);
      const hasEvents = !!rev || (o.a.events || []).length > 0;
      if (hasEvents && !trig.length) continue; // never released: not this actor's conflict
      let t0 = trig.length ? Math.min(...trig) : 0;
      // Threat onset, where the type knows a better moment than the release:
      // the crossing car passing the line into the junction, the pedestrian
      // stepping off the kerb. Until then nothing says it will not stop.
      const onset = cand.onsets && cand.onsets.get(o.a.id);
      if (onset && o.tr) {
        const k = o.tr.findIndex((p, i) => run.times[i] >= t0 && Math.hypot(p.x - onset.x, p.y - onset.y) < 1.5);
        if (k >= 0) t0 = run.times[k];
      }
      const i0 = Math.max(
        0,
        run.times.findIndex((t) => t >= t0),
      );
      let contact = null,
        minGap = Infinity,
        minAt = null;
      for (let i = i0; i < run.times.length; i++) {
        const ox = o.tr ? o.tr[i].x : o.a.x,
          oy = o.tr ? o.tr[i].y : o.a.y;
        if (Math.hypot(ox - egoTr[i].x, oy - egoTr[i].y) > 25) continue; // cheap reject
        const g = _quadGap(
          _corners(egoTr[i].x, egoTr[i].y, egoH[i], egoFp),
          _corners(ox, oy, h ? h[i] : o.a.yaw / DEG, fp),
        );
        if (g < minGap) {
          minGap = g;
          minAt = i;
        }
        if (g < 0) {
          contact = i;
          break;
        }
      }
      // Where it happens: the ego at contact, or at its closest approach.
      const atI = contact ?? minAt;
      const at = atI != null ? { x: r1(egoTr[atI].x), y: r1(egoTr[atI].y) } : null;
      let entry;
      if (contact != null) {
        const ttc = run.times[contact] - (i0 ? run.times[i0] : 0);
        let travel = 0;
        for (let i = i0 + 1; i <= contact; i++)
          travel += Math.hypot(egoTr[i].x - egoTr[i - 1].x, egoTr[i].y - egoTr[i - 1].y);
        const v = egoTr[i0].speed;
        const decel = v > 0.1 ? (v * v) / (2 * Math.max(travel - 0.5, 0.25)) : 0;
        entry = { contact: true, ttc_s: r2(ttc), decel_mps2: r1(decel), min_gap_m: 0, with: o.a.type, at };
      } else {
        entry = { contact: false, ttc_s: null, decel_mps2: 0, min_gap_m: r1(Math.max(0, minGap)), with: o.a.type, at };
      }
      // The worst conflict is the one that leaves the least time.
      const key = (e) => (e.contact ? e.ttc_s : 1000 + e.min_gap_m);
      if (!worst || key(entry) < key(worst)) worst = entry;
    }
    if (!worst) return { verdict: 'trivial' };

    let verdict = 'ok';
    if (!worst.contact && worst.min_gap_m > TRIVIAL_GAP_M) verdict = 'trivial';
    if (worst.contact && (worst.ttc_s < UNAVOIDABLE_TTC_S || worst.decel_mps2 > UNAVOIDABLE_DECEL))
      verdict = 'unavoidable';
    return {
      verdict,
      ttc_s: worst.ttc_s,
      decel_mps2: worst.decel_mps2,
      min_gap_m: worst.min_gap_m,
      conflict_with: worst.with,
      at: worst.at,
    };
  }

  GeneratorCore.define({ _routeOf, _routeFollowsCorridor, _spawnsClear, assess });
})();
