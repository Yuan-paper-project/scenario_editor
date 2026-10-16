/**
 * objectsPaths.js — path drawing mode: the banner, starting and finishing a draw, adding a waypoint.
 *
 * Part of ObjectsManager; see objects.js.
 */
(() => {
  'use strict';

  const {
    svg,
    SPAWN_CLEARANCE,
    _roundZ,
    groundZAt,
    _routeWaypointAt,
    _findActor,
    _eventPath,
    _setEventPath,
    _warnUnsnapped,
  } = ObjectsCore.shared;

  const trajBanner = document.getElementById('traj-banner');
  const trajBannerText = document.getElementById('traj-banner-text');
  const trajDoneBtn = document.getElementById('traj-done-btn');
  const trajUndoBtn = document.getElementById('traj-undo-btn');

  // ── Path drawing mode ─────────────────────────────────────────────────────────

  // What the banner announces, so leaving the mode is detected here — Esc clears the flags
  // directly, so the incomplete-path check cannot hang off the button.
  let _drawContext = null; // { actorId, eventId, type }

  AppState.on('change', (patch) => {
    if (
      !('trajectoryMode' in patch) &&
      !('activeTrajectoryId' in patch) &&
      !('routeMode' in patch) &&
      !('activeRouteId' in patch) &&
      !('activePathEventId' in patch)
    )
      return;

    const pathId =
      (AppState.trajectoryMode && AppState.activeTrajectoryId) || (AppState.routeMode && AppState.activeRouteId);
    const next = pathId
      ? {
          actorId: pathId,
          eventId: AppState.activePathEventId,
          type: AppState.routeMode ? 'route' : 'trajectory',
        }
      : null;

    const left = _drawContext;
    _drawContext = next;
    if (left && !(next && next.actorId === left.actorId && next.eventId === left.eventId)) {
      _discardIncompletePath(left);
    }

    const active = !!next;
    trajBanner.classList.toggle('hidden', !active);
    svg.classList.toggle('trajectory-mode', active);
    if (!active) return;

    const actor = AppState.findById(next.actorId);
    const name = actor ? AppState.actorLabel(actor, { short: true }) : next.actorId;
    trajBannerText.innerHTML =
      `${next.type === 'route' ? 'Route' : 'Pfad'} für <strong></strong> zeichnen — auf die Karte klicken, ` +
      `um Wegpunkte zu setzen · <b>Enter</b> beendet`;
    trajBannerText.querySelector('strong').textContent = name;
  });

  /** Drop a path event left under 2 waypoints (the emitter would drop it); deleteEvent re-points chains. */
  function _discardIncompletePath(context) {
    const actor = _findActor(context.actorId);
    if (!actor) return;
    const ev = (actor.events || []).find((item) => item.id === context.eventId);
    if (!ev) return;
    const action = ev.action || {};
    const isRoute = action.type === 'assign_route';
    if (action.type !== 'follow_trajectory' && !isRoute) return;
    const points = isRoute ? action.waypoints || [] : action.trajectory || [];
    if (points.length >= 2) return;

    EventPanel.deleteEvent(actor, context.eventId);
    Toast.warn(
      isRoute
        ? 'Event verworfen — eine Route braucht mindestens 2 Wegpunkte'
        : 'Event verworfen — eine Trajektorie braucht mindestens 2 Wegpunkte',
    );
    MapView.renderAllActors();
  }

  // loadJSON clears the flags without a 'change', so reset the banner and context here (ids recur).
  AppState.on('stateLoaded', () => {
    _drawContext = null;
    trajBanner.classList.add('hidden');
    svg.classList.remove('trajectory-mode');
  });

  trajDoneBtn.addEventListener('click', () => {
    _finishPathMode();
  });

  // Enter finishes a path (Esc cancels, in mapKeys.js); here because the banner lives here.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (!AppState.trajectoryMode && !AppState.routeMode) return;
    // A dialog on top owns Enter, and so does a focused field.
    if (window.Confirm?.isOpen) return;
    const t = e.target.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
    e.preventDefault();
    _finishPathMode();
  });

  trajUndoBtn.addEventListener('click', () => {
    const type = AppState.routeMode ? 'route' : 'trajectory';
    const id = AppState.routeMode ? AppState.activeRouteId : AppState.activeTrajectoryId;
    const eventId = AppState.activePathEventId;
    if (!id) return;
    const actor = _findActor(id);
    const path = actor ? _eventPath(actor, eventId, type) : null;
    if (!path?.length) return;
    _setEventPath(actor, eventId, type, path.slice(0, -1));
  });

  function _finishPathMode() {
    AppState.set({
      trajectoryMode: false,
      activeTrajectoryId: null,
      routeMode: false,
      activeRouteId: null,
      activePathEventId: null,
    });
  }

  function startPathMode(actorId, type, eventId = null) {
    const actor = _findActor(actorId);
    if (!actor || !eventId) return;
    // Waypoint 1 is the actor's own pose and height, so the first click completes a 2-point path.
    let path = _eventPath(actor, eventId, type);
    if (!path || path.length === 0) {
      if (type === 'trajectory') {
        path = [{ x: actor.x, y: actor.y, z: actor.z ?? 0, velocity: 10.0 }];
      } else {
        // Snapped like every route waypoint: a typed or dragged pose need not be on a lane.
        const snap = _routeWaypointAt(actor.x, actor.y);
        path = [
          {
            x: snap.x,
            y: snap.y,
            z: snap.snapped ? snap.z : (actor.z ?? 0),
            strategy: 'fastest',
          },
        ];
      }
      _setEventPath(actor, eventId, type, path);
    }
    // Drawing un-hides the path (MapView.showPath flips the stored toggle).
    MapView.showPath(actorId, eventId, type);
    AppState.set({
      activeTool: null,
      pendingTemplate: null,
      trajectoryMode: type === 'trajectory',
      activeTrajectoryId: type === 'trajectory' ? actorId : null,
      routeMode: type === 'route',
      activeRouteId: type === 'route' ? actorId : null,
      activePathEventId: eventId,
    });
    MapView.renderAllActors();
  }

  function _addPathPoint(actorId, type, wx, wy, eventId = null, shortest = false) {
    const actor = _findActor(actorId);
    if (!actor) return;
    let path = _eventPath(actor, eventId, type);
    if (!path) path = [];
    let point;
    if (type === 'route') {
      // Shift places a 'shortest' waypoint, driven literally and so not snapped; a plain click
      // snaps, because a 'fastest' one is projected onto a lane by the planner anyway.
      if (shortest) {
        const x = Math.round(wx * 10) / 10;
        const y = Math.round(wy * 10) / 10;
        point = {
          x,
          y,
          z: _roundZ(groundZAt(x, y) + SPAWN_CLEARANCE.waypoint),
          strategy: 'shortest',
        };
      } else {
        const snap = _routeWaypointAt(wx, wy);
        if (!snap.snapped) _warnUnsnapped();
        point = { x: snap.x, y: snap.y, z: snap.z, strategy: 'fastest' };
      }
    } else {
      const x = Math.round(wx * 10) / 10;
      const y = Math.round(wy * 10) / 10;
      point = { x, y, z: _roundZ(groundZAt(x, y) + SPAWN_CLEARANCE.waypoint) };
    }
    if (type === 'trajectory') {
      point.velocity = path.length > 0 ? path[path.length - 1].velocity : 10.0;
    }
    // A new array: _eventPath returns the live one, and mutating it would make the patch a no-op to undo.
    _setEventPath(actor, eventId, type, [...path, point]);
  }

  ObjectsCore.define({
    startPathMode,
    _addPathPoint,
  });
})();
