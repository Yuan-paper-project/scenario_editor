/**
 * aerialMap.js — the CARLA aerial image under the map, and the base-map switch.
 *
 * Tiles (tools/probes/capture_carla_aerial.py) are already in CARLA coordinates, so
 * they go into #world untransformed. A coarse backdrop is always loaded, plus the
 * zoom-matched level for tiles in view. The modes are a class on #map-svg, never
 * style.display, which the Ebenen checkboxes own.
 */
(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MODES = ['vector', 'aerial', 'both'];
  const STORAGE_KEY = 'scenarioEditor.baseMap';
  // Backdrop: the finest level of at most this many tiles (~2 px/m on Town06, ~1 MB).
  const BACKDROP_MAX_TILES = 16;

  const svg = document.getElementById('map-svg');
  const worldGroup = document.getElementById('world');
  const toggleEl = document.getElementById('map-base-toggle');

  let _layer = null; // <g id="layer-aerial">, first child of #world
  let _backdrop = null; // <g> holding the backdrop level
  let _detail = null; // <g> holding the zoom-matched level
  let _meta = null; // meta.json of the loaded town, or null
  let _town = null;
  let _loadSeq = 0; // drops a stale fetch when the town changes mid-request
  let _detailTiles = new Map(); // key "L/c/r" → <image>
  let _rafPending = false;

  let _preferred = 'vector';
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (MODES.includes(saved)) _preferred = saved;
  } catch (_) {
    /* storage blocked — fall back to vector */
  }

  // ── Mode ───────────────────────────────────────────────────────────────

  /** The mode actually shown: the preference, unless this town has no image. */
  function mode() {
    return _meta ? _preferred : 'vector';
  }

  function setMode(m) {
    if (!MODES.includes(m)) return;
    _preferred = m;
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch (_) {
      /* per-viewer nicety only */
    }
    _apply();
  }

  function _apply() {
    const m = mode();
    svg.classList.toggle('base-aerial', m === 'aerial');
    svg.classList.toggle('base-both', m === 'both');
    if (_layer) _layer.style.display = m === 'vector' ? 'none' : '';
    if (toggleEl) {
      toggleEl.classList.toggle('hidden', !_town);
      for (const btn of toggleEl.querySelectorAll('[data-base-mode]')) {
        const bm = btn.dataset.baseMode;
        const on = bm === m;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
        // Disabled with a reason rather than hidden, so the switch keeps its shape.
        btn.disabled = bm !== 'vector' && !_meta;
        btn.title = btn.disabled
          ? 'Für diese Karte gibt es kein Luftbild (nur CARLA-Städte, nicht Town10 oder importierte Karten)'
          : btn.dataset.title;
      }
    }
    if (m !== 'vector') update();
  }

  // ── Loading ────────────────────────────────────────────────────────────

  /** Called by renderMap; resolves once meta is known or absent. */
  async function load(town) {
    const seq = ++_loadSeq;
    _town = town || null;
    _meta = null;
    _detailTiles = new Map();
    if (_layer) _layer.remove();
    _layer = _el('g', { id: 'layer-aerial' });
    _backdrop = _el('g', { class: 'aerial-backdrop' });
    _detail = _el('g', { class: 'aerial-detail' });
    _layer.append(_backdrop, _detail);
    // Under everything, including the drawn roads.
    worldGroup.insertBefore(_layer, worldGroup.firstChild);
    _apply();
    if (!town) return;

    let meta = null;
    try {
      meta = await Api.getAerialMeta(town);
    } catch (e) {
      console.warn('[AerialMap]', e);
    }
    if (seq !== _loadSeq) return; // the user switched towns while we waited
    _meta = meta;
    if (_meta) _renderBackdrop();
    _apply();
  }

  function _tileUrl(level, c, r) {
    // ?v= busts the 1 h browser cache after a re-capture.
    return `/api/maps/${encodeURIComponent(_town)}/aerial/${level}/${c}_${r}.jpg?v=${_meta.version || 0}`;
  }

  /** Grid geometry of one pyramid level. */
  function _level(level) {
    const f = 2 ** level;
    const ts = _meta.tileSize;
    const wPx = Math.max(1, Math.floor(_meta.width / f));
    const hPx = Math.max(1, Math.floor(_meta.height / f));
    const ppm = _meta.ppm / f;
    return { level, ppm, wPx, hPx, ts, cols: Math.ceil(wPx / ts), rows: Math.ceil(hPx / ts) };
  }

  function _tileImage(L, c, r) {
    const x = _meta.x0 + (c * L.ts) / L.ppm;
    const y = _meta.y0 + (r * L.ts) / L.ppm;
    const wPx = Math.min(L.ts, L.wPx - c * L.ts);
    const hPx = Math.min(L.ts, L.hPx - r * L.ts);
    // One source pixel of overlap: abutting tiles leave hairlines.
    const over = 1 / L.ppm;
    const img = _el('image', {
      x,
      y,
      width: wPx / L.ppm + (c < L.cols - 1 ? over : 0),
      height: hPx / L.ppm + (r < L.rows - 1 ? over : 0),
      preserveAspectRatio: 'none',
    });
    img.setAttribute('href', _tileUrl(L.level, c, r));
    return img;
  }

  function _renderBackdrop() {
    let lvl = _meta.levels - 1;
    while (lvl > 0) {
      const L = _level(lvl - 1);
      if (L.cols * L.rows > BACKDROP_MAX_TILES) break;
      lvl--;
    }
    const L = _level(lvl);
    for (let r = 0; r < L.rows; r++) for (let c = 0; c < L.cols; c++) _backdrop.appendChild(_tileImage(L, c, r));
    _backdrop.dataset.level = String(lvl);
  }

  // ── Zoom-matched detail ────────────────────────────────────────────────

  /** Called on every pan/zoom; batched to one pass per frame. */
  function update() {
    if (!_meta || mode() === 'vector' || _rafPending) return;
    _rafPending = true;
    requestAnimationFrame(() => {
      _rafPending = false;
      _updateDetail();
    });
  }

  function _updateDetail() {
    if (!_meta || !_detail) return;
    const ctm = worldGroup.getScreenCTM();
    if (!ctm) return;
    const screenPpm = Math.abs(ctm.a) * (window.devicePixelRatio || 1);
    // Finest level not sharper than the screen needs.
    let lvl = Math.floor(Math.log2(_meta.ppm / screenPpm));
    lvl = Math.max(0, Math.min(_meta.levels - 1, lvl));
    const backdropLvl = Number(_backdrop.dataset.level);

    const wanted = new Set();
    if (lvl < backdropLvl) {
      const L = _level(lvl);
      const box = svg.getBoundingClientRect();
      const inv = ctm.inverse();
      const pt = svg.createSVGPoint();
      const corners = [
        [box.left, box.top],
        [box.right, box.bottom],
      ].map(([sx, sy]) => {
        pt.x = sx;
        pt.y = sy;
        return pt.matrixTransform(inv);
      });
      const tileM = L.ts / L.ppm;
      const c0 = Math.max(0, Math.floor((Math.min(corners[0].x, corners[1].x) - _meta.x0) / tileM));
      const c1 = Math.min(L.cols - 1, Math.floor((Math.max(corners[0].x, corners[1].x) - _meta.x0) / tileM));
      const r0 = Math.max(0, Math.floor((Math.min(corners[0].y, corners[1].y) - _meta.y0) / tileM));
      const r1 = Math.min(L.rows - 1, Math.floor((Math.max(corners[0].y, corners[1].y) - _meta.y0) / tileM));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const key = `${lvl}/${c}/${r}`;
          wanted.add(key);
          if (!_detailTiles.has(key)) {
            const img = _tileImage(L, c, r);
            _detailTiles.set(key, img);
            _detail.appendChild(img);
          }
        }
      }
    }
    for (const [key, img] of _detailTiles) {
      if (!wanted.has(key)) {
        img.remove();
        _detailTiles.delete(key);
      }
    }
  }

  function _el(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  // ── Wiring ─────────────────────────────────────────────────────────────

  if (toggleEl) {
    for (const btn of toggleEl.querySelectorAll('[data-base-mode]')) {
      btn.dataset.title = btn.title;
      btn.addEventListener('click', () => setMode(btn.dataset.baseMode));
    }
  }
  window.addEventListener('resize', update);

  window.AerialMap = { load, update, mode, setMode };
})();
