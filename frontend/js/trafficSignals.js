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
    if (!actionById(id)) return;
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
