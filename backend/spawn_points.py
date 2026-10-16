"""
Spawn points along lane centres, and junction centres from llm-scenario-gen's parser.
"""

import math
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from backend.xodr_geometry import (
    _eval_elevation,
    _eval_lane_offset,
    _get_elevations,
    _get_lane_offsets,
    _sample_geometry,
)
from backend.xodr_lanes import _eval_lane_width, _get_lane_sections

_LLMGEN = Path(__file__).resolve().parent.parent.parent / "llm-scenario-gen"
if not _LLMGEN.exists():
    _LLMGEN = Path("/home/dellpro2/CC/llm-scenario-gen")
SPAWN_SAMPLE_INTERVAL_M = 25.0
MIN_SPAWN_ROAD_LENGTH_M = 20.0


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
        elevations = _get_elevations(road)
        boundary_s = [s_start for (s_start, _s_end, _ld) in lane_sections if s_start > 0.0]
        samples = _sample_geometry(road, SPAWN_SAMPLE_INTERVAL_M, extra_s=boundary_s)
        if not samples:
            continue

        for sec_idx, (s_start, s_end, lane_defs) in enumerate(lane_sections):
            if not lane_defs:
                continue

            is_last_section = sec_idx == len(lane_sections) - 1
            sec_samples = [
                sp
                for sp in samples
                if s_start - 1e-4 <= sp[3] <= s_end + 1e-4 and (is_last_section or sp[3] < s_end - 1e-4)
            ]
            if not sec_samples:
                continue

            for ld in lane_defs:
                # Driving only: CARLA spawns on Driving lanes, and Town03's
                # 'bidirectional' lanes are its ring-highway separator wall.
                if ld['type'] != 'driving':
                    continue

                sign = +1.0 if ld['side'] == 'L' else -1.0
                side_lanes = [l for l in lane_defs if l['side'] == ld['side']]

                for px, py, ph, s in sec_samples:
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
                    spawn_points.append(
                        {
                            'x': round(x, 3),
                            'y': round(-y, 3),
                            'z': round(_eval_elevation(elevations, s), 3),
                            'yaw': _carla_yaw_from_xodr_heading(ph, ld['id']),
                        }
                    )

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
        intersections.append(
            {
                'id': junc.get('junction_id', '?'),
                'cx': cx,
                'cy': cy,
            }
        )
    return spawn_points, intersections
