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

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

from backend.map_renderer import (
    build_map_render_data,
    list_available_towns,
    THUMBNAIL_PATHS,
)
from backend.scenario_io import export_to_xosc, export_route_xml

# ── Paths ──────────────────────────────────────────────────────────────────────

_HERE     = Path(__file__).resolve().parent
_FRONTEND = _HERE.parent / "frontend"

# ── App ────────────────────────────────────────────────────────────────────────

app = FastAPI(title="OpenSCENARIO Editor", version="1.0.0")

# ── MAP_CACHE: pre-load all town render data at startup ────────────────────────

MAP_CACHE: dict[str, dict] = {}


@app.on_event("startup")
async def preload_maps():
    towns = list_available_towns()
    print(f"[startup] Pre-loading map geometry for {len(towns)} towns …")
    for town in towns:
        try:
            MAP_CACHE[town] = build_map_render_data(town)
            print(f"  ✓ {town}  ({len(MAP_CACHE[town]['roads'])} roads)")
        except Exception as exc:
            print(f"  ✗ {town}: {exc}")
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
