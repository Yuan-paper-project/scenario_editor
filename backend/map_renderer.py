"""
map_renderer.py — Parse a CARLA OpenDRIVE (.xodr) file into road polygon data for SVG rendering.

Coordinate convention:
  OpenDRIVE (x, y)  →  CARLA / SVG  (cx = x,  cy = -y)   [Y-axis flip]
  SVG viewBox is set to CARLA bounds directly — no further transform needed.
"""

import math
import os
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

# ── Map file paths ─────────────────────────────────────────────────────────────

_MAPS_DIR = Path(__file__).resolve().parent.parent / "maps"
_LLMGEN = Path(__file__).resolve().parent.parent.parent / "llm-scenario-gen"
if not _LLMGEN.exists():
    _LLMGEN = Path("/home/dellpro2/CC/llm-scenario-gen")

def _scan_xodr_paths(maps_dir: Path) -> dict[str, Path]:
    """Scan maps/ for any subdirectory that contains a .xodr file."""
    result = {}
    if not maps_dir.exists():
        return result
    for sub in sorted(maps_dir.iterdir()):
        if not sub.is_dir() or sub.name.startswith("_"):
            continue
        for xodr in sub.glob("*.xodr"):
            result[sub.name] = xodr
            break   # take the first .xodr found per folder
    return result

def _scan_thumbnail_paths(maps_dir: Path) -> dict[str, Path]:
    """Scan maps/ for thumbnail images (.jpg or .png) per town folder."""
    result = {}
    if not maps_dir.exists():
        return result
    for sub in sorted(maps_dir.iterdir()):
        if not sub.is_dir() or sub.name.startswith("_"):
            continue
        for ext in ("jpg", "jpeg", "png"):
            thumb = sub / f"{sub.name}.{ext}"
            if thumb.exists():
                result[sub.name] = thumb
                break
    return result

XODR_PATHS: dict[str, Path]      = _scan_xodr_paths(_MAPS_DIR)
THUMBNAIL_PATHS: dict[str, Path] = _scan_thumbnail_paths(_MAPS_DIR)

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
SPAWN_SAMPLE_INTERVAL_M = 25.0
MIN_SPAWN_ROAD_LENGTH_M = 20.0

# ── Lane Offset Parser ─────────────────────────────────────────────────────────

def _get_lane_offsets(road_elem: ET.Element) -> list[tuple]:
    """Extract all laneOffset elements as sorted tuples: (s, a, b, c, d)"""
    lanes_elem = road_elem.find('lanes')
    if lanes_elem is None:
        return []
    offsets = []
    for lo in lanes_elem.findall('laneOffset'):
        s = float(lo.get('s', 0.0))
        a = float(lo.get('a', 0.0))
        b = float(lo.get('b', 0.0))
        c = float(lo.get('c', 0.0))
        d = float(lo.get('d', 0.0))
        offsets.append((s, a, b, c, d))
    return sorted(offsets, key=lambda x: x[0])

def _eval_lane_offset(offsets: list[tuple], s_query: float) -> float:
    """Evaluate the active laneOffset polynomial at s_query."""
    if not offsets:
        return 0.0
    active = offsets[0]
    for lo in offsets:
        if s_query >= lo[0]:
            active = lo
        else:
            break
    s0, a, b, c, d = active
    ds = s_query - s0
    return a + b*ds + c*(ds**2) + d*(ds**3)

# ── Geometry sampling ──────────────────────────────────────────────────────────

