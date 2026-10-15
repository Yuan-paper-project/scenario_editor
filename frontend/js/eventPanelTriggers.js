/**
 * eventPanelTriggers.js — the trigger controls — the WENN half of a card.
 *
 * Part of the event panel (EventPanel); see eventPanel.js.
 */
(() => {
  'use strict';

  const {
    EVENT_TRIGGERS,
    EGO_SPEED_RULES,
    DEFAULT_EGO_SPEED,
    RELATIVE_SPEED_RULES,
    DEFAULT_RELATIVE_SPEED,
    DEFAULT_POINT_RADIUS,
    _defaultRelativeActorId,
    _relativeActorOptions,
    _defaultPointTriggerActorId,
    _triggerActorOptions,
    _eventTrigger,
    _patchEventTrigger,
    _updateEvent,
    _currentEvent,
    _select,
    _groupedSelect,
    _multiRow,
    _unit,
    _row,
    _pointDistanceRow,
    _splitAfterEventValue,
    _afterEventTrigger,
    _afterEventGroups,
    _afterEventOptionLabel,
    _firstAfterEventOption,
  } = EventPanelCore.shared;

  // ── Trigger Controls ────────────────────────────────────────────────────────

  /** Fills the card's `.event-trigger-block` — the WENN half, rendered above
   *  the action controls (see _renderEventList). */
  function _appendEventTriggerControls(block, actor, ev, events) {
    const trigger = _eventTrigger(ev);
    // The two actor-relative triggers need another actor to measure against;
    // for the ego that means an NPC, for an NPC there is always the ego.
    const others = _relativeActorOptions(actor);
    const triggerOptions = EVENT_TRIGGERS.filter(
      ([value]) =>
        !((value === 'distance_to_ego' || value === 'relative_speed') && others.length === 0) || value === trigger.type,
    );
    const triggerSelect = _select(triggerOptions, trigger.type || 'simulation_time');
    triggerSelect.addEventListener('change', (e) => {
      const kind = e.target.value;
      if (kind === 'after_event' || kind === 'event_started') {
        // The first offered option, own actor first — _afterEventGroups has
        // already dropped the assign_routes and anything that would loop.
        const ref = _firstAfterEventOption(_afterEventGroups(actor, ev, events, kind));
        _updateEvent(actor, ev.id, {
          trigger: ref ? _afterEventTrigger(actor, ref.actorId, ref.eventId, kind) : { type: kind, event_id: '' },
        });
      } else if (kind === 'ego_speed') {
        _updateEvent(actor, ev.id, {
          trigger: { type: 'ego_speed', rule: 'greaterThan', value: DEFAULT_EGO_SPEED },
        });
      } else if (kind === 'relative_speed') {
        _updateEvent(actor, ev.id, {
          trigger: {
            type: 'relative_speed',
            entity_ref: _defaultRelativeActorId(actor),
            rule: 'greaterThan',
            value: DEFAULT_RELATIVE_SPEED,
          },
        });
      } else if (kind === 'distance_to_ego') {
        // Absent entity_ref = the ego, which is what every older payload means
        // and what an NPC gets by default; the ego itself has to name an NPC.
        const next = {
          type: 'distance_to_ego',
          value: trigger.type === 'distance_to_ego' ? (trigger.value ?? 400) : 400,
        };
        if (actor.type === 'ego') next.entity_ref = _defaultRelativeActorId(actor);
        _updateEvent(actor, ev.id, { trigger: next });
      } else if (e.target.value === 'distance_to_point') {
        // The point is placed on the actor straight away rather than left null:
        // a null point used to reach the backend and be silently defaulted to
        // the map origin (0, 0), where the condition can never fire. It is then
        // moved by dragging its map marker (mapTriggerPoints.js) — there is no picking
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

    if (ScenarioRules.isEventRef(trigger)) {
      const kind = trigger.type;
      const groups = _afterEventGroups(actor, ev, events, kind);
      const selected = ScenarioRules.afterEventKey(trigger.actor_ref || actor.id, trigger.event_id || '');
      // A trigger loaded from a save file may name an event this dropdown does
      // not offer — one that has since been deleted, or (in an LLM payload) one
      // that closes a loop. Neither is silently repointed: the option is added
      // so the select shows what the trigger actually says, and the card's
      // warning chip says why it will not export.
      const known = groups.some((g) => g.options.some(([value]) => value === selected));
      if (!known) {
        const target = ScenarioRules.afterEventTarget(actor, trigger, events);
        groups.unshift({
          label: 'Aktuell',
          options: [
            [
              selected,
              target
                ? _afterEventOptionLabel(target.actor, target.event, target.index, target.actor.id === actor.id)
                : 'Unbekanntes Event',
            ],
          ],
        });
      }
      const refSelect = groups.length ? _groupedSelect(groups, selected) : _select([['', 'Kein Event']], '');
      refSelect.disabled = groups.length === 0;
      refSelect.title =
        'Events anderer Akteure sind nach Akteur gruppiert; ' +
        'Events, die bereits auf dieses warten, fehlen absichtlich (sonst Endlosschleife)' +
        (actor.type === 'ego' ? '' : '; Ego-Events fehlen, weil ein vom AV gefahrenes Ego keine hat');
      refSelect.addEventListener('change', (e) => {
        const { actorId, eventId } = _splitAfterEventValue(e.target.value);
        _updateEvent(actor, ev.id, { trigger: _afterEventTrigger(actor, actorId, eventId, kind) });
      });
      block.appendChild(_row(kind === 'event_started' ? 'Mit Event' : 'Nach Event', refSelect));
    } else if (trigger.type === 'ego_speed') {
      const ruleSelect = _select(EGO_SPEED_RULES, trigger.rule === 'lessThan' ? 'lessThan' : 'greaterThan');
      ruleSelect.title =
        'Feuert, sobald die gemessene Geschwindigkeit des Ego die Schwelle ' +
        'über- bzw. unterschreitet. „langsamer als" ist bei stehendem Ego sofort wahr.';
      ruleSelect.addEventListener('change', (e) => {
        _patchEventTrigger(actor, ev, { type: 'ego_speed', rule: e.target.value });
      });
      const speedInput = document.createElement('input');
      speedInput.type = 'number';
      speedInput.min = '0';
      speedInput.step = '0.5';
      speedInput.value = UIUtils.fmt(trigger.value ?? DEFAULT_EGO_SPEED);
      speedInput.addEventListener('change', (e) => {
        _patchEventTrigger(actor, ev, {
          type: 'ego_speed',
          value: Math.max(0, parseFloat(e.target.value) || 0),
        });
      });
      speedInput.setAttribute('aria-label', 'Schwelle');
      block.appendChild(_multiRow('Ego ist', [ruleSelect, speedInput, _unit('m/s')], { className: 'event-rule-row' }));
    } else if (trigger.type === 'relative_speed') {
      const refSelect = _select(
        others.length ? others : [['', 'Kein Akteur']],
        trigger.entity_ref || _defaultRelativeActorId(actor),
      );
      refSelect.disabled = others.length === 0;
      refSelect.addEventListener('change', (e) => {
        _patchEventTrigger(actor, ev, { type: 'relative_speed', entity_ref: e.target.value });
      });
      block.appendChild(_row('Akteur', refSelect));
      const ruleSelect = _select(RELATIVE_SPEED_RULES, trigger.rule === 'lessThan' ? 'lessThan' : 'greaterThan');
      ruleSelect.title =
        'Geschwindigkeit des gewählten Akteurs minus die eigene. ' +
        'Positiv: der andere ist schneller. Beide als Betrag gemessen.';
      ruleSelect.addEventListener('change', (e) => {
        _patchEventTrigger(actor, ev, { type: 'relative_speed', rule: e.target.value });
      });
      const diffInput = document.createElement('input');
      diffInput.type = 'number';
      diffInput.min = '-100';
      diffInput.max = '100';
      diffInput.step = '0.5';
      diffInput.value = UIUtils.fmt(trigger.value ?? DEFAULT_RELATIVE_SPEED);
      diffInput.title = ruleSelect.title;
      diffInput.addEventListener('change', (e) => {
        const parsed = parseFloat(e.target.value);
        _patchEventTrigger(actor, ev, {
          type: 'relative_speed',
          value: Math.max(-100, Math.min(100, Number.isFinite(parsed) ? parsed : 0)),
        });
      });
      diffInput.setAttribute('aria-label', 'Schwelle');
      block.appendChild(_multiRow('Differenz', [ruleSelect, diffInput, _unit('m/s')], { className: 'event-rule-row' }));
    } else if (trigger.type === 'distance_to_ego') {
      const distanceInput = document.createElement('input');
      distanceInput.type = 'number';
      distanceInput.min = '0';
      distanceInput.step = '1';
      distanceInput.value = UIUtils.fmt(trigger.value ?? 0, 0);
      distanceInput.addEventListener('change', (e) => {
        _patchEventTrigger(actor, ev, {
          type: 'distance_to_ego',
          value: Math.max(0, parseFloat(e.target.value) || 0),
        });
      });
      const selected = trigger.entity_ref || AppState.ego?.id || '';
      const refSelect = _select(others.length ? others : [['', 'Kein Akteur']], selected);
      refSelect.disabled = others.length === 0;
      refSelect.addEventListener('change', (e) => {
        const current = _eventTrigger(_currentEvent(actor.id, ev.id) || ev);
        const { entity_ref, ...rest } = current;
        _updateEvent(actor, ev.id, {
          trigger: e.target.value === AppState.ego?.id ? rest : { ...rest, entity_ref: e.target.value },
        });
      });
      block.appendChild(_pointDistanceRow(distanceInput, refSelect));
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
      distanceInput.addEventListener('change', (e) => {
        _patchEventTrigger(actor, ev, {
          type: 'distance_to_point',
          value: Math.max(0, parseFloat(e.target.value) || 0),
          entity_ref: trigger.entity_ref || _defaultPointTriggerActorId(actor),
          point: trigger.point || null,
        });
      });

      const targetSelect = _select(_triggerActorOptions(actor), selectedTarget);
      targetSelect.addEventListener('change', (e) => {
        _patchEventTrigger(actor, ev, {
          type: 'distance_to_point',
          value: trigger.value ?? 20,
          entity_ref: e.target.value,
          point: trigger.point || null,
        });
      });
      block.appendChild(_pointDistanceRow(distanceInput, targetSelect));
    } else {
      const valueInput = document.createElement('input');
      valueInput.type = 'number';
      valueInput.min = '0';
      valueInput.step = '0.1';
      valueInput.value = UIUtils.fmt(trigger.value ?? 0, 1);
      valueInput.addEventListener('change', (e) => {
        _patchEventTrigger(actor, ev, {
          type: trigger.type || 'simulation_time',
          value: Math.max(0, parseFloat(e.target.value) || 0),
        });
      });
      block.appendChild(UIUtils.paramRow('Zeit', valueInput, 's'));
    }
  }

  EventPanelCore.define({
    _appendEventTriggerControls,
  });
})();
