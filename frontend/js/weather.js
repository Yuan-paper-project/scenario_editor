/**
 * weather.js — Weather sliders and time-of-day dropdown.
 * Syncs with AppState.weather and AppState.time.
 */
(function () {
  'use strict';

  const timeSelect = document.getElementById('w-time');
  const WEATHER_KEYS = ['fog', 'rainy', 'cloudy', 'sunny', 'wet_road', 'snowy', 'dust_storm'];

  // ── Bind sliders ─────────────────────────────────────────────────────────────

  WEATHER_KEYS.forEach(key => {
    const slider  = document.getElementById(`w-${key}`);
    const valSpan = document.getElementById(`wv-${key}`);

    if (!slider) return;

    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      valSpan.textContent = val.toFixed(2);
      AppState.weather[key] = val;
      AppState.emit('change', { weather: AppState.weather });
    });
  });

  // ── Bind time select ──────────────────────────────────────────────────────────

  timeSelect.addEventListener('change', () => {
    AppState.set({ time: timeSelect.value });
  });

  // ── Sync panel when state is loaded ─────────────────────────────────────────

  function syncFromState() {
    WEATHER_KEYS.forEach(key => {
      const slider  = document.getElementById(`w-${key}`);
      const valSpan = document.getElementById(`wv-${key}`);
      if (!slider) return;
      const val = AppState.weather[key] || 0;
      slider.value       = val;
      valSpan.textContent = val.toFixed(2);
    });
    timeSelect.value = AppState.time || 'daytime';
  }

  AppState.on('stateLoaded', syncFromState);
})();
