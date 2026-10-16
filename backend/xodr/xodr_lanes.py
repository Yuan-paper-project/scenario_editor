"""Lane sections, widths and centres of an OpenDRIVE road, and the lane polygons and road-mark lines built from them."""

import xml.etree.ElementTree as ET

from backend.xodr.xodr_geometry import (
    _curvature_at,
    _eval_elevation,
    _eval_lane_offset,
    _get_elevations,
    _get_lane_offsets,
    _lateral_point,
    _parse_geometry_segments,
    _sample_geometry,
    _section_eval_s,
)

# ── Lane Width Polynomial Engine ────────────────────────────────────────────────


def _get_lane_defs_from_section(ls_elem: ET.Element) -> list[dict]:
    """Extract all lane structural entries to build an unbroken width chain."""
    result = []
    for side_name, side_key in [('left', 'L'), ('right', 'R')]:
        se = ls_elem.find(side_name)
        if se is None:
            continue
        lanes_sorted = sorted(se.findall('lane'), key=lambda l: abs(int(l.get('id', 0))))

        for lane in lanes_sorted:
            try:
                lid = int(lane.get('id', 0))
            except ValueError:
                continue
            ltype = lane.get('type', 'none')

            width_polys = []
            for w_elem in lane.findall('width'):
                width_polys.append(
                    {
                        'sOffset': float(w_elem.get('sOffset', 0.0)),
                        'a': float(w_elem.get('a', 3.5)),
                        'b': float(w_elem.get('b', 0.0)),
                        'c': float(w_elem.get('c', 0.0)),
                        'd': float(w_elem.get('d', 0.0)),
                    }
                )
            width_polys.sort(key=lambda x: x['sOffset'])

            if not width_polys:
                width_polys.append({'sOffset': 0.0, 'a': 3.5, 'b': 0.0, 'c': 0.0, 'd': 0.0})

            result.append(
                {
                    'id': lid,
                    'type': ltype,
                    'side': side_key,
                    'width_polys': width_polys,
                    'marks': _get_road_marks(lane),
                }
            )
    return result


# Drawn roadMark types; others are nothing or already visible as a lane edge.
_DRAWN_MARK_TOKENS = {'solid', 'broken'}
MARK_DOUBLE_GAP_M = 0.12  # half the spacing between the two lines of a double mark


def _get_road_marks(lane_elem: ET.Element) -> list[dict]:
    """<roadMark> records of one lane by sOffset; a lane's mark is its OUTER border (the centre lane's the reference line)."""
    marks = []
    for rm in lane_elem.findall('roadMark'):
        color = (rm.get('color') or 'standard').lower()
        marks.append(
            {
                'sOffset': float(rm.get('sOffset', 0.0)),
                'type': (rm.get('type') or 'none').lower(),
                'color': 'yellow' if color == 'yellow' else 'white',
                'width': float(rm.get('width', 0.15) or 0.15),
            }
        )
    marks.sort(key=lambda m: m['sOffset'])
    return marks


def _get_center_marks(ls_elem: ET.Element) -> list[dict]:
    lane = ls_elem.find('center/lane')
    return _get_road_marks(lane) if lane is not None else []


def _mark_lines(mark_type: str) -> list[tuple[str, float]]:
    """('solid'|'broken', lateral shift) per drawn line; a double mark's first token is the LEFT one."""
    tokens = mark_type.split()
    if len(tokens) == 1:
        return [(tokens[0], 0.0)] if tokens[0] in _DRAWN_MARK_TOKENS else []
    if len(tokens) == 2:
        return [
            (tok, shift)
            for tok, shift in zip(tokens, (MARK_DOUBLE_GAP_M, -MARK_DOUBLE_GAP_M))
            if tok in _DRAWN_MARK_TOKENS
        ]
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
    return max(0.0, active['a'] + active['b'] * ds + active['c'] * (ds**2) + active['d'] * (ds**3))


def _get_road_link(road_elem: ET.Element) -> dict:
    """<road><link>: the road or junction this one continues into at each end (no contactPoint for a junction)."""
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
        s_end = float(ls_elems[i + 1].get('s', road_length)) if i + 1 < len(ls_elems) else road_length
        lane_defs = _get_lane_defs_from_section(ls)
        result.append((s_start, s_end, lane_defs))
    return result


