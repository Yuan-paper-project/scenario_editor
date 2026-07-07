/**
 * simulate.js — Simple trajectory preview simulation.
 *
 * Animates actors along the path selected in the editor.
 * Trajectory mode uses per-waypoint velocities; route mode uses one shared speed.
 * Purely visual — no physics, no collision.
 */
(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────────

  let _running    = false;
  let _paused     = false;
  let _simTime    = 0;       // seconds elapsed in simulation
  let _lastFrame  = 0;       // timestamp of last rAF
  let _animId     = null;
  let _speed      = 1.0;     // playback speed multiplier

  // Snapshot of original positions so we can restore on stop
  let _originals  = new Map();  // actorId → {x, y, yaw}

  // Pre-computed per-actor timeline: [{t, x, y, yaw}]
  let _timelines  = new Map();  // actorId → timeline array

  // Per-NPC activation tracking: actorId → {triggerDist, activatedAt: null|simTime}
  let _npcTriggers = new Map();
  let _egoId       = null;      // ego actor id for distance checks

  // ── Controls (created dynamically) ─────────────────────────────────────────

  const controlsHtml = `
    <div id="sim-controls" class="sim-controls hidden">
      <button id="sim-play"  class="btn btn-small btn-primary" title="Play simulation">Play</button>
      <button id="sim-pause" class="btn btn-small btn-secondary hidden" title="Pause">Pause</button>
      <button id="sim-stop"  class="btn btn-small btn-danger hidden" title="Stop and reset">Stop</button>
      <input  id="sim-speed" type="range" min="0.25" max="4" step="0.25" value="1" title="Playback speed">
      <span   id="sim-speed-label" class="sim-speed-label">1.0x</span>
      <span   id="sim-time-label"  class="sim-time-label">0.0s</span>
      <div    id="sim-progress-bar" class="sim-progress-bar"><div id="sim-progress-fill" class="sim-progress-fill"></div></div>
    </div>`;

  // Insert into header-right (before export buttons)
  const headerRight = document.querySelector('.header-right');
  headerRight.insertAdjacentHTML('afterbegin', controlsHtml);

  const simControls  = document.getElementById('sim-controls');
  const btnPlay      = document.getElementById('sim-play');
  const btnPause     = document.getElementById('sim-pause');
  const btnStop      = document.getElementById('sim-stop');
  const speedSlider  = document.getElementById('sim-speed');
  const speedLabel   = document.getElementById('sim-speed-label');
  const timeLabel    = document.getElementById('sim-time-label');
  const progressBar  = document.getElementById('sim-progress-bar');
  const progressFill = document.getElementById('sim-progress-fill');

  // Show controls once a map is loaded
  AppState.on('change', patch => {
    if ('mapData' in patch && AppState.mapData) {
      simControls.classList.remove('hidden');
    }
  });

  // ── Timeline computation ──────────────────────────────────────────────────────

  /**
   * Build a timeline from a trajectory: array of {t, x, y, yaw} entries.
   * t is cumulative time based on distance / velocity between waypoints.
   */
  function _buildTimeline(trajectory) {
    if (!trajectory || trajectory.length < 2) return null;

    const tl = [{ t: 0, x: trajectory[0].x, y: trajectory[0].y, yaw: 0 }];

    for (let i = 1; i < trajectory.length; i++) {
      const prev = trajectory[i - 1];
      const curr = trajectory[i];
      const dx = curr.x - prev.x;
      const dy = curr.y - prev.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const v1 = prev.velocity || 10;
      const v2 = curr.velocity || 10;
      const avgV = (v1 + v2) / 2 || 1;
      const dt = dist / avgV;
      const yaw = Math.atan2(dy, dx) * 180 / Math.PI;

      tl.push({
        t: tl[tl.length - 1].t + dt,
        x: curr.x,
        y: curr.y,
        yaw: yaw,
      });
    }

    // Compute yaw for the first point from the first segment
    if (tl.length >= 2) {
      tl[0].yaw = tl[1].yaw;
    }

    return tl;
  }

  function _buildRouteTimeline(route, velocity) {
    if (!route || route.length < 2) return null;

    const speed = Math.max(0.1, parseFloat(velocity) || 10);
    const tl = [{ t: 0, x: route[0].x, y: route[0].y, yaw: 0 }];

    for (let i = 1; i < route.length; i++) {
      const prev = route[i - 1];
      const curr = route[i];
      const dx = curr.x - prev.x;
      const dy = curr.y - prev.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const yaw = Math.atan2(dy, dx) * 180 / Math.PI;

      tl.push({
        t: tl[tl.length - 1].t + dist / speed,
        x: curr.x,
        y: curr.y,
        yaw: yaw,
      });
    }

    if (tl.length >= 2) {
      tl[0].yaw = tl[1].yaw;
    }

    return tl;
  }

  function _getActorTimeline(actor) {
    if (!actor) return null;
    if (actor.type !== 'ego') {
      for (const ev of actor.events || []) {
        const action = ev.action || {};
        if (action.type === 'assign_route' && (action.waypoints || []).length >= 2) {
          return _buildRouteTimeline(action.waypoints, 10);
        }
        if (action.type === 'follow_trajectory' && (action.trajectory || []).length >= 2) {
          return _buildTimeline(action.trajectory);
        }
      }
      return null;
    }
    return _buildTimeline(actor.trajectory);
  }

  /**
   * Interpolate position on a timeline at time t.
   * Returns {x, y, yaw} or null if past the end.
   */
  function _interpolate(timeline, t) {
    if (!timeline || timeline.length < 2) return null;
    if (t <= timeline[0].t) return { x: timeline[0].x, y: timeline[0].y, yaw: timeline[0].yaw };

    for (let i = 1; i < timeline.length; i++) {
      if (t <= timeline[i].t) {
        const prev = timeline[i - 1];
        const curr = timeline[i];
        const segDur = curr.t - prev.t;
        const frac = segDur > 0 ? (t - prev.t) / segDur : 0;
        return {
          x:   prev.x + (curr.x - prev.x) * frac,
          y:   prev.y + (curr.y - prev.y) * frac,
          yaw: curr.yaw,  // use segment yaw
        };
      }
    }

    // Past the end — hold at last position
    const last = timeline[timeline.length - 1];
    return { x: last.x, y: last.y, yaw: last.yaw };
  }

  // ── Simulation lifecycle ──────────────────────────────────────────────────────

  function _getMaxTime() {
    let max = 0;
    for (const tl of _timelines.values()) {
      if (tl && tl.length > 0) max = Math.max(max, tl[tl.length - 1].t);
    }
    return max || 1;
  }

  function _prepareSimulation() {
    _originals.clear();
    _timelines.clear();
    _npcTriggers.clear();
    _egoId = null;

    // Gather all actors with a playable path.
    const actors = [];
    if (_getActorTimeline(AppState.ego)) {
      actors.push(AppState.ego);
      _egoId = AppState.ego.id;
    }
    for (const npc of AppState.npcs) {
      if (_getActorTimeline(npc)) {
        actors.push(npc);
      }
    }

    if (actors.length === 0) {
      Toast.warn('No actors have paths to simulate. Draw paths first.');
      return false;
    }

    for (const actor of actors) {
      _originals.set(actor.id, { x: actor.x, y: actor.y, yaw: actor.yaw });
      _timelines.set(actor.id, _getActorTimeline(actor));

      // Track NPC trigger distances (ego has none)
      if (actor.type !== 'ego') {
        _npcTriggers.set(actor.id, {
          triggerDist: actor.trigger_distance || 400,
          activatedAt: null,
        });
      }
    }

    return true;
  }

  function _startSimulation() {
    if (_running && !_paused) return;

    if (!_running) {
      if (!_prepareSimulation()) return;
      _simTime = 0;
      _running = true;
    }
    _paused = false;
    _lastFrame = performance.now();

    btnPlay.classList.add('hidden');
    btnPause.classList.remove('hidden');
    btnStop.classList.remove('hidden');

    // Deselect and disable editing during sim
    AppState.select(null);
    document.body.classList.add('simulating');

    _animId = requestAnimationFrame(_tick);
  }

  function _pauseSimulation() {
    if (!_running || _paused) return;
    _paused = true;
    if (_animId) cancelAnimationFrame(_animId);
    _animId = null;

    btnPlay.classList.remove('hidden');
    btnPlay.textContent = 'Resume';
    btnPause.classList.add('hidden');
  }

  function _stopSimulation() {
    _running = false;
    _paused = false;
    if (_animId) cancelAnimationFrame(_animId);
    _animId = null;

    // Restore original positions
    for (const [id, orig] of _originals) {
      AppState.updateById(id, { x: orig.x, y: orig.y, yaw: orig.yaw });
    }
    _originals.clear();
    _timelines.clear();

    document.body.classList.remove('simulating');
    btnPlay.classList.remove('hidden');
    btnPlay.textContent = 'Play';
    btnPause.classList.add('hidden');
    btnStop.classList.add('hidden');
    timeLabel.textContent = '0.0s';
    progressFill.style.width = '0%';

    MapView.renderAllActors();
  }

  function _tick(now) {
    if (!_running || _paused) return;

    const dt = ((now - _lastFrame) / 1000) * _speed;
    _lastFrame = now;
    _simTime += dt;

    const maxTime = _getMaxTime();

    // Get current ego position for trigger distance checks
    let egoX = 0, egoY = 0;
    if (_egoId) {
      const ego = AppState.findById(_egoId);
      if (ego) { egoX = ego.x; egoY = ego.y; }
    }

    // Update each actor's position
    for (const [id, tl] of _timelines) {
      // For NPCs: check trigger distance activation
      const trigger = _npcTriggers.get(id);
      if (trigger && _egoId) {
        if (trigger.activatedAt === null) {
          // Not yet activated — check distance to ego
          const orig = _originals.get(id);
          const dist = Math.hypot(egoX - orig.x, egoY - orig.y);
          if (dist <= trigger.triggerDist) {
            trigger.activatedAt = _simTime;
          } else {
            continue; // NPC stays at spawn, not activated yet
          }
        }
        // NPC activated — use local time since activation
        const localTime = _simTime - trigger.activatedAt;
        const pos = _interpolate(tl, localTime);
        if (pos) AppState.updateById(id, { x: pos.x, y: pos.y, yaw: pos.yaw });
      } else {
        // Ego or NPC without ego present — use global sim time
        const pos = _interpolate(tl, _simTime);
        if (pos) AppState.updateById(id, { x: pos.x, y: pos.y, yaw: pos.yaw });
      }
    }

    // Update time display and progress bar
    timeLabel.textContent = `${_simTime.toFixed(1)}s`;
    const pct = Math.min(100, (_simTime / maxTime) * 100);
    progressFill.style.width = `${pct}%`;

    // Loop: reset when ego's timeline completes (or max time)
    if (_simTime >= maxTime + 2) {
      _simTime = 0;
      // Reset NPC triggers for the new loop
      for (const trigger of _npcTriggers.values()) {
        trigger.activatedAt = null;
      }
      // Reset NPCs to original positions
      for (const [id, orig] of _originals) {
        if (id !== _egoId) {
          AppState.updateById(id, { x: orig.x, y: orig.y, yaw: orig.yaw });
        }
      }
    }

    _animId = requestAnimationFrame(_tick);
  }

  // ── Event handlers ────────────────────────────────────────────────────────────

  btnPlay.addEventListener('click', _startSimulation);
  btnPause.addEventListener('click', _pauseSimulation);
  btnStop.addEventListener('click', _stopSimulation);

  speedSlider.addEventListener('input', () => {
    _speed = parseFloat(speedSlider.value);
    speedLabel.textContent = `${_speed.toFixed(2)}x`;
  });

  // Click on progress bar to seek
  progressBar.addEventListener('click', e => {
    if (!_running) return;
    const rect = progressBar.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    _simTime = frac * _getMaxTime();
  });

  // Stop simulation if user interacts with editing tools
  AppState.on('change', patch => {
    if (_running && ('activeTool' in patch || 'trajectoryMode' in patch || 'routeMode' in patch)) {
      if (AppState.activeTool || AppState.trajectoryMode || AppState.routeMode) {
        _stopSimulation();
        Toast.info('Simulation stopped — editing resumed');
      }
    }
  });

  // Public API
  window.Simulator = {
    get running() { return _running; },
    start: _startSimulation,
    pause: _pauseSimulation,
    stop:  _stopSimulation,
  };
})();