def _sample_geometry(
    road_elem: ET.Element,
    interval: float = 4.0,
    extra_s: list[float] | None = None,
) -> list[tuple]:
    """
    Sample world positions along road planView at `interval` metres.
    Returns list of (xodr_x, xodr_y, hdg_rad, s) in OpenDRIVE coordinates.
    """
    plan_view = road_elem.find('planView')
    if plan_view is None:
        return []

    geom_segs: list[tuple] = []
    for geom in plan_view.findall('geometry'):
        s0  = float(geom.get('s', 0))
        x0  = float(geom.get('x', 0))
        y0  = float(geom.get('y', 0))
        hdg = float(geom.get('hdg', 0))
        ln  = float(geom.get('length', 0))
        arc = geom.find('arc')
        curv = float(arc.get('curvature', 0)) if arc is not None else 0.0
        geom_segs.append((s0, x0, y0, hdg, ln, curv))

    def _eval(s_query: float) -> tuple | None:
        if s_query < 1e-6:
            s_query = 0.0
        for i, (s0, x0, y0, hdg, ln, curv) in enumerate(geom_segs):
            if s0 - 1e-5 <= s_query <= (s0 + ln + 1e-5) or i == len(geom_segs) - 1:
                ds = max(0.0, min(s_query - s0, ln))
                if curv != 0.0:
                    r     = 1.0 / curv
                    angle = ds * curv
                    px = x0 + r * (math.sin(hdg + angle) - math.sin(hdg))
                    py = y0 + r * (-math.cos(hdg + angle) + math.cos(hdg))
                    ph = hdg + angle
                else:
                    px = x0 + ds * math.cos(hdg)
                    py = y0 + ds * math.sin(hdg)
                    ph = hdg
                return (px, py, ph, s_query)
        return None

    s_vals: list[float] = []
    for s0, x0, y0, hdg, ln, curv in geom_segs:
        s = 0.0
        while s < ln:
            s_vals.append(s0 + s)
            s += interval
        if ln > 0.0:
            s_vals.append(s0 + ln)

    if extra_s:
        s_vals.extend(extra_s)

    s_vals.sort()
    deduped: list[float] = []
    for sv in s_vals:
        if not deduped or sv - deduped[-1] > 1e-4:
            deduped.append(sv)

    samples = [pt for sv in deduped if (pt := _eval(sv)) is not None]
    return samples

# ── Lane Width Polynomial Engine ────────────────────────────────────────────────

def _get_lane_defs_from_section(ls_elem: ET.Element) -> list[dict]:
    """Extract all lane structural entries to build an unbroken width chain."""
    result = []
    for side_name, side_key in [('left', 'L'), ('right', 'R')]:
        se = ls_elem.find(side_name)
        if se is None:
            continue
        lanes_sorted = sorted(
            se.findall('lane'),
            key=lambda l: abs(int(l.get('id', 0)))
        )
        
        for lane in lanes_sorted:
            try:
                lid = int(lane.get('id', 0))
            except ValueError:
                continue
            ltype  = lane.get('type', 'none')
                
            width_polys = []
            for w_elem in lane.findall('width'):
                width_polys.append({
                    'sOffset': float(w_elem.get('sOffset', 0.0)),
                    'a': float(w_elem.get('a', 3.5)),
                    'b': float(w_elem.get('b', 0.0)),
                    'c': float(w_elem.get('c', 0.0)),
                    'd': float(w_elem.get('d', 0.0))
                })
            width_polys.sort(key=lambda x: x['sOffset'])
            
            if not width_polys:
                width_polys.append({'sOffset': 0.0, 'a': 3.5, 'b': 0.0, 'c': 0.0, 'd': 0.0})

            result.append({
                'id': lid,
                'type': ltype,
                'side': side_key,
                'width_polys': width_polys
            })
    return result


def _eval_lane_width(polys: list[dict], sec_s_query: float) -> float:
    """Evaluate lane width polynomial relative to the section's start coordinate."""
    if not polys:
        return 3.5
    active = polys[0]
    for p in polys:
        if sec_s_query >= p['sOffset']:
            active = p
        else:
            break
    ds = sec_s_query - active['sOffset']
    return max(0.0, active['a'] + active['b']*ds + active['c']*(ds**2) + active['d']*(ds**3))


def _get_lane_sections(road_elem: ET.Element) -> list[tuple]:
    lanes_elem = road_elem.find('lanes')
    if lanes_elem is None:
        return []
    road_length = float(road_elem.get('length', 0))
    ls_elems = lanes_elem.findall('laneSection')
    if not ls_elems:
        return []

    result = []
    for i, ls in enumerate(ls_elems):
        s_start = float(ls.get('s', 0))
        s_end = (
            float(ls_elems[i + 1].get('s', road_length))
            if i + 1 < len(ls_elems)
            else road_length
        )
        lane_defs = _get_lane_defs_from_section(ls)
        result.append((s_start, s_end, lane_defs))
    return result


# ── Dynamic Polygon Builder ────────────────────────────────────────────────────

