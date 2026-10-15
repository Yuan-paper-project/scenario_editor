/**
 * simTimeline.js — the preview bar, simulating the run up front, recording frames and badges, and showing a time.
 *
 * Part of the in-editor preview (Simulate); see simulate.js.
 */
(() => {
  'use strict';

  const {
    SVG_NS,
    run,
    _originals,
    _simActors,
    _tickSpeeds,
    _tickPoses,
    _tickCompleted,
    _tickStarted,
    ACT_TEARDOWN_DISTANCE_M,
    _pose,
    _makeSimActor,
    _footprintOf,
    _stepActor,
    r3,
  } = SimCore.shared;

  // ── Controls (created dynamically) ─────────────────────────────────────────

  // Two rows in a fixed-width card: transport, tempo and the two preview
  // toggles on top (eventTimeline.js appends „Ablauf" to .sim-row-top); the
  // scrub bar and the time underneath, so the bar gets the whole width.
  // Play/Pause/Stop are icon-only; their state („Abspielen" / „Fortsetzen" /
  // „Nochmal") is in the title and in the visually hidden #sim-play-text.
  const controlsHtml = `
    <div id="sim-controls" class="sim-controls hidden">
      <div class="sim-row sim-row-top">
        <button id="sim-play"  class="btn btn-small btn-primary sim-icon-btn" title="Abspielen (Leertaste)" aria-label="Abspielen"><svg class="ic-play" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1l7 4-7 4z"/></svg><svg class="ic-replay" viewBox="0 0 10 10" aria-hidden="true"><path d="M8.3 5.2A3.3 3.3 0 1 1 5 1.9" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4.4 0l2.8 1.9-2.8 1.9z"/></svg><span id="sim-play-text" class="sr-only">Abspielen</span></button>
        <button id="sim-pause" class="btn btn-small btn-secondary sim-icon-btn hidden" title="Anhalten (Leertaste)" aria-label="Pause"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1h2.2v8H2zM5.8 1H8v8H5.8z"/></svg></button>
        <button id="sim-stop"  class="btn btn-small btn-danger sim-icon-btn sim-idle" title="Stopp: Vorschau beenden und zurücksetzen (Esc)" aria-label="Stopp"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5h7v7h-7z"/></svg></button>
        <span class="sim-sep" aria-hidden="true"></span>
        <input  id="sim-speed" type="range" min="0.25" max="4" step="0.25" value="1" title="Tempo (Abspielgeschwindigkeit)" aria-label="Tempo">
        <span   id="sim-speed-label" class="sim-speed-label" title="Tempo">1×</span>
        <span class="sim-row-spacer"></span>
        <button id="sim-ego-react" type="button" class="btn btn-small btn-secondary sim-toggle" aria-pressed="false"
                title="Aus: das Ego reagiert nicht. Ein: es bremst für alles in seinem Fahrweg — zeigt, ob der Konflikt vermeidbar ist">Ego bremst</button>
        <a class="help-link" href="/static/help.html#vorschau" target="_blank" rel="noopener" title="Handbuch: Vorschau" aria-label="Handbuch: Vorschau">?</a>
      </div>
      <div class="sim-row sim-row-timeline">
        <div    id="sim-progress-bar" class="sim-progress-bar" role="slider" tabindex="-1" aria-label="Zeitleiste" aria-valuemin="0" title="Klicken zum Springen — startet die Vorschau angehalten"><div id="sim-progress-fill" class="sim-progress-fill"></div></div>
        <span   id="sim-time-label"  class="sim-time-label" title="Simulierte Zeit / Gesamtdauer">0.0 s</span>
      </div>
    </div>`;

  // Float over the map's lower edge rather than sitting in the header: these
  // are the controls in constant use during a preview, and they belong next to
  // what they animate. #map-bottom-stack keeps them clear of the draw banner.
  const bottomStack = document.getElementById('map-bottom-stack');
  bottomStack.insertAdjacentHTML('beforeend', controlsHtml);

  const simControls = document.getElementById('sim-controls');
  const btnPlay = document.getElementById('sim-play');
  const playText = document.getElementById('sim-play-text');
  const btnPause = document.getElementById('sim-pause');
  const btnStop = document.getElementById('sim-stop');
  const speedSlider = document.getElementById('sim-speed');
  const speedLabel = document.getElementById('sim-speed-label');
  const btnReact = document.getElementById('sim-ego-react');
  const timeLabel = document.getElementById('sim-time-label');
  const progressFill = document.getElementById('sim-progress-fill');
  const progressBar = document.getElementById('sim-progress-bar');

  // ── Simulation lifecycle ──────────────────────────────────────────────────────
  //
  // The whole run is simulated UP FRONT, at CARLA's own fixed 20 Hz tick, and
  // Play only replays the recorded frames. That is what makes the timeline
  // scrubbable: the model is a stateful discrete simulation (fired events,
  // lane-change plans, one-shot triggers, sticky goal stops), so seeking to an
  // arbitrary time would otherwise mean replaying everything up to it — doing
  // that once, at Play, costs tens of milliseconds and buys free seeking.
  // A fixed step is also closer to CARLA than the old rAF-sized one, whose
  // step length depended on the frame rate and the playback speed.

  const SIM_DT_S = 0.05; // ScenarioRunner's synchronous 20 Hz tick
  const MAX_SIM_TIME_S = 60.0; // every Act's MaxSimTime StopTrigger
  const TAIL_AFTER_ACTIVITY_S = 3.0; // keep this much idle time after the last motion

  const timeline = {
    frames: [], // [{t, poses: {id: {x,y,z,yaw}}, badges: {id: badge|null}}]
    end: 0, // seconds; the last recorded frame's t
    markers: [], // [{t, label, kind}] — event starts and the run's end
    endReason: null, // 'teardown' | 'maxtime' | 'idle'
    viewTime: 0, // the time currently on screen
    badgeLayer: null, // our own SVG layer, appended into #world
  };

  function _ensureBadgeLayer() {
    if (timeline.badgeLayer && timeline.badgeLayer.isConnected) return;
    const world = document.getElementById('world');
    timeline.badgeLayer = document.createElementNS(SVG_NS, 'g');
    timeline.badgeLayer.id = 'layer-sim-badges';
    world.appendChild(timeline.badgeLayer);
  }

  function _renderBadges(poses, badges) {
    if (!timeline.badgeLayer) return;
    while (timeline.badgeLayer.firstChild) timeline.badgeLayer.removeChild(timeline.badgeLayer.firstChild);
    for (const [id, badge] of Object.entries(badges || {})) {
      if (!badge || !poses[id]) continue;
      const sim = _simActors.get(id);
      const size = MapView.actorSize(sim ? sim.body || sim.type : 'car');
      const yOff = -Math.max(size.w, size.h) / 2 - 4.5;
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('transform', `translate(${poses[id].x},${poses[id].y + yOff})`);
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '1.8');
      text.setAttribute('fill', '#ffd966');
      text.setAttribute('style', 'pointer-events:none; paint-order: stroke; stroke:#1a1a1a; stroke-width:0.35;');
      text.textContent = `${badge.icon} ${badge.text}`;
      g.appendChild(text);
      timeline.badgeLayer.appendChild(g);
    }
  }

  function _snapshotSpeeds() {
    _tickSpeeds.clear();
    _tickPoses.clear();
    _tickCompleted.clear();
    _tickStarted.clear();
    for (const sim of _simActors.values()) {
      // A magnitude, like CarlaDataProvider.get_velocity — reversing counts positive.
      _tickSpeeds.set(sim.id, Math.abs(sim.speed));
      const p = _pose(sim);
      _tickPoses.set(sim.id, { x: p.x, y: p.y, z: sim.z });
      for (const [eventId, rec] of sim.fired) {
        _tickStarted.set(`${sim.id}::${eventId}`, rec.firedAt);
        if (rec.completedAt != null) _tickCompleted.set(`${sim.id}::${eventId}`, rec.completedAt);
      }
    }
  }

  function _recordFrame(t) {
    const poses = {};
    const badges = {};
    for (const sim of _simActors.values()) {
      const p = _pose(sim);
      poses[sim.id] = { x: p.x, y: p.y, z: sim.z, yaw: sim.yaw };
      badges[sim.id] = sim.badge ? { icon: sim.badge.icon, text: sim.badge.text } : null;
    }
    timeline.frames.push({ t, poses, badges });
  }

  /** A short, human label for an event marker on the timeline. */
  function _markerLabel(sim, ev) {
    const actor = AppState.findById(sim.id);
    const who = actor ? AppState.actorLabel(actor, { short: true }) : sim.id;
    const what = window.EventPanel?.displayName
      ? EventPanel.displayName(ev, sim.events.indexOf(ev))
      : ev.action?.type || ev.id;
    return `${who}: ${what}`;
  }

  /**
   * Steps the prepared _simActors from t = 0 to the end of the run and records
   * one frame per tick. The run ends where ScenarioRunner's would — the ego has
   * driven 500 m, or 60 s have passed (every Act's two StopTrigger groups the
   * preview can model) — or earlier, once nothing has moved and no event has
   * fired for TAIL_AFTER_ACTIVITY_S and none is left that could still fire.
   */
  function _simulateTimeline() {
    timeline.frames = [];
    timeline.markers = [];
    timeline.endReason = 'maxtime';
    const egoSim = run.egoId ? _simActors.get(run.egoId) : null;
    const seen = new Set();
    let lastActivity = 0;
    run.simTime = 0;
    _recordFrame(0);
    while (run.simTime < MAX_SIM_TIME_S - 1e-9) {
      run.simTime = r3(run.simTime + SIM_DT_S);
      const egoPrevPos = egoSim ? { ..._pose(egoSim), z: egoSim.z } : null;
      _snapshotSpeeds();
      for (const sim of _simActors.values()) _stepActor(sim, SIM_DT_S, egoPrevPos, run.simTime);
      _recordFrame(run.simTime);

      let active = false;
      let pending = false;
      for (const sim of _simActors.values()) {
        if (Math.abs(sim.speed) > 0.05 && !sim.frozen && !sim.goalStopped) active = true;
        for (const ev of sim.events) {
          const rec = sim.fired.get(ev.id);
          if (!rec) {
            if (!ev.trigger.neverFires && !sim.frozen) pending = true;
            continue;
          }
          const key = `${sim.id}::${ev.id}`;
          if (!seen.has(key)) {
            seen.add(key);
            active = true;
            timeline.markers.push({ t: rec.firedAt, label: _markerLabel(sim, ev), kind: 'event' });
          }
        }
      }
      if (active) lastActivity = run.simTime;

      if (egoSim && egoSim.traveled >= ACT_TEARDOWN_DISTANCE_M) {
        timeline.endReason = 'teardown';
        break;
      }
      // An unfired distance_to_ego event still has its 60 s OR-fallback ahead
      // of it, so "pending" keeps the run going to the end in that case — the
      // file really does do something at 60 s.
      if (!pending && run.simTime - lastActivity >= TAIL_AFTER_ACTIVITY_S) {
        timeline.endReason = 'idle';
        break;
      }
    }
    timeline.end = run.simTime;
    const endText = {
      teardown: 'Ende — Ego hat 500 m zurückgelegt (Stop-Trigger jedes Acts)',
      maxtime: 'Ende — 60 s erreicht (MaxSimTime jedes Acts)',
      idle: 'Ende — nichts bewegt sich mehr, kein Event steht aus',
    }[timeline.endReason];
    timeline.markers.push({ t: timeline.end, label: endText, kind: 'end' });
  }

  function _prepareSimulation() {
    _originals.clear();
    _simActors.clear();
    _tickSpeeds.clear();
    _tickCompleted.clear();
    _tickStarted.clear();
    run.egoId = null;

    const actors = [];
    if (AppState.ego) {
      actors.push(AppState.ego);
      run.egoId = AppState.ego.id;
    }
    for (const npc of AppState.npcs) actors.push(npc);

    if (actors.length === 0) {
      Toast.warn('Keine Akteure zum Simulieren. Ego oder NPC platzieren.');
      return false;
    }

    for (const actor of actors) {
      _originals.set(actor.id, { x: actor.x, y: actor.y, z: actor.z, yaw: actor.yaw });
      _simActors.set(actor.id, _makeSimActor(actor, actor.id === run.egoId));
    }
    run.staticObstacles = (AppState.staticObjects || []).map((o) => ({
      x: o.x,
      y: o.y,
      ..._footprintOf('prop', o.prop),
    }));
    _snapshotSpeeds(); // so an event firing on the very first tick reads real
    // init speeds rather than an empty map
    _ensureBadgeLayer();
    _simulateTimeline();
    _renderTimelineMarkers();
    return true;
  }

  /** Index of the last frame at or before `t` (frames are SIM_DT_S apart). */
  function _frameIndex(t) {
    return Math.max(0, Math.min(timeline.frames.length - 1, Math.floor(t / SIM_DT_S + 1e-6)));
  }

  function _lerpYaw(a, b, f) {
    const d = ((b - a + 540) % 360) - 180;
    return a + d * f;
  }

  /** Puts the recorded state at time `t` on the map, interpolating between ticks. */
  function _showTime(t) {
    if (!timeline.frames.length) return;
    timeline.viewTime = Math.max(0, Math.min(timeline.end, t));
    const i = _frameIndex(timeline.viewTime);
    const a = timeline.frames[i];
    const b = timeline.frames[Math.min(i + 1, timeline.frames.length - 1)];
    const f = b === a ? 0 : Math.max(0, Math.min(1, (timeline.viewTime - a.t) / (b.t - a.t)));
    const poses = {};
    for (const id of Object.keys(a.poses)) {
      const pa = a.poses[id],
        pb = b.poses[id] || pa;
      poses[id] = {
        x: pa.x + (pb.x - pa.x) * f,
        y: pa.y + (pb.y - pa.y) * f,
        z: pa.z + (pb.z - pa.z) * f,
        yaw: _lerpYaw(pa.yaw, pb.yaw, f),
      };
      AppState.updateById(id, poses[id]);
    }
    _renderBadges(poses, a.badges);
    _renderTimelineHead();
  }

  function _fmtTime(t) {
    return `${t.toFixed(1)} s`;
  }

  // Listeners on the preview's time (eventTimeline.js's playhead): called with
  // the view time on every frame shown, and with null when the preview stops.
  const _timeListeners = [];
  function _emitTime(t) {
    for (const fn of _timeListeners) {
      try {
        fn(t);
      } catch (err) {
        console.warn('[simulate] time listener', err);
      }
    }
  }

  function _renderTimelineHead() {
    _emitTime(timeline.viewTime);
    timeLabel.textContent = `${_fmtTime(timeline.viewTime)} / ${_fmtTime(timeline.end)}`;
    const pct = timeline.end > 0 ? (timeline.viewTime / timeline.end) * 100 : 0;
    progressFill.style.width = `${Math.min(100, pct)}%`;
    progressBar.setAttribute('aria-valuenow', timeline.viewTime.toFixed(1));
    progressBar.setAttribute('aria-valuemax', timeline.end.toFixed(1));
  }

  function _renderTimelineMarkers() {
    progressBar.querySelectorAll('.sim-marker').forEach((n) => n.remove());
    if (!(timeline.end > 0)) return;
    // Several events often fire on the same tick (a chain's first link, every
    // route at t = 0) — one tick mark with all their names in the tooltip.
    const byTick = new Map();
    for (const m of timeline.markers) {
      const key = `${m.kind}:${Math.round(m.t / SIM_DT_S)}`;
      if (!byTick.has(key)) byTick.set(key, { t: m.t, kind: m.kind, labels: [] });
      byTick.get(key).labels.push(m.label);
    }
    for (const m of byTick.values()) {
      if (m.kind === 'end') continue; // the bar's own right edge says that
      const el = document.createElement('div');
      el.className = `sim-marker sim-marker-${m.kind}`;
      el.style.left = `${(m.t / timeline.end) * 100}%`;
      el.title = `${_fmtTime(m.t)} — ${m.labels.join(' · ')}`;
      el.dataset.t = String(m.t);
      progressBar.appendChild(el);
    }
    progressBar.title =
      `${timeline.markers.find((m) => m.kind === 'end')?.label || ''} — ` +
      'klicken oder ziehen zum Springen, ←/→ ±0,5 s (Umschalt ±5 s), Pos1/Ende';
  }

  SimCore.define({
    simControls,
    btnPlay,
    playText,
    btnPause,
    btnStop,
    speedSlider,
    speedLabel,
    btnReact,
    timeLabel,
    progressFill,
    progressBar,
    TAIL_AFTER_ACTIVITY_S,
    timeline,
    _snapshotSpeeds,
    _prepareSimulation,
    _showTime,
    _timeListeners,
    _emitTime,
  });
})();
