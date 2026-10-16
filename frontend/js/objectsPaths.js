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

  // What the banner is currently announcing, so leaving a mode can be detected
  // and acted on. A path event that never got 2 waypoints is discarded here
  // rather than in _finishPathMode(): Esc clears the mode flags directly
  // (mapKeys.js), so hanging the check off the *button* would miss it.
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

  /**
   * Drop a path event that was left with fewer than 2 waypoints.
   *
   * Such an event is dropped by the emitter anyway (_add_follow_trajectory_action
   * / _add_assign_route_action return False under 2 points) and takes any
   * after_event chained onto it down with it, so the editor removes it at the
   * moment it becomes clear the user is not going to finish drawing.
   * EventPanel.deleteEvent does the re-pointing of those chains.
   */
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

  // loadJSON clears every mode flag by direct assignment and emits 'stateLoaded'
  // rather than 'change', so the handler above never sees it. Without this the
  // banner would survive a load started mid-draw, and _drawContext would keep
  // pointing at an id from the scenario that was just replaced — ids restart at
  // obj-1/evt-1 in every file, so that is a real collision, not a theoretical one.
  AppState.on('stateLoaded', () => {
    _drawContext = null;
    trajBanner.classList.add('hidden');
    svg.classList.remove('trajectory-mode');
  });

  trajDoneBtn.addEventListener('click', () => {
    _finishPathMode();
  });

  // Enter finishes a path, so drawing one never needs the mouse to leave the
  // map: click the waypoints, press Enter. Esc still cancels (mapKeys.js).
  // Bound here rather than in mapKeys.js's keydown because _finishPathMode and the
  // banner both live in this module.
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
    // Waypoint 1 is the actor's own pose, so it inherits the actor's height too
    // and the first map click already completes a usable 2-point path.
    //
    // On its own that seed is what used to make a forgotten path event silently
    // wrong: one waypoint is below the 2 the emitter needs and draws nothing on
    // the map (mapPaths.js skips a path under 2 points), while the card claimed
    // "Pfad gezeichnet". The seed is fine; leaving it *alone* is what is not, so
    // the event is discarded on leaving draw mode instead
    // (_discardIncompletePath), and the card counts against 2 rather than 0.
    let path = _eventPath(actor, eventId, type);
    if (!path || path.length === 0) {
      if (type === 'trajectory') {
        path = [{ x: actor.x, y: actor.y, z: actor.z ?? 0, velocity: 10.0 }];
      } else {
        // Snapped like every other route waypoint. A vehicle sits on a spawn
        // point, which is a lane centre already, so this normally moves the
        // seed by centimetres — but a hand-typed or dragged pose need not be
        // on a lane at all, and leg 0 would then start off the network.
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
    // Drawing into a hidden path would put every click somewhere invisible, so
    // starting a draw un-hides it for good (MapView.showPath flips the stored
    // toggle rather than overriding it, so the card's button stays truthful).
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
    // Waypoints used to carry no z at all and picked up a flat 0.2 downstream,
    // which drags a trajectory across an elevated road straight under it.
    let point;
    if (type === 'route') {
      // Shift places a 'shortest' waypoint. Same modifier and the same meaning
      // it already has for prop placement: do not snap to the lane. That is not
      // a convenience here, it is the semantics — a 'shortest' leg is appended
      // to the route verbatim and driven as the straight line it is drawn as,
      // so going where lanes do not is the whole point of choosing it. A plain
      // click stays snapped, because a 'fastest' leg is handed to the
      // GlobalRoutePlanner, which projects the point with map.get_waypoint()
      // and routes to whichever lane came out — off-centre that can silently be
      // the oncoming carriageway.
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
    // A NEW array, not path.push(). _eventPath returns the live
    // action.trajectory/waypoints, so mutating it in place would change the
    // actor before updateById is told about it — the patch would then be
    // identical to the state it is patching, the undo history would score it a
    // no-op, and the waypoint would not be undoable.
    _setEventPath(actor, eventId, type, [...path, point]);
  }

  ObjectsCore.define({
    startPathMode,
    _addPathPoint,
  });
})();
