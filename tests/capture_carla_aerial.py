"""capture_carla_aerial.py — render a georeferenced top-down image per town.

Not a test: a one-off tool, like probe_carla_lane_graph.py. Needs a running
CARLA and the `carla-venv` environment (this repo's own .venv has no `carla`):

  /home/dellpro2/Antonio/carla-venv/bin/python tests/capture_carla_aerial.py              # every bundled CARLA town
  /home/dellpro2/Antonio/carla-venv/bin/python tests/capture_carla_aerial.py Town03 Town05

**It calls `load_world` once per town**, so point it at a CARLA nobody else is
using — CARLA_PORT defaults to 2050, NOT run.sh's 2010. Start a private one with
`cd ~/yungloon/fail2drive/f2d_carla && ./CarlaUE4.sh -carla-port=2050 -RenderOffScreen -nosound`
(the same build run.sh runs, so the image shows the meshes a scenario runs on).

How it works: a nadir RGB camera (pitch -90, yaw -90 → image right = +x,
image down = +y, i.e. the editor's own frame with no flip) is placed over a
grid of tile centres. Its altitude is chosen so the ground plane at the tile's
road height images at exactly PPM pixels per metre:  alt = z_ground + f / PPM,
f = (S/2) / tan(fov/2). The georeference is therefore exact by construction —
no control points, no fitting.

A narrow FOV (8°, ~1.5 km up) keeps it near-orthographic, and only the central
half of each frame is kept, so a 30 m building leans at most ~1 m. That altitude
was checked by eye against a 60° capture: UE4 LOD/texture streaming does not
degrade at 1.5 km — lamp posts and benches stay sharp. Exposure is MANUAL so
every tile gets the same brightness (the default histogram auto-exposure would
make the seams visible). The sun is near-overhead (80°, see SUN_ALTITUDE
for why not 90), so shadows are short.

Output: maps/<Town>/aerial/meta.json plus a JPEG tile pyramid
maps/<Town>/aerial/<level>/<col>_<row>.jpg — level 0 is PPM px/m, each next
level halves it, the last level fits in one tile. meta.json:
  {ppm, x0, y0, width, height, tileSize, levels, ...}
where (x0, y0) is the CARLA world position of the level-0 image's top-left
corner and width/height are level-0 pixels.
"""
import json
import math
import os
import queue
import shutil
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

import carla

CARLA_HOST = os.environ.get("CARLA_HOST", "localhost")
CARLA_PORT = int(os.environ.get("CARLA_PORT", "2050"))

PPM = 10.0          # level-0 pixels per metre
FRAME = 2048        # rendered frame, px (square)
KEEP = 1024         # central crop kept from each frame, px
FOV = 8.0           # degrees
TILE = 512          # pyramid tile size, px
MARGIN_M = 60.0     # beyond the map's extent; the editor pads its viewBox by 3% (33 m on Town06)
SETTLE_TICKS = 4    # ticks after each teleport before the frame is used (texture streaming)
JPEG_QUALITY = 85
# Manual exposure, tuned by eye on Town03 (mean ~157/255, ~0.1% clipped). Bloom
# and lens flare are off: with them on, the water's glare haloed white onto the
# shore, differently in every frame, so the tile grid showed on Town04's coast.
EXPOSURE = dict(exposure_mode="manual", shutter_speed=60, iso=100, fstop=7.0,
                bloom_intensity=0, lens_flare_intensity=0)
# NOT 90. A nadir camera under an overhead sun catches the water's specular
# reflection dead centre in every frame — a saturated hotspot per frame that
# shows as a checkerboard on Town04's sea. At 80 the reflection leaves the 8°
# view (a few sparkles remain); shadows are ~0.18 × object height. 75 removes
# the sparkles too but doubles the shadows.
SUN_ALTITUDE = 80.0

REPO_ROOT = Path(__file__).resolve().parent.parent
MAPS_DIR = REPO_ROOT / "maps"
sys.path.insert(0, str(REPO_ROOT))
from backend.map_renderer import build_map_render_data   # stdlib-only, safe in carla-venv
# Town10 is the georeferenced VectorZero map with no CARLA asset — nothing to photograph.
TOWNS = ["Town01", "Town02", "Town03", "Town04", "Town05", "Town06", "Town07", "Town10HD"]


def _road_extent(cmap, town):
    """Union of CARLA's driving lanes and the editor's own bounds.

    The waypoints alone are not enough: generate_waypoints() yields driving
    lanes only, and Town03's .xodr reaches ~180 m further west than any of
    them, so a capture sized on waypoints left part of the editor's map blank.
    The editor's bounds come from the same parser that serves /render.
    """
    xs, ys = [], []
    for wp in cmap.generate_waypoints(2.0):
        loc = wp.transform.location
        xs.append(loc.x); ys.append(loc.y)
    b = build_map_render_data(town)["bounds"]
    return (min(min(xs), b["xMin"]), min(min(ys), b["yMin"]),
            max(max(xs), b["xMax"]), max(max(ys), b["yMax"]))


