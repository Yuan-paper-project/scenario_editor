"""Parse a CARLA OpenDRIVE (.xodr) file into the editor's render JSON.

The one Y flip happens here: OpenDRIVE (x, y) → CARLA (x, −y); z is not flipped.
"""

import xml.etree.ElementTree as ET
from pathlib import Path

from backend.xodr.spawn_points import _load_spawn_points
from backend.xodr.xodr_features import (
    _extract_crosswalks,
    _extract_signs,
    _extract_speed_signs,
    _extract_traffic_lights,
)
from backend.xodr.xodr_geometry import (
    _eval_elevation,
    _eval_lane_offset,
    _get_elevations,
    _get_lane_offsets,
    _lateral_point,
    _parse_geometry_segments,
    _sample_geometry,
    _section_eval_s,
)
from backend.xodr.xodr_lanes import (
    _build_lane_polygon_dynamic,
    _build_mark_polylines,
    _get_center_marks,
    _get_lane_sections,
    _get_road_link,
    _lane_centre,
)

# ── Map file paths ─────────────────────────────────────────────────────────────

_MAPS_DIR = Path(__file__).resolve().parents[2] / "maps"


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
            break  # take the first .xodr found per folder
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


XODR_PATHS: dict[str, Path] = _scan_xodr_paths(_MAPS_DIR)
THUMBNAIL_PATHS: dict[str, Path] = _scan_thumbnail_paths(_MAPS_DIR)

# ── Lane type colours ──────────────────────────────────────────────────────────

LANE_COLORS: dict[str, str] = {
    "driving": "#3d3d3d",  # dark asphalt
    "bidirectional": "#8f8a7e",  # Town03's only use: the highway separator wall
    "sidewalk": "#a89878",  # warm tan
    "shoulder": "#555555",
    "parking": "#34486a",  # blue tint, like a painted parking zone
    "biking": "#4a6a4a",
    # Not drivable: concrete-toned and hatched (mapRoadDetail.js), or Town03's tunnel median reads as a lane.
    "median": "#8f8a7e",  # raised concrete separator
    "border": "#6b6862",
    "restricted": "#6b6862",
    "curb": "#6b6862",
}
DEFAULT_LANE_COLOR = "#484848"
GRASS_COLOR = "#1e4a1e"  # deeper green for contrast

# ── Render data from a parsed .xodr ──────────────────────────────────────────


