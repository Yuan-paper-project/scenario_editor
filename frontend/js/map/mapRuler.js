/**
 * mapRuler.js — the distance ruler tool.
 *
 * Part of the map view (MapView); see mapView.js.
 */
(() => {
  'use strict';

  const { svg, worldGroup, drag, svgToWorld } = MapCore.shared;

  // ── Ruler (measure distance) ────────────────────────────────────────────────

  let _rulerStart = null; // {x, y} world coords
  let _rulerEnd = null;
  let _rulerGroup = null; // SVG group for ruler graphics
  let _rulerPinned = []; // Array of pinned measurements [{x1,y1,x2,y2,dist}]

  function _ensureRulerLayer() {
    if (!_rulerGroup) {
      _rulerGroup = UIUtils.svgEl('g', { id: 'layer-ruler' });
      worldGroup.appendChild(_rulerGroup);
    }
  }

  function _renderRulerLine(x1, y1, x2, y2, pinned) {
    const dist = Math.hypot(x2 - x1, y2 - y1);
    const mx = (x1 + x2) / 2,
      my = (y1 + y2) / 2;
    const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    const color = pinned ? '#ffcc00' : '#ffee55';

    const g = UIUtils.svgEl('g', { class: 'ruler-measurement' });

    // Main line
    g.appendChild(
      UIUtils.svgEl('line', {
        x1,
        y1,
        x2,
        y2,
        stroke: color,
        'stroke-width': '0.6',
        'stroke-dasharray': '2,1.5',
        opacity: pinned ? '0.8' : '1',
      }),
    );

    // End markers (small crosshairs)
    for (const [px, py] of [
      [x1, y1],
      [x2, y2],
    ]) {
      g.appendChild(
        UIUtils.svgEl('circle', {
          cx: px,
          cy: py,
          r: '1.2',
          fill: 'none',
          stroke: color,
          'stroke-width': '0.4',
        }),
      );
      g.appendChild(
        UIUtils.svgEl('circle', {
          cx: px,
          cy: py,
          r: '0.4',
          fill: color,
        }),
      );
    }

    // Distance label background
    const labelFontSize = 2.5;
    const textLen = dist.toFixed(1).length + 2; // "+ m"
    const bgW = textLen * labelFontSize * 0.65;
    const bgH = labelFontSize * 1.6;
    g.appendChild(
      UIUtils.svgEl('rect', {
        x: mx - bgW / 2,
        y: my - bgH / 2 - labelFontSize * 0.3,
        width: bgW,
        height: bgH,
        rx: '0.8',
        fill: 'rgba(0,0,0,0.75)',
        stroke: color,
        'stroke-width': '0.3',
      }),
    );

    // Distance label text
    const label = UIUtils.svgEl('text', {
      x: mx,
      y: my + labelFontSize * 0.3,
      'text-anchor': 'middle',
      'font-size': labelFontSize,
      fill: color,
      'font-weight': 'bold',
      style: 'pointer-events:none',
    });
    label.textContent = `${dist.toFixed(1)} m`;
    g.appendChild(label);

    // Remove button for pinned rulers
    if (pinned) {
      const delBtn = UIUtils.svgEl('circle', {
        cx: x2,
        cy: y2 - 2.5,
        r: '1.5',
        fill: '#cc3333',
        stroke: '#fff',
        'stroke-width': '0.3',
        style: 'cursor:pointer',
        class: 'ruler-delete',
      });
      g.appendChild(delBtn);
      const delX = UIUtils.svgEl('text', {
        x: x2,
        y: y2 - 2.0,
        'text-anchor': 'middle',
        'font-size': '2',
        fill: '#fff',
        'font-weight': 'bold',
        style: 'pointer-events:none',
      });
      delX.textContent = '\u00d7';
      g.appendChild(delX);
    }

    return g;
  }

  function _redrawRuler() {
    _ensureRulerLayer();
    while (_rulerGroup.firstChild) _rulerGroup.removeChild(_rulerGroup.firstChild);

    // Pinned measurements
    _rulerPinned.forEach((r, idx) => {
      const g = _renderRulerLine(r.x1, r.y1, r.x2, r.y2, true);
      g.dataset.rulerIdx = idx;
      // Click handler on delete button
      g.querySelector('.ruler-delete')?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        _rulerPinned.splice(idx, 1);
        _redrawRuler();
      });
      _rulerGroup.appendChild(g);
    });

    // Active measurement (being drawn)
    if (_rulerStart && _rulerEnd) {
      _rulerGroup.appendChild(_renderRulerLine(_rulerStart.x, _rulerStart.y, _rulerEnd.x, _rulerEnd.y, false));
    }
  }

  function _clearAllRulers() {
    _rulerPinned = [];
    _rulerStart = null;
    _rulerEnd = null;
    _redrawRuler();
  }

  // Ruler interactions — handled via the tool system
  // When ruler tool is active:
  //   - First click: set start point
  //   - Mouse move: preview line with live distance
  //   - Second click: pin the measurement and start a new one
  //   - Escape / tool change: cancel current measurement

  svg.addEventListener(
    'click',
    (e) => {
      if (AppState.activeTool !== 'ruler') return;
      if (e.defaultPrevented) return;

      const world = svgToWorld(e);
      e.preventDefault();
      e.stopPropagation();

      if (!_rulerStart) {
        // First click — set start
        _rulerStart = { x: world.x, y: world.y };
        _rulerEnd = null;
      } else {
        // Second click — pin the measurement
        _rulerPinned.push({
          x1: _rulerStart.x,
          y1: _rulerStart.y,
          x2: world.x,
          y2: world.y,
          dist: Math.hypot(world.x - _rulerStart.x, world.y - _rulerStart.y),
        });
        _rulerStart = null;
        _rulerEnd = null;
        _redrawRuler();
      }
    },
    true,
  ); // capture phase so it fires before the objects.js click handler

  svg.addEventListener('mousemove', (e) => {
    if (AppState.activeTool !== 'ruler' || !_rulerStart || drag.panning) return;
    const world = svgToWorld(e);
    _rulerEnd = { x: world.x, y: world.y };
    _redrawRuler();
  });

  // Cancel ruler on tool change
  AppState.on('change', (patch) => {
    if ('activeTool' in patch) {
      if (AppState.activeTool !== 'ruler') {
        _rulerStart = null;
        _rulerEnd = null;
        _redrawRuler();
      }
    }
  });

  MapCore.define({ _clearAllRulers });
})();
