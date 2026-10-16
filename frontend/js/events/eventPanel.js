/**
 * eventPanel.js — the event editor in the properties panel, the same for the ego and every NPC.
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
      // AssignRouteAction is vehicle-only downstream; the emitter would drop it.
      const routeUnavailable = actionType === 'assign_route' && !ScenarioRules.ROUTE_ACTION_TYPES.has(actor.type);
      // PedestrianControl never reads the offset, so a walker would never move sideways.
      const offsetUnavailable = actionType === 'lane_offset' && !ScenarioRules.honoursLaneOffset(actor.type);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'event-action-button';
      btn.textContent = label;
      // Disabled with a title rather than removed, so the grid does not reflow unexplained.
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
        // One undo entry: a path action also seeds waypoint 1, a second {events} patch.
        UndoStack.group('Event hinzugefügt', () => {
          AppState.updateById(actor.id, { events });
          if (isPathAction) {
            ObjectsManager.startPathMode(actor.id, actionType === 'assign_route' ? 'route' : 'trajectory', newEvent.id);
          }
        });
      });
      eventActionGrid.appendChild(btn);
    });

    // Apply a template's chain to an actor that is already placed.
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
    // Save this actor's chain as a user template (templatesUser.js), relative to the actor.
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
    // Also used by objectsPaths.js, so the re-point sweep and draw-state cleanup apply.
    deleteEvent: _deleteEvent,
    // The card title ('Geschw. setzen 2'), for the timeline markers.
    displayName: _eventDisplayName,
    // Mark an event's card (Ablauf block click); the next render expands and scrolls to it.
    highlight,
  };
})();
