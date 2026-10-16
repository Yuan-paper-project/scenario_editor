/**
 * eventPanelCore.js — DOM handles, constants, the shared panel state, event accessors and actor-reference getters.
 *
 * Part of the event panel (EventPanel); see eventPanel.js.
 */
(() => {
  'use strict';

  window.EventPanelCore = UIUtils.sharedScope('EventPanelCore');

  const eventSection = document.getElementById('event-section');
  const eventActionGrid = document.getElementById('event-action-grid');
  const eventList = document.getElementById('event-list');
  const eventCount = document.getElementById('event-count');
  const eventWarn = document.getElementById('event-warn');

  // German labels; the keys are the OpenSCENARIO-side names the other layers match on.
  const EVENT_ACTIONS = [
    ['follow_trajectory', 'Trajektorie folgen'],
    ['assign_route', 'Route zuweisen'],
    // Short, so 'Geschw. setzen 2' fits on the card header.
    ['set_speed', 'Geschw. setzen'],
    ['set_distance', 'Abstand halten'],
    ['lane_change', 'Spurwechsel'],
    ['lane_offset', 'Spurversatz'],
  ];
  // Still rendered when loaded, never offered: it would chase at 100 m/s (CLAUDE.md, set_distance).
  const HIDDEN_ACTIONS = new Set(['set_distance']);

  // distance_to_ego is „Abstand zu Akteur": entity_ref names the other actor, absent = the ego.
  const EVENT_TRIGGERS = [
    ['simulation_time', 'Simulationszeit'],
    ['distance_to_ego', 'Abstand zu Akteur'],
    ['distance_to_point', 'Abstand zu einem Punkt'],
    ['ego_speed', 'Ego-Geschwindigkeit'],
    ['relative_speed', 'Geschw.-Differenz'],
    ['after_event', 'Nach anderem Event'],
    ['event_started', 'Mit Start eines Events'],
  ];

  // equalTo left out: a measured speed is almost never exactly equal to anything.
  const EGO_SPEED_RULES = [
    ['greaterThan', 'schneller als'],
    ['lessThan', 'langsamer als'],
  ];
  const DEFAULT_EGO_SPEED = 10;

  // speed(other actor) − speed(this actor), as RelativeSpeedCondition computes it.
  const RELATIVE_SPEED_RULES = [
    ['greaterThan', 'größer als'],
    ['lessThan', 'kleiner als'],
  ];
  const DEFAULT_RELATIVE_SPEED = 2;

  // Not inherited from the outgoing trigger, whose value is seconds or an ego distance.
  const DEFAULT_POINT_RADIUS = 5;

  // Each dimension has its own default (switching re-defaults); 2.5 m/s² ≈ 0.25 g.
  const SPEED_DIMENSIONS = [
    ['time', 'für'],
    ['rate', 'Rate'],
  ];
  const DEFAULT_SPEED_TIME = 5.0;
  const DEFAULT_SPEED_RATE = 2.5;

  // The backend clamps the magnitude to 10 m.
  const DEFAULT_LANE_OFFSET_M = 1.0;
  const MAX_LANE_OFFSET_M = 10.0;
  // Used for the „½ Spur" / „1 Spur" presets when no lane is found under the actor.
  const FALLBACK_LANE_WIDTH_M = 3.5;
  const DEFAULT_SPEED_FACTOR = 0.8;

  const RETURN_LANE_OFFSET_HINT =
    'Endet, sobald der Versatz erreicht ist (auf 0,1 m), und kehrt dann zur Spurmitte ' +
    'zurück — ein Schlenker in einem Event, an den „Nach anderem Event" anschließen kann. ' +
    'Braucht den lokalen ScenarioRunner-Patch (ChangeActorLaneOffset); ' +
    'ein unveränderter ScenarioRunner 0.9.15 setzt den Versatz sofort zurück.';

  const CONTINUOUS_SPEED_HINT =
    'Folgt der Geschwindigkeit des Bezugsakteurs dauerhaft (continuous="true") — ' +
    'endet erst, wenn ein anderes Geschwindigkeits- oder Trajektorien-Event übernimmt.';

  const FIXED_LANE_OFFSET_HINT =
    'Ein Spurversatz gilt dauerhaft (continuous="true") — er endet erst, wenn ' +
    'ein weiterer Spurversatz oder ein Pfad-Event den Akteur übernimmt. ' +
    'Zurück zur Spurmitte: ein zweites Spurversatz-Event mit 0 m.';

  const FIXED_ROUTE_START_HINT =
    'Eine Route startet immer sofort (Simulationszeit 0) — der Auslöser ist nicht einstellbar.';

  /* `refresh` re-renders the properties panel (set by properties.js). `highlight`
   * is the card the Ablauf timeline marked, {actorId, eventId, scroll}. */
  const panel = { refresh: () => {}, highlight: null };

  // ── Actor References And Toggles ────────────────────────────────────────────

  function _speedMode(ev) {
    const target = _eventAction(ev).target || {};
    return target.mode === 'relative' ? 'relative' : 'absolute';
  }

  /** A payload carrying 'distance' renders, and once edited saves, as 'time'. */
  function _speedDimension(ev) {
    const dynamics = _eventAction(ev).dynamics || {};
    return dynamics.dimension === 'rate' ? 'rate' : 'time';
  }

  function _defaultRelativeActorId(actor) {
    if (AppState.ego && AppState.ego.id !== actor?.id) return AppState.ego.id;
    const fallback = AppState.npcs.find((n) => n.id !== actor?.id);
    return fallback ? fallback.id : '';
  }

  function _relativeActorOptions(actor) {
    const options = [];
    if (AppState.ego && AppState.ego.id !== actor?.id) {
      options.push([AppState.ego.id, 'Ego']);
    }
    AppState.npcs.filter((n) => n.id !== actor?.id).forEach((n) => options.push([n.id, AppState.actorLabel(n)]));
    return options;
  }

  function _defaultPointTriggerActorId(actor) {
    return AppState.ego?.id || actor?.id || '';
  }

  function _triggerActorOptions(actor) {
    const options = [];
    if (AppState.ego) {
      options.push([AppState.ego.id, AppState.actorLabel(AppState.ego, { short: true })]);
    }
    if (actor?.id && actor.id !== AppState.ego?.id) {
      options.push([actor.id, AppState.actorLabel(actor)]);
    }
    AppState.npcs.filter((n) => n.id !== actor?.id).forEach((n) => options.push([n.id, AppState.actorLabel(n)]));
    return options;
  }

  function _eventAction(ev) {
    return ev.action || { type: 'follow_trajectory' };
  }

  function _eventTrigger(ev) {
    return ev.trigger || { type: 'simulation_time', value: 0 };
  }

  function _patchEventAction(actor, ev, patch) {
    const currentEvent = _currentEvent(actor.id, ev.id) || ev;
    _updateEvent(actor, ev.id, { action: { ..._eventAction(currentEvent), ...patch } });
  }

  function _patchEventTrigger(actor, ev, patch) {
    const currentEvent = _currentEvent(actor.id, ev.id) || ev;
    _updateEvent(actor, ev.id, { trigger: { ..._eventTrigger(currentEvent), ...patch } });
  }

  function _updateEvent(actor, eventId, patch) {
    const currentActor = AppState.findById(actor.id) || actor;
    const events = (currentActor.events || []).map((ev) => (ev.id === eventId ? { ...ev, ...patch } : ev));
    AppState.updateById(currentActor.id, { events });
  }

  function _currentEvent(actorId, eventId) {
    const actor = AppState.findById(actorId);
    return (actor?.events || []).find((ev) => ev.id === eventId) || null;
  }

  EventPanelCore.define({
    eventSection,
    eventActionGrid,
    eventList,
    eventCount,
    eventWarn,
    EVENT_ACTIONS,
    HIDDEN_ACTIONS,
    EVENT_TRIGGERS,
    EGO_SPEED_RULES,
    DEFAULT_EGO_SPEED,
    RELATIVE_SPEED_RULES,
    DEFAULT_RELATIVE_SPEED,
    DEFAULT_POINT_RADIUS,
    SPEED_DIMENSIONS,
    DEFAULT_SPEED_TIME,
    DEFAULT_SPEED_RATE,
    DEFAULT_LANE_OFFSET_M,
    MAX_LANE_OFFSET_M,
    FALLBACK_LANE_WIDTH_M,
    DEFAULT_SPEED_FACTOR,
    RETURN_LANE_OFFSET_HINT,
    CONTINUOUS_SPEED_HINT,
    FIXED_LANE_OFFSET_HINT,
    FIXED_ROUTE_START_HINT,
    panel,
    _speedMode,
    _speedDimension,
    _defaultRelativeActorId,
    _relativeActorOptions,
    _defaultPointTriggerActorId,
    _triggerActorOptions,
    _eventAction,
    _eventTrigger,
    _patchEventAction,
    _patchEventTrigger,
    _updateEvent,
    _currentEvent,
  });
})();
