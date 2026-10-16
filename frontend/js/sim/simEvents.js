/**
 * simEvents.js — the export-normalisation mirror and trigger evaluation.
 *
 * Part of the in-editor preview (Simulate); see simulate.js.
 */
(() => {
  'use strict';

  const { run, _simActors, _tickSpeeds, _tickPoses, _tickCompleted, _tickStarted, DISTANCE_TO_EGO_FALLBACK_S, _pose } =
    SimCore.shared;

  // ── Event normalisation mirror (backend event_normalize.py / event_rules.py) ─
  // Export rewrites that change which trigger governs an event, in the backend's order:
  // per-event coercion, the after_event→assign_route rewrite, then the ego self-distance one.

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

    // Scenario-wide like _normalize_after_event_chains: the target may be another actor's.
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

    // Not a backend rewrite: a reference to an event the export drops, or on a cycle, never
    // fires. The export gate refuses both; this is for loaded files.
    for (const ev of events) {
      if (!ScenarioRules.isEventRef(ev.trigger)) continue;
      const target = ScenarioRules.afterEventTarget(actor, ev.trigger);
      // Also never: after_event on a never-completing event, and an NPC waiting on the ego.
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

  /** The reference's speed from the per-tick snapshot (as get_velocity's per-tick map); 0 if missing. */
  function _refSpeed(id) {
    const ref = id || run.egoId; // an omitted entity_ref exports as `hero`
    return _tickSpeeds.has(ref) ? _tickSpeeds.get(ref) : 0;
  }

  /** True while the condition holds (level-sensitive, like every OpenSCENARIO condition). */
  function _triggerSatisfied(trigger, sim, egoPrevPos, simTime) {
    switch (trigger.type) {
      case 'simulation_time':
        return simTime > (trigger.value ?? 0);
      case 'distance_to_ego': {
        // The 60 s OR-fallback the emitter adds to every distance_to_ego.
        if (simTime > DISTANCE_TO_EGO_FALLBACK_S) return true;
        const other =
          trigger.entity_ref && trigger.entity_ref !== run.egoId ? _tickPoses.get(trigger.entity_ref) : egoPrevPos;
        if (!other) return false;
        return UIUtils.dist3(_pose(sim), other) < (trigger.value ?? 400);
      }
      case 'relative_speed': {
        // speed(other) − speed(this), both magnitudes, from the snapshot.
        const diff = _refSpeed(trigger.entity_ref) - (_tickSpeeds.get(sim.id) ?? 0);
        const limit = trigger.value ?? 0;
        return trigger.rule === 'lessThan' ? diff < limit : diff > limit;
      }
      case 'distance_to_point': {
        const point = trigger.point;
        if (!point) return false;
        // The triggering entity is entity_ref (default hero), not necessarily the owner.
        const triggerActor = _resolveSimRef(trigger.entity_ref) || _simActors.get(run.egoId) || sim;
        return (
          UIUtils.dist3(_pose(triggerActor), { x: point.x, y: point.y, z: point.z ?? 0.2 }) < (trigger.value ?? 20)
        );
      }
      case 'after_event': {
        if (trigger.neverFires) return false;
        // A cross-actor reference reads the other actor's completion from the tick snapshot.
        if (trigger.watchActorId) {
          const completedAt = _tickCompleted.get(`${trigger.watchActorId}::${trigger.event_id}`);
          return completedAt != null && completedAt <= simTime;
        }
        const rec = sim.fired.get(trigger.event_id);
        return !!rec && rec.completedAt != null && rec.completedAt <= simTime;
      }
      case 'event_started': {
        // '(EVENT)<name>-START' is written on the tick the event's own trigger fires.
        if (trigger.neverFires) return false;
        if (trigger.watchActorId) {
          const firedAt = _tickStarted.get(`${trigger.watchActorId}::${trigger.event_id}`);
          return firedAt != null && firedAt <= simTime;
        }
        const rec = sim.fired.get(trigger.event_id);
        return !!rec && rec.firedAt <= simTime;
      }
      case 'ego_speed': {
        // The ego's measured speed from the snapshot; no ego → 0.
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
