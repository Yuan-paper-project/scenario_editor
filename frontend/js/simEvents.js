/**
 * simEvents.js — the export-normalisation mirror and trigger evaluation.
 *
 * Part of the in-editor preview (Simulate); see simulate.js.
 */
(() => {
  'use strict';

  const {
    run,
    _simActors,
    _tickSpeeds,
    _tickPoses,
    _tickCompleted,
    _tickStarted,
    DISTANCE_TO_EGO_FALLBACK_S,
    _dist3,
    _pose,
  } = SimCore.shared;

  // ── Event normalisation mirror (backend/scenario_io.py) ─────────────────────
  //
  // The preview reads AppState's raw, unexported events — but three rewrites
  // happen only at export time and change WHICH TRIGGER GOVERNS AN EVENT, so a
  // preview that skips them predicts a different scenario than export
  // produces. Order matters and matches _normalize_actor exactly: per-event
  // coercion (incl. assign_route forcing its own trigger), then the
  // after_event→assign_route rewrite, then — LAST, so it also catches the
  // just-rewritten case — the ego self-distance rewrite.

  const TRIGGER_TYPES = new Set([
    'simulation_time',
    'distance_to_ego',
    'distance_to_point',
    'ego_speed',
    'relative_speed',
    'after_event',
    'event_started',
  ]);

  const ACTION_TYPES = new Set([
    'follow_trajectory',
    'assign_route',
    'set_speed',
    'set_distance',
    'lane_change',
    'lane_offset',
  ]);

  // The emitter's own "does this action produce XML" rule, shared with the
  // panel's warning chips and the export gate (ScenarioRules, scenarioRules.js).
  const _actionEmits = (action, actorType) => ScenarioRules.actionEmits(action, actorType);

  function _normalizeEventsForSim(actor) {
    const events = JSON.parse(JSON.stringify(actor.events || []));
    const isEgo = actor.type === 'ego';

    for (const ev of events) {
      const trigger = ev.trigger && typeof ev.trigger === 'object' ? ev.trigger : {};
      if (!TRIGGER_TYPES.has(trigger.type)) trigger.type = 'simulation_time';
      ev.trigger = trigger;
      const action = ev.action && typeof ev.action === 'object' ? ev.action : {};
      if (!ACTION_TYPES.has(action.type)) action.type = 'follow_trajectory';
      ev.action = action;
      if (action.type === 'assign_route') ev.trigger = { type: 'simulation_time', value: 0 };
    }

    // Scenario-wide, exactly like _normalize_after_event_chains: an after_event
    // may name an event on ANOTHER actor, so "does the target assign a route"
    // cannot be answered from this actor's own list.
    for (const ev of events) {
      if (!ScenarioRules.isEventRef(ev.trigger)) continue;
      const target = ScenarioRules.afterEventTarget(actor, ev.trigger);
      if (target && (target.event.action || {}).type === 'assign_route') {
        ev.trigger = { type: 'distance_to_ego', value: 400 };
      }
    }

    if (isEgo) {
      for (const ev of events) {
        if (ev.trigger.type === 'distance_to_ego' && (!ev.trigger.entity_ref || ev.trigger.entity_ref === actor.id)) {
          ev.trigger = { type: 'simulation_time', value: 0 };
        }
      }
    }

    // Not a backend rewrite: an after_event pointing at an action that never
    // reaches the .xosc (a <2-point path, or a route on a non-routable type)
    // can never fire there either — the KNOWN defect in
    // build_custom_event_chain (see CLAUDE.md / test_events_e2e.py). Flagging
    // it here rather than pretending the chain proceeds. A cycle is the same
    // thing arrived at differently: nothing on it ever completes, so nothing on
    // it ever fires. The export gate refuses both, so this only ever sees them
    // in a loaded save file — which is exactly when a preview is what you reach
    // for.
    for (const ev of events) {
      if (!ScenarioRules.isEventRef(ev.trigger)) continue;
      const target = ScenarioRules.afterEventTarget(actor, ev.trigger);
      // A lane_offset target is refused by the export gate for after_event (it
      // never ends on its own) — event_started may name one, its start is
      // well defined. An NPC waiting on an ego event is refused outright
      // (ScenarioRules.mayWaitOnActor). In neither case does the preview
      // pretend the chain can proceed.
      if (
        !target ||
        !_actionEmits(target.event.action, target.actor.type) ||
        (ev.trigger.type === 'after_event' && ScenarioRules.neverCompletes(target.event.action)) ||
        !ScenarioRules.mayWaitOnActor(actor, target.actor) ||
        ScenarioRules.afterEventCycles(actor, ev)
      ) {
        ev.trigger.neverFires = true;
      } else if (target.actor.id !== actor.id) {
        ev.trigger.watchActorId = target.actor.id;
      }
    }

    return events;
  }

  // ── Trigger evaluation ───────────────────────────────────────────────────────

  function _resolveSimRef(id) {
    return id ? _simActors.get(id) || null : null;
  }

  /** The reference actor's speed as ChangeActorTargetSpeed sees it.
   * CarlaDataProvider.get_velocity reads a velocity map refilled once per world
   * tick, so every atomic in one tick reads the same value whatever the
   * behaviour-tree order — hence the snapshot rather than sim.speed live — and
   * an actor missing from it yields 0.0 (a printed warning, never a raise). */
  function _refSpeed(id) {
    const ref = id || run.egoId; // an omitted entity_ref exports as `hero`
    return _tickSpeeds.has(ref) ? _tickSpeeds.get(ref) : 0;
  }

  /** True the first tick the trigger's condition holds. Level-sensitive, like
   * every real OpenSCENARIO condition (conditionEdge is never read). */
  function _triggerSatisfied(trigger, sim, egoPrevPos, simTime) {
    switch (trigger.type) {
      case 'simulation_time':
        return simTime > (trigger.value ?? 0);
      case 'distance_to_ego': {
        // Both the real distance predicate AND the mandatory 60s OR-fallback
        // (event_builders.py) — a distance_to_ego trigger fires past t=60s
        // regardless of geometry, and a preview that skips this diverges in
        // any scenario that runs that long.
        if (simTime > DISTANCE_TO_EGO_FALLBACK_S) return true;
        // „Abstand zu Akteur": another actor than the ego is read from the
        // per-tick pose snapshot, exactly as the ego is.
        const other =
          trigger.entity_ref && trigger.entity_ref !== run.egoId ? _tickPoses.get(trigger.entity_ref) : egoPrevPos;
        if (!other) return false;
        return _dist3(_pose(sim), other) < (trigger.value ?? 400);
      }
      case 'relative_speed': {
        // RelativeVelocityToOtherActor: speed(other) − speed(this), both the
        // magnitudes CarlaDataProvider reports — hence the snapshot.
        const diff = _refSpeed(trigger.entity_ref) - (_tickSpeeds.get(sim.id) ?? 0);
        const limit = trigger.value ?? 0;
        return trigger.rule === 'lessThan' ? diff < limit : diff > limit;
      }
      case 'distance_to_point': {
        const point = trigger.point;
        if (!point) return false;
        // The triggering entity is whoever entity_ref names (default hero) —
        // NOT necessarily the actor that owns this event.
        const triggerActor = _resolveSimRef(trigger.entity_ref) || _simActors.get(run.egoId) || sim;
        return _dist3(_pose(triggerActor), { x: point.x, y: point.y, z: point.z ?? 0.2 }) < (trigger.value ?? 20);
      }
      case 'after_event': {
        if (trigger.neverFires) return false;
        // watchActorId is set by _normalizeEventsForSim only when the reference
        // leaves this actor. ScenarioRunner resolves storyboardElementRef
        // through a global blackboard, so which Act owns the event is
        // irrelevant there — but here the completion record lives on the other
        // sim actor, and is read from the tick snapshot rather than live.
        if (trigger.watchActorId) {
          const completedAt = _tickCompleted.get(`${trigger.watchActorId}::${trigger.event_id}`);
          return completedAt != null && completedAt <= simTime;
        }
        const rec = sim.fired.get(trigger.event_id);
        return !!rec && rec.completedAt != null && rec.completedAt <= simTime;
      }
      case 'event_started': {
        // startTransition: ScenarioRunner writes '(EVENT)<name>-START' when the
        // event's actions initialise, i.e. on the tick its own trigger fires.
        if (trigger.neverFires) return false;
        if (trigger.watchActorId) {
          const firedAt = _tickStarted.get(`${trigger.watchActorId}::${trigger.event_id}`);
          return firedAt != null && firedAt <= simTime;
        }
        const rec = sim.fired.get(trigger.event_id);
        return !!rec && rec.firedAt <= simTime;
      }
      case 'ego_speed': {
        // TriggerVelocity on hero: CarlaDataProvider's per-tick velocity map,
        // hence the snapshot. No ego → 0, like get_velocity's own fallback.
        const v = _tickSpeeds.get(run.egoId) ?? 0;
        const limit = trigger.value ?? 10;
        return trigger.rule === 'lessThan' ? v < limit : v > limit;
      }
      default:
        return false;
    }
  }

  /** The relative set_speed target as ChangeActorTargetSpeed computes it from
   * the reference's (snapshotted) speed: + delta, or × factor. */
  function _relativeTarget(sim) {
    const ref = _refSpeed(sim.speedRelativeRef);
    return sim.speedRelativeFactor != null ? ref * sim.speedRelativeFactor : ref + sim.speedRelativeDelta;
  }

  SimCore.define({ _actionEmits, _normalizeEventsForSim, _triggerSatisfied, _relativeTarget });
})();
