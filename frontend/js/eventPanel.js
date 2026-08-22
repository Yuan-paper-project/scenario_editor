/**
 * eventPanel.js — event action/trigger editor for the properties panel.
 * Shared by the ego and every NPC; the ego has no distance_to_ego trigger
 * option (see EVENT_TRIGGERS) since a distance from hero to itself is always
 * 0, but is otherwise editable exactly like an NPC.
 */
(function () {
  'use strict';

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
  ];

  // distance_to_ego is omitted for the ego itself — a distance from hero to
  // hero is always 0, so the condition would fire on tick 1 regardless of
  // the configured value. See _defaultFirstTrigger.
  const EVENT_TRIGGERS = [
    ['simulation_time', 'Simulationszeit'],
    ['distance_to_ego', 'Abstand zum Ego'],
    ['distance_to_point', 'Abstand zu einem Punkt'],
    ['after_event', 'Nach anderem Event'],
  ];

  // A freshly chosen distance_to_point starts as a small ring around the point
  // rather than inheriting the outgoing trigger's value, which is a delay in
  // seconds or a 400 m ego distance and means nothing as a radius.
  const DEFAULT_POINT_RADIUS = 5;

  // set_speed's dynamics value means a different physical quantity per
  // dimension, so switching re-defaults it — 5 is a nonsense rate and 2.5 a
  // nonsense duration. 2.5 m/s² is ≈0.25 g, everyday accel/brake.
  const SPEED_DIMENSIONS = [
    ['time', 'Zeit'],
    ['rate', 'Rate'],
  ];
  const DEFAULT_SPEED_TIME = 5.0;
  const DEFAULT_SPEED_RATE = 2.5;

  const FIXED_ROUTE_START_HINT =
    'Eine Route startet immer sofort (Simulationszeit 0) — der Auslöser ist nicht einstellbar.';

  let _refresh = () => {};

  // ── Public API ──────────────────────────────────────────────────────────────

  function render(actor) {
    _renderEventActionGrid(actor);
    _renderEventList(actor);
  }

  function setRefreshHandler(handler) {
    _refresh = typeof handler === 'function' ? handler : () => {};
  }

  // ── Event Rendering ─────────────────────────────────────────────────────────

  function _renderEventActionGrid(actor) {
    if (!eventActionGrid) return;
    eventActionGrid.innerHTML = '';
    if (!actor) return;

    const hasPathEvent = (actor.events || []).some(ev => {
      const type = _eventAction(ev).type;
      return type === 'follow_trajectory' || type === 'assign_route';
    });

    EVENT_ACTIONS.forEach(([actionType, label]) => {
      const isPathAction = actionType === 'follow_trajectory' || actionType === 'assign_route';
      // AssignRouteAction is vehicle-only downstream (_ROUTE_ACTION_TYPES in
      // event_builders.py). Offering it to a Fußgänger produced an event that
      // was silently dropped at export — along with anything chained onto it.
      const routeUnavailable = actionType === 'assign_route' &&
        !ScenarioRules.ROUTE_ACTION_TYPES.has(actor.type);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'event-action-button';
      btn.textContent = label;
      // The two path actions used to be *removed* once a path event existed,
      // reflowing the grid with nothing to explain where they went. Keeping
      // them disabled states the rule instead of hiding its consequence.
      if (routeUnavailable || (isPathAction && hasPathEvent)) {
        btn.disabled = true;
        btn.title = routeUnavailable
          ? 'Eine Route ist nur für Fahrzeuge möglich — für Personen die Trajektorie verwenden'
          : 'Pro Akteur ist nur ein Pfad-Event erlaubt';
        eventActionGrid.appendChild(btn);
        return;
      }
      btn.addEventListener('click', () => {
        eventSection.classList.remove('collapsed');
        const sectionHeader = eventSection.querySelector('.event-section-header');
        const indicator = sectionHeader?.querySelector('.collapse-indicator');
        if (indicator) indicator.textContent = '-';
        sectionHeader?.setAttribute('aria-expanded', 'true');
        const currentEvents = actor.events || [];
        const newEvent = _defaultEvent(actor, actionType, isPathAction);
        const events = isPathAction ? [newEvent, ...currentEvents] : [...currentEvents, newEvent];
        // One undo entry for the whole click. A path action also seeds waypoint
        // 1 with the actor's own pose (startPathMode), which is a second
        // `{events}` patch — ungrouped, Strg+Z would leave the event in place
        // with an empty path rather than removing what the click created.
        UndoStack.group('Event hinzugefügt', () => {
          AppState.updateById(actor.id, { events });
          if (isPathAction) {
            ObjectsManager.startPathMode(actor.id, actionType === 'assign_route' ? 'route' : 'trajectory', newEvent.id);
          }
        });
      });
      eventActionGrid.appendChild(btn);
    });
  }

  function _renderEventList(actor) {
    if (!eventList) return;
    eventList.innerHTML = '';
    const events = actor.events || [];
    if (eventCount) eventCount.textContent = String(events.length);

    // Events that will not survive the export, keyed by id. The rule lives in
    // ScenarioRules (app.js) so the card, the export gate and the preview can
    // never disagree about what "incomplete" means.
    const problems = new Map(
      ScenarioRules.problemsOf(actor).map(entry => [entry.ev.id, entry.problem])
    );
    if (eventWarn) {
      eventWarn.textContent = String(problems.size);
      eventWarn.classList.toggle('hidden', problems.size === 0);
      eventWarn.title = problems.size === 1
        ? '1 Event wird beim Export verworfen'
        : `${problems.size} Events werden beim Export verworfen`;
    }

    if (events.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'event-empty';
      empty.textContent = 'Noch keine Events definiert.';
      eventList.appendChild(empty);
      return;
    }

    if (events.length > 1) eventList.appendChild(_bulkCollapseBar(actor, events));

    // Which card the map clicks currently belong to. Event ids are only unique
    // within an actor (every actor's first event is `evt-1`), so this checks
    // the owner too.
    const pathOwnerId = AppState.activeTrajectoryId || AppState.activeRouteId;
    const drawingEventId = pathOwnerId === actor.id ? AppState.activePathEventId : null;

    events.forEach((ev, i) => {
      const action = _eventAction(ev);
      const actionType = action.type || 'follow_trajectory';
      const displayName = _eventDisplayName(ev, i);
      const triggerSummary = _eventTriggerSummary(ev, events, actor);
      const card = document.createElement('div');
      const isCollapsed = !!ev.collapsed;
      const isDrawing = drawingEventId === ev.id;
      const problem = problems.get(ev.id) || null;
      card.className = `event-card${isCollapsed ? ' collapsed' : ''}` +
        `${isDrawing ? ' active-draw' : ''}${problem ? ' has-problem' : ''}`;

      const header = document.createElement('div');
      header.className = 'event-card-header';

      const collapseBtn = document.createElement('button');
      collapseBtn.className = 'event-collapse';
      collapseBtn.type = 'button';
      collapseBtn.textContent = isCollapsed ? '+' : '-';
      collapseBtn.title = isCollapsed ? 'Event ausklappen' : 'Event einklappen';
      collapseBtn.setAttribute('aria-label', collapseBtn.title);
      collapseBtn.setAttribute('aria-expanded', String(!isCollapsed));
      collapseBtn.addEventListener('click', () => {
        _updateEvent(actor, ev.id, { collapsed: !isCollapsed });
      });

      const nameText = document.createElement('div');
      nameText.className = 'event-title-text';
      nameText.textContent = displayName;
      nameText.title = displayName;

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'event-delete';
      deleteBtn.type = 'button';
      deleteBtn.textContent = '×';
      deleteBtn.title = 'Event löschen';
      deleteBtn.setAttribute('aria-label', deleteBtn.title);
      deleteBtn.addEventListener('click', () => _deleteEvent(actor, ev.id));

      header.appendChild(collapseBtn);
      header.appendChild(nameText);
      header.appendChild(deleteBtn);
      card.appendChild(header);

      // The summary is the *collapsed* reading of the card — action and trigger
      // in one line. An expanded card shows both in editable form directly
      // below, so repeating them there was two rows of pure duplication.
      if (isCollapsed) {
        card.appendChild(_summaryLine(ev, actor, actionType, triggerSummary));
        if (problem) card.appendChild(_problemChip(problem));
        eventList.appendChild(card);
        return;
      }

      // Directly under the header, before the trigger: this is the reason the
      // rest of the card will not happen, so it reads first.
      if (problem) card.appendChild(_problemChip(problem));

      // WENN before DANN: the trigger goes first, the action controls below it.
      // An assign_route has no trigger *controls* — its start is discarded and
      // forced to simulation_time 0 at export — but it still gets the block, as
      // a stated fact. Dropping it entirely would leave the only card in the
      // panel whose start condition is stated nowhere.
      card.appendChild(actionType === 'assign_route'
        ? _fixedTriggerBlock()
        : _triggerBlock(actor, ev, events));

      if (actionType === 'set_speed') {
        _appendSpeedActionControls(card, actor, ev, action);
      } else if (actionType === 'set_distance') {
        _appendDistanceActionControls(card, actor, ev, action);
      } else if (actionType === 'lane_change') {
        _appendLaneChangeControls(card, actor, ev, action);
      } else {
        _appendEventPathControls(card, actor, ev);
        const pathList = document.createElement('div');
        pathList.className = 'event-waypoint-list waypoint-list';
        _renderPathList(actor, actionType === 'assign_route' ? 'route' : 'trajectory', pathList, ev);
        card.appendChild(pathList);
      }

      eventList.appendChild(card);
    });

    syncWaypointSelection();
  }

  /**
   * `<action> • <trigger>` — the whole event in one line, for a collapsed card.
   * The trigger used to sit in the header opposite the title, where it was
   * capped at 120px and ellipsised while the summary below it had a full line
   * to itself; the two belong together and read as one sentence.
   */
  function _summaryLine(ev, actor, actionType, triggerSummary) {
    const line = document.createElement('div');
    line.className = 'event-summary';

    const actionText = document.createElement('span');
    actionText.textContent = _eventActionSummary(ev, actor);
    line.appendChild(actionText);

    const separator = document.createElement('span');
    separator.className = 'event-summary-sep';
    separator.setAttribute('aria-hidden', 'true');
    separator.textContent = '•';
    line.appendChild(separator);

    const triggerText = document.createElement('span');
    triggerText.className = 'event-summary-trigger';
    triggerText.textContent = triggerSummary;
    if (actionType === 'assign_route') {
      triggerText.classList.add('fixed');
      triggerText.title = FIXED_ROUTE_START_HINT;
    }
    line.appendChild(triggerText);
    return line;
  }

  /** „⚠ <Grund>" — why this card will not reach the exported file. */
  function _problemChip(problem) {
    const chip = document.createElement('div');
    chip.className = 'event-problem';
    chip.setAttribute('role', 'status');
    const icon = document.createElement('span');
    icon.className = 'event-problem-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '⚠';
    const text = document.createElement('span');
    text.textContent = problem.short;
    chip.title = `Dieses Event wird beim Export verworfen: ${problem.message}.`;
    chip.appendChild(icon);
    chip.appendChild(text);
    return chip;
  }

  function _triggerBlock(actor, ev, events) {
    const block = document.createElement('div');
    block.className = 'event-trigger-block';
    _appendEventTriggerControls(block, actor, ev, events);
    return block;
  }

  /** The WENN half of an assign_route card: a fact, not a control. */
  function _fixedTriggerBlock() {
    const block = document.createElement('div');
    block.className = 'event-trigger-block fixed';
    const label = document.createElement('span');
    label.className = 'event-fixed-trigger-label';
    label.textContent = 'Auslöser';
    const text = document.createElement('span');
    text.className = 'event-fixed-trigger-text';
    text.textContent = 'startet sofort (fest)';
    text.title = FIXED_ROUTE_START_HINT;
    block.appendChild(label);
    block.appendChild(text);
    return block;
  }

  /** Collapse/expand every card of this actor at once. */
  function _bulkCollapseBar(actor, events) {
    const bar = document.createElement('div');
    bar.className = 'event-list-toolbar';
    const allCollapsed = events.every(ev => !!ev.collapsed);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'event-bulk-toggle';
    btn.textContent = allCollapsed ? 'Alle ausklappen' : 'Alle einklappen';
    btn.addEventListener('click', () => {
      const current = AppState.findById(actor.id) || actor;
      AppState.updateById(actor.id, {
        events: (current.events || []).map(ev => ({ ...ev, collapsed: !allCollapsed })),
      });
    });
    bar.appendChild(btn);
    return bar;
  }

  // ── Action Controls ─────────────────────────────────────────────────────────

  function _appendSpeedActionControls(card, actor, ev, action) {
    const speedTarget = action.target || { mode: 'absolute', value: 10.0 };
    const speedDynamics = action.dynamics || { shape: 'step', dimension: 'time', value: 5.0 };
    const isRelativeSpeed = _speedMode(ev) === 'relative';
    card.appendChild(_row('Modus', _speedModeToggle(actor, ev)));
    if (isRelativeSpeed) {
      const targetOptions = _relativeActorOptions(actor);
      const selectedTarget = speedTarget.entity_ref || _defaultRelativeActorId(actor);
      const targetSelect = _select(targetOptions.length ? targetOptions : [['', 'Kein Akteur']], selectedTarget);
      targetSelect.disabled = targetOptions.length === 0;
      targetSelect.addEventListener('change', e => {
        _patchEventAction(actor, ev, {
          target: { ...speedTarget, mode: 'relative', entity_ref: e.target.value },
        });
      });
      card.appendChild(_row('Relativ zu', targetSelect));
    }
    card.appendChild(_row('Dynamik', _speedDimensionToggle(actor, ev)));

    const speedInput = document.createElement('input');
    speedInput.type = 'number';
    speedInput.max = '100';
    speedInput.step = '0.5';
    speedInput.value = UIUtils.fmt(isRelativeSpeed ? (speedTarget.delta ?? 10.0) : (speedTarget.value ?? 10.0));
    speedInput.addEventListener('change', e => {
      const parsed = parseFloat(e.target.value);
      const value = Number.isFinite(parsed) ? parsed : 0;
      _patchEventAction(actor, ev, {
        target: isRelativeSpeed
          ? { ...speedTarget, mode: 'relative', delta: value }
          : { ...speedTarget, mode: 'absolute', value: Math.max(0, value) },
      });
    });
    if (!isRelativeSpeed) speedInput.min = '0';

    const isRate = _speedDimension(ev) === 'rate';
    const dynFloor = isRate ? 0.1 : 0; // a rate of 0 never reaches its target
    const timeInput = document.createElement('input');
    timeInput.type = 'number';
    timeInput.min = String(dynFloor);
    timeInput.step = '0.1';
    timeInput.value = UIUtils.fmt(speedDynamics.value ?? (isRate ? DEFAULT_SPEED_RATE : DEFAULT_SPEED_TIME));
    timeInput.addEventListener('change', e => {
      _patchEventAction(actor, ev, {
        dynamics: {
          ...speedDynamics,
          shape: isRate ? 'linear' : (speedDynamics.shape || 'step'),
          dimension: isRate ? 'rate' : 'time',
          value: Math.max(dynFloor, parseFloat(e.target.value) || 0),
        },
      });
    });
    card.appendChild(_speedTimingRow(speedInput, timeInput, isRate));
  }

  function _appendDistanceActionControls(card, actor, ev, action) {
    card.appendChild(_row('Richtung', _axisToggle(actor, ev)));

    const targetOptions = _relativeActorOptions(actor);
    const selectedTarget = action.entity_ref || _defaultRelativeActorId(actor);
    const targetSelect = _select(targetOptions.length ? targetOptions : [['', 'Kein Akteur']], selectedTarget);
    targetSelect.disabled = targetOptions.length === 0;
    targetSelect.addEventListener('change', e => {
      _patchEventAction(actor, ev, { entity_ref: e.target.value });
    });
    card.appendChild(_row('Relativ zu', targetSelect));

    const distanceInput = document.createElement('input');
    distanceInput.type = 'number';
    distanceInput.step = '0.1';
    distanceInput.value = UIUtils.fmt(action.value ?? 10.0);
    distanceInput.addEventListener('change', e => {
      const parsed = parseFloat(e.target.value);
      _patchEventAction(actor, ev, { value: Number.isFinite(parsed) ? parsed : 0 });
    });
    // 'Sollabstand', not 'Distanz': lane_change's dynamics value is a distance
    // too, and the two meant different things under one label.
    card.appendChild(UIUtils.paramRow('Sollabstand', distanceInput, 'm'));
  }

  function _appendLaneChangeControls(card, actor, ev, action) {
    const laneDynamics = action.dynamics || { shape: 'linear', value: 12.0 };
    const directionSelect = _select([
      ['left', 'Links'],
      ['right', 'Rechts'],
    ], action.direction === 'right' ? 'right' : 'left');
    directionSelect.addEventListener('change', e => {
      _patchEventAction(actor, ev, { direction: e.target.value === 'right' ? 'right' : 'left' });
    });
    card.appendChild(_row('Richtung', directionSelect));

    const durationInput = document.createElement('input');
    durationInput.type = 'number';
    durationInput.min = '0';
    durationInput.step = '0.1';
    durationInput.value = UIUtils.fmt(laneDynamics.value ?? 12.0);
    durationInput.addEventListener('change', e => {
      _patchEventAction(actor, ev, {
        dynamics: {
          ...laneDynamics,
          shape: laneDynamics.shape || 'linear',
          value: Math.max(0, parseFloat(e.target.value) || 0),
        },
      });
    });
    // The lateral move happens over this distance — see _buildLaneChangePlan.
    // Kept short so it fits the shared 70px label column; the title carries
    // the long form.
    durationInput.title = 'Strecke, über die der Spurwechsel ausgeführt wird';
    card.appendChild(UIUtils.paramRow('Strecke', durationInput, 'm'));
  }

  // ── Summaries And Labels ────────────────────────────────────────────────────

  function _eventActionLabel(actionType) {
    return (EVENT_ACTIONS.find(([value]) => value === (actionType || 'follow_trajectory')) || EVENT_ACTIONS[0])[1];
  }

  function _eventDisplayName(ev, index) {
    return `${_eventActionLabel(_eventAction(ev).type)} ${index + 1}`;
  }

  function _eventTriggerSummary(ev, events, actor) {
    // An assign_route's own trigger is discarded at export — buildScenarioParams
    // and the backend both force simulation_time @ 0 — and the card offers no
    // trigger controls for it either. Advertising whatever a loaded file
    // happens to carry would be a straight lie about when the route starts.
    if (_eventAction(ev).type === 'assign_route') return 'startet sofort (fest)';
    const trigger = _eventTrigger(ev);
    if (trigger.type === 'after_event') {
      const refIndex = events.findIndex(other => other.id === trigger.event_id);
      return refIndex >= 0 ? `Nach ${_eventDisplayName(events[refIndex], refIndex)}` : 'Nach Event';
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
    // The short spelling: these sit beside AUTO 1 / FUSSGAENGER 2 in the same
    // dropdown, so 'EGO' matches their case and width where 'Ego-Fahrzeug'
    // would not. AppState.actorLabel owns both spellings.
    const actor = AppState.findById(actorId);
    return actor ? AppState.actorLabel(actor, { short: true })
                 : AppState.actorLabel(AppState.ego, { short: true });
  }

  function _eventActionSummary(ev, actor) {
    const action = _eventAction(ev);
    const target = action.target || {};
    const dynamics = action.dynamics || {};
    const speedMode = _speedMode(ev);
    // 'für Ns' is a hold; 'mit N m/s²' is a ramp that ends on arrival, not on a
    // clock — the wording has to distinguish them or the card lies about when
    // an after_event chained onto it will fire.
    const speedDynamicsSummary = _speedDimension(ev) === 'rate'
      ? `mit ${UIUtils.fmt(dynamics.value ?? DEFAULT_SPEED_RATE)} m/s²`
      : `für ${UIUtils.fmt(dynamics.value ?? DEFAULT_SPEED_TIME)}s`;
    const relativeSpeedTarget = target.entity_ref || _defaultRelativeActorId(actor);
    const distanceTarget = action.entity_ref || _defaultRelativeActorId(actor);
    // Counted against the 2 the emitter needs, not against 0: a single waypoint
    // draws nothing on the map and is dropped at export, so calling it "drawn"
    // was the card's most convincing lie.
    const trajectoryPoints = (action.trajectory || []).length;
    const routePoints = (action.waypoints || []).length;
    const trajectoryVisible = MapView.isTrajectoryVisible(actor.id, ev.id);
    const routeVisible = MapView.isRouteVisible(actor.id, ev.id);
    const partial = n => `unvollständig (${n} Wegpunkt${n === 1 ? '' : 'e'})`;
    const actionLabels = {
      follow_trajectory: trajectoryPoints >= 2
        ? `Pfad gezeichnet${trajectoryVisible ? '' : ', ausgeblendet'}`
        : trajectoryPoints > 0 ? `Pfad ${partial(trajectoryPoints)}` : 'Pfad nicht gezeichnet',
      assign_route: routePoints >= 2
        ? `Route gezeichnet${routeVisible ? '' : ', ausgeblendet'}`
        : routePoints > 0 ? `Route ${partial(routePoints)}` : 'Route nicht gezeichnet',
      set_speed: speedMode === 'relative'
        ? `${UIUtils.fmt(target.delta ?? 10)} m/s relativ zu ${_eventActorLabel(relativeSpeedTarget)} ${speedDynamicsSummary}`
        : `${UIUtils.fmt(target.value ?? 10)} m/s ${speedDynamicsSummary}`,
      set_distance: `${action.axis === 'lateral' ? 'Lateral' : 'Longitudinal'} ${UIUtils.fmt(action.value ?? 10)} m relativ zu ${_eventActorLabel(distanceTarget)}`,
      lane_change: `${action.direction === 'right' ? 'Rechts' : 'Links'} innerhalb ${UIUtils.fmt(dynamics.value ?? 12)} m`,
    };
    return actionLabels[action.type];
  }

  // ── Trigger Controls ────────────────────────────────────────────────────────

  /** Fills the card's `.event-trigger-block` — the WENN half, rendered above
   *  the action controls (see _renderEventList). */
  function _appendEventTriggerControls(block, actor, ev, events) {
    const trigger = _eventTrigger(ev);
    const triggerOptions = EVENT_TRIGGERS.filter(([value]) =>
      !(value === 'distance_to_ego' && actor.type === 'ego'));
    const triggerSelect = _select(triggerOptions, trigger.type || 'simulation_time');
    triggerSelect.addEventListener('change', e => {
      if (e.target.value === 'after_event') {
        const ref = events.find(other => other.id !== ev.id && _eventAction(other).type !== 'assign_route');
        _updateEvent(actor, ev.id, { trigger: { type: 'after_event', event_id: ref ? ref.id : '' } });
      } else if (e.target.value === 'distance_to_point') {
        // The point is placed on the actor straight away rather than left null:
        // a null point used to reach the backend and be silently defaulted to
        // the map origin (0, 0), where the condition can never fire. It is then
        // moved by dragging its map marker (mapView.js) — there is no picking
        // mode and no "set the point" button.
        _updateEvent(actor, ev.id, {
          trigger: {
            type: 'distance_to_point',
            value: DEFAULT_POINT_RADIUS,
            entity_ref: trigger.entity_ref || _defaultPointTriggerActorId(actor),
            point: trigger.point || ObjectsManager.defaultTriggerPoint(actor.id, ev.id),
          },
        });
        MapView.renderAllActors();
      } else {
        _updateEvent(actor, ev.id, {
          trigger: {
            type: e.target.value,
            value: e.target.value === 'distance_to_ego' ? (trigger.value ?? 400) : (trigger.value ?? 0),
          },
        });
      }
    });
    block.appendChild(_row('Auslöser', triggerSelect, { primary: true }));

    if ((trigger.type || 'simulation_time') === 'after_event') {
      const refs = events
        .map((other, otherIndex) => ({ other, otherIndex }))
        .filter(({ other }) => other.id !== ev.id && _eventAction(other).type !== 'assign_route')
        .map(({ other, otherIndex }) => [other.id, _eventDisplayName(other, otherIndex)]);
      const refSelect = _select(refs.length ? refs : [['', 'Kein Event']], trigger.event_id || '');
      refSelect.disabled = refs.length === 0;
      refSelect.addEventListener('change', e => {
        _updateEvent(actor, ev.id, { trigger: { type: 'after_event', event_id: e.target.value } });
      });
      block.appendChild(_row('Nach Event', refSelect));
    } else if ((trigger.type || 'simulation_time') === 'distance_to_point') {
      const point = trigger.point;
      const selectedTarget = trigger.entity_ref || _defaultPointTriggerActorId(actor);
      const pointInfo = document.createElement('div');
      pointInfo.className = 'event-point-info';
      pointInfo.textContent = point
        ? `${point.name}: (${Number(point.x).toFixed(1)}, ${Number(point.y).toFixed(1)}) — auf der Karte ziehen`
        : 'Kein Punkt gesetzt';
      pointInfo.title = point
        ? 'Punktmarker auf der Karte ziehen, um ihn zu verschieben; den Griff am Ring ziehen, um den Radius zu ändern'
        : '';
      block.appendChild(pointInfo);

      const distanceInput = document.createElement('input');
      distanceInput.type = 'number';
      distanceInput.min = '0';
      distanceInput.step = '1';
      distanceInput.value = UIUtils.fmt(trigger.value ?? 20, 0);
      distanceInput.addEventListener('change', e => {
        _patchEventTrigger(actor, ev, {
          type: 'distance_to_point',
          value: Math.max(0, parseFloat(e.target.value) || 0),
          entity_ref: trigger.entity_ref || _defaultPointTriggerActorId(actor),
          point: trigger.point || null,
        });
      });

      const targetSelect = _select(_triggerActorOptions(actor), selectedTarget);
      targetSelect.addEventListener('change', e => {
        _patchEventTrigger(actor, ev, {
          type: 'distance_to_point',
          value: trigger.value ?? 20,
          entity_ref: e.target.value,
          point: trigger.point || null,
        });
      });
      block.appendChild(_pointDistanceRow(distanceInput, targetSelect));
    } else {
      const isEgoDistance = (trigger.type || 'simulation_time') === 'distance_to_ego';
      const valueInput = document.createElement('input');
      valueInput.type = 'number';
      valueInput.min = '0';
      valueInput.step = isEgoDistance ? '1' : '0.1';
      valueInput.value = UIUtils.fmt(trigger.value ?? 0, isEgoDistance ? 0 : 1);
      valueInput.addEventListener('change', e => {
        _patchEventTrigger(actor, ev, {
          type: trigger.type || 'simulation_time',
          value: Math.max(0, parseFloat(e.target.value) || 0),
        });
      });
      // 'Wert' said nothing about which quantity; the two triggers left here
      // measure different things in different units.
      block.appendChild(UIUtils.paramRow(
        isEgoDistance ? 'Abstand' : 'Zeit', valueInput, isEgoDistance ? 'm' : 's'));
    }
  }

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
    const fallback = AppState.npcs.find(n => n.id !== actor?.id);
    return fallback ? fallback.id : '';
  }

  function _relativeActorOptions(actor) {
    const options = [];
    if (AppState.ego && AppState.ego.id !== actor?.id) {
      options.push([AppState.ego.id, 'Ego']);
    }
    AppState.npcs
      .filter(n => n.id !== actor?.id)
      .forEach(n => options.push([n.id, AppState.actorLabel(n)]));
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
    AppState.npcs
      .filter(n => n.id !== actor?.id)
      .forEach(n => options.push([n.id, AppState.actorLabel(n)]));
    return options;
  }

  function _select(options, selectedValue) {
    const select = document.createElement('select');
    options.forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    });
    select.value = selectedValue;
    return select;
  }

  function _axisToggle(actor, ev) {
    const action = _eventAction(ev);
    const current = action.axis === 'lateral' ? 'lateral' : 'longitudinal';
    const wrap = document.createElement('div');
    wrap.className = 'event-toggle';

    [
      ['longitudinal', 'Longitudinal'],
      ['lateral', 'Lateral'],
    ].forEach(([value, label]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.className = value === current ? 'active' : '';
      btn.addEventListener('click', () => {
        _patchEventAction(actor, ev, { axis: value });
      });
      wrap.appendChild(btn);
    });
    return wrap;
  }

  function _speedModeToggle(actor, ev) {
    const current = _speedMode(ev);
    const action = _eventAction(ev);
    const target = action.target || { mode: 'absolute', value: 10.0 };
    const wrap = document.createElement('div');
    wrap.className = 'event-toggle';

    [
      ['absolute', 'Absolut'],
      ['relative', 'Relativ'],
    ].forEach(([value, label]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.className = value === current ? 'active' : '';
      btn.addEventListener('click', () => {
        _patchEventAction(actor, ev, {
          type: 'set_speed',
          target: value === 'relative'
            ? {
              mode: 'relative',
              entity_ref: target.entity_ref || _defaultRelativeActorId(actor),
              delta: target.delta ?? target.value ?? 10.0,
            }
            : {
              mode: 'absolute',
              value: target.value ?? target.delta ?? 10.0,
            },
        });
      });
      wrap.appendChild(btn);
    });
    return wrap;
  }

  /** Zeit (s) vs Rate (m/s²) for the SpeedActionDynamics value. The two are not
   * interchangeable numbers, so a real change re-defaults the value; clicking
   * the already-active button leaves a hand-tuned one alone. */
  function _speedDimensionToggle(actor, ev) {
    const current = _speedDimension(ev);
    const dynamics = _eventAction(ev).dynamics || {};
    const wrap = document.createElement('div');
    wrap.className = 'event-toggle';

    SPEED_DIMENSIONS.forEach(([value, label]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.className = value === current ? 'active' : '';
      btn.addEventListener('click', () => {
        if (value === current) return;
        _patchEventAction(actor, ev, {
          dynamics: {
            ...dynamics,
            dimension: value,
            // 'step' + 'rate' is self-contradictory; the backend forces this
            // too, but keeping state honest keeps the export a no-op change.
            shape: value === 'rate' ? 'linear' : 'step',
            value: value === 'rate' ? DEFAULT_SPEED_RATE : DEFAULT_SPEED_TIME,
          },
        });
      });
      wrap.appendChild(btn);
    });
    return wrap;
  }

  // ── DOM Helpers ─────────────────────────────────────────────────────────────

  function _row(labelText, control, { primary = false } = {}) {
    const row = document.createElement('div');
    row.className = 'event-row';
    if (primary) {
      row.classList.add('event-primary-row');
    }
    const label = document.createElement('label');
    label.textContent = labelText;
    UIUtils.bindLabel(label, control);
    row.appendChild(label);
    row.appendChild(control);
    return row;
  }

  function _speedTimingRow(speedInput, timeInput, isRate) {
    const row = document.createElement('div');
    row.className = 'event-speed-row';

    const speedLabel = document.createElement('label');
    speedLabel.textContent = 'Geschw.';
    UIUtils.bindLabel(speedLabel, speedInput);
    const speedUnit = document.createElement('span');
    speedUnit.textContent = 'm/s';

    const timeLabel = document.createElement('label');
    timeLabel.textContent = isRate ? 'Rate' : 'Für';
    UIUtils.bindLabel(timeLabel, timeInput);
    const timeUnit = document.createElement('span');
    timeUnit.textContent = isRate ? 'm/s²' : 's';

    row.appendChild(speedLabel);
    row.appendChild(speedInput);
    row.appendChild(speedUnit);
    row.appendChild(timeLabel);
    row.appendChild(timeInput);
    row.appendChild(timeUnit);
    return row;
  }

  function _pointDistanceRow(distanceInput, targetSelect) {
    const row = document.createElement('div');
    row.className = 'event-point-distance-row';

    const distanceLabel = document.createElement('label');
    distanceLabel.textContent = 'Abstand';
    UIUtils.bindLabel(distanceLabel, distanceInput);
    const unit = document.createElement('span');
    unit.textContent = 'm zu';
    targetSelect.setAttribute('aria-label', 'Bezugsakteur für den Abstand');

    row.appendChild(distanceLabel);
    row.appendChild(distanceInput);
    row.appendChild(unit);
    row.appendChild(targetSelect);
    return row;
  }

  // ── Path Action Controls ────────────────────────────────────────────────────

  function _eventPathPoints(ev) {
    const action = _eventAction(ev);
    return action.type === 'assign_route'
      ? (action.waypoints || [])
      : (action.trajectory || []);
  }

  /** Render one path event's waypoint list into `target`. */
  function _renderPathList(actor, type, target, ev) {
    target.innerHTML = '';
    const points  = _eventPathPoints(ev);
    const eventId = ev.id;
    const isRoute = type === 'route';

    if (points.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text-dim);font-size:11px;padding:4px 0';
      empty.textContent = isRoute ? 'Noch keine Route gezeichnet.' : 'Noch kein Pfad gezeichnet.';
      target.appendChild(empty);
      return;
    }

    points.forEach((wp, i) => {
      const item = document.createElement('div');
      item.className = `waypoint-item${isRoute ? ' route-waypoint-item' : ''}`;
      // The same four attributes the map's waypoint groups carry — they are the
      // whole contract between the two halves, so a row and a marker can always
      // be matched up without either side knowing how the other is built.
      item.dataset.actorId  = actor.id;
      item.dataset.eventId  = eventId;
      item.dataset.pathType = type;
      item.dataset.wpIdx    = i;
      // Focusable so Entf/Backspace reaches mapView's handler straight after a
      // click on the row: the guard there is "not inside a field", and a row is
      // not a field. Enter re-locates, matching the click.
      item.tabIndex = 0;
      item.title = 'Klicken, um auf der Karte zu zeigen · Entf löscht';

      const locate = () => {
        const sel = { actorId: actor.id, eventId, pathType: type, index: i };
        AppState.selectWaypoint(sel);
        MapView.focusWaypoint(sel);
      };
      item.addEventListener('click', e => {
        // The row's own controls keep their clicks: the delete button and the
        // velocity field both sit inside it.
        if (e.target.closest('button, input')) return;
        locate();
      });
      item.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        if (e.target.closest('input')) return;
        e.preventDefault();
        locate();
      });

      const num = document.createElement('span');
      num.className = 'wp-num';
      num.textContent = i + 1;

      const coords = document.createElement('span');
      coords.className = 'wp-coords';
      coords.textContent = `(${wp.x.toFixed(1)}, ${wp.y.toFixed(1)})`;

      const delBtn = document.createElement('button');
      delBtn.className = 'wp-delete';
      delBtn.type = 'button';
      delBtn.textContent = '×';
      delBtn.title = 'Wegpunkt entfernen';
      delBtn.setAttribute('aria-label', `Wegpunkt ${i + 1} entfernen`);
      delBtn.addEventListener('click', () => {
        ObjectsManager.deletePathPoint(actor.id, type, i, eventId);
        // Indices past the deleted one all shift down, so a mark left as it is
        // would silently start naming the next point along — and Entf would
        // then delete something the user never marked.
        const sel = AppState.selectedWaypoint;
        if (sel && sel.actorId === actor.id && sel.eventId === eventId
            && sel.pathType === type && sel.index >= i) {
          const left = (AppState.waypointPathOf(sel) || []).length;
          AppState.selectWaypoint(left && sel.index > i
            ? { ...sel, index: sel.index - 1 }
            : null);
        }
      });

      item.appendChild(num);
      item.appendChild(coords);
      if (!isRoute) {
        const velInput = document.createElement('input');
        velInput.type = 'number';
        velInput.min = '0';
        velInput.max = '50';
        velInput.step = '0.5';
        velInput.value = UIUtils.fmt(wp.velocity || 10);
        velInput.title = 'Geschwindigkeit (m/s)';
        velInput.setAttribute('aria-label', `Geschwindigkeit an Wegpunkt ${i + 1} (m/s)`);
        velInput.dataset.idx = i;
        velInput.addEventListener('change', e => {
          ObjectsManager.setPathPointVelocity(actor.id, type, i, e.target.value, eventId);
        });

        const msSuffix = document.createElement('span');
        msSuffix.style.cssText = 'color:var(--text-dim);font-size:11px;';
        msSuffix.textContent = 'm/s';

        item.appendChild(velInput);
        item.appendChild(msSuffix);
      }

      item.appendChild(delBtn);
      target.appendChild(item);
    });
  }

  /**
   * Put the `.waypoint-selected` class on the row the map's mark names, and
   * bring it into view — but only when the mark actually MOVED.
   *
   * The panel re-renders on every actorUpdated, which during a waypoint drag is
   * every mousemove; scrolling on each of those would fight the user for the
   * list's scroll position while they drag.
   */
  let _lastMarkKey = null;

  function syncWaypointSelection() {
    const sel = AppState.selectedWaypoint;
    const key = sel
      ? `${sel.actorId}:${sel.eventId}:${sel.pathType}:${sel.index}`
      : null;
    let marked = null;
    eventList.querySelectorAll('.waypoint-item').forEach(row => {
      const d = row.dataset;
      const hit = !!sel && d.actorId === sel.actorId && d.eventId === sel.eventId
               && d.pathType === sel.pathType && Number(d.wpIdx) === sel.index;
      row.classList.toggle('waypoint-selected', hit);
      if (hit) marked = row;
    });
    if (marked && key !== _lastMarkKey) marked.scrollIntoView({ block: 'nearest' });
    _lastMarkKey = key;
  }

  function _appendEventPathControls(card, actor, ev) {
    const actionType = _eventAction(ev).type || 'follow_trajectory';
    const isRouteAction = actionType === 'assign_route';
    const pathMode = isRouteAction ? 'route' : 'trajectory';
    const pathPoints = _eventPathPoints(ev);
    const hasPath = pathPoints.length > 0;
    const visible = isRouteAction
      ? MapView.isRouteVisible(actor.id, ev.id)
      : MapView.isTrajectoryVisible(actor.id, ev.id);

    const controls = document.createElement('div');
    controls.className = `event-toggle event-path-controls${hasPath ? ' has-path' : ''}`;

    const drawBtn = document.createElement('button');
    drawBtn.type = 'button';
    drawBtn.textContent = 'Zeichnen';
    drawBtn.addEventListener('click', () => {
      ObjectsManager.startPathMode(actor.id, pathMode, ev.id);
    });

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    // Quiet, not filled red: this used to be the strongest-looking button in
    // the card, louder than 'Zeichnen', which is the one people actually want.
    clearBtn.className = 'quiet-danger';
    clearBtn.textContent = 'Löschen';
    clearBtn.addEventListener('click', () => {
      ObjectsManager.clearPath(actor.id, pathMode, ev.id);
      _refresh();
    });

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.textContent = visible ? 'Ausblenden' : 'Anzeigen';
    // Ausblenden hides the path outright, selected or not. The way back is
    // either this button or working on the path — drawing it, or clicking one
    // of its waypoints below, both un-hide it (MapView.showPath).
    toggleBtn.title = visible
      ? 'Pfad auf der Karte ausblenden'
      : 'Pfad wieder einblenden — Zeichnen oder das Anklicken eines '
        + 'Wegpunkts blendet ihn ebenfalls wieder ein.';
    toggleBtn.addEventListener('click', () => {
      if (isRouteAction) MapView.toggleRouteVisibility(actor.id, ev.id);
      else MapView.toggleTrajectoryVisibility(actor.id, ev.id);
      _refresh();
    });

    controls.appendChild(drawBtn);
    if (hasPath) {
      controls.appendChild(toggleBtn);
      controls.appendChild(clearBtn);
    }
    card.appendChild(controls);
  }

  // A mark set on the map has to light up the matching row without rebuilding
  // the panel: the rebuild would happen anyway on the next actorUpdated, but a
  // click on a marker is not an edit and must not cost a full re-render.
  AppState.on('change', patch => {
    if ('selectedWaypoint' in patch) syncWaypointSelection();
  });

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
    const previousActionType = previous ? _eventAction(previous).type : null;
    const trigger = actionType === 'assign_route'
      ? { type: 'simulation_time', value: 0 }
      : events.length > 0 && !forceFirst && previousActionType !== 'assign_route'
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
    const events = (currentActor.events || []).map(ev => (
      ev.id === eventId ? { ...ev, ...patch } : ev
    ));
    AppState.updateById(currentActor.id, { events });
  }

  function _currentEvent(actorId, eventId) {
    const actor = AppState.findById(actorId);
    return (actor?.events || []).find(ev => ev.id === eventId) || null;
  }

  function _deleteEvent(actor, eventId) {
    const currentActor = AppState.findById(actor.id) || actor;
    const currentEvents = currentActor.events || [];
    const deletedIndex = currentEvents.findIndex(ev => ev.id === eventId);
    if (deletedIndex < 0) return;

    const previousEvent = currentEvents[deletedIndex - 1] || null;
    const firstEventTriggerPatch = ev => ({
      ...ev,
      trigger: _defaultFirstTrigger(
        currentActor,
        _eventTrigger(ev).type === 'distance_to_ego' ? _eventTrigger(ev).value : null
      ),
    });
    const events = currentEvents
      .filter(ev => ev.id !== eventId)
      .map(ev => {
        const trigger = _eventTrigger(ev);
        if (trigger.type === 'after_event' && trigger.event_id === eventId) {
          return previousEvent && _eventAction(previousEvent).type !== 'assign_route'
            ? { ...ev, trigger: { type: 'after_event', event_id: previousEvent.id } }
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
    AppState.updateById(currentActor.id, { events });
  }

  // ── Export ──────────────────────────────────────────────────────────────────

  window.EventPanel = {
    render,
    setRefreshHandler,
    // objects.js discards a path event left under 2 waypoints and must go
    // through this: it re-points any after_event chained onto the deleted
    // event and clears the draw-mode state, which a bare events.filter() would
    // leave dangling.
    deleteEvent: _deleteEvent,
  };
})();
