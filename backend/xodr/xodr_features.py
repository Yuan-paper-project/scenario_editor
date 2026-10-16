"""
Traffic lights, Stop/Yield and speed signs, and crosswalks read from an OpenDRIVE file.
"""

import json
import math
import re
import xml.etree.ElementTree as ET
from pathlib import Path

from backend.xodr.xodr_geometry import _eval_elevation, _eval_geometry_at_s, _get_elevations

# ── Traffic lights & crosswalks from xodr ─────────────────────────────────────


def _extract_traffic_lights(root: ET.Element, xodr_path: Path | None = None) -> list[dict]:
    """Dynamic signals, i.e. traffic lights, at their pole position.

    Each carries `signalId` (the .xodr id), `roads` — the junction connector
    roads whose `<signalReference>` names it, i.e. the lanes it governs (every
    connector in the bundled towns references at most one light) — and, when
    `maps/<town>/carla_traffic_lights.json` exists (tools/probes/probe_carla_traffic_lights.py),
    `inCarla`: whether the CARLA build has an actor within 2 m. A signal event
    on a light without one makes ScenarioRunner raise "Unknown traffic light"
    and abort the run (Town10HD's traffic_light_10/11).
    """
    governs: dict[str, list[str]] = {}
    for road in root.findall('road'):
        for ref in road.findall('.//signalReference'):
            governs.setdefault(ref.get('id'), []).append(road.get('id'))
    carla_lights = None
    if xodr_path is not None:
        probe = Path(xodr_path).parent / 'carla_traffic_lights.json'
        if probe.exists():
            try:
                carla_lights = json.loads(probe.read_text())
            except (OSError, ValueError):
                carla_lights = None

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
            editor_id = f"traffic_light_{len(results) + 1}"
            light = {
                'id': editor_id,
                'name': f"Traffic Light {len(results) + 1}",
                'x': round(wx, 1),
                'y': round(-wy, 1),
                # Road-surface height at the pole. A signal event's trigger is a
                # 3-D ReachPositionCondition around this point; the emitter used
                # to write z = 0, so on an elevated junction a short radius
                # could never be reached.
                'z': round(_eval_elevation(_get_elevations(road), s), 2),
                'signalId': sig.get('id'),
                'roads': sorted(set(governs.get(sig.get('id'), [])), key=str),
            }
            if carla_lights is not None:
                light['inCarla'] = any(math.hypot(c['x'] - light['x'], c['y'] - light['y']) < 2.0 for c in carla_lights)
            results.append(light)
    return results


def _extract_signs(root: ET.Element) -> list[dict]:
    """Static Stop (206) and Yield (205) signals — the German StVO codes CARLA
    exports, matched by name as well since `country` is 'OpenDRIVE'."""
    kinds = {'206': 'stop', '205': 'yield'}
    results = []
    for road in root.findall('road'):
        for sig in road.findall('.//signal'):
            if sig.get('dynamic', '') == 'yes':
                continue
            kind = kinds.get(sig.get('type', ''))
            name = (sig.get('name') or '').lower()
            if kind is None:
                kind = 'stop' if 'stop' in name else 'yield' if 'yield' in name else None
            if kind is None:
                continue
            s = float(sig.get('s', 0))
            t = float(sig.get('t', 0))
            res = _eval_geometry_at_s(road, s)
            if res is None:
                continue
            px, py, ph = res
            results.append(
                {
                    'type': kind,
                    'x': round(px - t * math.sin(ph), 2),
                    'y': round(-(py + t * math.cos(ph)), 2),
                }
            )
    return results


_SPEED_SIGN_RE = re.compile(r'^speed_(\d+)$', re.IGNORECASE)


def _extract_speed_signs(root: ET.Element) -> list[dict]:
    """Speed-limit SIGNS (`<object|signal name="Speed_90">`, km/h).

    These — not the per-road `<type><speed>` records — are what sets a CARLA
    vehicle's speed limit: CARLA spawns a SpeedLimit actor per sign, while
    MapBuilder::CreateRoadSpeed stores the road record's raw number with its
    unit discarded and uses it only to size Stop/Yield trigger boxes. The
    road records also say 55 mph on Town03's residential streets. Only
    Town01–05 carry signs; the other towns get none drawn.
    """
    results = []
    for road in root.findall('road'):
        for el in list(road.iterfind('objects/object')) + list(road.iterfind('.//signal')):
            m = _SPEED_SIGN_RE.match(el.get('name') or '')
            if not m:
                continue
            s = float(el.get('s', 0))
            t = float(el.get('t', 0))
            res = _eval_geometry_at_s(road, s)
            if res is None:
                continue
            px, py, ph = res
            results.append(
                {
                    'kmh': int(m.group(1)),
                    'x': round(px - t * math.sin(ph), 2),
                    'y': round(-(py + t * math.cos(ph)), 2),
                }
            )
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
            results.append(
                {
                    'x': round(wx, 2),
                    'y': round(-wy, 2),
                    'heading': heading_deg,
                    'width': round(width, 2),
                    'length': round(length, 2),
                    'source': 'object',
                }
            )

    return results


def _extract_heuristic_crosswalks(root: ET.Element) -> list[dict]:
    results = []
    for road in root.findall('road'):
        if road.get('junction', '-1') != '-1':
            continue
        has_sidewalk = any(lane.get('type') == 'sidewalk' for lane in road.findall('.//lane'))
        if not has_sidewalk:
            continue

        length = float(road.get('length', 0))
        link = road.find('link')
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
            results.append(
                {
                    'x': round(px, 1),
                    'y': round(-py, 1),
                    'heading': heading_deg,
                    'width': 3.0,
                    'length': 12.0,
                    'source': 'heuristic',
                }
            )
    return results


def _extract_crosswalks(root: ET.Element) -> list[dict]:
    object_crosswalks = _extract_crosswalk_objects(root)
    if object_crosswalks:
        return object_crosswalks
    return _extract_heuristic_crosswalks(root)