def _build_lane_polygon_dynamic(
    samples: list[tuple],
    target_ld: dict,
    all_lane_defs: list[dict],
    sec_start_s: float,
    offsets: list[tuple]
) -> list[list[float]]:
    """Build a perfect closed ribbon polygon by tracking cumulative widths dynamically at every s."""
    sign = +1.0 if target_ld['side'] == 'L' else -1.0
    fwd_inner: list[list[float]] = []
    fwd_outer: list[list[float]] = []

    side_lanes = [l for l in all_lane_defs if l['side'] == target_ld['side']]

    for (px, py, ph, s) in samples:
        sec_s = s - sec_start_s
        offset_shift = _eval_lane_offset(offsets, s)
        
        ref_perp = ph + math.pi / 2.0
        shifted_x = px + offset_shift * math.cos(ref_perp)
        shifted_y = py + offset_shift * math.sin(ref_perp)

        inner_w = 0.0
        outer_w = 0.0
        for ld in side_lanes:
            w_val = _eval_lane_width(ld['width_polys'], sec_s)
            if abs(ld['id']) < abs(target_ld['id']):
                inner_w += w_val
            if abs(ld['id']) <= abs(target_ld['id']):
                outer_w += w_val

        lane_perp = ph + sign * math.pi / 2.0
        ix = round(shifted_x + inner_w * math.cos(lane_perp), 2)
        iy = round(-(shifted_y + inner_w * math.sin(lane_perp)), 2)
        ox = round(shifted_x + outer_w * math.cos(lane_perp), 2)
        oy = round(-(shifted_y + outer_w * math.sin(lane_perp)), 2)

        fwd_inner.append([ix, iy])
        fwd_outer.append([ox, oy])

    return fwd_inner + list(reversed(fwd_outer))


# ── Traffic lights & crosswalks from xodr ─────────────────────────────────────

def _eval_geometry_at_s(road_elem: ET.Element, s_query: float):
    pv = road_elem.find('planView')
    if pv is None:
        return None
    geoms = pv.findall('geometry')
    for i, g in enumerate(geoms):
        s0     = float(g.get('s', 0))
        length = float(g.get('length', 0))
        if s0 - 1e-5 <= s_query <= (s0 + length + 1e-5) or i == len(geoms) - 1:
            x0  = float(g.get('x', 0))
            y0  = float(g.get('y', 0))
            hdg = float(g.get('hdg', 0))
            ds  = max(0.0, min(s_query - s0, length))
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
            wx = px - t * math.sin(ph)
            wy = py + t * math.cos(ph)
            results.append({'x': round(wx, 1), 'y': round(-wy, 1)})
    return results


def _extract_crosswalk_objects(root: ET.Element) -> list[dict]:
    results = []
    for road in root.findall('road'):
        objects_elem = road.find('objects')
        if objects_elem is None:
            continue

        for obj in objects_elem.findall('object'):
            obj_type = (obj.get('type') or '').lower()
            obj_name = (obj.get('name') or '').lower()
            if obj_type != 'crosswalk' and 'crosswalk' not in obj_name:
                continue

            s = float(obj.get('s', 0.0))
            t = float(obj.get('t', 0.0))
            obj_hdg = float(obj.get('hdg', 0.0))
            width = float(obj.get('width', 3.0))
            length = float(obj.get('length', 12.0))
            res = _eval_geometry_at_s(road, s)
            if res is None or width <= 0.0 or length <= 0.0:
                continue

            px, py, ph = res
            wx = px - t * math.sin(ph)
            wy = py + t * math.cos(ph)

            # OpenDRIVE object length is along its local x-axis. For CARLA
            # crosswalk objects, that x-axis usually spans across the road;
            # the local y-axis is the stripe's along-road direction.
            road_forward = ph + obj_hdg + math.pi / 2.0
            heading_deg = round(math.degrees(-road_forward) % 360.0, 1)
            results.append({
                'x': round(wx, 2),
                'y': round(-wy, 2),
                'heading': heading_deg,
                'width': round(width, 2),
                'length': round(length, 2),
                'source': 'object',
            })

    return results


def _extract_heuristic_crosswalks(root: ET.Element) -> list[dict]:
    results = []
    for road in root.findall('road'):
        if road.get('junction', '-1') != '-1':
            continue
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
            heading_deg = round(math.degrees(-ph) % 360, 1)
            results.append({
                'x':       round(px, 1),
                'y':       round(-py, 1),
                'heading': heading_deg,
                'width':    3.0,
                'length':   12.0,
                'source':   'heuristic',
            })
    return results


def _extract_crosswalks(root: ET.Element) -> list[dict]:
    object_crosswalks = _extract_crosswalk_objects(root)
    if object_crosswalks:
        return object_crosswalks
    return _extract_heuristic_crosswalks(root)


