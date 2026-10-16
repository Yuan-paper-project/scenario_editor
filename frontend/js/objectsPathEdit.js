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
   * A trigger point at (wx, wy) for one event of `actor`, keeping the event's
   * existing name if it already had one.
   *
   * Shared by the marker drag (moveTriggerPoint) and by eventPanelTriggers.js, which
   * seeds a point the moment the trigger is selected so it is never null — a
   * point-less distance_to_point used to reach the backend and be silently
   * defaulted to the map origin.
   * DistanceCondition is 3-D, so the z comes from the elevation profile exactly
   * as a waypoint's does; a literal here cannot fire on a graded road.
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

  /**
   * Move an existing trigger point to (wx, wy) — the end of a marker drag on
   * the map (mapTriggerPoints.js). The z is re-derived from the elevation profile here
   * and not on every mousemove, for the same reason an actor's is: the lookup
   * is a linear scan over every lane segment and z has no effect in a top-down
   * view.
   */
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
   * Move one existing waypoint to (wx, wy) — the map drag.
   *
   * A route waypoint is snapped here exactly as it is at placement, so dragging
   * one cannot put it somewhere clicking one could not. `deriveZ` is off during
   * the drag itself for a trajectory point (the elevation lookup is a linear
   * scan over every lane segment, the same reason an actor's z waits for
   * mouseup) — a route point gets its z free, out of the snap.
   */
  function movePathPoint(actorId, type, idx, wx, wy, eventId = null, deriveZ = false) {
    const actor = _findActor(actorId);
    const path = actor ? _eventPath(actor, eventId, type) : null;
    if (!actor || !path?.[idx]) return;

    let patch;
    // A 'shortest' route waypoint drags as freely as a trajectory vertex — it is
    // driven exactly where it is put, so snapping it would defeat the strategy
    // it was given. Only a 'fastest' one re-snaps, for the reason in
    // _addPathPoint: the router will project it whether we do or not.
    if (type === 'route' && path[idx].strategy !== 'shortest') {
      const snap = _routeWaypointAt(wx, wy);
      patch = { x: snap.x, y: snap.y, z: snap.z };
    } else {
      const x = Math.round(wx * 10) / 10;
      const y = Math.round(wy * 10) / 10;
      patch = deriveZ ? { x, y, z: _roundZ(groundZAt(x, y) + SPAWN_CLEARANCE.waypoint) } : { x, y };
    }
    // Copy rather than write through to the live point — see _addPathPoint.
    _setEventPath(
      actor,
      eventId,
      type,
      path.map((pt, i) => (i === idx ? { ...pt, ...patch } : pt)),
    );
  }

  /* Waypoint 1 IS the vehicle: it is seeded on the actor's pose and tracks it
   * (AppState.updateById), so deleting it would leave a path whose first point
   * is a place the actor is not. For a route that is also load-bearing rather
   * than tidy — waypoint 0 is what makes ChangeActorWaypoints bind its route
   * seed on the i == 0 pass, so a route whose first waypoint is 'shortest'
   * kills the run with an UnboundLocalError on stock ScenarioRunner. Keeping
   * the seed is what keeps waypoint 0 'fastest' and exports portable.
   *
   * Silent rather than a toast: Entf walks the path by design (the mark moves
   * to the point that took the deleted one's place), so this fires on the last
   * keypress of an ordinary gesture and a warning there would be noise. */
  function deletePathPoint(actorId, type, idx, eventId = null) {
    if (idx === 0) return;
    const actor = _findActor(actorId);
    const path = actor ? _eventPath(actor, eventId, type) : null;
    if (!actor || !path) return;
    // Copy rather than splice the live array — see _addPathPoint.
    _setEventPath(
      actor,
      eventId,
      type,
      path.filter((_, i) => i !== idx),
    );
  }

  /* Flip one route waypoint between the two strategies.
   *
   * Going to 'fastest' re-snaps: the point becomes a routing target, and an
   * off-centre one is projected by map.get_waypoint() to a lane nobody chose.
   * Going to 'shortest' leaves the point exactly where it is — a lane centre is
   * a perfectly good straight-line target, and moving it would be a surprise.
   *
   * Waypoint 0 is refused: its leg runs from the actor's own pose to itself, so
   * the choice means nothing, and 'shortest' there is the arrangement that
   * crashes an unpatched ScenarioRunner (see deletePathPoint). */
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

  /** One speed for the whole trajectory, written to every vertex (see
   * EventPanel._trajectorySpeed for why there is only one). */
  function setPathVelocity(actorId, velocity, eventId = null) {
    const actor = _findActor(actorId);
    const path = actor ? _eventPath(actor, eventId, 'trajectory') : null;
    if (!actor || !path?.length) return;
    const v = Math.min(50, Math.max(0, parseFloat(velocity)));
    const speed = Number.isFinite(v) ? v : 10.0;
    // Copy rather than write through to the live point — see _addPathPoint.
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
