/**
 * simulate.js — In-editor preview simulation.
 *
 * A per-tick kinematic model of what ScenarioRunner will actually do, not an
 * idealisation of what the author drew. Every actor (ego included) is driven
 * by the same real controllers this scenario exports to
 * (SimpleVehicleControl / PedestrianControl, both in
 * ../../scenario_runner/srunner/scenariomanager/actorcontrols/): they bypass
 * CARLA's vehicle physics entirely and write a target velocity straight onto
 * the actor. A walker's speed is therefore exactly what was commanded; a
 * vehicle's is the commanded speed after SimpleVehicleControl's own per-tick
 * max_acceleration / max_deceleration clamp (_applyControllerLimits) — both
 * are exactly reproducible here, not approximations. The genuinely
 * unknowable part is road-network topology CARLA's map builder resolves
 * internally (which successor lane a fork-following actor picks, the A*
 * route a `assign_route` action actually drives): this preview does not have
 * that data, so it stops and badges rather than guessing a path it cannot
 * justify. See the "In-editor preview fidelity" plan for the full analysis.
 *
 * All 7 real event triggers (simulation_time, distance_to_ego,
 * distance_to_point, ego_speed, relative_speed, after_event, event_started)
 * are evaluated, including the two rewrites
 * the backend applies at export time (assign_route forces its own trigger to
 * simulation_time@0; an after_event chained onto a dropped/assign_route
 * event never fires) — mirrored here so the preview matches the .xosc that
 * export would actually produce, not the raw authored event.
 *
 * lane_offset IS simulated: the actor's path-following maths keeps running on
 * the driven centreline and the offset is added when the pose is written back
 * (_pose), which is what SimpleVehicleControl does — it displaces the waypoint
 * it aims at and never touches its waypoint list. The atomic's supersede rules
 * are mirrored exactly, because they decide whether the offset survives the
 * next action (_supersedeLaneOffset).
 *
 * set_distance is deliberately NOT simulated (badge only) — its real
 * semantics (a 100 m/s speed spike, then a gap measured in OpenDRIVE `s` or a
 * planned route length) need the same road graph `assign_route` does, and
 * the action may not see real use; simulating it is deferred until it does.
 */
