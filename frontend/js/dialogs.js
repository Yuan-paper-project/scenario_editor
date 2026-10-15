/**
 * dialogs.js — Toast notifications and the confirm dialog (Toast, Confirm).
 */
(() => {
  'use strict';

  // ── Toast notification system ───────────────────────────────────────────────

  const _toastContainer = document.getElementById('toast-container');
  const TOAST_ICONS = { success: '\u2713', error: '\u2717', warning: '\u26A0', info: '\u2139' };

  function showToast(message, type = 'info', duration = 4000) {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `
      <span class="toast-icon">${TOAST_ICONS[type] || ''}</span>
      <span class="toast-msg">${_escHtml(message)}</span>
      <button class="toast-close">\u00D7</button>`;
    el.querySelector('.toast-close').addEventListener('click', () => _dismissToast(el));
    _toastContainer.appendChild(el);
    if (duration > 0) setTimeout(() => _dismissToast(el), duration);
    return el;
  }

  function _dismissToast(el) {
    if (!el.parentNode) return;
    el.classList.add('toast-out');
    el.addEventListener('animationend', () => el.remove());
  }

  function _escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  window.Toast = {
    show: showToast,
    success: (m, d) => showToast(m, 'success', d),
    error: (m, d) => showToast(m, 'error', d || 6000),
    warn: (m, d) => showToast(m, 'warning', d),
    info: (m, d) => showToast(m, 'info', d),
  };

  // ── Confirm dialog ──────────────────────────────────────────────────────────

  const _confirmOverlay = document.getElementById('confirm-overlay');
  const _confirmMsg = document.getElementById('confirm-message');
  const _confirmCancel = document.getElementById('confirm-cancel');
  const _confirmOk = document.getElementById('confirm-ok');
  let _confirmResolve = null;

  function showConfirm(message, okLabel = 'L\u00f6schen') {
    return new Promise((resolve) => {
      _confirmMsg.textContent = message;
      _confirmOk.textContent = okLabel;
      _confirmOverlay.classList.remove('hidden');
      _confirmResolve = resolve;
      // Focus the confirming button, so Enter lands on it and the dialog opens
      // with the keyboard already on the action it is asking about.
      _confirmOk.focus();
    });
  }

  function _closeConfirm(result) {
    if (_confirmOverlay.classList.contains('hidden')) return;
    _confirmOverlay.classList.add('hidden');
    const resolve = _confirmResolve;
    _confirmResolve = null;
    if (resolve) resolve(result);
  }

  _confirmCancel.addEventListener('click', () => _closeConfirm(false));
  _confirmOk.addEventListener('click', () => _closeConfirm(true));

  // Enter confirms, Escape cancels — from anywhere, not only the focused
  // button. CAPTURE phase and stopPropagation: mapView's own Escape handler
  // would otherwise also cancel the tool or the path being drawn *behind* the
  // dialog, and Enter would reach the finish-path shortcut.
  window.addEventListener(
    'keydown',
    (e) => {
      if (_confirmOverlay.classList.contains('hidden')) return;
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      _closeConfirm(e.key === 'Enter');
    },
    true,
  );

  window.Confirm = {
    show: showConfirm,
    /** True while a dialog is open — key handlers use this to stand down. */
    get isOpen() {
      return !_confirmOverlay.classList.contains('hidden');
    },
  };
})();
