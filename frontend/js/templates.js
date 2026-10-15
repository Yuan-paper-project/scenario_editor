/**
 * templates.js — Scenario template definitions and placement flow.
 *
 * A template is one actor plus a pre-filled event chain. Most chains are
 * fixed data (`events`); the ones whose shape depends on WHERE the actor was
 * dropped — how wide the road is that a pedestrian crosses, which driving lane
 * a parked car pulls out into — carry a `build(actor)` instead, which
 * objects.js runs at the click with the actor's final pose. A builder that
 * cannot make sense of the spot (no road to cross, no lane to pull out into)
 * falls back to its `events`, and says so with a toast.
 *
 * `initialSpeed` is the actor's Start (m/s). It defaults to the first
 * set_speed's target for a vehicle and to 0 for everything that must wait for
 * its trigger: an Init <SpeedAction> lands on tick 1, long before any
 * distance trigger, so a crossing pedestrian with a start speed is across the
 * road before the ego is anywhere near it.
 */
(() => {
  'use strict';

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
  const WAYPOINT_CLEARANCE = 0.5; // objects.js SPAWN_CLEARANCE.waypoint
  // SimpleVehicleControl counts a waypoint as reached within 4 m and stops dead
  // on the last one, so a trajectory ending AT the far kerb leaves a cyclist
  // standing 4 m short of it — measured in CARLA (Town01 road 1): stopped in
  // the middle of the oncoming lane. The last vertex goes this far past it.
  const VEHICLE_GOAL_ACCEPT_M = 4.0;

  // Everything a pedestrian is "on the road" for. A sidewalk is the kerb; a
  // lane of type 'none' is the verge.
  const NON_CARRIAGEWAY = new Set(['sidewalk', 'none']);

  class ScenarioTemplateManager {
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

    // ── User templates („Eigene Vorlagen") ───────────────────────────────────
    //
    // An actor's event chain saved by the user, with every position in it
    // stored relative to the actor's pose (x along its heading, y to its
    // right) and every actor reference as '$self' / '$ego'. Stored in this
    // table under `user:N` ids with a build() that maps the chain back onto a
    // new actor's pose, so placement, the „Ablauf aus Template" picker and
    // applyTo() handle them exactly like the built-in templates. Persisted per
    // viewer in localStorage (USER_KEY), shared as a JSON file.

    _loadUserTemplates() {
      let list = [];
      try {
        list = JSON.parse(localStorage.getItem(USER_KEY) || '[]');
      } catch (_) {
        list = [];
      }
      if (!Array.isArray(list)) list = [];
      for (const id of Object.keys(this.templates)) if (id.startsWith('user:')) delete this.templates[id];
      for (const t of list) this._registerUser(t);
    }

    _registerUser(t) {
      if (!t || !t.actorType || !Array.isArray(t.events) || !t.id) return;
      this.templates[t.id] = {
        user: true,
        label: t.label || 'Eigene Vorlage',
        hint: `Eigene Vorlage: ${t.events.length} Event${t.events.length === 1 ? '' : 's'}, Positionen relativ zum Akteur`,
        actorType: t.actorType,
        initialSpeed: t.initialSpeed ?? null,
        stored: t,
        events: [],
        build: (actor) => _fromRelative(t.events, actor),
      };
    }

    userTemplates() {
      return Object.entries(this.templates)
        .filter(([, t]) => t.user)
        .map(([id, t]) => ({ id, ...t.stored }));
    }

    _saveUserTemplates() {
      const list = this.userTemplates();
      try {
        localStorage.setItem(USER_KEY, JSON.stringify(list));
      } catch (_) {
        Toast.warn('Vorlagen konnten im Browser nicht gespeichert werden — als Datei exportieren');
      }
    }

    _nextUserId() {
      let n = 1;
      while (this.templates[`user:${n}`]) n++;
      return `user:${n}`;
    }

    /**
     * Save `actor`'s chain as a user template. Refuses (and says why) when an
     * event names another NPC: that actor will not exist where the template is
     * used. Returns the new id or null.
     */
    saveFromActor(actor, label = null) {
      if (!actor || actor.type === 'ego' || actor.type === 'prop') return null;
      if (!(actor.events || []).length) {
        Toast.warn('Keine Events zum Speichern');
        return null;
      }
      const egoId = AppState.ego?.id;
      const rel = _toRelative(actor, egoId);
      if (rel.foreign.length) {
        Toast.error(`Nicht als Vorlage speicherbar: ${rel.foreign.join(', ')} verweist auf einen anderen Akteur`);
        return null;
      }
      const id = this._nextUserId();
      const kindLabel = AppState.typeLabel(actor.type);
      const n = this.userTemplates().length + 1;
      this._registerUser({
        id,
        label: label || `Eigene Vorlage ${n} (${kindLabel})`,
        actorType: actor.type,
        initialSpeed: actor.initial_speed ?? 0,
        events: rel.events,
        created: new Date().toISOString(),
      });
      this._saveUserTemplates();
      Toast.success(`„${this.templates[id].label}" gespeichert — im Tab Templates unter „Eigene Vorlagen"`);
      return id;
    }

    renameUser(id, label) {
      const t = this.templates[id];
      if (!t?.user || !String(label).trim()) return;
      t.label = String(label).trim();
      t.stored.label = t.label;
      this._saveUserTemplates();
    }

    deleteUser(id) {
      if (!this.templates[id]?.user) return;
      delete this.templates[id];
      this._saveUserTemplates();
    }

    exportUserTemplates() {
      const list = this.userTemplates().map(({ id, ...t }) => t);
      if (!list.length) {
        Toast.info('Keine eigenen Vorlagen zum Exportieren');
        return;
      }
      const blob = new Blob(
        [JSON.stringify({ kind: 'scenario-editor-templates', version: 1, templates: list }, null, 2)],
        { type: 'application/json' },
      );
      ScenarioIO.downloadBlob(blob, 'eigene_vorlagen.json');
    }

    /** Add every template in an exported file (new ids; nothing replaced). */
    importUserTemplates(data) {
      const list = Array.isArray(data) ? data : data?.templates;
      if (!Array.isArray(list)) {
        Toast.error('Keine Vorlagen in dieser Datei');
        return 0;
      }
      let n = 0;
      for (const t of list) {
        if (!t || !t.actorType || !Array.isArray(t.events)) continue;
        this._registerUser({ ...t, id: this._nextUserId() });
        n++;
      }
      this._saveUserTemplates();
      Toast.success(`${n} Vorlage${n === 1 ? '' : 'n'} importiert`);
      return n;
    }

    _userSectionHtml() {
      const rows = this.userTemplates()
        .map(
          (t) => `
        <div class="user-template-row" data-user-template="${t.id}">
          <input type="text" class="user-template-name" value="${_attr(t.label)}" aria-label="Name der Vorlage"
                 title="Umbenennen">
          <button class="template-action-button event-action-button user-template-place" type="button"
                  data-template-action="${t.id}" title="${_attr(this.templates[t.id].hint)} — Akteur auf der Karte platzieren">Platzieren</button>
          <button class="user-template-del" type="button" data-user-template-del="${t.id}" title="Vorlage löschen">✕</button>
        </div>`,
        )
        .join('');
      const empty = rows
        ? ''
        : '<p class="templates-hint">Noch keine. Einen Akteur mit Events auswählen und im Events-Bereich „Als Vorlage speichern".</p>';
      return `
        <div class="collapsible-section">
          <button class="collapsible-header" type="button" data-collapse-target="template-user-body">
            <span>Eigene Vorlagen</span><span class="collapse-indicator">-</span>
          </button>
          <div id="template-user-body" class="collapsible-body">
            ${empty}${rows}
            <div class="user-template-io">
              <button type="button" class="btn btn-small btn-secondary" data-user-template-export>Exportieren</button>
              <label class="btn btn-small btn-secondary">Importieren
                <input type="file" accept=".json,application/json" data-user-template-import hidden></label>
            </div>
          </div>
        </div>`;
    }

    renderPanel() {
      return `
        <div class="templates-panel">
          <p class="templates-hint">Template wählen, dann Akteur auf der Karte platzieren. Wege und Dauern werden am Klickpunkt aus der Straße berechnet. <a class="help-link" href="/static/help.html#templates" target="_blank" rel="noopener" title="Handbuch: Templates" aria-label="Handbuch: Templates">?</a></p>
          ${this._generatorSectionHtml()}
          ${this._userSectionHtml()}
          ${this._sectionHtml('template-auto-body', 'Auto · Spur & Position', [
            this._buttonHtml('Spurwechsel links', 'vehicle-lane-change-left'),
            this._buttonHtml('Spurwechsel rechts', 'vehicle-lane-change-right'),
            this._buttonHtml('Einscheren', 'vehicle-cut-in'),
            this._buttonHtml('Schlenker links', 'vehicle-lane-drift'),
            this._buttonHtml('Ausparken', 'vehicle-pull-out'),
            this._buttonHtml('Pannenfahrzeug', 'vehicle-parked'),
          ])}
          ${this._sectionHtml('template-auto-speed-body', 'Auto · Tempo', [
            this._buttonHtml('Beschleunigen', 'vehicle-accelerating'),
            this._buttonHtml('Bremsen', 'vehicle-braking'),
            this._buttonHtml('Stoppen', 'vehicle-stopping'),
            this._buttonHtml('Stop-and-Go', 'vehicle-stop-and-go'),
            this._buttonHtml('Notbremsung', 'vehicle-emergency-brake'),
          ])}
          ${this._sectionHtml('template-pedestrian-body', 'Fußgänger', [
            this._buttonHtml('Überqueren', 'pedestrian-crossing'),
            this._buttonHtml('Bleibt stehen', 'pedestrian-stop-in-lane'),
            this._buttonHtml('Am Rand entlang', 'pedestrian-along-lane'),
            this._buttonHtml('Kind läuft raus', 'child-runs-out'),
          ])}
          ${this._sectionHtml('template-cyclist-body', 'Radfahrer', [
            this._buttonHtml('Überqueren', 'cyclist-crossing'),
            this._buttonHtml('Am Rand entlang', 'cyclist-along-lane'),
          ])}
        </div>
      `;
    }

    bindPanel(root) {
      root.querySelectorAll('[data-template-action]').forEach((btn) => {
        btn.addEventListener('click', () => this.startPlacement(btn.dataset.templateAction));
      });
      root.querySelectorAll('[data-generate-here]').forEach((btn) => {
        btn.addEventListener('click', () => ScenarioGenerator.armAt(btn.dataset.generateHere || null));
      });
      const rerender = () => AppState.emit('change', { userTemplates: true });
      root.querySelectorAll('[data-user-template]').forEach((row) => {
        const id = row.dataset.userTemplate;
        row.querySelector('.user-template-name').addEventListener('change', (e) => this.renameUser(id, e.target.value));
        row.querySelector('[data-user-template-del]').addEventListener('click', async (e) => {
          const label = this.templates[id]?.label || '';
          if (!(e.ctrlKey || e.metaKey) && !(await Confirm.show(`Vorlage „${label}" löschen?`))) return;
          this.deleteUser(id);
          rerender();
        });
      });
      root.querySelector('[data-user-template-export]')?.addEventListener('click', () => this.exportUserTemplates());
      root.querySelector('[data-user-template-import]')?.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          this.importUserTemplates(JSON.parse(await file.text()));
        } catch (_) {
          Toast.error('Datei ist kein gültiges JSON');
        }
        rerender();
      });
    }

    /**
     * The generator's conflict types as place-able templates ("Generate
     * here"): unlike the one-actor templates below, each builds a whole
     * scenario — ego, route, conflict actors, green wave — around the clicked
     * spot, with its timing solved against the ego and scored. It REPLACES the
     * scenario, which the button titles say.
     */
    _generatorSectionHtml() {
      const types = (window.ScenarioGenerator && ScenarioGenerator.TYPES) || {};
      const btn = (label, key, title) =>
        `<button class="template-action-button event-action-button" type="button" data-generate-here="${key}" title="${title}">${label}</button>`;
      const buttons = [
        btn('Beliebig', '', 'Zufälliger Konflikttyp an der angeklickten Stelle — ersetzt das Szenario'),
        ...Object.entries(types).map(([key, label]) =>
          btn(
            label,
            key,
            `${label}: ganzes Szenario (Ego, Route, Gegenspieler) um die angeklickte Stelle erzeugen — ersetzt das Szenario`,
          ),
        ),
      ];
      return this._sectionHtml('template-generate-body', 'Konflikt hier erzeugen', buttons);
    }

    startPlacement(templateId) {
      const template = this.templates[templateId];
      if (!template) return;
      AppState.set({
        activeTool: template.actorType,
        pendingTemplate: templateId,
        trajectoryMode: false,
        activeTrajectoryId: null,
        routeMode: false,
        activeRouteId: null,
        activePathEventId: null,
      });
      Toast.info(`${template.label}-Template: Akteur auf der Karte platzieren`);
    }

    /** The event chain for `actor`, built for its pose when the template can. */
    eventsForActor(actor, templateId) {
      const template = this.templates[templateId];
      if (!template || actor?.type !== template.actorType) return [];
      if (template.build) {
        let built = null;
        try {
          built = template.build(actor);
        } catch (err) {
          console.warn('[templates]', err);
        }
        if (built) return built;
        Toast.warn(`${template.label}: keine passende Straße am Klickpunkt — Standardablauf eingesetzt`);
      }
      return template.events.map((ev) => JSON.parse(JSON.stringify(ev)));
    }

    /** The template's Start (m/s), or null when the editor default applies. */
    initialSpeedFor(templateId) {
      const template = this.templates[templateId];
      if (!template) return null;
      if (template.initialSpeed != null) return template.initialSpeed;
      // Vehicles start at the speed their first event sets anyway, so the
      // chain does not open with a jump; walkers and cyclists wait.
      if (MapView.isWalkerType(template.actorType) || template.actorType === 'cyclist') return 0;
      const first = template.events.find((ev) => ev.action.type === 'set_speed');
      return first ? first.action.target.value : 0;
    }

    /**
     * Templates whose chain makes sense on an already-placed actor of this
     * type, for the event panel's "Ablauf aus Template" picker. Vehicle chains
     * go on any vehicle; walker chains (set_speed along the spawn heading) on
     * walkers only — a cyclist is a <Vehicle> and rides along the lane under
     * set_speed — and cyclist chains on cyclists. Never the ego: every chain
     * here waits on distance_to_ego, which on the ego itself is coerced to t=0.
     */
    compatibleWith(actorType) {
      if (!actorType || actorType === 'ego' || actorType === 'prop') return [];
      const kind = _templateKind(actorType);
      return Object.entries(this.templates)
        .filter(([, t]) => _templateKind(t.actorType) === kind)
        .map(([id, t]) => ({ id, label: t.label, hint: t.hint || '' }));
    }

    /**
     * Replaces `actor`'s events with the template's chain, built for its
     * current pose, and sets the template's start speed — one updateById, so
     * one undo entry. Asks first when the actor already has events.
     */
    async applyTo(actor, templateId) {
      const template = this.templates[templateId];
      if (!actor || !template) return false;
      const n = (actor.events || []).length;
      if (
        n &&
        !(await Confirm.show(
          `${n} Event${n === 1 ? '' : 's'} von ${AppState.actorLabel(actor, { short: true })} durch „${template.label}" ersetzen?`,
        ))
      ) {
        return false;
      }
      const current = AppState.findById(actor.id) || actor;
      // eventsForActor matches the template's own type; a van takes a car chain.
      const events = this.eventsForActor({ ...current, type: template.actorType }, templateId);
      const patch = { events };
      const v0 = this.initialSpeedFor(templateId);
      if (v0 != null) patch.initial_speed = v0;
      AppState.updateById(current.id, patch);
      Toast.success(`„${template.label}" auf ${AppState.actorLabel(current, { short: true })} angewendet`);
      return true;
    }

    label(templateId) {
      return this.templates[templateId]?.label || '';
    }

    placementFor(templateId) {
      const placement = this.templates[templateId]?.placement;
      return placement ? JSON.parse(JSON.stringify(placement)) : null;
    }

    // ── Geometry: what is in front of / beside the placed actor ──────────────

    /**
     * Walks from (x, y) along `yawDeg` and reports where the carriageway
     * starts and ends — every lane polygon but sidewalk/verge counts — plus
     * the middle of the first driving lane crossed. Distances in metres from
     * the start. Null when no carriageway lies within CROSSING_SEARCH_M.
     */
    _crossingProfile(x, y, yawDeg) {
      const roads = AppState.mapData?.roads || [];
      const ux = Math.cos((yawDeg * Math.PI) / 180),
        uy = Math.sin((yawDeg * Math.PI) / 180);
      const ex = x + ux * CROSSING_SEARCH_M,
        ey = y + uy * CROSSING_SEARCH_M;
      const bx0 = Math.min(x, ex) - 1,
        bx1 = Math.max(x, ex) + 1;
      const by0 = Math.min(y, ey) - 1,
        by1 = Math.max(y, ey) + 1;
      const polys = [];
      for (const road of roads) {
        for (const lane of road.lanes || []) {
          if (NON_CARRIAGEWAY.has(lane.type) || !lane.polygon || lane.polygon.length < 3) continue;
          let x0 = Infinity,
            x1 = -Infinity,
            y0 = Infinity,
            y1 = -Infinity;
          for (const p of lane.polygon) {
            if (p[0] < x0) x0 = p[0];
            if (p[0] > x1) x1 = p[0];
            if (p[1] < y0) y0 = p[1];
            if (p[1] > y1) y1 = p[1];
          }
          if (x1 < bx0 || x0 > bx1 || y1 < by0 || y0 > by1) continue;
          polys.push({ poly: lane.polygon, type: lane.type, x0, x1, y0, y1 });
        }
      }
      const laneAt = (px, py) => {
        for (const p of polys) {
          if (px < p.x0 || px > p.x1 || py < p.y0 || py > p.y1) continue;
          if (_pointInPoly(px, py, p.poly)) return p;
        }
        return null;
      };
      const STEP = 0.25;
      let entry = null,
        lastInside = null,
        drivingFrom = null,
        drivingTo = null,
        firstDriving = null;
      for (let s = 0; s <= CROSSING_SEARCH_M; s += STEP) {
        const lane = laneAt(x + ux * s, y + uy * s);
        if (lane) {
          if (entry == null) entry = s;
          lastInside = s;
          // The first driving LANE, by identity: two adjacent driving lanes
          // are one span by type, and its middle is the line between them.
          if (drivingTo == null) {
            if (lane.type === 'driving' && drivingFrom == null) {
              drivingFrom = s;
              firstDriving = lane;
            } else if (drivingFrom != null && lane !== firstDriving) drivingTo = s;
          }
        } else {
          if (drivingFrom != null && drivingTo == null) drivingTo = s;
          if (entry != null && s - lastInside > KERB_STEP_M) break; // across and onto the kerb
        }
      }
      // No road, or still on it at the end of the search — heading along the
      // carriageway rather than across it. Neither is a crossing.
      if (entry == null || lastInside >= CROSSING_SEARCH_M - STEP) return null;
      return {
        entry,
        exit: lastInside,
        end: lastInside + KERB_STEP_M,
        drivingMid: drivingFrom != null ? (drivingFrom + (drivingTo ?? lastInside)) / 2 : null,
        ux,
        uy,
      };
    }

    /** set_speed chain that walks a walker across: go, (pause,) go on, stop. */
    _buildWalkerCrossing(actor, speed, triggerM, { pauseS = 0 } = {}) {
      const prof = this._crossingProfile(actor.x, actor.y, actor.yaw || 0);
      if (!prof) return null;
      const hold = (d) => Math.max(0.5, Math.round((d / speed) * 10) / 10);
      const first = { type: 'distance_to_ego', value: triggerM };
      if (pauseS > 0 && prof.drivingMid != null) {
        return [
          this._setSpeedEvent('evt-1', first, speed, hold(prof.drivingMid)),
          this._setSpeedEvent('evt-2', { type: 'after_event', event_id: 'evt-1' }, 0.0, pauseS),
          this._setSpeedEvent(
            'evt-3',
            { type: 'after_event', event_id: 'evt-2' },
            speed,
            hold(prof.end - prof.drivingMid),
          ),
          this._setSpeedEvent('evt-4', { type: 'after_event', event_id: 'evt-3' }, 0.0, 5.0),
        ];
      }
      return [
        this._setSpeedEvent('evt-1', first, speed, hold(prof.end)),
        this._setSpeedEvent('evt-2', { type: 'after_event', event_id: 'evt-1' }, 0.0, 5.0),
      ];
    }

    /** One straight follow_trajectory across the road, kerb to kerb. */
    _buildCyclistCrossing(actor) {
      const prof = this._crossingProfile(actor.x, actor.y, actor.yaw || 0);
      if (!prof) return null;
      const at = (s) => {
        const x = Math.round((actor.x + prof.ux * s) * 10) / 10;
        const y = Math.round((actor.y + prof.uy * s) * 10) / 10;
        const z = Math.round((ObjectsManager.groundZAt(x, y) + WAYPOINT_CLEARANCE) * 100) / 100;
        return { x, y, z, velocity: CYCLE_SPEED };
      };
      // Waypoint 1 is the actor's own pose, exactly as startPathMode seeds it.
      const trajectory = [{ x: actor.x, y: actor.y, z: actor.z ?? 0, velocity: CYCLE_SPEED }];
      const mid = (prof.entry + prof.end) / 2;
      if (mid > 2) trajectory.push(at(mid));
      trajectory.push(at(prof.end + VEHICLE_GOAL_ACCEPT_M));
      return [
        {
          id: 'evt-1',
          trigger: { type: 'distance_to_ego', value: 30 },
          action: { type: 'follow_trajectory', trajectory },
        },
      ];
    }

    /** Cut-in chain, changing lanes toward the side the ego is on. */
    _buildCutIn(actor) {
      const events = this.templates['vehicle-cut-in'].events.map((ev) => JSON.parse(JSON.stringify(ev)));
      const ego = AppState.ego;
      if (!ego) {
        Toast.info('Einscheren: noch kein Ego platziert — Spurwechsel nach rechts angenommen');
        return events;
      }
      // CARLA's frame is left-handed with y down: facing +x, +y is to the RIGHT.
      const yaw = ((actor.yaw || 0) * Math.PI) / 180;
      const cross = Math.cos(yaw) * (ego.y - actor.y) - Math.sin(yaw) * (ego.x - actor.x);
      events[1].action.direction = cross >= 0 ? 'right' : 'left';
      return events;
    }

    /** Route out of the parking spot onto the driving lane beside it. */
    _buildPullOut(actor) {
      const driving = new Set(['driving']);
      // Travel direction from the lane the car stands on, not from its yaw: a
      // hand-placed car need not face the right way, and the lane does.
      const here = ObjectsManager.nearestLaneProjection(
        actor.x,
        actor.y,
        new Set(['driving', 'parking', 'shoulder']),
        12,
      );
      if (!here) return null;
      const yaw = (here.laneYaw * Math.PI) / 180;
      const ax = here.x + Math.cos(yaw) * PULL_OUT_AHEAD_M;
      const ay = here.y + Math.sin(yaw) * PULL_OUT_AHEAD_M;
      const merge = ObjectsManager.nearestLaneProjection(ax, ay, driving, 8);
      if (!merge) return null;
      // Same direction of travel, or the "lane beside it" is the oncoming one.
      const dYaw = Math.abs(((merge.laneYaw - here.laneYaw + 540) % 360) - 180);
      if (dYaw > 60) return null;
      const seed = ObjectsManager.routeWaypointAt(actor.x, actor.y);
      const wp = (x, y, z) => ({
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        z: Math.round((z + WAYPOINT_CLEARANCE) * 100) / 100,
        strategy: 'fastest',
      });
      const waypoints = [{ x: seed.x, y: seed.y, z: seed.z, strategy: 'fastest' }, wp(merge.x, merge.y, merge.z)];
      // On along the road, so the route's end — where the controller stops
      // dead — is not in the middle of the merge. Probed straight ahead and
      // projected back onto a same-direction driving lane, farthest first:
      // a lane's own directionLine ends at its section boundary, often only a
      // few metres on, while the 'fastest' leg in between is routed anyway.
      const mYaw = (merge.laneYaw * Math.PI) / 180;
      for (const ahead of [PULL_OUT_RUN_M, 60, 40, 30, 20]) {
        const c = ObjectsManager.nearestLaneProjection(
          merge.x + Math.cos(mYaw) * ahead,
          merge.y + Math.sin(mYaw) * ahead,
          driving,
          4,
        );
        if (c && Math.abs(((c.laneYaw - merge.laneYaw + 540) % 360) - 180) < 30) {
          waypoints.push(wp(c.x, c.y, c.z));
          break;
        }
      }
      return [
        {
          id: 'evt-1',
          trigger: { type: 'simulation_time', value: 0 },
          action: { type: 'assign_route', route_strategy: 'fastest', waypoints },
        },
        this._setSpeedEvent('evt-2', { type: 'distance_to_ego', value: 30 }, 10.0, 5.0),
      ];
    }

    _sectionHtml(bodyId, title, buttons) {
      return `
        <div class="collapsible-section">
          <button class="collapsible-header" type="button" data-collapse-target="${bodyId}">
            <span>${title}</span><span class="collapse-indicator">-</span>
          </button>
          <div id="${bodyId}" class="collapsible-body">
            <div class="template-action-grid event-action-grid">
              ${buttons.join('')}
            </div>
          </div>
        </div>
      `;
    }

    /** Every button carries its template's `hint` as the hover text. */
    _buttonHtml(label, templateId) {
      const hint = this.templates[templateId]?.hint || '';
      const t = hint ? ` title="${hint.replace(/"/g, '&quot;')}"` : '';
      return `<button class="template-action-button event-action-button" type="button" data-template-action="${templateId}"${t}>${label}</button>`;
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

  function _templateKind(type) {
    if (type === 'cyclist') return 'cyclist';
    if (type === 'pedestrian' || type === 'child') return 'walker';
    return 'vehicle';
  }

  function _pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0],
        yi = poly[i][1],
        xj = poly[j][0],
        yj = poly[j][1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  const USER_KEY = 'scenarioEditor.userTemplates';
  const _attr = (v) =>
    String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const _r1 = (v) => Math.round(v * 10) / 10;
  const _r2 = (v) => Math.round(v * 100) / 100;

  /** (x, y) in the actor's frame: +u along its heading, +v to its right (the
   * map is y-down, so heading +x has its right at +y — the same convention
   * generatorCorridor.js's _lateral uses). */
  function _toFrame(a, x, y) {
    const r = ((a.yaw || 0) * Math.PI) / 180,
      dx = x - a.x,
      dy = y - a.y;
    return { u: _r2(dx * Math.cos(r) + dy * Math.sin(r)), v: _r2(-dx * Math.sin(r) + dy * Math.cos(r)) };
  }
  function _fromFrame(a, u, v) {
    const r = ((a.yaw || 0) * Math.PI) / 180;
    return { x: _r1(a.x + u * Math.cos(r) - v * Math.sin(r)), y: _r1(a.y + u * Math.sin(r) + v * Math.cos(r)) };
  }

  /**
   * An actor's events with positions in its own frame and actor references
   * as '$self' / '$ego'. `foreign` names the events that reference another
   * NPC, which a template cannot carry.
   */
  function _toRelative(actor, egoId) {
    const foreign = [];
    const ref = (id, ev) => {
      if (!id || id === actor.id) return id ? '$self' : id;
      if (id === egoId) return '$ego';
      foreign.push(ev.name || ev.id);
      return id;
    };
    const events = (actor.events || []).map((ev0) => {
      const { collapsed, ...ev } = JSON.parse(JSON.stringify(ev0));
      const t = ev.trigger || {};
      if (t.point) {
        const f = _toFrame(actor, t.point.x, t.point.y);
        t.point = { ...t.point, u: f.u, v: f.v };
        delete t.point.x;
        delete t.point.y;
        delete t.point.z;
      }
      if (t.entity_ref) t.entity_ref = ref(t.entity_ref, ev);
      if (t.actor_ref) {
        if (t.actor_ref === actor.id) delete t.actor_ref;
        else ref(t.actor_ref, ev);
      }
      const a = ev.action || {};
      for (const k of ['trajectory', 'waypoints']) {
        if (Array.isArray(a[k]))
          a[k] = a[k].map((p) => {
            const f = _toFrame(actor, p.x, p.y);
            const { x, y, z, ...rest } = p;
            return { ...rest, u: f.u, v: f.v };
          });
      }
      if (a.target?.entity_ref) a.target.entity_ref = ref(a.target.entity_ref, ev);
      if (a.entity_ref && a.type === 'set_distance') a.entity_ref = ref(a.entity_ref, ev);
      return ev;
    });
    return { events, foreign: [...new Set(foreign)] };
  }

  /** The stored relative chain on `actor`'s pose: positions back in the world
   * (a `fastest` route waypoint re-snapped to a lane, waypoint 0 on the actor
   * like a freshly drawn route's seed), heights from the surface, '$self' /
   * '$ego' back to ids. */
  function _fromRelative(events, actor) {
    const egoId = AppState.ego?.id || null;
    const deref = (id) => (id === '$self' ? actor.id : id === '$ego' ? egoId : id);
    const wpZ = (x, y) => _r2(ObjectsManager.groundZAt(x, y) + WAYPOINT_CLEARANCE);
    return JSON.parse(JSON.stringify(events)).map((ev) => {
      const t = ev.trigger || {};
      if (t.point && t.point.u !== undefined) {
        const w = _fromFrame(actor, t.point.u, t.point.v);
        const { u, v, ...rest } = t.point;
        t.point = { ...rest, x: w.x, y: w.y, z: wpZ(w.x, w.y) };
      }
      if (t.entity_ref) t.entity_ref = deref(t.entity_ref);
      const a = ev.action || {};
      if (Array.isArray(a.trajectory)) {
        a.trajectory = a.trajectory.map(({ u, v, ...rest }) => {
          const w = _fromFrame(actor, u, v);
          return { ...rest, x: w.x, y: w.y, z: wpZ(w.x, w.y) };
        });
      }
      if (Array.isArray(a.waypoints)) {
        a.waypoints = a.waypoints.map(({ u, v, ...rest }, i) => {
          const w = i === 0 ? { x: actor.x, y: actor.y } : _fromFrame(actor, u, v);
          if (i === 0 || (rest.strategy || 'fastest') === 'fastest') {
            const snap = ObjectsManager.routeWaypointAt(w.x, w.y);
            return { ...rest, x: snap.x, y: snap.y, z: snap.z };
          }
          return { ...rest, x: w.x, y: w.y, z: wpZ(w.x, w.y) };
        });
      }
      if (a.target?.entity_ref) a.target.entity_ref = deref(a.target.entity_ref);
      if (a.entity_ref && a.type === 'set_distance') a.entity_ref = deref(a.entity_ref);
      return ev;
    });
  }

  window.ScenarioTemplates = new ScenarioTemplateManager();
  ScenarioTemplates._loadUserTemplates();
})();
