/**
 * weather.js — the header's "Umgebung" menu: time of day, weather presets and
 * the raw sliders. Syncs with AppState.weather and AppState.time.
 *
 * The controls used to be a full-width bar under the map. The ids (w-time,
 * w-<key>, wv-<key>) are unchanged; dropdown.js does the open/close.
 */
(function () {
  'use strict';

  const timeSelect = document.getElementById('w-time');
  const summary    = document.getElementById('env-summary');
  const presetsBox = document.getElementById('env-presets');
  const WEATHER_KEYS = ['fog', 'rainy', 'cloudy', 'sunny', 'wet_road', 'snowy', 'dust_storm'];

  // The same six the generator's batch varies over (scenarioGenerator.js
  // WEATHER_PRESETS) — rain without a wet road is not a condition anyone drives
  // in. A preset sets ALL keys, the rest to 0, so "matches a preset" is exact.
  const PRESETS = [
    { id: 'klar',       label: 'Klar',       w: {} },
    { id: 'bewoelkt',   label: 'Bewölkt',    w: { cloudy: 0.8 } },
    { id: 'regen',      label: 'Regen',      w: { cloudy: 0.8, rainy: 0.6, wet_road: 0.8 } },
    { id: 'starkregen', label: 'Starkregen', w: { cloudy: 1.0, rainy: 1.0, wet_road: 1.0, fog: 0.2 } },
    { id: 'nebel',      label: 'Nebel',      w: { cloudy: 0.5, fog: 0.7 } },
    { id: 'nass',       label: 'Nass',       w: { cloudy: 0.3, wet_road: 0.7 } },
  ];

  const _full = w => Object.fromEntries(WEATHER_KEYS.map(k => [k, w[k] || 0]));

  function _matchingPreset() {
    const cur = _full(AppState.weather || {});
    return PRESETS.find(p => {
      const want = _full(p.w);
      return WEATHER_KEYS.every(k => Math.abs(want[k] - cur[k]) < 1e-6);
    }) || null;
  }

  /** "Regen · Nacht" on the menu button, so the setting is readable shut. */
  function renderSummary() {
    const p = _matchingPreset();
    const wx = p ? p.label : 'Eigenes Wetter';
    if (summary) summary.textContent = `${wx} · ${AppState.timeLabel(AppState.time || 'daytime')}`;
    presetsBox?.querySelectorAll('.env-preset').forEach(btn => {
      btn.classList.toggle('active', !!p && btn.dataset.preset === p.id);
    });
  }

  // ── Presets ─────────────────────────────────────────────────────────────────

  PRESETS.forEach(p => {
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
    renderSummary();
  }

  AppState.on('stateLoaded', syncFromState);
  AppState.on('change', patch => {
    if ('weather' in patch || 'time' in patch) renderSummary();
  });
  // Once at load too, so the readouts use the same 2-decimal format before the
  // first drag as after it (the markup's "0.0" became "0.05" mid-drag).
  syncFromState();
})();