(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ── Playback state ───────────────────────────────────────────────────────────

  let _running    = false;
  let _paused     = false;
  let _simTime    = 0;       // seconds elapsed in simulation (the stepping clock)
  let _lastFrame  = 0;       // timestamp of last rAF
  let _animId     = null;
  let _speed      = 1.0;     // playback speed multiplier

  let _egoId      = null;
  let _originals  = new Map();  // actorId → {x, y, z, yaw}, to restore on stop
  let _simActors  = new Map();  // actorId → sim actor record (see _makeSimActor)
  let _tickSpeeds = new Map();  // actorId → speed, snapshotted once per tick
  let _tickPoses  = new Map();  // actorId → {x, y, z}, snapshotted with it
  // `actorId::eventId` → completedAt, snapshotted once per tick. Same reasoning
  // as _tickSpeeds: a cross-actor after_event that read another actor's live
  // fired-map would resolve differently depending on which actor _stepActor
  // reached first, and CARLA's own blackboard reads are not ordered either.
  // A SAME-actor reference still reads sim.fired live — that is one behaviour
  // tree ticking its own events and has no ordering ambiguity to remove.
  let _tickCompleted = new Map();
  // `actorId::eventId` → firedAt, the event_started counterpart of the above.
  let _tickStarted = new Map();
  let _layerSimBadges = null;   // our own SVG layer, appended into #world

  // ── Tunables mirroring the real controllers ─────────────────────────────────
  // simple_vehicle_control.py / pedestrian_control.py / atomic_behaviors.py —
  // see file header. Kept as named constants rather than inline literals
  // because each one is a specific, cited real-world value, not a preview
  // choice.

  const DISTANCE_TO_EGO_FALLBACK_S = 60.0;  // event_builders.py fallback_time
  const ACT_TEARDOWN_DISTANCE_M = 500.0;    // every Act's StopTrigger
  const VEHICLE_WAYPOINT_ACCEPT_M = 4.0;    // SimpleVehicleControl explicit-waypoint advance
  const VRU_WAYPOINT_ACCEPT_M = 1.0;        // PedestrianControl advance
  const LEADING_WAYPOINT_DROP_M = 0.5;      // both controllers, on activation
  const LANE_CHANGE_SAME_LANE_M = 5.0;      // _distance_same_lane constant
  const LANE_CHANGE_OTHER_LANE_M = 10.0;    // distance_other_lane, hardcoded in the parser call
  const LANE_NEIGHBOR_MIN_M = 1.5;          // plausible adjacent-lane lateral offset band
  const LANE_NEIGHBOR_MAX_M = 6.5;
  const LANE_NEIGHBOR_DIR_TOLERANCE_DEG = 45; // "same direction of travel" tolerance
  const LANE_SEARCH_MAX_DIST_M = 15;          // how far to reach for a lane anchor

  // ChangeActorWaypoints.initialise, as patched in the install run.sh runs
  // (/home/dellpro2/Antonio/scenario_runner — see CLAUDE.md, Verification;
  // the yungloon checkout carries the same filter but is run by nothing). These govern which of
  // the router's points survive into the actor's waypoint list.
  const ROUTE_SEED_AHEAD_M = 1.0;             // ego_waypoint.next(1)[0]
  const ROUTE_DEDUP_MIN_M = 1.0;              // drop a point closer than this to the last kept one
  const ROUTE_SHORT_REF_M = 0.5;              // reference vector too short to give a heading
  const ROUTE_HEADING_ACCEPT_LO = 2.0;        // accept when |delta| < LO ...
  const ROUTE_HEADING_ACCEPT_HI = 4.3;        // ... or > HI; the band between is a reversal

  // Which actor types AssignRouteAction accepts — mirrors _ROUTE_ACTION_TYPES in
  // ../llm-scenario-gen/generator/event_builders.py. Shared with eventPanel.js
  // (which greys the action out) and the export gate via app.js.
  const ROUTE_ACTION_TYPES = ScenarioRules.ROUTE_ACTION_TYPES;

  // ── Controls (created dynamically) ─────────────────────────────────────────

  // Two rows in a fixed-width card: transport, tempo and the two preview
  // toggles on top (eventTimeline.js appends „Ablauf" to .sim-row-top); the
  // scrub bar and the time underneath, so the bar gets the whole width.
  // Play/Pause/Stop are icon-only; their state („Abspielen" / „Fortsetzen" /
  // „Nochmal") is in the title and in the visually hidden #sim-play-text.
  const controlsHtml = `
    <div id="sim-controls" class="sim-controls hidden">
      <div class="sim-row sim-row-top">
        <button id="sim-play"  class="btn btn-small btn-primary sim-icon-btn" title="Abspielen (Leertaste)" aria-label="Abspielen"><svg class="ic-play" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1l7 4-7 4z"/></svg><svg class="ic-replay" viewBox="0 0 10 10" aria-hidden="true"><path d="M8.3 5.2A3.3 3.3 0 1 1 5 1.9" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4.4 0l2.8 1.9-2.8 1.9z"/></svg><span id="sim-play-text" class="sr-only">Abspielen</span></button>
        <button id="sim-pause" class="btn btn-small btn-secondary sim-icon-btn hidden" title="Anhalten (Leertaste)" aria-label="Pause"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1h2.2v8H2zM5.8 1H8v8H5.8z"/></svg></button>
        <button id="sim-stop"  class="btn btn-small btn-danger sim-icon-btn sim-idle" title="Stopp: Vorschau beenden und zurücksetzen (Esc)" aria-label="Stopp"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5h7v7h-7z"/></svg></button>
        <span class="sim-sep" aria-hidden="true"></span>
        <input  id="sim-speed" type="range" min="0.25" max="4" step="0.25" value="1" title="Tempo (Abspielgeschwindigkeit)" aria-label="Tempo">
        <span   id="sim-speed-label" class="sim-speed-label" title="Tempo">1×</span>
        <span class="sim-row-spacer"></span>
        <button id="sim-ego-react" type="button" class="btn btn-small btn-secondary sim-toggle" aria-pressed="false"
                title="Aus: das Ego reagiert nicht. Ein: es bremst für alles in seinem Fahrweg — zeigt, ob der Konflikt vermeidbar ist">Ego bremst</button>
        <a class="help-link" href="/static/help.html#vorschau" target="_blank" rel="noopener" title="Handbuch: Vorschau" aria-label="Handbuch: Vorschau">?</a>
      </div>
      <div class="sim-row sim-row-timeline">
        <div    id="sim-progress-bar" class="sim-progress-bar" role="slider" tabindex="-1" aria-label="Zeitleiste" aria-valuemin="0" title="Klicken zum Springen — startet die Vorschau angehalten"><div id="sim-progress-fill" class="sim-progress-fill"></div></div>
        <span   id="sim-time-label"  class="sim-time-label" title="Simulierte Zeit / Gesamtdauer">0.0 s</span>
      </div>
    </div>`;

  // Float over the map's lower edge rather than sitting in the header: these
  // are the controls in constant use during a preview, and they belong next to
  // what they animate. #map-bottom-stack keeps them clear of the draw banner.
  const bottomStack = document.getElementById('map-bottom-stack');
  bottomStack.insertAdjacentHTML('beforeend', controlsHtml);

  const simControls  = document.getElementById('sim-controls');
  const btnPlay      = document.getElementById('sim-play');
  const playText     = document.getElementById('sim-play-text');
  const btnPause     = document.getElementById('sim-pause');
  /** The play button is icon-only: its state lives in the hidden text, the
   * tooltip and the accessible name; „Nochmal" swaps in the replay icon. */
  function _setPlayLabel(text) {
    playText.textContent = text;
    btnPlay.title = `${text} (Leertaste)`;
    btnPlay.setAttribute('aria-label', text);
    btnPlay.classList.toggle('replay', text === 'Nochmal');
  }
  const btnStop      = document.getElementById('sim-stop');
  const speedSlider  = document.getElementById('sim-speed');
  const speedLabel   = document.getElementById('sim-speed-label');
  const btnReact     = document.getElementById('sim-ego-react');
  // Flipping it re-simulates the run: stop, then reopen at the same time,
  // playing again if it was.
  btnReact.addEventListener('click', () => {
    const was = _running, paused = _paused, t = _viewTime;
    if (was) _stopSimulation();
    _reactiveEgo = !_reactiveEgo;
    btnReact.setAttribute('aria-pressed', String(_reactiveEgo));
    btnReact.classList.toggle('active', _reactiveEgo);
    if (was) { _seek(t); if (!paused) _startSimulation(); }
  });
  const timeLabel    = document.getElementById('sim-time-label');
  const progressFill = document.getElementById('sim-progress-fill');
  const progressBar  = document.getElementById('sim-progress-bar');

  // Show controls once a map is loaded
  AppState.on('change', patch => {
    if ('mapData' in patch && AppState.mapData) {
      simControls.classList.remove('hidden');
    }
  });

  // ── Small geometry helpers ───────────────────────────────────────────────────

  function _dist3(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
  }

  /**
   * Where the actor actually IS, as opposed to where its path-following maths
   * is: `sim.x`/`sim.y` stay on the driven centreline and a lane offset is
   * added here.
   *
   * The split is not tidiness. SimpleVehicleControl offsets the waypoint it
   * AIMS at (`_offset_waypoint`) and leaves its waypoint list alone, and
   * `_walkDirLine` walks from the position it is handed toward the next
   * centreline point — so storing the displaced position back into sim.x/y
   * would make the actor converge back onto the centreline over the next few
   * ticks and quietly eat the offset.
   *
   * Right of travel is positive, matching `transform.get_right_vector()`: the
   * editor's frame IS CARLA's (the single Y flip happens in the .xodr parser),
   * so forward is (cos yaw, sin yaw) and right is (−sin yaw, cos yaw).
   */
  function _pose(sim) {
    if (!sim || !sim.laneOffset) return sim;
    const rad = (sim.yaw || 0) * Math.PI / 180;
    return {
      x: sim.x - sim.laneOffset * Math.sin(rad),
      y: sim.y + sim.laneOffset * Math.cos(rad),
      z: sim.z,
    };
  }

  function _angleDiffDeg(a, b) {
    return Math.abs(((a - b + 180) % 360 + 360) % 360 - 180);
  }

  /**
   * Advance up to `step` metres of arc length along `dirLine`, starting from
   * point (x, y, z) aiming at dirLine[startIdx]. Mirrors how both real
   * controllers aim at the next map/route waypoint from wherever the actor
   * currently is, not from the exact point on the line.
   */
  function _walkDirLine(dirLine, x, y, z, startIdx, step) {
    let idx = startIdx;
    let cx = x, cy = y, cz = z, yaw = null;
    let remaining = step;
    while (remaining > 1e-9 && idx < dirLine.length) {
      const [tx, ty, tz = 0] = dirLine[idx];
      const dx = tx - cx, dy = ty - cy;
      const dist = Math.hypot(dx, dy);
      if (dist < 1e-6) { idx += 1; continue; }
      const seg = Math.min(remaining, dist);
      const frac = seg / dist;
      cx += dx * frac; cy += dy * frac; cz += (tz - cz) * frac;
      yaw = Math.atan2(dy, dx) * 180 / Math.PI;
      remaining -= seg;
      if (seg >= dist - 1e-9) idx += 1;
    }
    return {
      x: cx, y: cy, z: cz, yaw, idx,
      consumed: step - remaining, // actual arc length walked, short of `step` if the line ran out
      ranOut: idx >= dirLine.length && remaining > 1e-9,
    };
  }

  // ── Event normalisation mirror (backend/scenario_io.py) ─────────────────────
  //
  // simulate.js reads AppState's raw, unexported events — but three rewrites
  // happen only at export time and change WHICH TRIGGER GOVERNS AN EVENT, so a
  // preview that skips them predicts a different scenario than export
  // produces. Order matters and matches _normalize_actor exactly: per-event
  // coercion (incl. assign_route forcing its own trigger), then the
  // after_event→assign_route rewrite, then — LAST, so it also catches the
  // just-rewritten case — the ego self-distance rewrite.

  const TRIGGER_TYPES = new Set(['simulation_time', 'distance_to_ego', 'distance_to_point',
                                 'ego_speed', 'relative_speed', 'after_event', 'event_started']);

  // SimpleVehicleControl's rate limits when the actor states none — the same
  // defaults the emitter writes (xml_builder._DYNAMICS_DEFAULTS).
  const DEFAULT_MAX_ACCEL = 3.0;
  const DEFAULT_MAX_DECEL = 10.0;
  // "If the tmp_speed is < 0.5 the vehicle may not properly accelerate" — the
  // controller bumps a positive command to at least this.
  const SVC_MIN_PULL_AWAY = 0.5;
  // ChangeActorLaneOffset.OFFSET_THRESHOLD: a non-continuous offset is reached
  // within this many metres.
  const LANE_OFFSET_THRESHOLD_M = 0.1;
  // How fast the displaced aim point pulls the actor sideways. Measured in CARLA
  // (Town04 road 40, 8 m/s, 1.75 m, tests/run_actions_ext_carla.py): the
  // remaining lateral gap decays exponentially with distance driven — it halves
  // every ~2 m, out and back alike — because SimpleVehicleControl steers
  // straight at a waypoint a few metres ahead. So the gap shrinks by
  // 1 − exp(−d / L) per d metres, with this L.
  const LANE_OFFSET_APPROACH_M = 3.0;
  const ACTION_TYPES  = new Set(['follow_trajectory', 'assign_route', 'set_speed',
                                 'set_distance', 'lane_change', 'lane_offset']);

  // The emitter's own "does this action produce XML" rule, shared with the
  // panel's warning chips and the export gate (ScenarioRules, app.js).
  const _actionEmits = (action, actorType) => ScenarioRules.actionEmits(action, actorType);

  function _normalizeEventsForSim(actor) {
    const events = JSON.parse(JSON.stringify(actor.events || []));
    const isEgo = actor.type === 'ego';

    for (const ev of events) {
      const trigger = (ev.trigger && typeof ev.trigger === 'object') ? ev.trigger : {};
      if (!TRIGGER_TYPES.has(trigger.type)) trigger.type = 'simulation_time';
      ev.trigger = trigger;
      const action = (ev.action && typeof ev.action === 'object') ? ev.action : {};
      if (!ACTION_TYPES.has(action.type)) action.type = 'follow_trajectory';
      ev.action = action;
      if (action.type === 'assign_route') ev.trigger = { type: 'simulation_time', value: 0 };
    }

    // Scenario-wide, exactly like _normalize_after_event_chains: an after_event
    // may name an event on ANOTHER actor, so "does the target assign a route"
    // cannot be answered from this actor's own list.
    for (const ev of events) {
      if (!ScenarioRules.isEventRef(ev.trigger)) continue;
      const target = ScenarioRules.afterEventTarget(actor, ev.trigger);
      if (target && (target.event.action || {}).type === 'assign_route') {
        ev.trigger = { type: 'distance_to_ego', value: 400 };
      }
    }

    if (isEgo) {
      for (const ev of events) {
        if (ev.trigger.type === 'distance_to_ego' &&
            (!ev.trigger.entity_ref || ev.trigger.entity_ref === actor.id)) {
          ev.trigger = { type: 'simulation_time', value: 0 };
        }
      }
    }

    // Not a backend rewrite: an after_event pointing at an action that never
    // reaches the .xosc (a <2-point path, or a route on a non-routable type)
    // can never fire there either — the KNOWN defect in
    // build_custom_event_chain (see CLAUDE.md / test_events_e2e.py). Flagging
    // it here rather than pretending the chain proceeds. A cycle is the same
    // thing arrived at differently: nothing on it ever completes, so nothing on
    // it ever fires. The export gate refuses both, so this only ever sees them
    // in a loaded save file — which is exactly when a preview is what you reach
    // for.
    for (const ev of events) {
      if (!ScenarioRules.isEventRef(ev.trigger)) continue;
      const target = ScenarioRules.afterEventTarget(actor, ev.trigger);
      // A lane_offset target is refused by the export gate for after_event (it
      // never ends on its own) — event_started may name one, its start is
      // well defined. An NPC waiting on an ego event is refused outright
      // (ScenarioRules.mayWaitOnActor). In neither case does the preview
      // pretend the chain can proceed.
      if (!target || !_actionEmits(target.event.action, target.actor.type) ||
          (ev.trigger.type === 'after_event' &&
           ScenarioRules.neverCompletes(target.event.action)) ||
          !ScenarioRules.mayWaitOnActor(actor, target.actor) ||
          ScenarioRules.afterEventCycles(actor, ev)) {
        ev.trigger.neverFires = true;
      } else if (target.actor.id !== actor.id) {
        ev.trigger.watchActorId = target.actor.id;
      }
    }

    return events;
  }

  // ── Trigger evaluation ───────────────────────────────────────────────────────

  function _resolveSimRef(id) {
    return id ? _simActors.get(id) || null : null;
  }

  /** The reference actor's speed as ChangeActorTargetSpeed sees it.
   * CarlaDataProvider.get_velocity reads a velocity map refilled once per world
   * tick, so every atomic in one tick reads the same value whatever the
   * behaviour-tree order — hence the snapshot rather than sim.speed live — and
   * an actor missing from it yields 0.0 (a printed warning, never a raise). */
  function _refSpeed(id) {
    const ref = id || _egoId;  // an omitted entity_ref exports as `hero`
    return _tickSpeeds.has(ref) ? _tickSpeeds.get(ref) : 0;
  }

  /** True the first tick the trigger's condition holds. Level-sensitive, like
   * every real OpenSCENARIO condition (conditionEdge is never read). */
  function _triggerSatisfied(trigger, sim, egoPrevPos, simTime) {
    switch (trigger.type) {
      case 'simulation_time':
        return simTime > (trigger.value ?? 0);
      case 'distance_to_ego': {
        // Both the real distance predicate AND the mandatory 60s OR-fallback
        // (event_builders.py) — a distance_to_ego trigger fires past t=60s
        // regardless of geometry, and a preview that skips this diverges in
        // any scenario that runs that long.
        if (simTime > DISTANCE_TO_EGO_FALLBACK_S) return true;
        // „Abstand zu Akteur": another actor than the ego is read from the
        // per-tick pose snapshot, exactly as the ego is.
        const other = trigger.entity_ref && trigger.entity_ref !== _egoId
          ? _tickPoses.get(trigger.entity_ref) : egoPrevPos;
        if (!other) return false;
        return _dist3(_pose(sim), other) < (trigger.value ?? 400);
      }
      case 'relative_speed': {
        // RelativeVelocityToOtherActor: speed(other) − speed(this), both the
        // magnitudes CarlaDataProvider reports — hence the snapshot.
        const diff = _refSpeed(trigger.entity_ref) - (_tickSpeeds.get(sim.id) ?? 0);
        const limit = trigger.value ?? 0;
        return trigger.rule === 'lessThan' ? diff < limit : diff > limit;
      }
      case 'distance_to_point': {
        const point = trigger.point;
        if (!point) return false;
        // The triggering entity is whoever entity_ref names (default hero) —
        // NOT necessarily the actor that owns this event.
        const triggerActor = _resolveSimRef(trigger.entity_ref) || _simActors.get(_egoId) || sim;
        return _dist3(_pose(triggerActor), { x: point.x, y: point.y, z: point.z ?? 0.2 }) < (trigger.value ?? 20);
      }
      case 'after_event': {
        if (trigger.neverFires) return false;
        // watchActorId is set by _normalizeEventsForSim only when the reference
        // leaves this actor. ScenarioRunner resolves storyboardElementRef
        // through a global blackboard, so which Act owns the event is
        // irrelevant there — but here the completion record lives on the other
        // sim actor, and is read from the tick snapshot rather than live.
        if (trigger.watchActorId) {
          const completedAt = _tickCompleted.get(`${trigger.watchActorId}::${trigger.event_id}`);
          return completedAt != null && completedAt <= simTime;
        }
        const rec = sim.fired.get(trigger.event_id);
        return !!rec && rec.completedAt != null && rec.completedAt <= simTime;
      }
      case 'event_started': {
        // startTransition: ScenarioRunner writes '(EVENT)<name>-START' when the
        // event's actions initialise, i.e. on the tick its own trigger fires.
        if (trigger.neverFires) return false;
        if (trigger.watchActorId) {
          const firedAt = _tickStarted.get(`${trigger.watchActorId}::${trigger.event_id}`);
          return firedAt != null && firedAt <= simTime;
        }
        const rec = sim.fired.get(trigger.event_id);
        return !!rec && rec.firedAt <= simTime;
      }
      case 'ego_speed': {
        // TriggerVelocity on hero: CarlaDataProvider's per-tick velocity map,
        // hence the snapshot. No ego → 0, like get_velocity's own fallback.
        const v = _tickSpeeds.get(_egoId) ?? 0;
        const limit = trigger.value ?? 10;
        return trigger.rule === 'lessThan' ? v < limit : v > limit;
      }
      default:
        return false;
    }
  }

  // ── Lane geometry (vehicle "no waypoints" mode + lane_change) ───────────────

  function _laneAnchor(x, y, z = null) {
    return ObjectsManager.nearestLaneProjection(
      x, y, new Set(['driving']), LANE_SEARCH_MAX_DIST_M, z
    );
  }

  /** Project (x, y) onto `dirLine`, returning the nearest point's distance,
   * position, segment index (the target for _walkDirLine) and local heading. */
  function _nearestPointOnDirLine(dirLine, x, y) {
    let best = null;
    for (let i = 1; i < dirLine.length; i++) {
      const [x0, y0] = dirLine[i - 1], [x1, y1] = dirLine[i];
      const dx = x1 - x0, dy = y1 - y0;
      const len2 = dx * dx + dy * dy;
      if (len2 <= 0) continue;
      const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / len2));
      const px = x0 + t * dx, py = y0 + t * dy;
      const d = Math.hypot(x - px, y - py);
      if (!best || d < best.d) best = { d, px, py, idx: i, yaw: Math.atan2(dy, dx) * 180 / Math.PI };
    }
    return best;
  }

  /**
   * A same-direction neighbour lane on the same road, found geometrically
   * (lateral offset + heading alignment) rather than from OpenDRIVE's `side`/
   * laneChange fields, which map_renderer does not emit to the frontend.
   * Mirrors generate_target_waypoint_list_multilane's feasibility gate
   * (a Driving lane must exist) but not its `check=` legality gate, which the
   * real atomic also skips (check=False).
   *
   * This is the phase-1 fallback, used only when AppState.laneGraph has
   * nothing to say (no cache for this town, or the ground truth itself
   * reports no neighbour) — see _laneNeighbor.
   */
  function _findSameDirectionNeighbor(near, direction) {
    const rad = near.laneYaw * Math.PI / 180;
    // Right-hand vector in this map's y-down convention (verified: heading
    // +x/east with north-up-on-screen, "right" points +y/south).
    const rightX = -Math.sin(rad), rightY = Math.cos(rad);
    let best = null;

    for (const lane of near.road.lanes || []) {
      if (lane === near.lane) continue;
      if (lane.type !== 'driving') continue;
      const dirLine = lane.directionLine;
      if (!dirLine || dirLine.length < 2) continue;

      const bestSeg = _nearestPointOnDirLine(dirLine, near.x, near.y);
      if (!bestSeg) continue;
      if (bestSeg.d < LANE_NEIGHBOR_MIN_M || bestSeg.d > LANE_NEIGHBOR_MAX_M) continue;
      if (_angleDiffDeg(bestSeg.yaw, near.laneYaw) > LANE_NEIGHBOR_DIR_TOLERANCE_DEG) continue;
      const side = (bestSeg.px - near.x) * rightX + (bestSeg.py - near.y) * rightY > 0 ? 'right' : 'left';
      if (side !== direction) continue;
      if (!best || bestSeg.d < best.dist) best = { lane, segIndex: bestSeg.idx, dist: bestSeg.d, dirLine };
    }
    return best;
  }

  // ── Cached CARLA lane graph (phase 2) ────────────────────────────────────────
  //
  // Everything below degrades to the phase-1 approximations above whenever
  // AppState.laneGraph is null (Town10, an uploaded map) or a specific lookup
  // misses — never a crash, never a guess dressed up as ground truth.

  /** The render-JSON {road, lane} pair for a CARLA lane reference
   * {roadId, sectionId, laneId} — a one-time linear scan, acceptable because
   * it only runs when a fork or lane change is actually being resolved, not
   * per frame (same allowance _nearestLaneProjection already relies on). */
  function _findLaneByRef(ref) {
    for (const road of AppState.mapData?.roads || []) {
      if (String(road.id) !== String(ref.roadId)) continue;
      for (const lane of road.lanes || []) {
        if (lane.sectionId === ref.sectionId && lane.laneId === ref.laneId) return { road, lane };
      }
    }
    return null;
  }

  /**
   * The Driving neighbour lane on `direction`'s side of `cursor`'s lane at
   * point (x, y) — CARLA-verified graph data (get_left_lane()/
   * get_right_lane() ground truth) preferred over the geometric guess.
   *
   * If the graph exists and confidently reports no Driving neighbour on this
   * side, that verdict is trusted outright rather than falling back to a
   * geometric guess that might disagree with it.
   *
   * Returns {road, lane, dirLine, verified} or null.
   */
  function _laneNeighbor(cursor, x, y, laneYaw, direction) {
    const graph = AppState.laneGraph;
    if (graph && cursor.road) {
      const record = LaneGraph.laneRecord(graph, Number(cursor.road.id), cursor.lane.sectionId, cursor.lane.laneId);
      if (record) {
        const ref = record[direction]; // {roadId, sectionId, laneId} or null
        if (!ref) return null; // ground truth: no Driving neighbour here — trust it
        const found = _findLaneByRef(ref);
        if (found && found.lane.directionLine && found.lane.directionLine.length >= 2) {
          return { road: found.road, lane: found.lane, dirLine: found.lane.directionLine, verified: true };
        }
      }
    }
    // _findSameDirectionNeighbor only ever searches cursor.road.lanes, so a
    // geometric guess is always on the same road as the current lane.
    const guess = _findSameDirectionNeighbor({ road: cursor.road, lane: cursor.lane, x, y, laneYaw }, direction);
    return guess ? { road: cursor.road, lane: guess.lane, dirLine: guess.dirLine, verified: false } : null;
  }

  /**
   * The one successor to advance onto without an authored route to
   * disambiguate with — or null when there isn't exactly one usable
   * candidate. A CARLA-probed graph's successors[0] is next()'s own real
   * fork choice, so any non-empty list is usable; an xodr-derived graph
   * (graph.source === 'xodr') makes no such claim about ordering (see
   * backend/lane_graph_builder.py), so a genuine fork — more than one
   * candidate — is left unresolved here rather than guessed. Explicit
   * assign_route waypoints are unaffected by this: LaneGraph.route()'s A*
   * already considers every candidate as a real edge and finds whichever
   * branch reaches the target, with no need to guess first.
   */
  function _preferredSuccessor(graph, record) {
    const succs = LaneGraph.realSuccessors(record);
    if (!succs.length) return null;
    if (graph.source === 'xodr' && succs.length > 1) return null;
    return succs[0];
  }

  /** The next lane cursor after `cursor`'s dirLine runs out, via the cached
   * graph's real successors — or null when there is no graph, no usable
   * successor (see _preferredSuccessor), or the successor isn't a lane the
   * render JSON carries a directionLine for. Shared by lane-following
   * (_continueLaneFollowAtFork) and the lane-change plan builder
   * (_walkLaneChained), which hit exactly the same situation: a lane's
   * polyline ends mid-maneuver and the real controller would simply have
   * continued via waypoint.next(). */
  function _nextLaneCursor(cursor) {
    const graph = AppState.laneGraph;
    const { road, lane } = cursor;
    if (!graph || !road) return null;
    const record = LaneGraph.laneRecord(graph, Number(road.id), lane.sectionId, lane.laneId);
    const succ = _preferredSuccessor(graph, record);
    if (!succ) return null;
    const found = _findLaneByRef(succ);
    if (!found || !found.lane.directionLine || found.lane.directionLine.length < 2) return null;
    return { road: found.road, lane: found.lane, dirLine: found.lane.directionLine, idx: 0 };
  }

  /**
   * Advances a lane cursor {road, lane, dirLine, idx} by up to `step` metres
   * of arc length, chaining onto _nextLaneCursor() whenever the polyline
   * runs out — the lane-change equivalent of waypoint.next(step) crossing a
   * lane-section boundary, which _walkDirLine alone cannot do (it only knows
   * about the one lane it was given).
   *
   * Returns {cursor, x, y, z, yaw, ranOut}; ranOut is true only when the
   * step could not be completed AND there was no successor to continue onto
   * — a genuine dead end, or no lane graph for this town.
   */
  function _walkLaneChained(cursor, x, y, z, step) {
    let cur = cursor;
    let cx = x, cy = y, cz = z, yaw = null;
    let remaining = step;
    while (remaining > 1e-9) {
      const r = _walkDirLine(cur.dirLine, cx, cy, cz, cur.idx, remaining);
      cx = r.x; cy = r.y; cz = r.z; if (r.yaw != null) yaw = r.yaw;
      cur = { ...cur, idx: r.idx };
      remaining -= r.consumed;
      if (!r.ranOut) break;
      const next = _nextLaneCursor(cur);
      if (!next) return { cursor: cur, x: cx, y: cy, z: cz, yaw, ranOut: true };
      cur = next;
    }
    return { cursor: cur, x: cx, y: cy, z: cz, yaw, ranOut: false };
  }

  /**
   * Ports generate_target_waypoint_list_multilane (scenario_runner's
   * scenario_helper.py) — the exact plan ChangeActorLateralMotion.initialise
   * hands to the vehicle controller, rather than a lateral blend approximating
   * its output. Three legs, step_distance=2 throughout, matching the real
   * defaults ChangeActorLateralMotion passes (_distance_same_lane=5 hardcoded,
   * distance_other_lane=10 hardcoded by the parser call):
   *   - same-lane waypoints every 2 m until 5 m accumulate,
   *   - ONE waypoint `diagTotal` m ahead, projected onto the neighbour lane —
   *     the entire lateral move happens on this single hop; CARLA does not
   *     interpolate a curve here either,
   *   - target-lane waypoints every 2 m until 10 m accumulate.
   * `lane_changes` is always 1 — the editor only ever authors a single lane
   * shift (`RelativeTargetLane/@value` is always ±1 at export).
   *
   * Returns {waypoints, endCursor, verified} or null when a next()-equivalent
   * runs off a genuine dead end (no lane graph for this town, or the
   * successor chain truly ends, or no Driving neighbour on `direction`'s
   * side) — mirrors the helper's `return None, None`.
   */
  function _buildLaneChangePlan(near, direction, diagTotal) {
    const STEP = 2.0;
    let cursor = { road: near.road, lane: near.lane, dirLine: near.lane.directionLine, idx: near.segIndex };
    let x = near.x, y = near.y, z = near.z;
    const waypoints = [];

    let dist = 0;
    while (dist < LANE_CHANGE_SAME_LANE_M) {
      const r = _walkLaneChained(cursor, x, y, z, STEP);
      if (r.ranOut) return null;
      dist += Math.hypot(r.x - x, r.y - y);
      cursor = r.cursor; x = r.x; y = r.y; z = r.z;
      waypoints.push({ x, y, z });
    }

    const lc = _walkLaneChained(cursor, x, y, z, diagTotal);
    if (lc.ranOut) return null;
    const lcYaw = (_nearestPointOnDirLine(lc.cursor.dirLine, lc.x, lc.y) || {}).yaw ?? near.laneYaw;
    const neighbor = _laneNeighbor(lc.cursor, lc.x, lc.y, lcYaw, direction);
    if (!neighbor) return null;
    const proj = _nearestPointOnDirLine(neighbor.dirLine, lc.x, lc.y);
    if (!proj) return null;
    waypoints.push({ x: proj.px, y: proj.py, z: lc.z });

    let ocursor = { road: neighbor.road, lane: neighbor.lane, dirLine: neighbor.dirLine, idx: proj.idx };
    x = proj.px; y = proj.py; z = lc.z;
    dist = 0;
    while (dist < LANE_CHANGE_OTHER_LANE_M) {
      const r = _walkLaneChained(ocursor, x, y, z, STEP);
      if (r.ranOut) return null;
      dist += Math.hypot(r.x - x, r.y - y);
      ocursor = r.cursor; x = r.x; y = r.y; z = r.z;
      waypoints.push({ x, y, z });
    }

    return { waypoints, endCursor: ocursor, verified: neighbor.verified };
  }

  /**
   * The lane-projected form of a raw point, carrying BOTH the projection and
   * the raw location — LaneGraph.route needs the projected point as its
   * `current` seed and the raw one for trace_route's distance break, and they
   * are different points.
   */
  function _resolveLaneRef(x, y, z) {
    // 3-D, like the map.get_waypoint() every trace_route endpoint goes through:
    // a waypoint on a bridge deck must not route from the street beneath it.
    const near = _laneAnchor(x, y, z);
    if (!near || !near.road) return null;
    return {
      roadId: Number(near.road.id), sectionId: near.lane.sectionId, laneId: near.lane.laneId,
      x: near.x, y: near.y, z: near.z,
      rawX: x, rawY: y, rawZ: z !== undefined ? z : near.z,
    };
  }

  /**
   * Ports `ego_waypoint.next(1)[0]` — the seed for leg 0 only
   * (atomic_behaviors.py ChangeActorWaypoints.initialise).
   *
   * `.next(1.0)` means "1 metre further ALONG THE ROAD", which almost always
   * stays inside the current lane and only crosses into a successor when the
   * lane actually ends within that metre. Reading the cached `successors`
   * list from an arbitrary mid-lane position instead — as this used to — jumps
   * the seed past the whole rest of the current lane, which put leg 0 on the
   * wrong lane entirely and was the main cause of the ego visibly driving
   * backwards for the first second or two.
   *
   * Returns {ref, headingRad} or null; `headingRad` is the lane tangent at the
   * seed, which the runtime's heading filter uses as its initial reference.
   */
  function _seedAssignRouteStart(sim) {
    const near = _laneAnchor(sim.x, sim.y, sim.z);
    if (!near || !near.road) return null;

    // The seed is a waypoint ON a known lane, so its ref is built from that lane
    // rather than re-projected: a seed that has crossed into a successor sits
    // on the shared boundary point, where the nearest-lane projection hands
    // back the lane it just left. That mattered — standing within 1 m of a lane
    // end, CARLA's seed is in the successor, waypoint 0 (the actor's own pose)
    // is then BEHIND it, and the real route drives round the block to come
    // back to it (Town03 road 5 is a 0.8 m stub: a 194 m loop the preview did
    // not show).
    const refOf = (road, lane, p) => ({
      roadId: Number(road.id), sectionId: lane.sectionId, laneId: lane.laneId,
      x: p.x, y: p.y, z: p.z, rawX: p.x, rawY: p.y, rawZ: p.z,
    });

    let road = near.road, lane = near.lane;
    const dl0 = lane.directionLine;
    const segT = Math.hypot(near.x - dl0[near.segIndex - 1][0], near.y - dl0[near.segIndex - 1][1])
      / (Math.hypot(dl0[near.segIndex][0] - dl0[near.segIndex - 1][0],
                    dl0[near.segIndex][1] - dl0[near.segIndex - 1][1]) || 1);
    let walked = _walkDirLineS(dl0, near.segIndex, segT, ROUTE_SEED_AHEAD_M);
    if (!walked) { // no s on this payload's points — fall back to arc length
      const w = _walkDirLine(dl0, near.x, near.y, near.z, near.segIndex, ROUTE_SEED_AHEAD_M);
      walked = { ...w, remaining: ROUTE_SEED_AHEAD_M - w.consumed };
    }
    let headingRad = (walked.yaw !== null ? walked.yaw : near.laneYaw) * Math.PI / 180;

    // .next(1.0) walks on through as many successors as the metre reaches.
    for (let hop = 0; walked.ranOut && hop < 8; hop++) {
      const graph = AppState.laneGraph;
      const record = LaneGraph.laneRecord(graph, Number(road.id), lane.sectionId, lane.laneId);
      let succ = _preferredSuccessor(graph, record);
      if (!succ && graph && graph.source === 'xodr') {
        // An unranked fork. Path-less driving refuses to guess here, but the
        // seed cannot: past ANY successor, waypoint 0 (the actor's pose) is
        // behind the seed and CARLA routes round to it, so keeping the actor's
        // own point would hide a loop CARLA certainly drives. next()[0] was
        // the highest-numbered road at 73% of the forks in the 8 probed towns.
        const succs = LaneGraph.realSuccessors(record);
        succ = succs.length ? succs.reduce((a, b) => (b.roadId > a.roadId ? b : a)) : null;
      }
      const found = succ ? _findLaneByRef(succ) : null;
      if (!found || (found.lane.directionLine || []).length < 2) {
        // No successor -> CARLA's IndexError path: the seed is the actor's
        // own waypoint.
        return { ref: refOf(near.road, near.lane, near), headingRad: near.laneYaw * Math.PI / 180 };
      }
      road = found.road; lane = found.lane;
      const next = _walkDirLineS(lane.directionLine, 1, 0, walked.remaining);
      if (!next) break;
      walked = next;
      if (walked.yaw !== null) headingRad = walked.yaw * Math.PI / 180;
    }

    return { ref: refOf(road, lane, walked), headingRad };
  }

  /**
   * Walk `ds` along a lane in OpenDRIVE s — what Waypoint.next(d) advances —
   * from `t` of the way along segment `idx` (dirLine[idx-1] -> dirLine[idx]).
   * Not arc length: on the inside of a curve a lane is shorter than its s
   * span, so an arc-length metre runs off the end of a lane that next(1)
   * stays inside (Town04's ramps). Returns {x, y, z, yaw, ranOut, remaining}
   * with `remaining` the s still to walk past the end, or null when the
   * points carry no s (an older render payload).
   */
  function _walkDirLineS(dirLine, idx, t, ds) {
    if (dirLine.length < 2 || dirLine[0].length < 4) return null;
    const sAt = (i) => dirLine[i][3];
    const sign = sAt(dirLine.length - 1) >= sAt(0) ? 1 : -1;
    const s0 = sAt(idx - 1) + (sAt(idx) - sAt(idx - 1)) * t;
    const target = s0 + sign * ds;
    for (let i = idx; i < dirLine.length; i++) {
      const a = dirLine[i - 1], b = dirLine[i];
      // The lane's own end is exclusive: next() landing exactly on it already
      // returns the successor (a generated actor 1 m before a fork does this).
      const last = i === dirLine.length - 1;
      if ((target - b[3]) * sign < (last ? -1e-6 : 1e-9)) {
        const span = b[3] - a[3];
        const f = span ? Math.max(0, Math.min(1, (target - a[3]) / span)) : 1;
        return {
          x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, z: a[2] + (b[2] - a[2]) * f,
          yaw: Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI, ranOut: false, remaining: 0,
        };
      }
    }
    const a = dirLine[dirLine.length - 2], b = dirLine[dirLine.length - 1];
    return {
      x: b[0], y: b[1], z: b[2], yaw: Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI,
      ranOut: true, remaining: Math.abs(target - b[3]),
    };
  }

  /**
   * Faithful port of ChangeActorWaypoints.initialise for a `fastest` route —
   * the locally patched version in the install run.sh actually executes
   * (/home/dellpro2/Antonio/scenario_runner). One trace_route per
   * authored waypoint, then a filter applied to the CONCATENATED result.
   *
   * That filter is not cosmetic: the router genuinely emits points that go
   * backwards (a lane change is a bare ~12 m chord, and a leg can overshoot
   * its goal), and the runtime drops them. Reproducing the routing without
   * the filter is what made the preview show a turn-around that CARLA
   * never performs.
   *
   * Returns the waypoint list, or null if the graph is absent or the very
   * first lane lookup fails — callers then fall back to the raw clicked
   * polyline, badged as approximate.
   */
  function _exactRoute(sim, rawPoints) {
    if (!AppState.laneGraph) return null;
    const seed = _seedAssignRouteStart(sim);
    if (!seed) return null;

    const route = [];
    let fromRef = seed.ref;

    for (const wp of rawPoints) {
      const toRef = _resolveLaneRef(wp.x, wp.y, wp.z);

      // A waypoint's strategy governs the leg that ENDS at it. 'shortest' is
      // appended verbatim — ChangeActorWaypoints does `route.append(element)`
      // outside the routed branch, so neither the >1 m dedup nor the heading
      // filter applies to it, and the actor drives the straight line as drawn.
      //
      // The next 'fastest' leg still starts HERE: CARLA seeds it from
      // carla_route_elements[i - 1] whatever that element's own strategy was,
      // which is exactly what makes an off-lane 'shortest' point before a
      // 'fastest' one a routing seed rather than a free excursion.
      if (wp.strategy === 'shortest') {
        route.push({ x: wp.x, y: wp.y, z: wp.z !== undefined ? wp.z : 0.2 });
        if (toRef) fromRef = toRef;
        continue;
      }

      // No lane under this waypoint, or no path to it: CARLA's NetworkXNoPath
      // branch appends the raw authored point and moves on, rather than
      // abandoning the whole route.
      const trace = toRef ? LaneGraph.route(AppState.laneGraph, fromRef, toRef) : null;
      if (!trace) {
        route.push({ x: wp.x, y: wp.y, z: wp.z !== undefined ? wp.z : 0.2 });
        if (toRef) fromRef = toRef;
        continue;
      }

      for (const p of trace) {
        const last = route[route.length - 1];
        if (last && _dist3(p, last) > ROUTE_DEDUP_MIN_M) {
          const newHeading = Math.atan2(p.y - last.y, p.x - last.x);
          let lastHeading;
          if (route.length > 1) {
            const prev = route[route.length - 2];
            const rx = last.x - prev.x, ry = last.y - prev.y, rz = (last.z || 0) - (prev.z || 0);
            if (Math.hypot(rx, ry, rz) < ROUTE_SHORT_REF_M) {
              // Too short to yield a meaningful heading; accepting beats
              // rejecting the rest of an otherwise legitimate route.
              route.push(p);
              continue;
            }
            lastHeading = Math.atan2(ry, rx);
          } else {
            lastHeading = seed.headingRad; // lane tangent, not a router chord
          }
          // Deliberately NOT wrapped to [0, pi]: the `> HI` arm is what
          // catches the wrap-around cases, so the raw difference is what the
          // band is calibrated against. Rejects only genuine reversals
          // (~115-246 deg).
          const headingDelta = Math.abs(newHeading - lastHeading);
          if (headingDelta < ROUTE_HEADING_ACCEPT_LO || headingDelta > ROUTE_HEADING_ACCEPT_HI) {
            route.push(p);
          }
        } else if (!route.length) {
          route.push(p); // first point of the whole route is unconditional
        }
      }
      fromRef = toRef;
    }
    return route.length >= 2 ? route : null;
  }

  // ── Per-actor sim record ─────────────────────────────────────────────────────

  function _makeSimActor(actor, isEgo) {
    const events = _normalizeEventsForSim(actor);
    return {
      id: actor.id,
      type: actor.type,
      body: AppState.bodyType(actor),   // footprint type: the ego's vehicleType
      isEgo,
      isWalker: MapView.isWalkerType(actor.type),
      x: actor.x, y: actor.y, z: actor.z ?? 0, yaw: actor.yaw || 0,
      spawnYaw: actor.yaw || 0,
      // The Init <SpeedAction>: ChangeActorTargetSpeed(..., init_speed=True)
      // runs in InitialActorSettings on tick 1, before any Act's
      // SimulationTime>0 start trigger, so the actor already has this speed
      // when the story begins. Nothing else is needed to model "unless a later
      // speed action replaces it" — set_speed and follow_trajectory both assign
      // sim.speed when they fire, exactly as BasicControl.update_target_speed()
      // overwrites _target_speed. An actor with no events gets no Act at all,
      // so for it this is the only speed it ever has.
      // `target` is what the atomics command (BasicControl._target_speed), and
      // `speed` what the actor actually drives after SimpleVehicleControl's
      // rate limits. A vehicle spawns at rest and pulls up to its Init speed at
      // max_acceleration; PedestrianControl sets the speed outright, so a walker
      // starts at it.
      target: Math.max(0, actor.initial_speed || 0),
      speed: MapView.isWalkerType(actor.type) ? Math.max(0, actor.initial_speed || 0) : 0,
      lastCmd: null,               // SimpleVehicleControl._last_target_speed
      maxAccel: actor.max_acceleration ?? DEFAULT_MAX_ACCEL,
      maxDecel: actor.max_deceleration ?? DEFAULT_MAX_DECEL,
      events,
      fired: new Map(),           // eventId → {firedAt, completedAt|null}
      activeSpeedEventId: null,
      speedEventDuration: 0,       // dynamics.value: seconds, or m/s² when the dimension is 'rate'
      speedEventDimension: 'time',
      speedRampFrom: 0,            // ChangeActorTargetSpeed._start_speed, 'rate' only
      speedRampTarget: 0,          // ._target_speed as snapshotted in initialise()
      speedRelativeRef: null,      // entity id to keep tracking; null ⇒ absolute target
      speedRelativeDelta: 0,
      speedRelativeFactor: null,   // speedTargetValueType="factor"; null ⇒ delta
      speedContinuous: false,      // continuous="true": tracks for good, never completes
      activePathEventId: null,
      pathKind: null,              // 'follow_trajectory' | 'assign_route'
      waypoints: null,
      activeLaneChangeEventId: null,
      laneChange: null,
      // ChangeActorLaneOffset — metres right of the driven path's centreline
      // (negative is left), and the event currently holding it. The offset is
      // applied when the pose is written back, NOT to sim.x/sim.y, so the
      // path-following maths keeps running on the centreline exactly as
      // SimpleVehicleControl's own waypoint list does — the controller offsets
      // its aim point, it does not re-plan around the displaced position.
      laneOffset: 0,               // the offset actually driven, eased toward laneOffsetTarget
      laneOffsetTarget: 0,         // what the controller's _offset is set to
      laneOffsetReturns: false,    // continuous="false": completes on reaching, then resets to 0
      activeLaneOffsetEventId: null,
      laneFollow: null,            // {lane, dirLine, idx} anchor while path-less
      badge: null,
      traveled: 0,
      frozen: false,
      goalStopped: false,          // SimpleVehicleControl._reached_goal — sticky
      hasNoEvents: events.length === 0,
      noEventsBadgeShown: false,
    };
  }

  function _avgTrajectorySpeed(points) {
    // Mirrors _compute_trajectory_times + openscenario_parser's patched
    // FollowTrajectoryAction handling: per-waypoint velocities are baked into
    // relativeTime, then collapsed back into ONE average speed for the whole
    // path (total_dist / total_time) — the real controller never sees the
    // per-segment values a trajectory was authored with.
    let totalDist = 0, totalTime = 0;
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - points[i - 1].x, dy = points[i].y - points[i - 1].y;
      const dist = Math.hypot(dx, dy);
      const v1 = points[i - 1].velocity ?? 10, v2 = points[i].velocity ?? 10;
      const avgV = (v1 + v2) / 2 || 1;
      totalDist += dist;
      totalTime += dist / avgV;
    }
    return totalTime > 0 ? totalDist / totalTime : 10;
  }

  /** A new longitudinal command lands: ChangeActorTargetSpeed.update() sees
   * get_last_longitudinal_command() != its own start_time and reports SUCCESS,
   * so the old atomic stops writing — including any relative tracking. */
  function _supersedeSpeedEvent(sim, simTime) {
    if (!sim.activeSpeedEventId) return;
    const prev = sim.fired.get(sim.activeSpeedEventId);
    if (prev && prev.completedAt == null) prev.completedAt = simTime;
    sim.activeSpeedEventId = null;
    sim.speedRelativeRef = null;
    sim.speedRelativeDelta = 0;
    sim.speedRelativeFactor = null;
    sim.speedContinuous = false;
    sim.speedRampFrom = 0;
    sim.speedRampTarget = 0;
  }

  /** A lateral/waypoint command lands while a lane offset is running.
   *
   * ChangeActorLaneOffset.update() ends on EITHER of two mismatches, and which
   * one decides whether the offset survives:
   *  - another lane offset (`get_last_lane_offset_command()`) sets `_overwritten`
   *    and returns SUCCESS, so `terminate()` skips its reset and the NEW offset
   *    stands. That is what makes "drift out, then a second event back to 0"
   *    work at all;
   *  - any other waypoint command (a route, a trajectory, a lane change) returns
   *    SUCCESS with `_overwritten` still false, so `terminate()` puts the offset
   *    back to 0.
   */
  function _supersedeLaneOffset(sim, simTime, { reset }) {
    if (sim.activeLaneOffsetEventId) {
      const prev = sim.fired.get(sim.activeLaneOffsetEventId);
      if (prev && prev.completedAt == null) prev.completedAt = simTime;
      sim.activeLaneOffsetEventId = null;
    }
    if (reset) sim.laneOffsetTarget = 0;
    sim.laneOffsetReturns = false;
  }

  /** The mirror of the rule above, in the other direction: ActorControl's
   * update_offset() stamps `_last_waypoint_command` as well as its own slot, so
   * starting a lane offset makes a running ChangeActorWaypoints /
   * ChangeActorLateralMotion report SUCCESS immediately.
   *
   * It does NOT call update_waypoints(), so the controller keeps driving the
   * list it already has — only the atomic ends. That is why the waypoints and
   * the lane-change plan are deliberately left untouched here: the visible
   * consequence is that an after_event waiting on that route fires the moment
   * the offset starts rather than when the route finishes. */
  function _supersedeWaypointEvents(sim, simTime) {
    for (const id of [sim.activePathEventId, sim.activeLaneChangeEventId]) {
      if (!id) continue;
      const rec = sim.fired.get(id);
      if (rec && rec.completedAt == null) rec.completedAt = simTime;
    }
  }

  function _applyEventAction(sim, ev, simTime) {
    sim.fired.set(ev.id, { firedAt: simTime, completedAt: null });
    const action = ev.action;
    if (sim.goalStopped && !sim.isWalker) {
      // SimpleVehicleControl._reached_goal is a one-way latch: run_step returns
      // zero velocity before it reads any target. The atomic still runs (a
      // timed set_speed even completes), it just moves nothing.
      sim.badge = { icon: '⏹', text: 'Wirkungslos — steht nach Pfadende (CARLA hält das Fahrzeug dort fest)' };
      if (action.type !== 'set_speed') {
        // A path action's ChangeActorWaypoints sees check_reached_waypoint_goal()
        // still true and ends at once; a lane change or offset never gets to.
        if (action.type === 'follow_trajectory' || action.type === 'assign_route') {
          sim.fired.get(ev.id).completedAt = simTime;
        }
        return;
      }
    }

    if (action.type === 'set_speed') {
      _supersedeSpeedEvent(sim, simTime);
      // ChangeActorTargetSpeed.initialise(): a relative target samples the
      // reference ONCE here, but the atomic goes on re-sampling it every tick
      // for the whole duration (see _stepActor), so the parameters are kept.
      const target = action.target || {};
      const isRelative = target.mode === 'relative';
      sim.speedRelativeRef = isRelative ? (target.entity_ref || _egoId) : null;
      sim.speedRelativeDelta = isRelative ? (target.delta ?? 0) : 0;
      sim.speedRelativeFactor = isRelative && target.value_type === 'factor' ? (target.factor ?? 1) : null;
      sim.speedContinuous = isRelative && target.continuous === true;
      sim.activeSpeedEventId = ev.id;
      sim.speedEventDuration = (action.dynamics && action.dynamics.value) ?? 5.0;
      // The emitter forces a continuous follow to a plain step ('time'): with
      // continuous="true" the atomic's ramp branch is skipped anyway.
      sim.speedEventDimension = sim.speedContinuous ? 'time'
        : (action.dynamics && action.dynamics.dimension) || 'time';

      // A negative absolute target is „Rückwärts" — vehicles only (the backend
      // rejects it for a walker, whose controller raises on it).
      const absolute = Math.max(0, target.value ?? 10) *
        (target.reverse === true && !sim.isWalker ? -1 : 1);
      const resolvedTarget = isRelative ? _relativeTarget(sim) : absolute;

      if (sim.speedEventDimension === 'rate') {
        // The rate branch does NOT step: initialise() commands _start_speed and
        // update() ramps from there. It also snapshots _target_speed once and
        // then overwrites its own per-tick relative re-sample with the ramp, so
        // a relative target stops tracking the moment a rate is used — that is
        // the atomic's real behaviour, not a shortcut taken here.
        // _start_speed is CarlaDataProvider.get_velocity — a magnitude.
        sim.speedRampFrom = Math.abs(sim.speed);
        sim.speedRampTarget = resolvedTarget;
        sim.speedRelativeRef = null;
        sim.target = sim.speedRampFrom;
      } else {
        sim.target = resolvedTarget;
      }

    } else if (action.type === 'follow_trajectory' || action.type === 'assign_route') {
      const isRoute = action.type === 'assign_route';
      const rawPoints = isRoute ? (action.waypoints || []) : (action.trajectory || []);
      if (!_actionEmits(action, sim.type)) return; // dropped at export — never applies
      _supersedeLaneOffset(sim, simTime, { reset: true });
      sim.activePathEventId = ev.id;
      sim.pathKind = action.type;

      if (isRoute) {
        // AssignRouteAction only sets waypoints, never a speed — so the actor
        // keeps whatever speed it already has. With an Init speed that means it
        // drives the route immediately; with none (initial_speed 0) it does not
        // move at all until some set_speed event gives it a nonzero speed.
        // The stationary case is a real gap in the emitted scenario, not a
        // preview limitation, so it gets no badge: the actor visibly sitting
        // still already says it, exactly like the real run would.
        const exact = _exactRoute(sim, rawPoints);
        if (exact) {
          sim.waypoints = exact;
          sim.badge = null;
        } else {
          sim.waypoints = rawPoints.map(p => ({ x: p.x, y: p.y, z: p.z ?? 0.2 }));
          sim.badge = { icon: '≈', text: 'Route ist ungefähr — kein CARLA-Kartengraph für diese Karte/Punkte' };
        }
      } else {
        // FollowTrajectoryAction parses into a Sequence whose first child is
        // ChangeActorTargetSpeed with its own start_time — a LONGITUDINAL
        // command, so it cancels any running relative-speed tracker. Neither
        // assign_route nor lane_change does (both issue waypoint commands
        // only, stamped on a separate _last_waypoint_command).
        _supersedeSpeedEvent(sim, simTime);
        sim.waypoints = rawPoints.map(p => ({ x: p.x, y: p.y, z: p.z ?? 0.2 }));
        sim.target = _avgTrajectorySpeed(rawPoints);
        if (!sim.goalStopped || sim.isWalker) sim.badge = null;
      }

      while (sim.waypoints.length &&
             _dist3(sim, sim.waypoints[0]) < LEADING_WAYPOINT_DROP_M) {
        sim.waypoints.shift();
      }

    } else if (action.type === 'lane_change') {
      _supersedeLaneOffset(sim, simTime, { reset: true });
      sim.activeLaneChangeEventId = ev.id;
      _startLaneChange(sim, action, simTime);

    } else if (action.type === 'lane_offset') {
      _startLaneOffset(sim, ev, action, simTime);

    } else if (action.type === 'set_distance') {
      // Deliberately not simulated — see file header. Never completes, so any
      // after_event chained onto it never fires here either, matching the
      // real gap-measurement / 100 m/s spike being unknowable without the
      // same lane graph assign_route needs.
      sim.badge = { icon: '−', text: 'set_distance wird in der Vorschau nicht simuliert' };
    }
  }

  /**
   * ChangeActorLaneOffset with an AbsoluteTargetLaneOffset, always
   * continuous="true" — the only mode the emitter writes, and the only one that
   * does anything (see _add_lane_offset_action). So this event never completes
   * on its own; it ends only when something supersedes it, which is exactly what
   * _supersedeLaneOffset models.
   *
   * Positive is right of travel. The editor's payload carries an unsigned
   * `offset` plus a `direction`, the same shape lane_change uses, and the sign
   * is applied here and in the emitter rather than stored.
   */
  function _startLaneOffset(sim, ev, action, simTime) {
    if (!_actionEmits(action, sim.type)) {
      // A walker: PedestrianControl stores the controller offset and never
      // reads it. The backend rejects this payload outright, so it can only
      // arrive in a loaded save file — badge it rather than move the actor
      // sideways in a way CARLA never would.
      sim.badge = { icon: '⚠', text: 'Spurversatz wirkt nicht — nur Fahrzeuge folgen ihm' };
      return;
    }
    _supersedeLaneOffset(sim, simTime, { reset: false });
    _supersedeWaypointEvents(sim, simTime);

    const magnitude = Math.max(0, action.offset ?? 1.0);
    sim.laneOffsetTarget = action.direction === 'right' ? magnitude : -magnitude;
    sim.laneOffsetReturns = action.continuous === false;
    sim.activeLaneOffsetEventId = ev.id;
    if (sim.goalStopped) return;
    sim.badge = magnitude > 0
      ? { icon: '⇥', text: `Spurversatz ${UIUtils.fmt(magnitude)} m ${action.direction === 'right' ? 'rechts' : 'links'} (${sim.laneOffsetReturns ? 'hin & zurück' : 'dauerhaft'})` }
      : { icon: '⇥', text: 'Zurück zur Spurmitte' };
  }

  function _startLaneChange(sim, action, simTime) {
    const near = _laneAnchor(sim.x, sim.y);
    const direction = action.direction === 'right' ? 'right' : 'left';
    const dirLabel = direction === 'left' ? 'links' : 'rechts';
    if (!near) {
      sim.badge = { icon: '⚠', text: `Spurwechsel ${dirLabel} nicht möglich — keine Spur unter dem Fahrzeug` };
      return;
    }
    const diagTotal = Math.max(0, (action.dynamics && action.dynamics.value) ?? 12.0) || 1e-6;
    const plan = _buildLaneChangePlan(near, direction, diagTotal);
    if (!plan) {
      // Mirrors generate_target_waypoint_list_multilane returning (None,
      // None) — ChangeActorLateralMotion.update then reports FAILURE and the
      // maneuver never completes, so we stop advancing this actor rather
      // than pretend a lane change happened.
      sim.frozen = true;
      sim.speed = 0;
      sim.target = 0;
      sim.badge = { icon: '⚠', text: `Spurwechsel ${dirLabel} nicht möglich — keine Nachbarspur in Fahrtrichtung` };
      return;
    }
    // Overwrites any waypoints left over from an earlier follow_trajectory/
    // assign_route — those would otherwise outrank lane-following once the
    // change completes (_advancePosition checks sim.waypoints first).
    sim.waypoints = plan.waypoints;
    sim.laneChange = { active: true, endCursor: plan.endCursor, eventId: sim.activeLaneChangeEventId };
    const totalM = (LANE_CHANGE_SAME_LANE_M + diagTotal + LANE_CHANGE_OTHER_LANE_M).toFixed(0);
    // plan.verified only says the neighbour came from the graph rather than a
    // geometric guess — an xodr-derived graph (no live CARLA behind it) still
    // gets its own, less confident label than an actual CARLA probe.
    const source = !plan.verified ? 'geschätzt'
      : (AppState.laneGraph && AppState.laneGraph.source === 'xodr') ? 'aus Kartendatei'
      : 'CARLA-Kartendaten';
    sim.badge = { icon: '↔', text: `Spurwechsel ${dirLabel} läuft (~${totalM} m, ${source})` };
  }

  /** The lane-change plan's waypoints ran out — the same signal
   * ChangeActorLateralMotion.update uses (distance travelled past
   * distance_other_lane) to report SUCCESS and hand the controller 200 fresh
   * lane-follow waypoints. Here the plan's own other-lane leg already IS
   * that distance, so emptying the list and completing are the same event. */
  function _completeLaneChange(sim) {
    const lc = sim.laneChange;
    lc.active = false;
    if (lc.eventId) {
      const rec = sim.fired.get(lc.eventId);
      if (rec) rec.completedAt = _simTime;
    }
    sim.laneFollow = lc.endCursor;
    sim.badge = null;
  }

  function _advanceWaypoints(sim, dt) {
    const acceptR = sim.isWalker ? VRU_WAYPOINT_ACCEPT_M : VEHICLE_WAYPOINT_ACCEPT_M;
    let remaining = sim.speed * dt;
    while (remaining > 1e-9 && sim.waypoints.length) {
      const target = sim.waypoints[0];
      const dx = target.x - sim.x, dy = target.y - sim.y;
      const dist2d = Math.hypot(dx, dy);
      if (dist2d <= acceptR) {
        // Advance to the next waypoint the instant we're within radius —
        // mirrors both controllers switching their aim point without
        // consuming this tick's remaining distance budget on the hop.
        sim.waypoints.shift();
        if (!sim.waypoints.length) {
          if (sim.laneChange && sim.laneChange.active) {
            // CARLA replaces the plan with 200 fresh lane-follow waypoints on
            // SUCCESS rather than stopping — a dead stop here would be wrong.
            _completeLaneChange(sim);
          } else {
            sim.speed = 0; // dead stop on _reached_goal, not a coast
            sim.target = 0;
            // ChangeActorWaypoints reports SUCCESS on check_reached_waypoint_goal()
            // — this tick — so an after_event on the path fires now. It used to
            // never complete here, and nothing chained onto a path ever fired.
            const pathRec = sim.activePathEventId && sim.fired.get(sim.activePathEventId);
            if (pathRec && pathRec.completedAt == null) pathRec.completedAt = _simTime;
            // _reached_goal is sticky: run_step returns zero velocity from
            // here on whatever target speed the atomics keep writing, so a
            // relative tracker must not drive this actor off again.
            sim.goalStopped = true;
            if (sim.pathKind === 'follow_trajectory') sim.badge = null;
          }
          return;
        }
        continue;
      }
      const step = Math.min(remaining, dist2d);
      const frac = step / dist2d;
      sim.x += dx * frac; sim.y += dy * frac; sim.z += (target.z - sim.z) * frac;
      sim.yaw = Math.atan2(dy, dx) * 180 / Math.PI;
      sim.traveled += step;
      remaining -= step;
    }
  }

  /** A negative speed: SimpleVehicleControl still aims at the waypoint ahead and
   * scales the direction to it by the (negative) speed, so the vehicle backs
   * away from it without turning. Over the short distances anyone reverses,
   * that is straight back along the current heading. The lane-follow anchor and
   * any waypoints are left alone, so driving forward again resumes them. */
  function _advanceReverse(sim, dt) {
    const rad = (sim.yaw || 0) * Math.PI / 180;
    const step = sim.speed * dt;  // negative
    sim.x += Math.cos(rad) * step;
    sim.y += Math.sin(rad) * step;
    sim.traveled += Math.abs(step);
  }

  /** The relative set_speed target as ChangeActorTargetSpeed computes it from
   * the reference's (snapshotted) speed: + delta, or × factor. */
  function _relativeTarget(sim) {
    const ref = _refSpeed(sim.speedRelativeRef);
    return sim.speedRelativeFactor != null ? ref * sim.speedRelativeFactor : ref + sim.speedRelativeDelta;
  }

  /**
   * SimpleVehicleControl._set_new_velocity's rate limits, literally: the
   * commanded speed may fall by at most max_deceleration·dt and rise by at most
   * max_acceleration·dt per tick, measured against the LAST COMMANDED speed
   * (not the measured one), with the controller's 0.5 m/s pull-away bump. The
   * branch is chosen by comparing the target to the measured speed — a
   * magnitude — which is why a reverse command (negative) always takes the
   * deceleration branch. A walker's PedestrianControl has no limits at all.
   * `want` is the target after any reacting-ego braking.
   */
  function _applyControllerLimits(sim, want, dt) {
    if (sim.isWalker) { sim.speed = Math.max(0, want); return; }
    const current = Math.abs(sim.speed);
    if (sim.lastCmd == null) sim.lastCmd = current;
    let cmd = want;
    if (want < current) {
      cmd = Math.max(want, sim.lastCmd - dt * sim.maxDecel);
    } else {
      const tmp = Math.min(want, sim.lastCmd + dt * sim.maxAccel);
      cmd = Math.max(tmp, Math.min(SVC_MIN_PULL_AWAY, want));
    }
    sim.lastCmd = cmd;
    sim.speed = cmd;
  }

  /** Ease the driven offset toward the controller's, per metre travelled (an
   * exponential approach, as measured in CARLA), and
   * finish a non-continuous offset the way the patched ChangeActorLaneOffset
   * does: within OFFSET_THRESHOLD it reports SUCCESS and terminate() sets the
   * offset back to 0. */
  function _advanceLaneOffset(sim, travelled, simTime) {
    const diff = sim.laneOffsetTarget - sim.laneOffset;
    if (diff !== 0) {
      sim.laneOffset += diff * (1 - Math.exp(-travelled / LANE_OFFSET_APPROACH_M));
      if (Math.abs(sim.laneOffsetTarget - sim.laneOffset) < 0.005) sim.laneOffset = sim.laneOffsetTarget;
    }
    if (sim.laneOffsetReturns && sim.activeLaneOffsetEventId &&
        Math.abs(sim.laneOffset - sim.laneOffsetTarget) < LANE_OFFSET_THRESHOLD_M) {
      const rec = sim.fired.get(sim.activeLaneOffsetEventId);
      if (rec && rec.completedAt == null) rec.completedAt = simTime;
      sim.activeLaneOffsetEventId = null;
      sim.laneOffsetReturns = false;
      sim.laneOffsetTarget = 0;
      sim.badge = { icon: '⇥', text: 'Spurversatz erreicht — zurück zur Spurmitte' };
    }
  }

  function _advanceStraight(sim, dt) {
    // PedestrianControl with no waypoints walks its CURRENT forward vector —
    // which, having never been given a waypoint, is still the spawn yaw.
    // Exact: no map query, no lane dependency at all.
    const rad = sim.spawnYaw * Math.PI / 180;
    const step = sim.speed * dt;
    sim.x += Math.cos(rad) * step;
    sim.y += Math.sin(rad) * step;
    sim.traveled += step;
  }

  function _ensureLaneFollowAnchor(sim) {
    if (sim.laneFollow) return true;
    const near = _laneAnchor(sim.x, sim.y);
    if (!near) {
      sim.frozen = true;
      sim.badge = { icon: '❓', text: 'Nicht auf einer bekannten Spur — Pfad kann nicht simuliert werden' };
      return false;
    }
    sim.laneFollow = { road: near.road, lane: near.lane, dirLine: near.lane.directionLine, idx: near.segIndex };
    return true;
  }

  /**
   * At the end of known lane geometry, consult the cached graph's real
   * successors for this exact lane via _preferredSuccessor (index 0 is
   * CARLA's own fork choice on a CARLA-probed graph, not a guess; an
   * xodr-derived graph refuses instead of guessing at a genuine fork — see
   * _preferredSuccessor) and re-anchor lane-following onto it. Returns false
   * (leaving the caller to freeze+badge) when there is no graph, no usable
   * successor, or the successor isn't a lane the render JSON carries a
   * directionLine for.
   */
  function _continueLaneFollowAtFork(sim) {
    const next = _nextLaneCursor(sim.laneFollow);
    if (!next) return false;
    sim.laneFollow = next;
    const graphSource = (AppState.laneGraph && AppState.laneGraph.source === 'xodr')
      ? 'aus Kartendatei abgeleitet' : 'CARLA-Kartendaten';
    sim.badge = { icon: '↷', text: `Fährt an bekannter Abzweigung weiter (${graphSource})` };
    return true;
  }

  function _advanceLaneFollow(sim, dt) {
    if (!_ensureLaneFollowAnchor(sim)) return;
    const dirLine = sim.laneFollow.dirLine;
    const r = _walkDirLine(dirLine, sim.x, sim.y, sim.z, sim.laneFollow.idx, sim.speed * dt);
    sim.x = r.x; sim.y = r.y; sim.z = r.z; if (r.yaw != null) sim.yaw = r.yaw;
    sim.laneFollow.idx = r.idx;
    sim.traveled += r.consumed;
    if (r.ranOut) {
      if (_continueLaneFollowAtFork(sim)) return;
      sim.frozen = true;
      sim.speed = 0;
      sim.target = 0;
      // Under-predicts on purpose when no graph is cached for this town:
      // without it, this preview cannot tell a genuine fork from a road
      // that simply continues, so it stops at the end of the known lane
      // geometry rather than guess which way CARLA's
      // map.get_waypoint(...).next(2.0)[0] walk would turn.
      sim.badge = { icon: '❓', text: 'Pfad ab hier unbekannt — Route/Trajektorie hinzufügen' };
    }
  }

  function _advancePosition(sim, dt) {
    // The vehicle goal latch: nothing moves it again (see _applyEventAction).
    if (sim.goalStopped && !sim.isWalker) { sim.speed = 0; return; }
    if (sim.speed < 0) { _advanceReverse(sim, dt); return; }
    if (sim.waypoints && sim.waypoints.length) { _advanceWaypoints(sim, dt); return; }
    if (sim.speed <= 0) return; // stationary — also the honest state for an
                                 // assign_route with no set_speed yet
    if (sim.isWalker) _advanceStraight(sim, dt);
    else _advanceLaneFollow(sim, dt);
  }

  // ── Reacting ego („Ego bremst", preview only) ──────────────────────────────
  //
  // Off, the preview ego never reacts ("what if the system under test does
  // nothing"). On, it is a
  // simple braking driver: its target (what the events set) is capped by the
  // braking room to anything in its path, to stop REACT_STANDOFF_M short of it,
  // and the controller limits (max_deceleration / max_acceleration) do the
  // actual braking and pulling away, as consider_obstacles does in CARLA. That
  // shows whether a conflict is avoidable at all. CARLA's scripted ego does
  // its own obstacle braking (consider_obstacles); this is not a model of it.
  // The commanded speed lives in `target`, the driven one in `speed`, so the
  // event logic above never sees the brake.
  const REACT_PLAN_DECEL = 6.0;     // m/s², what it plans a stop with
  const REACT_STANDOFF_M = 2.0;     // bumper gap it stops at
  const REACT_LOOKAHEAD_M = 60;
  let _reactiveEgo = false;
  let _staticObstacles = [];        // [{x, y, len, wid}] for the run being simulated

  function _footprintOf(type, prop) {
    if (type === 'prop') {
      const ps = window.PropCatalog?.planSize ? PropCatalog.planSize(prop) : null;
      return { len: ps?.len || 1, wid: ps?.wid || 1 };
    }
    const sz = MapView.actorSize(type) || { w: 4.5, h: 2.1 };
    return { len: sz.w, wid: sz.h || sz.w };
  }

  /** The speed the reacting ego may drive this tick: braking room to the
   * nearest thing in its path, Infinity when the path is clear. */
  function _egoAllowedSpeed(ego) {
    const p = _pose(ego);
    const rad = (ego.yaw || 0) * Math.PI / 180;
    const cx = Math.cos(rad), cy = Math.sin(rad);
    const me = _footprintOf(ego.body || 'ego');
    let gapMin = Infinity;
    const consider = (x, y, len, wid) => {
      const dx = x - p.x, dy = y - p.y;
      const lon = dx * cx + dy * cy;
      const lat = -dx * cy + dy * cx;
      if (lon <= 0 || lon > REACT_LOOKAHEAD_M) return;
      // Its extent across the ego's path, whatever its heading: conservative.
      if (Math.abs(lat) > me.wid / 2 + Math.max(len, wid) / 2 + 0.3) return;
      gapMin = Math.min(gapMin, lon - me.len / 2 - Math.min(len, wid) / 2);
    };
    for (const o of _simActors.values()) {
      if (o === ego) continue;
      const q = _pose(o);
      const fp = _footprintOf(o.body || o.type);
      consider(q.x, q.y, fp.len, fp.wid);
    }
    for (const o of _staticObstacles) consider(o.x, o.y, o.len, o.wid);
    if (!Number.isFinite(gapMin)) return Infinity;
    return Math.sqrt(Math.max(0, 2 * REACT_PLAN_DECEL * (gapMin - REACT_STANDOFF_M)));
  }

  /** The reacting ego's speed cap this tick: its commanded target, held under
   * the braking room to the nearest thing in its path. Like consider_obstacles,
   * it only lowers the target; the controller limits then do the braking. */
  function _reactEgoTarget(sim) {
    const want = Math.min(sim.target, _egoAllowedSpeed(sim));
    const braking = want < sim.target - 0.3;
    if (braking && !sim.reactBadge) {
      sim.reactBadge = true;
      sim.badge = { icon: '⏹', text: 'Ego bremst — Hindernis im Fahrweg' };
    } else if (!braking && sim.reactBadge) {
      sim.reactBadge = false;
      if (sim.badge && sim.badge.text.startsWith('Ego bremst')) sim.badge = null;
    }
    return want;
  }

  function _stepActor(sim, dt, egoPrevPos, simTime) {
    if (sim.frozen) return;

    if (sim.hasNoEvents) {
      // events: [] — no Act is emitted for this actor at all, so the Init
      // <SpeedAction> is the only speed command it ever receives: it holds its
      // start speed for the whole scenario, or stands still at 0. Badged once
      // so an actor that never reacts to anything reads as authored, not broken.
      if (!sim.noEventsBadgeShown) {
        sim.noEventsBadgeShown = true;
        sim.badge = sim.target > 0
          ? { icon: '▶', text: 'Kein Event — fährt nur mit Startgeschwindigkeit' }
          : { icon: '⏸', text: 'Kein Event — steht still' };
      }
    } else {
      for (const ev of sim.events) {
        if (sim.fired.has(ev.id)) continue;
        if (_triggerSatisfied(ev.trigger, sim, egoPrevPos, simTime)) {
          _applyEventAction(sim, ev, simTime);
        }
      }
      // ChangeActorTargetSpeed.update(), replayed: a RELATIVE target is
      // re-sampled on EVERY tick and BEFORE the duration test, so the final
      // tick of the window still tracks and the controller then holds that
      // last tracked value forever. `continuous` governs only whether duration
      // is allowed to end the atomic at all, and the editor always exports
      // continuous='false' — so this is a bounded follow, not a permanent one.
      // The distance dimension isn't produced by the UI (the Dynamik toggle
      // offers Zeit and Rate only), so a legacy/hand-edited file with it never
      // completes via duration here and simply tracks until overwritten —
      // closer to the real atomic than the old frozen initial sample was.
      // 'rate' is the one branch that is NOT a hold: it ramps and ends on
      // arrival, so duration/distance never get a look-in (if/elif upstream).
      if (sim.activeSpeedEventId) {
        const rec = sim.fired.get(sim.activeSpeedEventId);
        if (rec && rec.completedAt == null) {
          if (sim.speedRelativeRef && !sim.goalStopped) sim.target = _relativeTarget(sim);
          if (sim.speedEventDimension === 'rate') {
            // commanded = start ± rate·elapsed, clamped at the target. Not
            // clamped to ≥0 — the target already bounds it, and a negative
            // relative target is deliberately left unclamped (as in the atomic).
            const elapsed = simTime - rec.firedAt;
            const sign = sim.speedRampTarget >= sim.speedRampFrom ? 1 : -1;
            const ramped = sim.speedRampFrom + sign * sim.speedEventDuration * elapsed;
            const commanded = sign > 0
              ? Math.min(ramped, sim.speedRampTarget)
              : Math.max(ramped, sim.speedRampTarget);
            if (!sim.goalStopped) sim.target = commanded;
            if (commanded === sim.speedRampTarget) rec.completedAt = simTime;
          } else if (sim.speedContinuous) {
            // continuous="true": neither duration nor distance may end it.
          } else if (sim.speedEventDimension === 'time' &&
              simTime - rec.firedAt >= sim.speedEventDuration) {
            rec.completedAt = simTime;
          }
        }
      }
    }

    const want = _reactiveEgo && sim.isEgo ? _reactEgoTarget(sim) : sim.target;
    if (!(sim.goalStopped && !sim.isWalker)) _applyControllerLimits(sim, want, dt);
    const before = sim.traveled;
    _advancePosition(sim, dt);
    _advanceLaneOffset(sim, sim.traveled - before, simTime);
  }

  // ── Simulation lifecycle ──────────────────────────────────────────────────────
  //
  // The whole run is simulated UP FRONT, at CARLA's own fixed 20 Hz tick, and
  // Play only replays the recorded frames. That is what makes the timeline
  // scrubbable: the model is a stateful discrete simulation (fired events,
  // lane-change plans, one-shot triggers, sticky goal stops), so seeking to an
  // arbitrary time would otherwise mean replaying everything up to it — doing
  // that once, at Play, costs tens of milliseconds and buys free seeking.
  // A fixed step is also closer to CARLA than the old rAF-sized one, whose
  // step length depended on the frame rate and the playback speed.

  const SIM_DT_S = 0.05;                 // ScenarioRunner's synchronous 20 Hz tick
  const MAX_SIM_TIME_S = 60.0;           // every Act's MaxSimTime StopTrigger
  const TAIL_AFTER_ACTIVITY_S = 3.0;     // keep this much idle time after the last motion

  let _frames = [];        // [{t, poses: {id: {x,y,z,yaw}}, badges: {id: badge|null}}]
  let _timelineEnd = 0;    // seconds; the last recorded frame's t
  let _markers = [];       // [{t, label, kind}] — event starts and the run's end
  let _endReason = null;   // 'teardown' | 'maxtime' | 'idle'
  let _viewTime = 0;       // the time currently on screen

  function _ensureBadgeLayer() {
    if (_layerSimBadges && _layerSimBadges.isConnected) return;
    const world = document.getElementById('world');
    _layerSimBadges = document.createElementNS(SVG_NS, 'g');
    _layerSimBadges.id = 'layer-sim-badges';
    world.appendChild(_layerSimBadges);
  }

  function _renderBadges(poses, badges) {
    if (!_layerSimBadges) return;
    while (_layerSimBadges.firstChild) _layerSimBadges.removeChild(_layerSimBadges.firstChild);
    for (const [id, badge] of Object.entries(badges || {})) {
      if (!badge || !poses[id]) continue;
      const sim = _simActors.get(id);
      const size = MapView.actorSize(sim ? (sim.body || sim.type) : 'car');
      const yOff = -Math.max(size.w, size.h) / 2 - 4.5;
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('transform', `translate(${poses[id].x},${poses[id].y + yOff})`);
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '1.8');
      text.setAttribute('fill', '#ffd966');
      text.setAttribute('style', 'pointer-events:none; paint-order: stroke; stroke:#1a1a1a; stroke-width:0.35;');
      text.textContent = `${badge.icon} ${badge.text}`;
      g.appendChild(text);
      _layerSimBadges.appendChild(g);
    }
  }

  function _snapshotSpeeds() {
    _tickSpeeds.clear();
    _tickPoses.clear();
    _tickCompleted.clear();
    _tickStarted.clear();
    for (const sim of _simActors.values()) {
      // A magnitude, like CarlaDataProvider.get_velocity — reversing counts positive.
      _tickSpeeds.set(sim.id, Math.abs(sim.speed));
      const p = _pose(sim);
      _tickPoses.set(sim.id, { x: p.x, y: p.y, z: sim.z });
      for (const [eventId, rec] of sim.fired) {
        _tickStarted.set(`${sim.id}::${eventId}`, rec.firedAt);
        if (rec.completedAt != null) _tickCompleted.set(`${sim.id}::${eventId}`, rec.completedAt);
      }
    }
  }

  function _recordFrame(t) {
    const poses = {};
    const badges = {};
    for (const sim of _simActors.values()) {
      const p = _pose(sim);
      poses[sim.id] = { x: p.x, y: p.y, z: sim.z, yaw: sim.yaw };
      badges[sim.id] = sim.badge ? { icon: sim.badge.icon, text: sim.badge.text } : null;
    }
    _frames.push({ t, poses, badges });
  }

  /** A short, human label for an event marker on the timeline. */
  function _markerLabel(sim, ev) {
    const actor = AppState.findById(sim.id);
    const who = actor ? AppState.actorLabel(actor, { short: true }) : sim.id;
    const what = window.EventPanel?.displayName
      ? EventPanel.displayName(ev, sim.events.indexOf(ev)) : (ev.action?.type || ev.id);
    return `${who}: ${what}`;
  }

  /**
   * Steps the prepared _simActors from t = 0 to the end of the run and records
   * one frame per tick. The run ends where ScenarioRunner's would — the ego has
   * driven 500 m, or 60 s have passed (every Act's two StopTrigger groups the
   * preview can model) — or earlier, once nothing has moved and no event has
   * fired for TAIL_AFTER_ACTIVITY_S and none is left that could still fire.
   */
  function _simulateTimeline() {
    _frames = [];
    _markers = [];
    _endReason = 'maxtime';
    const egoSim = _egoId ? _simActors.get(_egoId) : null;
    const seen = new Set();
    let lastActivity = 0;
    _simTime = 0;
    _recordFrame(0);
    while (_simTime < MAX_SIM_TIME_S - 1e-9) {
      _simTime = r3(_simTime + SIM_DT_S);
      const egoPrevPos = egoSim ? { ..._pose(egoSim), z: egoSim.z } : null;
      _snapshotSpeeds();
      for (const sim of _simActors.values()) _stepActor(sim, SIM_DT_S, egoPrevPos, _simTime);
      _recordFrame(_simTime);

      let active = false;
      let pending = false;
      for (const sim of _simActors.values()) {
        if (Math.abs(sim.speed) > 0.05 && !sim.frozen && !sim.goalStopped) active = true;
        for (const ev of sim.events) {
          const rec = sim.fired.get(ev.id);
          if (!rec) {
            if (!ev.trigger.neverFires && !sim.frozen) pending = true;
            continue;
          }
          const key = `${sim.id}::${ev.id}`;
          if (!seen.has(key)) {
            seen.add(key);
            active = true;
            _markers.push({ t: rec.firedAt, label: _markerLabel(sim, ev), kind: 'event' });
          }
        }
      }
      if (active) lastActivity = _simTime;

      if (egoSim && egoSim.traveled >= ACT_TEARDOWN_DISTANCE_M) { _endReason = 'teardown'; break; }
      // An unfired distance_to_ego event still has its 60 s OR-fallback ahead
      // of it, so "pending" keeps the run going to the end in that case — the
      // file really does do something at 60 s.
      if (!pending && _simTime - lastActivity >= TAIL_AFTER_ACTIVITY_S) { _endReason = 'idle'; break; }
    }
    _timelineEnd = _simTime;
    const endText = { teardown: 'Ende — Ego hat 500 m zurückgelegt (Stop-Trigger jedes Acts)',
                      maxtime: 'Ende — 60 s erreicht (MaxSimTime jedes Acts)',
                      idle: 'Ende — nichts bewegt sich mehr, kein Event steht aus' }[_endReason];
    _markers.push({ t: _timelineEnd, label: endText, kind: 'end' });
  }

  function _prepareSimulation() {
    _originals.clear();
    _simActors.clear();
    _tickSpeeds.clear();
    _tickCompleted.clear();
    _tickStarted.clear();
    _egoId = null;

    const actors = [];
    if (AppState.ego) { actors.push(AppState.ego); _egoId = AppState.ego.id; }
    for (const npc of AppState.npcs) actors.push(npc);

    if (actors.length === 0) {
      Toast.warn('Keine Akteure zum Simulieren. Ego oder NPC platzieren.');
      return false;
    }

    for (const actor of actors) {
      _originals.set(actor.id, { x: actor.x, y: actor.y, z: actor.z, yaw: actor.yaw });
      _simActors.set(actor.id, _makeSimActor(actor, actor.id === _egoId));
    }
    _staticObstacles = (AppState.staticObjects || []).map(o => ({ x: o.x, y: o.y, ..._footprintOf('prop', o.prop) }));
    _snapshotSpeeds(); // so an event firing on the very first tick reads real
                       // init speeds rather than an empty map
    _ensureBadgeLayer();
    _simulateTimeline();
    _renderTimelineMarkers();
    return true;
  }

  /** Index of the last frame at or before `t` (frames are SIM_DT_S apart). */
  function _frameIndex(t) {
    return Math.max(0, Math.min(_frames.length - 1, Math.floor(t / SIM_DT_S + 1e-6)));
  }

  function _lerpYaw(a, b, f) {
    const d = ((b - a + 540) % 360) - 180;
    return a + d * f;
  }

  /** Puts the recorded state at time `t` on the map, interpolating between ticks. */
  function _showTime(t) {
    if (!_frames.length) return;
    _viewTime = Math.max(0, Math.min(_timelineEnd, t));
    const i = _frameIndex(_viewTime);
    const a = _frames[i];
    const b = _frames[Math.min(i + 1, _frames.length - 1)];
    const f = b === a ? 0 : Math.max(0, Math.min(1, (_viewTime - a.t) / (b.t - a.t)));
    const poses = {};
    for (const id of Object.keys(a.poses)) {
      const pa = a.poses[id], pb = b.poses[id] || pa;
      poses[id] = {
        x: pa.x + (pb.x - pa.x) * f,
        y: pa.y + (pb.y - pa.y) * f,
        z: pa.z + (pb.z - pa.z) * f,
        yaw: _lerpYaw(pa.yaw, pb.yaw, f),
      };
      AppState.updateById(id, poses[id]);
    }
    _renderBadges(poses, a.badges);
    _renderTimelineHead();
  }

  function _fmtTime(t) { return `${t.toFixed(1)} s`; }

  // Listeners on the preview's time (eventTimeline.js's playhead): called with
  // the view time on every frame shown, and with null when the preview stops.
  const _timeListeners = [];
  function _emitTime(t) {
    for (const fn of _timeListeners) {
      try { fn(t); } catch (err) { console.warn('[simulate] time listener', err); }
    }
  }

  function _renderTimelineHead() {
    _emitTime(_viewTime);
    timeLabel.textContent = `${_fmtTime(_viewTime)} / ${_fmtTime(_timelineEnd)}`;
    const pct = _timelineEnd > 0 ? (_viewTime / _timelineEnd) * 100 : 0;
    progressFill.style.width = `${Math.min(100, pct)}%`;
    progressBar.setAttribute('aria-valuenow', _viewTime.toFixed(1));
    progressBar.setAttribute('aria-valuemax', _timelineEnd.toFixed(1));
  }

  function _renderTimelineMarkers() {
    progressBar.querySelectorAll('.sim-marker').forEach(n => n.remove());
    if (!(_timelineEnd > 0)) return;
    // Several events often fire on the same tick (a chain's first link, every
    // route at t = 0) — one tick mark with all their names in the tooltip.
    const byTick = new Map();
    for (const m of _markers) {
      const key = `${m.kind}:${Math.round(m.t / SIM_DT_S)}`;
      if (!byTick.has(key)) byTick.set(key, { t: m.t, kind: m.kind, labels: [] });
      byTick.get(key).labels.push(m.label);
    }
    for (const m of byTick.values()) {
      if (m.kind === 'end') continue;   // the bar's own right edge says that
      const el = document.createElement('div');
      el.className = `sim-marker sim-marker-${m.kind}`;
      el.style.left = `${(m.t / _timelineEnd) * 100}%`;
      el.title = `${_fmtTime(m.t)} — ${m.labels.join(' · ')}`;
      el.dataset.t = String(m.t);
      progressBar.appendChild(el);
    }
    progressBar.title = `${_markers.find(m => m.kind === 'end')?.label || ''} — `
      + 'klicken oder ziehen zum Springen, ←/→ ±0,5 s (Umschalt ±5 s), Pos1/Ende';
  }

  function _startSimulation() {
    if (_running && !_paused) return;

    if (!_running) {
      /* Finish any half-done placement before the run starts.
       *
       * body.simulating dims the toolbar, but the map SVG stays live for
       * pan/zoom — so an armed tool survived Play, crosshair and all, and the
       * first click on the animating map placed an actor. Clearing the draw
       * flags is also what discards a path that never reached two waypoints
       * (objects.js `_discardIncompletePath`), which is why this must run
       * BEFORE _prepareSimulation() reads the actors: otherwise the preview
       * would simulate an event that no longer exists. It is also before
       * `_running = true`, so the "user picked up a tool" handler below — which
       * only reacts to a flag going truthy — never sees it.
       */
      if (AppState.placementActive) {
        AppState.cancelPlacement();
        Toast.info('Platzierung beendet — Vorschau startet');
      }
      // The preview drives the real actors' poses through AppState.updateById
      // (see _showTime), and _stopSimulation puts the originals back the same
      // way. None of that is an edit: without this a single run would push
      // hundreds of entries and bury the user's actual history.
      UndoStack.suspend();
      if (!_prepareSimulation()) { UndoStack.resume(); return; }
      _viewTime = 0;
      _running = true;
      AppState.select(null);
      document.body.classList.add('simulating');
      btnStop.classList.remove('sim-idle');
    } else if (_viewTime >= _timelineEnd - 1e-6) {
      _viewTime = 0;   // Play at the end replays from the start
    }
    _paused = false;
    _lastFrame = performance.now();

    btnPlay.classList.add('hidden');
    btnPause.classList.remove('hidden');

    _animId = requestAnimationFrame(_tick);
  }

  function _pauseSimulation() {
    if (!_running || _paused) return;
    _paused = true;
    if (_animId) cancelAnimationFrame(_animId);
    _animId = null;

    btnPlay.classList.remove('hidden');
    _setPlayLabel(_viewTime >= _timelineEnd - 1e-6 ? 'Nochmal' : 'Fortsetzen');
    btnPause.classList.add('hidden');
  }

  /** Jumps to time `t`. Starts a paused preview first when none is running. */
  function _seek(t) {
    if (!_running) {
      _startSimulation();
      if (!_running) return;
      _pauseSimulation();
    }
    _showTime(t);
    if (_paused) _setPlayLabel(_viewTime >= _timelineEnd - 1e-6 ? 'Nochmal' : 'Fortsetzen');
  }

  function _stopSimulation() {
    // Balances the suspend() in _startSimulation. Read before the flag is
    // cleared: Stop is also reachable when nothing is running (the editing
    // handler below calls this unconditionally), and resuming then would
    // decrement a suspension this module never took.
    const wasRunning = _running;
    _running = false;
    _paused = false;
    if (_animId) cancelAnimationFrame(_animId);
    _animId = null;

    for (const [id, orig] of _originals) {
      AppState.updateById(id, { x: orig.x, y: orig.y, z: orig.z, yaw: orig.yaw });
    }
    _originals.clear();
    _simActors.clear();
    _frames = [];
    _markers = [];
    _timelineEnd = 0;
    _viewTime = 0;
    if (_layerSimBadges) while (_layerSimBadges.firstChild) _layerSimBadges.removeChild(_layerSimBadges.firstChild);
    progressBar.querySelectorAll('.sim-marker').forEach(n => n.remove());
    progressBar.title = 'Klicken zum Springen — startet die Vorschau angehalten';

    document.body.classList.remove('simulating');
    btnPlay.classList.remove('hidden');
    _setPlayLabel('Abspielen');
    btnPause.classList.add('hidden');
    btnStop.classList.add('sim-idle');
    timeLabel.textContent = '0.0 s';
    progressFill.style.width = '0%';
    _emitTime(null);

    // After the originals are back, so the restore is not recorded either.
    if (wasRunning) UndoStack.resume();

    MapView.renderAllActors();
  }

  function _tick(now) {
    if (!_running || _paused) return;
    const realDt = Math.min(0.25, (now - _lastFrame) / 1000);
    _lastFrame = now;
    _showTime(_viewTime + realDt * _speed);
    if (_viewTime >= _timelineEnd - 1e-6) {
      _pauseSimulation();   // hold the last frame; Play replays
      return;
    }
    _animId = requestAnimationFrame(_tick);
  }

  // ── Event handlers ────────────────────────────────────────────────────────────

  btnPlay.addEventListener('click', _startSimulation);
  btnPause.addEventListener('click', _pauseSimulation);
  btnStop.addEventListener('click', _stopSimulation);

  function _togglePlayPause() {
    if (_running && !_paused) _pauseSimulation();
    else _startSimulation();   // cold start and resume are the same call
  }

  /* Leertaste = Play/Pause, Esc = Stop.
   *
   * Bubble phase, and no stopPropagation: app.js's confirm dialog and
   * dropdown.js's menus both handle Escape on the CAPTURE phase and stop it
   * there, so they preempt this for free. mapView.js is loaded first and runs
   * its own Escape branch before this one — harmless during a run, since
   * _startSimulation has already cleared everything it would clear.
   */
  window.addEventListener('keydown', e => {
    if (window.Confirm?.isOpen) return;
    const t = e.target;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
        t.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === ' ' || e.code === 'Space') {
      // Another handler already claimed it — the scene list's own Space, which
      // locates the focused row.
      if (e.defaultPrevented) return;
      // A control the user TABBED to keeps its own Space: Space on a focused
      // Export means Export. A control merely left focused by an earlier click
      // does not — that is the bug this replaced, where the last-clicked
      // toolbar tile ate every Space and re-armed itself instead of playing.
      // preventDefault below is load-bearing for exactly that case: it is what
      // stops the browser turning this keydown into a click on that button.
      if (UIUtils.keyboardFocused(t)) return;
      if (simControls.classList.contains('hidden')) return;   // no map loaded yet
      e.preventDefault();                                     // and no page scroll
      _togglePlayPause();
      return;
    }

    // ←/→ step through a running preview: 0.5 s, or 5 s with Umschalt. Pauses
    // it first — stepping a moving picture is not stepping.
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && _running) {
      if (e.defaultPrevented) return;
      e.preventDefault();
      if (!_paused) _pauseSimulation();
      const step = (e.shiftKey ? 5 : 0.5) * (e.key === 'ArrowLeft' ? -1 : 1);
      _seek(_viewTime + step);
      return;
    }

    // Pos1/Ende jump to the start / the end of a running preview.
    if ((e.key === 'Home' || e.key === 'End') && _running) {
      if (e.defaultPrevented) return;
      e.preventDefault();
      if (!_paused) _pauseSimulation();
      _seek(e.key === 'Home' ? 0 : _timelineEnd);
      return;
    }

    // Stops from either state — _paused implies _running.
    if (e.key === 'Escape' && _running &&
        document.getElementById('shortcuts-overlay')?.classList.contains('hidden')) {
      _stopSimulation();
      Toast.info('Vorschau beendet');
    }
  });

  speedSlider.addEventListener('input', () => {
    _speed = parseFloat(speedSlider.value);
    // 0.25× / 0.5× / 1× / 1.75× — no trailing zeros, so the label stops jumping width.
    speedLabel.textContent = `${parseFloat(_speed.toFixed(2))}×`;
  });

  // ── Scrubbing ───────────────────────────────────────────────────────────────
  // The run is recorded up front (_simulateTimeline), so seeking is a frame
  // lookup. Dragging pauses playback and resumes it on release if it was
  // playing; a click on the bar with no preview running starts one, paused.

  function _timeAtPointer(e) {
    const r = progressBar.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
    return f * _timelineEnd;
  }

  progressBar.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (!_running) _seek(0);            // simulate first, so _timelineEnd is known
    if (!_running) return;
    const resume = !_paused;
    _pauseSimulation();
    progressBar.setPointerCapture(e.pointerId);
    progressBar.classList.add('scrubbing');
    // A press on an event tick lands exactly on the event, not on the pixel.
    const tick = e.target.closest?.('.sim-marker');
    _seek(tick ? parseFloat(tick.dataset.t) : _timeAtPointer(e));
    const move = ev => _seek(_timeAtPointer(ev));
    const up = () => {
      progressBar.removeEventListener('pointermove', move);
      progressBar.removeEventListener('pointerup', up);
      progressBar.removeEventListener('pointercancel', up);
      progressBar.classList.remove('scrubbing');
      if (resume && _viewTime < _timelineEnd - 1e-6) _startSimulation();
    };
    progressBar.addEventListener('pointermove', move);
    progressBar.addEventListener('pointerup', up);
    progressBar.addEventListener('pointercancel', up);
  });

  // Stop simulation if user interacts with editing tools
  AppState.on('change', patch => {
    if (_running && ('activeTool' in patch || 'trajectoryMode' in patch || 'routeMode' in patch)) {
      if (AppState.activeTool || AppState.trajectoryMode || AppState.routeMode) {
        _stopSimulation();
        Toast.info('Simulation beendet — Bearbeitung fortgesetzt');
      }
    }
  });

  /**
   * The point list an assign_route actor is actually driven along: the cached
   * lane graph routed between the authored waypoints (LaneGraph.route, a port
   * of GlobalRoutePlanner.trace_route) and then filtered exactly as
   * ChangeActorWaypoints filters it. Returns null when the town has no lane
   * graph or the very first lane lookup fails.
   *
   * `rawPoints` defaults to the event's own waypoints. mapView.js draws this
   * instead of the straight chords between the clicks — the clicks are where
   * the route must PASS, not the shape it takes to get there, and a straight
   * line between two of them crosses buildings and oncoming lanes it will
   * never touch. It caches the result, because this walks every lane segment
   * on the map once per authored waypoint and renderAllActors runs per frame
   * during a drag.
   */
  function routeGeometry(actor, ev, rawPoints = null) {
    if (!actor || !ev) return null;
    const points = rawPoints || ev.action?.waypoints || [];
    if (points.length < 2) return null;
    // Through _makeSimActor so the seed sees the same normalized events (and
    // the same initial pose) the preview would; _exactRoute reads only the
    // actor's position off it, but building it by hand would be a second,
    // drifting definition of what a sim actor is.
    //
    // ...off the AUTHORED pose, though, never the live one. A running preview
    // rewrites actor.x/y every tick, and leg 0 is seeded from the actor's own
    // position — so computing this from the live pose made the drawn route
    // crawl along underneath the moving vehicle, redrawn every frame. The
    // route is a property of the scenario, not of where the car has got to.
    const sim = _makeSimActor({ ...actor, ...(authoredPose(actor.id) || {}) },
                              actor.type === 'ego');
    return _exactRoute(sim, points);
  }

  /**
   * The pose an actor had before the preview picked it up, or null when no
   * preview is running (in which case the actor's own pose IS the authored
   * one). mapView.js needs it for the same reason routeGeometry does: its
   * cache signature keys on the pose, and a live pose would invalidate the
   * entry on every tick.
   */
  function authoredPose(actorId) {
    if (!_running) return null;
    const orig = _originals.get(actorId);
    return orig ? { x: orig.x, y: orig.y, z: orig.z, yaw: orig.yaw } : null;
  }

  /**
   * The whole preview, run to completion in one call, with no rendering and
   * no writes to AppState — the same _makeSimActor / _stepActor the Play
   * button drives, at a fixed `dt`. Returns
   *   { egoId, dt, times: [t…], tracks: {actorId: [{x, y, speed}…]},
   *     fired: {actorId: {eventId: firedAt}}, ended: 'teardown'|'time'|'stopped' }
   * or null while a live preview is running (the two share this module's
   * tick state). scenarioGenerator.js measures conflicts off the tracks.
   */
  function runHeadless({ dt = 0.05, maxTime = 40, ego = AppState.ego, npcs = AppState.npcs,
                         reactiveEgo = false, props = [], stopWhenIdle = false } = {}) {
    // `ego`/`npcs` default to the editor's scenario; the generator passes a
    // candidate it has not loaded, so it can score one before committing it.
    // _makeSimActor reads only the actor it is given, and cross-actor lookups
    // go through _simActors, so nothing here needs the candidate in AppState.
    if (_running) return null;
    const actors = [ego, ...npcs].filter(Boolean);
    if (!actors.length) return null;
    const savedTime = _simTime;
    // Scoring wants the ego that does nothing, whatever the preview's switch says.
    const savedReact = _reactiveEgo;
    _reactiveEgo = !!reactiveEgo;
    const savedStatic = _staticObstacles;
    _staticObstacles = (props || []).map(o => ({ x: o.x, y: o.y, ..._footprintOf('prop', o.prop) }));
    _simActors.clear();
    _tickSpeeds.clear();
    _tickCompleted.clear();
    _tickStarted.clear();
    _egoId = ego ? ego.id : null;
    try {
      for (const a of actors) _simActors.set(a.id, _makeSimActor(a, a.id === _egoId));
      _snapshotSpeeds();
      const egoSim = _egoId ? _simActors.get(_egoId) : null;
      const times = [];
      const tracks = {};
      for (const id of _simActors.keys()) tracks[id] = [];
      let ended = 'time';
      let still = 0;
      const frozenAt = {};
      // stopWhenIdle ends the run where the preview's own timeline does
      // (_simulateTimeline): nothing moved and no event fired for
      // TAIL_AFTER_ACTIVITY_S, and none is left that could still fire. The
      // Ablauf panel asks for it so its axis matches the preview bar's; the
      // generator's scoring keeps the old rule.
      const seen = new Set();
      let lastActivity = 0;
      for (_simTime = 0; _simTime < maxTime;) {
        _simTime += dt;
        const egoPrevPos = egoSim ? { ..._pose(egoSim), z: egoSim.z } : null;
        _snapshotSpeeds();
        for (const sim of _simActors.values()) _stepActor(sim, dt, egoPrevPos, _simTime);
        times.push(r3(_simTime));
        let moving = false;
        for (const sim of _simActors.values()) {
          const p = _pose(sim);
          tracks[sim.id].push({ x: p.x, y: p.y, speed: sim.speed });
          if (sim.frozen && frozenAt[sim.id] == null) frozenAt[sim.id] = r3(_simTime);
          if (Math.abs(sim.speed) > 0.05 && !sim.frozen && !sim.goalStopped) moving = true;
        }
        if (egoSim && egoSim.traveled >= ACT_TEARDOWN_DISTANCE_M) { ended = 'teardown'; break; }
        if (stopWhenIdle) {
          let active = moving;
          let pending = false;
          for (const sim of _simActors.values()) {
            for (const ev of sim.events) {
              if (!sim.fired.has(ev.id)) {
                if (!ev.trigger.neverFires && !sim.frozen) pending = true;
              } else if (!seen.has(`${sim.id}::${ev.id}`)) {
                seen.add(`${sim.id}::${ev.id}`);
                active = true;
              }
            }
          }
          if (active) lastActivity = _simTime;
          if (!pending && _simTime - lastActivity >= TAIL_AFTER_ACTIVITY_S) { ended = 'idle'; break; }
          continue;
        }
        // Everything has been standing still for 10 s and no event can still
        // move it before the distance fallback — nothing more will happen.
        still = moving ? 0 : still + dt;
        if (still > 10 && _simTime > DISTANCE_TO_EGO_FALLBACK_S) { ended = 'stopped'; break; }
      }
      const fired = {};
      const completed = {};  // actorId -> eventId -> completedAt (absent while still running)
      const frozen = {};   // actorId -> the badge it froze with (lane ran out, no successor, …)
      for (const sim of _simActors.values()) {
        fired[sim.id] = {};
        completed[sim.id] = {};
        for (const [eventId, rec] of sim.fired) {
          fired[sim.id][eventId] = r3(rec.firedAt);
          if (rec.completedAt != null) completed[sim.id][eventId] = r3(rec.completedAt);
        }
        if (sim.frozen) frozen[sim.id] = sim.badge ? sim.badge.text : 'frozen';
      }
      return { egoId: _egoId, dt, times, tracks, fired, completed, frozen, frozenAt, ended };
    } finally {
      _simActors.clear();
      _tickSpeeds.clear();
      _tickCompleted.clear();
      _tickStarted.clear();
      _egoId = null;
      _simTime = savedTime;
      _reactiveEgo = savedReact;
      _staticObstacles = savedStatic;
    }
  }

  const r3 = v => Math.round(v * 1000) / 1000;

  window.Simulate = {
    runHeadless,
    // The generator stops a running preview before it replaces the scenario:
    // runHeadless refuses to run beside it, and the preview's Stop would then
    // try to put back poses on actors that no longer exist.
    get running() { return _running; },
    get reactiveEgo() { return _reactiveEgo; },
    // Jump the preview to time t (starting it paused if none runs) — the
    // event timeline's block click (eventTimeline.js).
    seek(t) { _seek(t); },
    stop() { if (_running) _stopSimulation(); },
    pause() { _pauseSimulation(); },
    play() { _startSimulation(); },
    get paused() { return _paused; },
    get time() { return _running ? _viewTime : null; },
    get end() { return _running ? _timelineEnd : null; },
    /** fn(t) on every shown frame, fn(null) on Stop. */
    onTime(fn) { _timeListeners.push(fn); },
    // routeForTesting exists purely for tests/test_route_fidelity_e2e.py: it
    // returns the route without running the animation. Asserting on the route
    // directly is deterministic, whereas sampling a moving actor can only ever
    // catch a reversal that happens to straddle two samples.
    routeForTesting(actor) {
      const sim = _makeSimActor(actor, actor.type === 'ego');
      const ev = (sim.events || []).find(e => e.action && e.action.type === 'assign_route');
      if (!ev) return null;
      return _exactRoute(sim, ev.action.waypoints || []);
    },
    routeGeometry,
    authoredPose,
  };
})();
