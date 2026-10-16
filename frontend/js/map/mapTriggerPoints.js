/**
 * mapTriggerPoints.js — trigger-point markers and their point/radius drags.
 *
 * Part of the map view (MapView); see mapView.js.
 */
(() => {
  'use strict';

  const { layers, MAP_LABEL_M, drag, svgToWorld, _formatSvgNumber } = MapCore.shared;

  function _renderTriggerPoints() {
    if (!layers.triggerPoints) return;
    const actor = AppState.findById(AppState.selectedId);
    if (!actor) return;
    (actor.events || []).forEach((ev) => {
      const point = ev.trigger?.point;
      if (!point) return;
      const radius = Math.max(0, Number(ev.trigger?.value ?? 20));
      const g = UIUtils.svgEl('g', { class: 'trigger-point', transform: `translate(${point.x},${point.y})` });
      const ring = UIUtils.svgEl('circle', {
        cx: '0',
        cy: '0',
        r: _formatSvgNumber(radius),
        fill: 'rgba(0, 0, 0, 0.05)',
        stroke: '#808080',
        'stroke-width': '0.3',
        'stroke-dasharray': '1,1',
        class: 'trigger-radius-control trigger-radius-ring',
      });
      _attachTriggerRadiusDrag(ring, actor.id, ev.id, point);
      g.appendChild(ring);
      const marker = UIUtils.svgEl('g', { class: 'trigger-point-control' });
      // Invisible hit target: the 0.7 m marker is sub-pixel at town zoom.
      marker.appendChild(
        UIUtils.svgEl('circle', {
          cx: '0',
          cy: '0',
          r: '2.2',
          fill: 'transparent',
        }),
      );
      marker.appendChild(
        UIUtils.svgEl('circle', {
          cx: '0',
          cy: '0',
          r: '0.7',
          fill: '#ffffff00',
          stroke: '#ffffff',
          'stroke-width': '0.5',
        }),
      );
      _attachTriggerPointDrag(marker, actor.id, ev.id);
      g.appendChild(marker);
      const label = UIUtils.svgEl('text', {
        x: '0',
        y: '-4.5',
        'text-anchor': 'middle',
        'font-size': String(MAP_LABEL_M),
        class: 'map-label',
        fill: '#fff',
        style: 'pointer-events:none',
      });
      label.textContent = point.name || 'Point';
      g.appendChild(label);
      const handle = UIUtils.svgEl('rect', {
        x: _formatSvgNumber(radius - 0.7),
        y: '-0.7',
        width: '1.4',
        height: '1.4',
        fill: '#ffffff',
        stroke: '#808080',
        'stroke-width': '0.3',
        class: 'trigger-radius-control trigger-radius-handle',
      });
      _attachTriggerRadiusDrag(handle, actor.id, ev.id, point);
      g.appendChild(handle);
      layers.triggerPoints.appendChild(g);
    });
  }

  function _attachTriggerPointDrag(el, actorId, eventId) {
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || window.Simulate?.running) return;
      drag.triggerPoint = { actorId, eventId };
      e.preventDefault();
      e.stopPropagation();
    });
  }

  /** Live-move the point (x/y only); moveTriggerPoint re-derives z on mouseup, like an actor drag. */
  function _updateTriggerPointDrag(e) {
    const actor = AppState.findById(drag.triggerPoint.actorId);
    if (!actor) return;
    const world = svgToWorld(e);
    const x = Math.round(world.x * 10) / 10;
    const y = Math.round(world.y * 10) / 10;
    const events = (actor.events || []).map((ev) => {
      if (ev.id !== drag.triggerPoint.eventId || !ev.trigger?.point) return ev;
      return { ...ev, trigger: { ...ev.trigger, point: { ...ev.trigger.point, x, y } } };
    });
    drag.triggerPoint.moved = { x, y };
    AppState.updateById(actor.id, { events });
  }

  function _attachTriggerRadiusDrag(el, actorId, eventId, point) {
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || window.Simulate?.running) return;
      drag.triggerRadius = { actorId, eventId, point: { ...point } };
      e.preventDefault();
      e.stopPropagation();
    });
  }

  function _updateTriggerRadiusDrag(e) {
    const actor = AppState.findById(drag.triggerRadius.actorId);
    if (!actor) return;
    const world = svgToWorld(e);
    const p = drag.triggerRadius.point;
    const distance = Math.round(Math.hypot(world.x - p.x, world.y - p.y) * 10) / 10;
    const events = (actor.events || []).map((ev) => {
      if (ev.id !== drag.triggerRadius.eventId) return ev;
      return {
        ...ev,
        trigger: {
          ...ev.trigger,
          type: 'distance_to_point',
          value: distance,
        },
      };
    });
    AppState.updateById(actor.id, { events });
  }

  MapCore.define({ _renderTriggerPoints, _updateTriggerPointDrag, _updateTriggerRadiusDrag });
})();
