"""
map_renderer.py — Parse a CARLA OpenDRIVE (.xodr) file into road polygon data for SVG rendering.

Coordinate convention:
  OpenDRIVE (x, y)  →  CARLA / SVG  (cx = x,  cy = -y)   [Y-axis flip]
  SVG viewBox is set to CARLA bounds directly — no further transform needed.
  Z is NOT flipped — OpenDRIVE and CARLA are both Z-up.
"""

import json
import math
import re
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
    "bidirectional": "#8f8a7e",      # Town03's only use: the highway separator wall
    "sidewalk":      "#a89878",      # warm tan
    "shoulder":      "#555555",
    "parking":       "#34486a",      # blue tint, like a painted parking zone
    "biking":        "#4a6a4a",
    # Not drivable: drawn concrete/kerb-toned and hatched by mapView.js rather
    # than in asphalt, or Town03's tunnel median reads as a lane.
    "median":        "#8f8a7e",      # raised concrete separator
    "border":        "#6b6862",
    "restricted":    "#6b6862",
    "curb":          "#6b6862",
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

# ── Elevation Profile Parser ───────────────────────────────────────────────────
#
# Road-surface height, the source of every z the editor writes. Same cubic and
# the same `ds = s - record.s` convention as laneOffset above — deliberately NOT
# like <width>, whose sOffset is relative to the laneSection start.
#
# z depends only on (road, s): across every bundled map there are no <shape>
# elements and every <superelevation> has a=0 (CARLA's exporter emits the tag but
# never banks a road), so the surface height at any lateral offset t equals
# elev(s) at the reference line. If that ever stops holding, this is where the
# cross-slope term belongs.

def _get_elevations(road_elem: ET.Element) -> list[tuple]:
    """Extract all elevation elements as sorted tuples: (s, a, b, c, d)"""
    profile = road_elem.find('elevationProfile')
    if profile is None:
        return []
    elevations = []
    for el in profile.findall('elevation'):
        s = float(el.get('s', 0.0))
        a = float(el.get('a', 0.0))
        b = float(el.get('b', 0.0))
        c = float(el.get('c', 0.0))
        d = float(el.get('d', 0.0))
        elevations.append((s, a, b, c, d))
    return sorted(elevations, key=lambda x: x[0])

def _eval_elevation(elevations: list[tuple], s_query: float) -> float:
    """Evaluate the active elevation polynomial at s_query."""
    if not elevations:
        return 0.0
    active = elevations[0]
    for el in elevations:
        if s_query >= el[0]:
            active = el
        else:
            break
    s0, a, b, c, d = active
    ds = s_query - s0
    return a + b*ds + c*(ds**2) + d*(ds**3)

# ── Geometry sampling ──────────────────────────────────────────────────────────

def _parse_geometry_segments(road_elem: ET.Element) -> list[tuple]:
    """planView <geometry> records as (s0, x0, y0, hdg, length, curvature).

    Only <line> and <arc> are modelled — every bundled town uses nothing else.
    Anything else is treated as a line, as it always was.
    """
    plan_view = road_elem.find('planView')
    if plan_view is None:
        return []
    segs: list[tuple] = []
    for geom in plan_view.findall('geometry'):
        arc = geom.find('arc')
        segs.append((
            float(geom.get('s', 0)),
            float(geom.get('x', 0)),
            float(geom.get('y', 0)),
            float(geom.get('hdg', 0)),
            float(geom.get('length', 0)),
            float(arc.get('curvature', 0)) if arc is not None else 0.0,
        ))
    return segs


def _curvature_at(geom_segs: list[tuple], s_query: float) -> float:
    """Reference-line curvature at s (the earlier segment wins at a boundary,
    matching _sample_geometry's own segment choice)."""
    for i, (s0, _x, _y, _h, ln, curv) in enumerate(geom_segs):
        if s0 - 1e-5 <= s_query <= s0 + ln + 1e-5 or i == len(geom_segs) - 1:
            return curv
    return 0.0


