"""Lane, road and junction links and lane-change road marks, read from an .xodr for the lane-graph builder."""

import xml.etree.ElementTree as ET

# ── XML extraction ──────────────────────────────────────────────────────────


def _forward_side(lane_id: int) -> str:
    """The <link> side matching a lane's forward direction (lane_graph_builder's forward rule)."""
    return 'successor' if lane_id < 0 else 'predecessor'


def _parse_lane_links(root: ET.Element) -> dict[tuple[int, int, int], tuple[int | None, int | None]]:
    """(roadId, sectionId, laneId) -> (predecessor, successor) lane ids from each <lane>'s <link>."""
    result: dict[tuple[int, int, int], tuple[int | None, int | None]] = {}
    for road in root.findall('road'):
        road_id = int(road.get('id'))
        lanes_elem = road.find('lanes')
        if lanes_elem is None:
            continue
        for section_id, ls in enumerate(lanes_elem.findall('laneSection')):
            for side in ('left', 'right'):
                se = ls.find(side)
                if se is None:
                    continue
                for lane in se.findall('lane'):
                    try:
                        lane_id = int(lane.get('id'))
                    except (TypeError, ValueError):
                        continue
                    link = lane.find('link')
                    pred_id = succ_id = None
                    if link is not None:
                        pred_el = link.find('predecessor')
                        succ_el = link.find('successor')
                        if pred_el is not None and pred_el.get('id') is not None:
                            pred_id = int(pred_el.get('id'))
                        if succ_el is not None and succ_el.get('id') is not None:
                            succ_id = int(succ_el.get('id'))
                    result[(road_id, section_id, lane_id)] = (pred_id, succ_id)
    return result


def _parse_road_links(root: ET.Element) -> dict[int, dict]:
    """roadId -> {'predecessor', 'successor'}, each {'elementType', 'elementId': int, 'contactPoint'} or None."""
    result: dict[int, dict] = {}
    for road in root.findall('road'):
        road_id = int(road.get('id'))
        link_elem = road.find('link')
        sides: dict[str, dict | None] = {'predecessor': None, 'successor': None}
        if link_elem is not None:
            for tag in ('predecessor', 'successor'):
                el = link_elem.find(tag)
                if el is None:
                    continue
                element_id = el.get('elementId')
                sides[tag] = {
                    'elementType': el.get('elementType', 'road'),
                    'elementId': int(element_id) if element_id is not None else None,
                    'contactPoint': el.get('contactPoint', 'start'),
                }
        result[road_id] = sides
    return result


def _parse_junction_connections(root: ET.Element) -> dict[tuple[int, int], list[dict]]:
    """(incomingRoadId, fromLaneId) -> every <connection> candidate, unranked (a fork has several)."""
    result: dict[tuple[int, int], list[dict]] = {}
    for junction in root.findall('junction'):
        for conn in junction.findall('connection'):
            incoming_road = conn.get('incomingRoad')
            connecting_road = conn.get('connectingRoad')
            if incoming_road is None or connecting_road is None:
                continue
            incoming_road = int(incoming_road)
            connecting_road = int(connecting_road)
            contact_point = conn.get('contactPoint', 'start')
            for ll in conn.findall('laneLink'):
                from_id = ll.get('from')
                to_id = ll.get('to')
                if from_id is None or to_id is None:
                    continue
                key = (incoming_road, int(from_id))
                result.setdefault(key, []).append(
                    {
                        'connectingRoadId': connecting_road,
                        'toLaneId': int(to_id),
                        'contactPoint': contact_point,
                    }
                )
    return result


def _parse_lane_change_marks(root: ET.Element) -> dict[tuple[int, int, int], str]:
    """(roadId, sectionId, laneId) -> the <roadMark laneChange> value, title-cased; informational only."""
    result: dict[tuple[int, int, int], str] = {}
    for road in root.findall('road'):
        road_id = int(road.get('id'))
        lanes_elem = road.find('lanes')
        if lanes_elem is None:
            continue
        for section_id, ls in enumerate(lanes_elem.findall('laneSection')):
            for side in ('left', 'right'):
                se = ls.find(side)
                if se is None:
                    continue
                for lane in se.findall('lane'):
                    try:
                        lane_id = int(lane.get('id'))
                    except (TypeError, ValueError):
                        continue
                    value = 'none'
                    for rm in lane.findall('roadMark'):
                        rm_value = (rm.get('laneChange') or 'none').lower()
                        # the most permissive of several records wins
                        if rm_value == 'both':
                            value = 'both'
                            break
                        if value == 'none' and rm_value != 'none':
                            value = rm_value
                    result[(road_id, section_id, lane_id)] = {
                        'none': 'NONE',
                        'both': 'Both',
                        'increase': 'Increase',
                        'decrease': 'Decrease',
                    }.get(value, 'NONE')
    return result


# CARLA's LaneMarking::LaneChange bits for right-hand traffic (LaneMarking.cpp
# GetLaneChange): `increase` -> Right, `decrease` -> Left. An absent or
# unrecognised attribute is Both (MapBuilder::CreateRoadMark's else branch).
_LC_RIGHT, _LC_LEFT = 1, 2
_LC_BITS = {'increase': _LC_RIGHT, 'decrease': _LC_LEFT, 'none': 0}


def _parse_mark_records(root: ET.Element) -> dict[tuple[int, int, int], list[tuple[float, int]]]:
    """(roadId, sectionId, laneId) -> [(absolute s, lane-change bits)] per <roadMark>, centre lane included.

    What GlobalRoutePlanner._lane_change_link gates every lane-change edge on.
    """
    result: dict[tuple[int, int, int], list[tuple[float, int]]] = {}
    for road in root.findall('road'):
        road_id = int(road.get('id'))
        lanes_elem = road.find('lanes')
        if lanes_elem is None:
            continue
        for section_id, ls in enumerate(lanes_elem.findall('laneSection')):
            section_s = float(ls.get('s', 0.0))
            for side in ('left', 'center', 'right'):
                se = ls.find(side)
                if se is None:
                    continue
                for lane in se.findall('lane'):
                    try:
                        lane_id = int(lane.get('id'))
                    except (TypeError, ValueError):
                        continue
                    records = sorted(
                        (
                            section_s + float(rm.get('sOffset', 0.0)),
                            _LC_BITS.get((rm.get('laneChange') or '').lower(), _LC_RIGHT | _LC_LEFT),
                        )
                        for rm in lane.findall('roadMark')
                    )
                    result[(road_id, section_id, lane_id)] = records
    return result


def _mark_bits_at(records: list[tuple[float, int]] | None, s: float) -> int:
    """Lane-change bits of the record in force at `s`; no record means no lane change."""
    bits = 0
    for record_s, record_bits in records or ():
        if record_s > s + 1e-6:
            break
        bits = record_bits
    return bits