def _ground_z(cmap, x, y):
    wp = cmap.get_waypoint(carla.Location(x, y, 0.0), project_to_road=True,
                           lane_type=carla.LaneType.Any)
    return wp.transform.location.z if wp else 0.0


def capture_town(client, town):
    world = client.load_world(town)
    cmap = world.get_map()
    original = world.get_settings()
    settings = world.get_settings()
    settings.synchronous_mode = True
    settings.fixed_delta_seconds = 0.05
    world.apply_settings(settings)
    world.set_weather(carla.WeatherParameters(
        cloudiness=0, precipitation=0, precipitation_deposits=0, wind_intensity=0,
        sun_azimuth_angle=0, sun_altitude_angle=SUN_ALTITUDE, fog_density=0, wetness=0))

    xmin, ymin, xmax, ymax = _road_extent(cmap, town)
    step_m = KEEP / PPM
    x0 = math.floor((xmin - MARGIN_M) / 10) * 10
    y0 = math.floor((ymin - MARGIN_M) / 10) * 10
    cols = math.ceil((xmax + MARGIN_M - x0) / step_m)
    rows = math.ceil((ymax + MARGIN_M - y0) / step_m)
    W, H = cols * KEEP, rows * KEEP
    print(f"[{town}] {cols}x{rows} frames → {W}x{H} px ({W / PPM:.0f}x{H / PPM:.0f} m)", flush=True)
    mosaic = np.zeros((H, W, 3), np.uint8)

    bp = world.get_blueprint_library().find("sensor.camera.rgb")
    for k, v in dict(image_size_x=FRAME, image_size_y=FRAME, fov=FOV,
                     motion_blur_intensity=0, **EXPOSURE).items():
        bp.set_attribute(k, str(v))
    focal = (FRAME / 2) / math.tan(math.radians(FOV) / 2)
    q = queue.Queue()
    cam = world.spawn_actor(bp, carla.Transform(carla.Location(0, 0, 2000), carla.Rotation(pitch=-90, yaw=-90)))
    cam.listen(q.put)
    lo = (FRAME - KEEP) // 2
    try:
        for _ in range(20):          # first load: let the whole level stream in
            world.tick()
        t0 = time.time()
        for r in range(rows):
            for c in range(cols):
                cx = x0 + (c + 0.5) * step_m
                cy = y0 + (r + 0.5) * step_m
                alt = _ground_z(cmap, cx, cy) + focal / PPM
                cam.set_transform(carla.Transform(carla.Location(cx, cy, alt),
                                                  carla.Rotation(pitch=-90, yaw=-90)))
                frame = None
                for _ in range(SETTLE_TICKS):
                    frame = world.tick()
                img = q.get(timeout=30)
                while img.frame < frame:
                    img = q.get(timeout=30)
                a = np.frombuffer(img.raw_data, np.uint8).reshape(FRAME, FRAME, 4)
                mosaic[r * KEEP:(r + 1) * KEEP, c * KEEP:(c + 1) * KEEP] = \
                    a[lo:lo + KEEP, lo:lo + KEEP, 2::-1]       # BGRA → RGB
                while not q.empty():
                    q.get_nowait()
            print(f"  row {r + 1}/{rows}  ({time.time() - t0:.0f}s)", flush=True)
    finally:
        cam.stop()
        cam.destroy()
        world.apply_settings(original)
    return mosaic, x0, y0


def write_pyramid(town, mosaic, x0, y0):
    out = MAPS_DIR / town / "aerial"
    if out.exists():
        shutil.rmtree(out)
    img = Image.fromarray(mosaic)
    level = 0
    while True:
        d = out / str(level)
        d.mkdir(parents=True)
        cols = math.ceil(img.width / TILE)
        rows = math.ceil(img.height / TILE)
        for r in range(rows):
            for c in range(cols):
                tile = img.crop((c * TILE, r * TILE, min((c + 1) * TILE, img.width),
                                 min((r + 1) * TILE, img.height)))
                tile.save(d / f"{c}_{r}.jpg", quality=JPEG_QUALITY, optimize=True)
        if cols == 1 and rows == 1:
            break
        img = img.resize((max(1, img.width // 2), max(1, img.height // 2)), Image.LANCZOS)
        level += 1
    meta = {
        "ppm": PPM, "x0": x0, "y0": y0,
        "width": mosaic.shape[1], "height": mosaic.shape[0],
        "tileSize": TILE, "levels": level + 1,
        "source": "carla", "fov": FOV, "sunAltitude": SUN_ALTITUDE,
        "captured": time.strftime("%Y-%m-%d"),
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=2))
    size = sum(f.stat().st_size for f in out.rglob("*.jpg"))
    print(f"[{town}] wrote {level + 1} levels, {size / 1e6:.1f} MB → {out}", flush=True)


def main():
    towns = sys.argv[1:] or TOWNS
    client = carla.Client(CARLA_HOST, CARLA_PORT)
    client.set_timeout(300)
    for town in towns:
        if not (MAPS_DIR / town).is_dir():
            print(f"[{town}] no maps/{town}/ folder — skipped")
            continue
        mosaic, x0, y0 = capture_town(client, town)
        write_pyramid(town, mosaic, x0, y0)


if __name__ == "__main__":
    main()
