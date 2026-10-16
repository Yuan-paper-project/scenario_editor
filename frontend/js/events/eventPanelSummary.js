/**
 * eventPanelSummary.js — event labels, display names and the one-line action and trigger summaries.
 *
 * Part of the event panel (EventPanel); see eventPanel.js.
 */
(() => {
  'use strict';

  const {
    EVENT_ACTIONS,
    DEFAULT_EGO_SPEED,
    DEFAULT_SPEED_TIME,
    DEFAULT_SPEED_RATE,
    DEFAULT_LANE_OFFSET_M,
    DEFAULT_SPEED_FACTOR,
    _speedMode,
    _speedDimension,
    _defaultRelativeActorId,
    _defaultPointTriggerActorId,
    _eventAction,
    _eventTrigger,
  } = EventPanelCore.shared;

  // ── Summaries And Labels ────────────────────────────────────────────────────

  function _eventActionLabel(actionType) {
    return (EVENT_ACTIONS.find(([value]) => value === (actionType || 'follow_trajectory')) || EVENT_ACTIONS[0])[1];
  }

  function _eventDisplayName(ev, index) {
    return `${_eventActionLabel(_eventAction(ev).type)} ${index + 1}`;
  }

  function _eventTriggerSummary(ev, events, actor) {
    // A route's trigger is discarded at export, so the stored one must not be shown.
    if (_eventAction(ev).type === 'assign_route') return 'startet sofort (fest)';
    const trigger = _eventTrigger(ev);
    if (ScenarioRules.isEventRef(trigger)) {
      const prefix = trigger.type === 'event_started' ? 'Mit Start von' : 'Nach';
      const target = ScenarioRules.afterEventTarget(actor, trigger, events);
      if (!target) return `${prefix} Event`;
      const name = _eventDisplayName(target.event, target.index);
      // Name the owner only when it is another actor.
      return target.actor.id === actor.id
        ? `${prefix} ${name}`
        : `${prefix} ${name} (${AppState.actorLabel(target.actor, { short: true })})`;
    }
    if (trigger.type === 'ego_speed') {
      const sign = trigger.rule === 'lessThan' ? '<' : '>';
      return `Ego ${sign} ${UIUtils.fmt(trigger.value ?? DEFAULT_EGO_SPEED)} m/s`;
    }
    if (trigger.type === 'relative_speed') {
      const sign = trigger.rule === 'lessThan' ? '<' : '>';
      return `v(${_eventActorLabel(trigger.entity_ref)}) − eigene ${sign} ${UIUtils.fmt(trigger.value ?? 0)} m/s`;
    }
    if (trigger.type === 'distance_to_ego' && trigger.entity_ref && trigger.entity_ref !== AppState.ego?.id) {
      return `Abstand zu ${_eventActorLabel(trigger.entity_ref)} ${UIUtils.fmt(trigger.value ?? 0, 0)}m`;
    }
    const pointTarget = trigger.entity_ref || _defaultPointTriggerActorId(actor);
    const triggerLabels = {
      simulation_time: `Nach ${UIUtils.fmt(trigger.value ?? 0)}s`,
      distance_to_ego: `Ego-Abstand ${UIUtils.fmt(trigger.value ?? 0, 0)}m`,
      distance_to_point: `${trigger.point?.name || 'Punkt'} ${UIUtils.fmt(trigger.value ?? 20, 0)}m zu ${_eventActorLabel(pointTarget)}`,
    };
    return triggerLabels[trigger.type];
  }

  function _eventActorLabel(actorId) {
    // Short spelling ('EGO'), to match AUTO 1 etc. in the same dropdown.
    const actor = AppState.findById(actorId);
    return actor ? AppState.actorLabel(actor, { short: true }) : AppState.actorLabel(AppState.ego, { short: true });
  }

  function _eventActionSummary(ev, actor) {
    const action = _eventAction(ev);
    const target = action.target || {};
    const dynamics = action.dynamics || {};
    const speedMode = _speedMode(ev);
    // A hold vs a ramp that ends on arrival — it decides when a chained after_event fires.
    const speedDynamicsSummary =
      _speedDimension(ev) === 'rate'
        ? `mit ${UIUtils.fmt(dynamics.value ?? DEFAULT_SPEED_RATE)} m/s²`
        : `für ${UIUtils.fmt(dynamics.value ?? DEFAULT_SPEED_TIME)}s`;
    const relativeSpeedTarget = target.entity_ref || _defaultRelativeActorId(actor);
    const distanceTarget = action.entity_ref || _defaultRelativeActorId(actor);
    // Against the emitter's minimum of 2: one waypoint draws nothing and is dropped at export.
    const trajectoryPoints = (action.trajectory || []).length;
    const routePoints = (action.waypoints || []).length;
    const trajectoryVisible = MapView.isTrajectoryVisible(actor.id, ev.id);
    const routeVisible = MapView.isRouteVisible(actor.id, ev.id);
    const partial = (n) => `unvollständig (${n} Wegpunkt${n === 1 ? '' : 'e'})`;
    const actionLabels = {
      follow_trajectory:
        trajectoryPoints >= 2
          ? `Pfad gezeichnet, ${UIUtils.fmt(_trajectorySpeed(action.trajectory))} m/s${trajectoryVisible ? '' : ', ausgeblendet'}`
          : trajectoryPoints > 0
            ? `Pfad ${partial(trajectoryPoints)}`
            : 'Pfad nicht gezeichnet',
      assign_route:
        routePoints >= 2
          ? `Route gezeichnet${routeVisible ? '' : ', ausgeblendet'}`
          : routePoints > 0
            ? `Route ${partial(routePoints)}`
            : 'Route nicht gezeichnet',
      set_speed:
        speedMode === 'relative'
          ? `${
              target.value_type === 'factor'
                ? `${UIUtils.fmt(target.factor ?? DEFAULT_SPEED_FACTOR, 2)}×`
                : `${UIUtils.fmt(target.delta ?? 10)} m/s`
            } relativ zu ${
              relativeSpeedTarget === actor.id ? 'eigener Geschw.' : _eventActorLabel(relativeSpeedTarget)
            } ${target.continuous === true && relativeSpeedTarget !== actor.id ? 'dauerhaft' : speedDynamicsSummary}`
          : `${UIUtils.fmt(target.value ?? 10)} m/s${target.reverse === true ? ' rückwärts' : ''} ${speedDynamicsSummary}`,
      set_distance: `${action.axis === 'lateral' ? 'Lateral' : 'Longitudinal'} ${UIUtils.fmt(action.value ?? 10)} m relativ zu ${_eventActorLabel(distanceTarget)}`,
      lane_change: `${action.direction === 'right' ? 'Rechts' : 'Links'} innerhalb ${UIUtils.fmt(dynamics.value ?? 12)} m`,
      // 'dauerhaft' belongs in the collapsed summary; an offset of 0 names no side.
      lane_offset:
        (action.offset ?? DEFAULT_LANE_OFFSET_M) > 0
          ? `${action.direction === 'right' ? 'Rechts' : 'Links'} ${UIUtils.fmt(action.offset ?? DEFAULT_LANE_OFFSET_M)} m, ${
              action.continuous === false ? 'hin & zurück' : 'dauerhaft'
            }`
          : 'Zurück zur Spurmitte, dauerhaft',
    };
    return actionLabels[action.type];
  }

  /**
   * The one speed CARLA drives a trajectory at (length ÷ time); a legacy file
   * with differing vertex velocities shows the average, as the preview drives.
   */
  function _trajectorySpeed(points) {
    let dist = 0,
      time = 0;
    for (let i = 1; i < points.length; i++) {
      const d = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      const v = ((points[i - 1].velocity ?? 10) + (points[i].velocity ?? 10)) / 2 || 1;
      dist += d;
      time += d / v;
    }
    if (time > 0) return dist / time;
    return points[0]?.velocity ?? 10;
  }

  EventPanelCore.define({
    _eventDisplayName,
    _eventTriggerSummary,
    _eventActionSummary,
    _trajectorySpeed,
  });
})();