# Angular step for arc sampling (rad). At the old flat 4 m a 6 m-radius bend was
# two or three visible facets; this keeps every bend ~6° per vertex.
ARC_SAMPLE_ANGLE_RAD = 0.1
ARC_SAMPLE_MIN_M     = 0.25


def _sample_geometry(
    road_elem: ET.Element,
    interval: float = 4.0,
    extra_s: list[float] | None = None,
) -> list[tuple]:
    """
    Sample world positions along road planView at `interval` metres (finer on
    tight arcs — see ARC_SAMPLE_ANGLE_RAD).
    Returns list of (xodr_x, xodr_y, hdg_rad, s) in OpenDRIVE coordinates.
    """
    geom_segs = _parse_geometry_segments(road_elem)
    if not geom_segs:
        return []

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
        step = interval
        if curv != 0.0:
            step = min(interval, max(ARC_SAMPLE_MIN_M, ARC_SAMPLE_ANGLE_RAD / abs(curv)))
        s = 0.0
        while s < ln:
            s_vals.append(s0 + s)
            s += step
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


def _section_eval_s(sec_samples: list[tuple]) -> list[float]:
    """The s at which to evaluate laneOffset and lane widths for each sample of
    one lane section: its own s, except the section's LAST sample, which takes
    the left limit (s_end − ε).

    CARLA maps step the laneOffset at a lane-section boundary to make up for a
    lane that starts or ends there (Town03 road 1566: −6.635 → −0.635 at s=2).
    _eval_lane_offset(s_end) picks the record that STARTS at s_end, i.e. the
    next section's, which threw section N's last vertex sideways by up to 6 m —
    the spikes and long wedges at road joins. The next section's first sample
    keeps s_start and correctly picks the new record up.
    """
    out = [sp[3] for sp in sec_samples]
    if len(out) > 1:
        out[-1] -= 1e-6
    return out


def _lateral_point(px: float, py: float, ph: float, d: float, curv: float) -> tuple[float, float]:
    """Point at signed lateral distance d (left of travel positive) from the
    reference line, returned in CARLA frame (x, −y).

    On the concave side of an arc a lateral distance beyond the radius crosses
    the arc centre and the offset curve folds back on itself (Town02 road 2:
    7.5 m radius, sidewalk outer edge at 8.3 m) — the bow-tie corners at
    junctions. d is clamped just short of the centre, so a folded edge collapses
    into a corner point instead.
    """
    if curv > 0.0:
        d = min(d, 0.999 / curv)
    elif curv < 0.0:
        d = max(d, -0.999 / -curv)
    perp = ph + math.pi / 2.0
    return px + d * math.cos(perp), -(py + d * math.sin(perp))


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
                'width_polys': width_polys,
                'marks': _get_road_marks(lane),
            })
    return result


# roadMark types drawn as lines; everything else ('none', 'curb', 'grass',
# 'botts dots', …) is either nothing or already visible as a lane edge.
_DRAWN_MARK_TOKENS = {'solid', 'broken'}
MARK_DOUBLE_GAP_M = 0.12   # half the spacing between the two lines of a double mark


def _get_road_marks(lane_elem: ET.Element) -> list[dict]:
    """<roadMark> records of one lane, sorted by sOffset (section-relative).

    Per OpenDRIVE a lane's roadMark describes its OUTER border; the centre
    lane's describes the reference line. A record holds until the next one.
    """
    marks = []
    for rm in lane_elem.findall('roadMark'):
        color = (rm.get('color') or 'standard').lower()
        marks.append({
            'sOffset': float(rm.get('sOffset', 0.0)),
            'type': (rm.get('type') or 'none').lower(),
            'color': 'yellow' if color == 'yellow' else 'white',
            'width': float(rm.get('width', 0.15) or 0.15),
        })
    marks.sort(key=lambda m: m['sOffset'])
    return marks


def _get_center_marks(ls_elem: ET.Element) -> list[dict]:
    lane = ls_elem.find('center/lane')
    return _get_road_marks(lane) if lane is not None else []


