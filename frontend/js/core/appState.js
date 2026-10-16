/**
 * appState.js — Global scenario state (AppState) and its event bus. All modules read from and write to
 * AppState; changes emit events so dependent modules can re-render.
 */
(() => {
  'use strict';

  let _nextId = 1;

  /**
   * Actor types that may be swapped for one another on an already-placed actor,
   * grouped by what a swap is allowed to preserve. Labels mirror the toolbar
   * buttons in index.html; sections become <optgroup>s in the type picker.
   *
   * The split is load-bearing, not cosmetic: every 'vehicle' type is snapped to
   * a lane centre at placement while every 'vru' type is in ROAD_FACING_TYPES
   * (objectsCore.js) and placed freely, so a within-group swap can keep the existing
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
    // Landmark reference points from maps/special_buildings.csv, ALL towns at
    // once — the map draws only the rows whose `town` matches AppState.map.
    // Pure map reference data: never part of the scenario, so it is absent from
    // toJSON()/loadJSON(), from SCENARIO_KEYS (hence records no undo entry) and
    // from the export payload.
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
    // Background traffic (bgTraffic.js): SUMO cars CARLA replays as puppets.
    // A setting like weather/time — saved in toJSON()/loadJSON(), kept out of
    // undo — and only the settings: the trajectories are regenerated from
    // them and the scenario's paths, by the backend, deterministically.
    bgTraffic: { enabled: false, count: 30, seed: 1, clearance: 0.5, radius: 80 },

    // ── Editor interaction ─────────────────────────────────────
    selectedId: null, // id of selected actor/object
    selectedTrafficLightId: null, // id of selected map traffic light
    // The one path waypoint currently under the cursor's attention, shared by
    // the map (mapPaths.js) and the event card's waypoint list (eventPanelPaths.js)
    // so the two always agree on which point is which:
    //   { actorId, eventId, pathType: 'trajectory'|'route', index }
    // Editor-only state, so it records no undo entry (_isScenarioPatch).
    selectedWaypoint: null,
    activeTool: null, // selected toolbar tool, or null
    trajectoryMode: false, // true while drawing a path
    activeTrajectoryId: null, // actor id whose trajectory we're drawing
    routeMode: false, // true while drawing a route
    activeRouteId: null, // actor id whose route we're drawing
    activePathEventId: null, // event id whose action path/route we're drawing
    pendingTemplate: null, // scenario template to apply to the next placed actor
    pendingGenerate: null, // generator type key (or 'any') to build at the next map click
    // Recipe of the scenario the generator last built ({type, seed, near,
    // overrides, params, criticality, signature}) or null. Scenario state:
    // saved, and part of every undo snapshot, so undoing a rebuild restores
    // the recipe that built what is on screen.
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

    /**
     * The actor's single path-producing event (follow_trajectory or
     * assign_route with points), or null. eventPanel.js enforces at most one
     * such event per actor, so "the" path event is unambiguous — this is the
     * one place ego and NPCs share the same path storage: on the actor's
     * events, never on the actor itself.
     */
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
      // After the listeners: one of them can mutate further (objectsPaths.js
      // discards an incomplete path on a mode change), and the baseline has to
      // end up describing the state the user is actually looking at.
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
      const ev = (actor?.events || []).find((item) => item.id === sel.eventId);
      const action = ev?.action;
      if (!action) return null;
      const points = sel.pathType === 'route' ? action.waypoints : action.trajectory;
      return Array.isArray(points) ? points : null;
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
        const idx = this.staticObjects.filter((o) => o.prop === actor.prop).findIndex((o) => o.id === actor.id);
        return idx >= 0 ? `${name} ${idx + 1}` : name;
      }

      const type = String(actor.type || 'actor').toUpperCase();
      const index = this.npcs.filter((n) => n.type === actor.type).findIndex((n) => n.id === actor.id);
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
    weatherLabel(key) {
      return WEATHER_LABELS[key] || String(key || '');
    },

    /** German name for a time-of-day value, falling back to the value itself. */
    timeLabel(value) {
      return TIME_LABELS[value] || String(value || '');
    },

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

    /**
     * The vehicle archetype an actor is drawn, simulated and exported as. The
     * ego keeps `type: 'ego'` as its identity (dozens of checks key on it) and
     * carries its body in `vehicleType`, absent meaning 'car' — so every save
     * file from before the field existed loads as the car it always was.
     */
    bodyType(actor) {
      if (!actor) return 'car';
      return actor.type === 'ego' ? actor.vehicleType || 'car' : actor.type;
    },

    /**
     * Change the ego's vehicle type. Any type in the 'vehicle' group: the ego is
     * always a <Vehicle> under simple_vehicle_control, and every one of those
     * types is lane-snapped and routable, so the pose and every event stay
     * valid. One updateById, so it is one undo step.
     */
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
     * Disarm every in-progress placement / draw mode.
     *
     * Three callers need exactly this set cleared — Esc, the ruler toggle (which
     * passes its own `activeTool`) and pressing Play — and it was two verbatim
     * copies of an eight-key literal before the third arrived (nine keys now,
     * with `pendingGenerate`). Clearing the draw
     * flags is also what discards a path that never reached two waypoints
     * (objectsPaths.js `_discardIncompletePath` hangs off this change), so callers
     * that go on to read the actors must call this first.
     *
     * Records no undo entry: `_isScenarioPatch` does not count editor-only keys.
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
     * Back to an empty scenario on the current map — what a fresh map load
     * looks like: no ego, NPCs, props, signal Schaltungen or generator recipe.
     * Weather and time are a setting, not scenario content, and stay. One
     * undo step; the map-change path clears the history afterwards instead,
     * since undoing there would restore actors at the old town's coordinates.
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
        // Empty patch: the overview's "arrays changed" signal (properties.js).
        // selectionChanged redraws the actors and the signal heads on the map.
        this.set({});
        this.emit('selectionChanged', null);
      });
    },

    /** Restore editor state from scenario JSON. */
    loadJSON(data) {
      this.map = data.map || null;
      this.weather = data.weather ? { ...data.weather } : { ...this.weather };
      this.time = data.time || 'daytime';
      // A file from before the feature has no traffic: off, not "keep whatever
      // the editor had", or loading an old scenario would quietly add cars.
      this.bgTraffic = { enabled: false, count: 30, seed: 1, clearance: 0.5, radius: 80, ...(data.bgTraffic || {}) };
      this.ego = data.ego ? this._migrateEgoTrajectory(this._hydrateActor(data.ego)) : null;
      this.npcs = (data.npcs || []).map((n) => this._hydrateActor(n));
      this.staticObjects = data.staticObjects || [];
      this.trafficSignals = (data.trafficSignals || []).map((sig) => ({ ...sig, events: sig.events || [] }));
      this.generated = data.generated || null;

      // Advance the id counter past everything just loaded, otherwise the next
      // placed object reuses an id that already exists in the file.
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
