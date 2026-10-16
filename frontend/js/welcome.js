/**
 * welcome.js — the Schnellstart modal (first load and Hilfe → Schnellstart) and Hilfe → Tastenkürzel.
 */
(() => {
  'use strict';

  const overlay = document.getElementById('welcome-overlay');
  const closeBtn = document.getElementById('welcome-close');
  const dontShow = document.getElementById('welcome-dont-show');
  const helpBtn = document.getElementById('btn-help');

  const STORAGE_KEY = 'openscenario_hide_welcome';

  function open() {
    overlay.classList.remove('hidden');
  }

  function close() {
    overlay.classList.add('hidden');
    if (dontShow.checked) {
      localStorage.setItem(STORAGE_KEY, '1');
    }
  }

  closeBtn.addEventListener('click', close);

  // Close on a click outside the card.
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  helpBtn.addEventListener('click', () => {
    dontShow.checked = false;
    open();
  });

  // Hilfe → Tastenkürzel: the same overlay as the „?" key.
  document.getElementById('btn-shortcuts')?.addEventListener('click', () => {
    document.getElementById('shortcuts-overlay')?.classList.remove('hidden');
  });

  // Shown once per viewer.
  if (!localStorage.getItem(STORAGE_KEY)) {
    open();
  }
})();
