"""
map_renderer.py — Parse a CARLA OpenDRIVE (.xodr) file into road polygon data for SVG rendering.

Coordinate convention:
  OpenDRIVE (x, y)  →  CARLA / SVG  (cx = x,  cy = -y)   [Y-axis flip]
  SVG viewBox is set to CARLA bounds directly — no further transform needed.
"""

import math
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

# ── Map file paths ─────────────────────────────────────────────────────────────

_LLMGEN   = Path("/home/dellpro2/CC/llm-scenario-gen")
_VEC_MAPS = Path("/home/dellpro2/CC/map_data/vector_maps/xodr")

XODR_PATHS: dict[str, Path] = {
    "Town01":   _LLMGEN / "maps/Town01/Town01.xodr",
    "Town02":   _LLMGEN / "maps/Town02/Town02.xodr",
    "Town03":   _LLMGEN / "maps/Town03/Town03.xodr",
    "Town04":   _LLMGEN / "maps/Town04/Town04.xodr",
    "Town05":   _LLMGEN / "maps/Town05/Town05.xodr",
    "Town06":   _LLMGEN / "maps/Town06/Town06.xodr",
    "Town07":   _LLMGEN / "maps/Town07/Town07.xodr",
    "Town10":   _LLMGEN / "maps/Town10/Town10.xodr",
    "Town10HD": _VEC_MAPS / "Town10HD.xodr",
}

THUMBNAIL_PATHS: dict[str, Path] = {
    t: _LLMGEN / f"maps/{t}/{t}.jpg"
    for t in ["Town01", "Town02", "Town03", "Town04", "Town05", "Town06", "Town07", "Town10"]
}

# ── Lane type colours (matched to SafetyPool Studio dark palette) ──────────────

LANE_COLORS: dict[str, str] = {
    "driving":       "#3d3d3d",      # dark asphalt
    "bidirectional": "#3d3d3d",
    "sidewalk":      "#a89878",      # warm tan
    "shoulder":      "#555555",
    "parking":       "#606060",
    "biking":        "#4a6a4a",
    "border":        "#484848",
    "restricted":    "#484848",
}
DEFAULT_LANE_COLOR = "#484848"
GRASS_COLOR        = "#1e4a1e"       # deeper green for contrast

# ── Geometry sampling ──────────────────────────────────────────────────────────

def _sample_geometry(road_elem: ET.Element, interval: float = 4.0) -> list[tuple]:
    """
    Sample world positions along road planView at `interval` metres.
    Returns list of (xodr_x, xodr_y, hdg_rad, s) in OpenDRIVE coordinates.
    Handles 'line' and 'arc' geometry types (only types present in CARLA maps).
    """
    plan_view = road_elem.find('planView')
    if plan_view is None:
        return []

    samples = []
    for geom in plan_view.findall('geometry'):
        s0     = float(geom.get('s', 0))
        x0     = float(geom.get('x', 0))
        y0     = float(geom.get('y', 0))
        hdg    = float(geom.get('hdg', 0))
        length = float(geom.get('length', 0))

        arc = geom.find('arc')
        curvature = float(arc.get('curvature', 0)) if arc is not None else 0.0

        s = 0.0
        while s <= length + 0.001:
            if curvature != 0.0:
                r     = 1.0 / curvature
                angle = s * curvature
                px = x0 + r * (math.sin(hdg + angle) - math.sin(hdg))
                py = y0 + r * (-math.cos(hdg + angle) + math.cos(hdg))
                ph = hdg + angle
            else:
                px = x0 + s * math.cos(hdg)
                py = y0 + s * math.sin(hdg)
                ph = hdg

            samples.append((px, py, ph, s0 + s))
            s += interval

    return samples


# ── Lane width extraction ──────────────────────────────────────────────────────

def _get_lane_defs(road_elem: ET.Element) -> list[dict]:
    """
    Return lane definitions from the first laneSection.
    Each entry: {'id': int, 'type': str, 'inner': float, 'outer': float, 'side': 'L'|'R'}
    Widths are cumulative, stacking outward from the road centreline.
    """
    ls = road_elem.find('.//laneSection')
    if ls is None:
        return []

    result = []
    for side_name, side_key in [('left', 'L'), ('right', 'R')]:
        se = ls.find(side_name)
        if se is None:
            continue
        lanes_sorted = sorted(
            se.findall('lane'),
            key=lambda l: abs(int(l.get('id', 0)))
        )
        cum = 0.0
        for lane in lanes_sorted:
            try:
                lid = int(lane.get('id', 0))
            except ValueError:
                continue
            ltype   = lane.get('type', 'none')
            w_elem  = lane.find('width')
            w = float(w_elem.get('a', 3.5)) if w_elem is not None else 3.5
            if ltype != 'none' and w > 0:
                result.append({
                    'id':    lid,
                    'type':  ltype,
                    'inner': round(cum, 3),
                    'outer': round(cum + w, 3),
                    'side':  side_key,
                })
            cum += w

    return result


