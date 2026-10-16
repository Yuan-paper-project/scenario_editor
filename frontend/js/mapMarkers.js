/**
 * mapMarkers.js — actor and prop markers, their labels, selection marks and the rotate handle.
 *
 * Part of the map view (MapView); see mapView.js.
 */
(() => {
  'use strict';

  const { svg, layerProps, layerActors, layers, MAP_LABEL_M, _frameActor } = MapCore.shared;

  /**
   * Frame an actor, WITHOUT selecting it.
   *
   * This is the scene list's single click. Selecting instead would be the
   * obvious implementation and the wrong one: the overview panel that holds the
   * list is only rendered while nothing is selected, so selecting would close
   * the list on the first click and you could never walk down it. Selection is
   * the double click, which is a deliberate act.
   *
   * Flying the view is the whole feature — markers are drawn at true world size,
   * so at the town view an actor is a few pixels and no amount of highlighting
   * would find it for you.
   */
  function focusActor(id) {
    const actor = id ? AppState.findById(id) : null;
    if (!_frameActor(actor)) return false;
    glowActor(id);
    return true;
  }

  // Total life of the locate glow: brightens, holds ~0.5 s, then fades out.
  // Must match the actor-glow-fade keyframes, or the class outlives the
  // animation and leaves the object sitting bright.
  const GLOW_MS = 900;
  let _glowTimer = null;

  /**
   * Briefly brighten one map object — the "it is right here" cue the scene list
   * fires when a row locates something.
   *
   * It is the object's own body brightening, the same `filter` it gets when
   * hovered directly on the map; no ring, nothing added to the group at render
   * time. Deliberately tied to the *click*, not to hover: hovering a list to
   * read it should not set things flashing on the map.
   */
  function glowActor(id) {
    clearTimeout(_glowTimer);
    // Query off the <svg> and not off layerActors: the layers are null until a
    // map has been rendered, and a prop lives in a different layer entirely.
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

  /* Yaw-handle geometry (world metres).
   *
   * The rotate handle must never overlap the body, or a drag meant to MOVE the
   * object spins it instead — which is exactly what the old hand-tuned
   * `max(w, 4.5) * 0.8` did to every car (grab circle inner edge 2.1 m against a
   * 2.25 m half-length) and to every small prop (the r=1.5 circle swallowed the
   * marker whole). So the length is derived from the body's own hit radius
   * instead of guessed, and the invariant — handle inner edge = bodyRadius +
   * YAW_HANDLE_GAP, always positive — holds by construction for any size.
   *
   * The handle radius is capped at both ends: big enough to hit on a child or a
   * cone, never so big on a bus that it swings back over the roof. */
  const YAW_HANDLE_GAP = 0.6; // clear air between body edge and handle edge
  const YAW_HANDLE_R_MAX = 1.2; // grab radius of the rotate handle
  const YAW_HANDLE_R_MIN = 0.7;

  // Drawn as a circle rather than a rectangle. Mirrors _PEDESTRIAN_TYPES in
  // ../llm-scenario-gen's xml_builder, which decides the same split for the
  // exported entity — keep the two in step.
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
      // Walker: filled circle. A rectangle plus windshield would read as a
      // very small car, which is exactly the wrong thing for a child.
      const c = UIUtils.svgEl('circle', { r: size.w / 2, fill: col.body, class: 'actor-body' });
      g.appendChild(c);
    } else {
      // Vehicle: rectangle with windshield highlight
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
      // Windshield (front-right highlight)
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

    // Selection marks, framing what is actually drawn: a walker is a circle of
    // diameter size.w, so its box is square rather than size.w × size.h.
    g.appendChild(_buildSelectionMarks(size.w, WALKER_TYPES.has(actor.type) ? size.w : size.h));

    // Label. `.map-label` is what _updateLabelVisibility hides below the
    // legibility floor; `.actor-label` carries nothing but this one's styling.
    g.appendChild(
      _uprightLabel(_actorMapLabel(actor), actor.yaw, Math.max(size.w, size.h) / 2 + 1.2, 'map-label actor-label'),
    );

    // Yaw arrow (vehicles and pedestrians — not static objects). The radius
    // passed is the marker's own, so the rotate handle lands outside it.
    g.appendChild(_buildYawArrow(actor, col.body, Math.max(size.w, size.h) / 2));

    // The selected actor goes in the top layer, above its own path — the
    // vehicle you are working on is never buried under anything.
    (sel && layers.actorsTop ? layers.actorsTop : layerActors).appendChild(g);
  }

  /* Static props. Shares the .actor-group class so selection, body dragging and
   * the pan-exclusion list all apply without duplicating that wiring; the extra
   * .prop-group class is there for prop-specific styling.
   *
   * The marker is a TOP-DOWN footprint, matching the rest of the map — roads,
   * lane markings and the vehicle rectangles in _renderActor are all plan view,
   * and like those it rotates with yaw. (The palette tiles use side-view
   * silhouettes instead; see PropCatalog.) Footprints are clamped to a floor by
   * PropCatalog.planSize() — a 0.4 m cone is otherwise invisible on a map
   * spanning hundreds of metres.
   */
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

    // Some meshes are not centred on their pivot (the container sits 1.1 m to
    // one side of it), so the body, its grab target and its selection marks
    // are drawn shifted by the catalogue's measured offset. The group itself
    // stays on the pivot — that is the exported position and the point the
    // prop rotates about, which is why the yaw arrow is left outside.
    const off = cat.planOffset(prop.prop);
    const meshG = off.x || off.y ? UIUtils.svgEl('g', { transform: `translate(${off.x},${off.y})` }) : g;

    // Invisible grab target: a real cone is ~4 px wide at default zoom, too
    // small to click or drag reliably. Same trick as the yaw-arrow handle.
    // Named, because the yaw handle is placed clear of exactly this circle.
    const grabR = Math.max(size * 0.6, 1.2);
    meshG.appendChild(UIUtils.svgEl('circle', { r: grabR, fill: 'transparent' }));

    // planRotate is cosmetic: for props whose yaw means "the way the face
    // points", the body sits ACROSS that direction (a barrier blocks the lane
    // rather than lying along it). Applied to the body alone, so the selection
    // ring, hit target and yaw arrow all still track the true facing.
    const spin = cat.planRotate(prop.prop);
    const body = UIUtils.svgEl('g', {
      class: 'actor-body',
      ...(spin ? { transform: `rotate(${spin})` } : {}),
    });
    cat.planShapes(prop.prop).forEach((s) => body.appendChild(s));
    meshG.appendChild(body);

    // The body is drawn spun by planRotate, which swaps its extent — frame what
    // is on screen, not the catalogue's unrotated footprint.
    const spun = Math.abs(spin % 180) === 90;
    meshG.appendChild(_buildSelectionMarks(spun ? fp.wid : fp.len, spun ? fp.len : fp.wid));
    if (meshG !== g) g.appendChild(meshG);

    // Label only while selected: props are placed in runs (a six-cone taper),
    // and one label per cone buries the glyphs it is meant to annotate.
    if (sel) {
      g.appendChild(_uprightLabel(_actorMapLabel(prop), prop.yaw, size / 2 + 1.0, 'map-label'));
    }

    // Only oriented props get a yaw handle — a cone or barrel has no heading.
    if (cat.oriented(prop.prop)) {
      g.appendChild(_buildYawArrow(prop, color, grabR));
    }

    layerProps.appendChild(g);
  }

  function _actorMapLabel(actor) {
    return AppState.actorLabel(actor, { short: true });
  }

  /* An object's name, drawn inside its rotated group but counter-rotated so it
   * always reads horizontally — it used to turn with the vehicle, so anything
   * driving north–south was labelled sideways or upside down. It goes on the
   * screen side the yaw arrow is NOT on (below when the nose points up), so
   * the two never overlap; `gap` is the distance from the pivot to the near
   * edge of the text, independent of the (zoom-capped) font size thanks to the
   * baseline choice. */
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

  /* The selection mark: four corner brackets on the object's own box.
   *
   * Deliberately not a ring any more. A yellow circle competed with the map's
   * own furniture — lane paint is yellow, the ruler is `#ffee55`, a bus body is
   * `#ddaa00` — so around a bus on a painted road it was ambiguous what it even
   * marked; and being one radius it could say "something here" but never what,
   * giving a 9 m bus and a 0.9 m cone the same circle. It also drew straight
   * through the actor's own label. Crop marks are a shape a road map never
   * draws, they frame the object instead of covering it, and they stay
   * readable at any size.
   *
   * `w`/`h` are the DRAWN extent in the object's own rotated frame, so the
   * marks turn with it and read as an oriented bounding box. Black over a white
   * casing rather than a single accent colour: the map runs from a `#e8edf2`
   * verge to a near-black carriageway, and only the casing carries both.
   *
   * The stroke is `non-scaling-stroke` (see `.sel-mark-*` in mapMarkers.css), so the
   * corners follow the box while the line keeps its width on screen. That is
   * what keeps a cone legible — a scaled 2 px line goes sub-pixel long before
   * the object it frames does.
   */
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
    // Every casing first, then every line — one path drawn twice, so no corner
    // can end up with its casing painted over the neighbouring corner's line.
    for (const cls of ['sel-mark-casing', 'sel-mark-line']) {
      for (const d of corners) g.appendChild(UIUtils.svgEl('path', { d, class: cls }));
    }
    return g;
  }

  /* The rotate handle.
   *
   * `bodyRadius` is the radius of the caller's OWN hit target — half the marker
   * for an actor, the invisible grab circle for a prop — and everything here is
   * placed outside it. That is the whole point: drag and rotate are two disjoint
   * zones, and the gap between them is real, empty map. The shaft is decoration
   * only (`.yaw-shaft` is pointer-events:none in CSS) and starts at the body's
   * edge rather than at its centre, where it used to hit-test as "rotate" right
   * across the marker.
   *
   * `.yaw-handle` is the one selector objects.js's mousedown looks for; the
   * ring draws that same circle on hover so the zone is visible before you
   * commit to a drag.
   */
  function _buildYawArrow(actor, color, bodyRadius) {
    const handleR = Math.min(YAW_HANDLE_R_MAX, Math.max(YAW_HANDLE_R_MIN, bodyRadius));
    const arrowLen = bodyRadius + YAW_HANDLE_GAP + handleR;
    const headLen = Math.min(1.2, handleR);

    // Arrow group: drawn in local (rotated) coords of the actor
    // so the arrow always points in the actor's heading direction (+X axis = forward)
    const ag = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    ag.setAttribute('class', 'yaw-arrow');
    ag.setAttribute('data-actor-id', actor.id);

    // Shaft — decoration, never a hit target (see .yaw-shaft in mapMarkers.css)
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

    // Arrowhead: the direction cue, and part of the handle. Scaled with the
    // handle so it stays clear of the body on a 0.6 m child too.
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

    // Invisible hit area, last so it sits on top of the drawn parts.
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
