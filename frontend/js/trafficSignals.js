/**
 * trafficSignals.js — Selection and event state helpers for map traffic lights.
 */
(function () {
  'use strict';

  function mapSignalById(id) {
    return (AppState.mapData?.trafficLights || [])
      .find(signal => String(signal.id) === String(id)) || null;
  }

  function actionById(id) {
    return AppState.trafficSignals
      .find(signal => String(signal.id) === String(id)) || null;
  }

  function select(id) {
    const signal = mapSignalById(id);
    if (!signal) return;

    AppState.selectedId = null;
    AppState.selectedTrafficLightId = String(id);
    if (!actionById(id)) {
      AppState.trafficSignals = [
        ...AppState.trafficSignals,
        {
          id: String(signal.id),
          x: signal.x,
          y: signal.y,
          events: [],
        },
      ];
    }

    AppState.emit('selectionChanged', null);
    AppState.emit('trafficSignalSelected', id);
    AppState.emit('trafficSignalUpdated', id);
  }

  function update(id, patch) {
    const current = actionById(id);
    if (!current) return;
    // The one scenario mutation in the app that does not go through
    // AppState.set/updateById/removeById, so it is also the one the undo
    // history cannot capture on its own — and every signal-event edit in
    // properties.js lands here, so this single call covers them all.
    //
    // Recorded unconditionally, like every other scenario edit: an edit that is
    // skipped is not merely un-undoable, it is destroyed by the next undo,
    // because the entry pushed after it describes a world where it never
    // happened. Signal events are edited from inside an `.event-card` like an
    // actor's, so app.js's seal rule already folds a card's controls into one
    // undo step.
    const next = (patch.events || []).length;
    const prev = (current.events || []).length;
    UndoStack.record(next > prev ? 'Event hinzugefügt'
                   : next < prev ? 'Event gelöscht'
                                 : 'Event bearbeitet');
    AppState.trafficSignals = AppState.trafficSignals.map(signal => (
      String(signal.id) === String(id) ? { ...signal, ...patch } : signal
    ));
    AppState.emit('trafficSignalUpdated', id);
  }

  window.TrafficSignals = {
    mapSignalById,
    actionById,
    select,
    update,
  };
})();
