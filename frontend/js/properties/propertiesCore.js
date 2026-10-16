/**
 * propertiesCore.js — the panel elements every view shares, the scene-list state and the collapsible headers.
 *
 * Part of the properties panel; see properties.js.
 */
(() => {
  'use strict';

  window.PropertiesCore = UIUtils.sharedScope('PropertiesCore');

  const propsOverview = document.getElementById('props-overview');
  const propsContent = document.getElementById('props-content');
  const propsTitle = document.getElementById('props-title');
  const propsDelete = document.getElementById('props-delete');
  const trafficSignalPanel = document.getElementById('traffic-signal-panel');
  const npcSection = document.getElementById('props-npc-section');

  // Scene-list state lives here, not in the DOM: the overview rebuilds its innerHTML on every change.
  const _sceneCollapsed = { npcs: false, props: false };
  const scene = { locatedId: null };
  // Set by properties.js, which loads last, so the scene list's deletes can re-render the panel.
  const panel = { render: null };
  // Each prop type's stepper position, by blueprint; clamped at render time.
  const _propCursor = {};

  function _bindCollapsibleHeaders(root) {
    root.querySelectorAll('.collapsible-header[data-collapse-target]').forEach((header) => {
      if (header.dataset.collapseBound === 'true') return;
      header.dataset.collapseBound = 'true';
      header.addEventListener('click', (e) => {
        if (e.target.closest('input, select, button:not(.collapsible-header)')) return;
        const targetId = header.dataset.collapseTarget;
        const target = targetId ? document.getElementById(targetId) : null;
        const section = target ? target.closest('.collapsible-section') : null;
        if (!section) return;
        section.classList.toggle('collapsed');
        const collapsed = section.classList.contains('collapsed');
        const indicator = header.querySelector('.collapse-indicator');
        if (indicator) indicator.textContent = collapsed ? '+' : '-';
        header.setAttribute('aria-expanded', String(!collapsed));
      });
    });
  }

  PropertiesCore.define({
    propsOverview,
    propsContent,
    propsTitle,
    propsDelete,
    trafficSignalPanel,
    npcSection,
    _sceneCollapsed,
    scene,
    panel,
    _propCursor,
    _bindCollapsibleHeaders,
  });
})();