def _mark_lines(mark_type: str) -> list[tuple[str, float]]:
    """('solid'|'broken', lateral shift) per drawn line of a roadMark type.

    A double mark's first token is the line on the LEFT (in s direction, i.e.
    +d), which is how 'broken solid' tells a driver which side may cross.
    """
    tokens = mark_type.split()
    if len(tokens) == 1:
        return [(tokens[0], 0.0)] if tokens[0] in _DRAWN_MARK_TOKENS else []
    if len(tokens) == 2:
        return [(tok, shift) for tok, shift in zip(tokens, (MARK_DOUBLE_GAP_M, -MARK_DOUBLE_GAP_M))
                if tok in _DRAWN_MARK_TOKENS]
    return []


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


def _get_road_link(road_elem: ET.Element) -> dict:
    """<road><link><predecessor/successor elementType elementId contactPoint>.

    Road-level connectivity — which road (or junction) this one continues
    into at s=0 and s=length. Needed by the frontend lane graph (phase 2) to
    tell a genuine fork from a road that simply continues; map_renderer never
    read <link> before this (the crosswalk heuristic looks at it and discards
    it again). contactPoint is absent for a junction link — junctions don't
    have a notion of start/end, only member roads and lanes do.
    """
    link_elem = road_elem.find('link')
    if link_elem is None:
        return {'predecessor': None, 'successor': None}

    def _side(tag):
        el = link_elem.find(tag)
        if el is None:
            return None
        return {
            'elementType': el.get('elementType', 'road'),
            'elementId': el.get('elementId'),
            'contactPoint': el.get('contactPoint'),
        }

    return {'predecessor': _side('predecessor'), 'successor': _side('successor')}


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
    offsets: list[tuple],
    geom_segs: list[tuple] | None = None,
) -> list[list[float]]:
    """Build a perfect closed ribbon polygon by tracking cumulative widths dynamically at every s."""
    sign = +1.0 if target_ld['side'] == 'L' else -1.0
    fwd_inner: list[list[float]] = []
    fwd_outer: list[list[float]] = []

    side_lanes = [l for l in all_lane_defs if l['side'] == target_ld['side']]

    for (px, py, ph, s), s_eval in zip(samples, _section_eval_s(samples)):
        sec_s = s_eval - sec_start_s
        offset_shift = _eval_lane_offset(offsets, s_eval)
        curv = _curvature_at(geom_segs, s) if geom_segs else 0.0

        inner_w = 0.0
        outer_w = 0.0
        for ld in side_lanes:
            w_val = _eval_lane_width(ld['width_polys'], sec_s)
            if abs(ld['id']) < abs(target_ld['id']):
                inner_w += w_val
            if abs(ld['id']) <= abs(target_ld['id']):
                outer_w += w_val

        ix, iy = _lateral_point(px, py, ph, offset_shift + sign * inner_w, curv)
        ox, oy = _lateral_point(px, py, ph, offset_shift + sign * outer_w, curv)
        fwd_inner.append([round(ix, 2), round(iy, 2)])
        fwd_outer.append([round(ox, 2), round(oy, 2)])

    return fwd_inner + list(reversed(fwd_outer))


