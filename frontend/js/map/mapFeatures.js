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

    // A signal head: every lamp dark until the scenario forces a state, then exactly those lit.
    const lit = new Set((action?.events || []).map((ev) => ev.state || 'red'));
    const g = UIUtils.svgEl('g', {
      transform: `translate(${x},${y})`,
      // A light CARLA does not have (inCarla false): selectable, so the panel can say why, but ghosted.
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

    // Invisible hit target, larger than the housing.
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
   * Landmark dots for the current town. The CSV's x/y are CARLA coordinates, plotted
   * verbatim (no second Y flip). Cased for verge and asphalt alike; never hit-tested.
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
      // For DOM readers; the group is pointer-events:none, so it never shows as a tooltip.
      const title = UIUtils.svgEl('title', {});
      title.textContent = b.name ? `${_landmarkLabel(b.type)} — ${b.name}` : _landmarkLabel(b.type);
      g.appendChild(title);
      layers.buildings.appendChild(g);
    }
  }

  // German names for building_type; unlisted keys fall back to the key with spaces.
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