# ── Polygon builder ────────────────────────────────────────────────────────────

def _build_lane_polygon(
    samples:  list[tuple],
    inner_w:  float,
    outer_w:  float,
    side:     str,
) -> list[list[float]]:
    """
    Build a closed polygon for one lane in CARLA/SVG coords.
    side='L' → left of centreline (perp = hdg + π/2)
    side='R' → right of centreline (perp = hdg - π/2)
    Applies carla_y = -xodr_y during construction.
    """
    sign = +1.0 if side == 'L' else -1.0
    fwd_inner: list[list[float]] = []
    fwd_outer: list[list[float]] = []

    for (px, py, ph, _s) in samples:
        perp = ph + sign * math.pi / 2.0

        ix = round(px + inner_w * math.cos(perp), 2)
        iy = round(-(py + inner_w * math.sin(perp)), 2)   # Y flip
        ox = round(px + outer_w * math.cos(perp), 2)
        oy = round(-(py + outer_w * math.sin(perp)), 2)   # Y flip

        fwd_inner.append([ix, iy])
        fwd_outer.append([ox, oy])

    # Closed polygon: forward inner edge + reversed outer edge
    return fwd_inner + list(reversed(fwd_outer))


# ── Traffic lights & crosswalks from xodr ─────────────────────────────────────

def _eval_geometry_at_s(road_elem: ET.Element, s_query: float):
    """Return (world_x, world_y, heading_rad) at position s along the road."""
    pv = road_elem.find('planView')
    if pv is None:
        return None
    geoms = pv.findall('geometry')
    for i, g in enumerate(geoms):
        s0     = float(g.get('s', 0))
        length = float(g.get('length', 0))
        if s_query >= s0 and (s_query <= s0 + length or i == len(geoms) - 1):
            x0  = float(g.get('x', 0))
            y0  = float(g.get('y', 0))
            hdg = float(g.get('hdg', 0))
            ds  = s_query - s0
            arc = g.find('arc')
            if arc is not None:
                curv = float(arc.get('curvature', 0))
                if curv != 0:
                    r     = 1.0 / curv
                    angle = ds * curv
                    px = x0 + r * (math.sin(hdg + angle) - math.sin(hdg))
                    py = y0 + r * (-math.cos(hdg + angle) + math.cos(hdg))
                    ph = hdg + angle
                else:
                    px = x0 + ds * math.cos(hdg)
                    py = y0 + ds * math.sin(hdg)
                    ph = hdg
            else:
                px = x0 + ds * math.cos(hdg)
                py = y0 + ds * math.sin(hdg)
                ph = hdg
            return px, py, ph
    return None


def _extract_traffic_lights(root: ET.Element) -> list[dict]:
    """Return list of {x, y} traffic light positions in CARLA coords."""
    results = []
    for road in root.findall('road'):
        for sig in road.findall('.//signal'):
            if sig.get('dynamic', '') != 'yes':
                continue
            s = float(sig.get('s', 0))
            t = float(sig.get('t', 0))
            res = _eval_geometry_at_s(road, s)
            if res is None:
                continue
            px, py, ph = res
            # Offset laterally by t
            wx = px - t * math.sin(ph)
            wy = py + t * math.cos(ph)
            results.append({'x': round(wx, 1), 'y': round(-wy, 1)})   # Y flip
    return results


def _extract_crosswalks(root: ET.Element) -> list[dict]:
    """
    Derive crosswalk positions from junction-approach roads that have sidewalk lanes.
    Returns list of {x, y, heading} where heading is road direction in degrees.
    """
    results = []
    junction_road_ids = {
        r.get('id') for r in root.findall('road')
        if r.get('junction', '-1') != '-1'
    }

    for road in root.findall('road'):
        if road.get('junction', '-1') != '-1':
            continue
        # Only roads with sidewalk lanes generate crosswalks
        has_sidewalk = any(
            lane.get('type') == 'sidewalk'
            for lane in road.findall('.//lane')
        )
        if not has_sidewalk:
            continue

        length = float(road.get('length', 0))
        link   = road.find('link')
        if link is None:
            continue

        for end_name, s_pos in [('successor', length), ('predecessor', 0.0)]:
            end_elem = link.find(end_name)
            if end_elem is None:
                continue
            if end_elem.get('elementType', '') != 'junction':
                continue
            res = _eval_geometry_at_s(road, s_pos)
            if res is None:
                continue
            px, py, ph = res
            heading_deg = round(math.degrees(-ph) % 360, 1)   # CARLA yaw convention
            results.append({
                'x':       round(px, 1),
                'y':       round(-py, 1),   # Y flip
                'heading': heading_deg,
            })

    return results


# ── Spawn point extraction via map_parser ──────────────────────────────────────

