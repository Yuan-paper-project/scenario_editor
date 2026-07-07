# OpenSCENARIO GUI Editor for CARLA - Updated Current State

A browser-based visual scenario editor for creating CARLA/OpenSCENARIO scenarios from rendered OpenDRIVE maps. The app lets you place actors, configure event-based NPC behavior, configure traffic light events, preview paths, save/load editor JSON, and export OpenSCENARIO `.xosc` plus ego route `.xml` files.

This document describes the current implementation state of the app.

---

## What It Does

- **Renders CARLA/OpenDRIVE maps** as an interactive SVG canvas with roads, lanes, crosswalks, spawn points, traffic lights, direction arrows, and map layers.
- **Imports custom `.xodr` maps** from the header import button or drag-and-drop onto the map.
- **Places scenario actors** including ego vehicle, cars, trucks, buses, motorcycles, pedestrians, and bicycles.
- **Snaps vehicles to spawn points**, while pedestrians and bicycles can be placed freely and are oriented toward the road.
- **Supports ego trajectory drawing** for the ego route/planner path.
- **Uses event-based NPC behavior** where actions and triggers are configured per event card.
- **Stores NPC route/trajectory waypoints inside event actions**, not on the NPC object itself.
- **Supports traffic light events** by clicking traffic lights on the map and adding signal-state events.
- **Provides save/load JSON** for continuing scenario editing.
- **Exports OpenSCENARIO `.xosc`** through the `llm-scenario-gen` XML builder.
- **Exports ego route `.xml`** from the ego trajectory.
- **Provides visual preview playback** for actor paths. Playback is a visual editor preview and currently ignores event trigger timing.

---

## Architecture

```text
scenario_editor/
├── backend/               Python FastAPI backend
│   ├── main.py            REST API, static file server, map upload, export endpoints
│   ├── map_renderer.py    OpenDRIVE parser to editor map geometry JSON
│   └── scenario_io.py     Scenario validation/normalization and export bridge
├── frontend/              Vanilla JavaScript + CSS, no build step
│   ├── index.html         Single-page app shell
│   ├── presentation.html  Standalone project presentation
│   ├── css/style.css      Application styling
│   └── js/
│       ├── app.js         Global state store and event bus
│       ├── api.js         Backend HTTP client
│       ├── mapView.js     SVG map rendering, pan/zoom, paths, traffic lights
│       ├── mapImport.js   Custom `.xodr` import
│       ├── toolbar.js     Tool palette and map selector
│       ├── objects.js     Actor placement, path drawing, trigger-point placement
│       ├── properties.js  Right-panel coordinator, actor fields, ego path, traffic lights
│       ├── eventPanel.js  NPC event action/trigger cards and event state updates
│       ├── trafficSignals.js Traffic-light selection/event state helpers
│       ├── weather.js     Weather and time controls
│       ├── scenarioIO.js  Save/load/export frontend logic
│       ├── simulate.js    Visual path preview
│       └── welcome.js     Welcome/help modal
├── maps/                  Bundled CARLA `.xodr` maps and previews
├── example/               Example scenario files
├── generate_pptx.py       Generates the downloadable presentation
├── run.sh                 Starts the FastAPI/uvicorn server
└── README.md              Original README
```

The backend serves the frontend, parses maps, validates scenario JSON, and delegates `.xosc` generation to the sibling `llm-scenario-gen` repository. The frontend is plain JavaScript served directly by FastAPI.

The right panel is split between `properties.js` and `eventPanel.js`: `properties.js` decides which panel to show and handles base actor/traffic-light controls, while `eventPanel.js` owns NPC event buttons, cards, action parameters, trigger parameters, and event deletion/relinking.

---

## Current Feature Set

| Area | Current behavior |
|---|---|
| Map selection | Bundled CARLA towns are listed and preloaded at server startup. |
| Custom maps | Upload or drag-and-drop `.xodr` files; uploaded maps are cached and selectable. |
| Map navigation | Pan and cursor-centered zoom. Panning also works while drawing paths, placing objects, and using the ruler. |
| Layers | Toggle road details such as crosswalks, traffic lights, spawn points, lane markings, and direction arrows. |
| Measurement | Ruler tool can measure distances on the map. |
| Actors | Ego, car, truck, bus, motorcycle, pedestrian, and bicycle tools. |
| Vehicle placement | Vehicles snap to nearby spawn points. |
| Pedestrian/bicycle placement | Free placement without spawn snapping; yaw is oriented toward the road. |
| Ego path | Ego has only trajectory/path drawing. Route mode is not available for ego. |
| NPC events | NPC behavior is configured through compact event cards. |
| Traffic lights | Click a traffic light to configure signal-state events in the right panel. |
| Preview | Play/pause/stop visual path preview with speed control. |
| Save/load | Save full editor state as JSON and load it again later. |
| Export | Export `.xosc`; export ego route `.xml`. |

---

## NPC Event System

NPCs use an event list. Each event has one action and, except for Assign Route, one trigger.

### NPC Actions

| Action | Description |
|---|---|
| Follow trajectory | Draws a trajectory with per-waypoint velocity. Exports as `FollowTrajectoryAction`. |
| Assign route | Draws route waypoints. Exports as `AssignRouteAction` with route strategy `fastest`. |
| Set speed | Absolute or relative target speed. Relative speed is relative to a selected actor, defaulting to ego. |
| Set distance | Longitudinal or lateral distance relative to a selected actor, defaulting to ego. |
| Lane change | Lane change left or right over a configurable distance, using linear dynamics. |

