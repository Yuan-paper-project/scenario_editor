/**
 * eventPanel.js — event action/trigger editor for the properties panel.
 * Shared by the ego and every NPC; the ego has no distance_to_ego trigger
 * option (see EVENT_TRIGGERS) since a distance from hero to itself is always
 * 0, but is otherwise editable exactly like an NPC.
 */
(() => {
  'use strict';

  const {
    eventSection,
    eventActionGrid,
    EVENT_ACTIONS,
    HIDDEN_ACTIONS,
    panel,
    _eventAction,
    _eventDisplayName,
    _defaultEvent,
    _deleteEvent,
    _renderEventList,
  } = EventPanelCore.shared;

  // ── Public API ──────────────────────────────────────────────────────────────

  function render(actor) {
    _renderEventActionGrid(actor);
    _renderEventList(actor);
  }

  function highlight(actorId, eventId) {
    const had = !!panel.highlight;
    panel.highlight = actorId && eventId ? { actorId, eventId, scroll: true } : null;
    if (had && !panel.highlight) panel.refresh(); // clearing: take the mark off now
  }

  function setRefreshHandler(handler) {
    panel.refresh = typeof handler === 'function' ? handler : () => {};
  }

  // ── Event Rendering ─────────────────────────────────────────────────────────

  function _renderEventActionGrid(actor) {
    if (!eventActionGrid) return;
    eventActionGrid.innerHTML = '';
    if (!actor) return;

    const hasPathEvent = (actor.events || []).some((ev) => {
      const type = _eventAction(ev).type;
      return type === 'follow_trajectory' || type === 'assign_route';
    });

    EVENT_ACTIONS.forEach(([actionType, label]) => {
      if (HIDDEN_ACTIONS.has(actionType)) return;
      const isPathAction = actionType === 'follow_trajectory' || actionType === 'assign_route';
      // AssignRouteAction is vehicle-only downstream (_ROUTE_ACTION_TYPES in
      // event_builders.py). Offering it to a Fußgänger produced an event that
      // was silently dropped at export — along with anything chained onto it.
      const routeUnavailable = actionType === 'assign_route' && !ScenarioRules.ROUTE_ACTION_TYPES.has(actor.type);
      // ChangeActorLaneOffset writes the controller's _offset, which
      // PedestrianControl stores and never reads — offering it to a Fußgänger
      // would produce a valid file in which the actor simply never moves
      // sideways.
      const offsetUnavailable = actionType === 'lane_offset' && !ScenarioRules.honoursLaneOffset(actor.type);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'event-action-button';
      btn.textContent = label;
      // The two path actions used to be *removed* once a path event existed,
      // reflowing the grid with nothing to explain where they went. Keeping
      // them disabled states the rule instead of hiding its consequence.
      if (routeUnavailable || offsetUnavailable || (isPathAction && hasPathEvent)) {
        btn.disabled = true;
        btn.title = routeUnavailable
          ? 'Eine Route ist nur für Fahrzeuge möglich — für Personen die Trajektorie verwenden'
          : offsetUnavailable
            ? 'Ein Spurversatz wirkt nur auf Fahrzeuge — Personen ignorieren ihn'
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

    // A template's chain onto an actor that is already placed — templates.js
    // otherwise only fire on a fresh placement click.
    const options = window.ScenarioTemplates ? ScenarioTemplates.compatibleWith(actor.type) : [];
    if (options.length) {
      const select = document.createElement('select');
      select.className = 'event-template-select';
      select.title =
        'Ersetzt die Events dieses Akteurs durch den Ablauf eines Templates, ' + 'berechnet für seine jetzige Position';
      select.setAttribute('aria-label', 'Ablauf aus Template');
      select.innerHTML =
        '<option value="">Ablauf aus Template …</option>' +
        options
          .map((o) => `<option value="${o.id}" title="${o.hint.replace(/"/g, '&quot;')}">${o.label}</option>`)
          .join('');
      select.addEventListener('change', async () => {
        const id = select.value;
        select.value = '';
        if (id) await ScenarioTemplates.applyTo(AppState.findById(actor.id) || actor, id);
      });
      eventActionGrid.appendChild(select);
    }
    // The reverse: this actor's chain as a reusable template (templates.js,
    // „Eigene Vorlagen"), positions kept relative to the actor.
    if (window.ScenarioTemplates && actor.type !== 'ego' && actor.type !== 'prop' && (actor.events || []).length) {
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'btn btn-small btn-secondary event-template-save';
      save.textContent = 'Als Vorlage speichern';
      save.title =
        'Diese Events als eigene Vorlage speichern — Positionen relativ zum Akteur, ' +
        'wiederverwendbar auf jeder Karte (Tab Templates → Eigene Vorlagen)';
      save.addEventListener('click', () => ScenarioTemplates.saveFromActor(AppState.findById(actor.id) || actor));
      eventActionGrid.appendChild(save);
    }
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
    // The card title ('Geschw. setzen 2'), so simulate.js's timeline markers
    // name an event the way its card does.
    displayName: _eventDisplayName,
    // Mark an event's card (eventTimeline.js block click) — the panel's next
    // render shows it expanded and scrolls it into view.
    highlight,
  };
})();
