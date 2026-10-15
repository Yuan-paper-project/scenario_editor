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
  let _overpassCount = 0;

  function renderMap(mapData) {
    // Clear all layers
    [layerRoads, layerMarkings, layerSpawns, layerJunctions].forEach((g) => {
      while (g.firstChild) g.removeChild(g.firstChild);
    });

    // Create/reset dynamic detail layers (inserted before trajectories)
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
    // Cached route geometry is lane geometry, i.e. specific to the town that
    // is being replaced. Ids restart at obj-1/evt-1 in every save file, so a
    // stale entry is a real collision rather than a theoretical one.
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
    // Above the ground-level markings, arrows and crosswalks, so a bridge
    // hides what it passes over; below lights, signs and everything editable.
    worldGroup.insertBefore(layers.overpass, layerTrajEl);
    // Spawn dots go back above the bridges: an elevated road's spawn points
    // would otherwise be painted over by its own deck.
    worldGroup.insertBefore(layerSpawns, layerTrajEl);
    worldGroup.insertBefore(layers.trafficLights, layerTrajEl);
    worldGroup.insertBefore(layers.buildings, layerTrajEl);
    worldGroup.insertBefore(layers.speeds, layerTrajEl);
    worldGroup.insertBefore(layers.signs, layerTrajEl);
    // These three go last, i.e. above layer-actors, and in this order: the
    // selected actor's path sits over the other vehicles, the actor itself sits
    // over its own path, and its trigger points sit over everything. Paint
    // order here is DOM order of the layers, not the order renderAllActors
    // happens to fill them in.
    worldGroup.appendChild(layers.pathsTop);
    worldGroup.appendChild(layers.actorsTop);
    worldGroup.appendChild(layers.triggerPoints);

    const { bounds, roads, spawnPoints, intersections, trafficLights, crosswalks, grassColor } = mapData;
    const signs = mapData.signs || [];
    const speedSigns = mapData.speedSigns || [];
    const w = bounds.xMax - bounds.xMin;
    const h = bounds.yMax - bounds.yMin;
    const pad = Math.max(w, h) * 0.03;

    // Set SVG viewBox to CARLA bounds
    const vb = `${bounds.xMin - pad} ${bounds.yMin - pad} ${w + pad * 2} ${h + pad * 2}`;
    svg.setAttribute('viewBox', vb);

    // Background
    bgRect.setAttribute('x', bounds.xMin - pad);
    bgRect.setAttribute('y', bounds.yMin - pad);
    bgRect.setAttribute('width', w + pad * 2);
    bgRect.setAttribute('height', h + pad * 2);
    bgRect.setAttribute('fill', 'transparent');

    // Reset pan/zoom so new map fills the view
    view.pan = { x: 0, y: 0 };
    view.zoom = 1.0;
    _applyTransform();

    // Sort roads: junctions on top. A road that passes OVER another one
    // (bridge, flyover, ramp) is drawn later still, in #layer-overpass, with
    // its own markings and arrows — see _roadOverpassLevels.
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
        // Lane polygon with thin edge outline for visual definition
        const points = _polyToPoints(lane.polygon);
        if (grp) {
          // The bridge's drop shadow / parapet: a wide dark casing under the
          // deck, so it reads as passing OVER the road beneath, not crossing it.
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
        // A median/border is a separator, not a lane: hatch it so it reads as
        // blocked in Vektor, and (CSS) instead of a white lane outline in Beides.
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

      // Road markings + direction arrows (non-junction roads only — CARLA
      // paints next to nothing inside a junction, and connector edges drawn
      // there criss-cross the whole box)
      if (road.junction === '-1' && road.centerline.length > 1) {
        const hasDriving = road.lanes.some((l) => l.type === 'driving');
        if (road.marks && road.marks.length) {
          _renderRoadMarks(road.marks, markTarget);
        } else if (hasDriving) {
          // No <roadMark> data (render JSON from an older backend, or a map
          // that states none): the old guessed yellow dashed centreline.
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
          // Per-lane direction arrows (each lane has its own directionLine
          // with correct travel direction — left lanes are reversed)
          for (const lane of road.lanes) {
            if (lane.type === 'driving' && lane.directionLine && lane.directionLine.length > 1) {
              _renderRoadDirArrows(lane.directionLine, dirTarget);
            }
          }
        }
      }
    }
    _overpassCount = [...levels.values()].filter((v) => v > 0).length;
    _applyLayerToggleExtras();

    for (const sign of signs) _renderSign(sign);
    for (const sp of speedSigns) _renderSpeedSign(sp);

    // Spawn point dots
    for (const sp of spawnPoints) {
      const c = UIUtils.svgEl('circle', { cx: sp.x, cy: sp.y, r: '1.5', class: 'spawn-dot' });
      layerSpawns.appendChild(c);
    }

    // Junction zone circles (subtle highlight)
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

    // Landmarks for whichever town this is. renderMap replaces the layer
    // wholesale, so this has to run here as well as on the fetch completing.
    _renderSpecialBuildings();

    // Aerial image under everything (aerialMap.js); fetched async, a town
    // without a capture simply stays on the vector map.
    AerialMap.load(AppState.map);

    // Fit the map to screen
    _fitToView(bounds, pad);

    // Wire up layer visibility toggles
    _setupLayerToggles();

    overlayMsg.style.display = 'none';

    // Initial scale ruler update (defer to let layout settle)
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
    // Show toggle bar once a map is loaded
    layerTogglesEl.classList.remove('hidden');
    // Same gate for the zoom cluster: neither means anything without a map.
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
      // Apply current checkbox state
      const target = p.layer;
      if (target) target.style.display = cb.checked ? '' : 'none';
      // Avoid duplicate listeners by replacing element (simple approach)
      cb.onchange = () => {
        const t = p.layer;
        if (t) t.style.display = cb.checked ? '' : 'none';
        _applyLayerToggleExtras();
      };
    }
  }

  MapCore.define({ renderMap });
})();
