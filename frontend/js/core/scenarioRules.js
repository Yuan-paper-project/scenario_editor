/**
 * scenarioRules.js — Rules every layer shares about which events export and fire (ScenarioRules).
 */
(() => {
  'use strict';

  // ── Which events actually survive the export ────────────────────────────────

  /**
   * The one definition of "will this event reach the .xosc", shared by the event
   * cards, the export gate and the preview. Each rule mirrors an action builder in
   * event_builders.py whose False drops the event — and dangles anything chained onto it.
   */
  const ROUTE_ACTION_TYPES = new Set([
    'car',
    'van',
    'truck',
    'bus',
    'motorcycle',
    'scooter',
    'police',
    'ambulance',
    'firetruck',
    'ego',
  ]);

  /* Only <Pedestrian>s ignore a lane offset (PedestrianControl never reads it). Wider
   * than ROUTE_ACTION_TYPES: a cyclist is a <Vehicle> and honours it. Same split as
   * mapMarkers.js's WALKER_TYPES and xml_builder._PEDESTRIAN_TYPES. */
  const WALKER_ACTION_TYPES = new Set(['pedestrian', 'child']);

  /* ChangeActorLateralMotion replaces the waypoint list: the rest of a route/trajectory is dropped,
   * and the vehicle follows its new lane ~400 m, then stops. Exempt: a path started by it. */
  function _laneChangeDropsPath(actor, ev, events) {
    if ((ev.action || {}).type !== 'lane_change') return null;
    const path = (events || actor.events || []).find((e) => {
      const t = (e.action || {}).type;
      return t === 'assign_route' || t === 'follow_trajectory';
    });
    if (!path) return null;
    const pt = path.trigger || {};
    if (_isEventRef(pt) && pt.event_id === ev.id && (!pt.actor_ref || pt.actor_ref === actor.id)) return null;
    const kind = path.action.type === 'assign_route' ? 'Route' : 'Trajektorie';
    return {
      code: 'lane_change_drops_path',
      short: `Verwirft den Rest der ${kind}`,
      message:
        `ein Spurwechsel ersetzt in CARLA die Wegpunkte: der Rest der ${kind} wird verworfen, ` +
        'danach folgt das Fahrzeug nur seiner neuen Spur und bleibt nach ~400 m stehen' +
        (actor.type === 'ego'
          ? '. Besser einen Routenpunkt auf die Zielspur setzen — nur so steht der Wechsel auch in der Routen-XML'
          : ''),
    };
  }

  /** A trigger point is only usable once it actually carries coordinates. */
  function _isTriggerPoint(point) {
    return !!point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y));
  }

  // ── Event references: cross-actor triggers and the cycles they make possible ──
  //
  // after_event fires on the named event's completion, event_started on its start.
  // An absent actor_ref means the event's own actor. One trigger per event makes the
  // reference graph functional (≤ 1 outgoing edge), so a forward walk finds any cycle.

  const EVENT_REF_TRIGGERS = new Set(['after_event', 'event_started']);
  const _isEventRef = (trigger) => !!trigger && EVENT_REF_TRIGGERS.has(trigger.type);

  const _afterEventKey = (actorId, eventId) => `${actorId}::${eventId}`;

  /** The actor that owns the event an event-reference trigger points at. */
  function _afterEventOwner(actor, trigger) {
    const ref = trigger && trigger.actor_ref;
    if (!ref || ref === actor.id) return actor;
    return AppState.findById(ref) || null;
  }

  /** The event an event-reference trigger points at, as {actor, event, index}. */
  function _afterEventTarget(actor, trigger, events) {
    const owner = _afterEventOwner(actor, trigger);
    if (!owner) return null;
    const list = owner === actor && events ? events : owner.events || [];
    const index = list.findIndex((o) => String(o.id) === String(trigger.event_id));
    return index >= 0 ? { actor: owner, event: list[index], index } : null;
  }

  /** Keys reachable forward from one event; the start is included only if the walk returns to it (a cycle). */
  function _afterEventReach(startActor, startEvent) {
    const seen = new Set();
    let actor = startActor,
      ev = startEvent;
    for (;;) {
      const trigger = (ev && ev.trigger) || {};
      if (!_isEventRef(trigger)) return seen;
      const target = _afterEventTarget(actor, trigger);
      if (!target) return seen;
      const key = _afterEventKey(target.actor.id, target.event.id);
      if (seen.has(key)) return seen;
      seen.add(key);
      actor = target.actor;
      ev = target.event;
    }
  }

  window.ScenarioRules = {
    ROUTE_ACTION_TYPES,

    /** Does this actor type's controller read the lane offset at all? */
    honoursLaneOffset(actorType) {
      return !WALKER_ACTION_TYPES.has(actorType);
    },

    /** Can this type drive backwards? PedestrianControl raises on a negative target speed. */
    canReverse(actorType) {
      return !WALKER_ACTION_TYPES.has(actorType);
    },

    /** Does this action never complete on its own (held lane_offset, continuous follow)? Mirrors _never_completes. */
    neverCompletes(action) {
      if (!action) return false;
      if (action.type === 'lane_offset') return action.continuous !== false;
      if (action.type === 'set_speed') {
        const target = action.target || {};
        return target.mode === 'relative' && target.continuous === true;
      }
      return false;
    },

    /** A self-relative set_speed compounds every tick unless a non-continuous `rate` ramp snapshots it. */
    selfSpeedCompounds(actor, action) {
      if (!actor || !action || action.type !== 'set_speed') return false;
      const target = action.target || {};
      if (target.mode !== 'relative' || target.entity_ref !== actor.id) return false;
      return (action.dynamics || {}).dimension !== 'rate' || target.continuous === true;
    },

    /**
     * Non-blocking warning, or null: exports, but does nothing in CARLA. A vehicle
     * latches `_reached_goal` at its path's end, so an event starting when its own
     * trajectory completes is dead on arrival.
     */
    eventWarning(actor, ev, events) {
      if (!actor || !ev || WALKER_ACTION_TYPES.has(actor.type)) return null;
      const trigger = ev.trigger || {};
      const target = trigger.type === 'after_event' ? _afterEventTarget(actor, trigger, events) : null;
      if (target && target.actor.id === actor.id && (target.event.action || {}).type === 'follow_trajectory') {
        return {
          code: 'after_own_path_end',
          short: 'Wirkungslos — steht nach Pfadende',
          message:
            'das Fahrzeug bleibt am Ende seiner Trajektorie endgültig stehen ' +
            '(SimpleVehicleControl), ein danach startendes Event bewegt es nicht mehr',
        };
      }
      return _laneChangeDropsPath(actor, ev, events);
    },

    afterEventKey: _afterEventKey,

    /** Does this trigger name another event (after_event / event_started)? */
    isEventRef: _isEventRef,

    /** May `actor` wait on an event of `owner`? Never an NPC on the ego, which may be the AV (backend: 400). */
    mayWaitOnActor(actor, owner) {
      if (!actor || !owner) return false;
      return actor.type === 'ego' || owner.type !== 'ego';
    },

    /** The {actor, event, index} an event-reference trigger names, or null. */
    afterEventTarget(actor, trigger, events) {
      if (!actor || !_isEventRef(trigger)) return null;
      return _afterEventTarget(actor, trigger, events);
    },

    /** Is `ev` itself on an event-reference cycle? */
    afterEventCycles(actor, ev) {
      if (!actor || !ev || !_isEventRef(ev.trigger)) return false;
      return _afterEventReach(actor, ev).has(_afterEventKey(actor.id, ev.id));
    },

    /** May `ev` wait for `candidate`? False if that would close a loop (the dropdown omits it). */
    canWaitFor(actor, ev, candidateActor, candidate) {
      if (!actor || !ev || !candidateActor || !candidate) return false;
      if (candidateActor.id === actor.id && String(candidate.id) === String(ev.id)) return false;
      return !_afterEventReach(candidateActor, candidate).has(_afterEventKey(actor.id, ev.id));
    },

    /** Mirrors _add_*_action's own return value: false ⇒ the event is dropped. */
    actionEmits(action, actorType) {
      if (!action) return false;
      if (action.type === 'follow_trajectory') return (action.trajectory || []).length >= 2;
      if (action.type === 'assign_route') {
        return (action.waypoints || []).length >= 2 && ROUTE_ACTION_TYPES.has(actorType);
      }
      if (action.type === 'lane_offset') return this.honoursLaneOffset(actorType);
      return true; // set_speed / set_distance / lane_change never fail to emit
    },

    /** The one thing wrong with `ev`, or null: `short` for the chip, `message` for the export gate. Action before trigger. */
    eventProblem(actor, ev, events) {
      const action = (ev && ev.action) || {};
      const trigger = (ev && ev.trigger) || {};
      const type = actor && actor.type;

      if (action.type === 'follow_trajectory' && (action.trajectory || []).length < 2) {
        return {
          code: 'path_too_short',
          short: 'Mindestens 2 Wegpunkte nötig',
          message: 'die Trajektorie hat weniger als 2 Wegpunkte',
        };
      }
      if (action.type === 'assign_route') {
        if (!ROUTE_ACTION_TYPES.has(type)) {
          return {
            code: 'route_not_routable',
            short: 'Route nur für Fahrzeuge möglich',
            message: 'eine Route ist für diesen Akteurstyp nicht möglich',
          };
        }
        if ((action.waypoints || []).length < 2) {
          return {
            code: 'path_too_short',
            short: 'Mindestens 2 Wegpunkte nötig',
            message: 'die Route hat weniger als 2 Wegpunkte',
          };
        }
        // Waypoint 0 must be 'fastest'; editor-built paths always are, so this catches loaded files.
        if (action.waypoints[0] && action.waypoints[0].strategy === 'shortest') {
          return {
            code: 'route_starts_straight',
            short: 'Erster Wegpunkt muss der Spur folgen',
            message: 'der erste Wegpunkt der Route ist auf „Gerade" gesetzt',
          };
        }
        // A route's trigger is discarded at export.
        return null;
      }

      if (action.type === 'lane_offset' && !this.honoursLaneOffset(type)) {
        return {
          code: 'offset_not_vehicle',
          short: 'Spurversatz nur für Fahrzeuge möglich',
          message: 'ein Spurversatz wirkt nur auf Fahrzeuge — Personen ignorieren ihn',
        };
      }

      if (
        action.type === 'set_speed' &&
        (action.target || {}).reverse === true &&
        (action.target || {}).mode !== 'relative' &&
        !this.canReverse(type)
      ) {
        return {
          code: 'reverse_not_vehicle',
          short: 'Rückwärts nur für Fahrzeuge möglich',
          message: 'rückwärts fahren können nur Fahrzeuge — Personen können es nicht',
        };
      }
      if (this.selfSpeedCompounds(actor, action)) {
        return {
          code: 'self_speed_compounds',
          short: 'Eigene Geschw. nur mit Rate, nicht dauerhaft',
          message:
            'eine Geschwindigkeit relativ zur eigenen braucht die Dynamik „Rate" und ' +
            'darf nicht dauerhaft folgen — sonst schaukelt sie sich jeden Tick auf',
        };
      }
      if ((trigger.type === 'distance_to_ego' || trigger.type === 'relative_speed') && actor) {
        const ref = trigger.entity_ref || (AppState.ego && AppState.ego.id);
        if (trigger.entity_ref && !AppState.findById(trigger.entity_ref)) {
          return {
            code: 'trigger_actor_missing',
            short: 'Auslöser feuert nie — Akteur fehlt',
            message: 'der Auslöser misst gegen einen Akteur, den es nicht mehr gibt',
          };
        }
        if (ref === actor.id && !(trigger.type === 'distance_to_ego' && type === 'ego')) {
          return {
            code: 'trigger_self_ref',
            short: 'Auslöser misst gegen sich selbst',
            message: 'der Auslöser vergleicht den Akteur mit sich selbst — das ist immer 0',
          };
        }
      }
      if (trigger.type === 'distance_to_point' && !_isTriggerPoint(trigger.point)) {
        return {
          code: 'no_trigger_point',
          short: 'Kein Auslösepunkt gesetzt',
          message: 'der Auslösepunkt wurde nie auf der Karte gesetzt',
        };
      }
      if (_isEventRef(trigger)) {
        // Resolved through AppState: the reference may leave this actor.
        const target = _afterEventTarget(actor, trigger, events);
        if (!target) {
          return {
            code: 'dangling_after_event',
            short: 'Auslöser feuert nie — Event fehlt',
            message: 'der Auslöser verweist auf ein Event, das es nicht gibt',
          };
        }
        // A loop never fires; the dropdown cannot build one, so this catches loaded files.
        if (this.afterEventCycles(actor, ev)) {
          return {
            code: 'cyclic_after_event',
            short: 'Auslöser wartet im Kreis',
            message: 'der Auslöser hängt in einem Kreis von Events, die aufeinander warten',
          };
        }
        const targetAction = target.event.action || {};
        // The backend rewrites a reference to a route (distance_to_ego @ 400) — so no ego ban either.
        if (targetAction.type === 'assign_route') return null;
        if (!this.mayWaitOnActor(actor, target.actor)) {
          return {
            code: 'npc_waits_on_ego',
            short: 'NPC darf nicht auf Ego-Event warten',
            message: 'ein NPC wartet auf ein Ego-Event — ein vom AV gefahrenes Ego hat keine Events',
          };
        }
        // A never-completing event is no after_event target (its start is fine for event_started).
        if (trigger.type === 'after_event' && this.neverCompletes(targetAction)) {
          return targetAction.type === 'lane_offset'
            ? {
                code: 'after_lane_offset',
                short: 'Auslöser feuert nie — Spurversatz endet nicht',
                message: 'der Auslöser wartet auf einen Spurversatz, der dauerhaft gilt und nie endet',
              }
            : {
                code: 'after_continuous_speed',
                short: 'Auslöser feuert nie — Folgen endet nicht',
                message: 'der Auslöser wartet auf ein dauerhaftes Geschwindigkeit-Folgen, das nie endet',
              };
        }
        if (!this.actionEmits(targetAction, target.actor.type)) {
          return {
            code: 'dangling_after_event',
            short: 'Auslöser feuert nie — Vorgänger unvollständig',
            message: 'der Auslöser wartet auf ein Event, das selbst nicht exportiert wird',
          };
        }
      }
      return null;
    },

    /** Every problem on one actor, as [{ev, index, problem}]. */
    problemsOf(actor) {
      const events = (actor && actor.events) || [];
      return events
        .map((ev, index) => ({ ev, index, problem: this.eventProblem(actor, ev, events) }))
        .filter((entry) => entry.problem);
    },
  };
})();
