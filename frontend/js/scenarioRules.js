/**
 * scenarioRules.js — Rules every layer shares about which events export and fire (ScenarioRules).
 */
(() => {
  'use strict';

  // ── Which events actually survive the export ────────────────────────────────

  /**
   * ScenarioRules — the single definition of "will this event reach the .xosc",
   * shared by eventPanel.js (warning chips), scenarioIO.js (the export gate) and
   * simulate.js (the preview). It used to live only inside simulate.js, so the
   * panel could show a card the exporter silently threw away.
   *
   * Every rule here mirrors one in ../llm-scenario-gen/generator/event_builders.py
   * — an action builder that returns False makes build_custom_event_chain skip
   * the whole event. The consequence is worse than the lost event: anything
   * chained onto it with after_event is left pointing at a storyboard element
   * that is not in the file, and can never fire.
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

  /* ChangeActorLaneOffset writes through to the controller's `_offset`, and only
   * SimpleVehicleControl and NpcVehicleControl ever read it — PedestrianControl
   * stores it and never looks at it again, so a walker gets a valid file in
   * which it simply never moves sideways.
   *
   * Deliberately NOT ROUTE_ACTION_TYPES, which is narrower: that set is limited
   * by the route planner and leaves 'cyclist' out, but a cyclist aliases to
   * 'bike' and is a <Vehicle> on simple_vehicle_control — it honours an offset
   * perfectly well. The rule is exactly "is this a <Pedestrian>", so it is
   * stated as the exclusion it is. Same split as mapView.js's WALKER_TYPES and
   * xml_builder._PEDESTRIAN_TYPES; keep all three in step. */
  const WALKER_ACTION_TYPES = new Set(['pedestrian', 'child']);

  /** A trigger point is only usable once it actually carries coordinates. */
  function _isTriggerPoint(point) {
    return !!point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y));
  }

  // ── Event references: cross-actor triggers and the cycles they make possible ──
  //
  // Two triggers name another event: after_event (fires when it COMPLETES,
  // completeState) and event_started (fires when it STARTS, startTransition).
  // Both carry `event_id` plus an optional `actor_ref`; an absent actor_ref
  // means the event's own actor, so every save file, template and payload
  // written before cross-actor references existed still resolves the same way.
  // The backend resolves actor_ref to an OSC entity name at export
  // (scenario_io.py) and the emitter keys its name table on (entity, event_id),
  // because ScenarioRunner's storyboardElementRef lookup goes through a global
  // blackboard ('(EVENT)<name>-START' / '-END') and does not care which Act
  // wrote it.
  //
  // Each event has exactly one trigger, so the reference graph is a functional
  // graph: at most one outgoing edge per node. Walking forward from a node
  // therefore finds any cycle it is part of without a full SCC pass. Both
  // trigger kinds are edges of the same graph — a loop of "starts when the
  // other starts" never fires either.

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

  /**
   * Every node reachable by following event-reference edges forward from one
   * event, as a Set of keys. Stops at a missing target, a trigger that names no
   * event, or a repeat — so it terminates on a cycle instead of spinning.
   * The start node is included only when the walk comes back to it, which is
   * exactly the test for "this event is on a cycle".
   */
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

    /** Can this actor type drive backwards? PedestrianControl raises on a
     * negative target speed; every <Vehicle> just reverses its velocity. */
    canReverse(actorType) {
      return !WALKER_ACTION_TYPES.has(actorType);
    },

    /**
     * Does this action's Event never report completeState on its own? A held
     * lane_offset (continuous, the default) and a continuous relative set_speed
     * end only when something supersedes them, so after_event may never name
     * one; event_started may. Mirrored by _never_completes
     * (backend/scenario_io.py) as a 400.
     */
    neverCompletes(action) {
      if (!action) return false;
      if (action.type === 'lane_offset') return action.continuous !== false;
      if (action.type === 'set_speed') {
        const target = action.target || {};
        return target.mode === 'relative' && target.continuous === true;
      }
      return false;
    },

    /**
     * A relative set_speed naming the acting actor itself compounds every tick
     * (ChangeActorTargetSpeed re-applies the relative target per tick) unless
     * the `rate` ramp snapshots it once at initialise. Continuous skips that
     * ramp, so it compounds too.
     */
    selfSpeedCompounds(actor, action) {
      if (!actor || !action || action.type !== 'set_speed') return false;
      const target = action.target || {};
      if (target.mode !== 'relative' || target.entity_ref !== actor.id) return false;
      return (action.dynamics || {}).dimension !== 'rate' || target.continuous === true;
    },

    /**
     * A non-blocking warning for `ev`, or null: the file exports, but the event
     * cannot do anything in CARLA. SimpleVehicleControl latches `_reached_goal`
     * at the end of its waypoint list and from then on writes zero velocity
     * before reading any target — nothing ever clears it. So on a vehicle, an
     * event that starts when its own trajectory COMPLETES (which is that very
     * moment) is dead on arrival. Other timings can only be told by running the
     * preview, which badges an event that fires after the stop.
     */
    eventWarning(actor, ev, events) {
      if (!actor || !ev || WALKER_ACTION_TYPES.has(actor.type)) return null;
      const trigger = ev.trigger || {};
      if (trigger.type !== 'after_event') return null;
      const target = _afterEventTarget(actor, trigger, events);
      if (!target || target.actor.id !== actor.id) return null;
      if ((target.event.action || {}).type !== 'follow_trajectory') return null;
      return {
        code: 'after_own_path_end',
        short: 'Wirkungslos — steht nach Pfadende',
        message:
          'das Fahrzeug bleibt am Ende seiner Trajektorie endgültig stehen ' +
          '(SimpleVehicleControl), ein danach startendes Event bewegt es nicht mehr',
      };
    },

    afterEventKey: _afterEventKey,

    /** Does this trigger name another event (after_event / event_started)? */
    isEventRef: _isEventRef,

    /**
     * May an event on `actor` wait on an event owned by `owner` at all?
     *
     * An NPC may not wait on an ego event. The ego may be driven by the AV
     * under test, which carries no storyboard events — an NPC chained onto one
     * would then simply never move. An NPC reacts to the ego through what the
     * ego DOES instead: distance_to_ego, distance_to_point with the ego as the
     * triggering entity, or ego_speed. The ego may still wait on an NPC event.
     * Mirrored by _normalize_after_event_chains (backend/scenario_io.py) as a 400.
     */
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

    /**
     * May `ev` (on `actor`) wait for `candidate` (on `candidateActor`)?
     *
     * False when the candidate already depends on `ev`, directly or through a
     * chain: pointing at it would close a loop on which no event ever fires.
     * eventPanel.js omits such an option from the dropdown, which is what makes
     * a cycle unauthorable rather than merely reported.
     */
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

    /**
     * The one thing wrong with `ev`, or null. `short` is the card chip, `message`
     * the full sentence used by the export gate. Reports the event's own action
     * before its trigger — a dropped action is why the trigger stops mattering.
     */
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
        // The first waypoint must route. Its leg runs from the actor's own pose
        // to itself, so on any path the editor built this is already true (the
        // seed is placed 'fastest' and cannot be deleted or toggled) — the gate
        // exists for a path that reached the editor another way: a save file
        // predating the seed guard, or an LLM payload. The backend raises the
        // same case as a 400; without this the export would fail with no chip
        // ever having said which event was at fault.
        if (action.waypoints[0] && action.waypoints[0].strategy === 'shortest') {
          return {
            code: 'route_starts_straight',
            short: 'Erster Wegpunkt muss der Spur folgen',
            message: 'der erste Wegpunkt der Route ist auf „Gerade" gesetzt',
          };
        }
        // An assign_route's own trigger is discarded and forced to
        // simulation_time 0 at export, so it can never be the problem.
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
        // The reference may leave this actor, so the target is resolved through
        // AppState rather than looked up in `events` — which holds only the
        // owning actor's own list.
        const target = _afterEventTarget(actor, trigger, events);
        if (!target) {
          return {
            code: 'dangling_after_event',
            short: 'Auslöser feuert nie — Event fehlt',
            message: 'der Auslöser verweist auf ein Event, das es nicht gibt',
          };
        }
        // A loop: every event on it waits for one that never completes, so none
        // of them ever fires. The dropdown cannot build one (canWaitFor), and
        // the backend rejects it with a 400 — this catches a loaded save file
        // or an LLM payload, and names the card at fault before the export gate
        // refuses the whole scenario.
        if (this.afterEventCycles(actor, ev)) {
          return {
            code: 'cyclic_after_event',
            short: 'Auslöser wartet im Kreis',
            message: 'der Auslöser hängt in einem Kreis von Events, die aufeinander warten',
          };
        }
        const targetAction = target.event.action || {};
        // Pointing at an assign_route is fine: the backend rewrites that trigger
        // to distance_to_ego @ 400 rather than leaving it dangling — which is
        // also why the ego ban below does not apply to it.
        if (targetAction.type === 'assign_route') return null;
        if (!this.mayWaitOnActor(actor, target.actor)) {
          return {
            code: 'npc_waits_on_ego',
            short: 'NPC darf nicht auf Ego-Event warten',
            message: 'ein NPC wartet auf ein Ego-Event — ein vom AV gefahrenes Ego hat keine Events',
          };
        }
        // A held lane_offset or a continuous follow (neverCompletes) never
        // completes on its own — it is never a valid after_event target. Its
        // START is perfectly well defined, so event_started may name one. The
        // dropdown never offers the former and the backend rejects it with a
        // 400; this catches a save file or an LLM payload before the export does.
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
