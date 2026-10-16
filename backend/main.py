"""FastAPI backend of the scenario editor: map data, exports, background traffic, static files."""

import csv
import json
import os
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

from backend.lane_graph.lane_graph_builder import build_lane_graph_from_xodr
from backend.scenario.batch_export import export_batch_zip
from backend.scenario.scenario_io import export_route_xml, export_to_xosc
from backend.traffic import bg_traffic
from backend.xodr.map_renderer import (
    THUMBNAIL_PATHS,
    XODR_PATHS,
    build_map_render_data,
    build_map_render_data_from_path,
    list_available_towns,
)

# ── Paths ──────────────────────────────────────────────────────────────────────

_HERE = Path(__file__).resolve().parent
_FRONTEND = _HERE.parent / "frontend"
_UPLOADS_DIR = _HERE.parent / "maps" / "_uploaded"  # persisted user maps
_BUILDINGS_CSV = _HERE.parent / "maps" / "special_buildings.csv"

# ── App ────────────────────────────────────────────────────────────────────────

app = FastAPI(title="OpenSCENARIO Editor", version="1.0.0")

# ── MAP_CACHE: pre-load all town render data at startup ────────────────────────

MAP_CACHE: dict[str, dict] = {}

# LANE_GRAPH_CACHE: per town, a CARLA-probed maps/<Town>/lane_graph.json when present, else one
# derived from the .xodr (source "xodr", which ranks no fork). Built at startup or upload.
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

    # A range far off zero suggests an absolute datum (maps/Town10: +50…+103 m); flagged, not shifted.
    def _elev_note(data: dict) -> str:
        ev = data.get('elevation') or {}
        lo, hi = ev.get('min', 0.0), ev.get('max', 0.0)
        if lo == 0.0 and hi == 0.0:
            return "flat"
        note = f"z {lo:+.1f}..{hi:+.1f} m"
        return note + "  ⚠ absolute datum?" if lo > 5.0 else note

    towns = list_available_towns()
    print(f"[startup] Pre-loading map geometry for {len(towns)} towns …")
    for town in towns:
        try:
            MAP_CACHE[town] = build_map_render_data(town)
            print(f"  ✓ {town}  ({len(MAP_CACHE[town]['roads'])} roads, {_elev_note(MAP_CACHE[town])})")
        except Exception as exc:
            print(f"  ✗ {town}: {exc}")

    # Uploaded maps, re-parsed on every startup.
    for xodr_file in sorted(_UPLOADS_DIR.glob("*.xodr")):
        town_name = xodr_file.stem
        if town_name not in MAP_CACHE:
            try:
                MAP_CACHE[town_name] = build_map_render_data_from_path(xodr_file, town_name)
                print(
                    f"  ✓ (uploaded) {town_name}  "
                    f"({len(MAP_CACHE[town_name]['roads'])} roads, {_elev_note(MAP_CACHE[town_name])})"
                )
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
        # No probed file: derive one from the .xodr.
        xodr_path = XODR_PATHS.get(town) or (_UPLOADS_DIR / f"{town}.xodr")
        if xodr_path.exists():
            graph = _build_lane_graph_safely(town, xodr_path)
            if graph:
                LANE_GRAPH_CACHE[town] = graph
    carla_count = sum(1 for g in LANE_GRAPH_CACHE.values() if g.get('source') != 'xodr')
    xodr_count = len(LANE_GRAPH_CACHE) - carla_count
    print(
        f"[startup] Lane graph cache ready. {len(LANE_GRAPH_CACHE)}/{len(MAP_CACHE)} towns have one "
        f"({carla_count} CARLA-probed, {xodr_count} xodr-derived)."
    )


# ── Static file serving ────────────────────────────────────────────────────────

app.mount("/static", StaticFiles(directory=str(_FRONTEND)), name="static")


@app.get("/")
async def index():
    return FileResponse(str(_FRONTEND / "index.html"))


# ── Map API ────────────────────────────────────────────────────────────────────


@app.get("/api/maps")
async def get_maps():
    # laneGraphs: the towns with a graph (nearly all; the frontend fetches regardless).
    return {"maps": list(MAP_CACHE.keys()), "laneGraphs": list(LANE_GRAPH_CACHE.keys())}


@app.get("/api/maps/{town}/render")
async def get_map_render(town: str):
    if town not in MAP_CACHE:
        raise HTTPException(status_code=404, detail=f"Town '{town}' not found")
    return JSONResponse(content=MAP_CACHE[town])