def _process_root_to_render_data(root: ET.Element, town_name: str, xodr_path: Path, interval: float) -> dict:
    header = root.find('header')
    w = float(header.get('west', -500)) if header is not None else -500
    e = float(header.get('east', 500)) if header is not None else 500
    s = float(header.get('south', -500)) if header is not None else -500
    n = float(header.get('north', 500)) if header is not None else 500

    bounds = {
        'xMin': round(w, 2),
        'xMax': round(e, 2),
        'yMin': round(-n, 2),
        'yMax': round(-s, 2),
    }

    roads_out = []
    elev_min = elev_max = None
    for road in root.findall('road'):
        length = float(road.get('length', 0))
        if length <= 0.0:
            continue

        lane_sections = _get_lane_sections(road)
        if not lane_sections:
            continue

        offsets = _get_lane_offsets(road)
        elevations = _get_elevations(road)
        is_junction = road.get('junction', '-1') != '-1'

        road_interval = 1.0 if (is_junction or len(offsets) > 0) else interval

        boundary_s = [s_start for (s_start, _s_end, _ld) in lane_sections if s_start > 0.0]
        for lo in offsets:
            if lo[0] > 0.0 and lo[0] not in boundary_s:
                boundary_s.append(lo[0])
        boundary_s.append(length)
        # Sample where a painted line changes type, so broken→solid leaves no gap.
        center_marks_by_section = [_get_center_marks(ls) for ls in road.find('lanes').findall('laneSection')]
        for (s_start, _s_end, lane_defs), cmarks in zip(lane_sections, center_marks_by_section):
            for m in cmarks + [m for ld in lane_defs for m in ld['marks']]:
                if m['sOffset'] > 0.0:
                    boundary_s.append(s_start + m['sOffset'])

        samples = _sample_geometry(road, road_interval, extra_s=boundary_s)
        if not samples:
            continue
        geom_segs = _parse_geometry_segments(road)
        road_marks: list[dict] = []

        lanes_out = []
        for section_id, (s_start, s_end, lane_defs) in enumerate(lane_sections):
            if not lane_defs:
                continue

            sec_samples = [sp for sp in samples if s_start - 1e-4 <= sp[3] <= s_end + 1e-4]
            if not sec_samples:
                continue
            road_marks.extend(
                _build_mark_polylines(
                    sec_samples, s_start, s_end, lane_defs, center_marks_by_section[section_id], offsets, geom_segs
                )
            )

            for ld in lane_defs:
                if ld['type'] == 'none':
                    continue

                poly = _build_lane_polygon_dynamic(sec_samples, ld, lane_defs, s_start, offsets, geom_segs)
                color = LANE_COLORS.get(ld['type'], DEFAULT_LANE_COLOR)
                # Connectors carry the kerb-side parking lane across junctions: paint it as carriageway.
                if is_junction and ld['type'] == 'parking':
                    color = LANE_COLORS['driving']

                lane_entry = {
                    'laneId': ld['id'],
                    'type': ld['type'],
                    'color': color,
                    'polygon': poly,
                    # Disambiguates a laneId recurring across sections; assumed to match CARLA's
                    # section_id (0-based in s order, cross-checked by probe_carla_lane_graph.py).
                    'sectionId': section_id,
                    'sStart': round(s_start, 2),
                    'sEnd': round(s_end, 2),
                }

                if ld['type'] in ('driving', 'bidirectional', 'parking', 'shoulder'):
                    sign = +1.0 if ld['side'] == 'L' else -1.0
                    lane_cl = []
                    lane_widths = []
                    side_lanes = [l for l in lane_defs if l['side'] == ld['side']]

                    for sample, s_eval in zip(sec_samples, _section_eval_s(sec_samples, s_start)):
                        cx, cy, cz, this_w = _lane_centre(
                            sample, s_eval, ld, side_lanes, s_start, offsets, elevations, geom_segs
                        )
                        # A trailing s: consumers destructure positionally and ignore it.
                        lane_cl.append([round(cx, 2), round(cy, 2), round(cz, 2), round(sample[3], 2)])
                        lane_widths.append(round(this_w, 2))

                    if ld['side'] == 'L':
                        lane_cl.reverse()
                        lane_widths.reverse()
                    lane_entry['directionLine'] = lane_cl
                    lane_entry['widths'] = lane_widths

                lanes_out.append(lane_entry)

        if not lanes_out:
            continue

        centreline = []
        for px, py, ph, s in samples:
            cz = _eval_elevation(elevations, s)
            elev_min = cz if elev_min is None else min(elev_min, cz)
            elev_max = cz if elev_max is None else max(elev_max, cz)
            # At a laneOffset step emit the left limit too, so the marking jogs instead of slanting.
            s_evals = [s]
            if s > 0.0 and abs(_eval_lane_offset(offsets, s - 1e-6) - _eval_lane_offset(offsets, s)) > 1e-3:
                s_evals = [s - 1e-6, s]
            for s_eval in s_evals:
                cx, cy = _lateral_point(px, py, ph, _eval_lane_offset(offsets, s_eval), 0.0)
                centreline.append([round(cx, 2), round(cy, 2), round(cz, 2), round(s, 2)])

        roads_out.append(
            {
                'id': road.get('id'),
                'junction': road.get('junction', '-1'),
                'length': round(length, 1),
                'lanes': lanes_out,
                'centerline': centreline,
                'link': _get_road_link(road),
                'marks': road_marks,
            }
        )

    spawn_points, intersections = _load_spawn_points(str(xodr_path))
    traffic_lights = _extract_traffic_lights(root, xodr_path)
    crosswalks = _extract_crosswalks(root)
    signs = _extract_signs(root)
    speed_signs = _extract_speed_signs(root)

    return {
        'town': town_name,
        'bounds': bounds,
        # Reference-line height range, for the startup log: a far-off-zero range suggests an
        # absolute datum (maps/Town10). Reported, never subtracted.
        'elevation': {'min': round(elev_min or 0.0, 2), 'max': round(elev_max or 0.0, 2)},
        'roads': roads_out,
        'spawnPoints': spawn_points,
        'intersections': intersections,
        'trafficLights': traffic_lights,
        'crosswalks': crosswalks,
        'signs': signs,
        'speedSigns': speed_signs,
        'grassColor': GRASS_COLOR,
    }


# ── Public API ─────────────────────────────────────────────────────────────────


def build_map_render_data(town_name: str, interval: float = 4.0) -> dict:
    xodr_path = XODR_PATHS.get(town_name) or _scan_xodr_paths(_MAPS_DIR).get(town_name)
    if xodr_path is None or not xodr_path.exists():
        raise FileNotFoundError(f"No .xodr file found for town '{town_name}'")

    tree = ET.parse(str(xodr_path))
    return _process_root_to_render_data(tree.getroot(), town_name, xodr_path, interval)


def build_map_render_data_from_path(xodr_path: Path, town_name: str, interval: float = 4.0) -> dict:
    """build_map_render_data for an arbitrary .xodr path (uploaded maps)."""
    if not xodr_path.exists():
        raise FileNotFoundError(f"File not found: {xodr_path}")

    tree = ET.parse(str(xodr_path))
    return _process_root_to_render_data(tree.getroot(), town_name, xodr_path, interval)


def list_available_towns() -> list[str]:
    """Return names of all towns discovered on disk (live scan)."""
    return sorted(_scan_xodr_paths(_MAPS_DIR).keys())
