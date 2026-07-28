/* propCatalog.js — CARLA static prop catalogue (presentation side).
 *
 * Mirrors the split already used for vehicles: this file owns everything the
 * editor needs to *show* a prop (label, group, shapes, dimensions), while
 * ../llm-scenario-gen/config/prop_catalog.yaml owns everything the exporter
 * needs to *emit* one (miscObjectCategory, mass, 3D bounding box). The only
 * shared column is the blueprint id; a mismatch fails loudly as a 400 at
 * export, never silently.
 *
 * TWO VIEWS, deliberately:
 *   side — elevation silhouette, used for the palette tiles. A picker icon
 *          should look like the object, and there is no projection to clash
 *          with in a toolbar.
 *   plan — top-down footprint, used for the map marker. The map is a plan
 *          view throughout (roads, lane markings, and vehicle footprints in
 *          mapView._renderActor), and props rotate with yaw the same way
 *          actors do, so their marker has to be plan view too.
 *
 * Dimensions are real metres. `plan.len` runs along local +X (the yaw
 * direction, matching ACTOR_SIZES.w); `plan.wid` runs across it.
 * oriented:false props are rotationally symmetric and get no yaw handle.
 *
 * `facing` is the placement rule, resolved against the OpenDRIVE direction of
 * the SPECIFIC lane nearest the click (objects.js `_propYawFor`). Because
 * map_renderer reverses directionLine for left-side lanes, adjacent lanes of a
 * two-way road yield opposite laneYaw, so an 'oncoming' prop on each side
 * correctly faces its own lane's traffic.
 *   oncoming    — laneYaw + 180, confronts approaching traffic
 *   along       — laneYaw, long axis follows the lane
 *   alongside   — laneYaw or +180, whichever turns the open side toward the road
 *   toward-road — bearing from the prop to the nearest lane point
 *   none        — no rule; yaw 0, still rotatable by hand
 * Independent of `oriented`: a 'none' prop can still have a yaw handle.
 */
