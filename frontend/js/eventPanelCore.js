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

  // UI-facing strings are German throughout (see CLAUDE.md); the internal
  // action/trigger keys stay the OpenSCENARIO-side snake_case names and are
  // what every other layer matches on.
  const EVENT_ACTIONS = [
    ['follow_trajectory', 'Trajektorie folgen'],
    ['assign_route', 'Route zuweisen'],
    // Abbreviated to match the in-card 'Geschw.' field label and to keep the
    // longest card title ('Geschw. setzen 2') on one header line.
    ['set_speed', 'Geschw. setzen'],
    ['set_distance', 'Abstand halten'],
    ['lane_change', 'Spurwechsel'],
    ['lane_offset', 'Spurversatz'],
  ];
  // Kept in EVENT_ACTIONS so a loaded event still gets its label and card, but
  // not offered in the grid. set_distance is hidden by decision: it emits no
  // DynamicConstraints, so KeepLongitudinalGap chases at its 100 m/s default
  // whenever the gap is too large, and the preview does not simulate it.
  const HIDDEN_ACTIONS = new Set(['set_distance']);

  // distance_to_ego is omitted for the ego itself — a distance from hero to
  // hero is always 0, so the condition would fire on tick 1 regardless of
  // the configured value. See _defaultFirstTrigger.
  //
  // after_event fires when the named event COMPLETES, event_started the moment
  // it STARTS (startTransition) — "when X happens, also do Y". Both are the
  // same reference machinery (ScenarioRules.isEventRef); see the dropdown
  // rules in _afterEventGroups. ego_speed reads the ego's own speed, which is
  // one of the things an NPC may legitimately react to now that it may not
  // wait on an ego EVENT (ScenarioRules.mayWaitOnActor).
  //
  // distance_to_ego is „Abstand zu Akteur": the distance from another actor
  // (entity_ref; absent = the ego, which every older payload means) to this
  // one. relative_speed is that actor's speed minus this one's.
  const EVENT_TRIGGERS = [
    ['simulation_time', 'Simulationszeit'],
    ['distance_to_ego', 'Abstand zu Akteur'],
    ['distance_to_point', 'Abstand zu einem Punkt'],
    ['ego_speed', 'Ego-Geschwindigkeit'],
    ['relative_speed', 'Geschw.-Differenz'],
    ['after_event', 'Nach anderem Event'],
    ['event_started', 'Mit Start eines Events'],
  ];

  // SpeedCondition's two useful rules. equalTo is left out on purpose: a
  // measured speed is almost never exactly equal to anything.
  const EGO_SPEED_RULES = [
    ['greaterThan', 'schneller als'],
    ['lessThan', 'langsamer als'],
  ];
  const DEFAULT_EGO_SPEED = 10;

  // relative_speed: speed(other actor) − speed(this actor), RelativeSpeedCondition.
  const RELATIVE_SPEED_RULES = [
    ['greaterThan', 'größer als'],
    ['lessThan', 'kleiner als'],
  ];
  const DEFAULT_RELATIVE_SPEED = 2;

  // A freshly chosen distance_to_point starts as a small ring around the point
  // rather than inheriting the outgoing trigger's value, which is a delay in
  // seconds or a 400 m ego distance and means nothing as a radius.
  const DEFAULT_POINT_RADIUS = 5;

  // set_speed's dynamics value means a different physical quantity per
  // dimension, so switching re-defaults it — 5 is a nonsense rate and 2.5 a
  // nonsense duration. 2.5 m/s² is ≈0.25 g, everyday accel/brake.
  const SPEED_DIMENSIONS = [
    ['time', 'für'],
    ['rate', 'Rate'],
  ];
  const DEFAULT_SPEED_TIME = 5.0;
  const DEFAULT_SPEED_RATE = 2.5;

  // Half a lane's width is a drift that reads clearly on the map and in CARLA
  // without leaving the lane; the backend clamps the magnitude to 10 m.
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

  /* Panel state reassigned at runtime. `refresh` re-renders the properties
   * panel (properties.js sets it). `highlight` is the card the „Ablauf"
   * timeline last pointed at ({actorId, eventId, scroll}) — module state
   * because the panel re-renders on every preview frame: the mark has to be
   * re-applied by each render, and the scroll done only once. A collapsed card
   * shows expanded while marked — view only, its stored `collapsed` is
   * untouched. eventTimeline.js clears it on Stop. */
  const panel = { refresh: () => {}, highlight: null };

  // ── Actor References And Toggles ────────────────────────────────────────────

  function _speedMode(ev) {
    const target = _eventAction(ev).target || {};
    return target.mode === 'relative' ? 'relative' : 'absolute';
  }

  /** Only the two dimensions the panel offers. A hand-written or LLM payload
   * carrying 'distance' renders (and, once edited, saves) as 'time' — the same
   * coercion the field did unconditionally before the toggle existed. */
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
