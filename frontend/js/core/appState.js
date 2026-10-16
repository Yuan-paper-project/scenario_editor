/**
 * appState.js — Global scenario state (AppState) and its event bus. All modules read from and write to
 * AppState; changes emit events so dependent modules can re-render.
 */
(() => {
  'use strict';

  let _nextId = 1;

  /**
   * Actor types that may be swapped on a placed actor; sections become <optgroup>s.
   * The groups are load-bearing: vehicles are lane-snapped and routable, VRUs are
   * placed freely, so only a within-group swap keeps pose and events valid.
   * ego and prop are in no group.
   */
  const ACTOR_TYPE_GROUPS = [
    {
      id: 'vehicle',
      sections: [
        {
          label: 'Fahrzeuge',
          types: [
            { type: 'car', label: 'Auto' },
            { type: 'van', label: 'Transporter' },
            { type: 'truck', label: 'LKW' },
            { type: 'bus', label: 'Bus' },
            { type: 'motorcycle', label: 'Moto' },
            { type: 'scooter', label: 'Roller' },
          ],
        },
        {
          label: 'Einsatzfahrzeuge',
          types: [
            { type: 'police', label: 'Polizei' },
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
            { type: 'child', label: 'Kind' },
            { type: 'cyclist', label: 'Radfahrer' },
          ],
        },
      ],
    },
  ];

  /** German names for weather keys and time values; the Umgebung menu repeats them in index.html. */
  const WEATHER_LABELS = {
    fog: 'Nebel',
    rainy: 'Regen',
    cloudy: 'Wolken',
    sunny: 'Sonne',
    wet_road: 'Nasse Stra\u00dfe',
    snowy: 'Schnee',
    dust_storm: 'Staub',
  };
  const TIME_LABELS = {
    daytime: 'Tags\u00fcber',
    morning: 'Morgen',
    noon: 'Mittag',
    afternoon: 'Nachmittag',
    dusk: 'D\u00e4mmerung',
    nighttime: 'Nacht',
  };

  const AppState = {
    // ── Map ──────────────────────────────────────────────────
    map: null, // selected town name string
    mapData: null, // road render JSON from /api/maps/{town}/render
    laneGraph: null, // cached CARLA routing graph from /api/maps/{town}/lane_graph, or null if unprobed
    // Landmarks for ALL towns (maps/special_buildings.csv); reference data, never scenario state.
    specialBuildings: [],

    // ── Scenario ─────────────────────────────────────────────
    ego: null, // {id, type:'ego', x, y, z, yaw, initial_speed, events} or null
    npcs: [], // [{id, type, x, y, z, yaw, initial_speed, events}]
    staticObjects: [], // [{id, type:'prop', prop:'static.prop.*', x, y, z, yaw}]
    trafficSignals: [], // configured traffic-light events from the map

    // ── Weather / time ────────────────────────────────────────
    weather: {
      fog: 0,
      rainy: 0,
      cloudy: 0,
      sunny: 0,
      wet_road: 0,
      snowy: 0,
      dust_storm: 0,
    },
    time: 'daytime',
    // Background traffic settings (bgTraffic.js): saved like weather, kept out of undo.
    bgTraffic: { enabled: false, count: 30, seed: 1, clearance: 0.5, radius: 80 },

    // ── Editor interaction ─────────────────────────────────────
    selectedId: null, // id of selected actor/object
    selectedTrafficLightId: null, // id of selected map traffic light
    // The marked waypoint, shared by the map and the event card:
    //   { actorId, eventId, pathType: 'trajectory'|'route', index }. Editor-only, no undo.
    selectedWaypoint: null,
    activeTool: null, // selected toolbar tool, or null
    trajectoryMode: false, // true while drawing a path
    activeTrajectoryId: null, // actor id whose trajectory we're drawing
    routeMode: false, // true while drawing a route
    activeRouteId: null, // actor id whose route we're drawing
    activePathEventId: null, // event id whose action path/route we're drawing
    pendingTemplate: null, // scenario template to apply to the next placed actor
    pendingGenerate: null, // generator type key (or 'any') to build at the next map click
    // The generator's recipe for what is on screen, or null. Scenario state (saved, in undo).
    generated: null,
    pendingProp: null, // CARLA blueprint id to place while activeTool === 'prop'

    // ── Listeners ─────────────────────────────────────────────
    _listeners: {},

    // ── Helpers ───────────────────────────────────────────────
    nextId() {
      return `obj-${_nextId++}`;
    },

    /** True for static props, which have no speed, events, or path. */
    isProp(actorOrId) {
      const actor = typeof actorOrId === 'string' ? this.findById(actorOrId) : actorOrId;
      return actor?.type === 'prop';
    },

    /** The actor's one path event (follow_trajectory or assign_route), or null; at most one per actor. */
    pathEventOf(actor) {
      return (
        (actor?.events || []).find((ev) => {
          const a = ev.action || {};
          return (
            (a.type === 'follow_trajectory' && (a.trajectory || []).length > 0) ||
            (a.type === 'assign_route' && (a.waypoints || []).length > 0)
          );
        }) || null
      );
    },

    /** The path event's points ([] when the actor has no path event yet). */
    pathPointsOf(actor) {
      const ev = this.pathEventOf(actor);
      if (!ev) return [];
      return ev.action.type === 'assign_route' ? ev.action.waypoints || [] : ev.action.trajectory || [];
    },

    on(event, fn) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(fn);
    },

    off(event, fn) {
      if (!this._listeners[event]) return;
      this._listeners[event] = this._listeners[event].filter((f) => f !== fn);
    },

    emit(event, data) {
      (this._listeners[event] || []).forEach((fn) => fn(data));
    },

    /** Patch state and emit 'change'. */
    set(patch) {
      const scenario = UndoStack._isScenarioPatch(patch);
      if (scenario) UndoStack._recordSet();
      Object.assign(this, patch);
      this.emit('change', patch);
      // After the listeners, which may mutate further (_discardIncompletePath).
      if (scenario) UndoStack._settle();
    },

    /** Find any object by id (ego, npc, or static). */
    findById(id) {
      if (this.ego && this.ego.id === id) return this.ego;
      const npc = this.npcs.find((n) => n.id === id);
      if (npc) return npc;
      return this.staticObjects.find((o) => o.id === id) || null;
    },

    /** Update an existing object's fields. */
    updateById(id, patch) {
      patch = UndoStack._seedFollowPatch(id, patch);
      UndoStack._recordUpdate(id, patch);
      if (this.ego && this.ego.id === id) {
        Object.assign(this.ego, patch);
      } else {
        const npc = this.npcs.find((n) => n.id === id);
        if (npc) Object.assign(npc, patch);
        else {
          const obj = this.staticObjects.find((o) => o.id === id);
          if (obj) Object.assign(obj, patch);
        }
      }
      this.emit('actorUpdated', id);
      UndoStack._settle();
    },

    /** Remove an object. */
    removeById(id) {
      UndoStack._recordRemove(id);
      if (this.ego && this.ego.id === id) {
        this.ego = null;
      } else {
        this.npcs = this.npcs.filter((n) => n.id !== id);
        this.staticObjects = this.staticObjects.filter((o) => o.id !== id);
      }
      if (this.selectedId === id) this.selectedId = null;
      if (this.selectedWaypoint?.actorId === id) this.selectedWaypoint = null;
      this.emit('actorRemoved', id);
      UndoStack._settle();
    },

    /** Select an actor. Pass null to deselect. */
    select(id) {
      // A waypoint mark on another actor would be unreachable, and Entf would delete it unseen.
      if (this.selectedWaypoint && this.selectedWaypoint.actorId !== id) {
        this.selectedWaypoint = null;
      }
      this.selectedId = id;
      this.selectedTrafficLightId = null;
      this.emit('selectionChanged', id);
    },

    /** Mark one path waypoint (null clears). Editor-only: no undo entry. */
    selectWaypoint(sel) {
      this.set({ selectedWaypoint: sel || null });
    },

    /** The waypoint array `selectedWaypoint` points into, or null. */
    waypointPathOf(sel) {
      if (!sel) return null;
      const actor = this.findById(sel.actorId);
      const ev = (actor?.events || []).find((item) => item.id === sel.eventId);
      const action = ev?.action;
      if (!action) return null;
      const points = sel.pathType === 'route' ? action.waypoints : action.trajectory;
      return Array.isArray(points) ? points : null;
    },

    /**
     * Actor label, numbered per type for NPCs. Owns both spellings of the ego:
     * 'Ego-Fahrzeug' in prose, 'EGO' with `short` (beside CAR 1 etc.).
     */
    actorLabel(actorOrId, options = {}) {
      const actor = typeof actorOrId === 'string' ? this.findById(actorOrId) : actorOrId;
      if (!actor) return options.fallback || 'Akteur';
      if (actor.type === 'ego') return options.ego || (options.short ? 'EGO' : 'Ego-Fahrzeug');

      // Props are numbered within staticObjects and named by prop.
      if (actor.type === 'prop') {
        const name = (window.PropCatalog?.label(actor.prop) || 'Requisite').toUpperCase();
        const idx = this.staticObjects.filter((o) => o.prop === actor.prop).findIndex((o) => o.id === actor.id);
        return idx >= 0 ? `${name} ${idx + 1}` : name;
      }

      const type = String(actor.type || 'actor').toUpperCase();
      const index = this.npcs.filter((n) => n.type === actor.type).findIndex((n) => n.id === actor.id);
      return index >= 0 ? `${type} ${index + 1}` : type;
    },

    WEATHER_LABELS,
    TIME_LABELS,

    /** German name for a weather key, falling back to the key itself. */
    weatherLabel(key) {
      return WEATHER_LABELS[key] || String(key || '');
    },

    /** German name for a time-of-day value, falling back to the value itself. */
    timeLabel(value) {
      return TIME_LABELS[value] || String(value || '');
    },

    /** German label for an actor type ('car' -> 'Auto'), derived from ACTOR_TYPE_GROUPS. */
    typeLabel(type) {
      if (type === 'ego') return 'Ego-Fahrzeug';
      if (type === 'prop') return 'Requisite';
      for (const group of ACTOR_TYPE_GROUPS) {
        for (const section of group.sections) {
          const hit = section.types.find((t) => t.type === type);
          if (hit) return hit.label;
        }
      }
      return String(type || '');
    },

    // ── Actor type switching ──────────────────────────────────

    ACTOR_TYPE_GROUPS,

    /** The vehicle archetype an actor is drawn and exported as: the ego's `vehicleType` (absent = car). */
    bodyType(actor) {
      if (!actor) return 'car';
      return actor.type === 'ego' ? actor.vehicleType || 'car' : actor.type;
    },

    /** Change the ego's vehicle type (any 'vehicle' type); one undo step. */
    setEgoVehicleType(nextType) {
      if (!this.ego || this.switchGroupFor(nextType) !== 'vehicle') return false;
      if (this.bodyType(this.ego) === nextType) return false;
      this.updateById(this.ego.id, { vehicleType: nextType });
      return true;
    },

    /** Switch group an actor type belongs to, or null if it cannot be swapped. */
    switchGroupFor(type) {
      const group = ACTOR_TYPE_GROUPS.find((g) => g.sections.some((s) => s.types.some((t) => t.type === type)));
      return group ? group.id : null;
    },

    /** True if a placed actor of type `from` may be swapped to type `to`. */
    canSwitchType(from, to) {
      if (!from || !to || from === to) return false;
      const group = this.switchGroupFor(from);
      return group !== null && group === this.switchGroupFor(to);
    },

    /**
     * Swap a placed NPC's type, keeping id, pose and events. The actor moves to the
     * end of `npcs` so it takes the next number in its new type. False if not allowed.
     */
    switchActorType(id, nextType) {
      const actor = this.npcs.find((n) => n.id === id);
      if (!actor || !this.canSwitchType(actor.type, nextType)) return false;
      this.npcs = [...this.npcs.filter((n) => n.id !== id), actor];
      this.updateById(id, { type: nextType });
      return true;
    },

    /** Deep-copy one scenario actor (ego or NPC) for toJSON(). */
    _dumpActor(a) {
      return {
        ...a,
        events: (a.events || []).map((ev) => ({ ...ev })),
      };
    },

    /** Snapshot editor state as scenario JSON. */
    toJSON() {
      return {
        schema_version: '1.0',
        map: this.map,
        weather: { ...this.weather },
        time: this.time,
        bgTraffic: { ...this.bgTraffic },
        // Nullable: a scenario may hold only props before an ego is placed.
        ego: this.ego ? this._dumpActor(this.ego) : null,
        npcs: this.npcs.map((n) => this._dumpActor(n)),
        staticObjects: this.staticObjects.map((o) => ({ ...o })),
        trafficSignals: this.trafficSignals.map((sig) => ({
          ...sig,
          events: sig.events.map((ev) => ({ ...ev })),
        })),
        generated: this.generated ? JSON.parse(JSON.stringify(this.generated)) : null,
      };
    },

    /** Fill an actor's shared defaults on load (ego and NPCs alike). */
    _hydrateActor(a) {
      // Fields of old save files that nothing reads; dropped so toJSON's spread does not keep them.
      const { behaviors, trigger_distance, ...rest } = a;
      return {
        ...rest,
        events: a.events || [],
        // 0, not the placement default of 10: an old file's actors must stay as still as they were.
        initial_speed: a.initial_speed ?? 0,
      };
    },

    /** Convert a legacy `ego.trajectory` into a follow_trajectory event. Idempotent. */
    _migrateEgoTrajectory(ego) {
      const legacy = ego.trajectory || [];
      delete ego.trajectory;
      if (legacy.length === 0) return ego;
      const hasPathEvent = ego.events.some((ev) => ['follow_trajectory', 'assign_route'].includes(ev.action?.type));
      if (hasPathEvent) return ego;
      ego.events = [
        {
          id: 'evt-legacy-path',
          // Not distance_to_ego: that is a self-distance for the hero.
          trigger: { type: 'simulation_time', value: 0 },
          action: { type: 'follow_trajectory', trajectory: legacy.map((p) => ({ ...p })) },
        },
        ...ego.events,
      ];
      return ego;
    },

    /**
     * Disarm every placement and draw mode (Esc, the ruler, Play). Clearing the draw
     * flags discards a path under two waypoints, so call this before reading actors.
     * Records no undo entry.
     */
    cancelPlacement(extra = {}) {
      this.set({
        activeTool: null,
        pendingTemplate: null,
        pendingProp: null,
        pendingGenerate: null,
        trajectoryMode: false,
        activeTrajectoryId: null,
        routeMode: false,
        activeRouteId: null,
        activePathEventId: null,
        ...extra,
      });
    },

    /** True while a tool is armed, a prop is pending or a path is being drawn. */
    get placementActive() {
      return !!(
        this.activeTool ||
        this.pendingTemplate ||
        this.pendingProp ||
        this.pendingGenerate ||
        this.trajectoryMode ||
        this.routeMode
      );
    },

    /** True when there is anything a clear would throw away. */
    get hasScenarioContent() {
      return !!(
        this.ego ||
        this.npcs.length ||
        this.staticObjects.length ||
        this.generated ||
        this.trafficSignals.some((sig) => (sig.events || []).length)
      );
    },

    /**
     * Empty the scenario on the current map; weather and time stay. One undo step
     * (a map change clears the history instead).
     */
    clearScenario() {
      this.cancelPlacement();
      UndoStack.group('Szenario geleert', () => {
        this.select(null);
        this.set({
          ego: null,
          npcs: [],
          staticObjects: [],
          trafficSignals: [],
          generated: null,
          selectedTrafficLightId: null,
          selectedWaypoint: null,
        });
        // Empty patch: the "arrays changed" signal.
        this.set({});
        this.emit('selectionChanged', null);
      });
    },

    /** Restore editor state from scenario JSON. */
    loadJSON(data) {
      this.map = data.map || null;
      this.weather = data.weather ? { ...data.weather } : { ...this.weather };
      this.time = data.time || 'daytime';
      // A file without the setting loads with traffic off, never the editor's current one.
      this.bgTraffic = { enabled: false, count: 30, seed: 1, clearance: 0.5, radius: 80, ...(data.bgTraffic || {}) };
      this.ego = data.ego ? this._migrateEgoTrajectory(this._hydrateActor(data.ego)) : null;
      this.npcs = (data.npcs || []).map((n) => this._hydrateActor(n));
      this.staticObjects = data.staticObjects || [];
      this.trafficSignals = (data.trafficSignals || []).map((sig) => ({ ...sig, events: sig.events || [] }));
      this.generated = data.generated || null;

      // Advance the id counter past everything loaded, or the next object reuses an id.
      const loadedIds = [this.ego, ...this.npcs, ...this.staticObjects, ...this.trafficSignals]
        .filter(Boolean)
        .map((o) => o.id);
      for (const id of loadedIds) {
        const n = parseInt(String(id).replace(/^obj-/, ''), 10);
        if (Number.isFinite(n) && n >= _nextId) _nextId = n + 1;
      }

      this.selectedId = null;
      this.selectedTrafficLightId = null;
      this.selectedWaypoint = null;
      this.activeTool = null;
      this.trajectoryMode = false;
      this.activeTrajectoryId = null;
      this.routeMode = false;
      this.activeRouteId = null;
      this.activePathEventId = null;
      this.pendingTemplate = null;
      this.pendingProp = null;
      this.pendingGenerate = null;
      this.emit('stateLoaded', data);
    },
  };

  window.AppState = AppState;
})();
