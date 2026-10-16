/**
 * properties.js — Right panel showing properties of the selected actor.
 *
 * Handles:
 *   - x/y/z/yaw numeric inputs
 *   - Delete button
 *
 * Events are identical for ego and NPCs — rendering the event section itself
 * (path drawing, action/trigger cards) is eventPanel.js's job, called
 * uniformly via EventPanel.render(actor).
 */
(() => {
  'use strict';

  const {
    propsOverview,
    propsContent,
    propsTitle,
    propsDelete,
    trafficSignalPanel,
    npcSection,
    scene,
    panel,
    _bindCollapsibleHeaders,
    _renderOverviewPanel,
    _renderTrafficSignalPanel,
  } = PropertiesCore.shared;

  const propX = document.getElementById('prop-x');
  const propY = document.getElementById('prop-y');
  const propZ = document.getElementById('prop-z');
  const propYaw = document.getElementById('prop-yaw');
  const propZAuto = document.getElementById('prop-z-auto');
  const propInitSpeed = document.getElementById('prop-init-speed');
  const propInitSpeedLabel = document.getElementById('prop-init-speed-label');
  const obeyRow = document.getElementById('obey-row');
  const propObeyLights = document.getElementById('prop-obey-lights');
  const propObeyObstacles = document.getElementById('prop-obey-obstacles');
  const dynamicsRow = document.getElementById('dynamics-row');
  const propMaxAccel = document.getElementById('prop-max-accel');
  const propMaxDecel = document.getElementById('prop-max-decel');

  // Track whether we're syncing to avoid loops
  let _syncing = false;
  function render() {
    const id = AppState.selectedId;
    const actor = id ? AppState.findById(id) : null;
    const trafficLightId = AppState.selectedTrafficLightId;
    const trafficLight = trafficLightId ? TrafficSignals.mapSignalById(trafficLightId) : null;

    if (trafficLight) {
      _renderTrafficSignalPanel(trafficLight);
      return;
    }

    if (!actor) {
      propsOverview.classList.remove('hidden');
      propsContent.classList.add('hidden');
      if (trafficSignalPanel) trafficSignalPanel.classList.add('hidden');
      _renderOverviewPanel();
      return;
    }

    propsOverview.classList.add('hidden');
    propsContent.classList.remove('hidden');
    if (trafficSignalPanel) trafficSignalPanel.classList.add('hidden');
    if (propsDelete) propsDelete.classList.remove('hidden');
    document.getElementById('spawn-panel')?.classList.remove('hidden');

    // Title
    propsTitle.textContent = AppState.actorLabel(actor, { ego: 'Ego-Fahrzeug' });

    // The ego is a scenario actor with the entity name 'hero', not a special
    // case; a prop is a <MiscObject> and has no speed or events at all.
    const isScenarioActor = !AppState.isProp(actor);

    // Position / yaw / start speed
    _syncing = true;
    propX.value = actor.x != null ? actor.x.toFixed(2) : '';
    propY.value = actor.y != null ? actor.y.toFixed(2) : '';
    propZ.value = actor.z != null ? actor.z.toFixed(2) : '0.20';
    propYaw.value = actor.yaw != null ? Math.round(actor.yaw) : '0';
    propInitSpeed.value = (actor.initial_speed ?? 0).toFixed(1);
    // Absent means on, in every layer — the value every vehicle was exported
    // with before the toggles existed.
    propObeyLights.checked = actor.obey_traffic_lights !== false;
    propObeyObstacles.checked = actor.obey_obstacles !== false;
    propMaxAccel.value = UIUtils.fmt(actor.max_acceleration ?? DEFAULT_MAX_ACCEL);
    propMaxDecel.value = UIUtils.fmt(actor.max_deceleration ?? DEFAULT_MAX_DECEL);
    _syncing = false;

    // Only simple_vehicle_control reads these; a walker is on
    // PedestrianControl, which reads neither. Same split as lane_offset.
    obeyRow.classList.toggle('hidden', !isScenarioActor || !ScenarioRules.honoursLaneOffset(actor.type));
    dynamicsRow.classList.toggle('hidden', !isScenarioActor || !ScenarioRules.honoursLaneOffset(actor.type));

    // .props-group is a bare 2-column grid with no per-row wrapper, so the
    // label and the input have to be hidden individually.
    propInitSpeed.classList.toggle('hidden', !isScenarioActor);
    propInitSpeedLabel.classList.toggle('hidden', !isScenarioActor);

    // Type pickers — swap an actor's type / a prop's blueprint in place
    _renderActorTypeRow(actor);
    _renderPropTypeRow(actor);

    // Events: identical for ego and NPCs.
    npcSection.classList.toggle('hidden', !isScenarioActor);

    if (isScenarioActor) {
      EventPanel.render(actor);
    }
  }

  // ── Input → state bindings ───────────────────────────────────────────────────

  function _onPosChange(e) {
    if (_syncing) return;
    const id = AppState.selectedId;
    if (!id) return;
    const actor = AppState.findById(id);
    if (!actor) return;
    // Fall back to the object's own values, not literals: a prop's correct z is
    // often 0.0, and a hardcoded 0.2 default would silently lift it off the road.
    const num = (raw, fallback) => {
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n : fallback;
    };
    const patch = {
      x: num(propX.value, actor.x ?? 0),
      y: num(propY.value, actor.y ?? 0),
      z: num(propZ.value, actor.z ?? 0),
      yaw: num(propYaw.value, actor.yaw ?? 0),
    };
    // Typing a new X/Y moves the object, so its height is re-derived exactly as
    // it would be by a drag. Keyed on which input fired so this never fights a
    // user typing into the Z box itself — a hand-set z survives until the object
    // is next moved.
    if (e?.target === propX || e?.target === propY) {
      patch.z = ObjectsManager.surfaceZFor(actor.type, patch.x, patch.y, actor.prop);
    }
    AppState.updateById(id, patch);
  }

  [propX, propY, propZ, propYaw].forEach((inp) => {
    inp.addEventListener('change', _onPosChange);
  });

  // simple_vehicle_control's rate limits. Absent = these defaults in every
  // layer (scenario_io._DYNAMICS_DEFAULTS, xml_builder._DYNAMICS_DEFAULTS,
  // simulate.js), the values every vehicle was exported with before the fields
  // existed. Floored at 0.1: at 0 the speed could never change.
  const DEFAULT_MAX_ACCEL = 3.0;
  const DEFAULT_MAX_DECEL = 10.0;
  [
    [propMaxAccel, 'max_acceleration'],
    [propMaxDecel, 'max_deceleration'],
  ].forEach(([input, key]) => {
    input.addEventListener('change', () => {
      if (_syncing) return;
      const id = AppState.selectedId;
      if (!id || !AppState.findById(id)) return;
      const parsed = parseFloat(input.value);
      const fallback = key === 'max_acceleration' ? DEFAULT_MAX_ACCEL : DEFAULT_MAX_DECEL;
      const val = Math.max(0.1, Math.min(50, Number.isFinite(parsed) ? parsed : fallback));
      input.value = UIUtils.fmt(val);
      AppState.updateById(id, { [key]: val });
    });
  });

  [
    [propObeyLights, 'obey_traffic_lights'],
    [propObeyObstacles, 'obey_obstacles'],
  ].forEach(([box, key]) => {
    box.addEventListener('change', () => {
      if (_syncing) return;
      const id = AppState.selectedId;
      if (!id || !AppState.findById(id)) return;
      AppState.updateById(id, { [key]: box.checked });
    });
  });

  // z is normally derived from the elevation profile on every move, so a
  // hand-typed value is sticky until the object is next moved — with no way
  // back to the surface height short of nudging it. This is that way back.
  // It is a button rather than an always-on indicator on purpose: the derived
  // value comes from _nearestLaneProjection, a linear scan over every lane
  // segment, and a drag re-renders this panel on every mousemove.
  propZAuto?.addEventListener('click', () => {
    const id = AppState.selectedId;
    if (!id) return;
    const actor = AppState.findById(id);
    if (!actor) return;
    AppState.updateById(id, {
      z: ObjectsManager.surfaceZFor(actor.type, actor.x, actor.y, actor.prop),
    });
  });

  // ── Actor type ───────────────────────────────────────────────────────────────

  const actorTypeRow = document.getElementById('actor-type-row');
  const actorTypeSelect = document.getElementById('actor-type-select');

  function _renderActorTypeRow(actor) {
    if (!actorTypeRow || !actorTypeSelect) return;
    // The ego is offered the vehicle group (its vehicleType); a walker or bike
    // ego is not a thing the hero <Vehicle> under simple_vehicle_control can be.
    const isEgo = actor?.type === 'ego';
    const group = isEgo ? 'vehicle' : actor ? AppState.switchGroupFor(actor.type) : null;
    actorTypeRow.classList.toggle('hidden', !group);
    if (!group) return;

    // Rebuilt per render, not once like the prop select: the option set depends
    // on which group the selected actor is in.
    actorTypeSelect.innerHTML = '';
    const sections = AppState.ACTOR_TYPE_GROUPS.find((g) => g.id === group).sections;
    for (const section of sections) {
      // A single-section group needs no optgroup heading.
      const parent =
        sections.length > 1 ? actorTypeSelect.appendChild(document.createElement('optgroup')) : actorTypeSelect;
      if (parent !== actorTypeSelect) parent.label = section.label;
      for (const { type, label } of section.types) {
        const opt = document.createElement('option');
        opt.value = type;
        opt.textContent = label;
        parent.appendChild(opt);
      }
    }
    _syncing = true;
    actorTypeSelect.value = AppState.bodyType(actor);
    _syncing = false;
  }

  actorTypeSelect?.addEventListener('change', () => {
    if (_syncing) return;
    const id = AppState.selectedId;
    if (!id) return;
    // switchActorType re-checks the group itself and is a no-op if not allowed.
    const ok =
      AppState.ego?.id === id
        ? AppState.setEgoVehicleType(actorTypeSelect.value)
        : AppState.switchActorType(id, actorTypeSelect.value);
    if (!ok) {
      render(); // resync the select back to the actor's unchanged type
      return;
    }
    MapView.renderAllActors();
    render();
  });

  // ── Prop type ────────────────────────────────────────────────────────────────

  const propTypeRow = document.getElementById('prop-type-row');
  const propTypeSelect = document.getElementById('prop-type-select');

  function _renderPropTypeRow(actor) {
    if (!propTypeRow || !propTypeSelect) return;
    const isProp = AppState.isProp(actor);
    propTypeRow.classList.toggle('hidden', !isProp);
    if (!isProp || !window.PropCatalog) return;

    if (!propTypeSelect.options.length) {
      for (const group of PropCatalog.GROUPS) {
        const ids = PropCatalog.ids().filter((id) => PropCatalog.get(id).group === group.id);
        if (!ids.length) continue;
        const og = document.createElement('optgroup');
        og.label = group.label;
        for (const id of ids) {
          const opt = document.createElement('option');
          opt.value = id;
          opt.textContent = PropCatalog.label(id);
          og.appendChild(opt);
        }
        propTypeSelect.appendChild(og);
      }
    }
    _syncing = true;
    propTypeSelect.value = actor.prop || '';
    _syncing = false;
  }

  propTypeSelect?.addEventListener('change', () => {
    if (_syncing) return;
    const id = AppState.selectedId;
    if (!id || !AppState.isProp(id)) return;
    const next = propTypeSelect.value;
    if (!window.PropCatalog?.get(next)) return;
    // defaultZ is an offset from the road surface, so the swap re-derives the
    // absolute height rather than dropping the prop to the catalogue value.
    const p = AppState.findById(id);
    AppState.updateById(id, {
      prop: next,
      z: ObjectsManager.surfaceZFor('prop', p.x, p.y, next),
    });
    MapView.renderAllActors();
    render();
  });

  // ── Start speed ──────────────────────────────────────────────────────────────

  // Emitted as a SpeedAction in the Storyboard Init, so it is the actor's speed
  // on tick 1 — before any Act's SimulationTime>0 start trigger. The first
  // set_speed / follow_trajectory event to fire overwrites it. An actor with
  // events: [] gets no Act at all, so for it this is the only speed it ever
  // has: 0 emits nothing and leaves it parked.
  propInitSpeed.addEventListener('change', () => {
    if (_syncing) return;
    const id = AppState.selectedId;
    if (!id) return;
    // Floor at 0 rather than allowing a negative: ScenarioRunner's
    // _get_actor_speed raises on a negative AbsoluteTargetSpeed in Init.
    const val = Math.max(0, Math.min(100, parseFloat(propInitSpeed.value) || 0));
    propInitSpeed.value = val.toFixed(1);
    AppState.updateById(id, { initial_speed: val });
  });

  // ── Delete ──────────────────────────────────────────────────────────────────

  propsDelete.addEventListener('click', async (e) => {
    const id = AppState.selectedId;
    if (!id) return;
    const actor = AppState.findById(id);
    if (!actor) return;
    const label = AppState.actorLabel(actor, { ego: 'Ego-Fahrzeug' });
    // Strg (Cmd on a Mac) skips the confirm here exactly as it does on the scene
    // list's trashes \u2014 one modifier, one meaning, everywhere a delete is guarded.
    const ok = e.ctrlKey || e.metaKey || (await Confirm.show(`${label} l\u00f6schen?`, 'L\u00f6schen'));
    if (!ok) return;
    AppState.removeById(id);
    MapView.renderAllActors();
    render();
    Toast.info(`${label} gel\u00f6scht \u2014 Strg+Z zum R\u00fcckg\u00e4ngigmachen`);
  });

  EventPanel.setRefreshHandler(render);
  panel.render = render;

  // ── Listen for state changes ─────────────────────────────────────────────────

  // A preview is view-only (body.simulating; the CSS takes the pointer away):
  // Tab must not reach a field either. Capture phase, so nothing in the
  // panel ever sees the focus. A field focused before Play is let go on the
  // first frame.
  const _panelEl = document.getElementById('properties-panel');
  _panelEl?.addEventListener(
    'focusin',
    (e) => {
      if (document.body.classList.contains('simulating')) e.target.blur?.();
    },
    true,
  );
  // simulate.js loads after this file, hence the deferred subscription.
  document.addEventListener('DOMContentLoaded', () => {
    Simulate.onTime((t) => {
      if (t != null && _panelEl?.contains(document.activeElement)) document.activeElement.blur();
    });
  });

  AppState.on('selectionChanged', () => render());
  AppState.on('trafficSignalSelected', () => render());
  AppState.on('trafficSignalUpdated', () => render());
  AppState.on('actorUpdated', (id) => {
    if (id === AppState.selectedId) render();
    else if (!AppState.selectedId) _renderOverviewPanel();
  });
  AppState.on('actorRemoved', (id) => {
    if (scene.locatedId === id) scene.locatedId = null;
    render();
  });
  // Ids restart at obj-1 in every save file, so a stale scene.locatedId would mark
  // some unrelated actor's row in the newly loaded scenario.
  AppState.on('stateLoaded', () => {
    scene.locatedId = null;
    render();
  });
  AppState.on('change', (patch) => {
    // 'map'/'mapData' are in here because the summary prints the town name and
    // used to sit on "Karte: None" from load until some unrelated event forced
    // a render — which read as intermittent rather than broken.
    //
    // An EMPTY patch is the codebase's signal that one of the state arrays was
    // mutated in place (`AppState.npcs = [...]; AppState.set({})`). It has to be
    // in here for the scene list: placing a prop is the one placement that does
    // not select what it placed, so the overview stays on screen and would
    // otherwise keep showing the pre-placement counts.
    const sceneChanged = Object.keys(patch).length === 0;
    if (
      !AppState.selectedId &&
      (sceneChanged ||
        'weather' in patch ||
        'time' in patch ||
        'map' in patch ||
        'mapData' in patch ||
        'generated' in patch ||
        'userTemplates' in patch)
    ) {
      _renderOverviewPanel();
    }
    // Entering or leaving draw mode changes which event card is marked as the
    // one the map clicks belong to (eventPanelCards.js `active-draw`).
    if (AppState.selectedId && 'activePathEventId' in patch) {
      render();
    }
  });

  _bindCollapsibleHeaders(document);

  // Render initial summary on load
  _renderOverviewPanel();
})();
