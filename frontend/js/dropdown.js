/* ══════════════════════════════════════════════════════════════════
   dropdown.js — the header's popup-menu mechanics, shared

   One behaviour, used by every header dropdown: toggle on the button,
   close on outside click, close on Esc. Owning it here keeps the menus
   from drifting apart and means a new one is three lines.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /**
   * Wire a button to its panel.
   * @param {Object} o
   * @param {HTMLElement} o.button   the trigger; gets .open + aria-expanded
   * @param {HTMLElement} o.panel    the popup; toggled via the .hidden class
   * @param {HTMLElement} [o.wrap]   outside-click boundary (default: panel.parentElement)
   * @param {Function}   [o.onOpen]  called with true/false on every state change
   * @returns {{open:Function, close:Function, isOpen:Function}}
   */
  function bind(o) {
    const { button, panel, onOpen } = o;
    const wrap = o.wrap || panel.parentElement;

    const isOpen = () => !panel.classList.contains('hidden');

    function set(on) {
      panel.classList.toggle('hidden', !on);
      button.classList.toggle('open', on);
      button.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (onOpen) onOpen(on);
    }

    button.addEventListener('click', e => {
      e.stopPropagation();          // don't trip the outside-click close below
      set(!isOpen());
    });

    document.addEventListener('click', e => {
      if (isOpen() && !wrap.contains(e.target)) set(false);
    });

    // Capture phase + stopPropagation: Esc closes the topmost thing, so it must
    // not also cancel a path being drawn (mapView's own document keydown).
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !isOpen()) return;
      e.stopPropagation();
      set(false);
      button.focus();
    }, true);

    // A menu row runs its own action and then closes; a control row (a
    // checkbox in the layer menu) is marked with neither and leaves it open.
    panel.addEventListener('click', e => {
      if (e.target.closest('[data-menu-item]')) set(false);
    });

    return { open: () => set(true), close: () => set(false), isOpen };
  }

  // Declarative menus: markup-only, no module of their own. A menu that needs
  // extra behaviour (the layer count pill) calls bind() itself instead.
  for (const wrap of document.querySelectorAll('[data-dropdown]')) {
    const button = wrap.querySelector('[data-dropdown-button]');
    const panel  = wrap.querySelector('[data-dropdown-panel]');
    if (button && panel) bind({ button, panel, wrap });
  }

  window.Dropdown = { bind };
})();
