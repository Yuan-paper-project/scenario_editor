/**
 * objectsDrag.js — dragging an actor, a prop, its yaw handle or a path waypoint.
 *
 * Part of ObjectsManager; see objects.js.
 */
(() => {
  'use strict';

  const {
    svg,
    drag,
    ROAD_FACING_TYPES,
    _vehicleLaneSnap,
    _clearanceFor,
    _roundZ,
    _surfaceZFor,
    _findActor,
    _eventPath,
  } = ObjectsCore.shared;

  // ── Drag state ───────────────────────────────────────────────────────────────
  let _dragState = null; // { type: 'actor'|'yaw'|'waypoint', actorId, ... }
  // ── Drag actors ───────────────────────────────────────────────────────────────

  svg.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;

    // Nothing is draggable while a tool is armed or a path is drawn: a click then places or selects.
    if (AppState.activeTool || AppState.trajectoryMode || AppState.routeMode) return;
    // Nor during a preview, which owns every pose (mapInput.js pans instead).
    if (window.Simulate?.running) return;

    /* A waypoint of the selected actor (the only hit-testable ones): marked on mousedown,
     * so a drag marks the point it moves. */
    const wpEl = e.target.closest('.path-waypoint');
    if (wpEl) {
      const actorId = wpEl.dataset.actorId;
      const eventId = wpEl.dataset.eventId;
      const pathType = wpEl.dataset.pathType;
      const index = Number(wpEl.dataset.wpIdx);
      if (actorId === AppState.selectedId && Number.isFinite(index)) {
        AppState.selectWaypoint({ actorId, eventId, pathType, index });
        _dragState = { type: 'waypoint', actorId, eventId, pathType, index };
        document.body.classList.add('dragging-actor');
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }

    /* Rotate: only `.yaw-handle`, which never overlaps the body's hit target. */
    const handle = e.target.closest('.yaw-handle');
    if (handle) {
      const actorId = handle.dataset.actorId || handle.closest('[data-actor-id]')?.dataset?.actorId;
      const actor = actorId ? AppState.findById(actorId) : null;
      if (actor) {
        _dragState = {
          type: 'yaw',
          actorId,
          actorPos: { x: actor.x, y: actor.y },
        };
        // The cursor goes on <body>: the handle is re-rendered within a frame, so :active never holds.
        document.body.classList.add('rotating');
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }

    const actorGroup = e.target.closest('.actor-group');
    if (actorGroup) {
      const id = actorGroup.dataset.id;
      const actor = AppState.findById(id);
      const world = MapView.svgToWorld(e);
      if (actor) {
        _dragState = {
          type: 'actor',
          actorId: id,
          startWorld: { ...world },
          startActorPos: { x: actor.x, y: actor.y },
          // Vehicles snap while dragged (Shift: free); walkers and props never.
          laneSnap: actor.type !== 'prop' && !ROAD_FACING_TYPES.has(actor.type),
          snap: null,
        };
        AppState.select(id);
        document.body.classList.add('dragging-actor');
        e.preventDefault();
        e.stopPropagation();
      }
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (!_dragState) return;
    drag.wasDragging = true;

    const world = MapView.svgToWorld(e);

    if (_dragState.type === 'actor') {
      const dx = world.x - _dragState.startWorld.x;
      const dy = world.y - _dragState.startWorld.y;
      const x = Math.round((_dragState.startActorPos.x + dx) * 10) / 10;
      const y = Math.round((_dragState.startActorPos.y + dy) * 10) / 10;
      if (!_dragState.laneSnap) {
        AppState.updateById(_dragState.actorId, { x, y });
      } else {
        const actor = AppState.findById(_dragState.actorId);
        const snap = e.shiftKey ? null : _vehicleLaneSnap(x, y, actor?.yaw);
        _dragState.snap = snap;
        // Always the same three keys, snapped or not, so the drag coalesces into one undo entry.
        AppState.updateById(
          _dragState.actorId,
          snap ? { x: snap.x, y: snap.y, yaw: snap.yaw } : { x, y, yaw: actor?.yaw ?? 0 },
        );
      }
    } else if (_dragState.type === 'waypoint') {
      ObjectsManager.movePathPoint(
        _dragState.actorId,
        _dragState.pathType,
        _dragState.index,
        world.x,
        world.y,
        _dragState.eventId,
      );
    } else if (_dragState.type === 'yaw') {
      const dx = world.x - _dragState.actorPos.x;
      const dy = world.y - _dragState.actorPos.y;
      // CARLA's frame is y-down like SVG, so atan2 gives the yaw directly.
      const yaw = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
      AppState.updateById(_dragState.actorId, { yaw });
    }
  });

  window.addEventListener('mouseup', () => {
    if (_dragState) {
      // Height for the drop point, on mouseup only: the lookup scans every lane segment.
      if (_dragState.type === 'actor') {
        const actor = AppState.findById(_dragState.actorId);
        if (actor) {
          // Unrecorded: the drag's entry already holds the old z. A lane snap carries its own
          // lane's height, right under an overpass where nearest-in-2-D may not be.
          const snap = _dragState.snap;
          UndoStack.suspend();
          AppState.updateById(actor.id, {
            z: snap
              ? _roundZ(snap.z + _clearanceFor(actor.type))
              : _surfaceZFor(actor.type, actor.x, actor.y, actor.prop),
          });
          UndoStack.resume();
        }
      }
      // Likewise a trajectory vertex; a route point's z came from the snap on every move.
      if (_dragState.type === 'waypoint' && _dragState.pathType !== 'route') {
        const actor = _findActor(_dragState.actorId);
        const path = actor ? _eventPath(actor, _dragState.eventId, _dragState.pathType) : null;
        const pt = path?.[_dragState.index];
        if (pt) {
          UndoStack.suspend();
          ObjectsManager.movePathPoint(
            _dragState.actorId,
            _dragState.pathType,
            _dragState.index,
            pt.x,
            pt.y,
            _dragState.eventId,
            true,
          );
          UndoStack.resume();
        }
      }
      _dragState = null;
      document.body.classList.remove('rotating', 'dragging-actor');
      setTimeout(() => {
        drag.wasDragging = false;
      }, 50);
    }
  });
})();
