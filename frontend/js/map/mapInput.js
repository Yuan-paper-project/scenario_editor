/**
 * mapInput.js — undo/redo buttons, mouse pan, wheel zoom and the zoom buttons.
 *
 * Part of the map view (MapView); see mapView.js.
 */
(() => {
  'use strict';

  const {
    svg,
    ZOOM_STEP,
    ZOOM_STEP_COARSE,
    _clampZoom,
    view,
    drag,
    _applyTransform,
    svgToWorld,
    _clientToSvg,
    zoomBy,
    zoomToSelection,
    _updateTriggerPointDrag,
    _updateTriggerRadiusDrag,
  } = MapCore.shared;

  let _dragStart = null;
  let _panStart = null;
  let _panMoved = false;
  let _suppressNextClick = false;
  const _PAN_CLICK_THRESHOLD = 4;

  // ── Undo / redo ──────────────────────────────────────────────────────────────
  // One path for Strg+Z / Strg+Y and the header's two buttons.
  const _btnUndo = document.getElementById('btn-undo');
  const _btnRedo = document.getElementById('btn-redo');

  function _stepHistory(wantRedo) {
    const step = wantRedo ? UndoStack.redo() : UndoStack.undo();
    _refreshHistoryButtons();
    if (!step) {
      Toast.info(wantRedo ? 'Nichts zu wiederholen' : 'Nichts r\u00fcckg\u00e4ngig zu machen');
      return;
    }
    const verb = wantRedo ? 'Wiederholt' : 'R\u00fcckg\u00e4ngig';
    Toast.info(step.label ? `${verb}: ${step.label}` : verb);
  }

  // UndoStack emits nothing, but every push happens in an AppState mutator: re-read once per frame.
  let _historyRaf = 0;
  function _refreshHistoryButtons() {
    if (_historyRaf) return;
    _historyRaf = requestAnimationFrame(() => {
      _historyRaf = 0;
      if (_btnUndo) _btnUndo.disabled = !UndoStack.length;
      if (_btnRedo) _btnRedo.disabled = !UndoStack.redoLength;
    });
  }
  _btnUndo?.addEventListener('click', () => _stepHistory(false));
  _btnRedo?.addEventListener('click', () => _stepHistory(true));
  ['change', 'actorUpdated', 'actorRemoved', 'stateLoaded', 'selectionChanged', 'trafficSignalUpdated'].forEach((ev) =>
    AppState.on(ev, _refreshHistoryButtons),
  );

  // ── Mouse interaction ────────────────────────────────────────────────────────

  // Pan with left-drag on the background, not on markers.
  svg.addEventListener(
    'mousedown',
    (e) => {
      if (e.button !== 0) return;
      // During a preview nothing is draggable, so a grab on a marker pans too.
      if (
        !window.Simulate?.running &&
        (e.target.closest('.actor-group') ||
          e.target.closest('.yaw-arrow') ||
          e.target.closest('.trigger-radius-control') ||
          e.target.closest('.trigger-point-control') ||
          // Capture phase runs before objectsDrag.js's bubble handler, so markers must be excluded here.
          e.target.closest('.path-waypoint'))
      )
        return;

      drag.panning = true;
      _dragStart = { x: e.clientX, y: e.clientY };
      _panStart = { ...view.pan };
      _panMoved = false;
      svg.style.cursor = 'grabbing';
      e.preventDefault();
    },
    true,
  );

  window.addEventListener('mousemove', (e) => {
    if (drag.triggerPoint) {
      _updateTriggerPointDrag(e);
      return;
    }
    if (drag.triggerRadius) {
      _updateTriggerRadiusDrag(e);
      return;
    }
    if (!drag.panning) return;
    const dx = e.clientX - _dragStart.x;
    const dy = e.clientY - _dragStart.y;
    if (!_panMoved && Math.hypot(dx, dy) <= _PAN_CLICK_THRESHOLD) return;
    _panMoved = true;
    view.pan.x = _panStart.x + dx;
    view.pan.y = _panStart.y + dy;
    _applyTransform();
  });

  window.addEventListener('mouseup', () => {
    if (drag.triggerPoint) {
      const { actorId, eventId, moved } = drag.triggerPoint;
      drag.triggerPoint = null;
      if (moved) {
        ObjectsManager.moveTriggerPoint(actorId, eventId, moved.x, moved.y);
        // Expires on a timer: the marker is re-rendered mid-drag, so mouseup may dispatch no click
        // and a permanent flag would swallow an unrelated click later.
        _suppressNextClick = true;
        setTimeout(() => {
          _suppressNextClick = false;
        }, 50);
      }
      return;
    }
    if (drag.triggerRadius) {
      drag.triggerRadius = null;
      _suppressNextClick = true;
      return;
    }
    if (drag.panning) {
      if (_panMoved) _suppressNextClick = true;
      drag.panning = false;
      _panMoved = false;
      svg.style.cursor = '';
    }
  });

  svg.addEventListener(
    'click',
    (e) => {
      if (!_suppressNextClick) return;
      _suppressNextClick = false;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );

  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const step = e.shiftKey ? ZOOM_STEP_COARSE : ZOOM_STEP;
      const factor = e.deltaY < 0 ? step : 1 / step;
      const cursor = _clientToSvg(e);
      if (!cursor) return;

      // Keep the point under the cursor fixed; the pan comes from the CLAMPED zoom, or the map
      // keeps translating at the limits.
      const world = svgToWorld(e);
      view.zoom = _clampZoom(view.zoom * factor);
      view.pan.x = cursor.x - world.x * view.zoom;
      view.pan.y = cursor.y - world.y * view.zoom;

      _applyTransform();
    },
    { passive: false },
  );

  // ── Map view controls ──────────────────────────────────────────────────────
  // Buttons zoom about the view centre; the wheel zooms about the cursor.
  document.getElementById('btn-zoom-in')?.addEventListener('click', () => zoomBy(ZOOM_STEP_COARSE));
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => zoomBy(1 / ZOOM_STEP_COARSE));
  document.getElementById('btn-zoom-fit')?.addEventListener('click', () => {
    Toast.info(zoomToSelection() ? 'Auf Auswahl gezoomt' : 'Ansicht zur\u00fcckgesetzt');
  });

  MapCore.define({ _stepHistory });
})();
