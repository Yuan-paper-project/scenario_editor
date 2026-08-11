"""
main.py — FastAPI backend for the OpenSCENARIO GUI Scenario Editor.

Endpoints:
  GET  /                           → serve index.html
  GET  /static/{path}              → serve frontend static files
  GET  /api/maps                   → list available towns
  GET  /api/maps/{town}/render     → road polygon + spawn point JSON (MAP_CACHE)
  GET  /api/maps/{town}/lane_graph → cached CARLA routing graph, if probed (LANE_GRAPH_CACHE)
  GET  /api/maps/{town}/preview    → serve town thumbnail image
  POST /api/export                 → generate .xosc and return as download
"""

import json
import os
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

from backend.map_renderer import (
    build_map_render_data,
    build_map_render_data_from_path,
    list_available_towns,
    XODR_PATHS,
    THUMBNAIL_PATHS,
)
from backend.lane_graph_builder import build_lane_graph_from_xodr
from backend.scenario_io import export_to_xosc, export_route_xml

# ── Paths ──────────────────────────────────────────────────────────────────────

_HERE        = Path(__file__).resolve().parent
_FRONTEND    = _HERE.parent / "frontend"
_UPLOADS_DIR = _HERE.parent / "maps" / "_uploaded"   # persisted user maps

# ── App ────────────────────────────────────────────────────────────────────────

app = FastAPI(title="OpenSCENARIO Editor", version="1.0.0")

# ── MAP_CACHE: pre-load all town render data at startup ────────────────────────

MAP_CACHE: dict[str, dict] = {}

# LANE_GRAPH_CACHE: routing topology per town, from one of two sources —
# tests/probe_carla_lane_graph.py's live-CARLA output (maps/<Town>/
# lane_graph.json on disk, source-less in the JSON, treated by the frontend
# as "carla") when it exists, or backend/lane_graph_builder.py's from-.xodr
# derivation (source: "xodr") for every town that has no such file: Town10
# (no CARLA counterpart to probe) and every uploaded map. A from-.xodr graph
# makes no attempt to rank a fork the way live CARLA next() does — see
# lane_graph_builder.py's module docstring — frontend/js/simulate.js knows
# to refuse to guess there rather than pick an arbitrary branch. Loaded once
# at startup (or once at upload time for a freshly uploaded map); a re-probe
# needs a restart, same caveat as everything else in this dict's family.
LANE_GRAPH_CACHE: dict[str, dict] = {}


def _build_lane_graph_safely(town: str, xodr_path: Path) -> dict | None:
    try:
        return build_lane_graph_from_xodr(xodr_path, MAP_CACHE[town]['roads'], town)
    except Exception as exc:
        print(f"  ✗ xodr-derived lane graph for {town}: {exc}")
        return None


@app.on_event("startup")
async def preload_maps():
    _UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

    # A map whose elevation range is far off zero is almost certainly using an
    # absolute geoid datum (maps/Town10 sits at +50..+103 m). Actors placed there
    # get those heights verbatim — flag it at startup rather than silently
    # shifting the map, which would put them back under the road.
    def _elev_note(data: dict) -> str:
        ev = data.get('elevation') or {}
        lo, hi = ev.get('min', 0.0), ev.get('max', 0.0)
        if lo == 0.0 and hi == 0.0:
            return "flat"
        note = f"z {lo:+.1f}..{hi:+.1f} m"
        return note + "  ⚠ absolute datum?" if lo > 5.0 else note

    # Pre-load bundled towns
    towns = list_available_towns()
    print(f"[startup] Pre-loading map geometry for {len(towns)} towns …")
    for town in towns:
        try:
            MAP_CACHE[town] = build_map_render_data(town)
            print(f"  ✓ {town}  ({len(MAP_CACHE[town]['roads'])} roads, {_elev_note(MAP_CACHE[town])})")
        except Exception as exc:
            print(f"  ✗ {town}: {exc}")

    # Re-load any previously uploaded maps
    for xodr_file in sorted(_UPLOADS_DIR.glob("*.xodr")):
        town_name = xodr_file.stem
        if town_name not in MAP_CACHE:
            try:
                MAP_CACHE[town_name] = build_map_render_data_from_path(xodr_file, town_name)
                print(f"  ✓ (uploaded) {town_name}  "
                      f"({len(MAP_CACHE[town_name]['roads'])} roads, {_elev_note(MAP_CACHE[town_name])})")
            except Exception as exc:
                print(f"  ✗ (uploaded) {town_name}: {exc}")

    print(f"[startup] Map cache ready. {len(MAP_CACHE)} towns loaded.")

    for town in MAP_CACHE:
        graph_path = _HERE.parent / "maps" / town / "lane_graph.json"
        if graph_path.exists():
            try:
                LANE_GRAPH_CACHE[town] = json.loads(graph_path.read_text())
                continue
            except Exception as exc:
                print(f"  ✗ lane_graph for {town}: {exc}")
                continue
        # No probed file — derive one from the .xodr directly (Town10, or any
        # uploaded map re-discovered above) rather than leaving this town
        # without routing.
        xodr_path = XODR_PATHS.get(town) or (_UPLOADS_DIR / f"{town}.xodr")
        if xodr_path.exists():
            graph = _build_lane_graph_safely(town, xodr_path)
            if graph:
                LANE_GRAPH_CACHE[town] = graph
    carla_count = sum(1 for g in LANE_GRAPH_CACHE.values() if g.get('source') != 'xodr')
    xodr_count = len(LANE_GRAPH_CACHE) - carla_count
    print(f"[startup] Lane graph cache ready. {len(LANE_GRAPH_CACHE)}/{len(MAP_CACHE)} towns have one "
          f"({carla_count} CARLA-probed, {xodr_count} xodr-derived).")


