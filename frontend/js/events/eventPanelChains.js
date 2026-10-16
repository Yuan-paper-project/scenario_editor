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

  /** Trigger patch for "wait for `eventId` on `ownerId`"; no actor_ref for the actor's own event (absent = self). */
  function _afterEventTrigger(actor, ownerId, eventId, type = 'after_event') {
    const trigger = { type, event_id: eventId };
    if (ownerId && ownerId !== actor.id) trigger.actor_ref = ownerId;
    return trigger;
  }

  /**
   * The 'Nach Event' dropdown, grouped by actor (this one first). Left out:
   * routes, anything already waiting on `ev` (so no loop can be authored), for
   * after_event a never-completing event, and for an NPC every ego event.
   */
  function _afterEventGroups(actor, ev, events, triggerType = 'after_event') {
    const groups = [];
    const addGroup = (owner, ownerEvents, label, isOwn) => {
      // Left out, not greyed: the dropdown only offers what will export.
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

  /** Option text. A foreign event names its owner: a closed select hides the group label. */
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

  /** Default trigger for a first event, or one whose predecessor was deleted; never distance_to_ego for the ego. */
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
      // No dynamics: the XSD requires them and nothing reads them; the emitter writes a fixed shape.
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
    // The actor_ref check matters: ids are unique per actor, so another actor has an evt-2 too.
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
    // Other actors may wait on this event too; grouped so the delete is one undo entry.
    UndoStack.group('Event gelöscht', () => {
      AppState.updateById(currentActor.id, { events });
      _repointForeignReferences(currentActor, eventId, previousEvent);
    });
  }

  /** May a reference of kind `triggerType` name `ev`? Never a route; after_event never a
   *  never-completing event. Shared by the dropdown, the new-event default and the re-point. */
  function _isChainTarget(ev, triggerType = 'after_event') {
    const action = _eventAction(ev);
    if (action.type === 'assign_route') return false;
    return triggerType === 'event_started' || !ScenarioRules.neverCompletes(action);
  }

  /** May `ev` be re-pointed at `candidate` without breaking the NPC→ego ban or closing a loop? */
  function _canChainOnto(actor, ev, owner, candidate, triggerType = 'after_event') {
    return (
      !!candidate &&
      _isChainTarget(candidate, triggerType) &&
      ScenarioRules.mayWaitOnActor(actor, owner) &&
      ScenarioRules.canWaitFor(actor, ev, owner, candidate)
    );
  }

  /** Re-point other actors' references to a deleted event; the fallback comes from the referencing
   *  actor. Deleting a whole actor is not swept: the „Event fehlt" chip reports it. */
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
