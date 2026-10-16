/**
 * generatorParams.js — the editable parameters per type and the TYPES table.
 *
 * Part of the scenario generator; the design is described in scenarioGenerator.js.
 */
(() => {
  'use strict';

  const {
    _leadBrake,
    _slowLead,
    _pullOut,
    _cutIn,
    _rearApproach,
    _vruCrossing,
    _turnVru,
    JUNCTION_LAYOUTS,
    _junctionConflict,
    _obstacle,
    _oncomingDrift,
    _cutOut,
    _cyclistAhead,
  } = GeneratorCore.shared;

  // ── Editable parameters per type (the recipe panel) ──────────────────────────
  // `key` is the _p() pin key and the key in the build's `params`. Ranges are the generator's
  // own draw ranges; outside them the site checks fail more often than not.
  const num = (key, label, unit, min, max, step) => ({ key, label, unit, kind: 'num', min, max, step });
  const bool = (key, label) => ({ key, label, kind: 'bool' });
  const choice = (key, label, options) => ({ key, label, kind: 'choice', options });
  const VEHICLE_OPTS = [
    ['car', 'Auto'],
    ['van', 'Transporter'],
    ['truck', 'Lkw'],
    ['bus', 'Bus'],
    ['motorcycle', 'Motorrad'],
  ];
  const SIDE_OPTS = [
    ['right', 'rechts'],
    ['left', 'links'],
  ];
  const EGO_SPEED = num('ego_speed', 'Ego-Tempo', 'm/s', 5, 20, 0.5);
  const PARAMS = {
    lead_brake: [
      choice('lead_type', 'Vorausfahrzeug', VEHICLE_OPTS),
      num('lead_speed', 'Tempo', 'm/s', 2, 14, 0.5),
      num('brake_headway_s', 'Bremst bei', 's Abstand', 1, 3, 0.1),
      num('decel', 'Verzögerung', 'm/s²', 2.5, 8, 0.5),
      num('end_speed', 'Bremst auf', 'm/s', 0, 4, 0.5),
      num('hold_s', 'Hält', 's', 1, 10, 0.5),
      bool('resumes', 'Fährt wieder an'),
    ],
    slow_lead: [
      choice('lead_type', 'Vorausfahrzeug', VEHICLE_OPTS),
      num('lead_speed', 'Tempo', 'm/s', 1, 11, 0.5),
      num('initial_gap_m', 'Vorsprung', 'm', 30, 100, 1),
      num('lateral_m', 'Seitlich versetzt', 'm', 0, 1.2, 0.1),
      choice('side', 'Seite', SIDE_OPTS),
    ],
    cut_in: [
      choice(
        'npc_type',
        'Fahrzeug',
        VEHICLE_OPTS.filter(([k]) => k !== 'bus'),
      ),
      num('npc_speed', 'Tempo', 'm/s', 3, 10, 0.5),
      num('trigger_m', 'Schert ein bei', 'm', 8, 26, 1),
      num('lane_change_m', 'Spurwechsel über', 'm', 10, 22, 1),
      bool('brakes_after', 'Bremst danach'),
    ],
    vru_crossing: [
      choice('vru_type', 'Person', [
        ['pedestrian', 'Fußgänger'],
        ['child', 'Kind'],
        ['cyclist', 'Radfahrer'],
      ]),
      num('speed', 'Tempo', 'm/s', 0.8, 6, 0.1),
      choice('from', 'Kommt von', SIDE_OPTS),
      num('arrival_offset_s', 'Zeitversatz', 's', -0.5, 0.8, 0.05),
      bool('occluded', 'Verdeckt (parkendes Fahrzeug)'),
      num('stops_in_lane_s', 'Bleibt stehen', 's (0 = nein)', 0, 4, 0.5),
    ],
    turn_vru: [
      choice('turn', 'Ego biegt ab', [
        ['left', 'links'],
        ['right', 'rechts'],
      ]),
      choice('vru_type', 'Person', [
        ['pedestrian', 'Fußgänger'],
        ['child', 'Kind'],
        ['cyclist', 'Radfahrer'],
      ]),
      num('speed', 'Tempo', 'm/s', 0.8, 6, 0.1),
      choice('from', 'Kommt von', SIDE_OPTS),
      num('arrival_offset_s', 'Zeitversatz', 's', -0.5, 0.8, 0.05),
      num('stops_in_lane_s', 'Bleibt stehen', 's (0 = nein)', 0, 4, 0.5),
    ],
    pull_out: [
      choice('npc_type', 'Fahrzeug', [
        ['car', 'Auto'],
        ['van', 'Transporter'],
        ['truck', 'Lkw'],
      ]),
      num('npc_speed', 'Tempo', 'm/s', 3, 12, 0.5),
      num('arrival_offset_s', 'Vorsprung', 's', 0.3, 2, 0.1),
    ],
    junction_conflict: [
      choice('layout', 'Konstellation', [
        ...Object.entries(JUNCTION_LAYOUTS).map(([k, v]) => [k, v.label]),
        ['other', 'Andere'],
      ]),
      choice('npc_from', 'Kommt von', [
        ['left', 'links'],
        ['right', 'rechts'],
        ['oncoming', 'vorn (Gegenverkehr)'],
      ]),
      choice('npc_type', 'Fahrzeug', [
        ...VEHICLE_OPTS.filter(([k]) => k !== 'bus'),
        ['police', 'Polizei'],
        ['ambulance', 'Rettungswagen'],
      ]),
      num('npc_speed', 'Tempo', 'm/s', 7, 13, 0.5),
      num('arrival_offset_s', 'Zeitversatz', 's', -0.6, 0.8, 0.05),
    ],
    obstacle: [
      choice('variant', 'Art', [
        ['cargo', 'Ladung'],
        ['workzone', 'Baustelle'],
        ['breakdown', 'Pannenfahrzeug'],
        ['stationary_vru', 'Stehende Person / Rad'],
        ['queue', 'Stehende Kolonne'],
      ]),
      choice('site', 'Ort', [
        ['straight', 'Gerade'],
        ['curve', 'Kurve'],
      ]),
      choice('side', 'Seite', SIDE_OPTS),
      choice('vehicle_type', 'Fahrzeug', [...VEHICLE_OPTS.filter(([k]) => k !== 'bus')]),
      choice('vru_type', 'Person', [
        ['pedestrian', 'Fußgänger'],
        ['child', 'Kind'],
        ['cyclist', 'Radfahrer'],
      ]),
      num('lateral_m', 'Seitlich versetzt', 'm', 0, 1.5, 0.1),
      choice('facing', 'Ausrichtung', [
        ['same', 'Fahrtrichtung'],
        ['oncoming', 'entgegen'],
      ]),
    ],
    oncoming_drift: [
      choice('style', 'Art', [
        ['swing', 'Schwenk (Route)'],
        ['offset', 'Spurversatz'],
      ]),
      choice(
        'npc_type',
        'Fahrzeug',
        VEHICLE_OPTS.filter(([k]) => k !== 'bus'),
      ),
      num('npc_speed', 'Tempo', 'm/s', 8, 14, 0.5),
      num('offset_m', 'Ausschwenken', 'm', 1.2, 2.8, 0.1),
      num('hold_m', 'Bleibt drüben', 'm', 0, 6, 0.5),
      num('return_ttc_s', 'Lenkt zurück', 's vorher (0 = nie)', 0, 1.2, 0.1),
      num('arrival_offset_s', 'Zeitversatz', 's', -0.4, 0.6, 0.05),
      choice('cause', 'Grund', [
        ['none', 'keiner'],
        ['parked', 'parkendes Fahrzeug'],
      ]),
    ],
    rear_approach: [
      choice('npc_type', 'Fahrzeug', [
        ['car', 'Auto'],
        ['van', 'Transporter'],
        ['motorcycle', 'Motorrad'],
        ['truck', 'Lkw'],
      ]),
      choice('side', 'Ego wechselt nach', SIDE_OPTS),
      num('speed_diff', 'Schneller als Ego', 'm/s', 3, 8, 0.5),
      num('gap_at_change_m', 'Abstand beim Wechsel', 'm', 2, 12, 0.5),
      num('lane_change_m', 'Spurwechsel über', 'm', 12, 20, 1),
    ],
    cut_out: [
      choice('lead_type', 'Vorausfahrzeug', [
        ['car', 'Auto'],
        ['van', 'Transporter'],
        ['truck', 'Lkw'],
      ]),
      choice('stopped_type', 'Stehendes Fahrzeug', [
        ['car', 'Auto'],
        ['van', 'Transporter'],
        ['truck', 'Lkw'],
      ]),
      num('headway_s', 'Folgeabstand', 's', 0.9, 2, 0.1),
      num('lane_change_m', 'Spurwechsel über', 'm', 8, 14, 1),
      num('cut_margin_m', 'Reserve', 'm', 1.5, 10, 0.5),
      bool('stopped_drives_off', 'Stehendes fährt an'),
    ],
    cyclist_ahead: [
      num('speed', 'Tempo', 'm/s', 3, 6, 0.5),
      num('initial_gap_m', 'Vorsprung', 'm', 30, 60, 1),
      num('edge_offset_m', 'Randabstand', 'm', 0.8, 1.2, 0.1),
      bool('swerves', 'Schwenkt aus'),
      num('swerve_ttc_s', 'Schwenkt bei', 's', 1.2, 3.5, 0.1),
    ],
  };

  /** Only pins naming one of this type's parameters, coerced and clamped (files may carry anything). */
  function _cleanOverrides(typeKey, raw) {
    if (!raw || !typeKey || !PARAMS[typeKey]) return null;
    const out = {};
    for (const spec of [EGO_SPEED, ...PARAMS[typeKey]]) {
      if (!Object.hasOwn(raw, spec.key)) continue;
      const v = raw[spec.key];
      if (spec.kind === 'num') {
        const n = Number(v);
        if (Number.isFinite(n)) out[spec.key] = Math.min(spec.max, Math.max(spec.min, n));
      } else if (spec.kind === 'bool') {
        out[spec.key] = v === true || v === 'true';
      } else if (spec.options.some(([k]) => k === v)) {
        out[spec.key] = v;
      }
    }
    return Object.keys(out).length ? out : null;
  }

  const TYPES = {
    lead_brake: { label: 'Vorausfahrzeug bremst', build: _leadBrake },
    slow_lead: { label: 'Langsames Fahrzeug voraus', build: _slowLead },
    cut_in: { label: 'Einscheren', build: _cutIn },
    vru_crossing: { label: 'Querende Person', build: _vruCrossing },
    turn_vru: { label: 'Abbiegen, Fußgänger/Rad quert', build: _turnVru },
    junction_conflict: { label: 'Querverkehr Kreuzung', build: _junctionConflict },
    obstacle: { label: 'Hindernis auf Spur', build: _obstacle },
    oncoming_drift: { label: 'Gegenverkehr driftet', build: _oncomingDrift },
    cyclist_ahead: { label: 'Radfahrer voraus', build: _cyclistAhead },
    cut_out: { label: 'Ausscheren vor Stauende', build: _cutOut },
    pull_out: { label: 'Ausparken vor Ego', build: _pullOut },
    rear_approach: { label: 'Spurwechsel, Fahrzeug von hinten', build: _rearApproach },
  };

  GeneratorCore.define({ EGO_SPEED, PARAMS, _cleanOverrides, TYPES });
})();
