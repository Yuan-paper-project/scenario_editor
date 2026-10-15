/* propCatalog.js — CARLA static prop catalogue (presentation side).
 *
 * Mirrors the split already used for vehicles: this file owns everything the
 * editor needs to *show* a prop (label, group, shapes, dimensions), while
 * ../llm-scenario-gen/config/prop_catalog.yaml owns everything the exporter
 * needs to *emit* one (miscObjectCategory, mass, 3D bounding box). The only
 * shared column is the blueprint id; a mismatch fails loudly as a 400 at
 * export, never silently.
 *
 * TWO VIEWS, deliberately:
 *   side — elevation silhouette, used for the palette tiles. A picker icon
 *          should look like the object, and there is no projection to clash
 *          with in a toolbar.
 *   plan — top-down footprint, used for the map marker. The map is a plan
 *          view throughout (roads, lane markings, and vehicle footprints in
 *          mapView._renderActor), and props rotate with yaw the same way
 *          actors do, so their marker has to be plan view too.
 *
 * Dimensions are real metres. `plan.len` runs along local +X (the yaw
 * direction, matching ACTOR_SIZES.w); `plan.wid` runs across it.
 * oriented:false props are rotationally symmetric and get no yaw handle.
 *
 * `facing` is the placement rule, resolved against the OpenDRIVE direction of
 * the SPECIFIC lane nearest the click (objects.js `_propYawFor`). Because
 * map_renderer reverses directionLine for left-side lanes, adjacent lanes of a
 * two-way road yield opposite laneYaw, so an 'oncoming' prop on each side
 * correctly faces its own lane's traffic.
 *   oncoming    — laneYaw + 180, confronts approaching traffic
 *   along       — laneYaw, long axis follows the lane
 *   alongside   — laneYaw or +180, whichever turns the open side toward the road
 *   toward-road — bearing from the prop to the nearest lane point
 *   none        — no rule; yaw 0, still rotatable by hand
 * Independent of `oriented`: a 'none' prop can still have a yaw handle.
 */
