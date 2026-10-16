/**
 * properties.js — the selected object's panel: Spawnpunkt, dynamics, the type pickers,
 * delete, and the AppState subscriptions. The event section is EventPanel's.
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

  // True while render writes the fields, so their change handlers stand down.
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

    propsTitle.textContent = AppState.actorLabel(actor, { ego: 'Ego-Fahrzeug' });

    // A prop is a <MiscObject>: no speed, no events.
    const isScenarioActor = !AppState.isProp(actor);

    _syncing = true;
    propX.value = actor.x != null ? actor.x.toFixed(2) : '';
    propY.value = actor.y != null ? actor.y.toFixed(2) : '';
    propZ.value = actor.z != null ? actor.z.toFixed(2) : '0.20';
    propYaw.value = actor.yaw != null ? Math.round(actor.yaw) : '0';
    propInitSpeed.value = (actor.initial_speed ?? 0).toFixed(1);
    // Absent means on, in every layer.
    propObeyLights.checked = actor.obey_traffic_lights !== false;
    propObeyObstacles.checked = actor.obey_obstacles !== false;
    propMaxAccel.value = UIUtils.fmt(actor.max_acceleration ?? DEFAULT_MAX_ACCEL);
    propMaxDecel.value = UIUtils.fmt(actor.max_deceleration ?? DEFAULT_MAX_DECEL);
    _syncing = false;

    // Only simple_vehicle_control reads these; walkers do not.
    obeyRow.classList.toggle('hidden', !isScenarioActor || !ScenarioRules.honoursLaneOffset(actor.type));
    dynamicsRow.classList.toggle('hidden', !isScenarioActor || !ScenarioRules.honoursLaneOffset(actor.type));

    // A bare grid without row wrappers: label and input are hidden individually.
    propInitSpeed.classList.toggle('hidden', !isScenarioActor);
    propInitSpeedLabel.classList.toggle('hidden', !isScenarioActor);

    _renderActorTypeRow(actor);
    _renderPropTypeRow(actor);

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
    // Fall back to the object's own values: a hardcoded default would lift a prop off the road.
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
    // A typed X/Y moves the object, so z is re-derived; a typed Z survives until the next move.
    if (e?.target === propX || e?.target === propY) {
      patch.z = ObjectsManager.surfaceZFor(actor.type, patch.x, patch.y, actor.prop);
    }
    AppState.updateById(id, patch);
  }

  [propX, propY, propZ, propYaw].forEach((inp) => {
    inp.addEventListener('change', _onPosChange);
  });

  // Defaults when absent, as in every layer; floored at 0.1, since at 0 the speed never changes.
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

  // The way back to the surface height after a typed z. A button, not a live indicator:
  // deriving z scans every lane segment, and a drag re-renders this panel every frame.
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
    // The ego gets the vehicle group (its vehicleType): the hero is always a <Vehicle>.
    const isEgo = actor?.type === 'ego';
    const group = isEgo ? 'vehicle' : actor ? AppState.switchGroupFor(actor.type) : null;
    actorTypeRow.classList.toggle('hidden', !group);
    if (!group) return;

    // Rebuilt per render: the options depend on the actor's group.
    actorTypeSelect.innerHTML = '';
    const sections = AppState.ACTOR_TYPE_GROUPS.find((g) => g.id === group).sections;
    for (const section of sections) {
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
    // defaultZ is a surface offset, so the swap re-derives the height.
    const p = AppState.findById(id);
    AppState.updateById(id, {
      prop: next,
      z: ObjectsManager.surfaceZFor('prop', p.x, p.y, next),
    });
    MapView.renderAllActors();
    render();
  });

  // ── Start speed ──────────────────────────────────────────────────────────────

  // The Init SpeedAction: the speed on tick 1 until the first speed event; 0 emits nothing.
  propInitSpeed.addEventListener('change', () => {
    if (_syncing) return;
    const id = AppState.selectedId;
    if (!id) return;
    // Never negative: ScenarioRunner raises on a negative Init speed.
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
    // Strg/Cmd skips the confirm, as everywhere.
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

  // During a preview Tab must not reach a field either (capture phase); one focused before Play is released.
  const _panelEl = document.getElementById('properties-panel');
  _panelEl?.addEventListener(
    'focusin',
    (e) => {
      if (document.body.classList.contains('simulating')) e.target.blur?.();
    },
    true,
  );
  // Deferred: simulate.js loads after this file.
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
  // Ids restart at obj-1 in every file, so a stale locatedId would mark an unrelated row.
  AppState.on('stateLoaded', () => {
    scene.locatedId = null;
    render();
  });
  AppState.on('change', (patch) => {
    // The overview re-renders on an allow-list: map/mapData (it prints the town), and the empty
    // patch that announces an array changed in place (placing a prop selects nothing).
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
    // Draw mode changes which card is marked `active-draw`.
    if (AppState.selectedId && 'activePathEventId' in patch) {
      render();
    }
  });

  _bindCollapsibleHeaders(document);

  _renderOverviewPanel();
})();
