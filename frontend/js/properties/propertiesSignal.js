/**
 * propertiesSignal.js — a traffic light's panel and its Schaltung cards.
 *
 * Part of the properties panel; see properties.js.
 */
(() => {
  'use strict';

  const { propsOverview, propsContent, propsTitle, propsDelete, trafficSignalPanel, npcSection } =
    PropertiesCore.shared;

  const btnAddTrafficEvent = document.getElementById('btn-add-traffic-event');
  const trafficSignalEventList = document.getElementById('traffic-signal-event-list');
  const trafficSignalMeta = document.getElementById('traffic-signal-meta');
  const trafficEventCount = document.getElementById('traffic-event-count');

  const TRAFFIC_STATES = [
    ['red', 'Rot'],
    ['yellow', 'Gelb'],
    ['green', 'Grün'],
  ];

  function _renderTrafficSignalPanel(tl) {
    const action = TrafficSignals.actionById(tl.id);
    propsOverview.classList.add('hidden');
    propsContent.classList.remove('hidden');
    const num = String(tl.id).match(/(\d+)$/);
    propsTitle.textContent = num ? `Ampel ${num[1]}` : `Ampel ${tl.id}`;
    if (propsDelete) propsDelete.classList.add('hidden');
    // Hide every actor/prop section explicitly: they share #props-content and would leak through.
    document.getElementById('spawn-panel')?.classList.add('hidden');
    document.getElementById('actor-type-row')?.classList.add('hidden');
    document.getElementById('prop-type-row')?.classList.add('hidden');
    npcSection.classList.add('hidden');
    if (trafficSignalPanel) trafficSignalPanel.classList.remove('hidden');
    if (trafficSignalMeta) {
      trafficSignalMeta.textContent = `${tl.id} · x ${UIUtils.fmt(tl.x)}, y ${UIUtils.fmt(tl.y)}`;
    }
    // A light CARLA lacks would abort the run ("Unknown traffic light"): adding is disabled,
    // existing ones are chipped, and export refuses them.
    const ghost = tl.inCarla === false;
    if (btnAddTrafficEvent) {
      btnAddTrafficEvent.disabled = ghost;
      btnAddTrafficEvent.title = ghost
        ? 'Diese Ampel gibt es in CARLA nicht — sie kann nicht geschaltet werden'
        : 'Ampel umschalten, sobald das Ego sich nähert';
    }
    let chip = document.getElementById('traffic-signal-ghost');
    if (ghost && !chip) {
      chip = document.createElement('div');
      chip.id = 'traffic-signal-ghost';
      chip.className = 'event-problem';
      chip.setAttribute('role', 'status');
      chip.textContent =
        '⚠ Diese Ampel gibt es in CARLA nicht. Eine Schaltung würde den Lauf mit „Unknown traffic light" abbrechen.';
      trafficSignalMeta?.after(chip);
    } else if (!ghost && chip) {
      chip.remove();
    }
    _renderTrafficSignalEvents(tl, action);
  }

  function _defaultTrafficSignalEvent(action) {
    const events = action?.events || [];
    const idx = UIUtils.nextIndexedId(events, 'traffic-event');
    return {
      id: `traffic-event-${idx}`,
      trigger_distance: 40,
      state: 'red',
    };
  }

  function _renderTrafficSignalEvents(tl, action) {
    if (!trafficSignalEventList) return;
    trafficSignalEventList.innerHTML = '';
    const events = action?.events || [];
    if (trafficEventCount) trafficEventCount.textContent = String(events.length);
    if (events.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'event-empty';
      empty.textContent = 'Keine Schaltung — die Ampel folgt ihrem normalen Zyklus.';
      trafficSignalEventList.appendChild(empty);
      return;
    }

    // Laid out like an event card: header, WENN, DANN.
    events.forEach((ev, i) => {
      const card = document.createElement('div');
      card.className = 'event-card traffic-event-card';

      const header = document.createElement('div');
      header.className = 'event-card-header traffic-event-header';
      const title = document.createElement('div');
      title.className = 'event-title-text';
      title.textContent = `Schaltung ${i + 1}`;
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'event-delete';
      deleteBtn.type = 'button';
      deleteBtn.textContent = '×';
      deleteBtn.title = 'Schaltung löschen';
      deleteBtn.setAttribute('aria-label', deleteBtn.title);
      deleteBtn.addEventListener('click', () => _deleteTrafficSignalEvent(tl.id, ev.id));
      header.appendChild(title);
      header.appendChild(deleteBtn);
      card.appendChild(header);

      // WENN: a ReachPositionCondition on hero with this tolerance around the pole.
      const trigger = document.createElement('div');
      trigger.className = 'event-trigger-block';
      const distanceInput = document.createElement('input');
      distanceInput.type = 'number';
      distanceInput.min = '0';
      distanceInput.step = '1';
      distanceInput.value = UIUtils.fmt(ev.trigger_distance ?? 40, 0);
      distanceInput.title = 'Abstand des Ego zum Ampelmast';
      distanceInput.addEventListener('change', (e) => {
        _updateTrafficSignalEvent(tl.id, ev.id, {
          trigger_distance: Math.max(0, parseFloat(e.target.value) || 0),
        });
      });
      const whenRow = document.createElement('div');
      whenRow.className = 'event-row event-primary-row';
      const whenLabel = document.createElement('label');
      whenLabel.textContent = 'Wenn';
      UIUtils.bindLabel(whenLabel, distanceInput);
      const phrase = document.createElement('div');
      phrase.className = 'traffic-when';
      const pre = document.createElement('span');
      pre.textContent = 'Ego näher als';
      const unit = document.createElement('span');
      unit.textContent = 'm';
      phrase.append(pre, distanceInput, unit);
      whenRow.append(whenLabel, phrase);
      trigger.appendChild(whenRow);
      card.appendChild(trigger);

      // DANN
      const thenRow = document.createElement('div');
      thenRow.className = 'event-row';
      const thenLabel = document.createElement('label');
      thenLabel.textContent = 'Dann';
      const picker = _trafficStatePicker(tl.id, ev);
      UIUtils.bindLabel(thenLabel, picker);
      thenRow.appendChild(thenLabel);
      thenRow.appendChild(picker);
      card.appendChild(thenRow);

      trafficSignalEventList.appendChild(card);
    });
  }

  function _trafficStatePicker(signalId, ev) {
    const current = TRAFFIC_STATES.some(([s]) => s === ev.state) ? ev.state : 'red';
    const wrap = document.createElement('div');
    wrap.className = 'event-toggle traffic-state-picker';
    TRAFFIC_STATES.forEach(([state, label]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `traffic-state-option ${state}${state === current ? ' active' : ''}`;
      btn.dataset.state = state;
      btn.setAttribute('aria-pressed', String(state === current));
      const lamp = document.createElement('span');
      lamp.className = 'traffic-state-lamp';
      lamp.setAttribute('aria-hidden', 'true');
      btn.appendChild(lamp);
      btn.appendChild(document.createTextNode(label));
      btn.addEventListener('click', () => _updateTrafficSignalEvent(signalId, ev.id, { state }));
      wrap.appendChild(btn);
    });
    return wrap;
  }

  function _updateTrafficSignalEvent(signalId, eventId, patch) {
    const signal = TrafficSignals.actionById(signalId);
    if (!signal) return;
    const events = (signal.events || []).map((ev) => (ev.id === eventId ? { ...ev, ...patch } : ev));
    TrafficSignals.update(signalId, { events });
  }

  function _deleteTrafficSignalEvent(signalId, eventId) {
    const signal = TrafficSignals.actionById(signalId);
    if (!signal) return;
    const events = (signal.events || []).filter((ev) => ev.id !== eventId);
    TrafficSignals.update(signalId, { events });
  }

  btnAddTrafficEvent.addEventListener('click', () => {
    const id = AppState.selectedTrafficLightId;
    if (!id) return;
    const signal = TrafficSignals.actionById(id);
    if (!signal) return;
    const events = [...(signal.events || []), _defaultTrafficSignalEvent(signal)];
    TrafficSignals.update(id, { events });
  });

  PropertiesCore.define({
    _renderTrafficSignalPanel,
  });
})();