def _lane_centre(
    sample: tuple,
    s_eval: float,
    ld: dict,
    side_lanes: list[dict],
    s_start: float,
    offsets: list[tuple],
    elevations: list[tuple],
    geom_segs: list[tuple],
) -> tuple[float, float, float, float]:
    """Centre of lane `ld` at one sample, full precision: (x, y, z, width) in CARLA frame.

    `s_eval` is where laneOffset and widths are read (_section_eval_s); z uses the sample's s.
    """
    px, py, ph, s = sample
    sec_s = s_eval - s_start
    inner_w = 0.0
    this_w = 3.5
    for l_item in side_lanes:
        w_val = _eval_lane_width(l_item['width_polys'], sec_s)
        if abs(l_item['id']) < abs(ld['id']):
            inner_w += w_val
        if l_item['id'] == ld['id']:
            this_w = w_val
    sign = +1.0 if ld['side'] == 'L' else -1.0
    cx, cy = _lateral_point(
        px, py, ph, _eval_lane_offset(offsets, s_eval) + sign * (inner_w + this_w / 2.0), _curvature_at(geom_segs, s)
    )
    return cx, cy, _eval_elevation(elevations, s), this_w


def lane_centre_points(
    road_elem: ET.Element, section_id: int, lane_id: int, s_values: list[float]
) -> list[list[float]]:
    """[x, y, z, s] of a lane's centre at exactly each of `s_values`, unrounded.

    For lane_graph_builder, whose 2 m sample counts and metre-rounded node ids need exact s.
    """
    sections = _get_lane_sections(road_elem)
    s_start, s_end, lane_defs = sections[section_id]
    ld = next(l for l in lane_defs if l['id'] == lane_id)
    side_lanes = [l for l in lane_defs if l['side'] == ld['side']]
    offsets, elevations = _get_lane_offsets(road_elem), _get_elevations(road_elem)
    geom_segs = _parse_geometry_segments(road_elem)
    samples = {round(sp[3], 9): sp for sp in _sample_geometry(road_elem, 1e9, extra_s=list(s_values))}
    out = []
    for sv in s_values:
        sp = samples.get(round(sv, 9)) or min(samples.values(), key=lambda q: abs(q[3] - sv))
        s_eval = min(max(sv, s_start), s_end - 1e-6) if sv >= s_end - 1e-9 else max(sv, s_start)
        cx, cy, cz, _w = _lane_centre(sp, s_eval, ld, side_lanes, s_start, offsets, elevations, geom_segs)
        out.append([cx, cy, cz, sv])
    return out


# ── Dynamic Polygon Builder ────────────────────────────────────────────────────


def _build_lane_polygon_dynamic(
    samples: list[tuple],
    target_ld: dict,
    all_lane_defs: list[dict],
    sec_start_s: float,
    offsets: list[tuple],
    geom_segs: list[tuple] | None = None,
) -> list[list[float]]:
    """A lane's closed polygon, tracking cumulative widths at every s."""
    sign = +1.0 if target_ld['side'] == 'L' else -1.0
    fwd_inner: list[list[float]] = []
    fwd_outer: list[list[float]] = []

    side_lanes = [l for l in all_lane_defs if l['side'] == target_ld['side']]

    for (px, py, ph, s), s_eval in zip(samples, _section_eval_s(samples, sec_start_s)):
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
    """Painted line polylines of one lane section, with the polygons' lateral maths (left limit, fold clamp)."""
    # (marks, function: (s_eval, widths-by-id) -> signed lateral distance)
    borders = [(center_marks, None)]
    for ld in lane_defs:
        if ld['marks']:
            borders.append((ld['marks'], ld))

    out = []
    for marks, ld in borders:
        if ld is not None:
            sign = +1.0 if ld['side'] == 'L' else -1.0
            inner_ids = [l for l in lane_defs if l['side'] == ld['side'] and abs(l['id']) <= abs(ld['id'])]
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
            for (px, py, ph, s), s_eval in zip(pts, _section_eval_s(pts, s_start)):
                d = _eval_lane_offset(offsets, s_eval)
                if ld is not None:
                    d += sign * sum(_eval_lane_width(l['width_polys'], s_eval - s_start) for l in inner_ids)
                dists.append((px, py, ph, s, d))
            for tok, shift in lines:
                poly = []
                for px, py, ph, s, d in dists:
                    x, y = _lateral_point(px, py, ph, d + shift, _curvature_at(geom_segs, s))
                    poly.append([round(x, 2), round(y, 2)])
                out.append(
                    {
                        'type': tok,
                        'color': mark['color'],
                        'width': round(mark['width'], 2),
                        'points': poly,
                    }
                )
    return out
