/**
 * mapKeys.js — the map's keyboard shortcuts.
 *
 * Part of the map view (MapView); see mapView.js.
 */
(() => {
  'use strict';

  const { zoomToSelection, _stepHistory, _clearAllRulers } = MapCore.shared;

  const _shortcutsOverlay = document.getElementById('shortcuts-overlay');

  window.addEventListener('keydown', (e) => {
    // Not while typing in a field (except Escape).
    const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT';

    if (e.key === 'Escape') {
      if (!_shortcutsOverlay.classList.contains('hidden')) {
        _shortcutsOverlay.classList.add('hidden');
        return;
      }
      AppState.cancelPlacement();
      return;
    }

    if (inInput) return;

    // A preview is view-only: undo/redo and deletes are swallowed.
    if (window.Simulate?.running) {
      const editKey =
        e.key === 'Delete' || e.key === 'Backspace' || ((e.ctrlKey || e.metaKey) && /^[zZy]$/.test(e.key));
      if (editKey) {
        e.preventDefault();
        return;
      }
    }

    if (e.key === '?') {
      _shortcutsOverlay.classList.toggle('hidden');
      return;
    }

    if (e.key === 'r' && !e.ctrlKey && !e.metaKey) {
      const newTool = AppState.activeTool === 'ruler' ? null : 'ruler';
      AppState.cancelPlacement({ activeTool: newTool });
      return;
    }

    // F frames the selection or resets the view: the way back from a lost view.
    if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      Toast.info(zoomToSelection() ? 'Auf Auswahl gezoomt' : 'Ansicht zur\u00fcckgesetzt');
      return;
    }

    // Shift+R clears all ruler measurements.
    if (e.key === 'R' && !e.ctrlKey && !e.metaKey) {
      _clearAllRulers();
      Toast.info('Alle Messungen gel\u00f6scht');
      return;
    }

    // Ctrl+Z / Ctrl+Shift+Z; UndoStack emits the re-render signals itself.
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      _stepHistory(e.shiftKey);
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
      e.preventDefault();
      _stepHistory(true);
      return;
    }

    // Entf deletes a marked waypoint at once, ahead of the actor; deleting an object confirms
    // unless Strg/Cmd is held (the app-wide "skip the confirm").
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
        // Re-read after the dialog: the actor may be gone or the selection moved.
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