# ── Static file serving ────────────────────────────────────────────────────────

app.mount("/static", StaticFiles(directory=str(_FRONTEND)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(_FRONTEND / "index.html"))


# ── Map API ────────────────────────────────────────────────────────────────────

@app.get("/api/maps")
async def get_maps():
    # laneGraphs lets the frontend skip the /lane_graph request (and its
    # console-logged 404) for a town it already knows has no cache, rather
    # than discovering that by asking.
    return {"maps": list(MAP_CACHE.keys()), "laneGraphs": list(LANE_GRAPH_CACHE.keys())}


@app.get("/api/maps/{town}/render")
async def get_map_render(town: str):
    if town not in MAP_CACHE:
        raise HTTPException(status_code=404, detail=f"Town '{town}' not found")
    return JSONResponse(content=MAP_CACHE[town])


@app.get("/api/maps/{town}/lane_graph")
async def get_lane_graph(town: str):
    if town not in LANE_GRAPH_CACHE:
        # A town in MAP_CACHE always gets an attempt at a lane graph (a probed
        # file, or an xodr-derived one built at startup/upload) — reaching
        # this branch means that attempt itself failed (see the startup/
        # upload logs), not simply "never probed".
        detail = (f"Town '{town}' not found" if town not in MAP_CACHE
                  else f"No lane graph available for '{town}' — building one from "
                       f"its .xodr failed (see server logs)")
        raise HTTPException(status_code=404, detail=detail)
    return JSONResponse(content=LANE_GRAPH_CACHE[town])


@app.get("/api/maps/{town}/preview")
async def get_map_preview(town: str):
    thumb = THUMBNAIL_PATHS.get(town)
    if thumb and thumb.exists():
        return FileResponse(str(thumb), media_type="image/jpeg")
    raise HTTPException(status_code=404, detail=f"No preview image for '{town}'")


@app.post("/api/maps/upload")
async def upload_map(file: UploadFile = File(...)):
    """
    Accept a .xodr file, parse it, cache it, and return the town name.
    The file is persisted in maps/_uploaded/ so it survives server restarts.
    """
    if not file.filename or not file.filename.lower().endswith(".xodr"):
        raise HTTPException(status_code=400, detail="Only .xodr files are accepted.")

    # Derive a clean town name from the filename
    raw_stem = Path(file.filename).stem
    town_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in raw_stem)
    if not town_name:
        town_name = "CustomMap"

    # Save to the persistent uploads directory
    dest_path = _UPLOADS_DIR / f"{town_name}.xodr"
    try:
        content = await file.read()
        dest_path.write_bytes(content)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save file: {exc}")

    # Parse and cache
    try:
        MAP_CACHE[town_name] = build_map_render_data_from_path(dest_path, town_name)
    except Exception as exc:
        dest_path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=f"Failed to parse .xodr: {exc}")

    # Best-effort — a failure here degrades to "no lane graph" (the existing
    # null-safe frontend path) rather than failing the upload itself.
    graph = _build_lane_graph_safely(town_name, dest_path)
    if graph:
        LANE_GRAPH_CACHE[town_name] = graph

    road_count = len(MAP_CACHE[town_name]["roads"])
    print(f"[upload] Imported '{town_name}' ({road_count} roads, "
          f"lane graph: {'yes' if graph else 'no'})")
    return {"town": town_name, "roads": road_count}


# ── Export API ─────────────────────────────────────────────────────────────────

@app.post("/api/export")
async def export_scenario(request: Request):
    params = await request.json()
    map_name = params.get("map", "scenario")

    try:
        tmp_path = export_to_xosc(params)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Export failed: {e}")

    filename = f"{map_name}_scenario.xosc"

    return FileResponse(
        tmp_path,
        media_type="application/xml",
        filename=filename,
        background=BackgroundTask(os.remove, tmp_path),
    )


@app.get("/api/presentation.pptx")
async def download_presentation():
    """Generate and serve the PowerPoint presentation."""
    import subprocess, sys
    script = _HERE.parent / "generate_pptx.py"
    out    = _HERE.parent / "OpenSCENARIO_Editor_Praesentation.pptx"
    subprocess.run([sys.executable, str(script)], cwd=str(_HERE.parent), check=True)
    return FileResponse(str(out), media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
                        filename="OpenSCENARIO_Editor_Praesentation.pptx")


@app.post("/api/export/route")
async def export_route(request: Request):
    """Export ego route as a separate route XML file."""
    params = await request.json()
    map_name = params.get("map", "scenario")

    try:
        tmp_path = export_route_xml(params)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Route export failed: {e}")

    filename = f"{map_name}_route.xml"
    return FileResponse(
        tmp_path,
        media_type="application/xml",
        filename=filename,
        background=BackgroundTask(os.remove, tmp_path),
    )
