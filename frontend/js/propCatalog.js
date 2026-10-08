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
(function () {
  'use strict';

  const GROUPS = [
    { id: 'workzone', label: 'Baustelle',          color: '#e8801a' },
    { id: 'surface',  label: 'Fahrbahn',           color: '#a06a2c' },
    { id: 'cargo',    label: 'Verlorene Ladung',   color: '#b0607a' },
    { id: 'waste',    label: 'Abfall & Container', color: '#4d7480' },
    { id: 'street',   label: 'Straßenmöbel',       color: '#6b7a8f' },
    { id: 'garden',   label: 'Garten & Freizeit',  color: '#7c9a2a' },
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
      label: 'Leitfass', group: 'workzone', z: 0.0, oriented: false, facing: 'none',
      side: { kind: 'drum_striped', w: 0.88, h: 1.13 },
      plan: { kind: 'cone', len: 0.88, wid: 0.88 },
    },
    'static.prop.trafficcone02': {
      label: 'Leitpfosten', group: 'workzone', z: 0.0, oriented: false, facing: 'none',
      side: { kind: 'delineator', w: 0.46, h: 1.18 },
      plan: { kind: 'cone', len: 0.46, wid: 0.39 },
    },
    'static.prop.constructioncone': {
      label: 'Leitkegel', group: 'workzone', z: 0.0, oriented: false, facing: 'none',
      side: { kind: 'cone', w: 0.34, h: 0.59 },
      plan: { kind: 'cone', len: 0.34, wid: 0.34 },
    },
    'static.prop.streetbarrier': {
      label: 'Absperrung', group: 'workzone', z: 0.0, oriented: true, facing: 'oncoming', planRotate: 90,
      side: { kind: 'jersey', w: 1.21, h: 1.07 },
      plan: { kind: 'barrier', len: 1.21, wid: 0.37 },
    },
    'static.prop.chainbarrier': {
      label: 'Kettensperre', group: 'workzone', z: 0.0, oriented: true, facing: 'oncoming',
      side: { kind: 'chain', w: 1.49, h: 0.89 },
      plan: { kind: 'chain', len: 0.24, wid: 1.49, off: [0.0, 0.63] },
    },
    'static.prop.chainbarrierend': {
      label: 'Kettenpfosten', group: 'workzone', z: 0.0, oriented: false, facing: 'none',
      side: { kind: 'post', w: 0.24, h: 0.89 },
      plan: { kind: 'drum', len: 0.24, wid: 0.24 },
    },
    'static.prop.trafficwarning': {
      label: 'Warnanhänger', group: 'workzone', z: 0.0, oriented: true, facing: 'oncoming', planRotate: 90,
      side: { kind: 'arrowboard', w: 2.87, h: 3.57 },
      plan: { kind: 'trailer', len: 2.37, wid: 2.87 },
    },
    'static.prop.warningconstruction': {
      label: 'Bauschild', group: 'workzone', z: 0.0, oriented: true, facing: 'oncoming',
      side: { kind: 'signtri', w: 1.31, h: 1.86 },
      plan: { kind: 'panel', len: 0.30, wid: 1.31 },
    },
    'static.prop.warningaccident': {
      label: 'Unfallschild', group: 'workzone', z: 0.0, oriented: true, facing: 'oncoming',
      side: { kind: 'signtri_a', w: 1.31, h: 1.86 },
      plan: { kind: 'panel', len: 0.30, wid: 1.31 },
    },
    'static.prop.barrel': {
      label: 'Fass', group: 'workzone', z: 0.0, oriented: false, facing: 'none',
      side: { kind: 'barrel', w: 0.47, h: 0.81 },
      plan: { kind: 'drum', len: 0.46, wid: 0.47 },
    },

    // ── Fahrbahn ────────────────────────────────────────
    'static.prop.ironplank': {
      label: 'Stahlplatte', group: 'surface', z: 0.0, oriented: true, facing: 'along',
      side: { kind: 'plank', w: 1.45, h: 0.02 },
      plan: { kind: 'plate', len: 1.45, wid: 1.17 },
    },
    'static.prop.dirtdebris01': {
      label: 'Schutt 1', group: 'surface', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'debris', w: 1.86, h: 0.15 },
      plan: { kind: 'blob', len: 1.86, wid: 1.51 },
    },
    'static.prop.dirtdebris02': {
      label: 'Schutt 2', group: 'surface', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'debris', w: 1.86, h: 0.15 },
      plan: { kind: 'blob', len: 1.86, wid: 1.51 },
    },
    'static.prop.dirtdebris03': {
      label: 'Schutt 3', group: 'surface', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'debris', w: 1.86, h: 0.19 },
      plan: { kind: 'blob', len: 1.86, wid: 1.51 },
    },
    'static.prop.creasedbox01': {
      label: 'Pappe klein', group: 'surface', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'flat', w: 0.81, h: 0.12 },
      plan: { kind: 'flat', len: 0.81, wid: 0.71 },
    },
    'static.prop.creasedbox02': {
      label: 'Pappe geknickt', group: 'surface', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'flat', w: 1.63, h: 0.21 },
      plan: { kind: 'flat', len: 1.63, wid: 0.71 },
    },
    'static.prop.creasedbox03': {
      label: 'Pappe flach', group: 'surface', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'flat', w: 1.67, h: 0.02 },
      plan: { kind: 'flat', len: 1.67, wid: 0.71, off: [0.12, 0.0] },
    },
    'static.prop.walkingkid': {
      label: 'Kind-Bild', group: 'surface', z: 0.0, oriented: true, facing: 'along',
      side: { kind: 'decal', w: 1.00, h: 0.00 },
      plan: { kind: 'decal', len: 0.59, wid: 1.00 },
    },
    'static.prop.walkingkidlarge': {
      label: 'Kind-Bild groß', group: 'surface', z: 0.0, oriented: true, facing: 'along',
      side: { kind: 'decal', w: 2.00, h: 0.00 },
      plan: { kind: 'decal', len: 1.18, wid: 2.00 },
    },

    // ── Verlorene Ladung ────────────────────────────────────────
    'static.prop.box01': {
      label: 'Karton 1', group: 'cargo', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'box', w: 0.65, h: 0.69 },
      plan: { kind: 'box', len: 0.65, wid: 0.65 },
    },
    'static.prop.box02': {
      label: 'Karton 2', group: 'cargo', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'box', w: 0.65, h: 0.65 },
      plan: { kind: 'box', len: 0.65, wid: 0.65 },
    },
    'static.prop.box03': {
      label: 'Karton 3', group: 'cargo', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'box', w: 0.67, h: 0.65 },
      plan: { kind: 'box', len: 0.66, wid: 0.67 },
    },
    'static.prop.haybalelb': {
      label: 'Heuballen', group: 'cargo', z: 0.11, oriented: true, facing: 'none',
      side: { kind: 'hay', w: 1.25, h: 1.19 },
      plan: { kind: 'hay', len: 1.25, wid: 1.19 },
    },
    'static.prop.travelcase': {
      label: 'Koffer', group: 'cargo', z: 1.26, oriented: true, facing: 'none',
      side: { kind: 'suitcase', w: 0.57, h: 1.26 },
      plan: { kind: 'case', len: 0.57, wid: 0.33, off: [0.01, 0.14] },
    },
    'static.prop.briefcase': {
      label: 'Aktentasche', group: 'cargo', z: 0.43, oriented: true, facing: 'none',
      side: { kind: 'briefcase', w: 0.54, h: 0.43 },
      plan: { kind: 'case', len: 0.54, wid: 0.18 },
    },
    'static.prop.guitarcase': {
      label: 'Gitarrenkoffer', group: 'cargo', z: 0.47, oriented: true, facing: 'none',
      side: { kind: 'guitar', w: 1.24, h: 0.49 },
      plan: { kind: 'case', len: 1.24, wid: 0.13 },
    },
    'static.prop.shoppingbag': {
      label: 'Einkaufstüte', group: 'cargo', z: 0.58, oriented: true, facing: 'none',
      side: { kind: 'bag', w: 0.47, h: 0.60 },
      plan: { kind: 'bag', len: 0.47, wid: 0.24 },
    },
    'static.prop.plasticbag': {
      label: 'Plastiktüte', group: 'cargo', z: 0.53, oriented: true, facing: 'none',
      side: { kind: 'bag', w: 0.40, h: 0.55 },
      plan: { kind: 'bag', len: 0.31, wid: 0.40 },
    },
    'static.prop.purse': {
      label: 'Handtasche', group: 'cargo', z: -0.89, oriented: true, facing: 'none',
      side: { kind: 'bag', w: 0.33, h: 0.59 },
      plan: { kind: 'bag', len: 0.16, wid: 0.33, off: [-0.26, 0.06] },
    },
    'static.prop.motorhelmet': {
      label: 'Motorradhelm', group: 'cargo', z: 0.23, oriented: true, facing: 'none',
      side: { kind: 'helmet', w: 0.26, h: 0.26 },
      plan: { kind: 'drum', len: 0.20, wid: 0.26 },
    },
    'static.prop.bike helmet': {
      label: 'Fahrradhelm', group: 'cargo', z: 0.14, oriented: true, facing: 'none',
      side: { kind: 'helmet', w: 0.28, h: 0.17 },
      plan: { kind: 'drum', len: 0.19, wid: 0.28 },
    },
    'static.prop.shoppingcart': {
      label: 'Einkaufswagen', group: 'cargo', z: 1.08, oriented: true, facing: 'none',
      side: { kind: 'cart', w: 1.21, h: 1.08 },
      plan: { kind: 'cart', len: 0.67, wid: 1.21, off: [-0.16, 0.58] },
    },
    'static.prop.shoppingtrolley': {
      label: 'Einkaufstrolley', group: 'cargo', z: 1.08, oriented: true, facing: 'none',
      side: { kind: 'trolley', w: 0.51, h: 1.09 },
      plan: { kind: 'case', len: 0.51, wid: 0.33 },
    },

    // ── Abfall & Container ────────────────────────────────────────
    'static.prop.bin': {
      label: 'Mülltonne', group: 'waste', z: 0.0, oriented: false, facing: 'none',
      side: { kind: 'bin', w: 0.64, h: 1.06 },
      plan: { kind: 'drum', len: 0.55, wid: 0.64 },
    },
    'static.prop.trashcan01': {
      label: 'Blechtonne', group: 'waste', z: 0.0, oriented: false, facing: 'none',
      side: { kind: 'can', w: 0.64, h: 0.85 },
      plan: { kind: 'drum', len: 0.64, wid: 0.57 },
    },
    'static.prop.trashcan02': {
      label: 'Pfostenkorb', group: 'waste', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'postbin', w: 0.52, h: 1.05 },
      plan: { kind: 'drum', len: 0.52, wid: 0.51 },
    },
    'static.prop.trashcan03': {
      label: 'Blechtonne alt', group: 'waste', z: 0.0, oriented: false, facing: 'none',
      side: { kind: 'can', w: 0.63, h: 0.93 },
      plan: { kind: 'drum', len: 0.63, wid: 0.55 },
    },
    'static.prop.trashcan04': {
      label: 'Abfallbox', group: 'waste', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'cabinet', w: 0.79, h: 1.02 },
      plan: { kind: 'box', len: 0.79, wid: 0.58 },
    },
    'static.prop.trashcan05': {
      label: 'Abfallbox grau', group: 'waste', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'cabinet', w: 0.79, h: 1.02 },
      plan: { kind: 'box', len: 0.79, wid: 0.58 },
    },
    'static.prop.trashbag': {
      label: 'Müllsack', group: 'waste', z: 0.0, oriented: false, facing: 'none',
      side: { kind: 'sack', w: 0.43, h: 0.70 },
      plan: { kind: 'drum', len: 0.38, wid: 0.43 },
    },
    'static.prop.container': {
      label: 'Container', group: 'waste', z: 0.0, oriented: true, facing: 'alongside',
      side: { kind: 'container', w: 1.93, h: 1.71 },
      plan: { kind: 'container', len: 1.93, wid: 1.01, off: [0.0, 1.1] },
    },
    'static.prop.clothcontainer': {
      label: 'Kleidercontainer', group: 'waste', z: 0.0, oriented: true, facing: 'along',
      side: { kind: 'container', w: 1.89, h: 1.81 },
      plan: { kind: 'container', len: 1.89, wid: 1.24 },
    },
    'static.prop.glasscontainer': {
      label: 'Glascontainer', group: 'waste', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'dome', w: 2.01, h: 1.79 },
      plan: { kind: 'box', len: 1.95, wid: 2.01 },
    },

    // ── Straßenmöbel ────────────────────────────────────────
    'static.prop.busstop': {
      label: 'Bushaltestelle', group: 'street', z: 0.0, oriented: true, facing: 'alongside',
      side: { kind: 'shelter', w: 3.88, h: 2.74 },
      plan: { kind: 'shelter', len: 3.88, wid: 1.89, off: [0.37, 0.18] },
    },
    'static.prop.bench01': {
      label: 'Bank', group: 'street', z: 0.0, oriented: true, facing: 'along',
      side: { kind: 'bench', w: 1.54, h: 0.97 },
      plan: { kind: 'bench', len: 1.54, wid: 0.74 },
    },
    'static.prop.bench02': {
      label: 'Bank ohne Lehne', group: 'street', z: 0.0, oriented: true, facing: 'along',
      side: { kind: 'bench_flat', w: 1.56, h: 0.51 },
      plan: { kind: 'bench', len: 1.56, wid: 0.54 },
    },
    'static.prop.bench03': {
      label: 'Steinbank', group: 'street', z: 0.0, oriented: true, facing: 'along',
      side: { kind: 'bench_flat', w: 1.58, h: 0.51 },
      plan: { kind: 'bench', len: 1.58, wid: 0.51 },
    },
    'static.prop.advertisement': {
      label: 'Werbetafel', group: 'street', z: 0.0, oriented: true, facing: 'oncoming',
      side: { kind: 'billboard', w: 1.55, h: 2.44 },
      plan: { kind: 'panel', len: 0.29, wid: 1.55 },
    },
    'static.prop.streetsign': {
      label: 'Infoschild', group: 'street', z: 0.0, oriented: true, facing: 'oncoming',
      side: { kind: 'billboard', w: 1.06, h: 2.15 },
      plan: { kind: 'panel', len: 0.13, wid: 1.06 },
    },
    'static.prop.streetsign01': {
      label: 'Hängeschild', group: 'street', z: 0.0, oriented: true, facing: 'oncoming',
      side: { kind: 'billboard', w: 2.47, h: 3.88 },
      plan: { kind: 'panel', len: 0.30, wid: 2.47 },
    },
    'static.prop.streetsign04': {
      label: 'Plakatständer', group: 'street', z: 0.0, oriented: true, facing: 'oncoming',
      side: { kind: 'billboard', w: 1.17, h: 2.77 },
      plan: { kind: 'panel', len: 0.12, wid: 1.17 },
    },
    'static.prop.vendingmachine': {
      label: 'Automat', group: 'street', z: 0.07, oriented: true, facing: 'toward-road',
      side: { kind: 'cabinet', w: 1.10, h: 2.11 },
      plan: { kind: 'box', len: 0.87, wid: 1.10 },
    },
    'static.prop.atm': {
      label: 'Geldautomat', group: 'street', z: 0.0, oriented: true, facing: 'toward-road',
      side: { kind: 'cabinet', w: 0.87, h: 2.28 },
      plan: { kind: 'box', len: 0.87, wid: 0.71 },
    },
    'static.prop.mailbox': {
      label: 'Briefkasten', group: 'street', z: 0.0, oriented: true, facing: 'toward-road',
      side: { kind: 'postbox', w: 0.53, h: 1.16 },
      plan: { kind: 'box', len: 0.44, wid: 0.53, off: [-0.18, -0.19] },
    },
    'static.prop.kiosk_01': {
      label: 'Telefonzelle', group: 'street', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'booth', w: 1.65, h: 3.25 },
      plan: { kind: 'box', len: 1.63, wid: 1.65 },
    },
    'static.prop.maptable': {
      label: 'Infotafel', group: 'street', z: 0.0, oriented: true, facing: 'toward-road',
      side: { kind: 'maptable', w: 1.57, h: 1.18 },
      plan: { kind: 'panel', len: 0.30, wid: 1.57, off: [0.29, 0.0] },
    },
    'static.prop.streetfountain': {
      label: 'Trinkbrunnen', group: 'street', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'post', w: 0.67, h: 1.26 },
      plan: { kind: 'box', len: 0.29, wid: 0.67, off: [0.0, 0.17] },
    },
    'static.prop.foodcart': {
      label: 'Imbisswagen', group: 'street', z: 0.0, oriented: true, facing: 'along',
      side: { kind: 'foodcart', w: 4.64, h: 3.57 },
      plan: { kind: 'cart', len: 4.64, wid: 2.28, off: [-0.39, -0.45] },
    },

    // ── Garten & Freizeit ────────────────────────────────────────
    'static.prop.plantpot01': {
      label: 'Pflanzkübel Holz', group: 'garden', z: 0.0, oriented: true, facing: 'along',
      side: { kind: 'planter', w: 1.09, h: 0.56 },
      plan: { kind: 'box', len: 1.09, wid: 0.48 },
    },
    'static.prop.plantpot02': {
      label: 'Pflanzkübel rot', group: 'garden', z: 0.0, oriented: true, facing: 'along',
      side: { kind: 'planter', w: 1.05, h: 0.49 },
      plan: { kind: 'box', len: 1.05, wid: 0.43 },
    },
    'static.prop.plantpot03': {
      label: 'Pflanzkübel grau', group: 'garden', z: 0.0, oriented: true, facing: 'along',
      side: { kind: 'planter', w: 1.05, h: 0.49 },
      plan: { kind: 'box', len: 1.05, wid: 0.43 },
    },
    'static.prop.plantpot04': {
      label: 'Pflanzbeet lang', group: 'garden', z: 0.0, oriented: true, facing: 'along',
      side: { kind: 'planter', w: 4.97, h: 0.12 },
      plan: { kind: 'box', len: 4.97, wid: 0.74 },
    },
    'static.prop.plantpot05': {
      label: 'Blumentopf', group: 'garden', z: 0.0, oriented: false, facing: 'none',
      side: { kind: 'pot', w: 0.40, h: 0.28 },
      plan: { kind: 'drum', len: 0.40, wid: 0.40 },
    },
    'static.prop.plantpot06': {
      label: 'Pflanzschale', group: 'garden', z: 0.0, oriented: false, facing: 'none',
      side: { kind: 'bowl', w: 1.59, h: 0.85 },
      plan: { kind: 'drum', len: 1.59, wid: 1.59 },
    },
    'static.prop.plantpot07': {
      label: 'Pflanzkübel klein', group: 'garden', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'planter', w: 0.49, h: 0.56 },
      plan: { kind: 'box', len: 0.49, wid: 0.48 },
    },
    'static.prop.plantpot08': {
      label: 'Pflanztopf eckig', group: 'garden', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'pot', w: 0.53, h: 0.49 },
      plan: { kind: 'box', len: 0.53, wid: 0.53 },
    },
    'static.prop.plasticchair': {
      label: 'Gartenstuhl', group: 'garden', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'chair', w: 0.75, h: 1.27 },
      plan: { kind: 'box', len: 0.73, wid: 0.75 },
    },
    'static.prop.plastictable': {
      label: 'Gartentisch', group: 'garden', z: 0.0, oriented: false, facing: 'none',
      side: { kind: 'parasol', w: 2.48, h: 2.48 },
      plan: { kind: 'drum', len: 2.48, wid: 2.48 },
    },
    'static.prop.table': {
      label: 'Picknicktisch', group: 'garden', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'picnic', w: 2.16, h: 0.85 },
      plan: { kind: 'bench', len: 2.16, wid: 2.15 },
    },
    'static.prop.barbeque': {
      label: 'Grill', group: 'garden', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'grill', w: 0.95, h: 1.26 },
      plan: { kind: 'box', len: 0.95, wid: 0.50 },
    },
    'static.prop.gnome': {
      label: 'Gartenzwerg', group: 'garden', z: 0.0, oriented: false, facing: 'none',
      side: { kind: 'gnome', w: 0.38, h: 0.88 },
      plan: { kind: 'drum', len: 0.37, wid: 0.38 },
    },
    'static.prop.doghouse': {
      label: 'Hundehütte', group: 'garden', z: 0.06, oriented: true, facing: 'none',
      side: { kind: 'doghouse', w: 1.27, h: 1.09 },
      plan: { kind: 'box', len: 1.08, wid: 1.27 },
    },
    'static.prop.gardenlamp': {
      label: 'Gartenlaterne', group: 'garden', z: 0.0, oriented: false, facing: 'none',
      side: { kind: 'lamp', w: 0.30, h: 0.65 },
      plan: { kind: 'drum', len: 0.30, wid: 0.28 },
    },
    'static.prop.swing': {
      label: 'Schaukel', group: 'garden', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'swing', w: 4.11, h: 2.57 },
      plan: { kind: 'frame', len: 4.11, wid: 1.58 },
    },
    'static.prop.swingcouch': {
      label: 'Hollywoodschaukel', group: 'garden', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'swingcouch', w: 2.36, h: 2.25 },
      plan: { kind: 'frame', len: 2.36, wid: 1.36, off: [0.2, 0.0] },
    },
    'static.prop.slide': {
      label: 'Rutsche', group: 'garden', z: 0.0, oriented: true, facing: 'none',
      side: { kind: 'slide', w: 4.12, h: 1.98 },
      plan: { kind: 'slide', len: 4.12, wid: 0.94, off: [-1.58, -0.16] },
    },
    'static.prop.trampoline': {
      label: 'Trampolin', group: 'garden', z: 0.0, oriented: false, facing: 'none',
      side: { kind: 'trampoline', w: 4.13, h: 2.80 },
      plan: { kind: 'drum', len: 4.13, wid: 4.13 },
    },
    'static.prop.pergola': {
      label: 'Pergola', group: 'garden', z: 0.23, oriented: true, facing: 'none',
      side: { kind: 'pergola', w: 5.09, h: 3.54 },
      plan: { kind: 'frame', len: 5.03, wid: 5.09 },
    },
    'static.prop.clothesline': {
      label: 'Wäscheleine', group: 'garden', z: 0.06, oriented: true, facing: 'none',
      side: { kind: 'clothesline', w: 1.12, h: 2.06 },
      plan: { kind: 'chain', len: 6.65, wid: 1.12 },
    },
  };

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function _el(tag, attrs) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  /* ── Side view (elevation) — palette tiles ───────────────────────────────────
   * Flat silhouettes standing on the ground line y=0, centred on x=0, rising to
   * y=-h. Fills use the group colour; white low-opacity accents only, matching
   * the rest of the map's visual language. No gradients, no shading.
   *
   * Objects with an extreme aspect ratio (a 0.05 m road plate, a 0.3 m sign
   * post) degenerate into a hairline at true proportion, so those shapes floor
   * one dimension — see MIN_SIDE_RATIO.
   */
  const MIN_SIDE_RATIO = 0.30;   // no silhouette thinner than 30% of its long side

  function sideShapes(kind, w, h, color) {
    // Keep degenerate aspect ratios legible without distorting normal props.
    const long = Math.max(w, h);
    w = Math.max(w, long * MIN_SIDE_RATIO);
    h = Math.max(h, long * MIN_SIDE_RATIO);

    const out = [];
    const X = n => n * w, Y = n => -n * h;
    const u = Math.min(w, h);
    const rect = (x, y, ww, hh, o = {}) => out.push(_el('rect', {
      x: X(x), y: Y(y), width: ww * w, height: hh * h,
      fill: o.fill || color, ...(o.op ? { 'fill-opacity': o.op } : {}),
      ...(o.rx ? { rx: o.rx * u } : {}),
    }));
    const poly = (pts, o = {}) => out.push(_el('polygon', {
      points: pts.map(([x, y]) => `${X(x)},${Y(y)}`).join(' '),
      fill: o.fill || color, ...(o.op ? { 'fill-opacity': o.op } : {}),
    }));
    const circ = (cx, cy, r, o = {}) => out.push(_el('circle', {
      cx: X(cx), cy: Y(cy), r: r * u,
      fill: o.fill || color, ...(o.op ? { 'fill-opacity': o.op } : {}),
    }));
    const path = (d, sw) => out.push(_el('path', {
      d, fill: 'none', stroke: color, 'stroke-width': sw * h, 'stroke-linecap': 'round',
    }));

    switch (kind) {
      case 'cone':                                    // tapered body, flat top, base slab
        poly([[-.34, .10], [.34, .10], [.09, 1], [-.09, 1]]);
        rect(-.5, .13, 1, .13, { rx: .10 });
        rect(-.26, .62, .52, .14, { fill: '#fff', op: .8 });
        break;
      case 'barrel':                                  // drum with two rim bands
        rect(-.5, 1, 1, 1, { rx: .10 });
        rect(-.5, .74, 1, .07, { fill: '#fff', op: .75 });
        rect(-.5, .34, 1, .07, { fill: '#fff', op: .75 });
        break;
      case 'bin':                                     // tapered body + lid overhang
        poly([[-.40, 0], [.40, 0], [.46, .86], [-.46, .86]]);
        rect(-.5, 1, 1, .15, { rx: .12 });
        break;
      case 'jersey':                                  // sloped skirt, flat top
        poly([[-.5, 0], [.5, 0], [.33, .52], [.29, 1], [-.29, 1], [-.33, .52]]);
        rect(-.30, .80, .60, .10, { fill: '#fff', op: .7 });
        break;
      case 'arrowboard':                              // board on mast, chassis + wheels
        rect(-.44, 1, .88, .46, { rx: .06 });
        rect(-.30, .54, .60, .10, { fill: '#fff', op: .75 });
        rect(-.06, .54, .12, .30);
        rect(-.40, .24, .80, .10, { rx: .04 });
        circ(-.20, .09, .095);
        circ(.24, .09, .095);
        break;
      case 'signtri':                                 // triangle sign on a single post
        rect(-.06, .46, .12, .46);
        rect(-.22, .05, .44, .05, { rx: .04 });
        poly([[0, 1], [.45, .44], [-.45, .44]]);
        poly([[0, .90], [.31, .50], [-.31, .50]], { fill: '#fff', op: .85 });
        break;
      case 'signtri_a':                               // same sign on a splayed A-frame
        poly([[0, 1], [.45, .44], [-.45, .44]]);
        poly([[0, .90], [.31, .50], [-.31, .50]], { fill: '#fff', op: .85 });
        poly([[-.05, .46], [.05, .46], [.34, 0], [.22, 0]]);
        poly([[.05, .46], [-.05, .46], [-.34, 0], [-.22, 0]]);
        break;
      case 'billboard':                               // raised panel on two legs
        rect(-.26, .40, .09, .40);
        rect(.17, .40, .09, .40);
        rect(-.5, 1, 1, .60, { rx: .04 });
        rect(-.44, .94, .88, .48, { fill: '#fff', op: .8 });
        break;
      case 'container':                               // long box, corner posts, ribs
        rect(-.5, 1, 1, 1, { rx: .03 });
        for (let i = 1; i < 12; i++) {
          rect(-.5 + i / 12, .92, .022, .84, { fill: '#fff', op: .28 });
        }
        rect(-.5, 1, .05, 1);
        rect(.45, 1, .05, 1);
        break;
      case 'shelter':                                 // roof slab, end posts, bench
        rect(-.5, 1, 1, .11, { rx: .03 });
        rect(-.47, .89, .07, .89);
        rect(.40, .89, .07, .89);
        rect(-.40, .70, .80, .62, { fill: '#fff', op: .35 });
        rect(-.34, .34, .68, .09, { rx: .04 });
        rect(-.30, .25, .06, .25);
        rect(.24, .25, .06, .25);
        break;
      case 'cabinet':                                 // body, window, plinth
        rect(-.5, 1, 1, .94, { rx: .05 });
        rect(-.38, .90, .58, .56, { fill: '#fff', op: .75 });
        rect(-.5, .06, 1, .06, { rx: .02 });
        break;
      case 'cart':                                    // basket, handle, wheels
        poly([[-.34, .72], [.44, .76], [.36, .30], [-.26, .28]]);
        path(`M ${X(-.34)} ${Y(.72)} L ${X(-.46)} ${Y(.92)}`, .06);
        circ(-.20, .09, .085);
        circ(.28, .09, .085);
        break;
      case 'plank':                                   // thin slab, bevelled ends
        poly([[-.5, .18], [.5, .18], [.44, .82], [-.44, .82]]);
        break;
      case 'debris':                                  // low irregular mound
        path(`M ${X(-.5)} 0 Q ${X(-.34)} ${Y(.70)} ${X(-.14)} ${Y(.58)}
              Q ${X(.02)} ${Y(.82)} ${X(.20)} ${Y(.55)}
              Q ${X(.38)} ${Y(.68)} ${X(.5)} 0 Z`, 0);
        out[out.length - 1].setAttribute('fill', color);
        out[out.length - 1].removeAttribute('stroke');
        break;
      case 'drum_striped':                            // traffic drum on a base slab
        rect(-.5, .07, 1, .07, { rx: .10 });
        rect(-.36, 1, .72, .92, { rx: .12 });
        rect(-.36, .76, .72, .10, { fill: '#fff', op: .8 });
        rect(-.36, .48, .72, .10, { fill: '#fff', op: .8 });
        break;
      case 'delineator':                              // tall tapered post on a foot
        rect(-.5, .08, 1, .08, { rx: .10 });
        poly([[-.22, .08], [.22, .08], [.12, 1], [-.12, 1]]);
        rect(-.16, .86, .32, .08, { fill: '#fff', op: .8 });
        break;
      case 'post':                                    // bollard / pillar
        rect(-.5, 1, 1, 1, { rx: .4 });
        rect(-.5, .86, 1, .08, { fill: '#fff', op: .6 });
        break;
      case 'chain':                                   // post with a sagging chain
        rect(-.5, 1, .12, 1, { rx: .3 });
        path(`M ${X(-.38)} ${Y(.78)} Q ${X(.06)} ${Y(.30)} ${X(.5)} ${Y(.78)}`, .05);
        break;
      case 'flat':                                    // creased cardboard on the ground
        poly([[-.5, 0], [.5, 0], [.44, .62], [-.08, 1], [-.46, .55]]);
        break;
      case 'decal':                                   // painted mat with a figure on it
        rect(-.5, .5, 1, .5, { rx: .05, op: .55 });
        circ(0, .84, .14, { fill: '#fff', op: .9 });
        rect(-.07, .70, .14, .62, { fill: '#fff', op: .9 });
        break;
      case 'box':                                     // carton with a tape strip
        rect(-.5, 1, 1, 1, { rx: .04 });
        rect(-.07, 1, .14, 1, { fill: '#fff', op: .35 });
        break;
      case 'hay':                                     // round bale, end on
        circ(0, .5, .5);
        circ(0, .5, .30, { fill: '#fff', op: .22 });
        circ(0, .5, .12, { fill: '#fff', op: .22 });
        break;
      case 'suitcase':                                // upright case, handle, wheels
        rect(-.5, .86, 1, .80, { rx: .12 });
        rect(-.08, 1, .16, .14);
        rect(-.5, .55, 1, .05, { fill: '#fff', op: .4 });
        circ(-.32, .04, .05);
        circ(.32, .04, .05);
        break;
      case 'briefcase':                               // flat case + handle loop
        rect(-.5, .78, 1, .78, { rx: .10 });
        rect(-.18, 1, .36, .07);
        rect(-.18, 1, .06, .22);
        rect(.12, 1, .06, .22);
        break;
      case 'guitar':                                  // guitar case, body + neck
        circ(-.28, .5, .5);
        rect(-.12, .70, .62, .40, { rx: .2 });
        break;
      case 'bag':                                     // tote with handle
        poly([[-.42, 0], [.42, 0], [.36, .72], [-.36, .72]]);
        path(`M ${X(-.18)} ${Y(.72)} Q ${X(0)} ${Y(1.25)} ${X(.18)} ${Y(.72)}`, .07);
        break;
      case 'helmet':                                  // dome with a visor
        out.push(_el('path', {
          d: `M ${X(-.5)} 0 A ${w / 2} ${h} 0 0 1 ${X(.5)} 0 Z`, fill: color,
        }));
        rect(-.05, .55, .5, .2, { fill: '#fff', op: .6, rx: .2 });
        break;
      case 'trolley':                                 // shopping trolley bag on wheels
        rect(-.40, .80, .80, .70, { rx: .2 });
        path(`M ${X(.30)} ${Y(.80)} L ${X(.42)} ${Y(1)}`, .05);
        circ(-.22, .05, .06);
        circ(.22, .05, .06);
        break;
      case 'can':                                     // metal dustbin with lid
        rect(-.42, .90, .84, .88, { rx: .06 });
        rect(-.5, .97, 1, .08, { rx: .2 });
        rect(-.08, 1, .16, .05);
        rect(-.42, .62, .84, .04, { fill: '#fff', op: .4 });
        rect(-.42, .32, .84, .04, { fill: '#fff', op: .4 });
        break;
      case 'postbin':                                 // bin hung on a post
        rect(-.06, .60, .12, .60);
        rect(-.40, 1, .80, .46, { rx: .10 });
        rect(-.30, .04, .60, .04);
        break;
      case 'sack':                                    // knotted bin bag
        poly([[-.46, .10], [-.5, .5], [-.25, .88], [0, .96], [.25, .88], [.5, .5], [.46, .10], [.30, 0], [-.30, 0]]);
        circ(0, .95, .10);
        break;
      case 'dome':                                    // bottle bank, rounded top
        path(`M ${X(-.5)} 0 L ${X(-.5)} ${Y(.6)} Q ${X(-.5)} ${Y(1)} ${X(0)} ${Y(1)}
              Q ${X(.5)} ${Y(1)} ${X(.5)} ${Y(.6)} L ${X(.5)} 0 Z`, 0);
        out[out.length - 1].setAttribute('fill', color);
        out[out.length - 1].removeAttribute('stroke');
        rect(-.5, .14, 1, .07, { fill: '#fff', op: .4 });
        circ(0, .72, .08, { fill: '#fff', op: .6 });
        break;
      case 'bench':                                   // seat, backrest, legs
        rect(-.5, 1, 1, .24, { rx: .04 });
        rect(-.5, .55, 1, .12, { rx: .04 });
        rect(-.44, .76, .06, .76);
        rect(.38, .76, .06, .76);
        break;
      case 'bench_flat':                              // slab seat on two legs
        rect(-.5, 1, 1, .24, { rx: .05 });
        rect(-.40, .78, .10, .78);
        rect(.30, .78, .10, .78);
        break;
      case 'postbox':                                 // round-topped mailbox on legs
        rect(-.5, .96, 1, .62, { rx: .35 });
        rect(-.36, .36, .12, .36);
        rect(.24, .36, .12, .36);
        rect(-.26, .84, .52, .06, { fill: '#fff', op: .8 });
        break;
      case 'booth':                                   // phone booth, glazed
        rect(-.5, 1, 1, 1, { rx: .04 });
        rect(-.38, .90, .76, .55, { fill: '#fff', op: .45 });
        rect(-.38, .30, .76, .18, { fill: '#fff', op: .3 });
        break;
      case 'maptable':                                // slanted board on two legs
        rect(-.46, .78, .10, .78);
        rect(.36, .78, .10, .78);
        poly([[-.5, .74], [.5, .74], [.5, 1], [-.5, .9]]);
        poly([[-.42, .78], [.42, .78], [.42, .95], [-.42, .88]], { fill: '#fff', op: .7 });
        break;
      case 'foodcart':                                // canopy on poles, counter, wheels
        rect(-.5, 1, 1, .12, { rx: .04 });
        rect(-.45, .88, .04, .40);
        rect(.41, .88, .04, .40);
        rect(-.45, .50, .90, .40, { rx: .03 });
        rect(-.35, .45, .40, .20, { fill: '#fff', op: .6 });
        circ(-.25, .08, .08);
        circ(.25, .08, .08);
        break;
      case 'planter':                                 // trough with a rim
        rect(-.5, 1, 1, 1, { rx: .05 });
        rect(-.5, 1, 1, .12, { fill: '#fff', op: .3 });
        break;
      case 'pot':                                     // tapered flower pot
        poly([[-.5, 1], [.5, 1], [.36, 0], [-.36, 0]]);
        rect(-.5, 1, 1, .14, { fill: '#fff', op: .3 });
        break;
      case 'bowl':                                    // wide bowl on ball feet
        poly([[-.5, 1], [.5, 1], [.30, .35], [-.30, .35]]);
        circ(-.18, .14, .14);
        circ(.18, .14, .14);
        break;
      case 'chair':                                   // garden chair, side view
        rect(-.36, 1, .12, .60);
        rect(-.36, .52, .82, .08);
        rect(-.36, .72, .76, .05);
        rect(-.36, .46, .06, .46);
        rect(.40, .46, .06, .46);
        break;
      case 'parasol':                                 // table under a parasol
        poly([[-.5, .82], [0, 1], [.5, .82]]);
        rect(-.02, .90, .04, .90);
        rect(-.42, .34, .84, .05);
        rect(-.38, .30, .04, .30);
        rect(.34, .30, .04, .30);
        break;
      case 'picnic':                                  // table, benches, crossed legs
        rect(-.5, 1, 1, .10);
        rect(-.5, .55, 1, .07);
        path(`M ${X(-.30)} 0 L ${X(.30)} ${Y(.95)} M ${X(.30)} 0 L ${X(-.30)} ${Y(.95)}`, .06);
        break;
      case 'grill':                                   // kettle on splayed legs
        rect(-.5, 1, 1, .32, { rx: .3 });
        path(`M ${X(-.35)} ${Y(.68)} L ${X(-.42)} 0 M ${X(.35)} ${Y(.68)} L ${X(.42)} 0`, .04);
        rect(-.38, .30, .76, .04);
        break;
      case 'gnome':                                   // pointed hat, body, face
        poly([[0, 1], [.32, .60], [-.32, .60]]);
        poly([[-.42, 0], [.42, 0], [.32, .55], [-.32, .55]]);
        circ(0, .58, .16, { fill: '#fff', op: .8 });
        break;
      case 'doghouse':                                // pitched roof, arched door
        poly([[-.5, .62], [0, 1], [.5, .62]]);
        rect(-.42, .64, .84, .64);
        rect(-.15, .42, .30, .42, { fill: '#fff', op: .35, rx: .3 });
        break;
      case 'lamp':                                    // lantern
        poly([[-.45, .80], [0, 1], [.45, .80]]);
        rect(-.35, .80, .70, .62, { rx: .08 });
        rect(-.22, .72, .44, .42, { fill: '#fff', op: .6 });
        rect(-.40, .18, .80, .18);
        break;
      case 'swing':                                   // A-frame with two seats
        path(`M ${X(-.5)} 0 L ${X(-.38)} ${Y(1)} L ${X(-.26)} 0 M ${X(.26)} 0 L ${X(.38)} ${Y(1)} L ${X(.5)} 0
              M ${X(-.38)} ${Y(1)} L ${X(.38)} ${Y(1)}`, .035);
        path(`M ${X(-.18)} ${Y(1)} L ${X(-.18)} ${Y(.28)} M ${X(.18)} ${Y(1)} L ${X(.18)} ${Y(.28)}`, .015);
        rect(-.26, .28, .16, .05);
        rect(.10, .28, .16, .05);
        break;
      case 'swingcouch':                              // roofed bench swing
        rect(-.5, 1, 1, .08);
        path(`M ${X(-.46)} 0 L ${X(-.46)} ${Y(.95)} M ${X(.46)} 0 L ${X(.46)} ${Y(.95)}`, .04);
        rect(-.34, .76, .68, .24, { op: .7, rx: .05 });
        rect(-.34, .52, .68, .14, { rx: .08 });
        break;
      case 'slide':                                   // ladder, platform, chute
        rect(-.5, 1, .05, 1);
        rect(-.36, 1, .05, 1);
        rect(-.5, 1, .22, .06);
        poly([[-.30, .96], [-.18, .96], [.5, .08], [.5, 0], [.36, 0]]);
        break;
      case 'trampoline':                              // mat, net, poles
        rect(-.5, 1, 1, .45, { op: .35 });
        rect(-.5, 1, .03, 1);
        rect(.47, 1, .03, 1);
        rect(-.5, .56, 1, .07);
        break;
      case 'pergola':                                 // posts and beams
        rect(-.5, 1, 1, .07);
        rect(-.5, .88, 1, .04);
        rect(-.46, .88, .07, .88);
        rect(.39, .88, .07, .88);
        break;
      case 'clothesline':                             // two posts, line, laundry
        rect(-.5, 1, .03, 1);
        rect(.47, 1, .03, 1);
        path(`M ${X(-.48)} ${Y(.92)} Q ${X(0)} ${Y(.80)} ${X(.48)} ${Y(.92)}`, .012);
        rect(-.32, .86, .10, .26);
        rect(-.10, .84, .12, .30);
        rect(.16, .86, .10, .22);
        break;
      default:
        rect(-.5, 1, 1, 1, { rx: .08 });
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
    const hl = len / 2, hw = wid / 2, u = Math.min(len, wid);
    const rect = (o = {}) => out.push(_el('rect', {
      x: -hl, y: -hw, width: len, height: wid, rx: (o.rx ?? .12) * u,
      fill: o.fill || color, ...(o.op ? { 'fill-opacity': o.op } : {}),
    }));

    switch (kind) {
      case 'cone':          // a cone from above is a disc with a ring
        out.push(_el('circle', { r: hl, fill: color }));
        out.push(_el('circle', {
          r: hl * 0.55, fill: 'none', stroke: '#fff',
          'stroke-width': hl * 0.22, 'stroke-opacity': .8,
        }));
        break;
      case 'drum':          // barrel / bin: plain disc
        out.push(_el('circle', { r: hl, fill: color }));
        out.push(_el('circle', {
          r: hl * 0.5, fill: 'none', stroke: '#fff',
          'stroke-width': hl * 0.14, 'stroke-opacity': .5,
        }));
        break;
      case 'panel':         // sign / billboard face: thin bar across +X
        rect({ rx: .3 });
        out.push(_el('rect', {
          x: -hl * 0.34, y: -hw * 0.8, width: hl * 0.68, height: wid * 0.8,
          fill: '#fff', 'fill-opacity': .55,
        }));
        break;
      case 'barrier':       // jersey barrier: bar with a centre stripe
        rect({ rx: .2 });
        out.push(_el('rect', {
          x: -hl * 0.12, y: -hw, width: hl * 0.24, height: wid,
          fill: '#fff', 'fill-opacity': .7,
        }));
        break;
      case 'trailer':       // arrow board: body plus a drawbar nose
        rect({ rx: .1 });
        out.push(_el('polygon', {
          points: `${hl},${-hw * .3} ${hl * 1.25},0 ${hl},${hw * .3}`, fill: color,
        }));
        break;
      case 'container':     // long box with corrugation ticks
        rect({ rx: .04 });
        for (let i = 1; i < 10; i++) {
          out.push(_el('rect', {
            x: -hl + (i * len) / 10 - len * .006, y: -hw * .82,
            width: len * .012, height: wid * .82,
            fill: '#fff', 'fill-opacity': .3,
          }));
        }
        break;
      case 'shelter':       // roof outline, open on the kerb side
        rect({ rx: .06, op: .45 });
        out.push(_el('rect', {
          x: -hl, y: -hw, width: len, height: wid * 0.26, fill: color,
        }));
        break;
      case 'plate':         // steel road plate: flat slab, cut corners
        out.push(_el('polygon', {
          points: `${-hl * .88},${-hw} ${hl * .88},${-hw} ${hl},${-hw * .6} `
                + `${hl},${hw * .6} ${hl * .88},${hw} ${-hl * .88},${hw} `
                + `${-hl},${hw * .6} ${-hl},${-hw * .6}`,
          fill: color, 'fill-opacity': .9,
        }));
        break;
      case 'blob':          // debris scatter
        out.push(_el('ellipse', {
          rx: hl, ry: hw * .82, fill: color, 'fill-opacity': .75,
          stroke: color, 'stroke-width': u * .05, 'stroke-dasharray': `${u * .12}`,
        }));
        out.push(_el('circle', { cx: -hl * .3, cy: hw * .3, r: u * .1, fill: color }));
        out.push(_el('circle', { cx: hl * .35, cy: -hw * .25, r: u * .08, fill: color }));
        break;
      case 'cart':          // basket outline with a handle tick
        rect({ rx: .18 });
        out.push(_el('rect', {
          x: -hl, y: -hw * .5, width: len * .16, height: wid * .5,
          fill: '#fff', 'fill-opacity': .6,
        }));
        break;
      case 'chain':         // two posts joined by a line along the long axis
        {
          const along = wid > len;
          const half = (along ? hw : hl), r = u * .5;
          const [x1, y1, x2, y2] = along ? [0, -half + r, 0, half - r] : [-half + r, 0, half - r, 0];
          out.push(_el('line', {
            x1, y1, x2, y2, stroke: color, 'stroke-width': u * .3,
            'stroke-dasharray': `${u * .35} ${u * .2}`,
          }));
          out.push(_el('circle', { cx: x1, cy: y1, r, fill: color }));
          out.push(_el('circle', { cx: x2, cy: y2, r, fill: color }));
        }
        break;
      case 'flat':          // flattened cardboard: irregular slab
        out.push(_el('polygon', {
          points: `${-hl},${-hw * .8} ${hl * .7},${-hw} ${hl},${hw * .6} `
                + `${-hl * .2},${hw} ${-hl * .9},${hw * .7}`,
          fill: color, 'fill-opacity': .85,
        }));
        break;
      case 'decal':         // painting on the road: outline + figure
        out.push(_el('rect', {
          x: -hl, y: -hw, width: len, height: wid, fill: color, 'fill-opacity': .3,
          stroke: color, 'stroke-width': u * .06, 'stroke-dasharray': `${u * .15}`,
        }));
        out.push(_el('ellipse', { rx: hl * .5, ry: hw * .18, fill: '#fff', 'fill-opacity': .8 }));
        out.push(_el('circle', { cx: hl * .58, r: hw * .2, fill: '#fff', 'fill-opacity': .8 }));
        break;
      case 'hay':           // round bale lying down: banded cylinder
        rect({ rx: .12 });
        for (const f of [-.5, 0, .5]) {
          out.push(_el('rect', {
            x: -hl * .9, y: hw * f - wid * .03, width: len * .9, height: wid * .06,
            fill: '#fff', 'fill-opacity': .3,
          }));
        }
        break;
      case 'case':          // luggage: rounded slab with a handle tick
        rect({ rx: .3 });
        out.push(_el('rect', {
          x: hl * .55, y: -hw * .35, width: len * .12, height: wid * .7,
          fill: '#fff', 'fill-opacity': .6,
        }));
        break;
      case 'bag':
        out.push(_el('ellipse', { rx: hl, ry: hw, fill: color }));
        out.push(_el('ellipse', {
          rx: hl * .45, ry: hw * .45, fill: 'none', stroke: '#fff',
          'stroke-width': u * .1, 'stroke-opacity': .6,
        }));
        break;
      case 'bench':         // seat with slats along the long axis
        rect({ rx: .15 });
        for (const f of [-.33, .33]) {
          out.push(_el('rect', {
            x: -hl * .92, y: hw * f - wid * .05, width: len * .92, height: wid * .1,
            fill: '#fff', 'fill-opacity': .45,
          }));
        }
        break;
      case 'frame':         // open structure: outline + corner posts
        out.push(_el('rect', {
          x: -hl, y: -hw, width: len, height: wid, fill: color, 'fill-opacity': .18,
          stroke: color, 'stroke-width': u * .06,
        }));
        for (const [cx, cy] of [[-hl, -hw], [hl, -hw], [-hl, hw], [hl, hw]]) {
          out.push(_el('circle', { cx: cx * .94, cy: cy * .9, r: u * .07, fill: color }));
        }
        break;
      case 'slide':         // platform square at -X, chute running to +X
        out.push(_el('rect', {
          x: -hl, y: -hw, width: wid, height: wid, fill: color,
        }));
        out.push(_el('rect', {
          x: -hl + wid * .8, y: -hw * .6, width: len - wid * .8, height: wid * .6,
          rx: wid * .2, fill: color, 'fill-opacity': .7,
        }));
        break;
      default:
        rect({ rx: .1 });
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
      const g = GROUPS.find(gr => gr.id === PROPS[id]?.group);
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
      const k = (size * 0.86) / long;                 // fit the tile, keep aspect
      const drawnH = Math.max(s.h, long * MIN_SIDE_RATIO) * k;
      const svg = _el('svg', { viewBox: `${-size / 2} ${-size} ${size} ${size}` });
      const g = _el('g', {
        transform: `translate(0, ${(drawnH - size) / 2}) scale(${k})`,
      });
      sideShapes(s.kind, s.w, s.h, this.color(id)).forEach(el => g.appendChild(el));
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
        const ids = Object.keys(PROPS).filter(id => PROPS[id].group === group.id);
        if (!ids.length) continue;

        const section = document.createElement('div');
        section.className = 'prop-section';
        section.dataset.group = group.id;
        section.classList.toggle('collapsed', collapsed.has(group.id));

        const heading = document.createElement('button');
        heading.type = 'button';
        heading.className = 'toolbar-section-label prop-section-head';
        heading.style.setProperty('--group-color', group.color);
        heading.innerHTML = '<span class="prop-section-caret">▾</span>'
          + `<span class="prop-section-name"></span><span class="prop-section-count"></span>`;
        heading.querySelector('.prop-section-name').textContent = group.label.toUpperCase();
        heading.title = `${group.label} ein-/ausklappen`;
        heading.addEventListener('click', () => {
          const now = !section.classList.contains('collapsed');
          section.classList.toggle('collapsed', now);
          heading.setAttribute('aria-expanded', String(!now));
          if (now) collapsed.add(group.id); else collapsed.delete(group.id);
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
          btn.title = `${PROPS[id].label} platzieren\n${id}\n`
            + `${d.len.toFixed(2)} × ${d.wid.toFixed(2)} × ${d.h.toFixed(2)} m`;
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
          sec.heading.querySelector('.prop-section-count').textContent =
            q ? `${n}/${sec.total}` : String(sec.total);
        }
        empty.classList.toggle('hidden', hits > 0);
      };
      search.addEventListener('input', applyFilter);
      // Esc clears the field and stops there: without stopPropagation it would
      // also reach mapView's Esc and disarm the prop tool the user just picked.
      search.addEventListener('keydown', e => {
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
    } catch (_) { /* fall through to the default */ }
    return new Set(GROUPS.slice(2).map(g => g.id));
  }
  function _saveCollapsed(set) {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch (_) { /* nicety only */ }
  }

  window.PropCatalog = PropCatalog;
})();
