/**
 * app.js — Global state store and simple event bus.
 * All modules read from and write to AppState.
 * Changes emit a 'change' event so dependent modules can re-render.
 */
(function () {
  'use strict';

  let _nextId = 1;

  /**
   * Actor types that may be swapped for one another on an already-placed actor,
   * grouped by what a swap is allowed to preserve. Labels mirror the toolbar
   * buttons in index.html; sections become <optgroup>s in the type picker.
   *
   * The split is load-bearing, not cosmetic: every 'vehicle' type is snapped to
   * a spawn point at placement while every 'vru' type is in ROAD_FACING_TYPES
   * (objects.js) and placed freely, so a within-group swap can keep the existing
   * pose untouched. assign_route is likewise vehicle-only downstream
   * (_ROUTE_ACTION_TYPES in ../llm-scenario-gen/generator/event_builders.py), so
   * a within-group swap can never orphan a route event. Crossing the boundary
   * would break both — hence canSwitchType() rather than a UI-only restriction.
   *
   * ego and prop appear nowhere here and are therefore never swappable.
   */
  const ACTOR_TYPE_GROUPS = [
    {
      id: 'vehicle',
      sections: [
        {
          label: 'Fahrzeuge',
          types: [
            { type: 'car',        label: 'Auto' },
            { type: 'van',        label: 'Transporter' },
            { type: 'truck',      label: 'LKW' },
            { type: 'bus',        label: 'Bus' },
            { type: 'motorcycle', label: 'Moto' },
            { type: 'scooter',    label: 'Roller' },
          ],
        },
        {
          label: 'Einsatzfahrzeuge',
          types: [
            { type: 'police',    label: 'Polizei' },
            { type: 'ambulance', label: 'Rettung' },
            { type: 'firetruck', label: 'Feuerwehr' },
          ],
        },
      ],
    },
    {
      id: 'vru',
      sections: [
        {
          label: 'Personen',
          types: [
            { type: 'pedestrian', label: 'Fußgänger' },
            { type: 'child',      label: 'Kind' },
            { type: 'cyclist',    label: 'Radfahrer' },
          ],
        },
      ],
    },
  ];

  const AppState = {
    // ── Map ──────────────────────────────────────────────────
    map:      null,       // selected town name string
    mapData:  null,       // road render JSON from /api/maps/{town}/render
    laneGraph: null,      // cached CARLA routing graph from /api/maps/{town}/lane_graph, or null if unprobed

    // ── Scenario ─────────────────────────────────────────────
    ego: null,            // {id, type:'ego', x, y, z, yaw, initial_speed, events} or null
    npcs: [],             // [{id, type, x, y, z, yaw, initial_speed, events}]
    staticObjects: [],    // [{id, type:'prop', prop:'static.prop.*', x, y, z, yaw}]
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
    pendingProp:         null,   // CARLA blueprint id to place while activeTool === 'prop'

    // ── Listeners ─────────────────────────────────────────────
    _listeners: {},

    // ── Helpers ───────────────────────────────────────────────
    nextId() { return `obj-${_nextId++}`; },

    /** True for static props, which have no speed, events, or path. */
    isProp(actorOrId) {
      const actor = typeof actorOrId === 'string' ? this.findById(actorOrId) : actorOrId;
      return actor?.type === 'prop';
    },

    /**
     * The actor's single path-producing event (follow_trajectory or
     * assign_route with points), or null. eventPanel.js enforces at most one
     * such event per actor, so "the" path event is unambiguous — this is the
     * one place ego and NPCs share the same path storage: on the actor's
     * events, never on the actor itself.
     */
    pathEventOf(actor) {
      return (actor?.events || []).find(ev => {
        const a = ev.action || {};
        return (a.type === 'follow_trajectory' && (a.trajectory || []).length > 0)
            || (a.type === 'assign_route'      && (a.waypoints  || []).length > 0);
      }) || null;
    },

    /** The path event's points ([] when the actor has no path event yet). */
    pathPointsOf(actor) {
      const ev = this.pathEventOf(actor);
      if (!ev) return [];
      return ev.action.type === 'assign_route' ? (ev.action.waypoints || []) : (ev.action.trajectory || []);
    },

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

      // Props are numbered within staticObjects and labelled by prop, not type
      // (every prop has type === 'prop', so the type would carry no meaning).
      if (actor.type === 'prop') {
        const name = (window.PropCatalog?.label(actor.prop) || 'Requisite').toUpperCase();
        const idx = this.staticObjects
          .filter(o => o.prop === actor.prop)
          .findIndex(o => o.id === actor.id);
        return idx >= 0 ? `${name} ${idx + 1}` : name;
      }

      const type = String(actor.type || 'actor').toUpperCase();
      const index = this.npcs
        .filter(n => n.type === actor.type)
        .findIndex(n => n.id === actor.id);
      return index >= 0 ? `${type} ${index + 1}` : type;
    },

    // ── Actor type switching ──────────────────────────────────

    ACTOR_TYPE_GROUPS,

    /** Switch group an actor type belongs to, or null if it cannot be swapped. */
    switchGroupFor(type) {
      const group = ACTOR_TYPE_GROUPS.find(g =>
        g.sections.some(s => s.types.some(t => t.type === type)));
      return group ? group.id : null;
    },

    /** All swappable types for a group id, flattened across its sections. */
    switchTypesFor(groupId) {
      const group = ACTOR_TYPE_GROUPS.find(g => g.id === groupId);
      return group ? group.sections.flatMap(s => s.types.map(t => t.type)) : [];
    },

    /** True if a placed actor of type `from` may be swapped to type `to`. */
    canSwitchType(from, to) {
      if (!from || !to || from === to) return false;
      const group = this.switchGroupFor(from);
      return group !== null && group === this.switchGroupFor(to);
    },

    /**
     * Swap a placed NPC's type in place. Only `type` changes — id, pose, events
     * and start speed are left untouched.
     *
     * The actor is moved to the end of `npcs` so it takes the next number in its
     * new type group, exactly as a freshly placed actor does; the type it left
     * closes its gap for free, because actorLabel() derives the number from
     * array position rather than storing it. Returns false if the swap is not
     * allowed (ego, prop, unknown or cross-group type).
     */
    switchActorType(id, nextType) {
      const actor = this.npcs.find(n => n.id === id);
      if (!actor || !this.canSwitchType(actor.type, nextType)) return false;
      this.npcs = [...this.npcs.filter(n => n.id !== id), actor];
      this.updateById(id, { type: nextType });
      return true;
    },

    /** Deep-copy one scenario actor (ego or NPC) for toJSON(). */
    _dumpActor(a) {
      return {
        ...a,
        events: (a.events || []).map(ev => ({ ...ev })),
      };
    },

    /** Snapshot editor state as scenario JSON. */
    toJSON() {
      return {
        schema_version: '1.0',
        map: this.map,
        weather: { ...this.weather },
        time: this.time,
        // Nullable: a scenario may hold only props before an ego is placed.
        ego: this.ego ? this._dumpActor(this.ego) : null,
        npcs: this.npcs.map(n => this._dumpActor(n)),
        staticObjects: this.staticObjects.map(o => ({ ...o })),
        trafficSignals: this.trafficSignals.map(sig => ({
          ...sig,
          events: sig.events.map(ev => ({ ...ev })),
        })),
      };
    },

    /** Fill an actor's shared defaults on load (ego and NPCs alike). */
    _hydrateActor(a) {
      // behaviors/trigger_distance are dropped rather than spread through: a
      // save file predating their removal would otherwise carry them straight
      // back out through toJSON()'s `...a`, as fields nothing reads any more.
      const { behaviors, trigger_distance, ...rest } = a;
      return {
        ...rest,
        events: a.events || [],
        // 0, not ObjectsManager's placement default of 10: this runs on
        // loadJSON, and a save file predating the field must keep its actors
        // exactly as stationary as they were when it was written.
        initial_speed: a.initial_speed ?? 0,
      };
    },

    /**
     * Legacy saves put the ego's path on the actor itself as `trajectory`
     * (from before the ego had events at all). Convert it into a
     * follow_trajectory event, exactly like an NPC's path, so old files —
     * example/Town01_scenario2.json, every tests/artifacts case's scenario.json
     * — still open. Idempotent: a no-op once migrated. Nothing downstream
     * reads ego.trajectory any more.
     */
    _migrateEgoTrajectory(ego) {
      const legacy = ego.trajectory || [];
      delete ego.trajectory;
      if (legacy.length === 0) return ego;
      const hasPathEvent = ego.events.some(ev =>
        ['follow_trajectory', 'assign_route'].includes(ev.action?.type));
      if (hasPathEvent) return ego;
      ego.events = [{
        id: 'evt-legacy-path',
        // Not distance_to_ego: that is a self-distance for the hero.
        trigger: { type: 'simulation_time', value: 0 },
        action: { type: 'follow_trajectory', trajectory: legacy.map(p => ({ ...p })) },
      }, ...ego.events];
      return ego;
    },

    /** Restore editor state from scenario JSON. */
    loadJSON(data) {
      this.map             = data.map || null;
      this.weather         = data.weather ? { ...data.weather } : { ...this.weather };
      this.time            = data.time || 'daytime';
      this.ego             = data.ego ? this._migrateEgoTrajectory(this._hydrateActor(data.ego)) : null;
      this.npcs            = (data.npcs || []).map(n => this._hydrateActor(n));
      this.staticObjects   = data.staticObjects || [];
      this.trafficSignals = (data.trafficSignals || []).map(sig => ({ ...sig, events: sig.events || [] }));

      // Advance the id counter past everything just loaded, otherwise the next
      // placed object reuses an id that already exists in the file.
      const loadedIds = [this.ego, ...this.npcs, ...this.staticObjects, ...this.trafficSignals]
        .filter(Boolean).map(o => o.id);
      for (const id of loadedIds) {
        const n = parseInt(String(id).replace(/^obj-/, ''), 10);
        if (Number.isFinite(n) && n >= _nextId) _nextId = n + 1;
      }

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
      this.pendingProp     = null;
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
      unit.style.cssText = 'color:var(--text-dim);font-size:11px;';
      unit.textContent = unitText;
      row.appendChild(label);
      row.appendChild(control);
      row.appendChild(unit);
      return row;
    },

    /**
     * Display precision for a numeric field, chosen to match the input's own
     * `step`: a 0.1/0.5-step field reads 1 dp, a whole-number one reads as an
     * integer. Both the input value and the card summary above it go through
     * this, so they can never disagree (`10` next to `10.0`).
     */
    fmt(value, decimals = 1) {
      const n = Number(value);
      return Number.isFinite(n) ? n.toFixed(decimals) : '';
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