@app.get("/api/maps/{town}/lane_graph")
async def get_lane_graph(town: str):
    if town not in LANE_GRAPH_CACHE:
        # Every cached town gets a graph attempt, so this means the attempt failed (see the logs).
        detail = (
            f"Town '{town}' not found"
            if town not in MAP_CACHE
            else f"No lane graph available for '{town}' — building one from its .xodr failed (see server logs)"
        )
        raise HTTPException(status_code=404, detail=detail)
    return JSONResponse(content=LANE_GRAPH_CACHE[town])


@app.get("/api/maps/{town}/preview")
async def get_map_preview(town: str):
    thumb = THUMBNAIL_PATHS.get(town)
    if thumb and thumb.exists():
        return FileResponse(str(thumb), media_type="image/jpeg")
    raise HTTPException(status_code=404, detail=f"No preview image for '{town}'")


# The aerial pyramid (tools/probes/capture_carla_aerial.py), read per request: a re-capture
# shows on a browser reload.
def _aerial_dir(town: str) -> Path:
    if town not in MAP_CACHE:
        raise HTTPException(status_code=404, detail=f"Town '{town}' not found")
    return _HERE.parent / "maps" / town / "aerial"


@app.get("/api/maps/{town}/aerial")
async def get_aerial_meta(town: str):
    meta = _aerial_dir(town) / "meta.json"
    if not meta.exists():
        raise HTTPException(status_code=404, detail=f"No aerial image for '{town}'")
    data = json.loads(meta.read_text())
    # Busts the tiles' 1 h browser cache after a re-capture (the frontend appends it to tile URLs).
    data["version"] = int(meta.stat().st_mtime)
    return JSONResponse(content=data, headers={"Cache-Control": "no-cache"})


@app.get("/api/maps/{town}/aerial/{level:int}/{col:int}_{row:int}.jpg")
async def get_aerial_tile(town: str, level: int, col: int, row: int):
    tile = _aerial_dir(town) / str(level) / f"{col}_{row}.jpg"
    if not tile.exists():
        raise HTTPException(status_code=404, detail="No such tile")
    return FileResponse(str(tile), media_type="image/jpeg", headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/special_buildings")
async def get_special_buildings():
    """Landmarks for all towns from maps/special_buildings.csv, read per request (edit, reload).

    CARLA coordinates, plotted verbatim. A missing or broken file yields an empty list.
    """
    return {"buildings": _read_special_buildings()}


def _read_special_buildings() -> list[dict]:
    if not _BUILDINGS_CSV.exists():
        return []
    out: list[dict] = []
    try:
        with _BUILDINGS_CSV.open(newline="", encoding="utf-8-sig") as fh:
            for row in csv.DictReader(fh):
                town = (row.get("town") or "").strip()
                btype = (row.get("building_type") or "").strip()
                if not town or not btype:
                    continue
                try:
                    x = float(row["x"])
                    y = float(row["y"])
                except (KeyError, TypeError, ValueError):
                    continue
                try:
                    z = float(row.get("z") or 0.0)
                except ValueError:
                    z = 0.0
                out.append(
                    {
                        "town": town,
                        "type": btype,
                        "name": (row.get("carla_name") or "").strip(),
                        "x": x,
                        "y": y,
                        "z": z,
                    }
                )
    except OSError as exc:
        print(f"[buildings] {_BUILDINGS_CSV}: {exc}")
        return []
    return out


@app.post("/api/maps/upload")
async def upload_map(file: UploadFile = File(...)):
    """Accept a .xodr upload, persist it in maps/_uploaded/, parse and cache it; returns the town name."""
    if not file.filename or not file.filename.lower().endswith(".xodr"):
        raise HTTPException(status_code=400, detail="Only .xodr files are accepted.")

    raw_stem = Path(file.filename).stem
    town_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in raw_stem)
    if not town_name:
        town_name = "CustomMap"

    dest_path = _UPLOADS_DIR / f"{town_name}.xodr"
    try:
        content = await file.read()
        dest_path.write_bytes(content)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save file: {exc}") from exc

    try:
        MAP_CACHE[town_name] = build_map_render_data_from_path(dest_path, town_name)
    except Exception as exc:
        dest_path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=f"Failed to parse .xodr: {exc}") from exc

    # Best-effort: a failure leaves the town without a lane graph, not the upload failed.
    graph = _build_lane_graph_safely(town_name, dest_path)
    if graph:
        LANE_GRAPH_CACHE[town_name] = graph

    road_count = len(MAP_CACHE[town_name]["roads"])
    print(f"[upload] Imported '{town_name}' ({road_count} roads, lane graph: {'yes' if graph else 'no'})")
    return {"town": town_name, "roads": road_count}


