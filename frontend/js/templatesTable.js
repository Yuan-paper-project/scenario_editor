/**
 * templatesTable.js — the shared constants, the built-in template table and the event factories it is built from.
 *
 * Part of ScenarioTemplates; see templates.js. ScenarioTemplateManager is a
 * chain of classes, one per file, each adding its methods to the one before.
 */
(() => {
  'use strict';

  window.TemplatesCore = UIUtils.sharedScope('TemplatesCore');

  // Acceleration/deceleration magnitude (m/s²) shared by every template that
  // ramps. Comfortable-but-brisk; well clear of the 0.1 floor _normalize_actor
  // applies to keep a rate event from never terminating.
  const RAMP_RATE = 5.0;
  const EMERGENCY_DECEL = 8.0; // m/s², a hard but tyre-limited stop
  const CUT_IN_SPEED = 8.0; // m/s, slower than a typical ego so it is caught up
  const CUT_IN_TRIGGER_M = 15; // ego distance (centre to centre) at which it pulls over
  const CUT_IN_LENGTH_M = 12; // lane-change distance; ScenarioRunner's practical minimum is ~12 m
  const WALK_SPEED = 1.4; // m/s, normal adult walking pace
  const CHILD_RUN_SPEED = 3.0; // m/s, a child running out
  const CYCLE_SPEED = 4.0; // m/s, ~14 km/h
  const KERB_STEP_M = 1.5; // how far past the last carriageway lane a crossing ends
  const CROSSING_SEARCH_M = 60; // how far ahead to look for the road at all
  const PULL_OUT_AHEAD_M = 10; // the merge point, ahead of the parked car (NOTES 1.1 #3)
  // Then on along the driving lane, as far as the probe reaches. The route's
  // end is where SimpleVehicleControl stops dead: at 40 m (measured in CARLA,
  // Town03 road 6) the car parked in the ego's lane and the ego closed to 3.5 m.
  const PULL_OUT_RUN_M = 80;
  const WAYPOINT_CLEARANCE = 0.5; // objectsCore.js SPAWN_CLEARANCE.waypoint
  // SimpleVehicleControl counts a waypoint as reached within 4 m and stops dead
  // on the last one, so a trajectory ending AT the far kerb leaves a cyclist
  // standing 4 m short of it — measured in CARLA (Town01 road 1): stopped in
  // the middle of the oncoming lane. The last vertex goes this far past it.
  const VEHICLE_GOAL_ACCEPT_M = 4.0;

  // Everything a pedestrian is "on the road" for. A sidewalk is the kerb; a
  // lane of type 'none' is the verge.
  const NON_CARRIAGEWAY = new Set(['sidewalk', 'none']);

  class TemplatesTable {
    constructor() {
      this.templates = {
        // The four speed-profile templates below ramp rather than step: a
        // 'rate' set_speed ends when the commanded speed REACHES the target
        // (|dv|/rate seconds), so a hold after a ramp has to be a separate
        // 'time' event — see the set_speed dynamics table in CLAUDE.md.
        'vehicle-accelerating': {
          label: 'Beschleunigen',
          hint: 'Fährt mit 10 m/s, beschleunigt nach 5 s mit 5 m/s² auf 15 m/s und hält das Tempo',
          actorType: 'car',
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 400 }, 10.0, 5.0),
            this._speedRampEvent('evt-2', { type: 'after_event', event_id: 'evt-1' }, 15.0, RAMP_RATE),
            this._setSpeedEvent('evt-3', { type: 'after_event', event_id: 'evt-2' }, 15.0, 5.0),
          ],
        },
        'vehicle-braking': {
          label: 'Bremsen',
          hint: 'Fährt mit 10 m/s, bremst nach 5 s mit 5 m/s² auf 5 m/s und fährt so weiter',
          actorType: 'car',
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 400 }, 10.0, 5.0),
            this._speedRampEvent('evt-2', { type: 'after_event', event_id: 'evt-1' }, 5.0, RAMP_RATE),
            this._setSpeedEvent('evt-3', { type: 'after_event', event_id: 'evt-2' }, 5.0, 5.0),
          ],
        },
        'vehicle-stopping': {
          label: 'Stoppen',
          hint: 'Fährt mit 10 m/s, bremst nach 5 s mit 5 m/s² bis zum Stand und bleibt stehen',
          actorType: 'car',
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 400 }, 10.0, 5.0),
            this._speedRampEvent('evt-2', { type: 'after_event', event_id: 'evt-1' }, 0.0, RAMP_RATE),
            this._setSpeedEvent('evt-3', { type: 'after_event', event_id: 'evt-2' }, 0.0, 5.0),
          ],
        },
        'vehicle-stop-and-go': {
          label: 'Stop-and-Go',
          hint: 'Fährt mit 10 m/s, bremst nach 5 s bis zum Stand, steht 1 s, fährt mit 5 m/s wieder an',
          actorType: 'car',
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 400 }, 10.0, 5.0),
            this._speedRampEvent('evt-2', { type: 'after_event', event_id: 'evt-1' }, 0.0, RAMP_RATE),
            this._setSpeedEvent('evt-3', { type: 'after_event', event_id: 'evt-2' }, 0.0, 1.0),
            this._speedRampEvent('evt-4', { type: 'after_event', event_id: 'evt-3' }, 5.0, RAMP_RATE),
            this._setSpeedEvent('evt-5', { type: 'after_event', event_id: 'evt-4' }, 5.0, 2.0),
          ],
        },
        // The AV-test version of "Stoppen": the brake is keyed to the ego
        // closing in, not to a clock, so it lands at the same headway whether
        // the ego is scripted or driven by the stack under test.
        'vehicle-emergency-brake': {
          label: 'Notbremsung',
          hint: 'Bremst mit 8 m/s² bis zum Stand, sobald das Ego 25 m nah ist, steht 3 s, fährt wieder an',
          actorType: 'car',
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 400 }, 10.0, 5.0),
            this._speedRampEvent('evt-2', { type: 'distance_to_ego', value: 25 }, 0.0, EMERGENCY_DECEL),
            this._setSpeedEvent('evt-3', { type: 'after_event', event_id: 'evt-2' }, 0.0, 3.0),
            // ...and pulls away again. Measured in CARLA (Town04 road 40): left
            // standing, it blocked the ego for the rest of the run, the ego's
            // route never completed, and the run only ended on MaxSimTime.
            this._speedRampEvent('evt-4', { type: 'after_event', event_id: 'evt-3' }, 10.0, 3.0),
          ],
        },
        'vehicle-lane-change-left': {
          label: 'Spurwechsel links',
          hint: 'Fährt mit 10 m/s und wechselt nach 5 s auf die linke Nachbarspur — zeitgesteuert, unabhängig vom Ego',
          actorType: 'car',
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 400 }, 10.0, 5.0),
            this._laneChangeEvent('evt-2', { type: 'after_event', event_id: 'evt-1' }, 'left', 15.0),
            this._setSpeedEvent('evt-3', { type: 'after_event', event_id: 'evt-2' }, 10.0, 5.0),
          ],
        },
        'vehicle-lane-change-right': {
          label: 'Spurwechsel rechts',
          hint: 'Fährt mit 10 m/s und wechselt nach 5 s auf die rechte Nachbarspur — zeitgesteuert, unabhängig vom Ego',
          actorType: 'car',
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 400 }, 10.0, 5.0),
            this._laneChangeEvent('evt-2', { type: 'after_event', event_id: 'evt-1' }, 'right', 15.0),
            this._setSpeedEvent('evt-3', { type: 'after_event', event_id: 'evt-2' }, 10.0, 5.0),
          ],
        },
        // The AV-test cut-in: drives in the lane beside the ego's, slower than
        // it, and changes into the ego's lane once the ego is 15 m away — keyed
        // to the ego, not to a clock (the two Spurwechsel templates above fire
        // 5 s after start wherever the ego is). The direction is toward the
        // ego, worked out at the click when one is placed (_buildCutIn).
        'vehicle-cut-in': {
          label: 'Einscheren',
          hint: 'Fährt mit 8 m/s neben dem Ego und wechselt bei 15 m Ego-Abstand in dessen Spur — Richtung zum Ego hin',
          actorType: 'car',
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 400 }, CUT_IN_SPEED, 5.0),
            this._laneChangeEvent(
              'evt-2',
              { type: 'distance_to_ego', value: CUT_IN_TRIGGER_M },
              'right',
              CUT_IN_LENGTH_M,
            ),
          ],
          build: (actor) => this._buildCutIn(actor),
        },
        // A lane_offset never ends on its own and nothing may chain onto it
        // with after_event, so the return is a second offset of 0 on its own,
        // nearer ego-distance trigger — the only way to end one (CLAUDE.md).
        'vehicle-lane-drift': {
          label: 'Schlenker links',
          hint: 'Fährt mit 8 m/s, driftet bei 40 m Ego-Abstand 1,5 m nach links und bei 20 m zurück',
          actorType: 'car',
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 400 }, 8.0, 5.0),
            this._laneOffsetEvent('evt-2', { type: 'distance_to_ego', value: 40 }, 'left', 1.5),
            this._laneOffsetEvent('evt-3', { type: 'distance_to_ego', value: 20 }, 'left', 0.0),
          ],
        },
        // NOTES 1.1 #3: a lane_change never fires from a parking lane (the
        // actor is not on a driving lane yet), so the pull-out is a route —
        // routed waypoints on the driving lane beside it, which the controller
        // drives to from wherever it is parked — released by a set_speed when
        // the ego comes within 30 m. A route alone does not move an actor, so
        // the car waits at the kerb with start speed 0 until then.
        'vehicle-pull-out': {
          label: 'Ausparken',
          hint: 'Steht am Rand (Parkstreifen, Seitenstreifen) und fährt auf die Fahrspur, sobald das Ego 30 m nah ist',
          actorType: 'car',
          initialSpeed: 0,
          placement: {
            snap: 'lane-center',
            laneTypes: ['driving', 'parking', 'shoulder'],
            maxDistance: 12,
          },
          events: [this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 30 }, 10.0, 5.0)],
          build: (actor) => this._buildPullOut(actor),
        },
        // Stationary obstacle: no events at all, so it gets no Act and holds
        // its start speed of 0 for the whole run (CLAUDE.md "events: []").
        'vehicle-parked': {
          label: 'Pannenfahrzeug',
          hint: 'Steht die ganze Zeit still (keine Events, Start 0 m/s) — Hindernis auf der Fahrbahn oder am Rand',
          actorType: 'car',
          initialSpeed: 0,
          placement: {
            snap: 'lane-center',
            laneTypes: ['driving', 'parking', 'shoulder'],
            maxDistance: 12,
          },
          events: [],
        },
        // PedestrianControl walks the SPAWN heading (the editor's road-facing
        // yaw), so a set_speed is enough for a walker to cross. The hold is
        // sized to the road actually in front of it — a fixed 10 s used to
        // stop it mid-carriageway on a wide road and walk it into a wall on a
        // narrow one.
        'pedestrian-crossing': {
          label: 'Fußgänger überqueren',
          hint: 'Geht bei 30 m Ego-Abstand mit 1,4 m/s los, überquert die Straße und bleibt auf der anderen Seite stehen',
          actorType: 'pedestrian',
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 30 }, WALK_SPEED, 10.0),
            this._setSpeedEvent('evt-2', { type: 'after_event', event_id: 'evt-1' }, 0.0, 5.0),
          ],
          // 30 m, not the 50 m this used to have: measured in CARLA (Town01,
          // ego at 7.6 m/s) a 50 m trigger had the walker off the far kerb
          // ~3.5 s before the ego arrived, so the crossing never conflicted.
          // At 1.4 m/s a 30 m trigger puts it in the nearside lane as the ego
          // gets there (≈3–4 s at 8–10 m/s).
          build: (actor) => this._buildWalkerCrossing(actor, WALK_SPEED, 30),
        },
        'pedestrian-stop-in-lane': {
          label: 'Bleibt auf Fahrbahn stehen',
          hint: 'Geht bei 40 m Ego-Abstand los, bleibt 3 s mitten in der ersten Fahrspur stehen und geht dann weiter',
          actorType: 'pedestrian',
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 40 }, WALK_SPEED, 10.0),
            this._setSpeedEvent('evt-2', { type: 'after_event', event_id: 'evt-1' }, 0.0, 5.0),
          ],
          build: (actor) => this._buildWalkerCrossing(actor, WALK_SPEED, 40, { pauseS: 3.0 }),
        },
        'pedestrian-along-lane': {
          label: 'Fußgänger am Rand entlang',
          hint: 'Geht mit 1,4 m/s am Fahrbahnrand entlang, in Fahrtrichtung der nächsten Spur',
          actorType: 'pedestrian',
          placement: { orientation: 'along-lane' },
          events: [this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 400 }, WALK_SPEED, 10.0)],
        },
        'child-runs-out': {
          label: 'Kind läuft auf die Straße',
          hint: 'Kind rennt bei 25 m Ego-Abstand mit 3 m/s über die Straße',
          actorType: 'child',
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 25 }, CHILD_RUN_SPEED, 10.0),
            this._setSpeedEvent('evt-2', { type: 'after_event', event_id: 'evt-1' }, 0.0, 5.0),
          ],
          build: (actor) => this._buildWalkerCrossing(actor, CHILD_RUN_SPEED, 25),
        },
        // A cyclist is a <Vehicle> (it aliases to 'bike'), and
        // SimpleVehicleControl ignores heading and follows the lane — so a
        // set_speed rides it ALONG the road, never across. It needs waypoints,
        // and follow_trajectory is the one path action a cyclist may have
        // (assign_route is vehicle-only). The trajectory's speed comes from its
        // vertex velocities, and its trigger releases it.
        'cyclist-crossing': {
          label: 'Radfahrer überqueren',
          hint: 'Fährt bei 30 m Ego-Abstand mit 4 m/s quer über die Straße (Trajektorie) und hält am anderen Rand',
          actorType: 'cyclist',
          events: [
            this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 30 }, CYCLE_SPEED, 5.0),
            this._setSpeedEvent('evt-2', { type: 'after_event', event_id: 'evt-1' }, 0.0, 5.0),
          ],
          build: (actor) => this._buildCyclistCrossing(actor),
        },
        'cyclist-along-lane': {
          label: 'Radfahrer am Rand entlang',
          hint: 'Fährt mit 4 m/s am Fahrbahnrand entlang, in Fahrtrichtung der nächsten Spur',
          actorType: 'cyclist',
          placement: { orientation: 'along-lane' },
          events: [this._setSpeedEvent('evt-1', { type: 'distance_to_ego', value: 400 }, CYCLE_SPEED, 10.0)],
        },
      };
    }

    _setSpeedEvent(id, trigger, speed, duration) {
      return {
        id,
        trigger,
        action: {
          type: 'set_speed',
          dynamics: { shape: 'step', dimension: 'time', value: duration },
          target: { mode: 'absolute', value: speed },
        },
      };
    }

    /** A ramp: `rate` m/s² until the target is reached, then the event ends. */
    _speedRampEvent(id, trigger, speed, rate) {
      return {
        id,
        trigger,
        action: {
          type: 'set_speed',
          // 'step' + 'rate' is self-contradictory; the backend forces 'linear'
          // for a rate event anyway, so state it here too.
          dynamics: { shape: 'linear', dimension: 'rate', value: rate },
          target: { mode: 'absolute', value: speed },
        },
      };
    }

    _laneChangeEvent(id, trigger, direction, distance) {
      return {
        id,
        trigger,
        action: {
          type: 'lane_change',
          direction,
          dynamics: { shape: 'linear', value: distance },
        },
      };
    }

    _laneOffsetEvent(id, trigger, direction, offset) {
      return { id, trigger, action: { type: 'lane_offset', direction, offset } };
    }
  }

  TemplatesCore.define({
    TemplatesTable,
    CYCLE_SPEED,
    KERB_STEP_M,
    CROSSING_SEARCH_M,
    PULL_OUT_AHEAD_M,
    PULL_OUT_RUN_M,
    WAYPOINT_CLEARANCE,
    VEHICLE_GOAL_ACCEPT_M,
    NON_CARRIAGEWAY,
  });
})();
