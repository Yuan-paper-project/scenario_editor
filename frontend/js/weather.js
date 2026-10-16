/**
 * weather.js — the Umgebung menu: time of day, weather presets and the sliders, synced with
 * AppState.weather / AppState.time. dropdown.js opens and closes it.
 */
(() => {
  'use strict';

  const timeSelect = document.getElementById('w-time');
  const summary = document.getElementById('env-summary');
  const presetsBox = document.getElementById('env-presets');
  const WEATHER_KEYS = ['fog', 'rainy', 'cloudy', 'sunny', 'wet_road', 'snowy', 'dust_storm'];

  // Shared with the generator's batch; a preset sets every key, so matching one is exact.
  const PRESETS = AppState.WEATHER_PRESETS;

  const _full = (w) => Object.fromEntries(WEATHER_KEYS.map((k) => [k, w[k] || 0]));

  function _matchingPreset() {
    const cur = _full(AppState.weather || {});
    return (
      PRESETS.find((p) => {
        const want = _full(p.w);
        return WEATHER_KEYS.every((k) => Math.abs(want[k] - cur[k]) < 1e-6);
      }) || null
    );
  }

  /** „Regen · Nacht" on the menu button, readable while it is shut. */
  function renderSummary() {
    const p = _matchingPreset();
    const wx = p ? p.label : 'Eigenes Wetter';
    if (summary) summary.textContent = `${wx} · ${AppState.timeLabel(AppState.time || 'daytime')}`;
    presetsBox?.querySelectorAll('.env-preset').forEach((btn) => {
      btn.classList.toggle('active', !!p && btn.dataset.preset === p.id);
    });
  }

  // ── Presets ─────────────────────────────────────────────────────────────────

  PRESETS.forEach((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'env-preset';
    b.dataset.preset = p.id;
    b.textContent = p.label;
    b.addEventListener('click', () => {
      AppState.weather = _full(p.w);
      syncFromState();
      AppState.emit('change', { weather: AppState.weather });
    });
    presetsBox?.appendChild(b);
  });

  // ── Bind sliders ─────────────────────────────────────────────────────────────

  WEATHER_KEYS.forEach((key) => {
    const slider = document.getElementById(`w-${key}`);
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
    WEATHER_KEYS.forEach((key) => {
      const slider = document.getElementById(`w-${key}`);
      const valSpan = document.getElementById(`wv-${key}`);
      if (!slider) return;
      const val = AppState.weather[key] || 0;
      slider.value = val;
      valSpan.textContent = val.toFixed(2);
    });
    timeSelect.value = AppState.time || 'daytime';
    renderSummary();
  }

  AppState.on('stateLoaded', syncFromState);
  AppState.on('change', (patch) => {
    if ('weather' in patch || 'time' in patch) renderSummary();
  });
  // At load too, so the readouts have their 2-decimal format before the first drag.
  syncFromState();
})();
