/**
 * mapRoadDetail.js — overpass levels, painted road marks, parking, signs, speed limits, direction arrows, crosswalks.
 *
 * Part of the map view (MapView); see mapView.js.
 */
(() => {
  'use strict';

  const { layerMarkings, layers } = MapCore.shared;

  // ── Road rendering ───────────────────────────────────────────────────────────
  function _polyToPoints(polygon) {
    return polygon.map((p) => `${p[0]},${p[1]}`).join(' ');
  }

  // ── Overlapping roads at different heights ─────────────────────────────────

  /* A flyover and the road under it share pixels, so roads that pass over others are
   * drawn in #layer-overpass by level. Heights are compared at the overlap itself (a ramp
   * varies); more than OVERPASS_GAP_M apart is an over/under, less a junction at grade. */
  const OVERPASS_GAP_M = 4.0;
  const OVERPASS_SAMPLE_STEP = 2; // test every 2nd centreline point

  function _bboxOf(points, into = null) {
    const b = into || { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const p of points) {
      if (p[0] < b.x0) b.x0 = p[0];
      if (p[0] > b.x1) b.x1 = p[0];
      if (p[1] < b.y0) b.y0 = p[1];
      if (p[1] > b.y1) b.y1 = p[1];
    }
    return b;
  }

  const _bboxHit = (a, b) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

  function _roadOverpassLevels(roads) {
    const info = [];
    for (const road of roads) {
      const cl = (road.centerline || []).filter((p) => p.length >= 3);
      const lanes = (road.lanes || [])
        .filter((l) => l.polygon && l.polygon.length >= 3)
        .map((l) => ({ poly: l.polygon, bbox: _bboxOf(l.polygon) }));
      if (!cl.length || !lanes.length) continue;
      const bbox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const l of lanes)
        _bboxOf(
          [
            [l.bbox.x0, l.bbox.y0],
            [l.bbox.x1, l.bbox.y1],
          ],
          bbox,
        );
      const zs = cl.map((p) => p[2]);
      info.push({ id: road.id, cl, lanes, bbox, zMin: Math.min(...zs), zMax: Math.max(...zs) });
    }
    const zAt = (r, x, y) => {
      let best = Infinity,
        z = 0;
      for (const p of r.cl) {
        const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
        if (d < best) {
          best = d;
          z = p[2];
        }
      }
      return z;
    };
    const heightOver = (a, b) => {
      for (let k = 0; k < b.cl.length; k += OVERPASS_SAMPLE_STEP) {
        const [x, y, z] = b.cl[k];
        if (x < a.bbox.x0 || x > a.bbox.x1 || y < a.bbox.y0 || y > a.bbox.y1) continue;
        for (const l of a.lanes) {
          if (x < l.bbox.x0 || x > l.bbox.x1 || y < l.bbox.y0 || y > l.bbox.y1) continue;
          if (UIUtils.pointInPoly(x, y, l.poly)) {
            const dz = zAt(a, x, y) - z;
            if (Math.abs(dz) > OVERPASS_GAP_M) return dz;
            break;
          }
        }
      }
      return 0;
    };
    const below = new Map(info.map((r) => [r.id, new Set()]));
    for (let i = 0; i < info.length; i++) {
      const a = info[i];
      for (let j = i + 1; j < info.length; j++) {
        const b = info[j];
        if (!_bboxHit(a.bbox, b.bbox)) continue;
        // Height ranges within the gap cannot pass over each other: skips nearly every pair.
        if (Math.max(a.zMax - b.zMin, b.zMax - a.zMin) <= OVERPASS_GAP_M) continue;
        const dz = heightOver(a, b) || -heightOver(b, a);
        if (dz > 0) below.get(a.id).add(b.id);
        else if (dz < 0) below.get(b.id).add(a.id);
      }
    }
    const levels = new Map();
    const visiting = new Set();
    const levelOf = (id) => {
      if (levels.has(id)) return levels.get(id);
      if (visiting.has(id)) return 0; // a cycle: should not happen, never loop
      visiting.add(id);
      let lv = 0;
      for (const b of below.get(id) || []) lv = Math.max(lv, levelOf(b) + 1);
      visiting.delete(id);
      levels.set(id, lv);
      return lv;
    };
    for (const r of info) levelOf(r.id);
    return levels;
  }

  // ── Road furniture from the .xodr: painted lines, parking, signs, limits ──

  const MARK_COLORS = { white: 'rgba(242,242,242,0.85)', yellow: 'rgba(242,190,40,0.9)' };
  const PARKING_GLYPH_EVERY_M = 20;

  /** Painted lines from the road's <roadMark>s (backend _build_mark_polylines). */
  function _renderRoadMarks(marks, target = layerMarkings) {
    for (const m of marks) {
      const attrs = {
        points: m.points.map((p) => `${p[0]},${p[1]}`).join(' '),
        fill: 'none',
        stroke: MARK_COLORS[m.color] || MARK_COLORS.white,
        'stroke-width': String(Math.max(m.width, 0.15)),
        class: `road-mark road-mark-${m.type}`,
      };
      // CARLA paints broken lines 3 m on, 6 m off.
      if (m.type === 'broken') attrs['stroke-dasharray'] = '3 6';
      target.appendChild(UIUtils.svgEl('polyline', attrs));
    }
  }

  /** A "P" every PARKING_GLYPH_EVERY_M along a parking lane's centre. */
  function _renderParkingGlyphs(line, target = layerMarkings) {
    let acc = PARKING_GLYPH_EVERY_M / 2;
    for (let i = 1; i < line.length; i++) {
      const [x0, y0] = line[i - 1],
        [x1, y1] = line[i];
      const seg = Math.hypot(x1 - x0, y1 - y0);
      while (acc <= seg && seg > 0) {
        const t = acc / seg;
        const t2 = UIUtils.svgEl('text', {
          x: (x0 + (x1 - x0) * t).toFixed(2),
          y: (y0 + (y1 - y0) * t).toFixed(2),
          class: 'parking-glyph',
          'font-size': '1.8',
          'text-anchor': 'middle',
          'dominant-baseline': 'central',
        });
        t2.textContent = 'P';
        target.appendChild(t2);
        acc += PARKING_GLYPH_EVERY_M;
      }
      acc -= seg;
    }
  }

  /** Stop = red octagon, Yield = inverted triangle; ~1.6 m, true-ish size like every marker. */
  function _renderSign(sign) {
    const g = UIUtils.svgEl('g', {
      class: `map-sign map-sign-${sign.type}`,
      transform: `translate(${sign.x},${sign.y})`,
    });
    if (sign.type === 'stop') {
      const r = 0.8,
        pts = [];
      for (let k = 0; k < 8; k++) {
        const a = Math.PI / 8 + (k * Math.PI) / 4;
        pts.push(`${(r * Math.cos(a)).toFixed(3)},${(r * Math.sin(a)).toFixed(3)}`);
      }
      g.appendChild(UIUtils.svgEl('polygon', { points: pts.join(' '), class: 'sign-stop-body' }));
      const t = UIUtils.svgEl('text', {
        class: 'sign-stop-text',
        'font-size': '0.42',
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
      });
      t.textContent = 'STOP';
      g.appendChild(t);
    } else {
      g.appendChild(UIUtils.svgEl('polygon', { points: '-0.9,-0.6 0.9,-0.6 0,0.95', class: 'sign-yield-body' }));
    }
    layers.signs.appendChild(g);
  }

  /** A speed-limit roundel at the sign; the sign actors, not the per-road speed records, set CARLA's limit. */
  function _renderSpeedSign(sp) {
    const g = UIUtils.svgEl('g', { class: 'speed-limit', transform: `translate(${sp.x},${sp.y})` });
    g.appendChild(UIUtils.svgEl('circle', { r: '1.6', class: 'speed-limit-ring' }));
    const t = UIUtils.svgEl('text', {
      class: 'speed-limit-text',
      'font-size': '1.3',
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
    });
    t.textContent = String(sp.kmh);
    g.appendChild(t);
    layers.speeds.appendChild(g);
  }

  /** Render small direction-arrow chevrons along a road centerline. */
  function _renderRoadDirArrows(centerline, target = layers.roadDir) {
    const INTERVAL = 30;
    let accum = 0;
    for (let i = 1; i < centerline.length; i++) {
      const [x0, y0] = centerline[i - 1];
      const [x1, y1] = centerline[i];
      const dx = x1 - x0,
        dy = y1 - y0;
      const segLen = Math.sqrt(dx * dx + dy * dy);
      accum += segLen;
      if (accum >= INTERVAL) {
        accum -= INTERVAL;
        const mx = (x0 + x1) / 2,
          my = (y0 + y1) / 2;
        const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        const arrow = UIUtils.svgEl('polygon', {
          points: '2,0 -2,-1.2 -2,1.2',
          fill: 'rgba(255,255,255,0.30)',
          transform: `translate(${mx.toFixed(1)},${my.toFixed(1)}) rotate(${angle.toFixed(1)})`,
        });
        target.appendChild(arrow);
      }
    }
  }

  /** On the road surface but not drivable. 'bidirectional' is Town03's ring-highway wall,
   *  which CARLA never routes. */
  const BLOCKED_LANE_TYPES = new Set(['median', 'border', 'restricted', 'bidirectional']);

  /** Return a subtle edge stroke colour for a given lane type. */
  function _laneStrokeColor(type) {
    switch (type) {
      case 'median':
      case 'bidirectional':
        return '#7a756a';
      case 'border':
      case 'restricted':
        return '#5a5752';
      case 'driving':
        return '#3a3a3a';
      case 'sidewalk':
        return '#b0a07a';
      case 'shoulder':
        return '#555555';
      default:
        return '#444444';
    }
  }

  // ── Crosswalk rendering ────────────────────────────────────────────────────

  function _renderCrosswalk(cw) {
    // Zebra stripes: spaced across the road, each a thin rectangle along it.
    const rad = (cw.heading * Math.PI) / 180;
    const fx = Math.cos(rad),
      fy = Math.sin(rad); // road-forward unit vector
    const px = -fy,
      py = fx; // perpendicular (across road)

    const crosswalkWidth = Math.max(1.0, Number(cw.width) || 3.0); // along-road direction (m)
    const crosswalkLength = Math.max(2.0, Number(cw.length) || 12.0); // across-road direction (m)
    const STRIPE_W = Math.min(1.2, Math.max(0.55, crosswalkLength / 12));
    const STRIPE_GAP = STRIPE_W * 0.75;
    const totalStep = STRIPE_W + STRIPE_GAP;
    const NUM_STRIPES = Math.max(2, Math.floor((crosswalkLength + STRIPE_GAP) / totalStep));
    const usedLength = NUM_STRIPES * STRIPE_W + (NUM_STRIPES - 1) * STRIPE_GAP;
    const startOff = -usedLength / 2;

    const g = UIUtils.svgEl('g', { class: 'crosswalk-group' });

    for (let i = 0; i < NUM_STRIPES; i++) {
      const offset = startOff + i * totalStep + STRIPE_W / 2;
      const cx = cw.x + px * offset;
      const cy = cw.y + py * offset;
      const hw = STRIPE_W / 2; // half-width in perpendicular direction
      const hl = crosswalkWidth / 2; // half-length in road-forward direction
      const pts = [
        [cx + fx * hl + px * hw, cy + fy * hl + py * hw],
        [cx + fx * hl - px * hw, cy + fy * hl - py * hw],
        [cx - fx * hl - px * hw, cy - fy * hl - py * hw],
        [cx - fx * hl + px * hw, cy - fy * hl + py * hw],
      ]
        .map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`)
        .join(' ');

      g.appendChild(
        UIUtils.svgEl('polygon', {
          points: pts,
          fill: '#ffffff',
          'fill-opacity': '0.85',
        }),
      );
    }

    layers.crosswalks.appendChild(g);
  }

  MapCore.define({
    _polyToPoints,
    _roadOverpassLevels,
    _renderRoadMarks,
    _renderParkingGlyphs,
    _renderSign,
    _renderSpeedSign,
    _renderRoadDirArrows,
    BLOCKED_LANE_TYPES,
    _laneStrokeColor,
    _renderCrosswalk,
  });
})();