def _carla_yaw_from_xodr_heading(heading_rad: float, lane_id: int) -> float:
    yaw = math.degrees(-heading_rad) % 360.0
    if lane_id > 0:
        yaw = (yaw + 180.0) % 360.0
    return round(yaw, 1)


def _build_spawn_points_from_render_geometry(root: ET.Element) -> list[dict]:
    """
    Generate spawn points from the same lane-center geometry used for SVG rendering.
    This keeps spawn dots aligned with rendered lane polygons, including laneOffset.
    """
    spawn_points: list[dict] = []

    for road in root.findall('road'):
        length = float(road.get('length', 0))
        if length < MIN_SPAWN_ROAD_LENGTH_M:
            continue
        if road.get('junction', '-1') != '-1':
            continue

        lane_sections = _get_lane_sections(road)
        if not lane_sections:
            continue

        offsets = _get_lane_offsets(road)
        boundary_s = [s_start for (s_start, _s_end, _ld) in lane_sections if s_start > 0.0]
        samples = _sample_geometry(road, SPAWN_SAMPLE_INTERVAL_M, extra_s=boundary_s)
        if not samples:
            continue

        for sec_idx, (s_start, s_end, lane_defs) in enumerate(lane_sections):
            if not lane_defs:
                continue

            is_last_section = sec_idx == len(lane_sections) - 1
            sec_samples = [
                sp for sp in samples
                if s_start - 1e-4 <= sp[3] <= s_end + 1e-4
                and (is_last_section or sp[3] < s_end - 1e-4)
            ]
            if not sec_samples:
                continue

            for ld in lane_defs:
                if ld['type'] not in ('driving', 'bidirectional'):
                    continue

                sign = +1.0 if ld['side'] == 'L' else -1.0
                side_lanes = [l for l in lane_defs if l['side'] == ld['side']]

                for (px, py, ph, s) in sec_samples:
                    sec_s = s - s_start
                    offset_shift = _eval_lane_offset(offsets, s)
                    ref_perp = ph + math.pi / 2.0
                    shifted_x = px + offset_shift * math.cos(ref_perp)
                    shifted_y = py + offset_shift * math.sin(ref_perp)

                    inner_w = 0.0
                    this_w = 3.5
                    for lane in side_lanes:
                        w_val = _eval_lane_width(lane['width_polys'], sec_s)
                        if abs(lane['id']) < abs(ld['id']):
                            inner_w += w_val
                        if lane['id'] == ld['id']:
                            this_w = w_val

                    center_offset = inner_w + (this_w / 2.0)
                    lane_perp = ph + sign * math.pi / 2.0
                    x = shifted_x + center_offset * math.cos(lane_perp)
                    y = shifted_y + center_offset * math.sin(lane_perp)
                    spawn_points.append({
                        'x': round(x, 3),
                        'y': round(-y, 3),
                        'yaw': _carla_yaw_from_xodr_heading(ph, ld['id']),
                    })

    return spawn_points


def _load_spawn_points(xodr_path: str) -> tuple[list[dict], list[dict]]:
    spawn_points = []
    try:
        root = ET.parse(xodr_path).getroot()
        spawn_points = _build_spawn_points_from_render_geometry(root)
    except Exception:
        spawn_points = []

    sys.path.insert(0, str(_LLMGEN))
    try:
        from preprocessing.map_parser import parse_xodr
        summary = parse_xodr(xodr_path)
    except Exception:
        return spawn_points, []

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


# ── Helper parsing engine (internal implementation sharing) ───────────────────

