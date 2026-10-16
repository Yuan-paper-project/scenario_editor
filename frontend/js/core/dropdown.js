/**
 * dropdown.js — the header dropdowns' shared mechanics: toggle, outside click, Esc.
 */
(() => {
  'use strict';

  /** Wire `o.button` to `o.panel` (toggled via .hidden); `o.wrap` bounds outside clicks, `o.onOpen(bool)` hears changes. */
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

    button.addEventListener('click', (e) => {
      e.stopPropagation(); // don't trip the outside-click close below
      set(!isOpen());
    });

    document.addEventListener('click', (e) => {
      if (isOpen() && !wrap.contains(e.target)) set(false);
    });

    // Capture + stopPropagation: closing a menu must not also cancel a path being drawn.
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || !isOpen()) return;
        e.stopPropagation();
        set(false);
        button.focus();
      },
      true,
    );

    // A [data-menu-item] row closes the menu after its action; other rows leave it open.
    panel.addEventListener('click', (e) => {
      if (e.target.closest('[data-menu-item]')) set(false);
    });

    return { open: () => set(true), close: () => set(false), isOpen };
  }

  // Markup-only menus; one with extra behaviour calls bind() itself instead.
  for (const wrap of document.querySelectorAll('[data-dropdown]')) {
    const button = wrap.querySelector('[data-dropdown-button]');
    const panel = wrap.querySelector('[data-dropdown-panel]');
    if (button && panel) bind({ button, panel, wrap });
  }

  window.Dropdown = { bind };
})();
