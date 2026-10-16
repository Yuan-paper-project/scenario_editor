/**
 * mapMarkers.js — actor and prop markers, their labels, selection marks and the rotate handle.
 *
 * Part of the map view (MapView); see mapView.js.
 */
(() => {
  'use strict';

  const { svg, layerProps, layerActors, layers, MAP_LABEL_M, _frameActor } = MapCore.shared;

  /** Frame an actor without selecting it (the scene list's click: selecting would close the list). */
  function focusActor(id) {
    const actor = id ? AppState.findById(id) : null;
    if (!_frameActor(actor)) return false;
    glowActor(id);
    return true;
  }

  // Must match the actor-glow-fade keyframes, or the class outlives the animation.
  const GLOW_MS = 900;
  let _glowTimer = null;

  /** Briefly brighten one object's own body (the hover filter): the scene list's locate cue. */
  function glowActor(id) {
    clearTimeout(_glowTimer);
    // Off the <svg>: the layers are null before a render, and props live elsewhere.
    svg.querySelectorAll('.actor-glow').forEach((el) => el.classList.remove('actor-glow'));
    if (!id) return;
    const g = svg.querySelector(`.actor-group[data-id="${CSS.escape(String(id))}"]`);
    if (!g) return;
    g.getBoundingClientRect(); // reflow, so re-locating the same object replays it
    g.classList.add('actor-glow');
    _glowTimer = setTimeout(() => g.classList.remove('actor-glow'), GLOW_MS);
  }

  // ── Actor rendering ──────────────────────────────────────────────────────────

  const ACTOR_COLORS = {
    ego: { body: '#4488ff', text: '#fff' },
    car: { body: '#ff9933', text: '#222' },
    van: { body: '#8899aa', text: '#222' },
    truck: { body: '#cc5522', text: '#fff' },
    bus: { body: '#ddaa00', text: '#222' },
    motorcycle: { body: '#ff7755', text: '#fff' },
    scooter: { body: '#b8d600', text: '#222' },
    police: { body: '#223f9e', text: '#fff' },
    ambulance: { body: '#f0f4f8', text: '#222' },
    firetruck: { body: '#c62828', text: '#fff' },
    pedestrian: { body: '#cc66cc', text: '#fff' },
    child: { body: '#e69ae6', text: '#222' },
    cyclist: { body: '#33bb88', text: '#fff' },
  };

  const ACTOR_SIZES = {
    ego: { w: 4.5, h: 2.1 },
    car: { w: 4.5, h: 2.1 },
    van: { w: 5.8, h: 2.2 },
    truck: { w: 7.0, h: 2.6 },
    bus: { w: 9.0, h: 2.8 },
    motorcycle: { w: 2.2, h: 1.0 },
    scooter: { w: 1.7, h: 0.8 },
    police: { w: 5.0, h: 2.1 },
    ambulance: { w: 6.0, h: 2.4 },
    firetruck: { w: 8.5, h: 2.8 },
    pedestrian: { w: 1.0, h: 1.0 },
    child: { w: 0.6, h: 0.6 },
    cyclist: { w: 2.0, h: 0.8 },
  };

  /* Yaw handle geometry (world m). Its length derives from the body's hit radius, so the
   * handle never overlaps the body at any size; the radius is capped both ways. */
  const YAW_HANDLE_GAP = 0.6; // clear air between body edge and handle edge
  const YAW_HANDLE_R_MAX = 1.2; // grab radius of the rotate handle
  const YAW_HANDLE_R_MIN = 0.7;

  // Drawn as circles; mirrors xml_builder._PEDESTRIAN_TYPES.
  const WALKER_TYPES = new Set(['pedestrian', 'child']);

  function _renderActor(actor) {
    const col = ACTOR_COLORS[actor.type] || ACTOR_COLORS.car;
    // The ego keeps its own colour but takes its vehicle type's footprint.
    const size = ACTOR_SIZES[AppState.bodyType(actor)] || ACTOR_SIZES.car;
    const sel = AppState.selectedId === actor.id;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', `actor-group${sel ? ' actor-selected' : ''}`);
    g.setAttribute('data-id', actor.id);
    g.setAttribute('transform', `translate(${actor.x},${actor.y}) rotate(${actor.yaw || 0})`);

    if (WALKER_TYPES.has(actor.type)) {
      // A walker is a circle: a tiny rectangle would read as a small car.
      const c = UIUtils.svgEl('circle', { r: size.w / 2, fill: col.body, class: 'actor-body' });
      g.appendChild(c);
    } else {
      const rect = UIUtils.svgEl('rect', {
        x: -size.w / 2,
        y: -size.h / 2,
        width: size.w,
        height: size.h,
        rx: 0.4,
        fill: col.body,
        class: 'actor-body',
      });
      g.appendChild(rect);
      const ws = UIUtils.svgEl('rect', {
        x: size.w / 2 - 1.4,
        y: -size.h / 2 + 0.2,
        width: 1.2,
        height: size.h - 0.4,
        rx: 0.2,
        fill: 'rgba(200,230,255,0.4)',
      });
      g.appendChild(ws);
    }

    // Frame what is drawn: a walker's box is square.
    g.appendChild(_buildSelectionMarks(size.w, WALKER_TYPES.has(actor.type) ? size.w : size.h));

    g.appendChild(
      _uprightLabel(_actorMapLabel(actor), actor.yaw, Math.max(size.w, size.h) / 2 + 1.2, 'map-label actor-label'),
    );

    // The marker's own radius, so the rotate handle lands outside it.
    g.appendChild(_buildYawArrow(actor, col.body, Math.max(size.w, size.h) / 2));

    // The selected actor goes on top, above its own path.
    (sel && layers.actorsTop ? layers.actorsTop : layerActors).appendChild(g);
  }

  /* A prop's plan-view footprint, rotating with yaw; .actor-group gives it selection,
   * dragging and pan exclusion. Small footprints are clamped up (PropCatalog.planSize). */
  function _renderProp(prop) {
    if (!layerProps) return;
    const cat = window.PropCatalog;
    if (!cat) return;

    const color = cat.color(prop.prop);
    const fp = cat.planSize(prop.prop);
    const size = Math.max(fp.len, fp.wid);
    const sel = AppState.selectedId === prop.id;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', `actor-group prop-group${sel ? ' actor-selected' : ''}`);
    g.setAttribute('data-id', prop.id);
    g.setAttribute('transform', `translate(${prop.x},${prop.y}) rotate(${prop.yaw || 0})`);

    // Off-pivot meshes are drawn shifted by the measured offset; the group stays on the pivot.
    const off = cat.planOffset(prop.prop);
    const meshG = off.x || off.y ? UIUtils.svgEl('g', { transform: `translate(${off.x},${off.y})` }) : g;

    // Invisible grab target (a cone is a few px); the yaw handle is placed clear of it.
    const grabR = Math.max(size * 0.6, 1.2);
    meshG.appendChild(UIUtils.svgEl('circle', { r: grabR, fill: 'transparent' }));

    // planRotate is cosmetic and on the body only: e.g. a barrier lies across its facing.
    const spin = cat.planRotate(prop.prop);
    const body = UIUtils.svgEl('g', {
      class: 'actor-body',
      ...(spin ? { transform: `rotate(${spin})` } : {}),
    });
    cat.planShapes(prop.prop).forEach((s) => body.appendChild(s));
    meshG.appendChild(body);

    // planRotate ±90 swaps the drawn extent.
    const spun = Math.abs(spin % 180) === 90;
    meshG.appendChild(_buildSelectionMarks(spun ? fp.wid : fp.len, spun ? fp.len : fp.wid));
    if (meshG !== g) g.appendChild(meshG);

    // Label only while selected: one label per cone buries a taper.
    if (sel) {
      g.appendChild(_uprightLabel(_actorMapLabel(prop), prop.yaw, size / 2 + 1.0, 'map-label'));
    }

    if (cat.oriented(prop.prop)) {
      g.appendChild(_buildYawArrow(prop, color, grabR));
    }

    layerProps.appendChild(g);
  }

  function _actorMapLabel(actor) {
    return AppState.actorLabel(actor, { short: true });
  }

  /* An object's name, counter-rotated to read horizontally, on the side the yaw arrow is
   * not on; `gap` is pivot to the text's near edge. */
  function _uprightLabel(text, yaw, gap, cls) {
    const deg = yaw || 0;
    const below = Math.sin((deg * Math.PI) / 180) < -0.2;
    const wrap = UIUtils.svgEl('g', { transform: `rotate(${-deg})`, style: 'pointer-events:none' });
    const label = UIUtils.svgEl('text', {
      x: 0,
      y: below ? gap : -gap,
      'text-anchor': 'middle',
      'font-size': String(MAP_LABEL_M),
      'dominant-baseline': below ? 'hanging' : 'auto',
      class: cls,
      fill: '#fff',
    });
    label.textContent = text;
    wrap.appendChild(label);
    return wrap;
  }

  /* Selection: four corner marks on the drawn box (`w`/`h` in the object's own frame).
   * Black over a white casing survives verge and asphalt; the stroke is non-scaling. */
  const SEL_PAD_MIN = 0.6; // world m of air between the body and the mark
  const SEL_PAD_FRAC = 0.18; // …or this much of the box, whichever is larger
  const SEL_ARM_FRAC = 0.3; // corner arm, as a fraction of its own side
  const SEL_ARM_MAX = 1.6; // world m — a long arm on a bus is just a box

  function _buildSelectionMarks(w, h) {
    const pad = Math.max(SEL_PAD_MIN, Math.max(w, h) * SEL_PAD_FRAC);
    const x = w / 2 + pad,
      y = h / 2 + pad;
    const ax = Math.min(2 * x * SEL_ARM_FRAC, SEL_ARM_MAX);
    const ay = Math.min(2 * y * SEL_ARM_FRAC, SEL_ARM_MAX);
    const corners = [
      `M${-x},${-y + ay} L${-x},${-y} L${-x + ax},${-y}`,
      `M${x - ax},${-y} L${x},${-y} L${x},${-y + ay}`,
      `M${x},${y - ay} L${x},${y} L${x - ax},${y}`,
      `M${-x + ax},${y} L${-x},${y} L${-x},${y - ay}`,
    ];
    const g = UIUtils.svgEl('g', { class: 'actor-select-marks' });
    // All casings before all lines, so no casing covers a neighbouring corner's line.
    for (const cls of ['sel-mark-casing', 'sel-mark-line']) {
      for (const d of corners) g.appendChild(UIUtils.svgEl('path', { d, class: cls }));
    }
    return g;
  }

  /* The rotate handle, placed wholly outside `bodyRadius` (the caller's own hit target),
   * so drag and rotate never overlap. Only `.yaw-handle` is hit-tested. */
  function _buildYawArrow(actor, color, bodyRadius) {
    const handleR = Math.min(YAW_HANDLE_R_MAX, Math.max(YAW_HANDLE_R_MIN, bodyRadius));
    const arrowLen = bodyRadius + YAW_HANDLE_GAP + handleR;
    const headLen = Math.min(1.2, handleR);

    // In the actor's rotated frame: +X is forward.
    const ag = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    ag.setAttribute('class', 'yaw-arrow');
    ag.setAttribute('data-actor-id', actor.id);

    const line = UIUtils.svgEl('line', {
      x1: bodyRadius,
      y1: 0,
      x2: arrowLen,
      y2: 0,
      stroke: color,
      'stroke-width': 0.5,
      'stroke-opacity': 0.9,
      class: 'yaw-shaft',
    });
    ag.appendChild(line);

    // Scaled with the handle, so it clears the body on a child too.
    const head = UIUtils.svgEl('polygon', {
      points: `${arrowLen},0 ${arrowLen - headLen},${-headLen / 2} ${arrowLen - headLen},${headLen / 2}`,
      fill: color,
      class: 'arrow-head yaw-handle',
      'data-actor-id': actor.id,
    });
    ag.appendChild(head);

    // Boundary of the grab zone, shown on hover only.
    ag.appendChild(
      UIUtils.svgEl('circle', {
        cx: arrowLen,
        cy: 0,
        r: handleR,
        fill: 'none',
        stroke: color,
        'stroke-width': 0.15,
        class: 'yaw-handle-ring',
      }),
    );

    // Invisible hit area, last so it is on top.
    ag.appendChild(
      UIUtils.svgEl('circle', {
        cx: arrowLen,
        cy: 0,
        r: handleR,
        fill: 'transparent',
        'data-actor-id': actor.id,
        class: 'yaw-handle',
      }),
    );

    return ag;
  }

  MapCore.define({
    focusActor,
    GLOW_MS,
    glowActor,
    ACTOR_COLORS,
    ACTOR_SIZES,
    WALKER_TYPES,
    _renderActor,
    _renderProp,
    _buildSelectionMarks,
  });
})();