def _process_root_to_render_data(root: ET.Element, town_name: str, xodr_path: Path, interval: float) -> dict:
    header = root.find('header')
    w = float(header.get('west',   -500)) if header is not None else -500
    e = float(header.get('east',    500)) if header is not None else  500
    s = float(header.get('south', -500)) if header is not None else -500
    n = float(header.get('north',   500)) if header is not None else  500

    bounds = {
        'xMin': round(w, 2),
        'xMax': round(e, 2),
        'yMin': round(-n, 2),
        'yMax': round(-s, 2),
    }

    roads_out = []
    for road in root.findall('road'):
        length = float(road.get('length', 0))
        if length <= 0.0:
            continue

        lane_sections = _get_lane_sections(road)
        if not lane_sections:
            continue

        offsets = _get_lane_offsets(road)
        is_junction = road.get('junction', '-1') != '-1'

        road_interval = 1.0 if (is_junction or len(offsets) > 0) else interval

        boundary_s = [s_start for (s_start, _s_end, _ld) in lane_sections if s_start > 0.0]
        for lo in offsets:
            if lo[0] > 0.0 and lo[0] not in boundary_s:
                boundary_s.append(lo[0])
        boundary_s.append(length)

        samples = _sample_geometry(road, road_interval, extra_s=boundary_s)
        if not samples:
            continue

        lanes_out = []
        for s_start, s_end, lane_defs in lane_sections:
            if not lane_defs:
                continue

            sec_samples = [sp for sp in samples if s_start - 1e-4 <= sp[3] <= s_end + 1e-4]
            if not sec_samples:
                continue

            for ld in lane_defs:
                if ld['type'] == 'none':
                    continue

                poly  = _build_lane_polygon_dynamic(sec_samples, ld, lane_defs, s_start, offsets)
                color = LANE_COLORS.get(ld['type'], DEFAULT_LANE_COLOR)

                lane_entry = {
                    'laneId': ld['id'],
                    'type':   ld['type'],
                    'color':  color,
                    'polygon': poly,
                }

                if ld['type'] in ('driving', 'bidirectional'):
                    sign = +1.0 if ld['side'] == 'L' else -1.0
                    lane_cl = []
                    side_lanes = [l for l in lane_defs if l['side'] == ld['side']]
                    
                    for (px, py, ph, s) in sec_samples:
                        sec_s = s - s_start
                        offset_shift = _eval_lane_offset(offsets, s)
                        ref_perp = ph + math.pi / 2.0
                        shifted_x = px + offset_shift * math.cos(ref_perp)
                        shifted_y = py + offset_shift * math.sin(ref_perp)

                        inner_w = 0.0
                        this_w = 3.5
                        for l_item in side_lanes:
                            w_val = _eval_lane_width(l_item['width_polys'], sec_s)
                            if abs(l_item['id']) < abs(ld['id']):
                                inner_w += w_val
                            if l_item['id'] == ld['id']:
                                this_w = w_val

                        center_offset = inner_w + (this_w / 2.0)
                        lane_perp = ph + sign * math.pi / 2.0
                        cx = round(shifted_x + center_offset * math.cos(lane_perp), 2)
                        cy = round(-(shifted_y + center_offset * math.sin(lane_perp)), 2)
                        lane_cl.append([cx, cy])
                        
                    if ld['side'] == 'L':
                        lane_cl.reverse()
                    lane_entry['directionLine'] = lane_cl

                lanes_out.append(lane_entry)

        if not lanes_out:
            continue

        centreline = []
        for (px, py, ph, s) in samples:
            offset_shift = _eval_lane_offset(offsets, s)
            ref_perp = ph + math.pi / 2.0
            cx = round(px + offset_shift * math.cos(ref_perp), 2)
            cy = round(-(py + offset_shift * math.sin(ref_perp)), 2)
            centreline.append([cx, cy])

        roads_out.append({
            'id':         road.get('id'),
            'junction':   road.get('junction', '-1'),
            'length':     round(length, 1),
            'lanes':      lanes_out,
            'centerline': centreline,
        })

    spawn_points, intersections = _load_spawn_points(str(xodr_path))
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


# ── Public API ─────────────────────────────────────────────────────────────────

def build_map_render_data(town_name: str, interval: float = 4.0) -> dict:
    xodr_path = XODR_PATHS.get(town_name) or _scan_xodr_paths(_MAPS_DIR).get(town_name)
    if xodr_path is None or not xodr_path.exists():
        raise FileNotFoundError(f"No .xodr file found for town '{town_name}'")

    tree = ET.parse(str(xodr_path))
    return _process_root_to_render_data(tree.getroot(), town_name, xodr_path, interval)


def build_map_render_data_from_path(xodr_path: Path, town_name: str, interval: float = 4.0) -> dict:
    """
    Same as build_map_render_data but works from an arbitrary .xodr file path
    instead of the pre-registered XODR_PATHS dict. Used for user-uploaded maps.
    """
    if not xodr_path.exists():
        raise FileNotFoundError(f"File not found: {xodr_path}")

    tree = ET.parse(str(xodr_path))
    return _process_root_to_render_data(tree.getroot(), town_name, xodr_path, interval)


def list_available_towns() -> list[str]:
    """Return names of all towns discovered on disk (live scan)."""
    return sorted(_scan_xodr_paths(_MAPS_DIR).keys())