def _load_spawn_points(xodr_path: str) -> tuple[list[dict], list[dict]]:
    """
    Use the existing map_parser.parse_xodr() to extract spawn points and intersections.
    Returns (spawn_points, intersections).
    """
    sys.path.insert(0, str(_LLMGEN))
    try:
        from preprocessing.map_parser import parse_xodr  # type: ignore
        summary = parse_xodr(xodr_path)
    except Exception:
        return [], []

    spawn_points = []
    for seg in summary.get('road_segments', []):
        for lane in seg.get('lanes', []):
            for sp in lane.get('spawns', []):
                spawn_points.append({
                    'x':   sp['x'],
                    'y':   sp['y'],
                    'yaw': sp.get('yaw', 0.0),
                })

    intersections = []
    for junc in summary.get('intersections', []):
        cx = junc.get('center', {}).get('x', 0)
        cy = junc.get('center', {}).get('y', 0)
        intersections.append({
            'id': junc.get('junction_id', '?'),
            'cx': cx,
            'cy': cy,
        })

    return spawn_points, intersections


# ── Public API ─────────────────────────────────────────────────────────────────

def build_map_render_data(town_name: str, interval: float = 4.0) -> dict:
    """
    Parse the .xodr for `town_name` and return a JSON-serialisable dict suitable
    for sending to the frontend SVG renderer.

    Returns:
    {
      "town":        str,
      "bounds":      {"xMin", "xMax", "yMin", "yMax"},   # CARLA coords
      "roads":       [...],                               # lane polygons
      "spawnPoints": [...],                               # {x, y, yaw}
      "intersections": [...],                             # {id, cx, cy}
    }
    """
    xodr_path = XODR_PATHS.get(town_name)
    if xodr_path is None or not xodr_path.exists():
        raise FileNotFoundError(f"No .xodr file found for town '{town_name}'")

    tree = ET.parse(str(xodr_path))
    root = tree.getroot()
    header = root.find('header')

    # Bounds: OpenDRIVE header uses geographic convention (west/east/south/north)
    # After Y-flip: carla_y = -xodr_y, so:
    #   carla_yMin = -xodr_north,  carla_yMax = -xodr_south
    w = float(header.get('west',   -500))
    e = float(header.get('east',    500))
    s = float(header.get('south', -500))
    n = float(header.get('north',   500))

    bounds = {
        'xMin': round(w, 2),
        'xMax': round(e, 2),
        'yMin': round(-n, 2),   # CARLA Y flip
        'yMax': round(-s, 2),   # CARLA Y flip
    }

    # Road polygons
    roads_out = []
    for road in root.findall('road'):
        length = float(road.get('length', 0))
        if length < 5.0:      # skip micro-connectors
            continue

        samples = _sample_geometry(road, interval)
        if not samples:
            continue

        lane_defs = _get_lane_defs(road)
        if not lane_defs:
            continue

        lanes_out = []
        for ld in lane_defs:
            poly  = _build_lane_polygon(samples, ld['inner'], ld['outer'], ld['side'])
            color = LANE_COLORS.get(ld['type'], DEFAULT_LANE_COLOR)

            lane_entry = {
                'laneId': ld['id'],
                'type':   ld['type'],
                'color':  color,
                'polygon': poly,
            }

            # For driving/bidirectional lanes, compute a direction centerline
            # at the lane's center offset, with correct travel direction.
            if ld['type'] in ('driving', 'bidirectional'):
                center_offset = (ld['inner'] + ld['outer']) / 2.0
                sign = +1.0 if ld['side'] == 'L' else -1.0
                lane_cl = []
                for (px, py, ph, _s) in samples:
                    perp = ph + sign * math.pi / 2.0
                    cx = round(px + center_offset * math.cos(perp), 2)
                    cy = round(-(py + center_offset * math.sin(perp)), 2)
                    lane_cl.append([cx, cy])
                # Left lanes travel opposite to the reference line direction
                if ld['side'] == 'L':
                    lane_cl.reverse()
                lane_entry['directionLine'] = lane_cl

            lanes_out.append(lane_entry)

        # Centreline in CARLA coords (Y-flipped)
        centreline = [[round(px, 2), round(-py, 2)] for (px, py, _ph, _s) in samples]

        roads_out.append({
            'id':         road.get('id'),
            'junction':   road.get('junction', '-1'),
            'length':     round(length, 1),
            'lanes':      lanes_out,
            'centerline': centreline,
        })

    # Spawn points + intersections (from existing map_parser)
    spawn_points, intersections = _load_spawn_points(str(xodr_path))

    # Traffic lights and crosswalks (from xodr signals/geometry)
    traffic_lights = _extract_traffic_lights(root)
    crosswalks     = _extract_crosswalks(root)

    return {
        'town':          town_name,
        'bounds':        bounds,
        'roads':         roads_out,
        'spawnPoints':   spawn_points,
        'intersections': intersections,
        'trafficLights': traffic_lights,
        'crosswalks':    crosswalks,
        'grassColor':    GRASS_COLOR,
    }


def list_available_towns() -> list[str]:
    """Return names of towns whose .xodr files actually exist on disk."""
    return [name for name, path in XODR_PATHS.items() if path.exists()]
