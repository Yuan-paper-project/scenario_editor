/* propPlanShapes.js — top-down footprints for the map markers (PropCatalog.planShapes).
 * Pure drawing: (kind, size, colour) in, SVG elements out; no catalogue lookups.
 */
(() => {
  'use strict';

  /* ── Plan view (top-down) — map markers ──────────────────────────────────────
   * Real footprints, drawn in the actor convention: `len` along local +X (the
   * yaw direction), `wid` across it, centred on the origin. These rotate with
   * prop.yaw exactly like vehicle footprints do in _renderActor.
   */
  function planShapes(kind, len, wid, color) {
    const out = [];
    const hl = len / 2,
      hw = wid / 2,
      u = Math.min(len, wid);
    const rect = (o = {}) =>
      out.push(
        UIUtils.svgEl('rect', {
          x: -hl,
          y: -hw,
          width: len,
          height: wid,
          rx: (o.rx ?? 0.12) * u,
          fill: o.fill || color,
          ...(o.op ? { 'fill-opacity': o.op } : {}),
        }),
      );

    switch (kind) {
      case 'cone': // a cone from above is a disc with a ring
        out.push(UIUtils.svgEl('circle', { r: hl, fill: color }));
        out.push(
          UIUtils.svgEl('circle', {
            r: hl * 0.55,
            fill: 'none',
            stroke: '#fff',
            'stroke-width': hl * 0.22,
            'stroke-opacity': 0.8,
          }),
        );
        break;
      case 'drum': // barrel / bin: plain disc
        out.push(UIUtils.svgEl('circle', { r: hl, fill: color }));
        out.push(
          UIUtils.svgEl('circle', {
            r: hl * 0.5,
            fill: 'none',
            stroke: '#fff',
            'stroke-width': hl * 0.14,
            'stroke-opacity': 0.5,
          }),
        );
        break;
      case 'panel': // sign / billboard face: thin bar across +X
        rect({ rx: 0.3 });
        out.push(
          UIUtils.svgEl('rect', {
            x: -hl * 0.34,
            y: -hw * 0.8,
            width: hl * 0.68,
            height: wid * 0.8,
            fill: '#fff',
            'fill-opacity': 0.55,
          }),
        );
        break;
      case 'barrier': // jersey barrier: bar with a centre stripe
        rect({ rx: 0.2 });
        out.push(
          UIUtils.svgEl('rect', {
            x: -hl * 0.12,
            y: -hw,
            width: hl * 0.24,
            height: wid,
            fill: '#fff',
            'fill-opacity': 0.7,
          }),
        );
        break;
      case 'trailer': // arrow board: body plus a drawbar nose
        rect({ rx: 0.1 });
        out.push(
          UIUtils.svgEl('polygon', {
            points: `${hl},${-hw * 0.3} ${hl * 1.25},0 ${hl},${hw * 0.3}`,
            fill: color,
          }),
        );
        break;
      case 'container': // long box with corrugation ticks
        rect({ rx: 0.04 });
        for (let i = 1; i < 10; i++) {
          out.push(
            UIUtils.svgEl('rect', {
              x: -hl + (i * len) / 10 - len * 0.006,
              y: -hw * 0.82,
              width: len * 0.012,
              height: wid * 0.82,
              fill: '#fff',
              'fill-opacity': 0.3,
            }),
          );
        }
        break;
      case 'shelter': // roof outline, open on the kerb side
        rect({ rx: 0.06, op: 0.45 });
        out.push(
          UIUtils.svgEl('rect', {
            x: -hl,
            y: -hw,
            width: len,
            height: wid * 0.26,
            fill: color,
          }),
        );
        break;
      case 'plate': // steel road plate: flat slab, cut corners
        out.push(
          UIUtils.svgEl('polygon', {
            points:
              `${-hl * 0.88},${-hw} ${hl * 0.88},${-hw} ${hl},${-hw * 0.6} ` +
              `${hl},${hw * 0.6} ${hl * 0.88},${hw} ${-hl * 0.88},${hw} ` +
              `${-hl},${hw * 0.6} ${-hl},${-hw * 0.6}`,
            fill: color,
            'fill-opacity': 0.9,
          }),
        );
        break;
      case 'blob': // debris scatter
        out.push(
          UIUtils.svgEl('ellipse', {
            rx: hl,
            ry: hw * 0.82,
            fill: color,
            'fill-opacity': 0.75,
            stroke: color,
            'stroke-width': u * 0.05,
            'stroke-dasharray': `${u * 0.12}`,
          }),
        );
        out.push(UIUtils.svgEl('circle', { cx: -hl * 0.3, cy: hw * 0.3, r: u * 0.1, fill: color }));
        out.push(UIUtils.svgEl('circle', { cx: hl * 0.35, cy: -hw * 0.25, r: u * 0.08, fill: color }));
        break;
      case 'cart': // basket outline with a handle tick
        rect({ rx: 0.18 });
        out.push(
          UIUtils.svgEl('rect', {
            x: -hl,
            y: -hw * 0.5,
            width: len * 0.16,
            height: wid * 0.5,
            fill: '#fff',
            'fill-opacity': 0.6,
          }),
        );
        break;
      case 'chain': // two posts joined by a line along the long axis
        {
          const along = wid > len;
          const half = along ? hw : hl,
            r = u * 0.5;
          const [x1, y1, x2, y2] = along ? [0, -half + r, 0, half - r] : [-half + r, 0, half - r, 0];
          out.push(
            UIUtils.svgEl('line', {
              x1,
              y1,
              x2,
              y2,
              stroke: color,
              'stroke-width': u * 0.3,
              'stroke-dasharray': `${u * 0.35} ${u * 0.2}`,
            }),
          );
          out.push(UIUtils.svgEl('circle', { cx: x1, cy: y1, r, fill: color }));
          out.push(UIUtils.svgEl('circle', { cx: x2, cy: y2, r, fill: color }));
        }
        break;
      case 'flat': // flattened cardboard: irregular slab
        out.push(
          UIUtils.svgEl('polygon', {
            points:
              `${-hl},${-hw * 0.8} ${hl * 0.7},${-hw} ${hl},${hw * 0.6} ` +
              `${-hl * 0.2},${hw} ${-hl * 0.9},${hw * 0.7}`,
            fill: color,
            'fill-opacity': 0.85,
          }),
        );
        break;
      case 'decal': // painting on the road: outline + figure
        out.push(
          UIUtils.svgEl('rect', {
            x: -hl,
            y: -hw,
            width: len,
            height: wid,
            fill: color,
            'fill-opacity': 0.3,
            stroke: color,
            'stroke-width': u * 0.06,
            'stroke-dasharray': `${u * 0.15}`,
          }),
        );
        out.push(UIUtils.svgEl('ellipse', { rx: hl * 0.5, ry: hw * 0.18, fill: '#fff', 'fill-opacity': 0.8 }));
        out.push(UIUtils.svgEl('circle', { cx: hl * 0.58, r: hw * 0.2, fill: '#fff', 'fill-opacity': 0.8 }));
        break;
      case 'hay': // round bale lying down: banded cylinder
        rect({ rx: 0.12 });
        for (const f of [-0.5, 0, 0.5]) {
          out.push(
            UIUtils.svgEl('rect', {
              x: -hl * 0.9,
              y: hw * f - wid * 0.03,
              width: len * 0.9,
              height: wid * 0.06,
              fill: '#fff',
              'fill-opacity': 0.3,
            }),
          );
        }
        break;
      case 'case': // luggage: rounded slab with a handle tick
        rect({ rx: 0.3 });
        out.push(
          UIUtils.svgEl('rect', {
            x: hl * 0.55,
            y: -hw * 0.35,
            width: len * 0.12,
            height: wid * 0.7,
            fill: '#fff',
            'fill-opacity': 0.6,
          }),
        );
        break;
      case 'bag':
        out.push(UIUtils.svgEl('ellipse', { rx: hl, ry: hw, fill: color }));
        out.push(
          UIUtils.svgEl('ellipse', {
            rx: hl * 0.45,
            ry: hw * 0.45,
            fill: 'none',
            stroke: '#fff',
            'stroke-width': u * 0.1,
            'stroke-opacity': 0.6,
          }),
        );
        break;
      case 'bench': // seat with slats along the long axis
        rect({ rx: 0.15 });
        for (const f of [-0.33, 0.33]) {
          out.push(
            UIUtils.svgEl('rect', {
              x: -hl * 0.92,
              y: hw * f - wid * 0.05,
              width: len * 0.92,
              height: wid * 0.1,
              fill: '#fff',
              'fill-opacity': 0.45,
            }),
          );
        }
        break;
      case 'frame': // open structure: outline + corner posts
        out.push(
          UIUtils.svgEl('rect', {
            x: -hl,
            y: -hw,
            width: len,
            height: wid,
            fill: color,
            'fill-opacity': 0.18,
            stroke: color,
            'stroke-width': u * 0.06,
          }),
        );
        for (const [cx, cy] of [
          [-hl, -hw],
          [hl, -hw],
          [-hl, hw],
          [hl, hw],
        ]) {
          out.push(UIUtils.svgEl('circle', { cx: cx * 0.94, cy: cy * 0.9, r: u * 0.07, fill: color }));
        }
        break;
      case 'slide': // platform square at -X, chute running to +X
        out.push(
          UIUtils.svgEl('rect', {
            x: -hl,
            y: -hw,
            width: wid,
            height: wid,
            fill: color,
          }),
        );
        out.push(
          UIUtils.svgEl('rect', {
            x: -hl + wid * 0.8,
            y: -hw * 0.6,
            width: len - wid * 0.8,
            height: wid * 0.6,
            rx: wid * 0.2,
            fill: color,
            'fill-opacity': 0.7,
          }),
        );
        break;
      default:
        rect({ rx: 0.1 });
        break;
    }
    return out;
  }

  window.PropShapes = Object.assign(window.PropShapes || {}, { plan: planShapes });
})();