(function () {
  'use strict';

  const GROUPS = [
    { id: 'workzone',  label: 'Baustelle',       color: '#e8801a' },
    { id: 'surface',   label: 'Fahrbahn',        color: '#a06a2c' },
    { id: 'occluder',  label: 'Sichtverdeckung', color: '#6b7a8f' },
  ];

  const PROPS = {
    // ── Baustelle ────────────────────────────────────────────────────────────
    'static.prop.trafficcone01': {
      label: 'Leitkegel', group: 'workzone', z: 0.0, oriented: false, facing: 'none',
      side: { kind: 'cone', w: 0.88, h: 1.14 },
      plan: { kind: 'cone', len: 0.88, wid: 0.88 },
    },
    'static.prop.trafficcone02': {
      label: 'Leitkegel klein', group: 'workzone', z: 0.0, oriented: false, facing: 'none',
      side: { kind: 'cone', w: 0.46, h: 1.18 },
      plan: { kind: 'cone', len: 0.46, wid: 0.40 },
    },
    'static.prop.constructioncone': {
      label: 'Baustellenkegel', group: 'workzone', z: 0.0, oriented: false, facing: 'none',
      side: { kind: 'cone', w: 0.34, h: 0.58 },
      plan: { kind: 'cone', len: 0.34, wid: 0.34 },
    },
    'static.prop.streetbarrier': {
      label: 'Absperrung', group: 'workzone', z: 0.0, oriented: true, facing: 'oncoming',
      planRotate: 90,
      side: { kind: 'jersey', w: 1.22, h: 1.06 },
      plan: { kind: 'barrier', len: 1.22, wid: 0.38 },
    },
    'static.prop.trafficwarning': {
      label: 'Warnanhänger', group: 'workzone', z: 0.0, oriented: true, facing: 'oncoming',
      planRotate: 90,
      side: { kind: 'arrowboard', w: 2.88, h: 3.56 },
      plan: { kind: 'trailer', len: 2.38, wid: 2.88 },
    },
    'static.prop.warningconstruction': {
      label: 'Bauschild', group: 'workzone', z: 0.0, oriented: true, facing: 'oncoming',
      side: { kind: 'signtri', w: 1.30, h: 1.86 },
      plan: { kind: 'panel', len: 0.30, wid: 1.30 },
    },
    'static.prop.warningaccident': {
      label: 'Unfallschild', group: 'workzone', z: 0.0, oriented: true, facing: 'oncoming',
      side: { kind: 'signtri_a', w: 1.30, h: 1.86 },
      plan: { kind: 'panel', len: 0.30, wid: 1.30 },
    },
    'static.prop.barrel': {
      label: 'Fass', group: 'workzone', z: 0.0, oriented: false, facing: 'none',
      side: { kind: 'barrel', w: 0.48, h: 0.80 },
      plan: { kind: 'drum', len: 0.46, wid: 0.48 },
    },

    // ── Fahrbahn ─────────────────────────────────────────────────────────────
    'static.prop.ironplank': {
      label: 'Stahlplatte', group: 'surface', z: 0.0, oriented: true, facing: 'along',
      side: { kind: 'plank', w: 1.46, h: 0.02 },
      plan: { kind: 'plate', len: 1.46, wid: 1.18 },
    },
    'static.prop.dirtdebris01': {
      label: 'Schutt groß', group: 'surface', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'debris', w: 1.86, h: 0.14 },
      plan: { kind: 'blob', len: 1.86, wid: 1.52 },
    },

    // ── Sichtverdeckung ──────────────────────────────────────────────────────
    'static.prop.container': {
      label: 'Container', group: 'occluder', z: 0.0, oriented: true, facing: 'alongside',
      side: { kind: 'container', w: 1.94, h: 1.72 },
      plan: { kind: 'container', len: 1.94, wid: 1.02 },
    },
    'static.prop.busstop': {
      label: 'Bushaltestelle', group: 'occluder', z: 0.0, oriented: true, facing: 'alongside',
      side: { kind: 'shelter', w: 3.88, h: 2.74 },
      plan: { kind: 'shelter', len: 3.88, wid: 1.90 },
    },
    'static.prop.advertisement': {
      label: 'Werbetafel', group: 'occluder', z: 0.0, oriented: true, facing: 'oncoming',
      side: { kind: 'billboard', w: 1.54, h: 2.44 },
      plan: { kind: 'panel', len: 0.28, wid: 1.54 },
    },
    'static.prop.vendingmachine': {
      label: 'Automat', group: 'occluder', z: 0.0, oriented: true, facing: 'toward-road',
      side: { kind: 'cabinet', w: 1.10, h: 2.10 },
      plan: { kind: 'box', len: 0.88, wid: 1.10 },
    },
    'static.prop.bin': {
      label: 'Mülltonne', group: 'occluder', z: 0.0, oriented: false, facing: 'none',
      side: { kind: 'bin', w: 0.64, h: 1.06 },
      plan: { kind: 'drum', len: 0.54, wid: 0.64 },
    },
    'static.prop.shoppingcart': {
      label: 'Einkaufswagen', group: 'occluder', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'cart', w: 1.20, h: 1.08 },
      plan: { kind: 'cart', len: 0.66, wid: 1.20 },
    },
  };

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function _el(tag, attrs) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  /* ── Side view (elevation) — palette tiles ───────────────────────────────────
   * Flat silhouettes standing on the ground line y=0, centred on x=0, rising to
   * y=-h. Fills use the group colour; white low-opacity accents only, matching
   * the rest of the map's visual language. No gradients, no shading.
   *
   * Objects with an extreme aspect ratio (a 0.05 m road plate, a 0.3 m sign
   * post) degenerate into a hairline at true proportion, so those shapes floor
   * one dimension — see MIN_SIDE_RATIO.
   */
  const MIN_SIDE_RATIO = 0.30;   // no silhouette thinner than 30% of its long side

  function sideShapes(kind, w, h, color) {
    // Keep degenerate aspect ratios legible without distorting normal props.
    const long = Math.max(w, h);
    w = Math.max(w, long * MIN_SIDE_RATIO);
    h = Math.max(h, long * MIN_SIDE_RATIO);

    const out = [];
    const X = n => n * w, Y = n => -n * h;
    const u = Math.min(w, h);
    const rect = (x, y, ww, hh, o = {}) => out.push(_el('rect', {
      x: X(x), y: Y(y), width: ww * w, height: hh * h,
      fill: o.fill || color, ...(o.op ? { 'fill-opacity': o.op } : {}),
      ...(o.rx ? { rx: o.rx * u } : {}),
    }));
    const poly = (pts, o = {}) => out.push(_el('polygon', {
      points: pts.map(([x, y]) => `${X(x)},${Y(y)}`).join(' '),
      fill: o.fill || color, ...(o.op ? { 'fill-opacity': o.op } : {}),
    }));
    const circ = (cx, cy, r, o = {}) => out.push(_el('circle', {
      cx: X(cx), cy: Y(cy), r: r * u,
      fill: o.fill || color, ...(o.op ? { 'fill-opacity': o.op } : {}),
    }));
    const path = (d, sw) => out.push(_el('path', {
      d, fill: 'none', stroke: color, 'stroke-width': sw * h, 'stroke-linecap': 'round',
    }));

    switch (kind) {
      case 'cone':                                    // tapered body, flat top, base slab
        poly([[-.34, .10], [.34, .10], [.09, 1], [-.09, 1]]);
        rect(-.5, .13, 1, .13, { rx: .10 });
        rect(-.26, .62, .52, .14, { fill: '#fff', op: .8 });
        break;
      case 'barrel':                                  // drum with two rim bands
        rect(-.5, 1, 1, 1, { rx: .10 });
        rect(-.5, .74, 1, .07, { fill: '#fff', op: .75 });
        rect(-.5, .34, 1, .07, { fill: '#fff', op: .75 });
        break;
      case 'bin':                                     // tapered body + lid overhang
        poly([[-.40, 0], [.40, 0], [.46, .86], [-.46, .86]]);
        rect(-.5, 1, 1, .15, { rx: .12 });
        break;
      case 'jersey':                                  // sloped skirt, flat top
        poly([[-.5, 0], [.5, 0], [.33, .52], [.29, 1], [-.29, 1], [-.33, .52]]);
        rect(-.30, .80, .60, .10, { fill: '#fff', op: .7 });
        break;
      case 'arrowboard':                              // board on mast, chassis + wheels
        rect(-.44, 1, .88, .46, { rx: .06 });
        rect(-.30, .54, .60, .10, { fill: '#fff', op: .75 });
        rect(-.06, .54, .12, .30);
        rect(-.40, .24, .80, .10, { rx: .04 });
        circ(-.20, .09, .095);
        circ(.24, .09, .095);
        break;
      case 'signtri':                                 // triangle sign on a single post
        rect(-.06, .46, .12, .46);
        rect(-.22, .05, .44, .05, { rx: .04 });
        poly([[0, 1], [.45, .44], [-.45, .44]]);
        poly([[0, .90], [.31, .50], [-.31, .50]], { fill: '#fff', op: .85 });
        break;
      case 'signtri_a':                               // same sign on a splayed A-frame
        poly([[0, 1], [.45, .44], [-.45, .44]]);
        poly([[0, .90], [.31, .50], [-.31, .50]], { fill: '#fff', op: .85 });
        poly([[-.05, .46], [.05, .46], [.34, 0], [.22, 0]]);
        poly([[.05, .46], [-.05, .46], [-.34, 0], [-.22, 0]]);
        break;
      case 'billboard':                               // raised panel on two legs
        rect(-.26, .40, .09, .40);
        rect(.17, .40, .09, .40);
        rect(-.5, 1, 1, .60, { rx: .04 });
        rect(-.44, .94, .88, .48, { fill: '#fff', op: .8 });
        break;
      case 'container':                               // long box, corner posts, ribs
        rect(-.5, 1, 1, 1, { rx: .03 });
        for (let i = 1; i < 12; i++) {
          rect(-.5 + i / 12, .92, .022, .84, { fill: '#fff', op: .28 });
        }
        rect(-.5, 1, .05, 1);
        rect(.45, 1, .05, 1);
        break;
      case 'shelter':                                 // roof slab, end posts, bench
        rect(-.5, 1, 1, .11, { rx: .03 });
        rect(-.47, .89, .07, .89);
        rect(.40, .89, .07, .89);
        rect(-.40, .70, .80, .62, { fill: '#fff', op: .35 });
        rect(-.34, .34, .68, .09, { rx: .04 });
        rect(-.30, .25, .06, .25);
        rect(.24, .25, .06, .25);
        break;
      case 'cabinet':                                 // body, window, plinth
        rect(-.5, 1, 1, .94, { rx: .05 });
        rect(-.38, .90, .58, .56, { fill: '#fff', op: .75 });
        rect(-.5, .06, 1, .06, { rx: .02 });
        break;
      case 'cart':                                    // basket, handle, wheels
        poly([[-.34, .72], [.44, .76], [.36, .30], [-.26, .28]]);
        path(`M ${X(-.34)} ${Y(.72)} L ${X(-.46)} ${Y(.92)}`, .06);
        circ(-.20, .09, .085);
        circ(.28, .09, .085);
        break;
      case 'plank':                                   // thin slab, bevelled ends
        poly([[-.5, .18], [.5, .18], [.44, .82], [-.44, .82]]);
        break;
      case 'debris':                                  // low irregular mound
        path(`M ${X(-.5)} 0 Q ${X(-.34)} ${Y(.70)} ${X(-.14)} ${Y(.58)}
              Q ${X(.02)} ${Y(.82)} ${X(.20)} ${Y(.55)}
              Q ${X(.38)} ${Y(.68)} ${X(.5)} 0 Z`, 0);
        out[out.length - 1].setAttribute('fill', color);
        out[out.length - 1].removeAttribute('stroke');
        break;
      default:
        rect(-.5, 1, 1, 1, { rx: .08 });
    }
    return out;
  }

  /* ── Plan view (top-down) — map markers ──────────────────────────────────────
   * Real footprints, drawn in the actor convention: `len` along local +X (the
   * yaw direction), `wid` across it, centred on the origin. These rotate with
   * prop.yaw exactly like vehicle footprints do in _renderActor.
   */
  function planShapes(kind, len, wid, color) {
    const out = [];
    const hl = len / 2, hw = wid / 2, u = Math.min(len, wid);
    const rect = (o = {}) => out.push(_el('rect', {
      x: -hl, y: -hw, width: len, height: wid, rx: (o.rx ?? .12) * u,
      fill: o.fill || color, ...(o.op ? { 'fill-opacity': o.op } : {}),
    }));

    switch (kind) {
      case 'cone':          // a cone from above is a disc with a ring
        out.push(_el('circle', { r: hl, fill: color }));
        out.push(_el('circle', {
          r: hl * 0.55, fill: 'none', stroke: '#fff',
          'stroke-width': hl * 0.22, 'stroke-opacity': .8,
        }));
        break;
      case 'drum':          // barrel / bin: plain disc
        out.push(_el('circle', { r: hl, fill: color }));
        out.push(_el('circle', {
          r: hl * 0.5, fill: 'none', stroke: '#fff',
          'stroke-width': hl * 0.14, 'stroke-opacity': .5,
        }));
        break;
      case 'panel':         // sign / billboard face: thin bar across +X
        rect({ rx: .3 });
        out.push(_el('rect', {
          x: -hl * 0.34, y: -hw * 0.8, width: hl * 0.68, height: wid * 0.8,
          fill: '#fff', 'fill-opacity': .55,
        }));
        break;
      case 'barrier':       // jersey barrier: bar with a centre stripe
        rect({ rx: .2 });
        out.push(_el('rect', {
          x: -hl * 0.12, y: -hw, width: hl * 0.24, height: wid,
          fill: '#fff', 'fill-opacity': .7,
        }));
        break;
      case 'trailer':       // arrow board: body plus a drawbar nose
        rect({ rx: .1 });
        out.push(_el('polygon', {
          points: `${hl},${-hw * .3} ${hl * 1.25},0 ${hl},${hw * .3}`, fill: color,
        }));
        break;
      case 'container':     // long box with corrugation ticks
        rect({ rx: .04 });
        for (let i = 1; i < 10; i++) {
          out.push(_el('rect', {
            x: -hl + (i * len) / 10 - len * .006, y: -hw * .82,
            width: len * .012, height: wid * .82,
            fill: '#fff', 'fill-opacity': .3,
          }));
        }
        break;
      case 'shelter':       // roof outline, open on the kerb side
        rect({ rx: .06, op: .45 });
        out.push(_el('rect', {
          x: -hl, y: -hw, width: len, height: wid * 0.26, fill: color,
        }));
        break;
      case 'plate':         // steel road plate: flat slab, cut corners
        out.push(_el('polygon', {
          points: `${-hl * .88},${-hw} ${hl * .88},${-hw} ${hl},${-hw * .6} `
                + `${hl},${hw * .6} ${hl * .88},${hw} ${-hl * .88},${hw} `
                + `${-hl},${hw * .6} ${-hl},${-hw * .6}`,
          fill: color, 'fill-opacity': .9,
        }));
        break;
      case 'blob':          // debris scatter
        out.push(_el('ellipse', {
          rx: hl, ry: hw * .82, fill: color, 'fill-opacity': .75,
          stroke: color, 'stroke-width': u * .05, 'stroke-dasharray': `${u * .12}`,
        }));
        out.push(_el('circle', { cx: -hl * .3, cy: hw * .3, r: u * .1, fill: color }));
        out.push(_el('circle', { cx: hl * .35, cy: -hw * .25, r: u * .08, fill: color }));
        break;
      case 'cart':          // basket outline with a handle tick
        rect({ rx: .18 });
        out.push(_el('rect', {
          x: -hl, y: -hw * .5, width: len * .16, height: wid * .5,
          fill: '#fff', 'fill-opacity': .6,
        }));
        break;
      case 'box':
      default:
        rect({ rx: .1 });
        break;
    }
    return out;
  }

  /* True measured footprint, drawn to scale — no minimum.
   *
   * There used to be a MIN_PLAN_EXTENT floor here, but it inflated every small
   * prop to the same size: all three cones are under it, so a 0.34 m
   * constructioncone and a 0.88 m trafficcone01 both rendered as identical
   * discs. Clickability does not depend on this — _renderProp adds a separate
   * invisible hit circle with its own floor — so the visible glyph can simply
   * tell the truth. */
  function planSize(id) {
    const p = PROPS[id]?.plan || { len: 0.5, wid: 0.5 };
    return { len: p.len, wid: p.wid };
  }

  const PropCatalog = {
    GROUPS,

    /** Catalogue entry for a blueprint id, or null. */
    get(id) {
      const p = PROPS[id];
      return p ? { id, ...p } : null;
    },

    ids() {
      return Object.keys(PROPS);
    },

    /** Fill colour for a prop, from its group. */
    color(id) {
      const g = GROUPS.find(gr => gr.id === PROPS[id]?.group);
      return g ? g.color : '#e8801a';
    },

    label(id) {
      return PROPS[id]?.label || id || '';
    },

    oriented(id) {
      return !!PROPS[id]?.oriented;
    },

    /** Placement facing rule — see the header. Independent of `oriented`:
     *  a 'none' prop may still carry a yaw handle for manual rotation. */
    facing(id) {
      return PROPS[id]?.facing || 'none';
    },

    /** MAP GLYPH ONLY: extra rotation of the drawn body, in degrees.
     *  For props whose yaw means "the way the face points", the body has to sit
     *  across that direction — a barrier blocks the lane, it does not lie along
     *  it. Purely cosmetic: the exported h is untouched, and the yaw arrow keeps
     *  pointing at the true facing. */
    planRotate(id) {
      return PROPS[id]?.planRotate || 0;
    },

    defaultZ(id) {
      return PROPS[id]?.z ?? 0.0;
    },

    /** Top-down footprint in metres, clamped for visibility. */
    planSize,

    /** Top-down SVG shapes for the map marker (local +X = yaw direction). */
    planShapes(id) {
      const { len, wid } = planSize(id);
      return planShapes(PROPS[id]?.plan?.kind, len, wid, this.color(id));
    },

    /** An <svg> element for a palette tile: side-view silhouette. */
    tileIcon(id, size = 30) {
      const s = PROPS[id]?.side || { kind: 'box', w: 1, h: 1 };
      // Silhouettes stand on y=0 rising to -h, so a flat prop would otherwise
      // hug the tile floor and leave dead space above. Centre it instead.
      const long = Math.max(s.w, s.h);
      const k = (size * 0.86) / long;                 // fit the tile, keep aspect
      const drawnH = Math.max(s.h, long * MIN_SIDE_RATIO) * k;
      const svg = _el('svg', { viewBox: `${-size / 2} ${-size} ${size} ${size}` });
      const g = _el('g', {
        transform: `translate(0, ${(drawnH - size) / 2}) scale(${k})`,
      });
      sideShapes(s.kind, s.w, s.h, this.color(id)).forEach(el => g.appendChild(el));
      svg.appendChild(g);
      return svg;
    },

    /** Render the REQUISITEN tab body: group labels + one tile per prop. */
    renderPanel(container) {
      container.textContent = '';
      for (const group of GROUPS) {
        const ids = Object.keys(PROPS).filter(id => PROPS[id].group === group.id);
        if (!ids.length) continue;

        const heading = document.createElement('div');
        heading.className = 'toolbar-section-label';
        heading.textContent = group.label.toUpperCase();
        container.appendChild(heading);

        const grid = document.createElement('div');
        grid.className = 'tool-grid';
        for (const id of ids) {
          const btn = document.createElement('button');
          btn.className = 'tool-btn';
          btn.dataset.tool = 'prop';
          btn.dataset.prop = id;
          btn.title = `${PROPS[id].label} platzieren (${id})`;
          btn.appendChild(this.tileIcon(id));
          const span = document.createElement('span');
          span.textContent = PROPS[id].label;
          btn.appendChild(span);
          grid.appendChild(btn);
        }
        container.appendChild(grid);
      }

      const note = document.createElement('div');
      note.className = 'toolbar-note';
      note.textContent = 'Shift-Klick: an Fahrspur ausrichten';
      container.appendChild(note);
    },
  };

  window.PropCatalog = PropCatalog;
})();
