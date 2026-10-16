/**
 * eventPanelCards.js — the event card list and the pieces of a card, plus the timeline highlight.
 *
 * Part of the event panel (EventPanel); see eventPanel.js.
 */
(() => {
  'use strict';

  const {
    eventList,
    eventCount,
    eventWarn,
    FIXED_ROUTE_START_HINT,
    panel,
    _eventAction,
    _updateEvent,
    _eventDisplayName,
    _eventTriggerSummary,
    _eventActionSummary,
    _deleteEvent,
    _appendSpeedActionControls,
    _appendDistanceActionControls,
    _appendLaneChangeControls,
    _appendLaneOffsetControls,
    _appendEventTriggerControls,
    _renderPathList,
    syncWaypointSelection,
    _appendTrajectorySpeedRow,
    _appendEventPathControls,
  } = EventPanelCore.shared;

  function _isHighlighted(actor, ev) {
    return !!panel.highlight && panel.highlight.actorId === actor.id && panel.highlight.eventId === ev.id;
  }

  /** After a render: bring the marked card into view, once. */
  function _scrollToHighlight() {
    if (!panel.highlight?.scroll) return;
    const card = eventList.querySelector('.event-card.timeline-focus');
    if (!card) return;
    panel.highlight.scroll = false;
    // The events section may be folded; the card would be invisible.
    const section = card.closest('.collapsible-section');
    if (section?.classList.contains('collapsed')) {
      section.classList.remove('collapsed');
      const header = section.querySelector('.collapsible-header');
      header?.setAttribute('aria-expanded', 'true');
      const ind = header?.querySelector('.collapse-indicator');
      if (ind) ind.textContent = '-';
    }
    // Not smooth: the panel re-renders every preview frame.
    requestAnimationFrame(() => {
      eventList.querySelector('.event-card.timeline-focus')?.scrollIntoView({ block: 'center' });
    });
  }

  function _renderEventList(actor) {
    if (!eventList) return;
    eventList.innerHTML = '';
    const events = actor.events || [];
    if (eventCount) eventCount.textContent = String(events.length);

    // ScenarioRules decides, so card, export gate and preview agree on what will not export.
    const problems = new Map(ScenarioRules.problemsOf(actor).map((entry) => [entry.ev.id, entry.problem]));
    if (eventWarn) {
      eventWarn.textContent = String(problems.size);
      eventWarn.classList.toggle('hidden', problems.size === 0);
      eventWarn.title =
        problems.size === 1
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

    // The card the map clicks belong to; ids are unique per actor only, so the owner is checked too.
    const pathOwnerId = AppState.activeTrajectoryId || AppState.activeRouteId;
    const drawingEventId = pathOwnerId === actor.id ? AppState.activePathEventId : null;

    events.forEach((ev, i) => {
      const action = _eventAction(ev);
      const actionType = action.type || 'follow_trajectory';
      const displayName = _eventDisplayName(ev, i);
      const triggerSummary = _eventTriggerSummary(ev, events, actor);
      const card = document.createElement('div');
      const isHighlighted = _isHighlighted(actor, ev);
      const isCollapsed = !!ev.collapsed && !isHighlighted;
      const isDrawing = drawingEventId === ev.id;
      const problem = problems.get(ev.id) || null;
      // Exports fine but cannot do anything in CARLA — never blocks the export.
      const warning = problem ? null : ScenarioRules.eventWarning(actor, ev, events);
      card.className =
        `event-card${isCollapsed ? ' collapsed' : ''}` +
        `${isDrawing ? ' active-draw' : ''}${problem ? ' has-problem' : ''}` +
        `${isHighlighted ? ' timeline-focus' : ''}`;
      card.dataset.eventId = ev.id;

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

      // The one-line summary only on a collapsed card; an expanded one shows both editable below.
      if (isCollapsed) {
        card.appendChild(_summaryLine(ev, actor, actionType, triggerSummary));
        if (problem) card.appendChild(_problemChip(problem));
        else if (warning) card.appendChild(_problemChip(warning, { soft: true }));
        eventList.appendChild(card);
        return;
      }

      // First under the header: it is why the rest of the card will not happen.
      if (problem) card.appendChild(_problemChip(problem));
      else if (warning) card.appendChild(_problemChip(warning, { soft: true }));

      // WENN before DANN. A route gets a fixed block stating its start, which the file forces to t = 0.
      card.appendChild(actionType === 'assign_route' ? _fixedTriggerBlock() : _triggerBlock(actor, ev, events));

      if (actionType === 'set_speed') {
        _appendSpeedActionControls(card, actor, ev, action);
      } else if (actionType === 'set_distance') {
        _appendDistanceActionControls(card, actor, ev, action);
      } else if (actionType === 'lane_change') {
        _appendLaneChangeControls(card, actor, ev, action);
      } else if (actionType === 'lane_offset') {
        _appendLaneOffsetControls(card, actor, ev, action);
      } else {
        _appendEventPathControls(card, actor, ev);
        if (actionType === 'follow_trajectory') _appendTrajectorySpeedRow(card, actor, ev);
        const pathList = document.createElement('div');
        pathList.className = 'event-waypoint-list waypoint-list';
        _renderPathList(actor, actionType === 'assign_route' ? 'route' : 'trajectory', pathList, ev);
        card.appendChild(pathList);
      }

      eventList.appendChild(card);
    });

    syncWaypointSelection();
    _scrollToHighlight();
  }

  /** `<action> • <trigger>`: the whole event in one line, for a collapsed card. */
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
  function _problemChip(problem, { soft = false } = {}) {
    const chip = document.createElement('div');
    chip.className = soft ? 'event-problem event-warning' : 'event-problem';
    chip.setAttribute('role', 'status');
    const icon = document.createElement('span');
    icon.className = 'event-problem-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '⚠';
    const text = document.createElement('span');
    text.textContent = problem.short;
    chip.title = soft
      ? `Wird exportiert, bewirkt in CARLA aber nichts: ${problem.message}.`
      : `Dieses Event wird beim Export verworfen: ${problem.message}.`;
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
    const allCollapsed = events.every((ev) => !!ev.collapsed);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'event-bulk-toggle';
    btn.textContent = allCollapsed ? 'Alle ausklappen' : 'Alle einklappen';
    btn.addEventListener('click', () => {
      const current = AppState.findById(actor.id) || actor;
      AppState.updateById(actor.id, {
        events: (current.events || []).map((ev) => ({ ...ev, collapsed: !allCollapsed })),
      });
    });
    bar.appendChild(btn);
    return bar;
  }

  EventPanelCore.define({
    _renderEventList,
  });
})();
