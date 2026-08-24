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

  /**
   * German names for the weather keys and the time-of-day values.
   *
   * These are the same words the weather bar prints, and the bar spells them
   * out in index.html markup — keep the two in step. Anything that reports
   * weather back to the user (today the scenario summary) reads them from here
   * rather than printing the raw key, which is how the summary came to say
   * 'wet_road' underneath a slider labelled 'Nasse Str.'.
   */
  const WEATHER_LABELS = {
    fog: 'Nebel', rainy: 'Regen', cloudy: 'Wolken', sunny: 'Sonne',
    wet_road: 'Nasse Stra\u00dfe', snowy: 'Schnee', dust_storm: 'Staub',
  };
  const TIME_LABELS = {
    daytime: 'Tags\u00fcber', morning: 'Morgen', noon: 'Mittag',
    afternoon: 'Nachmittag', dusk: 'D\u00e4mmerung', nighttime: 'Nacht',
  };

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
    // The one path waypoint currently under the cursor's attention, shared by
    // the map (mapView.js) and the event card's waypoint list (eventPanel.js)
    // so the two always agree on which point is which:
    //   { actorId, eventId, pathType: 'trajectory'|'route', index }
    // Editor-only state, so it records no undo entry (_isScenarioPatch).
    selectedWaypoint:    null,
    activeTool:          null,   // selected toolbar tool, or null
    trajectoryMode:      false,  // true while drawing a path
    activeTrajectoryId:  null,   // actor id whose trajectory we're drawing
    routeMode:           false,  // true while drawing a route
    activeRouteId:       null,   // actor id whose route we're drawing
    activePathEventId:    null,   // event id whose action path/route we're drawing
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
      const scenario = _isScenarioPatch(patch);
      if (scenario) _recordSet();
      Object.assign(this, patch);
      this.emit('change', patch);
      // After the listeners: one of them can mutate further (objects.js
      // discards an incomplete path on a mode change), and the baseline has to
      // end up describing the state the user is actually looking at.
      if (scenario) _settle();
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
      patch = _seedFollowPatch(id, patch);
      _recordUpdate(id, patch);
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
      _settle();
    },

    /** Remove an object. */
    removeById(id) {
      _recordRemove(id);
      if (this.ego && this.ego.id === id) {
        this.ego = null;
      } else {
        this.npcs          = this.npcs.filter(n => n.id !== id);
        this.staticObjects = this.staticObjects.filter(o => o.id !== id);
      }
      if (this.selectedId === id) this.selectedId = null;
      if (this.selectedWaypoint?.actorId === id) this.selectedWaypoint = null;
      this.emit('actorRemoved', id);
      _settle();
    },

    /** Select an actor. Pass null to deselect. */
    select(id) {
      // Waypoints are only clickable while their own actor is selected, so a
      // selection that moves elsewhere leaves the marked point unreachable —
      // and Entf would then delete a waypoint of an actor no longer on screen.
      if (this.selectedWaypoint && this.selectedWaypoint.actorId !== id) {
        this.selectedWaypoint = null;
      }
      this.selectedId = id;
      this.selectedTrafficLightId = null;
      this.emit('selectionChanged', id);
    },

    /**
     * Mark one path waypoint, or clear the mark with null.
     *
     * Goes through set() so both the map and the event card hear about it on
     * the same 'change'; the key is editor-only, so nothing lands in the undo
     * history (marking a point is not an edit).
     */
    selectWaypoint(sel) {
      this.set({ selectedWaypoint: sel || null });
    },

    /** The waypoint array `selectedWaypoint` points into, or null. */
    waypointPathOf(sel) {
      if (!sel) return null;
      const actor = this.findById(sel.actorId);
      const ev = (actor?.events || []).find(item => item.id === sel.eventId);
      const action = ev?.action;
      if (!action) return null;
      const points = sel.pathType === 'route' ? action.waypoints : action.trajectory;
      return Array.isArray(points) ? points : null;
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

    /**
     * Human-readable actor label, indexed per actor type for NPCs.
     *
     * The ego has exactly two spellings and this is where both live: prose
     * ('Ego-Fahrzeug' — panel titles, toasts, validation messages) and `short`
     * ('EGO' — the map marker, the draw banner and the event dropdowns, where
     * it sits beside AUTO 1 / FUSSGAENGER 2 and has to match their case and
     * width). Callers used to pass the spelling in, which is how one vehicle
     * ended up called Ego-Fahrzeug, EGO, Ego Vehicle and Ego in four places.
     */
    actorLabel(actorOrId, options = {}) {
      const actor = typeof actorOrId === 'string' ? this.findById(actorOrId) : actorOrId;
      if (!actor) return options.fallback || 'Akteur';
      if (actor.type === 'ego') return options.ego || (options.short ? 'EGO' : 'Ego-Fahrzeug');

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

    /**
     * German label for a bare actor type string ('car' -> 'Auto').
     *
     * Derived from ACTOR_TYPE_GROUPS rather than a second table, so a type
     * added to the picker is named correctly everywhere for free. Falls back
     * to the raw key, which is what the scenario summary used to print for
     * every type ('car', 'pedestrian') next to a toolbar saying Auto and
     * Fussgaenger.
     */
    WEATHER_LABELS,
    TIME_LABELS,

    /** German name for a weather key, falling back to the key itself. */
    weatherLabel(key) { return WEATHER_LABELS[key] || String(key || ''); },

    /** German name for a time-of-day value, falling back to the value itself. */
    timeLabel(value) { return TIME_LABELS[value] || String(value || ''); },

    typeLabel(type) {
      if (type === 'ego') return 'Ego-Fahrzeug';
      if (type === 'prop') return 'Requisite';
      for (const group of ACTOR_TYPE_GROUPS) {
        for (const section of group.sections) {
          const hit = section.types.find(t => t.type === type);
          if (hit) return hit.label;
        }
      }
      return String(type || '');
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

    /**
     * Disarm every in-progress placement / draw mode.
     *
     * Three callers need exactly this set cleared — Esc, the ruler toggle (which
     * passes its own `activeTool`) and pressing Play — and it was two verbatim
     * copies of an eight-key literal before the third arrived. Clearing the draw
     * flags is also what discards a path that never reached two waypoints
     * (objects.js `_discardIncompletePath` hangs off this change), so callers
     * that go on to read the actors must call this first.
     *
     * Records no undo entry: `_isScenarioPatch` does not count editor-only keys.
     */
    cancelPlacement(extra = {}) {
      this.set({
        activeTool: null, pendingTemplate: null, pendingProp: null,
        trajectoryMode: false, activeTrajectoryId: null,
        routeMode: false, activeRouteId: null, activePathEventId: null,
        ...extra,
      });
    },

    /** True while a tool is armed, a prop is pending or a path is being drawn. */
    get placementActive() {
      return !!(this.activeTool || this.pendingTemplate || this.pendingProp ||
                this.trajectoryMode || this.routeMode);
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
      this.selectedWaypoint = null;
      this.activeTool      = null;
      this.trajectoryMode  = false;
      this.activeTrajectoryId = null;
      this.routeMode       = false;
      this.activeRouteId   = null;
      this.activePathEventId = null;
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

  function showConfirm(message, okLabel = 'L\u00f6schen') {
    return new Promise(resolve => {
      _confirmMsg.textContent = message;
      _confirmOk.textContent  = okLabel;
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
  window.addEventListener('keydown', e => {
    if (_confirmOverlay.classList.contains('hidden')) return;
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    _closeConfirm(e.key === 'Enter');
  }, true);

  window.Confirm = {
    show: showConfirm,
    /** True while a dialog is open — key handlers use this to stand down. */
    get isOpen() { return !_confirmOverlay.classList.contains('hidden'); },
  };

  // ── Undo / redo history ──────────────────────────────────────────────────────

  /**
   * Snapshot-based undo, captured automatically at AppState's three mutators.
   *
   * Every scenario edit in the app goes through set() / updateById() /
   * removeById() — placement, the body and yaw drags, the Spawnpunkt fields,
   * type swaps, event add/edit/delete, waypoints, trigger points, templates —
   * so nothing has to be instrumented at the call site and an edit added later
   * is covered for free. The exception is TrafficSignals.update(), which
   * rewrites AppState.trafficSignals directly and calls record() itself.
   *
   * This replaces a stack that held one deleted actor per entry. Its failure
   * mode was worse than a missing feature: Strg+Z after a misplaced drag popped
   * an unrelated *delete* from earlier in the session and resurrected that
   * actor, while the drag stood.
   *
   * Scope is the scenario objects only. `map`/`mapData` stay out because
   * undoing a town switch would need an async re-fetch, and weather/time stay
   * out because they are a global setting rather than an edit (their sliders
   * are also the only controls in the app that fire on `input` rather than
   * `change`, so they would need coalescing of their own).
   */

  // Raised from 50 once event edits and waypoints started recording: drawing a
  // long path is one entry per waypoint, and a short stack would let a single
  // path evict every placement behind it.
  const MAX_HISTORY = 100;

  const _undo = [];       // states BEFORE each edit, oldest first
  const _redo = [];       // states AFTER each undone edit
  let _baseline   = null; // the scenario as of the last settled edit
  let _openKind   = null; // coalescing key of the edit currently in progress
  let _suspend    = 0;    // >0 while something else owns the actor poses
  let _groupDepth = 0;
  let _groupLabel = null;
  let _groupTaken = false;

  const SCENARIO_KEYS = ['ego', 'npcs', 'staticObjects', 'trafficSignals'];

  /**
   * Deep copy of the scenario half of AppState.
   *
   * A JSON round-trip and not AppState.toJSON(): _dumpActor() spreads each
   * event, so an action's `trajectory`/`waypoints` array stays shared with the
   * live state — a snapshot taken that way would be rewritten in place by the
   * very edit it is supposed to be the "before" of.
   */
  function _snapshot(label) {
    const copy = JSON.parse(JSON.stringify({
      ego:            AppState.ego,
      npcs:           AppState.npcs,
      staticObjects:  AppState.staticObjects,
      trafficSignals: AppState.trafficSignals,
    }));
    copy.label                  = label || '';
    copy.selectedId             = AppState.selectedId;
    copy.selectedTrafficLightId = AppState.selectedTrafficLightId;
    return copy;
  }

  /**
   * Push the "before" of an edit about to happen.
   *
   * What gets pushed is `_baseline` — the state as of the last settled edit —
   * and NOT a snapshot taken here. The two are not the same, because the
   * placement paths mutate the array first and only then announce it
   * (`AppState.npcs = [...]; AppState.set({})`), so by the time set() runs, the
   * "before" state is already gone. _settle() refreshes the baseline after each
   * mutation instead, which is the one point where the state is known-good.
   *
   * `kind` is the coalescing key: consecutive edits sharing one collapse into a
   * single entry, which is what makes a drag — dozens of updateById calls with
   * the same id and the same patch keys — one Strg+Z. Pass null for an edit
   * that must always start its own entry. seal() ends the current run, so two
   * deliberate edits that happen to produce the same key stay separate.
   */
  function _record(kind, label) {
    if (_suspend > 0) return;
    if (_baseline === null) _baseline = _snapshot('');
    if (_groupDepth > 0) {
      if (_groupTaken) return;
      _groupTaken = true;
      label = _groupLabel || label;
    } else {
      if (kind !== null && kind === _openKind) return;
      _openKind = kind;
    }
    _baseline.label = label || '';
    _undo.push(_baseline);
    _baseline = null;           // _settle() takes the post-edit state
    if (_undo.length > MAX_HISTORY) _undo.shift();
    _redo.length = 0;
  }

  /** Re-read the baseline once an edit has been applied. */
  function _settle() {
    if (_suspend > 0) return;
    _baseline = _snapshot('');
  }

  /** True for a patch that touches the scenario rather than editor-only state. */
  function _isScenarioPatch(patch) {
    const keys = Object.keys(patch);
    // An empty patch is this codebase's signal that one of the state arrays was
    // mutated in place (`AppState.npcs = [...]; AppState.set({})`), which is how
    // every placement and the bulk prop delete announce themselves.
    if (keys.length === 0) return true;
    return keys.some(k => SCENARIO_KEYS.includes(k));
  }

  // Patch shapes worth naming in the toast. Everything else undoes as a plain
  // "Rückgängig" rather than guessing a name for it.
  const PATCH_LABELS = [
    [['x', 'y', 'z'],       'Verschieben'],
    [['yaw'],               'Drehen'],
    [['type'],              'Typwechsel'],
    [['prop'],              'Typwechsel'],
    [['initial_speed'],     'Startgeschwindigkeit'],
    // Last, so a bare {yaw} still reads 'Drehen': the Spawnpunkt fields commit
    // all four together (_onPosChange), and naming the panel section is more
    // use than picking one of the four to name.
    [['x', 'y', 'z', 'yaw'], 'Spawnpunkt'],
  ];

  function _labelForPatch(patch) {
    const keys = Object.keys(patch);
    if (!keys.length) return '';
    const hit = PATCH_LABELS.find(([fields]) => keys.every(k => fields.includes(k)));
    return hit ? hit[1] : '';
  }

  function _recordSet() {
    // null kind: every scenario set() is a discrete act (a placement, a bulk
    // delete) and must never fold into the one before it.
    _record(null, '');
  }

  /** True when every field in the patch already holds that value. */
  /**
   * Waypoint 1 of every path event is the actor's own pose, so an actor that
   * moves takes it with it. Without this the seed stays where the path was
   * drawn and the actor routes back to a point it has since left — visible as a
   * route that starts by driving backwards.
   *
   * Folded into the caller's patch rather than issued as a second updateById:
   * `events` then rides along in the SAME patch as x/y, so the move and the
   * seed are one undo entry instead of two that can be separated.
   *
   * `events` is attached whenever the actor has a path at all, even on the
   * frames where the snap leaves the seed exactly where it was. The undo key is
   * `id + sorted patch keys`, so a key that alternated between {x,y} and
   * {x,y,events} mid-drag would break a single drag into several entries.
   * A patch that genuinely changes nothing is still dropped by _isNoOpPatch,
   * which deep-compares.
   *
   * Skipped outright while the preview is driving this actor: it rewrites
   * actor.x/y every tick, and following that would rewrite the authored path
   * under the running preview — the same reason routeGeometry reads the
   * authored pose rather than the live one.
   */
  function _seedFollowPatch(id, patch) {
    if (!('x' in patch) && !('y' in patch)) return patch;
    if (window.Simulate && Simulate.authoredPose && Simulate.authoredPose(id)) return patch;

    const actor = (AppState.ego && AppState.ego.id === id)
      ? AppState.ego
      : AppState.npcs.find(n => n.id === id);
    if (!actor) return patch;

    const x = 'x' in patch ? patch.x : actor.x;
    const y = 'y' in patch ? patch.y : actor.y;
    const z = 'z' in patch ? patch.z : actor.z;

    let hasPath = false;
    const events = (actor.events || []).map(ev => {
      const action = ev.action || {};
      const isRoute = action.type === 'assign_route';
      const path = isRoute ? action.waypoints
                 : action.type === 'follow_trajectory' ? action.trajectory
                 : null;
      if (!path || !path.length) return ev;
      hasPath = true;

      let seed;
      if (isRoute && window.ObjectsManager) {
        // Snapped like any other 'fastest' waypoint — the actor's own pose need
        // not be on a lane (hand-typed, or dragged onto the verge).
        const snap = ObjectsManager.routeWaypointAt(x, y);
        seed = { ...path[0], x: snap.x, y: snap.y,
                 z: snap.snapped ? snap.z : (z ?? path[0].z), strategy: 'fastest' };
      } else {
        seed = { ...path[0], x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10,
                 z: z ?? path[0].z };
      }
      const next = [seed, ...path.slice(1)];
      return { ...ev, action: isRoute ? { ...action, waypoints: next }
                                      : { ...action, trajectory: next } };
    });

    return hasPath ? { ...patch, events } : patch;
  }

  function _isNoOpPatch(id, patch) {
    const actor = AppState.findById(id);
    if (!actor) return false;
    return Object.keys(patch).every(k => {
      const a = actor[k], b = patch[k];
      if (a === b) return true;
      if (a && b && typeof a === 'object' && typeof b === 'object') {
        return JSON.stringify(a) === JSON.stringify(b);
      }
      return false;
    });
  }

  /**
   * Which event an `{events}` patch touches, and what to call the edit.
   *
   * **Everything in a snapshot must be recorded.** An edit that is skipped is
   * not merely un-undoable: it is *destroyed* by the next undo, because the
   * entry pushed after it describes a world where it never happened. Skipping
   * event tweaks meant "add event A, retune event B, Strg+Z" silently threw
   * away the retune. The way to keep something out of undo is to keep it out of
   * the snapshot — which is what `weather`/`time` do — not to stop recording it.
   *
   * Noise is handled by coalescing instead: the key is the id of the ONE event
   * the patch changed, so every control in a single card folds into one undo
   * step, and touching a different card starts a new one. The label is part of
   * the key so that adding, editing and deleting the same event stay distinct
   * steps rather than folding into each other.
   *
   * The changed event is found by reference identity, not by comparing
   * contents: every mutation site rebuilds the array with `.map()`, so the
   * untouched events are the very same objects. That keeps this free even on
   * the trigger-point drag, which patches once per mousemove against an actor
   * whose trajectory can hold hundreds of points. A future site that rebuilds
   * every event would fall back to the first one, which coalesces more coarsely
   * — never wrongly.
   */
  function _eventsPatchInfo(id, patch) {
    const actor = AppState.findById(id);
    const prev = (actor && actor.events) || [];
    const next = patch.events || [];

    if (next.length > prev.length) {
      const added = next.find(ev => !prev.some(p => p.id === ev.id));
      return { key: added ? added.id : 'neu', label: 'Event hinzugefügt' };
    }
    if (next.length < prev.length) {
      const gone = prev.find(ev => !next.some(n => n.id === ev.id));
      return { key: gone ? gone.id : 'weg', label: 'Event gelöscht' };
    }
    const changed = next.find((ev, i) => ev !== prev[i]);
    return { key: changed ? changed.id : 'events', label: 'Event bearbeitet' };
  }

  function _recordUpdate(id, patch) {
    // A patch that changes nothing gets no entry. Blurring a Spawnpunkt field
    // re-fires `change` with the value already in it, and _onPosChange always
    // sends all four of x/y/z/yaw — so without this, tabbing through the panel
    // fills the history with steps that undo to exactly where they started.
    if (_isNoOpPatch(id, patch)) return;

    const keys = Object.keys(patch);
    if (keys.length === 1 && keys[0] === 'events') {
      const info = _eventsPatchInfo(id, patch);
      _record(`${id}:events:${info.key}:${info.label}`, info.label);
      return;
    }
    _record(`${id}:${keys.sort().join(',')}`, _labelForPatch(patch));
  }

  function _recordRemove(id) {
    _record(`remove:${id}`, 'Löschen');
  }

  /** Restore one snapshot without recording it as an edit of its own. */
  function _apply(snap) {
    _suspend++;
    try {
      // Copy out of the snapshot: updateById mutates an actor in place with
      // Object.assign, so handing the stored object straight to AppState would
      // let the next edit rewrite an entry still sitting in the history.
      const restored = JSON.parse(JSON.stringify({
        ego: snap.ego, npcs: snap.npcs,
        staticObjects: snap.staticObjects, trafficSignals: snap.trafficSignals,
      }));
      AppState.ego            = restored.ego;
      AppState.npcs           = restored.npcs;
      AppState.staticObjects  = restored.staticObjects;
      AppState.trafficSignals = restored.trafficSignals;
      AppState.selectedId = snap.selectedId && AppState.findById(snap.selectedId)
        ? snap.selectedId
        : null;
      AppState.selectedTrafficLightId = snap.selectedTrafficLightId;
      // Waypoint indices are positions in an array the snapshot has just
      // replaced, so a mark taken before the undo can now name a different
      // point — or none at all.
      AppState.selectedWaypoint = null;

      // The empty patch redraws the scene list and the overview; the
      // selectionChanged emit is what re-renders the map and the properties
      // panel. Emitted rather than routed through select(), which would clear
      // selectedTrafficLightId and drop a signal edit out of view as it is undone.
      AppState.set({});
      AppState.emit('selectionChanged', AppState.selectedId);
    } finally {
      _suspend--;
    }
    _openKind = null;
    _settle();
  }

  window.UndoStack = {
    /**
     * End the current coalescing run, so the next edit starts a fresh entry.
     * Bound below to `mousedown` and `change`, which between them precede every
     * committed edit in the app — without it two consecutive Spawnpunkt edits
     * fold into one, since _onPosChange sends the same four keys every time.
     */
    seal() { _openKind = null; },

    /**
     * Stop recording. Balanced with resume(); nests.
     *
     * Coming back out, the baseline is re-read: whatever ran under the
     * suspension changed the state without recording it, and the next edit's
     * "before" has to be where things actually stand. That is what makes the
     * drag's mouseup z-fixup (objects.js) invisible to the history rather than
     * merely unrecorded.
     */
    suspend() { _suspend++; },
    resume()  {
      _suspend = Math.max(0, _suspend - 1);
      if (_suspend === 0) _settle();
    },

    /** Run fn as a single undo entry, however many mutations it makes. */
    group(label, fn) {
      _openKind = null;
      const outerLabel = _groupLabel;
      const outerTaken = _groupTaken;
      if (_groupDepth === 0) { _groupLabel = label || ''; _groupTaken = false; }
      _groupDepth++;
      try {
        return fn();
      } finally {
        _groupDepth--;
        if (_groupDepth === 0) { _groupLabel = null; _groupTaken = false; _openKind = null; }
        else { _groupLabel = outerLabel; _groupTaken = outerTaken; }
      }
    },

    /** Record the current state as the "before" of an edit made outside AppState. */
    record(label) { _record(null, label || ''); },

    /** Undo one edit. Returns { label } or null when there is nothing to undo. */
    undo() {
      if (!_undo.length) return null;
      const before = _undo.pop();
      _redo.push(_snapshot(before.label));
      if (_redo.length > MAX_HISTORY) _redo.shift();
      _apply(before);
      return { label: before.label };
    },

    /** Redo one undone edit. Returns { label } or null. */
    redo() {
      if (!_redo.length) return null;
      const after = _redo.pop();
      _undo.push(_snapshot(after.label));
      if (_undo.length > MAX_HISTORY) _undo.shift();
      _apply(after);
      return { label: after.label };
    },

    clear() { _undo.length = 0; _redo.length = 0; _openKind = null; _baseline = null; },

    get length()     { return _undo.length; },
    get redoLength() { return _redo.length; },
  };

  // Seal on the two events that precede a committed edit. Every editable field
  // in the app commits on `change` (only the map drag and the weather sliders
  // are continuous), and every click- or drag-driven edit opens with a
  // `mousedown`. Capture phase, so the seal lands before the handler that
  // performs the edit.
  //
  // Inside an event card the seal is skipped: an event card is a dozen small
  // controls describing one thing, and sealing between them would make tuning a
  // single card a dozen undo steps. The coalescing key already keys on the
  // event's own id and on what kind of change it is, so a different card — or
  // deleting the one being edited — still starts its own step.
  function _sealUnlessInEventCard(e) {
    const t = e.target;
    if (t && typeof t.closest === 'function' && t.closest('.event-card')) return;
    UndoStack.seal();
  }
  document.addEventListener('change',    _sealUnlessInEventCard, true);
  document.addEventListener('mousedown', _sealUnlessInEventCard, true);

  // Opening a file replaces the scenario the history describes. Restoring a
  // pre-load state would leave the scenario objects from before the load beside
  // the map, weather and time from the file — a half-state neither the user nor
  // the export would recognise.
  AppState.on('stateLoaded', () => UndoStack.clear());

  // ── Which events actually survive the export ────────────────────────────────

  /**
   * ScenarioRules — the single definition of "will this event reach the .xosc",
   * shared by eventPanel.js (warning chips), scenarioIO.js (the export gate) and
   * simulate.js (the preview). It used to live only inside simulate.js, so the
   * panel could show a card the exporter silently threw away.
   *
   * Every rule here mirrors one in ../llm-scenario-gen/generator/event_builders.py
   * — an action builder that returns False makes build_custom_event_chain skip
   * the whole event. The consequence is worse than the lost event: anything
   * chained onto it with after_event is left pointing at a storyboard element
   * that is not in the file, and can never fire.
   */
  const ROUTE_ACTION_TYPES = new Set([
    'car', 'van', 'truck', 'bus', 'motorcycle', 'scooter',
    'police', 'ambulance', 'firetruck', 'ego',
  ]);

  /** A trigger point is only usable once it actually carries coordinates. */
  function _isTriggerPoint(point) {
    return !!point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y));
  }

  window.ScenarioRules = {
    ROUTE_ACTION_TYPES,

    /** Mirrors _add_*_action's own return value: false ⇒ the event is dropped. */
    actionEmits(action, actorType) {
      if (!action) return false;
      if (action.type === 'follow_trajectory') return (action.trajectory || []).length >= 2;
      if (action.type === 'assign_route') {
        return (action.waypoints || []).length >= 2 && ROUTE_ACTION_TYPES.has(actorType);
      }
      return true;   // set_speed / set_distance / lane_change never fail to emit
    },

    /**
     * The one thing wrong with `ev`, or null. `short` is the card chip, `message`
     * the full sentence used by the export gate. Reports the event's own action
     * before its trigger — a dropped action is why the trigger stops mattering.
     */
    eventProblem(actor, ev, events) {
      const action = (ev && ev.action) || {};
      const trigger = (ev && ev.trigger) || {};
      const type = actor && actor.type;

      if (action.type === 'follow_trajectory' && (action.trajectory || []).length < 2) {
        return {
          code: 'path_too_short',
          short: 'Mindestens 2 Wegpunkte nötig',
          message: 'die Trajektorie hat weniger als 2 Wegpunkte',
        };
      }
      if (action.type === 'assign_route') {
        if (!ROUTE_ACTION_TYPES.has(type)) {
          return {
            code: 'route_not_routable',
            short: 'Route nur für Fahrzeuge möglich',
            message: 'eine Route ist für diesen Akteurstyp nicht möglich',
          };
        }
        if ((action.waypoints || []).length < 2) {
          return {
            code: 'path_too_short',
            short: 'Mindestens 2 Wegpunkte nötig',
            message: 'die Route hat weniger als 2 Wegpunkte',
          };
        }
        // The first waypoint must route. Its leg runs from the actor's own pose
        // to itself, so on any path the editor built this is already true (the
        // seed is placed 'fastest' and cannot be deleted or toggled) — the gate
        // exists for a path that reached the editor another way: a save file
        // predating the seed guard, or an LLM payload. The backend raises the
        // same case as a 400; without this the export would fail with no chip
        // ever having said which event was at fault.
        if (action.waypoints[0] && action.waypoints[0].strategy === 'shortest') {
          return {
            code: 'route_starts_straight',
            short: 'Erster Wegpunkt muss der Spur folgen',
            message: 'der erste Wegpunkt der Route ist auf „Gerade" gesetzt',
          };
        }
        // An assign_route's own trigger is discarded and forced to
        // simulation_time 0 at export, so it can never be the problem.
        return null;
      }

      if (trigger.type === 'distance_to_point' && !_isTriggerPoint(trigger.point)) {
        return {
          code: 'no_trigger_point',
          short: 'Kein Auslösepunkt gesetzt',
          message: 'der Auslösepunkt wurde nie auf der Karte gesetzt',
        };
      }
      if (trigger.type === 'after_event') {
        const target = (events || []).find(o => String(o.id) === String(trigger.event_id));
        if (!target) {
          return {
            code: 'dangling_after_event',
            short: 'Auslöser feuert nie — Event fehlt',
            message: 'der Auslöser verweist auf ein Event, das es nicht gibt',
          };
        }
        // Pointing at an assign_route is fine: the backend rewrites that trigger
        // to distance_to_ego @ 400 rather than leaving it dangling.
        const targetAction = target.action || {};
        if (targetAction.type !== 'assign_route' && !this.actionEmits(targetAction, type)) {
          return {
            code: 'dangling_after_event',
            short: 'Auslöser feuert nie — Vorgänger unvollständig',
            message: 'der Auslöser wartet auf ein Event, das selbst nicht exportiert wird',
          };
        }
      }
      return null;
    },

    /** Every problem on one actor, as [{ev, index, problem}]. */
    problemsOf(actor) {
      const events = (actor && actor.events) || [];
      return events
        .map((ev, index) => ({ ev, index, problem: this.eventProblem(actor, ev, events) }))
        .filter(entry => entry.problem);
    },
  };

  // ── Shared panel helpers (properties.js / eventPanel.js) ────────────────────

  let _autoId = 0;

  /* Did the keyboard put focus where it is?
   *
   * Only keys that MOVE focus count. This is deliberately not the browser's own
   * `:focus-visible`, which was tried first and does not work here: its heuristic
   * is "was the most recent interaction a keypress", so pressing Space to start
   * the preview *itself* flips every control into focus-visible, and the second
   * press hands the key straight back to the button. Tab/arrow/Home/End are the
   * only keys that can have delivered focus, so they are the only ones that set
   * this; a bare mousedown clears it.
   */
  let _focusByKeyboard = false;
  document.addEventListener('mousedown', () => { _focusByKeyboard = false; }, true);
  document.addEventListener('keydown', e => {
    if (e.key === 'Tab' || e.key === 'Home' || e.key === 'End' ||
        (typeof e.key === 'string' && e.key.startsWith('Arrow'))) {
      _focusByKeyboard = true;
    }
  }, true);

  window.UIUtils = {
    /**
     * True when `el` holds focus *because the user put it there with the
     * keyboard* — tabbed or arrowed onto, rather than left focused by a click.
     *
     * This is the arbiter for "who owns a bare keystroke". Clicking a button
     * leaves it focused, and the browser then turns Space into a click on it:
     * the last tile clicked in the toolbar kept re-arming and disarming itself
     * while the preview never started, and the same held for any panel button
     * and for a scene row that had been clicked. But a keyboard user who tabbed
     * onto Export really does mean Export, so the key cannot simply be taken
     * globally either. Focus modality separates the two exactly — a
     * click-focused control shows no focus ring, so nothing suggests it is armed.
     *
     * Callers that lose the tie must `preventDefault()`: that is what stops the
     * browser generating the click the focused button would otherwise get.
     */
    keyboardFocused(el) {
      if (!el || el === document.body) return false;
      return _focusByKeyboard && el === document.activeElement;
    },

    /**
     * Point `label` at `control`, giving the control an id if it has none.
     * Every control in the properties panel is built in JS, so without this
     * none of them is programmatically labelled — the visible text sits in a
     * <label> that names nothing.
     *
     * A segmented toggle is a <div> of buttons, which `for=` cannot address at
     * all; it becomes a named group instead, which is what it actually is.
     */
    bindLabel(label, control) {
      if (!control) return label;
      if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(control.tagName)) {
        if (!control.id) control.id = `ui-ctl-${++_autoId}`;
        label.htmlFor = control.id;
      } else {
        control.setAttribute('role', 'group');
        control.setAttribute('aria-label', label.textContent);
      }
      return label;
    },

    /** Labelled control row with a trailing unit, as used in event cards. */
    paramRow(labelText, control, unitText) {
      const row = document.createElement('div');
      row.className = 'event-param-row';
      const label = document.createElement('label');
      label.textContent = labelText;
      window.UIUtils.bindLabel(label, control);
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
