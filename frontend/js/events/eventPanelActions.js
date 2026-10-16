/**
 * eventPanelActions.js — the per-action controls: speed, distance, lane change, lane offset.
 *
 * Part of the event panel (EventPanel); see eventPanel.js.
 */
(() => {
  'use strict';

  const {
    DEFAULT_SPEED_TIME,
    DEFAULT_SPEED_RATE,
    DEFAULT_LANE_OFFSET_M,
    MAX_LANE_OFFSET_M,
    FALLBACK_LANE_WIDTH_M,
    DEFAULT_SPEED_FACTOR,
    RETURN_LANE_OFFSET_HINT,
    CONTINUOUS_SPEED_HINT,
    FIXED_LANE_OFFSET_HINT,
    _speedMode,
    _speedDimension,
    _defaultRelativeActorId,
    _relativeActorOptions,
    _eventAction,
    _patchEventAction,
    _select,
    _axisToggle,
    _speedModeToggle,
    _speedDimensionSelect,
    _multiRow,
    _unit,
    _row,
    _speedTimingRow,
  } = EventPanelCore.shared;

  // ── Action Controls ─────────────────────────────────────────────────────────

  /** Geschw. setzen: Modus + reference (or Vor/Rück), Art + Folgen when relative, then value + dynamics. */
  function _appendSpeedActionControls(card, actor, ev, action) {
    const speedTarget = action.target || { mode: 'absolute', value: 10.0 };
    const speedDynamics = action.dynamics || { shape: 'step', dimension: 'time', value: 5.0 };
    const isRelativeSpeed = _speedMode(ev) === 'relative';
    const isFactor = isRelativeSpeed && speedTarget.value_type === 'factor';
    const isSelf = isRelativeSpeed && speedTarget.entity_ref === actor.id;
    const isContinuous = isRelativeSpeed && speedTarget.continuous === true && !isSelf;

    const modeControls = [_speedModeToggle(actor, ev)];
    if (isRelativeSpeed) {
      // Relative to oneself is only safe as a one-shot `rate` ramp, so choosing it switches to Rate.
      const targetOptions = [..._relativeActorOptions(actor), [actor.id, 'Eigene Geschw.']];
      const selectedTarget = speedTarget.entity_ref || _defaultRelativeActorId(actor);
      const targetSelect = _select(targetOptions, selectedTarget);
      targetSelect.className = 'event-speed-ref';
      targetSelect.setAttribute('aria-label', 'Relativ zu');
      targetSelect.title =
        'Relativ zu — „Eigene Geschw.": Ziel ist die eigene Geschwindigkeit ' +
        'beim Start, z. B. Faktor 0,5 = auf die Hälfte abbremsen (nur mit Rate)';
      targetSelect.addEventListener('change', (e) => {
        const self = e.target.value === actor.id;
        const patch = { target: { ...speedTarget, mode: 'relative', entity_ref: e.target.value } };
        if (self) {
          patch.target.continuous = false;
          if (_speedDimension(ev) !== 'rate') {
            patch.dynamics = { ...speedDynamics, dimension: 'rate', shape: 'linear', value: DEFAULT_SPEED_RATE };
          }
        }
        _patchEventAction(actor, ev, patch);
      });
      modeControls.push(targetSelect);
    } else if (ScenarioRules.canReverse(actor.type)) {
      const dir = _toggle(
        actor,
        ev,
        [
          ['forward', 'Vor'],
          ['reverse', 'Rück'],
        ],
        speedTarget.reverse === true ? 'reverse' : 'forward',
        (value) => ({ target: { ...speedTarget, mode: 'absolute', reverse: value === 'reverse' } }),
      );
      dir.title =
        'Richtung — Rück: das Fahrzeug fährt rückwärts, ohne sich zu drehen ' +
        '(SimpleVehicleControl kehrt nur die Geschwindigkeit um)';
      dir.querySelector('[data-value="forward"]').title = 'Vorwärts';
      dir.querySelector('[data-value="reverse"]').title = 'Rückwärts';
      modeControls.push(dir);
    }
    card.appendChild(_multiRow('Modus', modeControls));

    if (isRelativeSpeed) {
      const art = _toggle(
        actor,
        ev,
        [
          ['delta', 'Δ'],
          ['factor', '×'],
        ],
        isFactor ? 'factor' : 'delta',
        (value) => ({ target: { ...speedTarget, value_type: value } }),
      );
      art.title = 'Art — Δ: Bezugsgeschw. plus Differenz; ×: Bezugsgeschw. mal Faktor';
      art.querySelector('[data-value="delta"]').title = 'Differenz (m/s)';
      art.querySelector('[data-value="factor"]').title = 'Faktor';
      const controls = [art];
      if (!isSelf) {
        const follow = _toggle(
          actor,
          ev,
          [
            ['once', 'Einmal'],
            ['continuous', 'Dauer'],
          ],
          isContinuous ? 'continuous' : 'once',
          (value) => ({ target: { ...speedTarget, continuous: value === 'continuous' } }),
        );
        follow.title =
          'Folgen — Einmal: Ziel beim Start bzw. für die Dauer nachgeführt. ' +
          'Dauer: folgt dem Bezugsakteur, bis ein anderes Event übernimmt.';
        controls.push(follow);
      }
      card.appendChild(_multiRow('Art', controls));
    }

    const speedInput = document.createElement('input');
    speedInput.type = 'number';
    speedInput.max = isFactor ? '10' : '100';
    speedInput.step = isFactor ? '0.05' : '0.5';
    speedInput.value = isFactor
      ? UIUtils.fmt(speedTarget.factor ?? DEFAULT_SPEED_FACTOR, 2)
      : UIUtils.fmt(isRelativeSpeed ? (speedTarget.delta ?? 10.0) : (speedTarget.value ?? 10.0));
    speedInput.addEventListener('change', (e) => {
      const parsed = parseFloat(e.target.value);
      const value = Number.isFinite(parsed) ? parsed : 0;
      _patchEventAction(actor, ev, {
        target: isFactor
          ? { ...speedTarget, mode: 'relative', factor: Math.min(10, Math.max(0, value)) }
          : isRelativeSpeed
            ? { ...speedTarget, mode: 'relative', delta: value }
            : { ...speedTarget, mode: 'absolute', value: Math.max(0, value) },
      });
    });
    if (!isRelativeSpeed || isFactor) speedInput.min = '0';
    const valueLabel = isFactor ? 'Faktor' : isRelativeSpeed ? 'Δ Geschw.' : 'Geschw.';

    if (isContinuous) {
      const fact = document.createElement('span');
      fact.className = 'event-fixed-trigger-text';
      fact.textContent = 'dauerhaft';
      fact.title = CONTINUOUS_SPEED_HINT;
      card.appendChild(_speedTimingRow(speedInput, null, fact, valueLabel, isFactor));
      return;
    }

    const isRate = _speedDimension(ev) === 'rate';
    const dynFloor = isRate ? 0.1 : 0; // a rate of 0 never reaches its target
    const timeInput = document.createElement('input');
    timeInput.type = 'number';
    timeInput.min = String(dynFloor);
    timeInput.step = '0.1';
    timeInput.value = UIUtils.fmt(speedDynamics.value ?? (isRate ? DEFAULT_SPEED_RATE : DEFAULT_SPEED_TIME));
    timeInput.addEventListener('change', (e) => {
      _patchEventAction(actor, ev, {
        dynamics: {
          ...speedDynamics,
          shape: isRate ? 'linear' : speedDynamics.shape || 'step',
          dimension: isRate ? 'rate' : 'time',
          value: Math.max(dynFloor, parseFloat(e.target.value) || 0),
        },
      });
    });
    card.appendChild(
      _speedTimingRow(
        speedInput,
        timeInput,
        _speedDimensionSelect(actor, ev, { rateOnly: isSelf }),
        valueLabel,
        isFactor,
      ),
    );
  }

  /** A segmented toggle whose click patches the action with `patchFor(value)`. */
  function _toggle(actor, ev, options, current, patchFor) {
    const wrap = document.createElement('div');
    wrap.className = 'event-toggle';
    options.forEach(([value, label]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.dataset.value = value;
      btn.className = value === current ? 'active' : '';
      btn.addEventListener('click', () => {
        if (value === current) return;
        _patchEventAction(actor, ev, patchFor(value));
      });
      wrap.appendChild(btn);
    });
    return wrap;
  }

  function _appendDistanceActionControls(card, actor, ev, action) {
    card.appendChild(_row('Richtung', _axisToggle(actor, ev)));

    const targetOptions = _relativeActorOptions(actor);
    const selectedTarget = action.entity_ref || _defaultRelativeActorId(actor);
    const targetSelect = _select(targetOptions.length ? targetOptions : [['', 'Kein Akteur']], selectedTarget);
    targetSelect.disabled = targetOptions.length === 0;
    targetSelect.addEventListener('change', (e) => {
      _patchEventAction(actor, ev, { entity_ref: e.target.value });
    });
    card.appendChild(_row('Relativ zu', targetSelect));

    const distanceInput = document.createElement('input');
    distanceInput.type = 'number';
    distanceInput.step = '0.1';
    distanceInput.value = UIUtils.fmt(action.value ?? 10.0);
    distanceInput.addEventListener('change', (e) => {
      const parsed = parseFloat(e.target.value);
      _patchEventAction(actor, ev, { value: Number.isFinite(parsed) ? parsed : 0 });
    });
    // Not 'Distanz': lane_change's dynamics value is a distance too, with another meaning.
    card.appendChild(UIUtils.paramRow('Sollabstand', distanceInput, 'm'));
  }

  function _appendLaneChangeControls(card, actor, ev, action) {
    const laneDynamics = action.dynamics || { shape: 'linear', value: 12.0 };
    const directionSelect = _select(
      [
        ['left', 'Links'],
        ['right', 'Rechts'],
      ],
      action.direction === 'right' ? 'right' : 'left',
    );
    directionSelect.addEventListener('change', (e) => {
      _patchEventAction(actor, ev, { direction: e.target.value === 'right' ? 'right' : 'left' });
    });
    const durationInput = document.createElement('input');
    durationInput.type = 'number';
    durationInput.min = '0';
    durationInput.step = '0.1';
    durationInput.value = UIUtils.fmt(laneDynamics.value ?? 12.0);
    durationInput.addEventListener('change', (e) => {
      _patchEventAction(actor, ev, {
        dynamics: {
          ...laneDynamics,
          shape: laneDynamics.shape || 'linear',
          value: Math.max(0, parseFloat(e.target.value) || 0),
        },
      });
    });
    // The distance the lateral move takes (_buildLaneChangePlan); the long label is in the title.
    durationInput.title = 'Strecke, über die der Spurwechsel ausgeführt wird';
    directionSelect.setAttribute('aria-label', 'Richtung');
    card.appendChild(
      _multiRow('Richtung', [directionSelect, _unit('über'), durationInput, _unit('m')], {
        className: 'event-lane-change-row',
      }),
    );
  }

  /** Spurversatz: side, magnitude and mode (Dauerhaft | Hin & zurück). */
  function _appendLaneOffsetControls(card, actor, ev, action) {
    const offsetInput = document.createElement('input');
    offsetInput.type = 'number';
    offsetInput.min = '0';
    offsetInput.max = String(MAX_LANE_OFFSET_M);
    offsetInput.step = '0.1';
    offsetInput.value = UIUtils.fmt(action.offset ?? DEFAULT_LANE_OFFSET_M);
    offsetInput.addEventListener('change', (e) => {
      const parsed = parseFloat(e.target.value);
      _patchEventAction(actor, ev, {
        offset: Math.min(MAX_LANE_OFFSET_M, Math.max(0, Number.isFinite(parsed) ? parsed : 0)),
      });
    });
    offsetInput.title = 'Versatz — seitlicher Abstand zur Spurmitte; 0 m bedeutet zurück in die Mitte';
    offsetInput.setAttribute('aria-label', 'Versatz');

    // ½ straddles the lane line, 1 reaches the next lane's centre; lanes are not all 3.5 m (Town01/02: 4 m).
    const width = _laneWidthAt(actor);
    const presets = document.createElement('div');
    presets.className = 'event-toggle event-offset-presets';
    [
      ['half', '½', width / 2],
      ['full', '1', width],
    ].forEach(([key, label, metres]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.preset = key;
      btn.textContent = label;
      btn.title =
        `${key === 'half' ? 'Halbe Spur' : 'Ganze Spur'}: ${UIUtils.fmt(metres, 2)} m ` +
        `— Spurbreite hier ${UIUtils.fmt(width, 2)} m`;
      btn.addEventListener('click', () => {
        _patchEventAction(actor, ev, { offset: Math.round(metres * 100) / 100 });
      });
      presets.appendChild(btn);
    });
    card.appendChild(
      _multiRow('Seite', [_lateralDirectionToggle(actor, ev), offsetInput, _unit('m'), presets], {
        className: 'event-offset-row',
      }),
    );

    const held = action.continuous !== false;
    const mode = _toggle(
      actor,
      ev,
      [
        ['held', 'Dauerhaft'],
        ['return', 'Hin & zurück'],
      ],
      held ? 'held' : 'return',
      (value) => ({ continuous: value === 'held' }),
    );
    mode.title = held ? FIXED_LANE_OFFSET_HINT : RETURN_LANE_OFFSET_HINT;
    card.appendChild(_row('Dauer', mode));
  }

  /** Width of the driving lane under the actor (render JSON `widths`), else FALLBACK_LANE_WIDTH_M. */
  function _laneWidthAt(actor) {
    const near = ObjectsManager.nearestLaneProjection(actor.x, actor.y, new Set(['driving']), 10);
    const w = near && near.lane.widths ? near.lane.widths[near.segIndex] : null;
    return Number.isFinite(w) && w > 0.5 ? w : FALLBACK_LANE_WIDTH_M;
  }

  /** Links | Rechts, for an action whose direction is a side of the lane. */
  function _lateralDirectionToggle(actor, ev) {
    const current = _eventAction(ev).direction === 'right' ? 'right' : 'left';
    const wrap = document.createElement('div');
    wrap.className = 'event-toggle';

    [
      ['left', 'Links'],
      ['right', 'Rechts'],
    ].forEach(([value, label]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.className = value === current ? 'active' : '';
      btn.addEventListener('click', () => {
        if (value === current) return;
        _patchEventAction(actor, ev, { direction: value });
      });
      wrap.appendChild(btn);
    });
    return wrap;
  }

  EventPanelCore.define({
    _appendSpeedActionControls,
    _appendDistanceActionControls,
    _appendLaneChangeControls,
    _appendLaneOffsetControls,
  });
})();
