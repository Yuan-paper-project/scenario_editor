"""OpenDRIVE reference-line maths: planView sampling, laneOffset, elevation, lateral offsets.

Points come back in CARLA coordinates (y flipped).
"""

import math
import xml.etree.ElementTree as ET

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
    return a + b * ds + c * (ds**2) + d * (ds**3)


# ── Elevation Profile Parser ───────────────────────────────────────────────────
# The source of every z. Same cubic and `ds = s − record.s` as laneOffset — NOT like <width>,
# whose sOffset is section-relative. z depends only on (road, s): no bundled map has <shape>
# or a non-zero <superelevation>; a cross-slope term would go here.


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
    return a + b * ds + c * (ds**2) + d * (ds**3)


# ── Geometry sampling ──────────────────────────────────────────────────────────


def _parse_geometry_segments(road_elem: ET.Element) -> list[tuple]:
    """planView <geometry> as (s0, x0, y0, hdg, length, curvature); only line and arc (all the maps use)."""
    plan_view = road_elem.find('planView')
    if plan_view is None:
        return []
    segs: list[tuple] = []
    for geom in plan_view.findall('geometry'):
        arc = geom.find('arc')
        segs.append(
            (
                float(geom.get('s', 0)),
                float(geom.get('x', 0)),
                float(geom.get('y', 0)),
                float(geom.get('hdg', 0)),
                float(geom.get('length', 0)),
                float(arc.get('curvature', 0)) if arc is not None else 0.0,
            )
        )
    return segs


def _curvature_at(geom_segs: list[tuple], s_query: float) -> float:
    """Reference-line curvature at s (the earlier segment wins at a boundary, like _sample_geometry)."""
    for i, (s0, _x, _y, _h, ln, curv) in enumerate(geom_segs):
        if s0 - 1e-5 <= s_query <= s0 + ln + 1e-5 or i == len(geom_segs) - 1:
            return curv
    return 0.0


# Arc sampling step (rad): ~6° per vertex, so tight bends are not faceted.
ARC_SAMPLE_ANGLE_RAD = 0.1
ARC_SAMPLE_MIN_M = 0.25


def _sample_geometry(
    road_elem: ET.Element,
    interval: float = 4.0,
    extra_s: list[float] | None = None,
) -> list[tuple]:
    """Reference-line samples (xodr_x, xodr_y, hdg_rad, s) every `interval` m, finer on tight arcs."""
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
                    r = 1.0 / curv
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


def _section_eval_s(sec_samples: list[tuple], s_start: float) -> list[float]:
    """Per sample of a lane section, the s to read laneOffset and widths at.

    The last sample uses the left limit (s_end − ε): CARLA steps the laneOffset at a section
    boundary, and reading at s_end picks the next section's record (vertices thrown up to 6 m).
    Floored at `s_start`, because the sampler can emit s = 2.0 beside 2.000000000000057 and the
    first would read the previous record (Town06 road 1124: a 14 m jump).
    """
    out = [max(sp[3], s_start) for sp in sec_samples]
    if len(out) > 1:
        out[-1] -= 1e-6
    return out


def _lateral_point(px: float, py: float, ph: float, d: float, curv: float) -> tuple[float, float]:
    """Point at signed lateral distance d (left of travel positive), in CARLA frame.

    On the concave side d is clamped just short of the arc centre, so the offset curve cannot
    fold back on itself (Town02's bow-tie sidewalk corners).
    """
    if curv > 0.0:
        d = min(d, 0.999 / curv)
    elif curv < 0.0:
        d = max(d, -0.999 / -curv)
    perp = ph + math.pi / 2.0
    return px + d * math.cos(perp), -(py + d * math.sin(perp))


def _eval_geometry_at_s(road_elem: ET.Element, s_query: float):
    pv = road_elem.find('planView')
    if pv is None:
        return None
    geoms = pv.findall('geometry')
    for i, g in enumerate(geoms):
        s0 = float(g.get('s', 0))
        length = float(g.get('length', 0))
        if s0 - 1e-5 <= s_query <= (s0 + length + 1e-5) or i == len(geoms) - 1:
            x0 = float(g.get('x', 0))
            y0 = float(g.get('y', 0))
            hdg = float(g.get('hdg', 0))
            ds = max(0.0, min(s_query - s0, length))
            arc = g.find('arc')
            if arc is not None:
                curv = float(arc.get('curvature', 0))
                if curv != 0:
                    r = 1.0 / curv
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