# ── Export API ─────────────────────────────────────────────────────────────────


@app.post("/api/export")
async def export_scenario(request: Request):
    params = await request.json()
    map_name = params.get("map", "scenario")

    try:
        tmp_path = export_to_xosc(params)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Export failed: {e}") from e

    filename = f"{map_name}_scenario.xosc"

    return FileResponse(
        tmp_path,
        media_type="application/xml",
        filename=filename,
        background=BackgroundTask(os.remove, tmp_path),
    )


@app.post("/api/export/batch")
async def export_batch(request: Request):
    """Zip of many generated scenarios plus a manifest (Mehrere generieren); see export_batch_zip."""
    body = await request.json()
    try:
        zip_path, n_ok, n_failed = export_batch_zip(body.get("scenarios"))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Batch export failed: {e}") from e
    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=body.get("filename") or "scenarios.zip",
        headers={"X-Scenarios-Ok": str(n_ok), "X-Scenarios-Failed": str(n_failed)},
        background=BackgroundTask(os.remove, zip_path),
    )


# ── Background traffic (SUMO trajectories replayed as CARLA puppets) ─────────


def _xodr_for(town: str) -> Path:
    path = XODR_PATHS.get(town)
    if path is None:
        candidate = _UPLOADS_DIR / f"{town}.xodr"
        path = candidate if candidate.exists() else None
    if path is None:
        raise HTTPException(status_code=404, detail=f"Unknown town: {town}")
    return Path(path)


def _bg_traffic_or_http(town: str, request_body: dict) -> dict:
    try:
        return bg_traffic.generate(town, _xodr_for(town), request_body)
    except bg_traffic.BgTrafficError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post("/api/bg_traffic")
def generate_bg_traffic(body: dict):
    """Background traffic for the preview (backend/traffic/bg_traffic.py).

    A plain `def`, so FastAPI runs the SUMO subprocesses in its thread pool.
    """
    return _bg_traffic_or_http(body.get("town") or "", body)


@app.post("/api/export/bundle")
def export_bundle(body: dict):
    """The .xosc and its background traffic, zipped as <map>_scenario.xosc / .bgtraffic.json.

    run.sh picks the traffic up by that name; it comes from the same cache the preview used.
    """
    import zipfile

    params = body.get("params") or {}
    traffic_req = body.get("bg_traffic") or {}
    map_name = params.get("map", "scenario")
    traffic = _bg_traffic_or_http(map_name, traffic_req)
    try:
        xosc_path = export_to_xosc(params)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Export failed: {e}") from e
    zip_path = xosc_path[: -len(".xosc")] + ".zip"
    stem = f"{map_name}_scenario"
    try:
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(xosc_path, f"{stem}.xosc")
            zf.writestr(f"{stem}.bgtraffic.json", json.dumps(traffic, separators=(",", ":")))
    finally:
        os.remove(xosc_path)
    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=f"{stem}.zip",
        headers={"X-Bg-Traffic-Vehicles": str(len(traffic["vehicles"]))},
        background=BackgroundTask(os.remove, zip_path),
    )


@app.get("/api/presentation.pptx")
async def download_presentation():
    """Generate and serve the PowerPoint presentation."""
    import subprocess
    import sys

    script = _HERE.parent / "generate_pptx.py"
    out = _HERE.parent / "OpenSCENARIO_Editor_Praesentation.pptx"
    subprocess.run([sys.executable, str(script)], cwd=str(_HERE.parent), check=True)
    return FileResponse(
        str(out),
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        filename="OpenSCENARIO_Editor_Praesentation.pptx",
    )


@app.post("/api/export/route")
async def export_route(request: Request):
    """Export ego route as a separate route XML file."""
    params = await request.json()
    map_name = params.get("map", "scenario")

    try:
        tmp_path = export_route_xml(params)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Route export failed: {e}") from e

    filename = f"{map_name}_route.xml"
    return FileResponse(
        tmp_path,
        media_type="application/xml",
        filename=filename,
        background=BackgroundTask(os.remove, tmp_path),
    )