(() => {
  'use strict';

  const GROUPS = [
    { id: 'workzone', label: 'Baustelle', color: '#e8801a' },
    { id: 'surface', label: 'Fahrbahn', color: '#a06a2c' },
    { id: 'cargo', label: 'Verlorene Ladung', color: '#b0607a' },
    { id: 'waste', label: 'Abfall & Container', color: '#4d7480' },
    { id: 'street', label: 'Straßenmöbel', color: '#6b7a8f' },
    { id: 'garden', label: 'Garten & Freizeit', color: '#7c9a2a' },
  ];

  /* GENERATED from live CARLA measurements — every number below is measured,
   * not estimated: footprints and heights from bounding_box.extent, `z` from
   * spawning each prop on a road and reading where its mesh actually ends up.
   * ScenarioRunner runs every prop with physics ON, so a mesh whose pivot is
   * not at its base would start with its collision below the road and fall
   * through the world; `z` is the lift that puts its base on the surface.
   * `plan.off` is the mesh centre relative to its pivot in the editor's own
   * frame (+X = yaw) — the container's sits 1.1 m to one side, and drawing it
   * centred put the marker beside the real skip. */
  const PROPS = {
    // ── Baustelle ────────────────────────────────────────
    'static.prop.trafficcone01': {
      label: 'Leitfass',
      group: 'workzone',
      z: 0.0,
      oriented: false,
      facing: 'none',
      side: { kind: 'drum_striped', w: 0.88, h: 1.13 },
      plan: { kind: 'cone', len: 0.88, wid: 0.88 },
    },
    'static.prop.trafficcone02': {
      label: 'Leitpfosten',
      group: 'workzone',
      z: 0.0,
      oriented: false,
      facing: 'none',
      side: { kind: 'delineator', w: 0.46, h: 1.18 },
      plan: { kind: 'cone', len: 0.46, wid: 0.39 },
    },
    'static.prop.constructioncone': {
      label: 'Leitkegel',
      group: 'workzone',
      z: 0.0,
      oriented: false,
      facing: 'none',
      side: { kind: 'cone', w: 0.34, h: 0.59 },
      plan: { kind: 'cone', len: 0.34, wid: 0.34 },
    },
    'static.prop.streetbarrier': {
      label: 'Absperrung',
      group: 'workzone',
      z: 0.0,
      oriented: true,
      facing: 'oncoming',
      planRotate: 90,
      side: { kind: 'jersey', w: 1.21, h: 1.07 },
      plan: { kind: 'barrier', len: 1.21, wid: 0.37 },
    },
    'static.prop.chainbarrier': {
      label: 'Kettensperre',
      group: 'workzone',
      z: 0.0,
      oriented: true,
      facing: 'oncoming',
      side: { kind: 'chain', w: 1.49, h: 0.89 },
      plan: { kind: 'chain', len: 0.24, wid: 1.49, off: [0.0, 0.63] },
    },
    'static.prop.chainbarrierend': {
      label: 'Kettenpfosten',
      group: 'workzone',
      z: 0.0,
      oriented: false,
      facing: 'none',
      side: { kind: 'post', w: 0.24, h: 0.89 },
      plan: { kind: 'drum', len: 0.24, wid: 0.24 },
    },
    'static.prop.trafficwarning': {
      label: 'Warnanhänger',
      group: 'workzone',
      z: 0.0,
      oriented: true,
      facing: 'oncoming',
      planRotate: 90,
      side: { kind: 'arrowboard', w: 2.87, h: 3.57 },
      plan: { kind: 'trailer', len: 2.37, wid: 2.87 },
    },
    'static.prop.warningconstruction': {
      label: 'Bauschild',
      group: 'workzone',
      z: 0.0,
      oriented: true,
      facing: 'oncoming',
      side: { kind: 'signtri', w: 1.31, h: 1.86 },
      plan: { kind: 'panel', len: 0.3, wid: 1.31 },
    },
    'static.prop.warningaccident': {
      label: 'Unfallschild',
      group: 'workzone',
      z: 0.0,
      oriented: true,
      facing: 'oncoming',
      side: { kind: 'signtri_a', w: 1.31, h: 1.86 },
      plan: { kind: 'panel', len: 0.3, wid: 1.31 },
    },
    'static.prop.barrel': {
      label: 'Fass',
      group: 'workzone',
      z: 0.0,
      oriented: false,
      facing: 'none',
      side: { kind: 'barrel', w: 0.47, h: 0.81 },
      plan: { kind: 'drum', len: 0.46, wid: 0.47 },
    },

    // ── Fahrbahn ────────────────────────────────────────
    'static.prop.ironplank': {
      label: 'Stahlplatte',
      group: 'surface',
      z: 0.0,
      oriented: true,
      facing: 'along',
      side: { kind: 'plank', w: 1.45, h: 0.02 },
      plan: { kind: 'plate', len: 1.45, wid: 1.17 },
    },
    'static.prop.dirtdebris01': {
      label: 'Schutt 1',
      group: 'surface',
      z: 0.0,
      oriented: true,
      facing: 'none',
      side: { kind: 'debris', w: 1.86, h: 0.15 },
      plan: { kind: 'blob', len: 1.86, wid: 1.51 },
    },
    'static.prop.dirtdebris02': {
      label: 'Schutt 2',
      group: 'surface',
      z: 0.0,
      oriented: true,
      facing: 'none',
      side: { kind: 'debris', w: 1.86, h: 0.15 },
      plan: { kind: 'blob', len: 1.86, wid: 1.51 },
    },
    'static.prop.dirtdebris03': {
      label: 'Schutt 3',
      group: 'surface',
      z: 0.0,
      oriented: true,
      facing: 'none',
      side: { kind: 'debris', w: 1.86, h: 0.19 },
      plan: { kind: 'blob', len: 1.86, wid: 1.51 },
    },
    'static.prop.creasedbox01': {
      label: 'Pappe klein',
      group: 'surface',
      z: 0.0,
      oriented: true,
      facing: 'none',
      side: { kind: 'flat', w: 0.81, h: 0.12 },
      plan: { kind: 'flat', len: 0.81, wid: 0.71 },
    },
    'static.prop.creasedbox02': {
      label: 'Pappe geknickt',
      group: 'surface',
      z: 0.0,
      oriented: true,
      facing: 'none',
      side: { kind: 'flat', w: 1.63, h: 0.21 },
      plan: { kind: 'flat', len: 1.63, wid: 0.71 },
    },
    'static.prop.creasedbox03': {
      label: 'Pappe flach',
      group: 'surface',
      z: 0.0,
      oriented: true,
      facing: 'none',
      side: { kind: 'flat', w: 1.67, h: 0.02 },
      plan: { kind: 'flat', len: 1.67, wid: 0.71, off: [0.12, 0.0] },
    },
    'static.prop.walkingkid': {
      label: 'Kind-Bild',
      group: 'surface',
      z: 0.0,
      oriented: true,
      facing: 'along',
      side: { kind: 'decal', w: 1.0, h: 0.0 },
      plan: { kind: 'decal', len: 0.59, wid: 1.0 },
    },
    'static.prop.walkingkidlarge': {
      label: 'Kind-Bild groß',
      group: 'surface',
      z: 0.0,
      oriented: true,
      facing: 'along',
      side: { kind: 'decal', w: 2.0, h: 0.0 },
      plan: { kind: 'decal', len: 1.18, wid: 2.0 },
    },

    // ── Verlorene Ladung ────────────────────────────────────────
    'static.prop.box01': {
      label: 'Karton 1',
      group: 'cargo',
      z: 0.0,
      oriented: true,
      facing: 'none',
      side: { kind: 'box', w: 0.65, h: 0.69 },
      plan: { kind: 'box', len: 0.65, wid: 0.65 },
    },
    'static.prop.box02': {
      label: 'Karton 2',
      group: 'cargo',
      z: 0.0,
      oriented: true,
      facing: 'none',
      side: { kind: 'box', w: 0.65, h: 0.65 },
      plan: { kind: 'box', len: 0.65, wid: 0.65 },
    },
    'static.prop.box03': {
      label: 'Karton 3',
      group: 'cargo',
      z: 0.0,
      oriented: true,
      facing: 'none',
      side: { kind: 'box', w: 0.67, h: 0.65 },
      plan: { kind: 'box', len: 0.66, wid: 0.67 },
    },
    'static.prop.haybalelb': {
      label: 'Heuballen',
      group: 'cargo',
      z: 0.11,
      oriented: true,
      facing: 'none',
      side: { kind: 'hay', w: 1.25, h: 1.19 },
      plan: { kind: 'hay', len: 1.25, wid: 1.19 },
    },
    'static.prop.travelcase': {
      label: 'Koffer',
      group: 'cargo',
      z: 1.26,
      oriented: true,
      facing: 'none',
      side: { kind: 'suitcase', w: 0.57, h: 1.26 },
      plan: { kind: 'case', len: 0.57, wid: 0.33, off: [0.01, 0.14] },
    },
    'static.prop.briefcase': {
      label: 'Aktentasche',
      group: 'cargo',
      z: 0.43,
      oriented: true,
      facing: 'none',
      side: { kind: 'briefcase', w: 0.54, h: 0.43 },
      plan: { kind: 'case', len: 0.54, wid: 0.18 },
    },
    'static.prop.guitarcase': {
      label: 'Gitarrenkoffer',
      group: 'cargo',
      z: 0.47,
      oriented: true,
      facing: 'none',
      side: { kind: 'guitar', w: 1.24, h: 0.49 },
      plan: { kind: 'case', len: 1.24, wid: 0.13 },
    },
    'static.prop.shoppingbag': {
      label: 'Einkaufstüte',
      group: 'cargo',
      z: 0.58,
      oriented: true,
      facing: 'none',
      side: { kind: 'bag', w: 0.47, h: 0.6 },
      plan: { kind: 'bag', len: 0.47, wid: 0.24 },
    },
    'static.prop.plasticbag': {
      label: 'Plastiktüte',
      group: 'cargo',
      z: 0.53,
      oriented: true,
      facing: 'none',
      side: { kind: 'bag', w: 0.4, h: 0.55 },
      plan: { kind: 'bag', len: 0.31, wid: 0.4 },
    },
    'static.prop.purse': {
      label: 'Handtasche',
      group: 'cargo',
      z: -0.89,
      oriented: true,
      facing: 'none',
      side: { kind: 'bag', w: 0.33, h: 0.59 },
      plan: { kind: 'bag', len: 0.16, wid: 0.33, off: [-0.26, 0.06] },
    },
    'static.prop.motorhelmet': {
      label: 'Motorradhelm',
      group: 'cargo',
      z: 0.23,
      oriented: true,
      facing: 'none',
      side: { kind: 'helmet', w: 0.26, h: 0.26 },
      plan: { kind: 'drum', len: 0.2, wid: 0.26 },
    },
    'static.prop.bike helmet': {
      label: 'Fahrradhelm',
      group: 'cargo',
      z: 0.14,
      oriented: true,
      facing: 'none',
      side: { kind: 'helmet', w: 0.28, h: 0.17 },
      plan: { kind: 'drum', len: 0.19, wid: 0.28 },
    },
    'static.prop.shoppingcart': {
      label: 'Einkaufswagen',
      group: 'cargo',
      z: 1.08,
      oriented: true,
      facing: 'none',
      side: { kind: 'cart', w: 1.21, h: 1.08 },
      plan: { kind: 'cart', len: 0.67, wid: 1.21, off: [-0.16, 0.58] },
    },
    'static.prop.shoppingtrolley': {
      label: 'Einkaufstrolley',
      group: 'cargo',
      z: 1.08,
      oriented: true,
      facing: 'none',
      side: { kind: 'trolley', w: 0.51, h: 1.09 },
      plan: { kind: 'case', len: 0.51, wid: 0.33 },
    },

    // ── Abfall & Container ────────────────────────────────────────
    'static.prop.bin': {
      label: 'Mülltonne',
      group: 'waste',
      z: 0.0,
      oriented: false,
      facing: 'none',
      side: { kind: 'bin', w: 0.64, h: 1.06 },
      plan: { kind: 'drum', len: 0.55, wid: 0.64 },
    },
    'static.prop.trashcan01': {
      label: 'Blechtonne',
      group: 'waste',
      z: 0.0,
      oriented: false,
      facing: 'none',
      side: { kind: 'can', w: 0.64, h: 0.85 },
      plan: { kind: 'drum', len: 0.64, wid: 0.57 },
    },
    'static.prop.trashcan02': {
      label: 'Pfostenkorb',
      group: 'waste',
      z: 0.0,
      oriented: true,
      facing: 'none',
      side: { kind: 'postbin', w: 0.52, h: 1.05 },
      plan: { kind: 'drum', len: 0.52, wid: 0.51 },
    },
    'static.prop.trashcan03': {
      label: 'Blechtonne alt',
      group: 'waste',
      z: 0.0,
      oriented: false,
      facing: 'none',
      side: { kind: 'can', w: 0.63, h: 0.93 },
      plan: { kind: 'drum', len: 0.63, wid: 0.55 },
    },
    'static.prop.trashcan04': {
      label: 'Abfallbox',
      group: 'waste',
      z: 0.0,
      oriented: true,
      facing: 'none',
      side: { kind: 'cabinet', w: 0.79, h: 1.02 },
      plan: { kind: 'box', len: 0.79, wid: 0.58 },
    },
    'static.prop.trashcan05': {
      label: 'Abfallbox grau',
      group: 'waste',
      z: 0.0,
      oriented: true,
      facing: 'none',
      side: { kind: 'cabinet', w: 0.79, h: 1.02 },
      plan: { kind: 'box', len: 0.79, wid: 0.58 },
    },
    'static.prop.trashbag': {
      label: 'Müllsack',
      group: 'waste',
      z: 0.0,
      oriented: false,
      facing: 'none',
      side: { kind: 'sack', w: 0.43, h: 0.7 },
      plan: { kind: 'drum', len: 0.38, wid: 0.43 },
    },
    'static.prop.container': {
      label: 'Container',
      group: 'waste',
      z: 0.0,
      oriented: true,
      facing: 'alongside',
      side: { kind: 'container', w: 1.93, h: 1.71 },
      plan: { kind: 'container', len: 1.93, wid: 1.01, off: [0.0, 1.1] },
    },
    'static.prop.clothcontainer': {
      label: 'Kleidercontainer',
      group: 'waste',
      z: 0.0,
      oriented: true,
      facing: 'along',
      side: { kind: 'container', w: 1.89, h: 1.81 },
      plan: { kind: 'container', len: 1.89, wid: 1.24 },
    },
    'static.prop.glasscontainer': {
      label: 'Glascontainer',
      group: 'waste',
      z: 0.0,
      oriented: true,
      facing: 'none',
      side: { kind: 'dome', w: 2.01, h: 1.79 },
      plan: { kind: 'box', len: 1.95, wid: 2.01 },
    },

    // ── Straßenmöbel ────────────────────────────────────────
    'static.prop.busstop': {
      label: 'Bushaltestelle',
      group: 'street',
      z: 0.0,
      oriented: true,
      facing: 'alongside',
      side: { kind: 'shelter', w: 3.88, h: 2.74 },
      plan: { kind: 'shelter', len: 3.88, wid: 1.89, off: [0.37, 0.18] },
    },
    'static.prop.bench01': {
      label: 'Bank',
      group: 'street',
      z: 0.0,
      oriented: true,
      facing: 'along',
      side: { kind: 'bench', w: 1.54, h: 0.97 },
      plan: { kind: 'bench', len: 1.54, wid: 0.74 },
    },
    'static.prop.bench02': {
      label: 'Bank ohne Lehne',
      group: 'street',
      z: 0.0,
      oriented: true,
      facing: 'along',
      side: { kind: 'bench_flat', w: 1.56, h: 0.51 },
      plan: { kind: 'bench', len: 1.56, wid: 0.54 },
    },
    'static.prop.bench03': {
      label: 'Steinbank',
      group: 'street',
      z: 0.0,
      oriented: true,
      facing: 'along',
      side: { kind: 'bench_flat', w: 1.58, h: 0.51 },
      plan: { kind: 'bench', len: 1.58, wid: 0.51 },
    },
    'static.prop.advertisement': {
      label: 'Werbetafel',
      group: 'street',
      z: 0.0,
      oriented: true,
      facing: 'oncoming',
      side: { kind: 'billboard', w: 1.55, h: 2.44 },
      plan: { kind: 'panel', len: 0.29, wid: 1.55 },
    },
    'static.prop.streetsign': {
      label: 'Infoschild',
      group: 'street',
      z: 0.0,
      oriented: true,
      facing: 'oncoming',
      side: { kind: 'billboard', w: 1.06, h: 2.15 },
      plan: { kind: 'panel', len: 0.13, wid: 1.06 },
    },
    'static.prop.streetsign01': {
      label: 'Hängeschild',
      group: 'street',
      z: 0.0,
      oriented: true,
      facing: 'oncoming',
      side: { kind: 'billboard', w: 2.47, h: 3.88 },
      plan: { kind: 'panel', len: 0.3, wid: 2.47 },
    },
    'static.prop.streetsign04': {
      label: 'Plakatständer',
      group: 'street',
      z: 0.0,
      oriented: true,
      facing: 'oncoming',
      side: { kind: 'billboard', w: 1.17, h: 2.77 },
      plan: { kind: 'panel', len: 0.12, wid: 1.17 },
    },
    'static.prop.vendingmachine': {
      label: 'Automat',
      group: 'street',
      z: 0.07,
      oriented: true,
      facing: 'toward-road',
      side: { kind: 'cabinet', w: 1.1, h: 2.11 },
      plan: { kind: 'box', len: 0.87, wid: 1.1 },
    },
    'static.prop.atm': {
      label: 'Geldautomat',
      group: 'street',
      z: 0.0,
      oriented: true,
      facing: 'toward-road',
      side: { kind: 'cabinet', w: 0.87, h: 2.28 },
      plan: { kind: 'box', len: 0.87, wid: 0.71 },
    },
    'static.prop.mailbox': {
      label: 'Briefkasten',
      group: 'street',
      z: 0.0,
      oriented: true,
      facing: 'toward-road',
      side: { kind: 'postbox', w: 0.53, h: 1.16 },
      plan: { kind: 'box', len: 0.44, wid: 0.53, off: [-0.18, -0.19] },
    },
    'static.prop.kiosk_01': {
      label: 'Telefonzelle',
      group: 'street',
      z: 0.0,
      oriented: true,
      facing: 'none',
      side: { kind: 'booth', w: 1.65, h: 3.25 },
      plan: { kind: 'box', len: 1.63, wid: 1.65 },
    },
    'static.prop.maptable': {
      label: 'Infotafel',
      group: 'street',
      z: 0.0,
      oriented: true,
      facing: 'toward-road',
      side: { kind: 'maptable', w: 1.57, h: 1.18 },
      plan: { kind: 'panel', len: 0.3, wid: 1.57, off: [0.29, 0.0] },
    },
    'static.prop.streetfountain': {
      label: 'Trinkbrunnen',
      group: 'street',
      z: 0.0,
      oriented: true,
      facing: 'none',
      side: { kind: 'post', w: 0.67, h: 1.26 },
      plan: { kind: 'box', len: 0.29, wid: 0.67, off: [0.0, 0.17] },
    },
    'static.prop.foodcart': {
      label: 'Imbisswagen',
      group: 'street',
      z: 0.0,
      oriented: true,
      facing: 'along',
      side: { kind: 'foodcart', w: 4.64, h: 3.57 },
      plan: { kind: 'cart', len: 4.64, wid: 2.28, off: [-0.39, -0.45] },
    },

    // ── Garten & Freizeit ────────────────────────────────────────
    'static.prop.plantpot01': {
      label: 'Pflanzkübel Holz',
      group: 'garden',
      z: 0.0,
      oriented: true,
      facing: 'along',
      side: { kind: 'planter', w: 1.09, h: 0.56 },
      plan: { kind: 'box', len: 1.09, wid: 0.48 },
    },
    'static.prop.plantpot02': {
      label: 'Pflanzkübel rot',
      group: 'garden',
      z: 0.0,
      oriented: true,
      facing: 'along',
      side: { kind: 'planter', w: 1.05, h: 0.49 },
      plan: { kind: 'box', len: 1.05, wid: 0.43 },
    },
    'static.prop.plantpot03': {
      label: 'Pflanzkübel grau',
      group: 'garden',
      z: 0.0,
      oriented: true,
      facing: 'along',
      side: { kind: 'planter', w: 1.05, h: 0.49 },
      plan: { kind: 'box', len: 1.05, wid: 0.43 },
    },
    'static.prop.plantpot04': {
      label: 'Pflanzbeet lang',
      group: 'garden',
      z: 0.0,
      oriented: true,
      facing: 'along',
      side: { kind: 'planter', w: 4.97, h: 0.12 },
      plan: { kind: 'box', len: 4.97, wid: 0.74 },
    },
    'static.prop.plantpot05': {
      label: 'Blumentopf',
      group: 'garden',
      z: 0.0,
      oriented: false,
      facing: 'none',
      side: { kind: 'pot', w: 0.4, h: 0.28 },
      plan: { kind: 'drum', len: 0.4, wid: 0.4 },
    },
    'static.prop.plantpot06': {
      label: 'Pflanzschale',
      group: 'garden',
      z: 0.0,
      oriented: false,
      facing: 'none',
      side: { kind: 'bowl', w: 1.59, h: 0.85 },
      plan: { kind: 'drum', len: 1.59, wid: 1.59 },
    },
    'static.prop.plantpot07': {
      label: 'Pflanzkübel klein',
      group: 'garden',
      z: 0.0,
      oriented: true,
      facing: 'none',
      side: { kind: 'planter', w: 0.49, h: 0.56 },
      plan: { kind: 'box', len: 0.49, wid: 0.48 },
    },
    'static.prop.plantpot08': {
      label: 'Pflanztopf eckig',
      group: 'garden',
      z: 0.0,
      oriented: true,
      facing: 'none',
      side: { kind: 'pot', w: 0.53, h: 0.49 },
      plan: { kind: 'box', len: 0.53, wid: 0.53 },
    },
    'static.prop.plasticchair': {
      label: 'Gartenstuhl',
      group: 'garden',
      z: 0.0,
      oriented: true,
      facing: 'none',
      side: { kind: 'chair', w: 0.75, h: 1.27 },
      plan: { kind: 'box', len: 0.73, wid: 0.75 },
    },
    'static.prop.plastictable': {
      label: 'Gartentisch',
      group: 'garden',
      z: 0.0,
      oriented: false,
      facing: 'none',
      side: { kind: 'parasol', w: 2.48, h: 2.48 },
      plan: { kind: 'drum', len: 2.48, wid: 2.48 },
    },
    'static.prop.table': {
      label: 'Picknicktisch',
      group: 'garden',
      z: 0.0,
      oriented: true,
      facing: 'none',
      side: { kind: 'picnic', w: 2.16, h: 0.85 },
      plan: { kind: 'bench', len: 2.16, wid: 2.15 },
    },
    'static.prop.barbeque': {
      label: 'Grill',
      group: 'garden',
      z: 0.0,
      oriented: true,
      facing: 'none',
      side: { kind: 'grill', w: 0.95, h: 1.26 },
      plan: { kind: 'box', len: 0.95, wid: 0.5 },
    },
    'static.prop.gnome': {
      label: 'Gartenzwerg',
      group: 'garden',
      z: 0.0,
      oriented: false,
      facing: 'none',
      side: { kind: 'gnome', w: 0.38, h: 0.88 },
      plan: { kind: 'drum', len: 0.37, wid: 0.38 },
    },
    'static.prop.doghouse': {
      label: 'Hundehütte',
      group: 'garden',
      z: 0.06,
      oriented: true,
      facing: 'none',
      side: { kind: 'doghouse', w: 1.27, h: 1.09 },
      plan: { kind: 'box', len: 1.08, wid: 1.27 },
    },
    'static.prop.gardenlamp': {
      label: 'Gartenlaterne',
      group: 'garden',
      z: 0.0,
      oriented: false,
      facing: 'none',
      side: { kind: 'lamp', w: 0.3, h: 0.65 },
      plan: { kind: 'drum', len: 0.3, wid: 0.28 },
    },
    'static.prop.swing': {
      label: 'Schaukel',
      group: 'garden',
      z: 0.0,
      oriented: true,
      facing: 'none',
      side: { kind: 'swing', w: 4.11, h: 2.57 },
      plan: { kind: 'frame', len: 4.11, wid: 1.58 },
    },
    'static.prop.swingcouch': {
      label: 'Hollywoodschaukel',
      group: 'garden',
      z: 0.0,
      oriented: true,
      facing: 'none',
      side: { kind: 'swingcouch', w: 2.36, h: 2.25 },
      plan: { kind: 'frame', len: 2.36, wid: 1.36, off: [0.2, 0.0] },
    },
    'static.prop.slide': {
      label: 'Rutsche',
      group: 'garden',
      z: 0.0,
      oriented: true,
      facing: 'none',
      side: { kind: 'slide', w: 4.12, h: 1.98 },
      plan: { kind: 'slide', len: 4.12, wid: 0.94, off: [-1.58, -0.16] },
    },
    'static.prop.trampoline': {
      label: 'Trampolin',
      group: 'garden',
      z: 0.0,
      oriented: false,
      facing: 'none',
      side: { kind: 'trampoline', w: 4.13, h: 2.8 },
      plan: { kind: 'drum', len: 4.13, wid: 4.13 },
    },
    'static.prop.pergola': {
      label: 'Pergola',
      group: 'garden',
      z: 0.23,
      oriented: true,
      facing: 'none',
      side: { kind: 'pergola', w: 5.09, h: 3.54 },
      plan: { kind: 'frame', len: 5.03, wid: 5.09 },
    },
    'static.prop.clothesline': {
      label: 'Wäscheleine',
      group: 'garden',
      z: 0.06,
      oriented: true,
      facing: 'none',
      side: { kind: 'clothesline', w: 1.12, h: 2.06 },
      plan: { kind: 'chain', len: 6.65, wid: 1.12 },
    },
  };

  /* ── Side view (elevation) — palette tiles ───────────────────────────────────
   * Flat silhouettes standing on the ground line y=0, centred on x=0, rising to
   * y=-h. Fills use the group colour; white low-opacity accents only, matching
   * the rest of the map's visual language. No gradients, no shading.
   *
   * Objects with an extreme aspect ratio (a 0.05 m road plate, a 0.3 m sign
   * post) degenerate into a hairline at true proportion, so those shapes floor
   * one dimension — see MIN_SIDE_RATIO.
   */
  const MIN_SIDE_RATIO = 0.3; // no silhouette thinner than 30% of its long side

  function sideShapes(kind, w, h, color) {
    // Keep degenerate aspect ratios legible without distorting normal props.
    const long = Math.max(w, h);
    w = Math.max(w, long * MIN_SIDE_RATIO);
    h = Math.max(h, long * MIN_SIDE_RATIO);

    const out = [];
    const X = (n) => n * w,
      Y = (n) => -n * h;
    const u = Math.min(w, h);
    const rect = (x, y, ww, hh, o = {}) =>
      out.push(
        UIUtils.svgEl('rect', {
          x: X(x),
          y: Y(y),
          width: ww * w,
          height: hh * h,
          fill: o.fill || color,
          ...(o.op ? { 'fill-opacity': o.op } : {}),
          ...(o.rx ? { rx: o.rx * u } : {}),
        }),
      );
    const poly = (pts, o = {}) =>
      out.push(
        UIUtils.svgEl('polygon', {
          points: pts.map(([x, y]) => `${X(x)},${Y(y)}`).join(' '),
          fill: o.fill || color,
          ...(o.op ? { 'fill-opacity': o.op } : {}),
        }),
      );
    const circ = (cx, cy, r, o = {}) =>
      out.push(
        UIUtils.svgEl('circle', {
          cx: X(cx),
          cy: Y(cy),
          r: r * u,
          fill: o.fill || color,
          ...(o.op ? { 'fill-opacity': o.op } : {}),
        }),
      );
    const path = (d, sw) =>
      out.push(
        UIUtils.svgEl('path', {
          d,
          fill: 'none',
          stroke: color,
          'stroke-width': sw * h,
          'stroke-linecap': 'round',
        }),
      );

    switch (kind) {
      case 'cone': // tapered body, flat top, base slab
        poly([
          [-0.34, 0.1],
          [0.34, 0.1],
          [0.09, 1],
          [-0.09, 1],
        ]);
        rect(-0.5, 0.13, 1, 0.13, { rx: 0.1 });
        rect(-0.26, 0.62, 0.52, 0.14, { fill: '#fff', op: 0.8 });
        break;
      case 'barrel': // drum with two rim bands
        rect(-0.5, 1, 1, 1, { rx: 0.1 });
        rect(-0.5, 0.74, 1, 0.07, { fill: '#fff', op: 0.75 });
        rect(-0.5, 0.34, 1, 0.07, { fill: '#fff', op: 0.75 });
        break;
      case 'bin': // tapered body + lid overhang
        poly([
          [-0.4, 0],
          [0.4, 0],
          [0.46, 0.86],
          [-0.46, 0.86],
        ]);
        rect(-0.5, 1, 1, 0.15, { rx: 0.12 });
        break;
      case 'jersey': // sloped skirt, flat top
        poly([
          [-0.5, 0],
          [0.5, 0],
          [0.33, 0.52],
          [0.29, 1],
          [-0.29, 1],
          [-0.33, 0.52],
        ]);
        rect(-0.3, 0.8, 0.6, 0.1, { fill: '#fff', op: 0.7 });
        break;
      case 'arrowboard': // board on mast, chassis + wheels
        rect(-0.44, 1, 0.88, 0.46, { rx: 0.06 });
        rect(-0.3, 0.54, 0.6, 0.1, { fill: '#fff', op: 0.75 });
        rect(-0.06, 0.54, 0.12, 0.3);
        rect(-0.4, 0.24, 0.8, 0.1, { rx: 0.04 });
        circ(-0.2, 0.09, 0.095);
        circ(0.24, 0.09, 0.095);
        break;
      case 'signtri': // triangle sign on a single post
        rect(-0.06, 0.46, 0.12, 0.46);
        rect(-0.22, 0.05, 0.44, 0.05, { rx: 0.04 });
        poly([
          [0, 1],
          [0.45, 0.44],
          [-0.45, 0.44],
        ]);
        poly(
          [
            [0, 0.9],
            [0.31, 0.5],
            [-0.31, 0.5],
          ],
          { fill: '#fff', op: 0.85 },
        );
        break;
      case 'signtri_a': // same sign on a splayed A-frame
        poly([
          [0, 1],
          [0.45, 0.44],
          [-0.45, 0.44],
        ]);
        poly(
          [
            [0, 0.9],
            [0.31, 0.5],
            [-0.31, 0.5],
          ],
          { fill: '#fff', op: 0.85 },
        );
        poly([
          [-0.05, 0.46],
          [0.05, 0.46],
          [0.34, 0],
          [0.22, 0],
        ]);
        poly([
          [0.05, 0.46],
          [-0.05, 0.46],
          [-0.34, 0],
          [-0.22, 0],
        ]);
        break;
      case 'billboard': // raised panel on two legs
        rect(-0.26, 0.4, 0.09, 0.4);
        rect(0.17, 0.4, 0.09, 0.4);
        rect(-0.5, 1, 1, 0.6, { rx: 0.04 });
        rect(-0.44, 0.94, 0.88, 0.48, { fill: '#fff', op: 0.8 });
        break;
      case 'container': // long box, corner posts, ribs
        rect(-0.5, 1, 1, 1, { rx: 0.03 });
        for (let i = 1; i < 12; i++) {
          rect(-0.5 + i / 12, 0.92, 0.022, 0.84, { fill: '#fff', op: 0.28 });
        }
        rect(-0.5, 1, 0.05, 1);
        rect(0.45, 1, 0.05, 1);
        break;
      case 'shelter': // roof slab, end posts, bench
        rect(-0.5, 1, 1, 0.11, { rx: 0.03 });
        rect(-0.47, 0.89, 0.07, 0.89);
        rect(0.4, 0.89, 0.07, 0.89);
        rect(-0.4, 0.7, 0.8, 0.62, { fill: '#fff', op: 0.35 });
        rect(-0.34, 0.34, 0.68, 0.09, { rx: 0.04 });
        rect(-0.3, 0.25, 0.06, 0.25);
        rect(0.24, 0.25, 0.06, 0.25);
        break;
      case 'cabinet': // body, window, plinth
        rect(-0.5, 1, 1, 0.94, { rx: 0.05 });
        rect(-0.38, 0.9, 0.58, 0.56, { fill: '#fff', op: 0.75 });
        rect(-0.5, 0.06, 1, 0.06, { rx: 0.02 });
        break;
      case 'cart': // basket, handle, wheels
        poly([
          [-0.34, 0.72],
          [0.44, 0.76],
          [0.36, 0.3],
          [-0.26, 0.28],
        ]);
        path(`M ${X(-0.34)} ${Y(0.72)} L ${X(-0.46)} ${Y(0.92)}`, 0.06);
        circ(-0.2, 0.09, 0.085);
        circ(0.28, 0.09, 0.085);
        break;
      case 'plank': // thin slab, bevelled ends
        poly([
          [-0.5, 0.18],
          [0.5, 0.18],
          [0.44, 0.82],
          [-0.44, 0.82],
        ]);
        break;
      case 'debris': // low irregular mound
        path(
          `M ${X(-0.5)} 0 Q ${X(-0.34)} ${Y(0.7)} ${X(-0.14)} ${Y(0.58)}
              Q ${X(0.02)} ${Y(0.82)} ${X(0.2)} ${Y(0.55)}
              Q ${X(0.38)} ${Y(0.68)} ${X(0.5)} 0 Z`,
          0,
        );
        out[out.length - 1].setAttribute('fill', color);
        out[out.length - 1].removeAttribute('stroke');
        break;
      case 'drum_striped': // traffic drum on a base slab
        rect(-0.5, 0.07, 1, 0.07, { rx: 0.1 });
        rect(-0.36, 1, 0.72, 0.92, { rx: 0.12 });
        rect(-0.36, 0.76, 0.72, 0.1, { fill: '#fff', op: 0.8 });
        rect(-0.36, 0.48, 0.72, 0.1, { fill: '#fff', op: 0.8 });
        break;
      case 'delineator': // tall tapered post on a foot
        rect(-0.5, 0.08, 1, 0.08, { rx: 0.1 });
        poly([
          [-0.22, 0.08],
          [0.22, 0.08],
          [0.12, 1],
          [-0.12, 1],
        ]);
        rect(-0.16, 0.86, 0.32, 0.08, { fill: '#fff', op: 0.8 });
        break;
      case 'post': // bollard / pillar
        rect(-0.5, 1, 1, 1, { rx: 0.4 });
        rect(-0.5, 0.86, 1, 0.08, { fill: '#fff', op: 0.6 });
        break;
      case 'chain': // post with a sagging chain
        rect(-0.5, 1, 0.12, 1, { rx: 0.3 });
        path(`M ${X(-0.38)} ${Y(0.78)} Q ${X(0.06)} ${Y(0.3)} ${X(0.5)} ${Y(0.78)}`, 0.05);
        break;
      case 'flat': // creased cardboard on the ground
        poly([
          [-0.5, 0],
          [0.5, 0],
          [0.44, 0.62],
          [-0.08, 1],
          [-0.46, 0.55],
        ]);
        break;
      case 'decal': // painted mat with a figure on it
        rect(-0.5, 0.5, 1, 0.5, { rx: 0.05, op: 0.55 });
        circ(0, 0.84, 0.14, { fill: '#fff', op: 0.9 });
        rect(-0.07, 0.7, 0.14, 0.62, { fill: '#fff', op: 0.9 });
        break;
      case 'box': // carton with a tape strip
        rect(-0.5, 1, 1, 1, { rx: 0.04 });
        rect(-0.07, 1, 0.14, 1, { fill: '#fff', op: 0.35 });
        break;
      case 'hay': // round bale, end on
        circ(0, 0.5, 0.5);
        circ(0, 0.5, 0.3, { fill: '#fff', op: 0.22 });
        circ(0, 0.5, 0.12, { fill: '#fff', op: 0.22 });
        break;
      case 'suitcase': // upright case, handle, wheels
        rect(-0.5, 0.86, 1, 0.8, { rx: 0.12 });
        rect(-0.08, 1, 0.16, 0.14);
        rect(-0.5, 0.55, 1, 0.05, { fill: '#fff', op: 0.4 });
        circ(-0.32, 0.04, 0.05);
        circ(0.32, 0.04, 0.05);
        break;
      case 'briefcase': // flat case + handle loop
        rect(-0.5, 0.78, 1, 0.78, { rx: 0.1 });
        rect(-0.18, 1, 0.36, 0.07);
        rect(-0.18, 1, 0.06, 0.22);
        rect(0.12, 1, 0.06, 0.22);
        break;
      case 'guitar': // guitar case, body + neck
        circ(-0.28, 0.5, 0.5);
        rect(-0.12, 0.7, 0.62, 0.4, { rx: 0.2 });
        break;
      case 'bag': // tote with handle
        poly([
          [-0.42, 0],
          [0.42, 0],
          [0.36, 0.72],
          [-0.36, 0.72],
        ]);
        path(`M ${X(-0.18)} ${Y(0.72)} Q ${X(0)} ${Y(1.25)} ${X(0.18)} ${Y(0.72)}`, 0.07);
        break;
      case 'helmet': // dome with a visor
        out.push(
          UIUtils.svgEl('path', {
            d: `M ${X(-0.5)} 0 A ${w / 2} ${h} 0 0 1 ${X(0.5)} 0 Z`,
            fill: color,
          }),
        );
        rect(-0.05, 0.55, 0.5, 0.2, { fill: '#fff', op: 0.6, rx: 0.2 });
        break;
      case 'trolley': // shopping trolley bag on wheels
        rect(-0.4, 0.8, 0.8, 0.7, { rx: 0.2 });
        path(`M ${X(0.3)} ${Y(0.8)} L ${X(0.42)} ${Y(1)}`, 0.05);
        circ(-0.22, 0.05, 0.06);
        circ(0.22, 0.05, 0.06);
        break;
      case 'can': // metal dustbin with lid
        rect(-0.42, 0.9, 0.84, 0.88, { rx: 0.06 });
        rect(-0.5, 0.97, 1, 0.08, { rx: 0.2 });
        rect(-0.08, 1, 0.16, 0.05);
        rect(-0.42, 0.62, 0.84, 0.04, { fill: '#fff', op: 0.4 });
        rect(-0.42, 0.32, 0.84, 0.04, { fill: '#fff', op: 0.4 });
        break;
      case 'postbin': // bin hung on a post
        rect(-0.06, 0.6, 0.12, 0.6);
        rect(-0.4, 1, 0.8, 0.46, { rx: 0.1 });
        rect(-0.3, 0.04, 0.6, 0.04);
        break;
      case 'sack': // knotted bin bag
        poly([
          [-0.46, 0.1],
          [-0.5, 0.5],
          [-0.25, 0.88],
          [0, 0.96],
          [0.25, 0.88],
          [0.5, 0.5],
          [0.46, 0.1],
          [0.3, 0],
          [-0.3, 0],
        ]);
        circ(0, 0.95, 0.1);
        break;
      case 'dome': // bottle bank, rounded top
        path(
          `M ${X(-0.5)} 0 L ${X(-0.5)} ${Y(0.6)} Q ${X(-0.5)} ${Y(1)} ${X(0)} ${Y(1)}
              Q ${X(0.5)} ${Y(1)} ${X(0.5)} ${Y(0.6)} L ${X(0.5)} 0 Z`,
          0,
        );
        out[out.length - 1].setAttribute('fill', color);
        out[out.length - 1].removeAttribute('stroke');
        rect(-0.5, 0.14, 1, 0.07, { fill: '#fff', op: 0.4 });
        circ(0, 0.72, 0.08, { fill: '#fff', op: 0.6 });
        break;
      case 'bench': // seat, backrest, legs
        rect(-0.5, 1, 1, 0.24, { rx: 0.04 });
        rect(-0.5, 0.55, 1, 0.12, { rx: 0.04 });
        rect(-0.44, 0.76, 0.06, 0.76);
        rect(0.38, 0.76, 0.06, 0.76);
        break;
      case 'bench_flat': // slab seat on two legs
        rect(-0.5, 1, 1, 0.24, { rx: 0.05 });
        rect(-0.4, 0.78, 0.1, 0.78);
        rect(0.3, 0.78, 0.1, 0.78);
        break;
      case 'postbox': // round-topped mailbox on legs
        rect(-0.5, 0.96, 1, 0.62, { rx: 0.35 });
        rect(-0.36, 0.36, 0.12, 0.36);
        rect(0.24, 0.36, 0.12, 0.36);
        rect(-0.26, 0.84, 0.52, 0.06, { fill: '#fff', op: 0.8 });
        break;
      case 'booth': // phone booth, glazed
        rect(-0.5, 1, 1, 1, { rx: 0.04 });
        rect(-0.38, 0.9, 0.76, 0.55, { fill: '#fff', op: 0.45 });
        rect(-0.38, 0.3, 0.76, 0.18, { fill: '#fff', op: 0.3 });
        break;
      case 'maptable': // slanted board on two legs
        rect(-0.46, 0.78, 0.1, 0.78);
        rect(0.36, 0.78, 0.1, 0.78);
        poly([
          [-0.5, 0.74],
          [0.5, 0.74],
          [0.5, 1],
          [-0.5, 0.9],
        ]);
        poly(
          [
            [-0.42, 0.78],
            [0.42, 0.78],
            [0.42, 0.95],
            [-0.42, 0.88],
          ],
          { fill: '#fff', op: 0.7 },
        );
        break;
      case 'foodcart': // canopy on poles, counter, wheels
        rect(-0.5, 1, 1, 0.12, { rx: 0.04 });
        rect(-0.45, 0.88, 0.04, 0.4);
        rect(0.41, 0.88, 0.04, 0.4);
        rect(-0.45, 0.5, 0.9, 0.4, { rx: 0.03 });
        rect(-0.35, 0.45, 0.4, 0.2, { fill: '#fff', op: 0.6 });
        circ(-0.25, 0.08, 0.08);
        circ(0.25, 0.08, 0.08);
        break;
      case 'planter': // trough with a rim
        rect(-0.5, 1, 1, 1, { rx: 0.05 });
        rect(-0.5, 1, 1, 0.12, { fill: '#fff', op: 0.3 });
        break;
      case 'pot': // tapered flower pot
        poly([
          [-0.5, 1],
          [0.5, 1],
          [0.36, 0],
          [-0.36, 0],
        ]);
        rect(-0.5, 1, 1, 0.14, { fill: '#fff', op: 0.3 });
        break;
      case 'bowl': // wide bowl on ball feet
        poly([
          [-0.5, 1],
          [0.5, 1],
          [0.3, 0.35],
          [-0.3, 0.35],
        ]);
        circ(-0.18, 0.14, 0.14);
        circ(0.18, 0.14, 0.14);
        break;
      case 'chair': // garden chair, side view
        rect(-0.36, 1, 0.12, 0.6);
        rect(-0.36, 0.52, 0.82, 0.08);
        rect(-0.36, 0.72, 0.76, 0.05);
        rect(-0.36, 0.46, 0.06, 0.46);
        rect(0.4, 0.46, 0.06, 0.46);
        break;
      case 'parasol': // table under a parasol
        poly([
          [-0.5, 0.82],
          [0, 1],
          [0.5, 0.82],
        ]);
        rect(-0.02, 0.9, 0.04, 0.9);
        rect(-0.42, 0.34, 0.84, 0.05);
        rect(-0.38, 0.3, 0.04, 0.3);
        rect(0.34, 0.3, 0.04, 0.3);
        break;
      case 'picnic': // table, benches, crossed legs
        rect(-0.5, 1, 1, 0.1);
        rect(-0.5, 0.55, 1, 0.07);
        path(`M ${X(-0.3)} 0 L ${X(0.3)} ${Y(0.95)} M ${X(0.3)} 0 L ${X(-0.3)} ${Y(0.95)}`, 0.06);
        break;
      case 'grill': // kettle on splayed legs
        rect(-0.5, 1, 1, 0.32, { rx: 0.3 });
        path(`M ${X(-0.35)} ${Y(0.68)} L ${X(-0.42)} 0 M ${X(0.35)} ${Y(0.68)} L ${X(0.42)} 0`, 0.04);
        rect(-0.38, 0.3, 0.76, 0.04);
        break;
      case 'gnome': // pointed hat, body, face
        poly([
          [0, 1],
          [0.32, 0.6],
          [-0.32, 0.6],
        ]);
        poly([
          [-0.42, 0],
          [0.42, 0],
          [0.32, 0.55],
          [-0.32, 0.55],
        ]);
        circ(0, 0.58, 0.16, { fill: '#fff', op: 0.8 });
        break;
      case 'doghouse': // pitched roof, arched door
        poly([
          [-0.5, 0.62],
          [0, 1],
          [0.5, 0.62],
        ]);
        rect(-0.42, 0.64, 0.84, 0.64);
        rect(-0.15, 0.42, 0.3, 0.42, { fill: '#fff', op: 0.35, rx: 0.3 });
        break;
      case 'lamp': // lantern
        poly([
          [-0.45, 0.8],
          [0, 1],
          [0.45, 0.8],
        ]);
        rect(-0.35, 0.8, 0.7, 0.62, { rx: 0.08 });
        rect(-0.22, 0.72, 0.44, 0.42, { fill: '#fff', op: 0.6 });
        rect(-0.4, 0.18, 0.8, 0.18);
        break;
      case 'swing': // A-frame with two seats
        path(
          `M ${X(-0.5)} 0 L ${X(-0.38)} ${Y(1)} L ${X(-0.26)} 0 M ${X(0.26)} 0 L ${X(0.38)} ${Y(1)} L ${X(0.5)} 0
              M ${X(-0.38)} ${Y(1)} L ${X(0.38)} ${Y(1)}`,
          0.035,
        );
        path(`M ${X(-0.18)} ${Y(1)} L ${X(-0.18)} ${Y(0.28)} M ${X(0.18)} ${Y(1)} L ${X(0.18)} ${Y(0.28)}`, 0.015);
        rect(-0.26, 0.28, 0.16, 0.05);
        rect(0.1, 0.28, 0.16, 0.05);
        break;
      case 'swingcouch': // roofed bench swing
        rect(-0.5, 1, 1, 0.08);
        path(`M ${X(-0.46)} 0 L ${X(-0.46)} ${Y(0.95)} M ${X(0.46)} 0 L ${X(0.46)} ${Y(0.95)}`, 0.04);
        rect(-0.34, 0.76, 0.68, 0.24, { op: 0.7, rx: 0.05 });
        rect(-0.34, 0.52, 0.68, 0.14, { rx: 0.08 });
        break;
      case 'slide': // ladder, platform, chute
        rect(-0.5, 1, 0.05, 1);
        rect(-0.36, 1, 0.05, 1);
        rect(-0.5, 1, 0.22, 0.06);
        poly([
          [-0.3, 0.96],
          [-0.18, 0.96],
          [0.5, 0.08],
          [0.5, 0],
          [0.36, 0],
        ]);
        break;
      case 'trampoline': // mat, net, poles
        rect(-0.5, 1, 1, 0.45, { op: 0.35 });
        rect(-0.5, 1, 0.03, 1);
        rect(0.47, 1, 0.03, 1);
        rect(-0.5, 0.56, 1, 0.07);
        break;
      case 'pergola': // posts and beams
        rect(-0.5, 1, 1, 0.07);
        rect(-0.5, 0.88, 1, 0.04);
        rect(-0.46, 0.88, 0.07, 0.88);
        rect(0.39, 0.88, 0.07, 0.88);
        break;
      case 'clothesline': // two posts, line, laundry
        rect(-0.5, 1, 0.03, 1);
        rect(0.47, 1, 0.03, 1);
        path(`M ${X(-0.48)} ${Y(0.92)} Q ${X(0)} ${Y(0.8)} ${X(0.48)} ${Y(0.92)}`, 0.012);
        rect(-0.32, 0.86, 0.1, 0.26);
        rect(-0.1, 0.84, 0.12, 0.3);
        rect(0.16, 0.86, 0.1, 0.22);
        break;
      default:
        rect(-0.5, 1, 1, 1, { rx: 0.08 });
    }
    return out;
  }

  /* ── Plan view (top-down) — map markers ──────────────────────────────────────
   * Real footprints, drawn in the actor convention: `len` along local +X (the
   * yaw direction), `wid` across it, centred on the origin. These rotate with
   * prop.yaw exactly like vehicle footprints do in _renderActor.
   */
  function planShapes(kind, len, wid, color) {
    const out = [];
    const hl = len / 2,
      hw = wid / 2,
      u = Math.min(len, wid);
    const rect = (o = {}) =>
      out.push(
        UIUtils.svgEl('rect', {
          x: -hl,
          y: -hw,
          width: len,
          height: wid,
          rx: (o.rx ?? 0.12) * u,
          fill: o.fill || color,
          ...(o.op ? { 'fill-opacity': o.op } : {}),
        }),
      );

    switch (kind) {
      case 'cone': // a cone from above is a disc with a ring
        out.push(UIUtils.svgEl('circle', { r: hl, fill: color }));
        out.push(
          UIUtils.svgEl('circle', {
            r: hl * 0.55,
            fill: 'none',
            stroke: '#fff',
            'stroke-width': hl * 0.22,
            'stroke-opacity': 0.8,
          }),
        );
        break;
      case 'drum': // barrel / bin: plain disc
        out.push(UIUtils.svgEl('circle', { r: hl, fill: color }));
        out.push(
          UIUtils.svgEl('circle', {
            r: hl * 0.5,
            fill: 'none',
            stroke: '#fff',
            'stroke-width': hl * 0.14,
            'stroke-opacity': 0.5,
          }),
        );
        break;
      case 'panel': // sign / billboard face: thin bar across +X
        rect({ rx: 0.3 });
        out.push(
          UIUtils.svgEl('rect', {
            x: -hl * 0.34,
            y: -hw * 0.8,
            width: hl * 0.68,
            height: wid * 0.8,
            fill: '#fff',
            'fill-opacity': 0.55,
          }),
        );
        break;
      case 'barrier': // jersey barrier: bar with a centre stripe
        rect({ rx: 0.2 });
        out.push(
          UIUtils.svgEl('rect', {
            x: -hl * 0.12,
            y: -hw,
            width: hl * 0.24,
            height: wid,
            fill: '#fff',
            'fill-opacity': 0.7,
          }),
        );
        break;
      case 'trailer': // arrow board: body plus a drawbar nose
        rect({ rx: 0.1 });
        out.push(
          UIUtils.svgEl('polygon', {
            points: `${hl},${-hw * 0.3} ${hl * 1.25},0 ${hl},${hw * 0.3}`,
            fill: color,
          }),
        );
        break;
      case 'container': // long box with corrugation ticks
        rect({ rx: 0.04 });
        for (let i = 1; i < 10; i++) {
          out.push(
            UIUtils.svgEl('rect', {
              x: -hl + (i * len) / 10 - len * 0.006,
              y: -hw * 0.82,
              width: len * 0.012,
              height: wid * 0.82,
              fill: '#fff',
              'fill-opacity': 0.3,
            }),
          );
        }
        break;
      case 'shelter': // roof outline, open on the kerb side
        rect({ rx: 0.06, op: 0.45 });
        out.push(
          UIUtils.svgEl('rect', {
            x: -hl,
            y: -hw,
            width: len,
            height: wid * 0.26,
            fill: color,
          }),
        );
        break;
      case 'plate': // steel road plate: flat slab, cut corners
        out.push(
          UIUtils.svgEl('polygon', {
            points:
              `${-hl * 0.88},${-hw} ${hl * 0.88},${-hw} ${hl},${-hw * 0.6} ` +
              `${hl},${hw * 0.6} ${hl * 0.88},${hw} ${-hl * 0.88},${hw} ` +
              `${-hl},${hw * 0.6} ${-hl},${-hw * 0.6}`,
            fill: color,
            'fill-opacity': 0.9,
          }),
        );
        break;
      case 'blob': // debris scatter
        out.push(
          UIUtils.svgEl('ellipse', {
            rx: hl,
            ry: hw * 0.82,
            fill: color,
            'fill-opacity': 0.75,
            stroke: color,
            'stroke-width': u * 0.05,
            'stroke-dasharray': `${u * 0.12}`,
          }),
        );
        out.push(UIUtils.svgEl('circle', { cx: -hl * 0.3, cy: hw * 0.3, r: u * 0.1, fill: color }));
        out.push(UIUtils.svgEl('circle', { cx: hl * 0.35, cy: -hw * 0.25, r: u * 0.08, fill: color }));
        break;
      case 'cart': // basket outline with a handle tick
        rect({ rx: 0.18 });
        out.push(
          UIUtils.svgEl('rect', {
            x: -hl,
            y: -hw * 0.5,
            width: len * 0.16,
            height: wid * 0.5,
            fill: '#fff',
            'fill-opacity': 0.6,
          }),
        );
        break;
      case 'chain': // two posts joined by a line along the long axis
        {
          const along = wid > len;
          const half = along ? hw : hl,
            r = u * 0.5;
          const [x1, y1, x2, y2] = along ? [0, -half + r, 0, half - r] : [-half + r, 0, half - r, 0];
          out.push(
            UIUtils.svgEl('line', {
              x1,
              y1,
              x2,
              y2,
              stroke: color,
              'stroke-width': u * 0.3,
              'stroke-dasharray': `${u * 0.35} ${u * 0.2}`,
            }),
          );
          out.push(UIUtils.svgEl('circle', { cx: x1, cy: y1, r, fill: color }));
          out.push(UIUtils.svgEl('circle', { cx: x2, cy: y2, r, fill: color }));
        }
        break;
      case 'flat': // flattened cardboard: irregular slab
        out.push(
          UIUtils.svgEl('polygon', {
            points:
              `${-hl},${-hw * 0.8} ${hl * 0.7},${-hw} ${hl},${hw * 0.6} ` +
              `${-hl * 0.2},${hw} ${-hl * 0.9},${hw * 0.7}`,
            fill: color,
            'fill-opacity': 0.85,
          }),
        );
        break;
      case 'decal': // painting on the road: outline + figure
        out.push(
          UIUtils.svgEl('rect', {
            x: -hl,
            y: -hw,
            width: len,
            height: wid,
            fill: color,
            'fill-opacity': 0.3,
            stroke: color,
            'stroke-width': u * 0.06,
            'stroke-dasharray': `${u * 0.15}`,
          }),
        );
        out.push(UIUtils.svgEl('ellipse', { rx: hl * 0.5, ry: hw * 0.18, fill: '#fff', 'fill-opacity': 0.8 }));
        out.push(UIUtils.svgEl('circle', { cx: hl * 0.58, r: hw * 0.2, fill: '#fff', 'fill-opacity': 0.8 }));
        break;
      case 'hay': // round bale lying down: banded cylinder
        rect({ rx: 0.12 });
        for (const f of [-0.5, 0, 0.5]) {
          out.push(
            UIUtils.svgEl('rect', {
              x: -hl * 0.9,
              y: hw * f - wid * 0.03,
              width: len * 0.9,
              height: wid * 0.06,
              fill: '#fff',
              'fill-opacity': 0.3,
            }),
          );
        }
        break;
      case 'case': // luggage: rounded slab with a handle tick
        rect({ rx: 0.3 });
        out.push(
          UIUtils.svgEl('rect', {
            x: hl * 0.55,
            y: -hw * 0.35,
            width: len * 0.12,
            height: wid * 0.7,
            fill: '#fff',
            'fill-opacity': 0.6,
          }),
        );
        break;
      case 'bag':
        out.push(UIUtils.svgEl('ellipse', { rx: hl, ry: hw, fill: color }));
        out.push(
          UIUtils.svgEl('ellipse', {
            rx: hl * 0.45,
            ry: hw * 0.45,
            fill: 'none',
            stroke: '#fff',
            'stroke-width': u * 0.1,
            'stroke-opacity': 0.6,
          }),
        );
        break;
      case 'bench': // seat with slats along the long axis
        rect({ rx: 0.15 });
        for (const f of [-0.33, 0.33]) {
          out.push(
            UIUtils.svgEl('rect', {
              x: -hl * 0.92,
              y: hw * f - wid * 0.05,
              width: len * 0.92,
              height: wid * 0.1,
              fill: '#fff',
              'fill-opacity': 0.45,
            }),
          );
        }
        break;
      case 'frame': // open structure: outline + corner posts
        out.push(
          UIUtils.svgEl('rect', {
            x: -hl,
            y: -hw,
            width: len,
            height: wid,
            fill: color,
            'fill-opacity': 0.18,
            stroke: color,
            'stroke-width': u * 0.06,
          }),
        );
        for (const [cx, cy] of [
          [-hl, -hw],
          [hl, -hw],
          [-hl, hw],
          [hl, hw],
        ]) {
          out.push(UIUtils.svgEl('circle', { cx: cx * 0.94, cy: cy * 0.9, r: u * 0.07, fill: color }));
        }
        break;
      case 'slide': // platform square at -X, chute running to +X
        out.push(
          UIUtils.svgEl('rect', {
            x: -hl,
            y: -hw,
            width: wid,
            height: wid,
            fill: color,
          }),
        );
        out.push(
          UIUtils.svgEl('rect', {
            x: -hl + wid * 0.8,
            y: -hw * 0.6,
            width: len - wid * 0.8,
            height: wid * 0.6,
            rx: wid * 0.2,
            fill: color,
            'fill-opacity': 0.7,
          }),
        );
        break;
      default:
        rect({ rx: 0.1 });
        break;
    }
    return out;
  }

  /* Scale a footprint up uniformly when it is too small to see on a map
   * spanning hundreds of metres. Aspect ratio is preserved, so a barrier stays
   * elongated and a cone stays round; large props are untouched.
   *
   * Known consequence: every prop under the floor is drawn at the floor, so the
   * three cones (0.88 / 0.46 / 0.34 m) all render at the same diameter and
   * their real size difference is not visible on the map. */
  const MIN_PLAN_EXTENT = 1.2;

  function planSize(id) {
    const p = PROPS[id]?.plan || { len: 0.5, wid: 0.5 };
    const k = Math.max(1, MIN_PLAN_EXTENT / Math.max(p.len, p.wid));
    return { len: p.len * k, wid: p.wid * k };
  }

  const PropCatalog = {
    GROUPS,

    /** Catalogue entry for a blueprint id, or null. */
    get(id) {
      const p = PROPS[id];
      return p ? { id, ...p } : null;
    },

    ids() {
      return Object.keys(PROPS);
    },

    /** Fill colour for a prop, from its group. */
    color(id) {
      const g = GROUPS.find((gr) => gr.id === PROPS[id]?.group);
      return g ? g.color : '#e8801a';
    },

    label(id) {
      return PROPS[id]?.label || id || '';
    },

    oriented(id) {
      return !!PROPS[id]?.oriented;
    },

    /** Placement facing rule — see the header. Independent of `oriented`:
     *  a 'none' prop may still carry a yaw handle for manual rotation. */
    facing(id) {
      return PROPS[id]?.facing || 'none';
    },

    /** MAP GLYPH ONLY: extra rotation of the drawn body, in degrees.
     *  For props whose yaw means "the way the face points", the body has to sit
     *  across that direction — a barrier blocks the lane, it does not lie along
     *  it. Purely cosmetic: the exported h is untouched, and the yaw arrow keeps
     *  pointing at the true facing. */
    planRotate(id) {
      return PROPS[id]?.planRotate || 0;
    },

    defaultZ(id) {
      return PROPS[id]?.z ?? 0.0;
    },

    /** Top-down footprint in metres, clamped for visibility. */
    planSize,

    /** Where the mesh actually sits relative to the prop's pivot, in the
     *  prop's own frame (+X = yaw), in metres. [0, 0] for most props. Not
     *  scaled by planSize's visibility clamp: it is a real position. */
    planOffset(id) {
      const o = PROPS[id]?.plan?.off;
      return o ? { x: o[0], y: o[1] } : { x: 0, y: 0 };
    },

    /** Real (unclamped) size for display: length × width × height, metres. */
    dims(id) {
      const p = PROPS[id];
      if (!p) return null;
      return { len: p.plan.len, wid: p.plan.wid, h: p.side.h };
    },

    /** Top-down SVG shapes for the map marker (local +X = yaw direction). */
    planShapes(id) {
      const { len, wid } = planSize(id);
      return planShapes(PROPS[id]?.plan?.kind, len, wid, this.color(id));
    },

    /** An <svg> element for a palette tile: side-view silhouette. */
    tileIcon(id, size = 30) {
      const s = PROPS[id]?.side || { kind: 'box', w: 1, h: 1 };
      // Silhouettes stand on y=0 rising to -h, so a flat prop would otherwise
      // hug the tile floor and leave dead space above. Centre it instead.
      const long = Math.max(s.w, s.h);
      const k = (size * 0.86) / long; // fit the tile, keep aspect
      const drawnH = Math.max(s.h, long * MIN_SIDE_RATIO) * k;
      const svg = UIUtils.svgEl('svg', { viewBox: `${-size / 2} ${-size} ${size} ${size}` });
      const g = UIUtils.svgEl('g', {
        transform: `translate(0, ${(drawnH - size) / 2}) scale(${k})`,
      });
      sideShapes(s.kind, s.w, s.h, this.color(id)).forEach((el) => g.appendChild(el));
      svg.appendChild(g);
      return svg;
    },

    /** Render the REQUISITEN tab body: a search field, then one collapsible
     *  section per group. With ~80 props a flat tile list is a long scroll, so
     *  sections fold (per-viewer, remembered in localStorage — UI preference,
     *  not scenario state) and the search filters across all of them,
     *  matching the German label or the blueprint id. While a search is
     *  active every section with a hit is shown open regardless of its fold
     *  state, and the fold state itself is left untouched. */
    renderPanel(container) {
      container.textContent = '';
      const collapsed = _loadCollapsed();

      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'prop-search';
      search.placeholder = 'Suchen …';
      search.setAttribute('aria-label', 'Requisiten durchsuchen');
      search.title = 'Name oder CARLA-ID — Esc leert das Feld';
      container.appendChild(search);

      const sections = [];
      for (const group of GROUPS) {
        const ids = Object.keys(PROPS).filter((id) => PROPS[id].group === group.id);
        if (!ids.length) continue;

        const section = document.createElement('div');
        section.className = 'prop-section';
        section.dataset.group = group.id;
        section.classList.toggle('collapsed', collapsed.has(group.id));

        const heading = document.createElement('button');
        heading.type = 'button';
        heading.className = 'toolbar-section-label prop-section-head';
        heading.style.setProperty('--group-color', group.color);
        heading.innerHTML =
          '<span class="prop-section-caret">▾</span>' +
          `<span class="prop-section-name"></span><span class="prop-section-count"></span>`;
        heading.querySelector('.prop-section-name').textContent = group.label.toUpperCase();
        heading.title = `${group.label} ein-/ausklappen`;
        heading.addEventListener('click', () => {
          const now = !section.classList.contains('collapsed');
          section.classList.toggle('collapsed', now);
          heading.setAttribute('aria-expanded', String(!now));
          if (now) collapsed.add(group.id);
          else collapsed.delete(group.id);
          _saveCollapsed(collapsed);
        });
        heading.setAttribute('aria-expanded', String(!collapsed.has(group.id)));
        section.appendChild(heading);

        const grid = document.createElement('div');
        grid.className = 'tool-grid';
        const tiles = [];
        for (const id of ids) {
          const btn = document.createElement('button');
          btn.className = 'tool-btn';
          btn.dataset.tool = 'prop';
          btn.dataset.prop = id;
          const d = this.dims(id);
          btn.title =
            `${PROPS[id].label} platzieren\n${id}\n` +
            `${d.len.toFixed(2)} × ${d.wid.toFixed(2)} × ${d.h.toFixed(2)} m`;
          btn.appendChild(this.tileIcon(id));
          const span = document.createElement('span');
          span.textContent = PROPS[id].label;
          btn.appendChild(span);
          grid.appendChild(btn);
          tiles.push({ btn, hay: `${PROPS[id].label} ${id}`.toLowerCase() });
        }
        section.appendChild(grid);
        container.appendChild(section);
        sections.push({ section, heading, tiles, total: ids.length });
      }

      const empty = document.createElement('div');
      empty.className = 'toolbar-note prop-search-empty hidden';
      empty.textContent = 'Keine Requisite gefunden';
      container.appendChild(empty);

      const applyFilter = () => {
        const q = search.value.trim().toLowerCase();
        let hits = 0;
        for (const sec of sections) {
          let n = 0;
          for (const t of sec.tiles) {
            const show = !q || t.hay.includes(q);
            t.btn.classList.toggle('hidden', !show);
            if (show) n++;
          }
          hits += n;
          sec.section.classList.toggle('hidden', !n);
          sec.section.classList.toggle('searching', !!q);
          sec.heading.querySelector('.prop-section-count').textContent = q ? `${n}/${sec.total}` : String(sec.total);
        }
        empty.classList.toggle('hidden', hits > 0);
      };
      search.addEventListener('input', applyFilter);
      // Esc clears the field and stops there: without stopPropagation it would
      // also reach mapView's Esc and disarm the prop tool the user just picked.
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && search.value) {
          search.value = '';
          applyFilter();
          e.stopPropagation();
        }
      });
      applyFilter();

      const note = document.createElement('div');
      note.className = 'toolbar-note';
      note.textContent = 'Shift-Klick: an Fahrspur ausrichten';
      container.appendChild(note);
    },
  };

  /* Folded sections, per viewer. Every accessor can throw (private window,
   * blocked storage), and the panel must work without it. Default: everything
   * past the first two groups starts folded, so the work-zone and road-hazard
   * props — the ones scenarios mostly use — are visible without a scroll. */
  const COLLAPSE_KEY = 'scenarioEditor.propSections';
  function _loadCollapsed() {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      if (raw) return new Set(JSON.parse(raw));
    } catch (_) {
      /* fall through to the default */
    }
    return new Set(GROUPS.slice(2).map((g) => g.id));
  }
  function _saveCollapsed(set) {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
    } catch (_) {
      /* nicety only */
    }
  }

  window.PropCatalog = PropCatalog;
})();
