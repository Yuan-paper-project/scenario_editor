/**
 * eventPanelWidgets.js — selects, segmented toggles and the row helpers every card control is built from.
 *
 * Part of the event panel (EventPanel); see eventPanel.js.
 */
(() => {
  'use strict';

  const {
    SPEED_DIMENSIONS,
    DEFAULT_SPEED_TIME,
    DEFAULT_SPEED_RATE,
    _speedMode,
    _speedDimension,
    _defaultRelativeActorId,
    _eventAction,
    _patchEventAction,
  } = EventPanelCore.shared;

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

  /** _select with <optgroup>s: groups is [{label, options: [[value, text]]}]. */
  function _groupedSelect(groups, selectedValue) {
    const select = document.createElement('select');
    groups.forEach(({ label, options }) => {
      const group = document.createElement('optgroup');
      group.label = label;
      options.forEach(([value, text]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        group.appendChild(option);
      });
      select.appendChild(group);
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
          target:
            value === 'relative'
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

  /** „für" (a hold, seconds) vs „Rate" (a ramp, m/s²) for the
   * SpeedActionDynamics value — a small select inside the speed row. The two are
   * not interchangeable numbers, so a real change re-defaults the value. */
  function _speedDimensionSelect(actor, ev, { rateOnly = false } = {}) {
    const current = _speedDimension(ev);
    const dynamics = _eventAction(ev).dynamics || {};
    const select = _select(SPEED_DIMENSIONS, current);
    select.className = 'event-speed-dim';
    select.setAttribute('aria-label', 'Dynamik');
    select.title =
      'Dynamik — für: Zielgeschwindigkeit sofort, gehalten für N s; ' + 'Rate: Rampe mit N m/s², endet beim Erreichen';
    if (rateOnly) {
      select.querySelector('option[value="time"]').disabled = true;
      select.title += ' (relativ zur eigenen Geschwindigkeit nur mit Rate)';
    }
    select.addEventListener('change', (e) => {
      const value = e.target.value;
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
    return select;
  }

  // ── DOM Helpers ─────────────────────────────────────────────────────────────

  /** A label and several controls side by side — one row per meaning, so a
   * choice and the value it governs never take two rows. The first control
   * gets the label's `for`. */
  function _multiRow(labelText, controls, { className = '' } = {}) {
    const row = document.createElement('div');
    row.className = `event-row event-multi-row ${className}`.trim();
    const label = document.createElement('label');
    label.textContent = labelText;
    UIUtils.bindLabel(label, controls[0]);
    const wrap = document.createElement('div');
    wrap.className = 'event-multi';
    controls.forEach((c) => wrap.appendChild(c));
    row.appendChild(label);
    row.appendChild(wrap);
    return row;
  }

  function _unit(text) {
    const span = document.createElement('span');
    span.className = 'event-unit';
    span.textContent = text;
    return span;
  }

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

  /** `<value> <unit> <dimension select> <dynamics value> <unit>` — or, for a
   * continuous follow, the value followed by a fixed „dauerhaft" (`dimControl`
   * is then that span and `timeInput` null). */
  function _speedTimingRow(speedInput, timeInput, dimControl, valueLabel, isFactor) {
    const row = document.createElement('div');
    row.className = 'event-speed-row';

    const speedLabel = document.createElement('label');
    speedLabel.textContent = valueLabel;
    UIUtils.bindLabel(speedLabel, speedInput);
    const speedUnit = document.createElement('span');
    speedUnit.textContent = isFactor ? '×' : 'm/s';

    row.appendChild(speedLabel);
    row.appendChild(speedInput);
    row.appendChild(speedUnit);
    row.appendChild(dimControl);
    if (timeInput) {
      const timeUnit = document.createElement('span');
      timeUnit.textContent = dimControl.value === 'rate' ? 'm/s²' : 's';
      timeInput.setAttribute('aria-label', dimControl.value === 'rate' ? 'Rate' : 'Dauer');
      row.appendChild(timeInput);
      row.appendChild(timeUnit);
    } else {
      row.classList.add('event-speed-row-fixed');
    }
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

  EventPanelCore.define({
    _select,
    _groupedSelect,
    _axisToggle,
    _speedModeToggle,
    _speedDimensionSelect,
    _multiRow,
    _unit,
    _row,
    _speedTimingRow,
    _pointDistanceRow,
  });
})();
