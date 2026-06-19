"""
main.py — FastAPI backend for the OpenSCENARIO GUI Scenario Editor.

Endpoints:
  GET  /                           → serve index.html
  GET  /static/{path}              → serve frontend static files
  GET  /api/maps                   → list available towns
  GET  /api/maps/{town}/render     → road polygon + spawn point JSON (MAP_CACHE)
  GET  /api/maps/{town}/preview    → serve town thumbnail image
  POST /api/export                 → generate .xosc and return as download
"""

import os
import sys
from pathlib import Path

import shutil
import tempfile

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

from backend.map_renderer import (
    build_map_render_data,
    build_map_render_data_from_path,
    list_available_towns,
    THUMBNAIL_PATHS,
)
from backend.scenario_io import export_to_xosc, export_route_xml

# ── Paths ──────────────────────────────────────────────────────────────────────

_HERE        = Path(__file__).resolve().parent
_FRONTEND    = _HERE.parent / "frontend"
_UPLOADS_DIR = _HERE.parent / "maps" / "_uploaded"   # persisted user maps

# ── App ────────────────────────────────────────────────────────────────────────

app = FastAPI(title="OpenSCENARIO Editor", version="1.0.0")

# ── MAP_CACHE: pre-load all town render data at startup ────────────────────────

MAP_CACHE: dict[str, dict] = {}


@app.on_event("startup")
async def preload_maps():
    _UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

    # Pre-load bundled towns
    towns = list_available_towns()
    print(f"[startup] Pre-loading map geometry for {len(towns)} towns …")
    for town in towns:
        try:
            MAP_CACHE[town] = build_map_render_data(town)
            print(f"  ✓ {town}  ({len(MAP_CACHE[town]['roads'])} roads)")
        except Exception as exc:
            print(f"  ✗ {town}: {exc}")

    # Re-load any previously uploaded maps
    for xodr_file in sorted(_UPLOADS_DIR.glob("*.xodr")):
        town_name = xodr_file.stem
        if town_name not in MAP_CACHE:
            try:
                MAP_CACHE[town_name] = build_map_render_data_from_path(xodr_file, town_name)
                print(f"  ✓ (uploaded) {town_name}  ({len(MAP_CACHE[town_name]['roads'])} roads)")
            except Exception as exc:
                print(f"  ✗ (uploaded) {town_name}: {exc}")

    print(f"[startup] Map cache ready. {len(MAP_CACHE)} towns loaded.")


# ── Static file serving ────────────────────────────────────────────────────────

app.mount("/static", StaticFiles(directory=str(_FRONTEND)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(_FRONTEND / "index.html"))


# ── Map API ────────────────────────────────────────────────────────────────────

@app.get("/api/maps")
async def get_maps():
    return {"maps": list(MAP_CACHE.keys())}


@app.get("/api/maps/{town}/render")
async def get_map_render(town: str):
    if town not in MAP_CACHE:
        raise HTTPException(status_code=404, detail=f"Town '{town}' not found")
    return JSONResponse(content=MAP_CACHE[town])


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

    road_count = len(MAP_CACHE[town_name]["roads"])
    print(f"[upload] Imported '{town_name}' ({road_count} roads)")
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

    # Also generate route XML if ego route waypoints are provided
    route_wps = params.get("route_waypoints", [])
    route_path = None
    if route_wps and len(route_wps) >= 1:
        try:
            route_path = export_route_xml(params)
        except Exception as e:
            print(f"[export] Route XML generation failed (non-fatal): {e}")

    def _cleanup():
        os.remove(tmp_path)
        if route_path and os.path.exists(route_path):
            pass  # keep route XML — user may need it

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
