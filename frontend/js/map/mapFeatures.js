/**
 * mapFeatures.js — traffic-light signal heads and landmark dots.
 *
 * Part of the map view (MapView); see mapView.js.
 */
(() => {
  'use strict';

  const { layers, MAP_LABEL_M, _formatSvgNumber, _buildSelectionMarks } = MapCore.shared;

  // ── Traffic light rendering ────────────────────────────────────────────────

  function _renderTrafficLight(tl) {
    const x = tl.x;
    const y = tl.y;
    const id = String(tl.id ?? `${x},${y}`);
    const action = TrafficSignals.actionById(id);
    const selected = String(AppState.selectedTrafficLightId || '') === id;
    const configured = (action?.events || []).length > 0;
    const lastEvent = configured ? action.events[action.events.length - 1] : null;

    // A compact signal head: dark housing, three lamps. Every lamp is dark until
    // the scenario forces a state on this signal, and then exactly the states
    // its events set are lit — the old marker was an 8 m red disc with a glow,
    // red whether or not anything was configured, and at lane zoom it was the
    // loudest thing on the map and sat over the crosswalk it belongs to.
    const lit = new Set((action?.events || []).map((ev) => ev.state || 'red'));
    const g = UIUtils.svgEl('g', {
      transform: `translate(${x},${y})`,
      // A light the .xodr has but CARLA does not (tl.inCarla === false, from
      // maps/<town>/carla_traffic_lights.json): still selectable, so the panel
      // can say why it cannot be switched, but drawn as a ghost.
      class:
        `traffic-light${selected ? ' selected' : ''}${configured ? ' configured' : ''}` +
        `${tl.inCarla === false ? ' not-in-carla' : ''}`,
      'data-traffic-light-id': id,
    });
    g.addEventListener('click', (e) => {
      if (AppState.activeTool || AppState.trajectoryMode || AppState.routeMode) return;
      e.preventDefault();
      e.stopPropagation();
      TrafficSignals.select(id);
    });

    // Invisible hit target, larger than the housing so it stays clickable at
    // town zoom — the same trick props and trigger points use.
    g.appendChild(UIUtils.svgEl('circle', { cx: '0', cy: '0', r: '2.4', fill: 'transparent' }));

    const W = 1.5,
      H = 3.7;
    g.appendChild(
      UIUtils.svgEl('rect', {
        x: String(-W / 2),
        y: String(-H / 2),
        width: String(W),
        height: String(H),
        rx: '0.45',
        class: 'traffic-light-housing',
      }),
    );
    [
      ['red', -1.1],
      ['yellow', 0],
      ['green', 1.1],
    ].forEach(([state, cy]) => {
      g.appendChild(
        UIUtils.svgEl('circle', {
          cx: '0',
          cy: String(cy),
          r: '0.46',
          class: `traffic-light-lamp lamp-${state}${lit.has(state) ? ' lit' : ''}`,
        }),
      );
    });

    // Selection marks around the housing. Same helper as actors and props: one
    // selection language for everything on the map.
    g.appendChild(_buildSelectionMarks(W + 0.6, H + 0.6));

    const title = UIUtils.svgEl('title', {});
    title.textContent =
      tl.inCarla === false
        ? `Ampel ${id} — existiert in CARLA nicht, nicht schaltbar`
        : configured
          ? `Ampel ${id} — ${action.events.length} Event${action.events.length === 1 ? '' : 's'}`
          : `Ampel ${id} — klicken, um ihren Zustand im Szenario festzulegen`;
    g.appendChild(title);

    layers.trafficLights.appendChild(g);
  }

  function _renderTrafficLights() {
    if (!layers.trafficLights || !AppState.mapData) return;
    while (layers.trafficLights.firstChild) layers.trafficLights.removeChild(layers.trafficLights.firstChild);
    for (const tl of AppState.mapData.trafficLights || []) {
      _renderTrafficLight(tl);
    }
  }

  /**
   * Landmark dots for the current town (maps/special_buildings.csv, fetched by
   * specialBuildings.js into AppState.specialBuildings — every town's rows at
   * once, so this filters).
   *
   * The CSV's x/y are CARLA world coordinates, i.e. exactly the frame the render
   * JSON and every actor pose are already in — the single Y flip happens in
   * backend/map_renderer.py and nothing downstream repeats it. Plot verbatim.
   *
   * Drawn like the trigger point's centre marker (a small dot) but with a white
   * casing under it, because the map runs from a near-white verge to a near-black
   * carriageway and no single colour survives both. Nothing here is hit-testable:
   * a landmark is reference decoration, and a hit target here would swallow
   * clicks aimed at the road under it.
   */
  function _renderSpecialBuildings() {
    if (!layers.buildings) return;
    while (layers.buildings.firstChild) layers.buildings.removeChild(layers.buildings.firstChild);
    const town = AppState.map;
    if (!town) return;
    for (const b of AppState.specialBuildings || []) {
      if (b.town !== town) continue;
      const g = UIUtils.svgEl('g', {
        class: 'special-building',
        transform: `translate(${_formatSvgNumber(b.x)},${_formatSvgNumber(b.y)})`,
      });
      g.appendChild(UIUtils.svgEl('circle', { cx: '0', cy: '0', r: '1.5', class: 'building-dot-casing' }));
      g.appendChild(UIUtils.svgEl('circle', { cx: '0', cy: '0', r: '1.0', class: 'building-dot' }));
      const label = UIUtils.svgEl('text', {
        x: '0',
        y: '-2.8',
        'text-anchor': 'middle',
        'font-size': String(MAP_LABEL_M),
        class: 'map-label building-label',
      });
      label.textContent = _landmarkLabel(b.type);
      g.appendChild(label);
      // Not a tooltip the user can hover for (the group is pointer-events:none)
      // — it is there for anyone reading the DOM, and costs nothing.
      const title = UIUtils.svgEl('title', {});
      title.textContent = b.name ? `${_landmarkLabel(b.type)} — ${b.name}` : _landmarkLabel(b.type);
      g.appendChild(title);
      layers.buildings.appendChild(g);
    }
  }

  // German names for maps/special_buildings.csv's building_type. Anything not
  // listed falls back to the raw key with underscores as spaces.
  const LANDMARK_LABELS = {
    bus_stop: 'Haltestelle',
    store: 'Geschäft',
    park: 'Park',
    restaurant: 'Restaurant',
    parking: 'Parkplatz',
    farm: 'Bauernhof',
    playground: 'Spielplatz',
    cafe: 'Café',
    hotel: 'Hotel',
    sports_facility: 'Sportplatz',
    gas_station: 'Tankstelle',
    warehouse: 'Lager',
    supermarket: 'Supermarkt',
    shopping_mall: 'Einkaufszentrum',
    museum: 'Museum',
    library: 'Bibliothek',
    lake: 'See',
    bakery: 'Bäckerei',
    woods: 'Wald',
    university: 'Universität',
    train_station: 'Bahnhof',
    theater: 'Theater',
    river: 'Fluss',
    house: 'Haus',
    factory: 'Fabrik',
    cinema: 'Kino',
    church: 'Kirche',
    beach: 'Strand',
    atm: 'Geldautomat',
    school: 'Schule',
    hospital: 'Krankenhaus',
    police: 'Polizei',
    bank: 'Bank',
  };
  function _landmarkLabel(type) {
    return LANDMARK_LABELS[type] || String(type || '').replace(/_/g, ' ');
  }

  MapCore.define({ _renderTrafficLight, _renderTrafficLights, _renderSpecialBuildings });
})();
