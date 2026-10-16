/**
 * propertiesCore.js — the panel elements every view shares, the scene-list state and the collapsible headers.
 *
 * Part of the properties panel; see properties.js.
 */
(() => {
  'use strict';

  window.PropertiesCore = UIUtils.sharedScope('PropertiesCore');

  // Elements
  const propsOverview = document.getElementById('props-overview');
  const propsContent = document.getElementById('props-content');
  const propsTitle = document.getElementById('props-title');
  const propsDelete = document.getElementById('props-delete');
  const trafficSignalPanel = document.getElementById('traffic-signal-panel');
  const npcSection = document.getElementById('props-npc-section');

  // Scene-list state. Both live here rather than in the DOM because
  // _renderOverviewPanel rebuilds its innerHTML wholesale on every change — a
  // collapsed section would spring back open the moment a prop was placed.
  // `locatedId` is on an object rather than a reassigned let because the
  // state subscriptions clear it too.
  const _sceneCollapsed = { npcs: false, props: false };
  const scene = { locatedId: null };
  // The scene list's deletes re-render the whole panel, and render() is
  // defined in properties.js, which loads last and sets this beside the event
  // panel's refresh handler.
  const panel = { render: null };
  // Which instance each prop type's stepper is pointing at, keyed by blueprint
  // id. Clamped at render time rather than on delete: props are also added and
  // removed from the map and the toolbar, which never touch this.
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