def _build_mark_polylines(
    sec_samples: list[tuple],
    s_start: float,
    s_end: float,
    lane_defs: list[dict],
    center_marks: list[dict],
    offsets: list[tuple],
    geom_segs: list[tuple],
) -> list[dict]:
    """Painted line polylines of one lane section, from its <roadMark>s.

    Each lane's marks sit on its outer border, the centre lane's on the
    reference line (+ laneOffset). Same lateral maths as the lane polygons —
    left-limit at the range end (_section_eval_s) and the fold clamp
    (_lateral_point) — so a line never drifts off the edge it belongs to.
    """
    # (marks, function: (s_eval, widths-by-id) -> signed lateral distance)
    borders = [(center_marks, None)]
    for ld in lane_defs:
        if ld['marks']:
            borders.append((ld['marks'], ld))

    out = []
    for marks, ld in borders:
        if ld is not None:
            sign = +1.0 if ld['side'] == 'L' else -1.0
            inner_ids = [l for l in lane_defs
                         if l['side'] == ld['side'] and abs(l['id']) <= abs(ld['id'])]
        for i, mark in enumerate(marks):
            lines = _mark_lines(mark['type'])
            if not lines:
                continue
            r0 = s_start + mark['sOffset']
            r1 = s_start + marks[i + 1]['sOffset'] if i + 1 < len(marks) else s_end
            r1 = min(r1, s_end)
            if r1 - r0 < 0.05:
                continue
            pts = [sp for sp in sec_samples if r0 - 1e-4 <= sp[3] <= r1 + 1e-4]
            if len(pts) < 2:
                continue
            dists = []
            for (px, py, ph, s), s_eval in zip(pts, _section_eval_s(pts)):
                d = _eval_lane_offset(offsets, s_eval)
                if ld is not None:
                    d += sign * sum(_eval_lane_width(l['width_polys'], s_eval - s_start)
                                    for l in inner_ids)
                dists.append((px, py, ph, s, d))
            for tok, shift in lines:
                poly = []
                for (px, py, ph, s, d) in dists:
                    x, y = _lateral_point(px, py, ph, d + shift, _curvature_at(geom_segs, s))
                    poly.append([round(x, 2), round(y, 2)])
                out.append({
                    'type': tok,
                    'color': mark['color'],
                    'width': round(mark['width'], 2),
                    'points': poly,
                })
    return out


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


