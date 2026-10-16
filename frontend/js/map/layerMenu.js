/**
 * layerMenu.js — the Ebenen dropdown: the count pill and Alle/Keine. The checkboxes
 * are wired to their layers by mapRender.js's _setupLayerToggles, by id.
 */
(() => {
  'use strict';

  const wrap = document.getElementById('layer-toggles');
  const btn = document.getElementById('layer-menu-btn');
  const panel = document.getElementById('layer-menu-panel');
  const countEl = document.getElementById('layer-menu-count');
  if (!wrap || !btn || !panel || !countEl) return;

  const boxes = () => Array.from(panel.querySelectorAll('input[type="checkbox"]'));

  function _updateCount() {
    const all = boxes();
    countEl.textContent = `${all.filter((cb) => cb.checked).length}/${all.length}`;
  }

  Dropdown.bind({ button: btn, panel, wrap });

  // The <label> ticks the box, so mapRender.js's onchange runs for free.
  panel.addEventListener('change', _updateCount);

  panel.addEventListener('click', (e) => {
    const action = e.target.closest('[data-layer-action]');
    if (!action) return;
    const on = action.dataset.layerAction === 'all';
    for (const cb of boxes()) {
      if (cb.checked === on) continue;
      cb.checked = on;
      // Assigning .checked fires nothing; mapRender.js listens for 'change'.
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    }
    _updateCount();
  });

  _updateCount();
})();
