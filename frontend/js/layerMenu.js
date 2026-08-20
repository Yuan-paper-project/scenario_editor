/* ══════════════════════════════════════════════════════════════════
   layerMenu.js — the header's "Ebenen" dropdown

   Owns nothing but the popup: open/close, the visible-count pill and the
   Alle/Keine shortcuts. The six checkboxes inside it are still wired by
   mapView.js's _setupLayerToggles() via their ids, so this file never
   touches an SVG layer — it only makes sure a programmatic tick fires the
   'change' event that wiring listens for.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const wrap    = document.getElementById('layer-toggles');
  const btn     = document.getElementById('layer-menu-btn');
  const panel   = document.getElementById('layer-menu-panel');
  const countEl = document.getElementById('layer-menu-count');
  if (!wrap || !btn || !panel || !countEl) return;

  const boxes = () => Array.from(panel.querySelectorAll('input[type="checkbox"]'));

  function _updateCount() {
    const all = boxes();
    countEl.textContent = `${all.filter(cb => cb.checked).length}/${all.length}`;
  }

  Dropdown.bind({ button: btn, panel, wrap });

  // A row click toggles its layer and leaves the panel open — the <label>
  // does the ticking, so mapView's onchange runs for free.
  panel.addEventListener('change', _updateCount);

  panel.addEventListener('click', e => {
    const action = e.target.closest('[data-layer-action]');
    if (!action) return;
    const on = action.dataset.layerAction === 'all';
    for (const cb of boxes()) {
      if (cb.checked === on) continue;
      cb.checked = on;
      // Assigning .checked fires nothing; mapView listens for 'change'.
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    }
    _updateCount();
  });

  _updateCount();
})();