def _extract_traffic_lights(root: ET.Element, xodr_path: Path | None = None) -> list[dict]:
    """Dynamic signals, i.e. traffic lights, at their pole position.

    Each carries `signalId` (the .xodr id), `roads` — the junction connector
    roads whose `<signalReference>` names it, i.e. the lanes it governs (every
    connector in the bundled towns references at most one light) — and, when
    `maps/<town>/carla_traffic_lights.json` exists (tests/probe_carla_traffic_lights.py),
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
                light['inCarla'] = any(
                    math.hypot(c['x'] - light['x'], c['y'] - light['y']) < 2.0 for c in carla_lights)
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
            results.append({
                'type': kind,
                'x': round(px - t * math.sin(ph), 2),
                'y': round(-(py + t * math.cos(ph)), 2),
            })
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
            results.append({
                'kmh': int(m.group(1)),
                'x': round(px - t * math.sin(ph), 2),
                'y': round(-(py + t * math.cos(ph)), 2),
            })
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
                sp for sp in samples
                if s_start - 1e-4 <= sp[3] <= s_end + 1e-4
                and (is_last_section or sp[3] < s_end - 1e-4)
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
                        'z': round(_eval_elevation(elevations, s), 3),
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
        # Samples exactly where a painted line changes type, so broken→solid
        # does not leave a gap the length of a sample interval.
        center_marks_by_section = [_get_center_marks(ls)
                                   for ls in road.find('lanes').findall('laneSection')]
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
            road_marks.extend(_build_mark_polylines(
                sec_samples, s_start, s_end, lane_defs,
                center_marks_by_section[section_id], offsets, geom_segs))

            for ld in lane_defs:
                if ld['type'] == 'none':
                    continue

                poly  = _build_lane_polygon_dynamic(sec_samples, ld, lane_defs, s_start, offsets, geom_segs)
                color = LANE_COLORS.get(ld['type'], DEFAULT_LANE_COLOR)
                # Junction connectors carry the kerb-side parking lane across
                # the box (Town03: 25 roads, Town05: 8, Town07: 2). Nobody
                # parks in a junction, so paint it as carriageway, not blue.
                if is_junction and ld['type'] == 'parking':
                    color = LANE_COLORS['driving']

                lane_entry = {
                    'laneId': ld['id'],
                    'type':   ld['type'],
                    'color':  color,
                    'polygon': poly,
                    # Disambiguates a laneId that recurs across lane sections
                    # of the same road (road.lanes is otherwise flattened with
                    # no section marker) — assumes CARLA's waypoint.section_id
                    # numbers sections the same way, 0-based in s-order, which
                    # tests/probe_carla_lane_graph.py cross-checks.
                    'sectionId': section_id,
                    'sStart': round(s_start, 2),
                    'sEnd': round(s_end, 2),
                }

                if ld['type'] in ('driving', 'bidirectional', 'parking', 'shoulder'):
                    sign = +1.0 if ld['side'] == 'L' else -1.0
                    lane_cl = []
                    lane_widths = []
                    side_lanes = [l for l in lane_defs if l['side'] == ld['side']]

                    for (px, py, ph, s), s_eval in zip(sec_samples, _section_eval_s(sec_samples)):
                        sec_s = s_eval - s_start
                        offset_shift = _eval_lane_offset(offsets, s_eval)

                        inner_w = 0.0
                        this_w = 3.5
                        for l_item in side_lanes:
                            w_val = _eval_lane_width(l_item['width_polys'], sec_s)
                            if abs(l_item['id']) < abs(ld['id']):
                                inner_w += w_val
                            if l_item['id'] == ld['id']:
                                this_w = w_val

                        center_offset = inner_w + (this_w / 2.0)
                        cx, cy = _lateral_point(px, py, ph, offset_shift + sign * center_offset,
                                                _curvature_at(geom_segs, s))
                        cx, cy = round(cx, 2), round(cy, 2)
                        cz = round(_eval_elevation(elevations, s), 2)
                        # 4th element is s, the same backward-compatible trick
                        # already used for z — existing 3-element consumers
                        # destructure positionally and never see it.
                        lane_cl.append([cx, cy, cz, round(s, 2)])
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
        for (px, py, ph, s) in samples:
            cz = _eval_elevation(elevations, s)
            elev_min = cz if elev_min is None else min(elev_min, cz)
            elev_max = cz if elev_max is None else max(elev_max, cz)
            # At a laneOffset step (see _section_eval_s) emit the left limit as
            # well, so the marking jogs at the boundary instead of slanting
            # across the whole preceding sample interval.
            s_evals = [s]
            if s > 0.0 and abs(_eval_lane_offset(offsets, s - 1e-6) - _eval_lane_offset(offsets, s)) > 1e-3:
                s_evals = [s - 1e-6, s]
            for s_eval in s_evals:
                cx, cy = _lateral_point(px, py, ph, _eval_lane_offset(offsets, s_eval), 0.0)
                centreline.append([round(cx, 2), round(cy, 2), round(cz, 2), round(s, 2)])

        roads_out.append({
            'id':         road.get('id'),
            'junction':   road.get('junction', '-1'),
            'length':     round(length, 1),
            'lanes':      lanes_out,
            'centerline': centreline,
            'link':       _get_road_link(road),
            'marks':      road_marks,
        })

    spawn_points, intersections = _load_spawn_points(str(xodr_path))
    traffic_lights = _extract_traffic_lights(root, xodr_path)
    crosswalks     = _extract_crosswalks(root)
    signs          = _extract_signs(root)
    speed_signs    = _extract_speed_signs(root)

    return {
        'town':          town_name,
        'bounds':        bounds,
        # Reference-line height range, for the startup log and for spotting a map
        # whose elevations are an absolute geoid datum rather than metres above
        # ground (maps/Town10 is +50..+103 m). Reported, never subtracted: if
        # CARLA builds that map's mesh from this same .xodr the road really is up
        # there, and shifting it would reintroduce the bug this all fixes.
        'elevation':     {'min': round(elev_min or 0.0, 2), 'max': round(elev_max or 0.0, 2)},
        'roads':         roads_out,
        'spawnPoints':   spawn_points,
        'intersections': intersections,
        'trafficLights': traffic_lights,
        'crosswalks':    crosswalks,
        'signs':         signs,
        'speedSigns':    speed_signs,
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
