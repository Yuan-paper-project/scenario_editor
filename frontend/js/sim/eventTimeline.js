/**
 * eventTimeline.js — „Ablauf": one row per actor, one block per event from firing to
 * completion, read off Simulate.runHeadless, with connectors for event references.
 * A block click seeks the preview and marks the event's card; the playhead scrubs.
 * Re-runs 400 ms after an edit while open.
 *
 * Global: EventTimeline — { refresh(), toggle(open?), get open, get data }.
 */
(() => {
  'use strict';

  const DEBOUNCE_MS = 400;
  const RUN_TIME_S = 60; // every Act's MaxSimTime

  const stack = document.getElementById('map-bottom-stack');
  const controls = document.getElementById('sim-controls');
  if (!stack || !controls) return;

  const panel = document.createElement('div');
  panel.id = 'sim-lanes';
  panel.className = 'sim-lanes hidden';
  panel.setAttribute('aria-label', 'Ablauf der Events');
  stack.insertBefore(panel, controls);

  (controls.querySelector('.sim-row-top') || controls).insertAdjacentHTML(
    'beforeend',
    `
    <button id="sim-lanes-toggle" type="button" class="btn btn-small btn-secondary sim-toggle" aria-pressed="false"
            title="Ablauf: alle Events auf einer Zeitachse — Klick springt zum Zeitpunkt">Ablauf</button>`,
  );
  const btn = document.getElementById('sim-lanes-toggle');

  let _open = false;
  let _data = null; // { run, end, rows: [{actor, events: [...]}] }
  let _timer = null;

  const fmt = (t) => `${UIUtils.fmt(t)} s`;

  function _actors() {
    return [AppState.ego, ...AppState.npcs].filter(Boolean);
  }

  function _compute() {
    const actors = _actors();
    if (!actors.length || !AppState.mapData) return null;
    const run = Simulate.runHeadless({ dt: 0.05, maxTime: RUN_TIME_S, stopWhenIdle: true });
    if (!run) return null;
    const end = run.times.length ? run.times[run.times.length - 1] : 0;
    const rows = actors.map((actor) => ({
      actor,
      events: (actor.events || []).map((ev, i) => {
        const firedAt = run.fired[actor.id]?.[ev.id];
        const doneAt = run.completed?.[actor.id]?.[ev.id];
        return { ev, index: i, firedAt: firedAt ?? null, doneAt: doneAt ?? null, name: EventPanel.displayName(ev, i) };
      }),
    }));
    return { run, end: Math.max(end, 1), rows };
  }

  function _render() {
    if (!_open) return;
    if (!_data) {
      panel.innerHTML = '<div class="sim-lanes-empty">Kein Ablauf — Ego oder NPC mit Events platzieren.</div>';
      return;
    }
    const { end, rows } = _data;
    const ticks = [];
    const step = end > 40 ? 10 : end > 15 ? 5 : end > 6 ? 2 : 1;
    for (let t = 0; t <= end + 1e-6; t += step) ticks.push(t);
    const pct = (t) => `${Math.max(0, Math.min(100, (t / end) * 100))}%`;
    const rowHtml = rows
      .map(({ actor, events }) => {
        const blocks = events
          .filter((e) => e.firedAt != null)
          .map((e) => {
            const open = e.doneAt == null;
            const w = Math.max(0.6, (((open ? end : e.doneAt) - e.firedAt) / end) * 100);
            const title =
              `${e.name} — ${fmt(e.firedAt)}${open ? ' bis Ende (läuft weiter)' : ` bis ${fmt(e.doneAt)}`}` +
              ' · Klick springt hierher';
            return `<div class="sim-lane-block${open ? ' open' : ''}"
                     style="left:${pct(e.firedAt)};width:${w}%"
                     data-actor="${actor.id}" data-event="${e.ev.id}" data-t="${e.firedAt}" title="${UIUtils.escapeHtml(title)}">
                  <span>${UIUtils.escapeHtml(e.name)}</span></div>`;
          })
          .join('');
        const never = events.filter((e) => e.firedAt == null);
        const neverHtml = never.length
          ? `<span class="sim-lane-never" title="${UIUtils.escapeHtml(never.map((e) => e.name).join(', '))} feuert in diesem Lauf nie">nie: ${never.length}</span>`
          : '';
        return `<div class="sim-lane-row">
        <button type="button" class="sim-lane-label" data-actor="${actor.id}" title="Akteur zeigen">${UIUtils.escapeHtml(AppState.actorLabel(actor, { short: true }))}</button>
        <div class="sim-lane-track">${blocks}</div>
        ${neverHtml || '<span></span>'}
      </div>`;
      })
      .join('');
    panel.innerHTML = `
      <div class="sim-lane-row sim-lane-axis"><span></span>
        <div class="sim-lane-track">${ticks.map((t) => `<span class="sim-lane-tick" style="left:${pct(t)}">${t}s</span>`).join('')}</div>
        <span></span>
      </div>
      ${rowHtml}
      <svg class="sim-lane-links" aria-hidden="true"></svg>
      <div class="sim-lane-playhead" title="Aktueller Zeitpunkt der Vorschau — ziehen zum Springen"></div>`;
    _drawLinks();
    _placePlayhead();
  }

  /* ── Playhead ──────────────────────────────────────────────────────────
   * On this panel's axis, not the preview bar's: with „Ego bremst" on the runs end differently. */
  let _lastTime = null;

  function _axisTrack() {
    return panel.querySelector('.sim-lane-axis .sim-lane-track');
  }

  function _placePlayhead(t = _lastTime) {
    const head = panel.querySelector('.sim-lane-playhead');
    const track = _axisTrack();
    if (!head || !track || !_data) return;
    const box = panel.getBoundingClientRect(),
      tr = track.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (t ?? 0) / _data.end));
    head.style.left = `${tr.left - box.left + panel.scrollLeft + f * tr.width}px`;
    head.style.height = `${panel.scrollHeight}px`;
    head.classList.toggle('idle', t == null);
  }

  function _timeAt(clientX) {
    const tr = _axisTrack().getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - tr.left) / Math.max(1, tr.width))) * _data.end;
  }

  Simulate.onTime((t) => {
    _lastTime = t;
    if (t == null) EventPanel.highlight(null); // the mark is a preview-time aid
    if (_open) _placePlayhead(t);
  });

  // Scrub like the bar: pause while dragging, resume after; starts a paused preview if none runs.
  panel.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !_data) return;
    if (!e.target.closest('.sim-lane-playhead, .sim-lane-axis')) return;
    e.preventDefault();
    const resume = Simulate.running && !Simulate.paused;
    Simulate.seek(_timeAt(e.clientX));
    if (!Simulate.running) return;
    Simulate.pause();
    panel.setPointerCapture(e.pointerId);
    panel.classList.add('scrubbing');
    const move = (ev) => Simulate.seek(_timeAt(ev.clientX));
    const up = () => {
      panel.removeEventListener('pointermove', move);
      panel.removeEventListener('pointerup', up);
      panel.removeEventListener('pointercancel', up);
      panel.classList.remove('scrubbing');
      if (resume && Simulate.time < Simulate.end - 1e-6) Simulate.play();
    };
    panel.addEventListener('pointermove', move);
    panel.addEventListener('pointerup', up);
    panel.addEventListener('pointercancel', up);
  });

  /** Connectors from each referenced event to the one waiting on it: from the
   * referenced block's end (after_event) or start (event_started). */
  function _drawLinks() {
    const svg = panel.querySelector('.sim-lane-links');
    if (!svg) return;
    const box = panel.getBoundingClientRect();
    svg.setAttribute('width', box.width);
    svg.setAttribute('height', box.height);
    const blockOf = (actorId, eventId) =>
      panel.querySelector(`.sim-lane-block[data-actor="${actorId}"][data-event="${eventId}"]`);
    let paths = '';
    for (const { actor, events } of _data.rows) {
      for (const e of events) {
        const t = e.ev.trigger || {};
        if (t.type !== 'after_event' && t.type !== 'event_started') continue;
        const to = blockOf(actor.id, e.ev.id);
        const from = blockOf(t.actor_ref || actor.id, t.event_id);
        if (!to || !from) continue;
        const a = from.getBoundingClientRect(),
          b = to.getBoundingClientRect();
        const x1 = (t.type === 'after_event' ? a.right : a.left) - box.left,
          y1 = a.top + a.height / 2 - box.top;
        const x2 = b.left - box.left,
          y2 = b.top + b.height / 2 - box.top;
        const mx = Math.max(x1, x2) - 6;
        paths += `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`;
      }
    }
    svg.innerHTML = paths;
  }

  function refresh() {
    clearTimeout(_timer);
    _timer = null;
    if (!_open) return;
    // runHeadless refuses beside a preview: keep the last result, or say why there is none.
    if (Simulate.running) {
      if (_data) _render();
      else panel.innerHTML = '<div class="sim-lanes-empty">Vorschau läuft — der Ablauf erscheint nach Stopp.</div>';
      return;
    }
    try {
      _data = _compute();
    } catch (err) {
      console.warn('[eventTimeline]', err);
      _data = null;
    }
    _render();
  }

  function _schedule() {
    if (!_open) return;
    clearTimeout(_timer);
    _timer = setTimeout(refresh, DEBOUNCE_MS);
  }

  function toggle(open = !_open) {
    _open = !!open;
    panel.classList.toggle('hidden', !_open);
    btn.setAttribute('aria-pressed', String(_open));
    btn.classList.toggle('active', _open);
    if (_open) {
      panel.style.width = `${controls.getBoundingClientRect().width}px`;
      refresh();
    }
  }

  panel.addEventListener('click', (e) => {
    const block = e.target.closest('.sim-lane-block');
    if (block) {
      Simulate.seek(Number(block.dataset.t));
      // Highlight before selecting: the select re-renders the panel, which reads the highlight.
      EventPanel.highlight(block.dataset.actor, block.dataset.event);
      if (AppState.selectedId !== block.dataset.actor) AppState.select(block.dataset.actor);
      else AppState.emit('selectionChanged', AppState.selectedId);
      return;
    }
    const label = e.target.closest('.sim-lane-label');
    if (label) MapView.focusActor(label.dataset.actor);
  });
  btn.addEventListener('click', () => toggle());

  const IGNORED_KEYS = new Set([
    'selectedId',
    'selectedTrafficLightId',
    'selectedWaypoint',
    'activeTool',
    'pendingTemplate',
    'pendingProp',
    'pendingGenerate',
    'trajectoryMode',
    'activeTrajectoryId',
    'routeMode',
    'activeRouteId',
    'activePathEventId',
    'weather',
    'time',
    'userTemplates',
  ]);
  AppState.on('change', (patch) => {
    const keys = Object.keys(patch || {});
    if (keys.length && keys.every((k) => IGNORED_KEYS.has(k))) return;
    _schedule();
  });
  for (const evt of ['actorUpdated', 'actorRemoved', 'stateLoaded']) {
    AppState.on(evt, () => {
      if (!Simulate.running) _schedule();
    });
  }

  window.EventTimeline = {
    refresh,
    toggle,
    get open() {
      return _open;
    },
    get data() {
      return _data;
    },
  };
})();
