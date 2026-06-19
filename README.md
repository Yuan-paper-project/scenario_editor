# OpenSCENARIO GUI Editor for CARLA

A browser-based visual editor for creating, editing, and exporting autonomous driving test scenarios in [OpenSCENARIO 1.0](https://www.asam.net/standards/detail/openscenario/) format, built on top of [CARLA](https://carla.org/) simulator maps.

---

## What It Does

- **Visualises CARLA maps** — Parses OpenDRIVE (`.xodr`) road networks and renders them as interactive SVG with lane polygons, direction arrows, crosswalks, traffic lights, and spawn points.
- **Import your own maps** — Upload any CARLA `.xodr` file via the header button or by dragging it onto the canvas; imported maps appear in the dropdown (marked ★) and render instantly.
- **Place & configure actors** — Drag-and-drop ego vehicle, cars, trucks, buses, motorcycles, cyclists, and pedestrians onto the map. Snap-to-spawn for precise placement.
- **Draw trajectories** — Click to draw waypoint-based paths for each actor with per-waypoint velocity. Ego trajectory doubles as the planner route.
- **Set trigger conditions** — Configure per-NPC trigger distance so actors activate when the ego approaches.
- **Simulate preview** — Animate all actors along their trajectories at configurable playback speed (0.25x–4x) to visually verify the scenario before export.
- **Export industry-standard files** — One-click export to OpenSCENARIO `.xosc`, route `.xml` (for Autoware/CARLA planners), and scenario `.json` (for reload).

---

## Architecture

```
scenario_editor/
├── backend/               Python (FastAPI)
│   ├── main.py            REST API + static file server (incl. map upload, .pptx)
│   ├── map_renderer.py    OpenDRIVE parser → road geometry JSON
│   └── scenario_io.py     Validation + export to .xosc / route XML
├── frontend/              Vanilla JS + CSS (no build step)
│   ├── index.html         Single-page application shell
│   ├── presentation.html  Standalone project presentation (TUM-style slides)
│   ├── css/style.css      Dark theme UI
│   └── js/
│       ├── app.js         Global state store + event bus
│       ├── api.js         HTTP client
│       ├── mapView.js     SVG map rendering, pan/zoom, layers
│       ├── mapImport.js   Custom .xodr import (button + drag-and-drop)
│       ├── toolbar.js     Tool palette + map selector
│       ├── objects.js     Actor placement + trajectory drawing
│       ├── properties.js  Right-panel property editor
│       ├── weather.js     Weather & time-of-day controls
│       ├── scenarioIO.js  Save / Load / Export logic
│       ├── simulate.js    Trajectory preview animation
│       └── welcome.js     Welcome modal + help button
├── generate_pptx.py       Generates the project presentation as .pptx
└── example/               Sample scenario files (Town01)
```

The backend parses CARLA's OpenDRIVE maps into JSON geometry and delegates `.xosc` generation to the [`llm-scenario-gen`](../llm-scenario-gen/) library — the sibling repo that also powers LLM-driven scenario generation. This editor is the manual/interactive counterpart; both share the same vehicle catalog and export logic. The frontend is a zero-dependency single-page app — no Node.js, no bundler, just plain JavaScript modules served as static files.

---

## Key Features

| Feature | Description |
|---|---|
| **Interactive Map** | Pan, zoom, and click on rendered CARLA town maps (Town01–Town10HD) |
| **Custom Map Import** | Upload any CARLA `.xodr` via header button or drag-and-drop; imported maps are marked ★ in the dropdown |
| **Actor Toolbox** | 7 actor types: ego, car, truck, bus, motorcycle, pedestrian, cyclist |
| **Trajectory Editor** | Click-to-place waypoints with editable per-point velocity |
| **NPC Trigger Distance** | Configurable activation radius (5–1000 m) per NPC |
| **Trajectory Simulation** | Animated playback with play/pause/stop, speed control, and seek bar |
| **Layer Controls** | Toggle visibility of crosswalks, traffic lights, spawns, lane markings, direction arrows |
| **Scale Ruler** | Dynamic scale bar that updates with zoom level |
| **Measurement Ruler** | Click two points to measure real-world distance; pin multiple measurements |
| **Weather & Time** | Sliders for fog, rain, clouds, sun, wet road, snow, dust; time-of-day presets |
| **Undo Support** | Ctrl+Z to restore deleted actors (up to 20 levels) |
| **Multi-format Export** | `.xosc` (OpenSCENARIO), `.xml` (route for planners), `.json` (save/reload) |
| **Onboarding Help** | Welcome modal on first load plus a help button to reopen it any time |
| **Project Presentation** | Built-in slide deck (`presentation.html`) and downloadable `.pptx` via `/api/presentation.pptx` |

---

## Quick Start

### Prerequisites

- Python 3.10+
- CARLA OpenDRIVE maps (`.xodr` files) under `../llm-scenario-gen/maps/`
- The [`llm-scenario-gen`](../llm-scenario-gen/) library (sibling directory)

### Run

```bash
cd scenario_editor
bash run.sh          # starts on port 9090
# or
bash run.sh 8080     # custom port
```

Open **http://localhost:9090** in your browser.

The startup script creates a Python virtual environment, installs dependencies, and launches the server with hot-reload enabled.

---

## Workflow

```
1. Select Map        →  Choose a CARLA town from the dropdown
2. Place Ego         →  Click "Ego" tool, then click on the map
3. Draw Ego Route    →  Select ego → "Draw Path" → click waypoints → "Done"
4. Add NPCs          →  Click actor tool (car/pedestrian/...) → click on map
5. Configure NPCs    →  Set behaviors, trigger distance, draw trajectories
6. Set Environment   →  Adjust weather sliders and time-of-day
7. Preview           →  Hit Play to animate all actors along their paths
8. Export            →  "Export .xosc" / "Export Route" / "Save" as JSON
```

---

## Export Formats

### OpenSCENARIO `.xosc`
Complete scenario definition following the [ASAM OpenSCENARIO 1.0](https://www.asam.net/standards/detail/openscenario/) standard. Includes ego spawn, NPC entities with `FollowTrajectoryAction`, distance-based triggers, weather, and time-of-day. Ready for CARLA ScenarioRunner.

### Route `.xml`
Waypoint-based route file compatible with CARLA's route format and Autoware planners. Each waypoint carries position and heading computed from the trajectory direction.

### Scenario `.json`
Internal format for saving and reloading the full editor state — map, actors, trajectories, weather, and all configuration. Load it back into the editor to continue editing.

---

## Supported Maps

Town01, Town02, Town03, Town04, Town05, Town06, Town07, Town10, Town10HD

Maps are auto-discovered from the CARLA OpenDRIVE directory and pre-cached at server startup for fast rendering. You can also **import any other CARLA `.xodr`** at runtime — drag it onto the canvas or use the import button in the header.

---

## Technology Stack

| Layer | Technology |
|---|---|
| Backend | Python, FastAPI, uvicorn |
| Frontend | Vanilla JavaScript (ES6 IIFEs), SVG, CSS |
| Map Format | OpenDRIVE (`.xodr`) |
| Export Format | OpenSCENARIO 1.0 (`.xosc`) |
| Simulator | CARLA |
