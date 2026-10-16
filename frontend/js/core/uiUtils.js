/**
 * uiUtils.js — Panel helpers and per-town scenario parking shared across modules (UIUtils).
 */
(() => {
  'use strict';

  // ── Map switch: one scenario per town ───────────────────────────────────────
  // Leaving a town parks its scenario and undo history; coming back restores them.
  // In memory only. The batch generator swaps maps itself and bypasses this.

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

  /** Restore `town`'s parked scenario or start empty (after AppState.map is set); true if restored. */
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

  /** Before a file load: park the current town if the file is for another; drop the file town's parked entry. */
  function beforeLoadFile(fileTown) {
    // Stop a running preview first: it would animate the loaded actors (ids collide).
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

  /* Did the keyboard put focus where it is? Only focus-moving keys set it, a mousedown
   * clears it. Not :focus-visible, which pressing Space itself flips on. */
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
     * True when the keyboard (not a click) put focus on `el` — who owns a bare Space.
     * A click-focused button would otherwise turn Space into a click; callers that
     * lose the tie must preventDefault().
     */
    keyboardFocused(el) {
      if (!el || el === document.body) return false;
      return _focusByKeyboard && el === document.activeElement;
    },

    /** Point `label` at `control` (assigning an id); a segmented toggle becomes a named group instead. */
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

    /** Display precision following the input's `step`, shared by the field and the card summary. */
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

    /** An SVG element with the given attributes. */
    svgEl(tag, attrs) {
      const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    },

    /** Ray-casting test; `poly` is an array of [x, y]. */
    pointInPoly(x, y, poly) {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i],
          [xj, yj] = poly[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    },

    /** Degrees normalised into [-180, 180). */
    wrapDeg(deg) {
      return ((((deg + 180) % 360) + 360) % 360) - 180;
    },

    /** 3-D distance between {x, y, z?} points; a missing z counts as 0. */
    dist3(a, b) {
      return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
    },

    /** A split module's internal namespace: `define()` adds names, reading an undefined one from `shared` throws. */
    sharedScope(name) {
      const _shared = {};
      return {
        define(names) {
          for (const [k, v] of Object.entries(names)) {
            if (Object.hasOwn(_shared, k)) throw new Error(`${name}: ${k} defined twice`);
            _shared[k] = v;
          }
        },
        shared: new Proxy(_shared, {
          get(target, k) {
            if (!Object.hasOwn(target, k)) {
              throw new Error(`${name}: ${String(k)} is not defined yet (check the script order in index.html)`);
            }
            return target[k];
          },
        }),
      };
    },
  };
})();
