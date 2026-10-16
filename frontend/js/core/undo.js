/**
 * undo.js — Snapshot-based undo/redo of the scenario (UndoStack).
 */
(() => {
  'use strict';

  // ── Undo / redo history ──────────────────────────────────────────────────────

  /**
   * Snapshot undo, captured automatically in AppState.set / updateById / removeById,
   * so every edit is covered without instrumenting call sites. TrafficSignals.update()
   * bypasses them and calls record() itself. Scope: scenario objects only — not
   * map/mapData (would need an async re-fetch) and not weather/time (a setting).
   */

  // A long path is one entry per waypoint; a short stack would evict every placement behind it.
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

  /** Deep copy of the scenario state. Not AppState.toJSON(), which shares path arrays with live state. */
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
   * Push the "before" of an edit about to happen. It is `_baseline`, not a fresh
   * snapshot: placements mutate the array before announcing it, so at set() time
   * the "before" is gone. `kind` coalesces consecutive edits (a drag is one entry);
   * null always starts a new one.
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
    // An empty patch announces an array mutated in place (placements, bulk deletes).
    if (keys.length === 0) return true;
    return keys.some((k) => SCENARIO_KEYS.includes(k));
  }

  // Patch shapes named in the toast; anything else undoes as plain "Rückgängig".
  const PATCH_LABELS = [
    [['x', 'y', 'z'], 'Verschieben'],
    [['yaw'], 'Drehen'],
    [['type'], 'Typwechsel'],
    [['prop'], 'Typwechsel'],
    [['initial_speed'], 'Startgeschwindigkeit'],
    [['max_acceleration'], 'Max. Beschleunigung'],
    [['max_deceleration'], 'Max. Verzögerung'],
    // Last, so a bare {yaw} reads 'Drehen'; the Spawnpunkt fields commit all four keys.
    [['x', 'y', 'z', 'yaw'], 'Spawnpunkt'],
  ];

  function _labelForPatch(patch) {
    const keys = Object.keys(patch);
    if (!keys.length) return '';
    const hit = PATCH_LABELS.find(([fields]) => keys.every((k) => fields.includes(k)));
    return hit ? hit[1] : '';
  }

  function _recordSet() {
    // null kind: a placement or bulk delete never folds into the previous entry.
    _record(null, '');
  }

  /**
   * Fold waypoint 1 (the seed, on the actor's pose) into the move's own patch, so
   * move and seed are one undo entry. `events` rides along whenever the actor has a
   * path, even unchanged, so the coalescing key stays stable through a drag. Off
   * while the preview drives the actor.
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
        // Snapped like any 'fastest' waypoint: the actor's pose need not be on a lane.
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

  /** True when every field in the patch already holds that value. */
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
   * Which event an `{events}` patch touches (by reference identity — sites rebuild
   * with .map()), and the label. Keying on that event coalesces one card's edits
   * into one step. Everything in a snapshot must be recorded: a skipped edit is
   * destroyed by the next undo.
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
    // A no-op patch (e.g. blurring a Spawnpunkt field) records nothing.
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
      // Copy: updateById mutates actors in place and would rewrite the stored entry.
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
      // Indices may name a different point after the restore.
      AppState.selectedWaypoint = null;

      // Emitted rather than via select(), which would clear selectedTrafficLightId.
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

    /** End the coalescing run; bound to mousedown and change, which precede every committed edit. */
    seal() {
      _openKind = null;
    },

    /** Stop recording (nests, balanced with resume()); resume re-reads the baseline, hiding what ran under it. */
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

    /** Take the live scenario and its history out (a map switch); the caller replaces the live state. */
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

  // Seal on mousedown and change (capture, before the editing handler) — except inside an
  // event card, whose controls coalesce into one step per event.
  function _sealUnlessInEventCard(e) {
    const t = e.target;
    if (t && typeof t.closest === 'function' && t.closest('.event-card')) return;
    UndoStack.seal();
  }
  document.addEventListener('change', _sealUnlessInEventCard, true);
  document.addEventListener('mousedown', _sealUnlessInEventCard, true);

  // A loaded file replaces the scenario the history describes.
  AppState.on('stateLoaded', () => UndoStack.clear());
})();
