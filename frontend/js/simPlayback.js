/**
 * simPlayback.js — Play/Pause/Stop, the tempo and „Ego bremst" switches, keys and scrubbing.
 *
 * Part of the in-editor preview (Simulate); see simulate.js.
 */
(() => {
  'use strict';

  const {
    run,
    _originals,
    _simActors,
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
    timeline,
    _prepareSimulation,
    _showTime,
    _emitTime,
  } = SimCore.shared;

  let _lastFrame = 0; // timestamp of last rAF
  let _animId = null;
  let _speed = 1.0; // playback speed multiplier

  /** The play button is icon-only: its state lives in the hidden text, the
   * tooltip and the accessible name; „Nochmal" swaps in the replay icon. */
  function _setPlayLabel(text) {
    playText.textContent = text;
    btnPlay.title = `${text} (Leertaste)`;
    btnPlay.setAttribute('aria-label', text);
    btnPlay.classList.toggle('replay', text === 'Nochmal');
  }
  // Flipping it re-simulates the run: stop, then reopen at the same time,
  // playing again if it was.
  btnReact.addEventListener('click', () => {
    const was = run.running,
      paused = run.paused,
      t = timeline.viewTime;
    if (was) _stopSimulation();
    run.reactiveEgo = !run.reactiveEgo;
    btnReact.setAttribute('aria-pressed', String(run.reactiveEgo));
    btnReact.classList.toggle('active', run.reactiveEgo);
    if (was) {
      _seek(t);
      if (!paused) _startSimulation();
    }
  });
  // Show controls once a map is loaded
  AppState.on('change', (patch) => {
    if ('mapData' in patch && AppState.mapData) {
      simControls.classList.remove('hidden');
    }
  });

  function _startSimulation() {
    if (run.running && !run.paused) return;

    if (!run.running) {
      /* Finish any half-done placement before the run starts.
       *
       * body.simulating dims the toolbar, but the map SVG stays live for
       * pan/zoom — so an armed tool survived Play, crosshair and all, and the
       * first click on the animating map placed an actor. Clearing the draw
       * flags is also what discards a path that never reached two waypoints
       * (objectsPaths.js `_discardIncompletePath`), which is why this must run
       * BEFORE _prepareSimulation() reads the actors: otherwise the preview
       * would simulate an event that no longer exists. It is also before
       * `run.running = true`, so the "user picked up a tool" handler below — which
       * only reacts to a flag going truthy — never sees it.
       */
      if (AppState.placementActive) {
        AppState.cancelPlacement();
        Toast.info('Platzierung beendet — Vorschau startet');
      }
      // The preview drives the real actors' poses through AppState.updateById
      // (see _showTime), and _stopSimulation puts the originals back the same
      // way. None of that is an edit: without this a single run would push
      // hundreds of entries and bury the user's actual history.
      UndoStack.suspend();
      if (!_prepareSimulation()) {
        UndoStack.resume();
        return;
      }
      timeline.viewTime = 0;
      run.running = true;
      AppState.select(null);
      document.body.classList.add('simulating');
      btnStop.classList.remove('sim-idle');
    } else if (timeline.viewTime >= timeline.end - 1e-6) {
      timeline.viewTime = 0; // Play at the end replays from the start
    }
    run.paused = false;
    _lastFrame = performance.now();

    btnPlay.classList.add('hidden');
    btnPause.classList.remove('hidden');

    _animId = requestAnimationFrame(_tick);
  }

  function _pauseSimulation() {
    if (!run.running || run.paused) return;
    run.paused = true;
    if (_animId) cancelAnimationFrame(_animId);
    _animId = null;

    btnPlay.classList.remove('hidden');
    _setPlayLabel(timeline.viewTime >= timeline.end - 1e-6 ? 'Nochmal' : 'Fortsetzen');
    btnPause.classList.add('hidden');
  }

  /** Jumps to time `t`. Starts a paused preview first when none is running. */
  function _seek(t) {
    if (!run.running) {
      _startSimulation();
      if (!run.running) return;
      _pauseSimulation();
    }
    _showTime(t);
    if (run.paused) _setPlayLabel(timeline.viewTime >= timeline.end - 1e-6 ? 'Nochmal' : 'Fortsetzen');
  }

  function _stopSimulation() {
    // Balances the suspend() in _startSimulation. Read before the flag is
    // cleared: Stop is also reachable when nothing is running (the editing
    // handler below calls this unconditionally), and resuming then would
    // decrement a suspension this module never took.
    const wasRunning = run.running;
    run.running = false;
    run.paused = false;
    if (_animId) cancelAnimationFrame(_animId);
    _animId = null;

    for (const [id, orig] of _originals) {
      AppState.updateById(id, { x: orig.x, y: orig.y, z: orig.z, yaw: orig.yaw });
    }
    _originals.clear();
    _simActors.clear();
    timeline.frames = [];
    timeline.markers = [];
    timeline.end = 0;
    timeline.viewTime = 0;
    if (timeline.badgeLayer)
      while (timeline.badgeLayer.firstChild) timeline.badgeLayer.removeChild(timeline.badgeLayer.firstChild);
    progressBar.querySelectorAll('.sim-marker').forEach((n) => n.remove());
    progressBar.title = 'Klicken zum Springen — startet die Vorschau angehalten';

    document.body.classList.remove('simulating');
    btnPlay.classList.remove('hidden');
    _setPlayLabel('Abspielen');
    btnPause.classList.add('hidden');
    btnStop.classList.add('sim-idle');
    timeLabel.textContent = '0.0 s';
    progressFill.style.width = '0%';
    _emitTime(null);

    // After the originals are back, so the restore is not recorded either.
    if (wasRunning) UndoStack.resume();

    MapView.renderAllActors();
  }

  function _tick(now) {
    if (!run.running || run.paused) return;
    const realDt = Math.min(0.25, (now - _lastFrame) / 1000);
    _lastFrame = now;
    _showTime(timeline.viewTime + realDt * _speed);
    if (timeline.viewTime >= timeline.end - 1e-6) {
      _pauseSimulation(); // hold the last frame; Play replays
      return;
    }
    _animId = requestAnimationFrame(_tick);
  }

  // ── Event handlers ────────────────────────────────────────────────────────────

  btnPlay.addEventListener('click', _startSimulation);
  btnPause.addEventListener('click', _pauseSimulation);
  btnStop.addEventListener('click', _stopSimulation);

  function _togglePlayPause() {
    if (run.running && !run.paused) _pauseSimulation();
    else _startSimulation(); // cold start and resume are the same call
  }

  /* Leertaste = Play/Pause, Esc = Stop.
   *
   * Bubble phase, and no stopPropagation: dialogs.js's confirm dialog and
   * dropdown.js's menus both handle Escape on the CAPTURE phase and stop it
   * there, so they preempt this for free. mapKeys.js is loaded first and runs
   * its own Escape branch before this one — harmless during a run, since
   * _startSimulation has already cleared everything it would clear.
   */
  window.addEventListener('keydown', (e) => {
    if (window.Confirm?.isOpen) return;
    const t = e.target;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === ' ' || e.code === 'Space') {
      // Another handler already claimed it — the scene list's own Space, which
      // locates the focused row.
      if (e.defaultPrevented) return;
      // A control the user TABBED to keeps its own Space: Space on a focused
      // Export means Export. A control merely left focused by an earlier click
      // does not — that is the bug this replaced, where the last-clicked
      // toolbar tile ate every Space and re-armed itself instead of playing.
      // preventDefault below is load-bearing for exactly that case: it is what
      // stops the browser turning this keydown into a click on that button.
      if (UIUtils.keyboardFocused(t)) return;
      if (simControls.classList.contains('hidden')) return; // no map loaded yet
      e.preventDefault(); // and no page scroll
      _togglePlayPause();
      return;
    }

    // ←/→ step through a running preview: 0.5 s, or 5 s with Umschalt. Pauses
    // it first — stepping a moving picture is not stepping.
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && run.running) {
      if (e.defaultPrevented) return;
      e.preventDefault();
      if (!run.paused) _pauseSimulation();
      const step = (e.shiftKey ? 5 : 0.5) * (e.key === 'ArrowLeft' ? -1 : 1);
      _seek(timeline.viewTime + step);
      return;
    }

    // Pos1/Ende jump to the start / the end of a running preview.
    if ((e.key === 'Home' || e.key === 'End') && run.running) {
      if (e.defaultPrevented) return;
      e.preventDefault();
      if (!run.paused) _pauseSimulation();
      _seek(e.key === 'Home' ? 0 : timeline.end);
      return;
    }

    // Stops from either state — run.paused implies run.running.
    if (
      e.key === 'Escape' &&
      run.running &&
      document.getElementById('shortcuts-overlay')?.classList.contains('hidden')
    ) {
      _stopSimulation();
      Toast.info('Vorschau beendet');
    }
  });

  speedSlider.addEventListener('input', () => {
    _speed = parseFloat(speedSlider.value);
    // 0.25× / 0.5× / 1× / 1.75× — no trailing zeros, so the label stops jumping width.
    speedLabel.textContent = `${parseFloat(_speed.toFixed(2))}×`;
  });

  // ── Scrubbing ───────────────────────────────────────────────────────────────
  // The run is recorded up front (_simulateTimeline), so seeking is a frame
  // lookup. Dragging pauses playback and resumes it on release if it was
  // playing; a click on the bar with no preview running starts one, paused.

  function _timeAtPointer(e) {
    const r = progressBar.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
    return f * timeline.end;
  }

  progressBar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (!run.running) _seek(0); // simulate first, so timeline.end is known
    if (!run.running) return;
    const resume = !run.paused;
    _pauseSimulation();
    progressBar.setPointerCapture(e.pointerId);
    progressBar.classList.add('scrubbing');
    // A press on an event tick lands exactly on the event, not on the pixel.
    const tick = e.target.closest?.('.sim-marker');
    _seek(tick ? parseFloat(tick.dataset.t) : _timeAtPointer(e));
    const move = (ev) => _seek(_timeAtPointer(ev));
    const up = () => {
      progressBar.removeEventListener('pointermove', move);
      progressBar.removeEventListener('pointerup', up);
      progressBar.removeEventListener('pointercancel', up);
      progressBar.classList.remove('scrubbing');
      if (resume && timeline.viewTime < timeline.end - 1e-6) _startSimulation();
    };
    progressBar.addEventListener('pointermove', move);
    progressBar.addEventListener('pointerup', up);
    progressBar.addEventListener('pointercancel', up);
  });

  // Stop simulation if user interacts with editing tools
  AppState.on('change', (patch) => {
    if (run.running && ('activeTool' in patch || 'trajectoryMode' in patch || 'routeMode' in patch)) {
      if (AppState.activeTool || AppState.trajectoryMode || AppState.routeMode) {
        _stopSimulation();
        Toast.info('Simulation beendet — Bearbeitung fortgesetzt');
      }
    }
  });

  SimCore.define({ _startSimulation, _pauseSimulation, _seek, _stopSimulation });
})();
