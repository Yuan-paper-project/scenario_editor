/**
 * objectsPathEdit.js — trigger points and editing an existing path: move, delete, strategy, speed, clear.
 *
 * Part of ObjectsManager; see objects.js.
 */
(() => {
  'use strict';

  const {
    SPAWN_CLEARANCE,
    _roundZ,
    groundZAt,
    _routeWaypointAt,
    _findActor,
    _eventPath,
    _setEventPath,
    _warnUnsnapped,
  } = ObjectsCore.shared;

  /**
   * A trigger point at (wx, wy) for one of `actor`'s events, keeping its name. z comes
   * from the elevation profile: DistanceCondition is 3-D, so a literal z may never fire.
   */
  function _triggerPointAt(actor, eventId, wx, wy) {
    const events = actor.events || [];
    const currentEvent = events.find((ev) => ev.id === eventId);
    const pointIndex =
      events.reduce((max, ev) => {
        const match = String(ev.trigger?.point?.name || '').match(/^Point\s+(\d+)$/);
        return match ? Math.max(max, parseInt(match[1], 10)) : max;
      }, 0) + 1;
    const px = Math.round(wx * 10) / 10;
    const py = Math.round(wy * 10) / 10;
    return {
      name: currentEvent?.trigger?.point?.name || `Point ${pointIndex}`,
      x: px,
      y: py,
      z: _roundZ(groundZAt(px, py) + SPAWN_CLEARANCE.waypoint),
    };
  }

  /** The point a distance_to_point trigger starts life with: the actor's pose. */
  function defaultTriggerPoint(actorId, eventId) {
    const actor = _findActor(actorId);
    if (!actor) return null;
    return _triggerPointAt(actor, eventId, actor.x, actor.y);
  }

  /** Move a trigger point (end of a marker drag); z is re-derived here, once, like an actor's. */
  function moveTriggerPoint(actorId, eventId, wx, wy) {
    const actor = _findActor(actorId);
    if (!actor) return;
    const events = actor.events || [];
    const point = _triggerPointAt(actor, eventId, wx, wy);
    const patchedEvents = events.map((ev) => {
      if (ev.id !== eventId) return ev;
      return {
        ...ev,
        trigger: {
          type: 'distance_to_point',
          value: ev.trigger?.value ?? 20,
          entity_ref: ev.trigger?.entity_ref || AppState.ego?.id || actor.id,
          point,
        },
      };
    });
    AppState.updateById(actor.id, { events: patchedEvents });
  }

  /**
   * Move a waypoint (the map drag). A 'fastest' route point re-snaps, as at placement;
   * a trajectory point gets its z only with `deriveZ` (on mouseup).
   */
  function movePathPoint(actorId, type, idx, wx, wy, eventId = null, deriveZ = false) {
    const actor = _findActor(actorId);
    const path = actor ? _eventPath(actor, eventId, type) : null;
    if (!actor || !path?.[idx]) return;

    let patch;
    // A 'shortest' point drags freely: it is driven exactly where it is put.
    if (type === 'route' && path[idx].strategy !== 'shortest') {
      const snap = _routeWaypointAt(wx, wy);
      patch = { x: snap.x, y: snap.y, z: snap.z };
    } else {
      const x = Math.round(wx * 10) / 10;
      const y = Math.round(wy * 10) / 10;
      patch = deriveZ ? { x, y, z: _roundZ(groundZAt(x, y) + SPAWN_CLEARANCE.waypoint) } : { x, y };
    }
    // A copy, not a write through to the live point (see _addPathPoint).
    _setEventPath(
      actor,
      eventId,
      type,
      path.map((pt, i) => (i === idx ? { ...pt, ...patch } : pt)),
    );
  }

  /* Waypoint 1 is the vehicle and cannot be deleted; it also keeps waypoint 0 'fastest',
   * which unpatched ScenarioRunner needs. Silent: holding Entf walks into it by design. */
  function deletePathPoint(actorId, type, idx, eventId = null) {
    if (idx === 0) return;
    const actor = _findActor(actorId);
    const path = actor ? _eventPath(actor, eventId, type) : null;
    if (!actor || !path) return;
    _setEventPath(
      actor,
      eventId,
      type,
      path.filter((_, i) => i !== idx),
    );
  }

  /* Flip a route waypoint's strategy. To 'fastest' re-snaps; to 'shortest' leaves it in
   * place. Waypoint 0 is refused. */
  function setPathPointStrategy(actorId, idx, strategy, eventId = null) {
    if (idx === 0 || (strategy !== 'fastest' && strategy !== 'shortest')) return;
    const actor = _findActor(actorId);
    const path = actor ? _eventPath(actor, eventId, 'route') : null;
    if (!actor || !path?.[idx]) return;
    let patch = { strategy };
    if (strategy === 'fastest') {
      const snap = _routeWaypointAt(path[idx].x, path[idx].y);
      if (!snap.snapped) _warnUnsnapped();
      patch = { ...patch, x: snap.x, y: snap.y, z: snap.z };
    }
    _setEventPath(
      actor,
      eventId,
      'route',
      path.map((pt, i) => (i === idx ? { ...pt, ...patch } : pt)),
    );
  }

  /** One speed for the whole trajectory, written to every vertex. */
  function setPathVelocity(actorId, velocity, eventId = null) {
    const actor = _findActor(actorId);
    const path = actor ? _eventPath(actor, eventId, 'trajectory') : null;
    if (!actor || !path?.length) return;
    const v = Math.min(50, Math.max(0, parseFloat(velocity)));
    const speed = Number.isFinite(v) ? v : 10.0;
    _setEventPath(
      actor,
      eventId,
      'trajectory',
      path.map((pt) => ({ ...pt, velocity: speed })),
    );
  }

  function clearPath(actorId, type, eventId = null) {
    const actor = _findActor(actorId);
    if (!actor || !eventId) return;
    _setEventPath(actor, eventId, type, []);
  }

  ObjectsCore.define({
    defaultTriggerPoint,
    moveTriggerPoint,
    movePathPoint,
    deletePathPoint,
    setPathPointStrategy,
    setPathVelocity,
    clearPath,
  });
})();
