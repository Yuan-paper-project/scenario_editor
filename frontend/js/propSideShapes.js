/* propSideShapes.js — side-view silhouettes for the palette tiles (PropCatalog.tileIcon).
 * Pure drawing: (kind, size, colour) in, SVG elements out; no catalogue lookups.
 */
(() => {
  'use strict';

  /* ── Side view (elevation) — palette tiles ───────────────────────────────────
   * Flat silhouettes standing on the ground line y=0, centred on x=0, rising to
   * y=-h. Fills use the group colour; white low-opacity accents only, matching
   * the rest of the map's visual language. No gradients, no shading.
   *
   * Objects with an extreme aspect ratio (a 0.05 m road plate, a 0.3 m sign
   * post) degenerate into a hairline at true proportion, so those shapes floor
   * one dimension — see MIN_SIDE_RATIO.
   */
  const MIN_SIDE_RATIO = 0.3; // no silhouette thinner than 30% of its long side

  function sideShapes(kind, w, h, color) {
    // Keep degenerate aspect ratios legible without distorting normal props.
    const long = Math.max(w, h);
    w = Math.max(w, long * MIN_SIDE_RATIO);
    h = Math.max(h, long * MIN_SIDE_RATIO);

    const out = [];
    const X = (n) => n * w,
      Y = (n) => -n * h;
    const u = Math.min(w, h);
    const rect = (x, y, ww, hh, o = {}) =>
      out.push(
        UIUtils.svgEl('rect', {
          x: X(x),
          y: Y(y),
          width: ww * w,
          height: hh * h,
          fill: o.fill || color,
          ...(o.op ? { 'fill-opacity': o.op } : {}),
          ...(o.rx ? { rx: o.rx * u } : {}),
        }),
      );
    const poly = (pts, o = {}) =>
      out.push(
        UIUtils.svgEl('polygon', {
          points: pts.map(([x, y]) => `${X(x)},${Y(y)}`).join(' '),
          fill: o.fill || color,
          ...(o.op ? { 'fill-opacity': o.op } : {}),
        }),
      );
    const circ = (cx, cy, r, o = {}) =>
      out.push(
        UIUtils.svgEl('circle', {
          cx: X(cx),
          cy: Y(cy),
          r: r * u,
          fill: o.fill || color,
          ...(o.op ? { 'fill-opacity': o.op } : {}),
        }),
      );
    const path = (d, sw) =>
      out.push(
        UIUtils.svgEl('path', {
          d,
          fill: 'none',
          stroke: color,
          'stroke-width': sw * h,
          'stroke-linecap': 'round',
        }),
      );

    switch (kind) {
      case 'cone': // tapered body, flat top, base slab
        poly([
          [-0.34, 0.1],
          [0.34, 0.1],
          [0.09, 1],
          [-0.09, 1],
        ]);
        rect(-0.5, 0.13, 1, 0.13, { rx: 0.1 });
        rect(-0.26, 0.62, 0.52, 0.14, { fill: '#fff', op: 0.8 });
        break;
      case 'barrel': // drum with two rim bands
        rect(-0.5, 1, 1, 1, { rx: 0.1 });
        rect(-0.5, 0.74, 1, 0.07, { fill: '#fff', op: 0.75 });
        rect(-0.5, 0.34, 1, 0.07, { fill: '#fff', op: 0.75 });
        break;
      case 'bin': // tapered body + lid overhang
        poly([
          [-0.4, 0],
          [0.4, 0],
          [0.46, 0.86],
          [-0.46, 0.86],
        ]);
        rect(-0.5, 1, 1, 0.15, { rx: 0.12 });
        break;
      case 'jersey': // sloped skirt, flat top
        poly([
          [-0.5, 0],
          [0.5, 0],
          [0.33, 0.52],
          [0.29, 1],
          [-0.29, 1],
          [-0.33, 0.52],
        ]);
        rect(-0.3, 0.8, 0.6, 0.1, { fill: '#fff', op: 0.7 });
        break;
      case 'arrowboard': // board on mast, chassis + wheels
        rect(-0.44, 1, 0.88, 0.46, { rx: 0.06 });
        rect(-0.3, 0.54, 0.6, 0.1, { fill: '#fff', op: 0.75 });
        rect(-0.06, 0.54, 0.12, 0.3);
        rect(-0.4, 0.24, 0.8, 0.1, { rx: 0.04 });
        circ(-0.2, 0.09, 0.095);
        circ(0.24, 0.09, 0.095);
        break;
      case 'signtri': // triangle sign on a single post
        rect(-0.06, 0.46, 0.12, 0.46);
        rect(-0.22, 0.05, 0.44, 0.05, { rx: 0.04 });
        poly([
          [0, 1],
          [0.45, 0.44],
          [-0.45, 0.44],
        ]);
        poly(
          [
            [0, 0.9],
            [0.31, 0.5],
            [-0.31, 0.5],
          ],
          { fill: '#fff', op: 0.85 },
        );
        break;
      case 'signtri_a': // same sign on a splayed A-frame
        poly([
          [0, 1],
          [0.45, 0.44],
          [-0.45, 0.44],
        ]);
        poly(
          [
            [0, 0.9],
            [0.31, 0.5],
            [-0.31, 0.5],
          ],
          { fill: '#fff', op: 0.85 },
        );
        poly([
          [-0.05, 0.46],
          [0.05, 0.46],
          [0.34, 0],
          [0.22, 0],
        ]);
        poly([
          [0.05, 0.46],
          [-0.05, 0.46],
          [-0.34, 0],
          [-0.22, 0],
        ]);
        break;
      case 'billboard': // raised panel on two legs
        rect(-0.26, 0.4, 0.09, 0.4);
        rect(0.17, 0.4, 0.09, 0.4);
        rect(-0.5, 1, 1, 0.6, { rx: 0.04 });
        rect(-0.44, 0.94, 0.88, 0.48, { fill: '#fff', op: 0.8 });
        break;
      case 'container': // long box, corner posts, ribs
        rect(-0.5, 1, 1, 1, { rx: 0.03 });
        for (let i = 1; i < 12; i++) {
          rect(-0.5 + i / 12, 0.92, 0.022, 0.84, { fill: '#fff', op: 0.28 });
        }
        rect(-0.5, 1, 0.05, 1);
        rect(0.45, 1, 0.05, 1);
        break;
      case 'shelter': // roof slab, end posts, bench
        rect(-0.5, 1, 1, 0.11, { rx: 0.03 });
        rect(-0.47, 0.89, 0.07, 0.89);
        rect(0.4, 0.89, 0.07, 0.89);
        rect(-0.4, 0.7, 0.8, 0.62, { fill: '#fff', op: 0.35 });
        rect(-0.34, 0.34, 0.68, 0.09, { rx: 0.04 });
        rect(-0.3, 0.25, 0.06, 0.25);
        rect(0.24, 0.25, 0.06, 0.25);
        break;
      case 'cabinet': // body, window, plinth
        rect(-0.5, 1, 1, 0.94, { rx: 0.05 });
        rect(-0.38, 0.9, 0.58, 0.56, { fill: '#fff', op: 0.75 });
        rect(-0.5, 0.06, 1, 0.06, { rx: 0.02 });
        break;
      case 'cart': // basket, handle, wheels
        poly([
          [-0.34, 0.72],
          [0.44, 0.76],
          [0.36, 0.3],
          [-0.26, 0.28],
        ]);
        path(`M ${X(-0.34)} ${Y(0.72)} L ${X(-0.46)} ${Y(0.92)}`, 0.06);
        circ(-0.2, 0.09, 0.085);
        circ(0.28, 0.09, 0.085);
        break;
      case 'plank': // thin slab, bevelled ends
        poly([
          [-0.5, 0.18],
          [0.5, 0.18],
          [0.44, 0.82],
          [-0.44, 0.82],
        ]);
        break;
      case 'debris': // low irregular mound
        path(
          `M ${X(-0.5)} 0 Q ${X(-0.34)} ${Y(0.7)} ${X(-0.14)} ${Y(0.58)}
              Q ${X(0.02)} ${Y(0.82)} ${X(0.2)} ${Y(0.55)}
              Q ${X(0.38)} ${Y(0.68)} ${X(0.5)} 0 Z`,
          0,
        );
        out[out.length - 1].setAttribute('fill', color);
        out[out.length - 1].removeAttribute('stroke');
        break;
      case 'drum_striped': // traffic drum on a base slab
        rect(-0.5, 0.07, 1, 0.07, { rx: 0.1 });
        rect(-0.36, 1, 0.72, 0.92, { rx: 0.12 });
        rect(-0.36, 0.76, 0.72, 0.1, { fill: '#fff', op: 0.8 });
        rect(-0.36, 0.48, 0.72, 0.1, { fill: '#fff', op: 0.8 });
        break;
      case 'delineator': // tall tapered post on a foot
        rect(-0.5, 0.08, 1, 0.08, { rx: 0.1 });
        poly([
          [-0.22, 0.08],
          [0.22, 0.08],
          [0.12, 1],
          [-0.12, 1],
        ]);
        rect(-0.16, 0.86, 0.32, 0.08, { fill: '#fff', op: 0.8 });
        break;
      case 'post': // bollard / pillar
        rect(-0.5, 1, 1, 1, { rx: 0.4 });
        rect(-0.5, 0.86, 1, 0.08, { fill: '#fff', op: 0.6 });
        break;
      case 'chain': // post with a sagging chain
        rect(-0.5, 1, 0.12, 1, { rx: 0.3 });
        path(`M ${X(-0.38)} ${Y(0.78)} Q ${X(0.06)} ${Y(0.3)} ${X(0.5)} ${Y(0.78)}`, 0.05);
        break;
      case 'flat': // creased cardboard on the ground
        poly([
          [-0.5, 0],
          [0.5, 0],
          [0.44, 0.62],
          [-0.08, 1],
          [-0.46, 0.55],
        ]);
        break;
      case 'decal': // painted mat with a figure on it
        rect(-0.5, 0.5, 1, 0.5, { rx: 0.05, op: 0.55 });
        circ(0, 0.84, 0.14, { fill: '#fff', op: 0.9 });
        rect(-0.07, 0.7, 0.14, 0.62, { fill: '#fff', op: 0.9 });
        break;
      case 'box': // carton with a tape strip
        rect(-0.5, 1, 1, 1, { rx: 0.04 });
        rect(-0.07, 1, 0.14, 1, { fill: '#fff', op: 0.35 });
        break;
      case 'hay': // round bale, end on
        circ(0, 0.5, 0.5);
        circ(0, 0.5, 0.3, { fill: '#fff', op: 0.22 });
        circ(0, 0.5, 0.12, { fill: '#fff', op: 0.22 });
        break;
      case 'suitcase': // upright case, handle, wheels
        rect(-0.5, 0.86, 1, 0.8, { rx: 0.12 });
        rect(-0.08, 1, 0.16, 0.14);
        rect(-0.5, 0.55, 1, 0.05, { fill: '#fff', op: 0.4 });
        circ(-0.32, 0.04, 0.05);
        circ(0.32, 0.04, 0.05);
        break;
      case 'briefcase': // flat case + handle loop
        rect(-0.5, 0.78, 1, 0.78, { rx: 0.1 });
        rect(-0.18, 1, 0.36, 0.07);
        rect(-0.18, 1, 0.06, 0.22);
        rect(0.12, 1, 0.06, 0.22);
        break;
      case 'guitar': // guitar case, body + neck
        circ(-0.28, 0.5, 0.5);
        rect(-0.12, 0.7, 0.62, 0.4, { rx: 0.2 });
        break;
      case 'bag': // tote with handle
        poly([
          [-0.42, 0],
          [0.42, 0],
          [0.36, 0.72],
          [-0.36, 0.72],
        ]);
        path(`M ${X(-0.18)} ${Y(0.72)} Q ${X(0)} ${Y(1.25)} ${X(0.18)} ${Y(0.72)}`, 0.07);
        break;
      case 'helmet': // dome with a visor
        out.push(
          UIUtils.svgEl('path', {
            d: `M ${X(-0.5)} 0 A ${w / 2} ${h} 0 0 1 ${X(0.5)} 0 Z`,
            fill: color,
          }),
        );
        rect(-0.05, 0.55, 0.5, 0.2, { fill: '#fff', op: 0.6, rx: 0.2 });
        break;
      case 'trolley': // shopping trolley bag on wheels
        rect(-0.4, 0.8, 0.8, 0.7, { rx: 0.2 });
        path(`M ${X(0.3)} ${Y(0.8)} L ${X(0.42)} ${Y(1)}`, 0.05);
        circ(-0.22, 0.05, 0.06);
        circ(0.22, 0.05, 0.06);
        break;
      case 'can': // metal dustbin with lid
        rect(-0.42, 0.9, 0.84, 0.88, { rx: 0.06 });
        rect(-0.5, 0.97, 1, 0.08, { rx: 0.2 });
        rect(-0.08, 1, 0.16, 0.05);
        rect(-0.42, 0.62, 0.84, 0.04, { fill: '#fff', op: 0.4 });
        rect(-0.42, 0.32, 0.84, 0.04, { fill: '#fff', op: 0.4 });
        break;
      case 'postbin': // bin hung on a post
        rect(-0.06, 0.6, 0.12, 0.6);
        rect(-0.4, 1, 0.8, 0.46, { rx: 0.1 });
        rect(-0.3, 0.04, 0.6, 0.04);
        break;
      case 'sack': // knotted bin bag
        poly([
          [-0.46, 0.1],
          [-0.5, 0.5],
          [-0.25, 0.88],
          [0, 0.96],
          [0.25, 0.88],
          [0.5, 0.5],
          [0.46, 0.1],
          [0.3, 0],
          [-0.3, 0],
        ]);
        circ(0, 0.95, 0.1);
        break;
      case 'dome': // bottle bank, rounded top
        path(
          `M ${X(-0.5)} 0 L ${X(-0.5)} ${Y(0.6)} Q ${X(-0.5)} ${Y(1)} ${X(0)} ${Y(1)}
              Q ${X(0.5)} ${Y(1)} ${X(0.5)} ${Y(0.6)} L ${X(0.5)} 0 Z`,
          0,
        );
        out[out.length - 1].setAttribute('fill', color);
        out[out.length - 1].removeAttribute('stroke');
        rect(-0.5, 0.14, 1, 0.07, { fill: '#fff', op: 0.4 });
        circ(0, 0.72, 0.08, { fill: '#fff', op: 0.6 });
        break;
      case 'bench': // seat, backrest, legs
        rect(-0.5, 1, 1, 0.24, { rx: 0.04 });
        rect(-0.5, 0.55, 1, 0.12, { rx: 0.04 });
        rect(-0.44, 0.76, 0.06, 0.76);
        rect(0.38, 0.76, 0.06, 0.76);
        break;
      case 'bench_flat': // slab seat on two legs
        rect(-0.5, 1, 1, 0.24, { rx: 0.05 });
        rect(-0.4, 0.78, 0.1, 0.78);
        rect(0.3, 0.78, 0.1, 0.78);
        break;
      case 'postbox': // round-topped mailbox on legs
        rect(-0.5, 0.96, 1, 0.62, { rx: 0.35 });
        rect(-0.36, 0.36, 0.12, 0.36);
        rect(0.24, 0.36, 0.12, 0.36);
        rect(-0.26, 0.84, 0.52, 0.06, { fill: '#fff', op: 0.8 });
        break;
      case 'booth': // phone booth, glazed
        rect(-0.5, 1, 1, 1, { rx: 0.04 });
        rect(-0.38, 0.9, 0.76, 0.55, { fill: '#fff', op: 0.45 });
        rect(-0.38, 0.3, 0.76, 0.18, { fill: '#fff', op: 0.3 });
        break;
      case 'maptable': // slanted board on two legs
        rect(-0.46, 0.78, 0.1, 0.78);
        rect(0.36, 0.78, 0.1, 0.78);
        poly([
          [-0.5, 0.74],
          [0.5, 0.74],
          [0.5, 1],
          [-0.5, 0.9],
        ]);
        poly(
          [
            [-0.42, 0.78],
            [0.42, 0.78],
            [0.42, 0.95],
            [-0.42, 0.88],
          ],
          { fill: '#fff', op: 0.7 },
        );
        break;
      case 'foodcart': // canopy on poles, counter, wheels
        rect(-0.5, 1, 1, 0.12, { rx: 0.04 });
        rect(-0.45, 0.88, 0.04, 0.4);
        rect(0.41, 0.88, 0.04, 0.4);
        rect(-0.45, 0.5, 0.9, 0.4, { rx: 0.03 });
        rect(-0.35, 0.45, 0.4, 0.2, { fill: '#fff', op: 0.6 });
        circ(-0.25, 0.08, 0.08);
        circ(0.25, 0.08, 0.08);
        break;
      case 'planter': // trough with a rim
        rect(-0.5, 1, 1, 1, { rx: 0.05 });
        rect(-0.5, 1, 1, 0.12, { fill: '#fff', op: 0.3 });
        break;
      case 'pot': // tapered flower pot
        poly([
          [-0.5, 1],
          [0.5, 1],
          [0.36, 0],
          [-0.36, 0],
        ]);
        rect(-0.5, 1, 1, 0.14, { fill: '#fff', op: 0.3 });
        break;
      case 'bowl': // wide bowl on ball feet
        poly([
          [-0.5, 1],
          [0.5, 1],
          [0.3, 0.35],
          [-0.3, 0.35],
        ]);
        circ(-0.18, 0.14, 0.14);
        circ(0.18, 0.14, 0.14);
        break;
      case 'chair': // garden chair, side view
        rect(-0.36, 1, 0.12, 0.6);
        rect(-0.36, 0.52, 0.82, 0.08);
        rect(-0.36, 0.72, 0.76, 0.05);
        rect(-0.36, 0.46, 0.06, 0.46);
        rect(0.4, 0.46, 0.06, 0.46);
        break;
      case 'parasol': // table under a parasol
        poly([
          [-0.5, 0.82],
          [0, 1],
          [0.5, 0.82],
        ]);
        rect(-0.02, 0.9, 0.04, 0.9);
        rect(-0.42, 0.34, 0.84, 0.05);
        rect(-0.38, 0.3, 0.04, 0.3);
        rect(0.34, 0.3, 0.04, 0.3);
        break;
      case 'picnic': // table, benches, crossed legs
        rect(-0.5, 1, 1, 0.1);
        rect(-0.5, 0.55, 1, 0.07);
        path(`M ${X(-0.3)} 0 L ${X(0.3)} ${Y(0.95)} M ${X(0.3)} 0 L ${X(-0.3)} ${Y(0.95)}`, 0.06);
        break;
      case 'grill': // kettle on splayed legs
        rect(-0.5, 1, 1, 0.32, { rx: 0.3 });
        path(`M ${X(-0.35)} ${Y(0.68)} L ${X(-0.42)} 0 M ${X(0.35)} ${Y(0.68)} L ${X(0.42)} 0`, 0.04);
        rect(-0.38, 0.3, 0.76, 0.04);
        break;
      case 'gnome': // pointed hat, body, face
        poly([
          [0, 1],
          [0.32, 0.6],
          [-0.32, 0.6],
        ]);
        poly([
          [-0.42, 0],
          [0.42, 0],
          [0.32, 0.55],
          [-0.32, 0.55],
        ]);
        circ(0, 0.58, 0.16, { fill: '#fff', op: 0.8 });
        break;
      case 'doghouse': // pitched roof, arched door
        poly([
          [-0.5, 0.62],
          [0, 1],
          [0.5, 0.62],
        ]);
        rect(-0.42, 0.64, 0.84, 0.64);
        rect(-0.15, 0.42, 0.3, 0.42, { fill: '#fff', op: 0.35, rx: 0.3 });
        break;
      case 'lamp': // lantern
        poly([
          [-0.45, 0.8],
          [0, 1],
          [0.45, 0.8],
        ]);
        rect(-0.35, 0.8, 0.7, 0.62, { rx: 0.08 });
        rect(-0.22, 0.72, 0.44, 0.42, { fill: '#fff', op: 0.6 });
        rect(-0.4, 0.18, 0.8, 0.18);
        break;
      case 'swing': // A-frame with two seats
        path(
          `M ${X(-0.5)} 0 L ${X(-0.38)} ${Y(1)} L ${X(-0.26)} 0 M ${X(0.26)} 0 L ${X(0.38)} ${Y(1)} L ${X(0.5)} 0
              M ${X(-0.38)} ${Y(1)} L ${X(0.38)} ${Y(1)}`,
          0.035,
        );
        path(`M ${X(-0.18)} ${Y(1)} L ${X(-0.18)} ${Y(0.28)} M ${X(0.18)} ${Y(1)} L ${X(0.18)} ${Y(0.28)}`, 0.015);
        rect(-0.26, 0.28, 0.16, 0.05);
        rect(0.1, 0.28, 0.16, 0.05);
        break;
      case 'swingcouch': // roofed bench swing
        rect(-0.5, 1, 1, 0.08);
        path(`M ${X(-0.46)} 0 L ${X(-0.46)} ${Y(0.95)} M ${X(0.46)} 0 L ${X(0.46)} ${Y(0.95)}`, 0.04);
        rect(-0.34, 0.76, 0.68, 0.24, { op: 0.7, rx: 0.05 });
        rect(-0.34, 0.52, 0.68, 0.14, { rx: 0.08 });
        break;
      case 'slide': // ladder, platform, chute
        rect(-0.5, 1, 0.05, 1);
        rect(-0.36, 1, 0.05, 1);
        rect(-0.5, 1, 0.22, 0.06);
        poly([
          [-0.3, 0.96],
          [-0.18, 0.96],
          [0.5, 0.08],
          [0.5, 0],
          [0.36, 0],
        ]);
        break;
      case 'trampoline': // mat, net, poles
        rect(-0.5, 1, 1, 0.45, { op: 0.35 });
        rect(-0.5, 1, 0.03, 1);
        rect(0.47, 1, 0.03, 1);
        rect(-0.5, 0.56, 1, 0.07);
        break;
      case 'pergola': // posts and beams
        rect(-0.5, 1, 1, 0.07);
        rect(-0.5, 0.88, 1, 0.04);
        rect(-0.46, 0.88, 0.07, 0.88);
        rect(0.39, 0.88, 0.07, 0.88);
        break;
      case 'clothesline': // two posts, line, laundry
        rect(-0.5, 1, 0.03, 1);
        rect(0.47, 1, 0.03, 1);
        path(`M ${X(-0.48)} ${Y(0.92)} Q ${X(0)} ${Y(0.8)} ${X(0.48)} ${Y(0.92)}`, 0.012);
        rect(-0.32, 0.86, 0.1, 0.26);
        rect(-0.1, 0.84, 0.12, 0.3);
        rect(0.16, 0.86, 0.1, 0.22);
        break;
      default:
        rect(-0.5, 1, 1, 1, { rx: 0.08 });
    }
    return out;
  }

  window.PropShapes = Object.assign(window.PropShapes || {}, { side: sideShapes, MIN_SIDE_RATIO });
})();
