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

    // Nothing on the map is draggable while a tool is armed or a path is being
    // drawn: a click there means "place" or "select", never "edit this pose".
    // The rotate branch below used to lack this guard, so grabbing the handle
    // with a tool armed spun the actor while grabbing its body selected it.
    if (AppState.activeTool || AppState.trajectoryMode || AppState.routeMode) return;
    // Nor during a preview: it writes every actor's pose each tick, and Stop
    // puts the authored poses back — a drag here would be overwritten either
    // way. mapInput.js pans instead (see its pan-exclusion list).
    if (window.Simulate?.running) return;

    /* A path waypoint of the SELECTED actor: mark it, and drag it.
     *
     * Only the selected actor's waypoints are hit-testable at all (mapPaths.js
     * renders everyone else's with pointer-events: none), so this branch can
     * never steal a mousedown aimed at some other actor's path drawn across
     * the same stretch of road. The mark is set here rather than on click so
     * that a drag marks the point it is about to move.
     */
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

    /* Rotate: the yaw handle only.
     *
     * One class, no string-matching on `style` or `class*="arrow"` as this used
     * to do. `.yaw-handle` is placed a real gap outside the body's own hit
     * target (mapMarkers.js _buildYawArrow), so this branch and the body branch
     * below can never both match the same pixel.
     */
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
        // The cursor lives on <body> for the duration, not on the handle: every
        // updateById re-renders the actor layer, so the element the drag started
        // on is detached within a frame and :active never survives.
        document.body.classList.add('rotating');
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }

    // Move: the body.
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
          // Vehicles snap to a lane while dragged (Shift: free); walkers and
          // props move freely, as they are placed.
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
        // Always the same three keys, snapped or not: the undo entry coalesces
        // on id + patch keys, and an alternating key set would split one drag
        // into several entries.
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
      // Compute angle from actor centre to current mouse position
      const dx = world.x - _dragState.actorPos.x;
      const dy = world.y - _dragState.actorPos.y;
      // atan2 gives angle in radians; convert to degrees; SVG Y is flipped so Y is already correct
      const yaw = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
      AppState.updateById(_dragState.actorId, { yaw });
    }
  });

  window.addEventListener('mouseup', () => {
    if (_dragState) {
      // Re-derive the height for the position the object was dropped at. This
      // runs on mouseup rather than on every mousemove deliberately:
      // _nearestLaneProjection is a linear scan over every lane segment (~59k
      // points on Town03), so doing it per frame would make dragging stutter —
      // and z has no visual effect at all in a top-down 2D view.
      if (_dragState.type === 'actor') {
        const actor = AppState.findById(_dragState.actorId);
        if (actor) {
          // Not recorded: the drag's own undo entry was taken before the first
          // mousemove and already holds the pre-drag z. Left unsuspended this
          // would be a second entry — different patch keys, so it does not
          // coalesce — and one Strg+Z would put the height back without the
          // position.
          // A lane snap carries the height of the lane it snapped to, which is
          // the right one under an overpass where the nearest-in-2-D lane may not be.
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
      // Same deal for a dragged trajectory vertex: x/y tracked the cursor every
      // frame, the elevation lookup waited for the drop. A route waypoint needs
      // nothing here — its z came out of the lane snap on every move.
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
