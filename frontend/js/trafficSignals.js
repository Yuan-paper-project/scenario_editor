/**
 * trafficSignals.js — selection and Schaltung state for map traffic lights (TrafficSignals).
 */
(() => {
  'use strict';

  function mapSignalById(id) {
    return (AppState.mapData?.trafficLights || []).find((signal) => String(signal.id) === String(id)) || null;
  }

  function actionById(id) {
    return AppState.trafficSignals.find((signal) => String(signal.id) === String(id)) || null;
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
          z: signal.z ?? 0,
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
    // The one scenario mutation outside AppState's mutators, so it records undo itself — always,
    // since a skipped edit would be destroyed by the next undo.
    const next = (patch.events || []).length;
    const prev = (current.events || []).length;
    UndoStack.record(next > prev ? 'Event hinzugefügt' : next < prev ? 'Event gelöscht' : 'Event bearbeitet');
    AppState.trafficSignals = AppState.trafficSignals.map((signal) =>
      String(signal.id) === String(id) ? { ...signal, ...patch } : signal,
    );
    AppState.emit('trafficSignalUpdated', id);
  }

  window.TrafficSignals = {
    mapSignalById,
    actionById,
    select,
    update,
  };
})();
