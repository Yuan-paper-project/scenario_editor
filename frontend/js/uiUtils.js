/**
 * uiUtils.js — Panel helpers and per-town scenario parking shared across modules (UIUtils).
 */
(() => {
  'use strict';

  // ── Map switch: one scenario per town ───────────────────────────────────────
  // A scenario's poses belong to the town they were placed on. Leaving a town
  // parks its scenario AND its undo history; coming back restores both, and a
  // town never visited (or left empty) starts empty. In memory only — a page
  // reload loses the parked scenarios exactly as it loses the live one, and the
  // save file holds the current town's scenario only. Shared by the map
  // selector (toolbar.js), the .xodr import (mapImport.js) and Laden
  // (scenarioIO.js). The batch generator swaps maps itself and bypasses this.

  const _parked = new Map(); // town → UndoStack.park() result

  function _emitParked() {
    AppState.emit('mapScenariosChanged');
  }

  /** Park the current town's scenario (or forget it, when there is nothing). */
  function leaveMap() {
    window.Simulate?.stop();
    AppState.cancelPlacement();
    const town = AppState.map;
    if (!town) return;
    if (AppState.hasScenarioContent || UndoStack.length || UndoStack.redoLength) {
      AppState.select(null);
      _parked.set(town, UndoStack.park());
    } else {
      _parked.delete(town);
    }
    _emitParked();
  }

  /** Bring `town`'s parked scenario back, or start it empty. Call after
   * AppState.map is set. Returns true when something was restored. */
  function enterMap(town) {
    const entry = _parked.get(town);
    _parked.delete(town);
    _emitParked();
    if (entry) {
      UndoStack.unpark(entry);
      return true;
    }
    AppState.clearScenario();
    UndoStack.clear();
    return false;
  }

  /** A file is about to replace the live scenario: park the current town's if
   * the file is for another one, and drop any parked scenario of the file's
   * own town — the file replaces it, as it does the live one. */
  function beforeLoadFile(fileTown) {
    // Stop a running preview whatever the town: left running, it kept writing
    // poses onto the loaded actors (ids restart at obj-1, so they collide), and
    // its Stop then put the OLD scenario's authored poses back onto them.
    window.Simulate?.stop();
    if (fileTown && AppState.map && fileTown !== AppState.map) leaveMap();
    if (fileTown && _parked.delete(fileTown)) _emitParked();
  }

  /** Towns holding a parked scenario (not counting the current one). */
  function parkedTowns() {
    return [..._parked.keys()];
  }

  // ── Shared panel helpers (properties.js / eventPanel.js) ────────────────────

  let _autoId = 0;

  /* Did the keyboard put focus where it is?
   *
   * Only keys that MOVE focus count. This is deliberately not the browser's own
   * `:focus-visible`, which was tried first and does not work here: its heuristic
   * is "was the most recent interaction a keypress", so pressing Space to start
   * the preview *itself* flips every control into focus-visible, and the second
   * press hands the key straight back to the button. Tab/arrow/Home/End are the
   * only keys that can have delivered focus, so they are the only ones that set
   * this; a bare mousedown clears it.
   */
  let _focusByKeyboard = false;
  document.addEventListener(
    'mousedown',
    () => {
      _focusByKeyboard = false;
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (
        e.key === 'Tab' ||
        e.key === 'Home' ||
        e.key === 'End' ||
        (typeof e.key === 'string' && e.key.startsWith('Arrow'))
      ) {
        _focusByKeyboard = true;
      }
    },
    true,
  );

  window.UIUtils = {
    leaveMap,
    enterMap,
    beforeLoadFile,
    parkedTowns,

    /**
     * True when `el` holds focus *because the user put it there with the
     * keyboard* — tabbed or arrowed onto, rather than left focused by a click.
     *
     * This is the arbiter for "who owns a bare keystroke". Clicking a button
     * leaves it focused, and the browser then turns Space into a click on it:
     * the last tile clicked in the toolbar kept re-arming and disarming itself
     * while the preview never started, and the same held for any panel button
     * and for a scene row that had been clicked. But a keyboard user who tabbed
     * onto Export really does mean Export, so the key cannot simply be taken
     * globally either. Focus modality separates the two exactly — a
     * click-focused control shows no focus ring, so nothing suggests it is armed.
     *
     * Callers that lose the tie must `preventDefault()`: that is what stops the
     * browser generating the click the focused button would otherwise get.
     */
    keyboardFocused(el) {
      if (!el || el === document.body) return false;
      return _focusByKeyboard && el === document.activeElement;
    },

    /**
     * Point `label` at `control`, giving the control an id if it has none.
     * Every control in the properties panel is built in JS, so without this
     * none of them is programmatically labelled — the visible text sits in a
     * <label> that names nothing.
     *
     * A segmented toggle is a <div> of buttons, which `for=` cannot address at
     * all; it becomes a named group instead, which is what it actually is.
     */
    bindLabel(label, control) {
      if (!control) return label;
      if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(control.tagName)) {
        if (!control.id) control.id = `ui-ctl-${++_autoId}`;
        label.htmlFor = control.id;
      } else {
        control.setAttribute('role', 'group');
        control.setAttribute('aria-label', label.textContent);
      }
      return label;
    },

    /** Labelled control row with a trailing unit, as used in event cards. */
    paramRow(labelText, control, unitText) {
      const row = document.createElement('div');
      row.className = 'event-param-row';
      const label = document.createElement('label');
      label.textContent = labelText;
      window.UIUtils.bindLabel(label, control);
      const unit = document.createElement('span');
      unit.style.cssText = 'color:var(--text-dim);font-size:11px;';
      unit.textContent = unitText;
      row.appendChild(label);
      row.appendChild(control);
      row.appendChild(unit);
      return row;
    },

    /**
     * Display precision for a numeric field, chosen to match the input's own
     * `step`: a 0.1/0.5-step field reads 1 dp, a whole-number one reads as an
     * integer. Both the input value and the card summary above it go through
     * this, so they can never disagree (`10` next to `10.0`).
     */
    fmt(value, decimals = 1) {
      const n = Number(value);
      return Number.isFinite(n) ? n.toFixed(decimals) : '';
    },

    /** Next free numeric suffix for `${prefix}-${n}` ids within `events`. */
    nextIndexedId(events, prefix) {
      const used = new Set((events || []).map((ev) => String(ev.id || '')));
      let idx = events.length + 1;
      while (used.has(`${prefix}-${idx}`)) idx += 1;
      return idx;
    },
  };
})();
