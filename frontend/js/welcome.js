/**
 * welcome.js — Willkommens-Modal und Hilfe-Schaltfläche.
 * Zeigt das Einführungs-Modal beim ersten Laden und auf Anfrage.
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

  // Schließen durch Klick außerhalb der Karte
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  // Hilfe-Schaltfläche öffnet das Modal erneut
  helpBtn.addEventListener('click', () => {
    dontShow.checked = false;
    open();
  });

  // Hilfe → Tastenkürzel: dieselbe Übersicht wie die Taste „?".
  document.getElementById('btn-shortcuts')?.addEventListener('click', () => {
    document.getElementById('shortcuts-overlay')?.classList.remove('hidden');
  });

  // Beim Laden prüfen, ob Modal angezeigt werden soll
  if (!localStorage.getItem(STORAGE_KEY)) {
    open();
  }
})();
