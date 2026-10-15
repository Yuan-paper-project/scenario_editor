/**
 * eventPanelChains.js — event references (after_event / event_started), defaults, and deleting an event with its re-point sweep.
 *
 * Part of the event panel (EventPanel); see eventPanel.js.
 */
(() => {
  'use strict';

  const { DEFAULT_LANE_OFFSET_M, _defaultRelativeActorId, _eventAction, _eventTrigger, _eventDisplayName } =
    EventPanelCore.shared;

  // ── after_event references ──────────────────────────────────────────────────

  /** Split `${actorId}::${eventId}`, the value the ref dropdown carries. */
  function _splitAfterEventValue(value) {
    const at = String(value || '').indexOf('::');
    return at < 0
      ? { actorId: null, eventId: String(value || '') }
      : { actorId: value.slice(0, at), eventId: value.slice(at + 2) };
  }

  /** The trigger patch for "wait for `candidate` on `owner`".
   *  actor_ref is omitted for the actor's own event: absent means self
   *  everywhere (scenarioRules.js, scenario_io.py, event_builders.py), so a self-
   *  reference keeps saving exactly as it did before cross-actor refs. */
  function _afterEventTrigger(actor, ownerId, eventId, type = 'after_event') {
    const trigger = { type, event_id: eventId };
    if (ownerId && ownerId !== actor.id) trigger.actor_ref = ownerId;
    return trigger;
  }

  /**
   * The 'Nach Event' dropdown's contents, grouped by actor — this actor first,
   * then every other scenario actor. Three kinds of event are left out of every
   * group:
   *
   *  - an assign_route, whose own trigger is discarded at export and whose
   *    dependents are rewritten to distance_to_ego@400, so "after the route"
   *    is a start condition the file never contains;
   *  - a lane_offset, which is emitted continuous="true" and so never ends on
   *    its own. It is never a valid target: a save file that names one keeps
   *    it (the 'Aktuell' group below) so the select shows what the trigger
   *    says, ScenarioRules chips it, and the export refuses it;
   *  - anything that already waits on `ev`, directly or down a chain
   *    (ScenarioRules.canWaitFor). Omitting those is what makes a loop
   *    unauthorable rather than merely reported — the backend's 400 then only
   *    has to catch a save file or an LLM payload.
   *
   * The same function serves event_started, where only the lane_offset rule
   * differs: an offset's START is well defined, so it may be named there.
   * And for an NPC the ego's events are left out entirely (mayWaitOnActor).
   */
  function _afterEventGroups(actor, ev, events, triggerType = 'after_event') {
    const groups = [];
    const addGroup = (owner, ownerEvents, label, isOwn) => {
      // An NPC may not wait on an ego event at all (see mayWaitOnActor): the
      // whole ego group is left out rather than shown greyed, so the dropdown
      // only ever offers what will export.
      if (!ScenarioRules.mayWaitOnActor(actor, owner)) return;
      const options = ownerEvents
        .map((other, index) => ({ other, index }))
        .filter(({ other }) => _isChainTarget(other, triggerType))
        .filter(({ other }) => ScenarioRules.canWaitFor(actor, ev, owner, other))
        .map(({ other, index }) => [
          ScenarioRules.afterEventKey(owner.id, other.id),
          _afterEventOptionLabel(owner, other, index, isOwn),
        ]);
      if (options.length) groups.push({ label, options });
    };
    addGroup(actor, events, 'Dieser Akteur', true);
    [AppState.ego, ...(AppState.npcs || [])]
      .filter((other) => other && other.id !== actor.id)
      .forEach((other) => addGroup(other, other.events || [], AppState.actorLabel(other, { short: true }), false));
    return groups;
  }

  /**
   * One option's text in the 'Nach Event' dropdown.
   *
   * A foreign event's owner is named in the option ITSELF, not only in its
   * <optgroup> label: a closed native select shows the selected option's text
   * and nothing else, so the group heading — the only thing saying whose event
   * this is — disappears the moment the dropdown closes. The owning actor's own
   * events stay unsuffixed, where naming it on every row would say nothing.
   * Same rule as the collapsed card's summary line (_eventTriggerSummary).
   */
  function _afterEventOptionLabel(owner, other, index, isOwn) {
    const name = _eventDisplayName(other, index);
    return isOwn ? name : `${name} (${AppState.actorLabel(owner, { short: true })})`;
  }

  /** The first option in `groups`, or null — the default when an after_event
   *  trigger is chosen or its target disappears. */
  function _firstAfterEventOption(groups) {
    for (const group of groups) {
      if (group.options.length) return _splitAfterEventValue(group.options[0][0]);
    }
    return null;
  }

  // ── Event State ─────────────────────────────────────────────────────────────

  /**
   * The default trigger for an actor's first event (or any event that just
   * lost its predecessor — see _deleteEvent). distance_to_ego is meaningless
   * for the ego itself (a distance from hero to hero is always 0, so the
   * condition fires on tick 1) — the backend coerces this anyway
   * (_normalize_actor in backend/scenario_io.py), but defaulting it correctly
   * here means the UI never shows a trigger it is about to rewrite.
   */
  function _defaultFirstTrigger(actor, previousValue = null) {
    if (actor?.type === 'ego') return { type: 'simulation_time', value: 0 };
    return { type: 'distance_to_ego', value: previousValue ?? 400 };
  }

  function _defaultEvent(actor, actionType = 'set_speed', forceFirst = false) {
    const events = actor.events || [];
    const idx = UIUtils.nextIndexedId(events, 'evt');
    const previous = events[events.length - 1];
    const trigger =
      actionType === 'assign_route'
        ? { type: 'simulation_time', value: 0 }
        : events.length > 0 && !forceFirst && _isChainTarget(previous)
          ? { type: 'after_event', event_id: previous.id }
          : _defaultFirstTrigger(actor);
    return {
      id: `evt-${idx}`,
      trigger,
      action: _defaultAction(actor, actionType),
    };
  }

  function _defaultAction(actor, actionType = 'set_speed') {
    if (actionType === 'set_distance') {
      return {
        type: 'set_distance',
        axis: 'longitudinal',
        entity_ref: _defaultRelativeActorId(actor),
        value: 10.0,
      };
    }
    if (actionType === 'lane_change') {
      return {
        type: 'lane_change',
        direction: 'left',
        dynamics: { shape: 'linear', value: 12.0 },
      };
    }
    if (actionType === 'lane_offset') {
      // No dynamics: LaneOffsetActionDynamics is required by the XSD and read
      // by nothing, so the emitter writes a fixed shape rather than carrying a
      // value through three layers that never means anything.
      return {
        type: 'lane_offset',
        direction: 'left',
        offset: DEFAULT_LANE_OFFSET_M,
      };
    }
    if (actionType === 'assign_route') {
      return {
        type: 'assign_route',
        route_strategy: 'fastest',
        waypoints: [],
      };
    }
    if (actionType === 'follow_trajectory') {
      return {
        type: 'follow_trajectory',
        trajectory: [],
      };
    }
    return {
      type: 'set_speed',
      dynamics: { shape: 'step', dimension: 'time', value: 5.0 },
      target: { mode: 'absolute', value: 10.0 },
    };
  }

  function _deleteEvent(actor, eventId) {
    const currentActor = AppState.findById(actor.id) || actor;
    const currentEvents = currentActor.events || [];
    const deletedIndex = currentEvents.findIndex((ev) => ev.id === eventId);
    if (deletedIndex < 0) return;

    const previousEvent = currentEvents[deletedIndex - 1] || null;
    const firstEventTriggerPatch = (ev) => ({
      ...ev,
      trigger: _defaultFirstTrigger(
        currentActor,
        _eventTrigger(ev).type === 'distance_to_ego' ? _eventTrigger(ev).value : null,
      ),
    });
    // `!trigger.actor_ref` is load-bearing: event ids are only unique within an
    // actor, so every actor's second event is `evt-2`. Without it, deleting
    // this actor's evt-2 would re-point a trigger that names ANOTHER actor's
    // evt-2 — at an event on the wrong vehicle.
    const events = currentEvents
      .filter((ev) => ev.id !== eventId)
      .map((ev) => {
        const trigger = _eventTrigger(ev);
        if (ScenarioRules.isEventRef(trigger) && !trigger.actor_ref && trigger.event_id === eventId) {
          return _canChainOnto(currentActor, ev, currentActor, previousEvent, trigger.type)
            ? { ...ev, trigger: { type: trigger.type, event_id: previousEvent.id } }
            : firstEventTriggerPatch(ev);
        }
        return ev;
      });

    if (AppState.activePathEventId === eventId) {
      AppState.set({
        trajectoryMode: false,
        activeTrajectoryId: null,
        routeMode: false,
        activeRouteId: null,
        activePathEventId: null,
      });
    }
    // Another actor may be waiting for the event being deleted, so the
    // re-point sweep cannot stop at this actor's own list. Each actor is its
    // own updateById call, hence the group: deleting one event is one undo
    // entry however many actors it touches.
    UndoStack.group('Event gelöscht', () => {
      AppState.updateById(currentActor.id, { events });
      _repointForeignReferences(currentActor, eventId, previousEvent);
    });
  }

  /**
   * Re-point every OTHER actor's after_event trigger that named the event just
   * deleted from `owner`. Same rule as the owner's own list — fall back to the
   * event before it, or to that actor's default first trigger — except the
   * fallback is derived from the referencing actor, not the owner: an
   * ego-owned event must not land on distance_to_ego (a distance from hero to
   * itself is always 0), which _defaultFirstTrigger already knows.
   *
   * Deleting a whole ACTOR is deliberately not swept: there is no sensible
   * event to fall back to, so the references are left dangling and the card's
   * „Auslöser feuert nie — Event fehlt" chip (plus the export gate) says so.
   */
  /** May `ev` be re-pointed at `candidate` — is it a real, non-route event
   *  that does not already wait on `ev`? Shared by both halves of the delete
   *  sweep, so neither can close a loop while repairing one. */
  /** May an event-reference trigger of kind `triggerType` name `ev` at all?
   *  An assign_route never qualifies — its own trigger is discarded at export.
   *  A lane_offset never completes, so after_event may not name one; its start
   *  is well defined, so event_started may. The dropdown, the new-event default
   *  and the delete re-point all go through this — they drifted apart once
   *  already, when the dropdown learned about lane_offset and the default did
   *  not. */
  function _isChainTarget(ev, triggerType = 'after_event') {
    const action = _eventAction(ev);
    if (action.type === 'assign_route') return false;
    return triggerType === 'event_started' || !ScenarioRules.neverCompletes(action);
  }

  function _canChainOnto(actor, ev, owner, candidate, triggerType = 'after_event') {
    return (
      !!candidate &&
      _isChainTarget(candidate, triggerType) &&
      ScenarioRules.mayWaitOnActor(actor, owner) &&
      ScenarioRules.canWaitFor(actor, ev, owner, candidate)
    );
  }

  function _repointForeignReferences(owner, deletedEventId, previousEvent) {
    for (const other of [AppState.ego, ...(AppState.npcs || [])]) {
      if (!other || other.id === owner.id || !(other.events || []).length) continue;
      let touched = false;
      const events = other.events.map((ev) => {
        const trigger = _eventTrigger(ev);
        if (
          !ScenarioRules.isEventRef(trigger) ||
          trigger.actor_ref !== owner.id ||
          String(trigger.event_id) !== String(deletedEventId)
        )
          return ev;
        touched = true;
        return {
          ...ev,
          trigger: _canChainOnto(other, ev, owner, previousEvent, trigger.type)
            ? _afterEventTrigger(other, owner.id, previousEvent.id, trigger.type)
            : _defaultFirstTrigger(other, null),
        };
      });
      if (touched) AppState.updateById(other.id, { events });
    }
  }

  EventPanelCore.define({
    _splitAfterEventValue,
    _afterEventTrigger,
    _afterEventGroups,
    _afterEventOptionLabel,
    _firstAfterEventOption,
    _defaultEvent,
    _deleteEvent,
  });
})();