### NPC Triggers

| Trigger | Description |
|---|---|
| Simulation time | Starts after a configured simulation time in seconds. |
| Distance to ego | Starts when the NPC is within a configured distance to the ego vehicle. |
| After event | Starts after another non-Assign-Route event ends. |
| Distance to point | User places a named point on the map and configures a radius. Exports as a Euclidean distance condition. |

### Important Event Rules

- Assign Route is inserted as the first event when selected.
- Assign Route has no visible trigger editor. It automatically uses simulation time `0s` in JSON/export.
- Other events cannot use Assign Route as an `after event` reference because Assign Route does not naturally finish.
- Only one path action is allowed per NPC: either Follow Trajectory or Assign Route.
- When Follow Trajectory or Assign Route is selected, the editor immediately enters drawing mode.
- Path points are stored in `event.action.trajectory` or `event.action.waypoints`.
- Deleting an event updates only affected `after event` links.
- Distance-to-point trigger points are shown only while their corresponding actor is selected.

---

## Traffic Light Events

Traffic lights can be selected directly on the map. The right panel shows an Ampel/traffic-light editor with event cards.

Each traffic-light event currently contains:

- Trigger: ego vehicle within a configurable distance.
- State: red, yellow, or green.

In the exported `.xosc`, traffic light events are placed in the same act as the rest of the scenario, inside a traffic-light maneuver group. Traffic lights that have configured events are visually marked on the map.

---

## JSON Save Format

The editor JSON uses the current structured format:

```json
{
  "schema_version": "1.0",
  "map": "Town01",
  "weather": {},
  "time": "daytime",
  "ego": {
    "type": "ego",
    "x": 0,
    "y": 0,
    "z": 0.2,
    "yaw": 0,
    "trajectory": []
  },
  "npcs": [
    {
      "id": "npc_1",
      "type": "car",
      "x": 10,
      "y": 0,
      "z": 0.2,
      "yaw": 0,
      "behaviors": ["constant_speed"],
      "trigger_distance": 400,
      "events": [
        {
          "id": "event_1",
          "name": "Set Speed 1",
          "trigger": { "type": "distance_to_ego", "value": 400 },
          "action": {
            "type": "set_speed",
            "target": { "mode": "absolute", "value": 10 },
            "dynamics": { "shape": "step", "dimension": "time", "value": 5 }
          }
        }
      ]
    }
  ],
  "staticObjects": [],
  "trafficSignals": []
}
```

Frontend state uses camelCase for editor-owned collections such as `staticObjects` and `trafficSignals`. The export payload still includes `route_waypoints` for ego route XML export because the route builder expects that field.

---

## Export Formats

### OpenSCENARIO `.xosc`

The `.xosc` export includes:

- Ego and scenario entities.
- NPC events and actions.
- FollowTrajectoryAction, AssignRouteAction, SpeedAction, LaneChangeAction, and distance actions.
- Traffic signal state events.
- Weather and time-of-day configuration.

The export is generated by `llm-scenario-gen/generator/xml_builder.py` through `backend/scenario_io.py`.

### Ego Route `.xml`

The route export is generated from the ego trajectory. Waypoint yaw is computed from neighboring trajectory points.

### Scenario `.json`

The JSON save file stores the editor state so the scenario can be loaded and edited again later.

---

## Quick Start

### Prerequisites

- Python 3.10+
- CARLA/OpenDRIVE maps under `maps/` or importable as `.xodr`
- The sibling `llm-scenario-gen` repository available next to this repo, or at the configured fallback path

### Run

```bash
cd scenario_editor
bash run.sh
```

By default the app starts on:

```text
http://localhost:9090
```

Use a custom port if needed:

```bash
bash run.sh 9091
```

The script creates `.venv` if needed, installs the backend dependencies, and starts uvicorn with hot reload.

---

## Typical Workflow

```text
1. Select a map.
2. Place the ego vehicle.
3. Draw the ego trajectory if a route export is needed.
4. Place NPC actors.
5. Add NPC event actions from the action button grid.
6. Configure each event action and trigger.
7. Optionally click traffic lights and add signal-state events.
8. Adjust weather and time.
9. Preview paths with Play if needed.
10. Save JSON or export `.xosc` / route `.xml`.
```

---

## Supported Maps

Bundled maps currently include:

- Town01
- Town02
- Town03
- Town04
- Town05
- Town06
- Town07
- Town10
- Town10HD

Additional `.xodr` maps can be uploaded at runtime.

---

## Notes And Current Limitations

- Visual playback follows drawn path geometry and does not simulate OpenSCENARIO trigger timing.
- Assign Route starts at simulation time `0s` and should not be used as an `after event` dependency.
- NPC route/trajectory data belongs to event actions, not directly to the NPC object.
- Ego currently supports trajectory drawing only.
- Export correctness depends on the sibling `llm-scenario-gen` generator code being available.

---

## Technology Stack

| Layer | Technology |
|---|---|
| Backend | Python, FastAPI, uvicorn |
| Frontend | Vanilla JavaScript, SVG, CSS |
| Map format | OpenDRIVE `.xodr` |
| Scenario export | OpenSCENARIO 1.0 `.xosc` |
| Route export | CARLA-style route `.xml` |
| Simulator target | CARLA / ScenarioRunner |

---

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright (c) 2026 yuangao-tum.
