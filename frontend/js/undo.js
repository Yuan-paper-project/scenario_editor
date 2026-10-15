/**
 * undo.js — Snapshot-based undo/redo of the scenario (UndoStack).
 */
(() => {
  'use strict';

  // ── Undo / redo history ──────────────────────────────────────────────────────

  /**
   * Snapshot-based undo, captured automatically at AppState's three mutators.
   *
   * Every scenario edit in the app goes through set() / updateById() /
   * removeById() — placement, the body and yaw drags, the Spawnpunkt fields,
   * type swaps, event add/edit/delete, waypoints, trigger points, templates —
   * so nothing has to be instrumented at the call site and an edit added later
   * is covered for free. The exception is TrafficSignals.update(), which
   * rewrites AppState.trafficSignals directly and calls record() itself.
   *
   * This replaces a stack that held one deleted actor per entry. Its failure
   * mode was worse than a missing feature: Strg+Z after a misplaced drag popped
   * an unrelated *delete* from earlier in the session and resurrected that
   * actor, while the drag stood.
   *
   * Scope is the scenario objects only. `map`/`mapData` stay out because
   * undoing a town switch would need an async re-fetch, and weather/time stay
   * out because they are a global setting rather than an edit (their sliders
   * are also the only controls in the app that fire on `input` rather than
   * `change`, so they would need coalescing of their own).
   */

  // Raised from 50 once event edits and waypoints started recording: drawing a
  // long path is one entry per waypoint, and a short stack would let a single
  // path evict every placement behind it.
  const MAX_HISTORY = 100;

  const _undo = []; // states BEFORE each edit, oldest first
  const _redo = []; // states AFTER each undone edit
  let _baseline = null; // the scenario as of the last settled edit
  let _openKind = null; // coalescing key of the edit currently in progress
  let _suspend = 0; // >0 while something else owns the actor poses
  let _groupDepth = 0;
  let _groupLabel = null;
  let _groupTaken = false;

  const SCENARIO_KEYS = ['ego', 'npcs', 'staticObjects', 'trafficSignals', 'generated'];

  /**
   * Deep copy of the scenario half of AppState.
   *
   * A JSON round-trip and not AppState.toJSON(): _dumpActor() spreads each
   * event, so an action's `trajectory`/`waypoints` array stays shared with the
   * live state — a snapshot taken that way would be rewritten in place by the
   * very edit it is supposed to be the "before" of.
   */
  function _snapshot(label) {
    const copy = JSON.parse(
      JSON.stringify({
        ego: AppState.ego,
        npcs: AppState.npcs,
        staticObjects: AppState.staticObjects,
        trafficSignals: AppState.trafficSignals,
        generated: AppState.generated,
      }),
    );
    copy.label = label || '';
    copy.selectedId = AppState.selectedId;
    copy.selectedTrafficLightId = AppState.selectedTrafficLightId;
    return copy;
  }

  /**
   * Push the "before" of an edit about to happen.
   *
   * What gets pushed is `_baseline` — the state as of the last settled edit —
   * and NOT a snapshot taken here. The two are not the same, because the
   * placement paths mutate the array first and only then announce it
   * (`AppState.npcs = [...]; AppState.set({})`), so by the time set() runs, the
   * "before" state is already gone. _settle() refreshes the baseline after each
   * mutation instead, which is the one point where the state is known-good.
   *
   * `kind` is the coalescing key: consecutive edits sharing one collapse into a
   * single entry, which is what makes a drag — dozens of updateById calls with
   * the same id and the same patch keys — one Strg+Z. Pass null for an edit
   * that must always start its own entry. seal() ends the current run, so two
   * deliberate edits that happen to produce the same key stay separate.
   */
  function _record(kind, label) {
    if (_suspend > 0) return;
    if (_baseline === null) _baseline = _snapshot('');
    if (_groupDepth > 0) {
      if (_groupTaken) return;
      _groupTaken = true;
      label = _groupLabel || label;
    } else {
      if (kind !== null && kind === _openKind) return;
      _openKind = kind;
    }
    _baseline.label = label || '';
    _undo.push(_baseline);
    _baseline = null; // _settle() takes the post-edit state
    if (_undo.length > MAX_HISTORY) _undo.shift();
    _redo.length = 0;
  }

  /** Re-read the baseline once an edit has been applied. */
  function _settle() {
    if (_suspend > 0) return;
    _baseline = _snapshot('');
  }

  /** True for a patch that touches the scenario rather than editor-only state. */
  function _isScenarioPatch(patch) {
    const keys = Object.keys(patch);
    // An empty patch is this codebase's signal that one of the state arrays was
    // mutated in place (`AppState.npcs = [...]; AppState.set({})`), which is how
    // every placement and the bulk prop delete announce themselves.
    if (keys.length === 0) return true;
    return keys.some((k) => SCENARIO_KEYS.includes(k));
  }

  // Patch shapes worth naming in the toast. Everything else undoes as a plain
  // "Rückgängig" rather than guessing a name for it.
  const PATCH_LABELS = [
    [['x', 'y', 'z'], 'Verschieben'],
    [['yaw'], 'Drehen'],
    [['type'], 'Typwechsel'],
    [['prop'], 'Typwechsel'],
    [['initial_speed'], 'Startgeschwindigkeit'],
    [['max_acceleration'], 'Max. Beschleunigung'],
    [['max_deceleration'], 'Max. Verzögerung'],
    // Last, so a bare {yaw} still reads 'Drehen': the Spawnpunkt fields commit
    // all four together (_onPosChange), and naming the panel section is more
    // use than picking one of the four to name.
    [['x', 'y', 'z', 'yaw'], 'Spawnpunkt'],
  ];

  function _labelForPatch(patch) {
    const keys = Object.keys(patch);
    if (!keys.length) return '';
    const hit = PATCH_LABELS.find(([fields]) => keys.every((k) => fields.includes(k)));
    return hit ? hit[1] : '';
  }

  function _recordSet() {
    // null kind: every scenario set() is a discrete act (a placement, a bulk
    // delete) and must never fold into the one before it.
    _record(null, '');
  }

  /** True when every field in the patch already holds that value. */
  /**
   * Waypoint 1 of every path event is the actor's own pose, so an actor that
   * moves takes it with it. Without this the seed stays where the path was
   * drawn and the actor routes back to a point it has since left — visible as a
   * route that starts by driving backwards.
   *
   * Folded into the caller's patch rather than issued as a second updateById:
   * `events` then rides along in the SAME patch as x/y, so the move and the
   * seed are one undo entry instead of two that can be separated.
   *
   * `events` is attached whenever the actor has a path at all, even on the
   * frames where the snap leaves the seed exactly where it was. The undo key is
   * `id + sorted patch keys`, so a key that alternated between {x,y} and
   * {x,y,events} mid-drag would break a single drag into several entries.
   * A patch that genuinely changes nothing is still dropped by _isNoOpPatch,
   * which deep-compares.
   *
   * Skipped outright while the preview is driving this actor: it rewrites
   * actor.x/y every tick, and following that would rewrite the authored path
   * under the running preview — the same reason routeGeometry reads the
   * authored pose rather than the live one.
   */
  function _seedFollowPatch(id, patch) {
    if (!('x' in patch) && !('y' in patch)) return patch;
    if (window.Simulate && Simulate.authoredPose && Simulate.authoredPose(id)) return patch;

    const actor = AppState.ego && AppState.ego.id === id ? AppState.ego : AppState.npcs.find((n) => n.id === id);
    if (!actor) return patch;

    const x = 'x' in patch ? patch.x : actor.x;
    const y = 'y' in patch ? patch.y : actor.y;
    const z = 'z' in patch ? patch.z : actor.z;

    let hasPath = false;
    const events = (actor.events || []).map((ev) => {
      const action = ev.action || {};
      const isRoute = action.type === 'assign_route';
      const path = isRoute ? action.waypoints : action.type === 'follow_trajectory' ? action.trajectory : null;
      if (!path || !path.length) return ev;
      hasPath = true;

      let seed;
      if (isRoute && window.ObjectsManager) {
        // Snapped like any other 'fastest' waypoint — the actor's own pose need
        // not be on a lane (hand-typed, or dragged onto the verge).
        const snap = ObjectsManager.routeWaypointAt(x, y);
        seed = { ...path[0], x: snap.x, y: snap.y, z: snap.snapped ? snap.z : (z ?? path[0].z), strategy: 'fastest' };
      } else {
        seed = { ...path[0], x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, z: z ?? path[0].z };
      }
      const next = [seed, ...path.slice(1)];
      return { ...ev, action: isRoute ? { ...action, waypoints: next } : { ...action, trajectory: next } };
    });

    return hasPath ? { ...patch, events } : patch;
  }

  function _isNoOpPatch(id, patch) {
    const actor = AppState.findById(id);
    if (!actor) return false;
    return Object.keys(patch).every((k) => {
      const a = actor[k],
        b = patch[k];
      if (a === b) return true;
      if (a && b && typeof a === 'object' && typeof b === 'object') {
        return JSON.stringify(a) === JSON.stringify(b);
      }
      return false;
    });
  }

  /**
   * Which event an `{events}` patch touches, and what to call the edit.
   *
   * **Everything in a snapshot must be recorded.** An edit that is skipped is
   * not merely un-undoable: it is *destroyed* by the next undo, because the
   * entry pushed after it describes a world where it never happened. Skipping
   * event tweaks meant "add event A, retune event B, Strg+Z" silently threw
   * away the retune. The way to keep something out of undo is to keep it out of
   * the snapshot — which is what `weather`/`time` do — not to stop recording it.
   *
   * Noise is handled by coalescing instead: the key is the id of the ONE event
   * the patch changed, so every control in a single card folds into one undo
   * step, and touching a different card starts a new one. The label is part of
   * the key so that adding, editing and deleting the same event stay distinct
   * steps rather than folding into each other.
   *
   * The changed event is found by reference identity, not by comparing
   * contents: every mutation site rebuilds the array with `.map()`, so the
   * untouched events are the very same objects. That keeps this free even on
   * the trigger-point drag, which patches once per mousemove against an actor
   * whose trajectory can hold hundreds of points. A future site that rebuilds
   * every event would fall back to the first one, which coalesces more coarsely
   * — never wrongly.
   */
  function _eventsPatchInfo(id, patch) {
    const actor = AppState.findById(id);
    const prev = (actor && actor.events) || [];
    const next = patch.events || [];

    if (next.length > prev.length) {
      const added = next.find((ev) => !prev.some((p) => p.id === ev.id));
      return { key: added ? added.id : 'neu', label: 'Event hinzugefügt' };
    }
    if (next.length < prev.length) {
      const gone = prev.find((ev) => !next.some((n) => n.id === ev.id));
      return { key: gone ? gone.id : 'weg', label: 'Event gelöscht' };
    }
    const changed = next.find((ev, i) => ev !== prev[i]);
    return { key: changed ? changed.id : 'events', label: 'Event bearbeitet' };
  }

  function _recordUpdate(id, patch) {
    // A patch that changes nothing gets no entry. Blurring a Spawnpunkt field
    // re-fires `change` with the value already in it, and _onPosChange always
    // sends all four of x/y/z/yaw — so without this, tabbing through the panel
    // fills the history with steps that undo to exactly where they started.
    if (_isNoOpPatch(id, patch)) return;

    const keys = Object.keys(patch);
    if (keys.length === 1 && keys[0] === 'events') {
      const info = _eventsPatchInfo(id, patch);
      _record(`${id}:events:${info.key}:${info.label}`, info.label);
      return;
    }
    _record(`${id}:${keys.sort().join(',')}`, _labelForPatch(patch));
  }

  function _recordRemove(id) {
    _record(`remove:${id}`, 'Löschen');
  }

  /** Restore one snapshot without recording it as an edit of its own. */
  function _apply(snap) {
    _suspend++;
    try {
      // Copy out of the snapshot: updateById mutates an actor in place with
      // Object.assign, so handing the stored object straight to AppState would
      // let the next edit rewrite an entry still sitting in the history.
      const restored = JSON.parse(
        JSON.stringify({
          ego: snap.ego,
          npcs: snap.npcs,
          staticObjects: snap.staticObjects,
          trafficSignals: snap.trafficSignals,
          generated: snap.generated ?? null,
        }),
      );
      AppState.ego = restored.ego;
      AppState.npcs = restored.npcs;
      AppState.staticObjects = restored.staticObjects;
      AppState.trafficSignals = restored.trafficSignals;
      AppState.generated = restored.generated;
      AppState.selectedId = snap.selectedId && AppState.findById(snap.selectedId) ? snap.selectedId : null;
      AppState.selectedTrafficLightId = snap.selectedTrafficLightId;
      // Waypoint indices are positions in an array the snapshot has just
      // replaced, so a mark taken before the undo can now name a different
      // point — or none at all.
      AppState.selectedWaypoint = null;

      // The empty patch redraws the scene list and the overview; the
      // selectionChanged emit is what re-renders the map and the properties
      // panel. Emitted rather than routed through select(), which would clear
      // selectedTrafficLightId and drop a signal edit out of view as it is undone.
      AppState.set({});
      AppState.emit('selectionChanged', AppState.selectedId);
    } finally {
      _suspend--;
    }
    _openKind = null;
    _settle();
  }

  window.UndoStack = {
    // AppState's mutators record through these; they are not for other callers.
    _settle,
    _isScenarioPatch,
    _recordSet,
    _seedFollowPatch,
    _recordUpdate,
    _recordRemove,

    /**
     * End the current coalescing run, so the next edit starts a fresh entry.
     * Bound below to `mousedown` and `change`, which between them precede every
     * committed edit in the app — without it two consecutive Spawnpunkt edits
     * fold into one, since _onPosChange sends the same four keys every time.
     */
    seal() {
      _openKind = null;
    },

    /**
     * Stop recording. Balanced with resume(); nests.
     *
     * Coming back out, the baseline is re-read: whatever ran under the
     * suspension changed the state without recording it, and the next edit's
     * "before" has to be where things actually stand. That is what makes the
     * drag's mouseup z-fixup (objects.js) invisible to the history rather than
     * merely unrecorded.
     */
    suspend() {
      _suspend++;
    },
    resume() {
      _suspend = Math.max(0, _suspend - 1);
      if (_suspend === 0) _settle();
    },

    /** Run fn as a single undo entry, however many mutations it makes. */
    group(label, fn) {
      _openKind = null;
      const outerLabel = _groupLabel;
      const outerTaken = _groupTaken;
      if (_groupDepth === 0) {
        _groupLabel = label || '';
        _groupTaken = false;
      }
      _groupDepth++;
      try {
        return fn();
      } finally {
        _groupDepth--;
        if (_groupDepth === 0) {
          _groupLabel = null;
          _groupTaken = false;
          _openKind = null;
        } else {
          _groupLabel = outerLabel;
          _groupTaken = outerTaken;
        }
      }
    },

    /** Record the current state as the "before" of an edit made outside AppState. */
    record(label) {
      _record(null, label || '');
    },

    /** Undo one edit. Returns { label } or null when there is nothing to undo. */
    undo() {
      if (!_undo.length) return null;
      const before = _undo.pop();
      _redo.push(_snapshot(before.label));
      if (_redo.length > MAX_HISTORY) _redo.shift();
      _apply(before);
      return { label: before.label };
    },

    /** Redo one undone edit. Returns { label } or null. */
    redo() {
      if (!_redo.length) return null;
      const after = _redo.pop();
      _undo.push(_snapshot(after.label));
      if (_undo.length > MAX_HISTORY) _undo.shift();
      _apply(after);
      return { label: after.label };
    },

    clear() {
      _undo.length = 0;
      _redo.length = 0;
      _openKind = null;
      _baseline = null;
    },

    /** Take the live scenario and its whole history out (a map switch, see
     * UIUtils.leaveMap). The live state is left as it is; the caller replaces it. */
    park() {
      const entry = { snap: _snapshot(''), undo: _undo.splice(0), redo: _redo.splice(0) };
      _openKind = null;
      return entry;
    },

    /** Put a park() result back: its scenario live, its history as the stacks. */
    unpark(entry) {
      _apply({ ...entry.snap, selectedId: null, selectedTrafficLightId: null });
      _undo.length = 0;
      _undo.push(...entry.undo);
      _redo.length = 0;
      _redo.push(...entry.redo);
      _openKind = null;
    },

    get length() {
      return _undo.length;
    },
    get redoLength() {
      return _redo.length;
    },
  };

  // Seal on the two events that precede a committed edit. Every editable field
  // in the app commits on `change` (only the map drag and the weather sliders
  // are continuous), and every click- or drag-driven edit opens with a
  // `mousedown`. Capture phase, so the seal lands before the handler that
  // performs the edit.
  //
  // Inside an event card the seal is skipped: an event card is a dozen small
  // controls describing one thing, and sealing between them would make tuning a
  // single card a dozen undo steps. The coalescing key already keys on the
  // event's own id and on what kind of change it is, so a different card — or
  // deleting the one being edited — still starts its own step.
  function _sealUnlessInEventCard(e) {
    const t = e.target;
    if (t && typeof t.closest === 'function' && t.closest('.event-card')) return;
    UndoStack.seal();
  }
  document.addEventListener('change', _sealUnlessInEventCard, true);
  document.addEventListener('mousedown', _sealUnlessInEventCard, true);

  // Opening a file replaces the scenario the history describes. Restoring a
  // pre-load state would leave the scenario objects from before the load beside
  // the map, weather and time from the file — a half-state neither the user nor
  // the export would recognise.
  AppState.on('stateLoaded', () => UndoStack.clear());
})();
