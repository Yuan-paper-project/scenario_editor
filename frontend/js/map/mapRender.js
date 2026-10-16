/**
 * mapRender.js — renderMap: building the town's layers, and the Ebenen layer toggles.
 *
 * Part of the map view (MapView); see mapView.js.
 */
(() => {
  'use strict';

  const {
    svg,
    bgRect,
    worldGroup,
    layerRoads,
    layerMarkings,
    layerSpawns,
    layerJunctions,
    layerProps,
    overlayMsg,
    layers,
    view,
    _updateScaleRuler,
    _applyTransform,
    _polyToPoints,
    _roadOverpassLevels,
    _renderRoadMarks,
    _renderParkingGlyphs,
    _renderSign,
    _renderSpeedSign,
    _renderRoadDirArrows,
    BLOCKED_LANE_TYPES,
    _laneStrokeColor,
    _fitToView,
    _renderCrosswalk,
    _renderTrafficLight,
    _renderSpecialBuildings,
    _routeGeomCache,
  } = MapCore.shared;

  let _overpassGroupsFor = () => null;

  function renderMap(mapData) {
    [layerRoads, layerMarkings, layerSpawns, layerJunctions].forEach((g) => {
      while (g.firstChild) g.removeChild(g.firstChild);
    });

    if (layers.crosswalks) layers.crosswalks.remove();
    if (layers.trafficLights) layers.trafficLights.remove();
    if (layers.roadDir) layers.roadDir.remove();
    if (layers.overpass) layers.overpass.remove();
    if (layers.triggerPoints) layers.triggerPoints.remove();
    if (layers.buildings) layers.buildings.remove();
    if (layers.signs) layers.signs.remove();
    if (layers.speeds) layers.speeds.remove();
    if (layers.pathsTop) layers.pathsTop.remove();
    if (layers.actorsTop) layers.actorsTop.remove();
    // Route geometry belongs to the old town, and ids restart at obj-1/evt-1, so entries would collide.
    _routeGeomCache.clear();
    layers.crosswalks = UIUtils.svgEl('g', { id: 'layer-crosswalks' });
    layers.trafficLights = UIUtils.svgEl('g', { id: 'layer-trafficlights' });
    layers.roadDir = UIUtils.svgEl('g', { id: 'layer-roaddir' });
    layers.overpass = UIUtils.svgEl('g', { id: 'layer-overpass' });
    layers.triggerPoints = UIUtils.svgEl('g', { id: 'layer-trigger-points' });
    layers.buildings = UIUtils.svgEl('g', { id: 'layer-buildings' });
    layers.signs = UIUtils.svgEl('g', { id: 'layer-signs' });
    layers.speeds = UIUtils.svgEl('g', { id: 'layer-speeds' });
    layers.pathsTop = UIUtils.svgEl('g', { id: 'layer-paths-top' });
    layers.actorsTop = UIUtils.svgEl('g', { id: 'layer-actors-top' });
    const layerTrajEl = document.getElementById('layer-trajectories');
    worldGroup.insertBefore(layers.roadDir, layerTrajEl);
    worldGroup.insertBefore(layers.crosswalks, layerTrajEl);
    // Above markings, arrows and crosswalks (a bridge hides what it passes over); below anything editable.
    worldGroup.insertBefore(layers.overpass, layerTrajEl);
    // Spawn dots back above the bridges, or a deck paints over its own spawn points.
    worldGroup.insertBefore(layerSpawns, layerTrajEl);
    worldGroup.insertBefore(layers.trafficLights, layerTrajEl);
    worldGroup.insertBefore(layers.buildings, layerTrajEl);
    worldGroup.insertBefore(layers.speeds, layerTrajEl);
    worldGroup.insertBefore(layers.signs, layerTrajEl);
    // Last, in this order: the selected actor's paths over other vehicles, the actor over its
    // paths, its trigger points over everything. Paint order is the layers' DOM order.
    worldGroup.appendChild(layers.pathsTop);
    worldGroup.appendChild(layers.actorsTop);
    worldGroup.appendChild(layers.triggerPoints);

    const { bounds, roads, spawnPoints, intersections, trafficLights, crosswalks } = mapData;
    const signs = mapData.signs || [];
    const speedSigns = mapData.speedSigns || [];
    const w = bounds.xMax - bounds.xMin;
    const h = bounds.yMax - bounds.yMin;
    const pad = Math.max(w, h) * 0.03;

    const vb = `${bounds.xMin - pad} ${bounds.yMin - pad} ${w + pad * 2} ${h + pad * 2}`;
    svg.setAttribute('viewBox', vb);

    bgRect.setAttribute('x', bounds.xMin - pad);
    bgRect.setAttribute('y', bounds.yMin - pad);
    bgRect.setAttribute('width', w + pad * 2);
    bgRect.setAttribute('height', h + pad * 2);
    bgRect.setAttribute('fill', 'transparent');

    view.pan = { x: 0, y: 0 };
    view.zoom = 1.0;
    _applyTransform();

    // Junction roads on top; roads passing over others go in #layer-overpass (_roadOverpassLevels).
    const normal = roads.filter((r) => r.junction === '-1');
    const junctions = roads.filter((r) => r.junction !== '-1');
    const levels = _roadOverpassLevels(roads);
    const overpassGroups = []; // index = level − 1
    _overpassGroupsFor = (level) => {
      while (overpassGroups.length < level) {
        const g = UIUtils.svgEl('g', { class: 'ovp-level', 'data-level': String(overpassGroups.length + 1) });
        const parts = {
          g,
          shadow: UIUtils.svgEl('g', { class: 'ovp-shadow' }),
          roads: UIUtils.svgEl('g', { class: 'ovp-roads' }),
          marks: UIUtils.svgEl('g', { class: 'ovp-marks' }),
          dir: UIUtils.svgEl('g', { class: 'ovp-dir' }),
        };
        g.append(parts.shadow, parts.roads, parts.marks, parts.dir);
        layers.overpass.appendChild(g);
        overpassGroups.push(parts);
      }
      return overpassGroups[level - 1];
    };

    for (const road of [...normal, ...junctions]) {
      const level = levels.get(road.id) || 0;
      const grp = level ? _overpassGroupsFor(level) : null;
      const roadTarget = grp ? grp.roads : layerRoads;
      const markTarget = grp ? grp.marks : layerMarkings;
      const dirTarget = grp ? grp.dir : layers.roadDir;
      for (const lane of road.lanes) {
        const points = _polyToPoints(lane.polygon);
        if (grp) {
          // Dark casing under the deck, so it reads as passing over the road beneath.
          grp.shadow.appendChild(UIUtils.svgEl('polygon', { points, class: 'ovp-casing' }));
        }
        const poly = UIUtils.svgEl('polygon', {
          points,
          fill: lane.color,
          stroke: _laneStrokeColor(lane.type),
          'stroke-width': '0.3',
          'stroke-linejoin': 'round',
          class: `lane lane-${lane.type}`,
        });
        roadTarget.appendChild(poly);
        // Separators are hatched in Vektor and lose the white lane outline in Beides (CSS).
        if (BLOCKED_LANE_TYPES.has(lane.type)) {
          roadTarget.appendChild(
            UIUtils.svgEl('polygon', {
              points,
              fill: 'url(#hatch-blocked)',
              class: 'lane-hatch',
            }),
          );
        }
      }

      // Markings and arrows on non-junction roads only: connector edges criss-cross the box.
      if (road.junction === '-1' && road.centerline.length > 1) {
        const hasDriving = road.lanes.some((l) => l.type === 'driving');
        if (road.marks && road.marks.length) {
          _renderRoadMarks(road.marks, markTarget);
        } else if (hasDriving) {
          // No <roadMark> data: fall back to a guessed yellow dashed centreline.
          const cl = UIUtils.svgEl('polyline', {
            points: road.centerline.map((p) => `${p[0]},${p[1]}`).join(' '),
            fill: 'none',
            stroke: 'rgba(255,210,80,0.5)',
            'stroke-width': '0.35',
            'stroke-dasharray': '3,5',
            'stroke-linecap': 'round',
          });
          markTarget.appendChild(cl);
        }
        for (const lane of road.lanes) {
          if (lane.type === 'parking' && lane.directionLine && lane.directionLine.length > 1) {
            _renderParkingGlyphs(lane.directionLine, markTarget);
          }
        }
        if (hasDriving) {
          // Per-lane arrows; left lanes' directionLines are already reversed to travel direction.
          for (const lane of road.lanes) {
            if (lane.type === 'driving' && lane.directionLine && lane.directionLine.length > 1) {
              _renderRoadDirArrows(lane.directionLine, dirTarget);
            }
          }
        }
      }
    }
    _applyLayerToggleExtras();

    for (const sign of signs) _renderSign(sign);
    for (const sp of speedSigns) _renderSpeedSign(sp);

    for (const sp of spawnPoints) {
      const c = UIUtils.svgEl('circle', { cx: sp.x, cy: sp.y, r: '1.5', class: 'spawn-dot' });
      layerSpawns.appendChild(c);
    }

    for (const junc of intersections || []) {
      const c = UIUtils.svgEl('circle', { cx: junc.cx, cy: junc.cy, r: '14', class: 'junction-zone' });
      layerJunctions.appendChild(c);
    }

    // ── Crosswalks: zebra stripes perpendicular to road ──────────────────────
    console.log(`[MapView] Rendering ${(crosswalks || []).length} crosswalks`);
    for (const cw of crosswalks || []) {
      _renderCrosswalk(cw);
    }
    console.log(`[MapView] layer-crosswalks children: ${layers.crosswalks.children.length}`);

    // ── Traffic lights ─────────────────────────────────────────────────────
    console.log(`[MapView] Rendering ${(trafficLights || []).length} traffic lights`);
    for (const tl of trafficLights || []) {
      _renderTrafficLight(tl);
    }
    console.log(`[MapView] layer-trafficlights children: ${layers.trafficLights.children.length}`);

    // Here as well as on fetch: renderMap replaces the layer wholesale.
    _renderSpecialBuildings();

    // A town without an aerial capture stays on the vector map.
    AerialMap.load(AppState.map);

    _fitToView(bounds, pad);

    _setupLayerToggles();

    overlayMsg.style.display = 'none';

    // Deferred so the layout settles first.
    requestAnimationFrame(() => _updateScaleRuler());
  }

  /** Overpass markings/arrows follow the Markierungen / Fahrtrichtung boxes. */
  function _applyLayerToggleExtras() {
    if (!layers.overpass) return;
    const marks = document.getElementById('toggle-markings');
    const dir = document.getElementById('toggle-roaddir');
    layers.overpass.querySelectorAll('.ovp-marks').forEach((g) => {
      g.style.display = marks && !marks.checked ? 'none' : '';
    });
    layers.overpass.querySelectorAll('.ovp-dir').forEach((g) => {
      g.style.display = dir && !dir.checked ? 'none' : '';
    });
  }

  // ── Layer visibility toggles ──────────────────────────────────────────────

  const layerTogglesEl = document.getElementById('layer-toggles');

  function _setupLayerToggles() {
    layerTogglesEl.classList.remove('hidden');
    document.getElementById('map-view-controls')?.classList.remove('hidden');
    document.getElementById('scale-ruler')?.classList.remove('hidden');

    const pairs = [
      {
        id: 'toggle-crosswalks',
        get layer() {
          return layers.crosswalks;
        },
      },
      {
        id: 'toggle-trafficlights',
        get layer() {
          return layers.trafficLights;
        },
      },
      { id: 'toggle-spawns', layer: layerSpawns },
      { id: 'toggle-markings', layer: layerMarkings },
      {
        id: 'toggle-roaddir',
        get layer() {
          return layers.roadDir;
        },
      },
      { id: 'toggle-props', layer: layerProps },
      {
        id: 'toggle-buildings',
        get layer() {
          return layers.buildings;
        },
      },
      {
        id: 'toggle-signs',
        get layer() {
          return layers.signs;
        },
      },
      {
        id: 'toggle-speeds',
        get layer() {
          return layers.speeds;
        },
      },
    ];

    for (const p of pairs) {
      const cb = document.getElementById(p.id);
      if (!cb) continue;
      const target = p.layer;
      if (target) target.style.display = cb.checked ? '' : 'none';
      // onchange, not addEventListener: renderMap runs again on every town.
      cb.onchange = () => {
        const t = p.layer;
        if (t) t.style.display = cb.checked ? '' : 'none';
        _applyLayerToggleExtras();
      };
    }
  }

  MapCore.define({ renderMap });
})();
