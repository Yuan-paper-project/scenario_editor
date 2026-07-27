/**
 * app.js — Global state store and simple event bus.
 * All modules read from and write to AppState.
 * Changes emit a 'change' event so dependent modules can re-render.
 */
(function () {
  'use strict';

  let _nextId = 1;

  const AppState = {
    // ── Map ──────────────────────────────────────────────────
    map:      null,       // selected town name string
    mapData:  null,       // road render JSON from /api/maps/{town}/render

    // ── Scenario ─────────────────────────────────────────────
    ego: null,            // {id, type:'ego', x, y, z, yaw, trajectory} or null
    npcs: [],             // [{id, type, x, y, z, yaw, events}]
    staticObjects: [],    // [{id, type:'tree'|'building', x, y}]
    trafficSignals: [],   // configured traffic-light events from the map

    // ── Weather / time ────────────────────────────────────────
    weather: {
      fog: 0, rainy: 0, cloudy: 0, sunny: 0,
      wet_road: 0, snowy: 0, dust_storm: 0,
    },
    time: 'daytime',

    // ── Editor interaction ─────────────────────────────────────
    selectedId:          null,   // id of selected actor/object
    selectedTrafficLightId: null, // id of selected map traffic light
    activeTool:          null,   // selected toolbar tool, or null
    trajectoryMode:      false,  // true while drawing a path
    activeTrajectoryId:  null,   // actor id whose trajectory we're drawing
    routeMode:           false,  // true while drawing a route
    activeRouteId:       null,   // actor id whose route we're drawing
    activePathEventId:    null,   // event id whose action path/route we're drawing
    triggerPointMode:    null,   // { actorId, eventId } while picking a distance trigger point
    pendingTemplate:     null,   // scenario template to apply to the next placed actor

    // ── Listeners ─────────────────────────────────────────────
    _listeners: {},

    // ── Helpers ───────────────────────────────────────────────
    nextId() { return `obj-${_nextId++}`; },

    on(event, fn) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(fn);
    },

    off(event, fn) {
      if (!this._listeners[event]) return;
      this._listeners[event] = this._listeners[event].filter(f => f !== fn);
    },

    emit(event, data) {
      (this._listeners[event] || []).forEach(fn => fn(data));
    },

    /** Patch state and emit 'change'. */
    set(patch) {
      Object.assign(this, patch);
      this.emit('change', patch);
    },

    /** Find any object by id (ego, npc, or static). */
    findById(id) {
      if (this.ego && this.ego.id === id) return this.ego;
      const npc = this.npcs.find(n => n.id === id);
      if (npc) return npc;
      return this.staticObjects.find(o => o.id === id) || null;
    },

    /** Update an existing object's fields. */
    updateById(id, patch) {
      if (this.ego && this.ego.id === id) {
        Object.assign(this.ego, patch);
      } else {
        const npc = this.npcs.find(n => n.id === id);
        if (npc) Object.assign(npc, patch);
        else {
          const obj = this.staticObjects.find(o => o.id === id);
          if (obj) Object.assign(obj, patch);
        }
      }
      this.emit('actorUpdated', id);
    },

    /** Remove an object. */
    removeById(id) {
      if (this.ego && this.ego.id === id) {
        this.ego = null;
      } else {
        this.npcs          = this.npcs.filter(n => n.id !== id);
        this.staticObjects = this.staticObjects.filter(o => o.id !== id);
      }
      if (this.selectedId === id) this.selectedId = null;
      this.emit('actorRemoved', id);
    },

    /** Select an actor. Pass null to deselect. */
    select(id) {
      this.selectedId = id;
      this.selectedTrafficLightId = null;
      this.emit('selectionChanged', id);
    },

    /** Find nearest spawn point within maxDist metres. Returns null if none. */
    nearestSpawn(wx, wy, maxDist = 10) {
      if (!this.mapData) return null;
      let best = null, bestDist = maxDist;
      for (const sp of this.mapData.spawnPoints) {
        const d = Math.hypot(sp.x - wx, sp.y - wy);
        if (d < bestDist) { bestDist = d; best = sp; }
      }
      return best;
    },

    /** Human-readable actor label, indexed per actor type for NPCs. */
    actorLabel(actorOrId, options = {}) {
      const actor = typeof actorOrId === 'string' ? this.findById(actorOrId) : actorOrId;
      if (!actor) return options.fallback || 'Actor';
      if (actor.type === 'ego') return options.ego || 'Ego';

      const type = String(actor.type || 'actor').toUpperCase();
      const index = this.npcs
        .filter(n => n.type === actor.type)
        .findIndex(n => n.id === actor.id);
      return index >= 0 ? `${type} ${index + 1}` : type;
    },

    /** Snapshot editor state as scenario JSON. */
    toJSON() {
      return {
        schema_version: '1.0',
        map: this.map,
        weather: { ...this.weather },
        time: this.time,
        ego: {
          ...this.ego,
          trajectory: this.ego.trajectory.map(p => ({ ...p })),
        },
        npcs: this.npcs.map(n => ({
          ...n,
          events: n.events.map(ev => ({ ...ev })),
          behaviors: [...n.behaviors],
        })),
        staticObjects: this.staticObjects.map(o => ({ ...o })),
        trafficSignals: this.trafficSignals.map(sig => ({
          ...sig,
          events: sig.events.map(ev => ({ ...ev })),
        })),
      };
    },

    /** Restore editor state from scenario JSON. */
    loadJSON(data) {
      this.map             = data.map || null;
      this.weather         = data.weather ? { ...data.weather } : { ...this.weather };
      this.time            = data.time || 'daytime';
      this.ego             = data.ego ? { ...data.ego, trajectory: data.ego.trajectory || [] } : null;
      this.npcs            = (data.npcs || []).map(n => ({
        ...n,
        events: n.events || [],
        behaviors: n.behaviors || [],
      }));
      this.staticObjects   = data.staticObjects || [];
      this.trafficSignals = (data.trafficSignals || []).map(sig => ({ ...sig, events: sig.events || [] }));
      this.selectedId      = null;
      this.selectedTrafficLightId = null;
      this.activeTool      = null;
      this.trajectoryMode  = false;
      this.activeTrajectoryId = null;
      this.routeMode       = false;
      this.activeRouteId   = null;
      this.activePathEventId = null;
      this.triggerPointMode = null;
      this.pendingTemplate = null;
      this.emit('stateLoaded', data);
    },
  };

  window.AppState = AppState;

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

  window.Toast = { show: showToast, success: (m, d) => showToast(m, 'success', d),
    error: (m, d) => showToast(m, 'error', d || 6000), warn: (m, d) => showToast(m, 'warning', d),
    info: (m, d) => showToast(m, 'info', d) };

  // ── Confirm dialog ──────────────────────────────────────────────────────────

  const _confirmOverlay = document.getElementById('confirm-overlay');
  const _confirmMsg     = document.getElementById('confirm-message');
  const _confirmCancel  = document.getElementById('confirm-cancel');
  const _confirmOk      = document.getElementById('confirm-ok');
  let _confirmResolve   = null;

  function showConfirm(message, okLabel = 'Delete') {
    return new Promise(resolve => {
      _confirmMsg.textContent = message;
      _confirmOk.textContent  = okLabel;
      _confirmOverlay.classList.remove('hidden');
      _confirmResolve = resolve;
    });
  }

  _confirmCancel.addEventListener('click', () => { _confirmOverlay.classList.add('hidden'); if (_confirmResolve) _confirmResolve(false); });
  _confirmOk.addEventListener('click', () => { _confirmOverlay.classList.add('hidden'); if (_confirmResolve) _confirmResolve(true); });

  window.Confirm = { show: showConfirm };

  // ── Undo stack (for delete operations) ───────────────────────────────────────

  const _undoStack = [];
  const MAX_UNDO = 20;

  window.UndoStack = {
    push(entry) {
      _undoStack.push(entry);
      if (_undoStack.length > MAX_UNDO) _undoStack.shift();
    },
    pop() { return _undoStack.pop() || null; },
    get length() { return _undoStack.length; },
  };

  // ── Shared panel helpers (properties.js / eventPanel.js) ────────────────────

  window.UIUtils = {
    /** Labelled control row with a trailing unit, as used in event cards. */
    paramRow(labelText, control, unitText) {
      const row = document.createElement('div');
      row.className = 'event-param-row';
      const label = document.createElement('label');
      label.textContent = labelText;
      const unit = document.createElement('span');
      unit.style.cssText = 'color:var(--text-dim);font-size:10px;';
      unit.textContent = unitText;
      row.appendChild(label);
      row.appendChild(control);
      row.appendChild(unit);
      return row;
    },

    /** Next free numeric suffix for `${prefix}-${n}` ids within `events`. */
    nextIndexedId(events, prefix) {
      const used = new Set((events || []).map(ev => String(ev.id || '')));
      let idx = events.length + 1;
      while (used.has(`${prefix}-${idx}`)) idx += 1;
      return idx;
    },
  };
})();
