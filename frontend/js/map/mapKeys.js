/**
 * mapKeys.js — the map's keyboard shortcuts.
 *
 * Part of the map view (MapView); see mapView.js.
 */
(() => {
  'use strict';

  const { zoomToSelection, _stepHistory, _clearAllRulers } = MapCore.shared;

  // Keyboard shortcuts
  const _shortcutsOverlay = document.getElementById('shortcuts-overlay');

  window.addEventListener('keydown', (e) => {
    // Don't intercept when typing in inputs (except Escape)
    const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT';

    // Escape — cancel active tool / trajectory mode / close overlays
    if (e.key === 'Escape') {
      if (!_shortcutsOverlay.classList.contains('hidden')) {
        _shortcutsOverlay.classList.add('hidden');
        return;
      }
      AppState.cancelPlacement();
      return;
    }

    if (inInput) return;

    // A preview is view-only: no undo/redo (it would restore poses under the
    // running preview) and no deletes. Ctrl+Z is still swallowed, so the
    // browser does not act on it either.
    if (window.Simulate?.running) {
      const editKey =
        e.key === 'Delete' || e.key === 'Backspace' || ((e.ctrlKey || e.metaKey) && /^[zZy]$/.test(e.key));
      if (editKey) {
        e.preventDefault();
        return;
      }
    }

    // ? — show keyboard shortcuts
    if (e.key === '?') {
      _shortcutsOverlay.classList.toggle('hidden');
      return;
    }

    // R — toggle ruler tool
    if (e.key === 'r' && !e.ctrlKey && !e.metaKey) {
      const newTool = AppState.activeTool === 'ruler' ? null : 'ruler';
      AppState.cancelPlacement({ activeTool: newTool });
      return;
    }

    // F — frame the selection, or reset the view when nothing is selected.
    // Together with the zoom clamp this is the way back from a view that no
    // longer contains the map.
    if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      Toast.info(zoomToSelection() ? 'Auf Auswahl gezoomt' : 'Ansicht zur\u00fcckgesetzt');
      return;
    }

    // Shift+R — clear all ruler measurements
    if (e.key === 'R' && !e.ctrlKey && !e.metaKey) {
      _clearAllRulers();
      Toast.info('Alle Messungen gel\u00f6scht');
      return;
    }

    // Ctrl+Z / Ctrl+Shift+Z — undo and redo any scenario edit.
    //
    // UndoStack.undo() restores its snapshot and emits the re-render signals
    // itself, so there is nothing to reconstruct here. This handler used to
    // rebuild the deleted actor by hand, because the stack held one deleted
    // actor per entry and understood no other kind of edit.
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      _stepHistory(e.shiftKey);
      return;
    }

    // Ctrl+Y — redo, for the keyboards that expect it there.
    if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
      e.preventDefault();
      _stepHistory(true);
      return;
    }

    // Delete / Backspace — remove the selected object (with undo).
    //
    // Strg (Cmd on a Mac) is the app-wide "skip the confirm" modifier, honoured
    // identically by the properties trash and every scene-list trash: plain Entf
    // asks first, Strg+Entf does not. This key path used to delete outright,
    // which was the one place in the app where a delete was unguarded.
    // A marked waypoint takes Entf/Backspace ahead of the actor, and takes it
    // WITHOUT the confirm every other delete in the app asks for. The two are
    // not comparable acts: deleting an actor throws away its pose, its whole
    // event chain and anything chained onto those, while a waypoint is one
    // click of a path and comes back with one more — and the mark then moves
    // to the point that took its place, so holding the key walks the path.
    if ((e.key === 'Delete' || e.key === 'Backspace') && AppState.selectedWaypoint) {
      e.preventDefault();
      const sel = AppState.selectedWaypoint;
      ObjectsManager.deletePathPoint(sel.actorId, sel.pathType, sel.index, sel.eventId);
      const left = (AppState.waypointPathOf(sel) || []).length;
      AppState.selectWaypoint(left ? { ...sel, index: Math.min(sel.index, left - 1) } : null);
      return;
    }

    if ((e.key === 'Delete' || e.key === 'Backspace') && AppState.selectedId) {
      const id = AppState.selectedId;
      const actor = AppState.findById(id);
      if (!actor) return;
      const label = AppState.actorLabel(actor);

      const commit = () => {
        // The dialog is awaited, so re-read instead of trusting the captured
        // actor: it can be deleted, or the selection moved, while it was open.
        const still = AppState.findById(id);
        if (!still) return;
        AppState.removeById(id);
        MapView.renderAllActors();
        Toast.info(`${label} gelöscht — Strg+Z zum Rückgängigmachen`);
      };

      if (e.ctrlKey || e.metaKey) commit();
      else
        Confirm.show(`${label} löschen?`, 'Löschen').then((ok) => {
          if (ok) commit();
        });
    }
  });
})();
