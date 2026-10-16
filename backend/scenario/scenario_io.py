"""Validate the editor's export payload and export it as .xosc / route XML through llm-scenario-gen."""

import sys
import uuid
from pathlib import Path

from backend.scenario.event_normalize import _normalize_actor
from backend.scenario.event_rules import _ROUTE_ACTOR_TYPES, _normalize_after_event_chains

_LLMGEN = Path(__file__).resolve().parents[3] / "llm-scenario-gen"
if not _LLMGEN.exists():
    _LLMGEN = Path("/home/dellpro2/CC/llm-scenario-gen")


def _ensure_llmgen_on_path():
    llmgen_str = str(_LLMGEN)
    if llmgen_str not in sys.path:
        sys.path.insert(0, llmgen_str)


def _normalize_actor_types(params: dict):
    """Reject NPC types the emitter cannot resolve (400): every lookup would fall back to `car`.

    The ego is exempt (sent as its vehicle type, or a literal 'ego'). Puts the sibling repo on
    the path itself, so test_normalization.py can call it directly.
    """
    _ensure_llmgen_on_path()
    from generator.xml_builder import actor_types  # type: ignore

    known = set(actor_types())
    for idx, npc in enumerate(params.get("npcs") or []):
        if not isinstance(npc, dict):
            continue
        npc_type = str(npc.get("type", "car")).strip()
        if npc_type not in known:
            raise ValueError(f"npcs[{idx}]: unknown actor type '{npc_type}' (not in config/vehicle_catalog.yaml)")
        npc["type"] = npc_type


def _normalize_static_objects(params: dict):
    """Validate the placed props; an unknown blueprint is a 400, not a missing actor in CARLA later.

    Needs _ensure_llmgen_on_path() (the prop catalogue is in the sibling repo).
    """
    raw = params.get("staticObjects")
    params["staticObjects"] = []
    if not isinstance(raw, list) or not raw:
        return

    from generator.xml_builder import prop_spec  # type: ignore

    for idx, obj in enumerate(raw):
        if not isinstance(obj, dict):
            raise ValueError(f"staticObjects[{idx}] must be an object")
        blueprint = str(obj.get("prop", "")).strip()
        if not prop_spec(blueprint):
            raise ValueError(f"staticObjects[{idx}]: unknown prop '{blueprint}' (not in config/prop_catalog.yaml)")
        params["staticObjects"].append(
            {
                "prop": blueprint,
                "x": float(obj.get("x", 0.0)),
                "y": float(obj.get("y", 0.0)),
                "z": float(obj.get("z", 0.0)),
                "yaw": float(obj.get("yaw", 0.0)),
            }
        )


_MAPS_DIR = Path(__file__).resolve().parents[2] / "maps"


def _carla_light_positions(town: str):
    """CARLA's traffic-light positions for a town, or None if never probed."""
    import json

    probe = _MAPS_DIR / str(town) / "carla_traffic_lights.json"
    if not probe.exists():
        return None
    try:
        return [(float(l["x"]), float(l["y"])) for l in json.loads(probe.read_text())]
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _reject_phantom_signals(params: dict):
    """Reject signal events on a light CARLA lacks (400): ScenarioRunner resolves "pos=x,y" within
    2 m and aborts the run with "Unknown traffic light" otherwise. Skipped for unprobed towns and
    for a signal naming its actor (traffic_signal_ref)."""
    import math

    carla_lights = _carla_light_positions(params.get("map"))
    if carla_lights is None:
        return
    for signal in params["trafficSignals"]:
        if not signal["events"] or signal.get("traffic_signal_ref"):
            continue
        if not any(math.hypot(cx - signal["x"], cy - signal["y"]) < 2.0 for cx, cy in carla_lights):
            raise ValueError(
                f"traffic signal '{signal['id']}' at ({signal['x']}, {signal['y']}) has no "
                f"traffic light in CARLA's {params.get('map')} — ScenarioRunner would abort "
                f"the run with 'Unknown traffic light'"
            )


# One pass over the payload in the order the checks depend on; splitting it scatters that order.
def validate_scenario_params(params: dict) -> dict:  # pylint: disable=too-many-branches,too-many-statements
    """Validate the export payload and fill defaults in place; raises ValueError (a 400)."""
    if not isinstance(params, dict):
        raise ValueError("params must be a JSON object")

    params.setdefault("map", "Town01")

    if "ego" not in params or params["ego"] is None:
        raise ValueError("Scenario must have an ego vehicle")
    ego = params["ego"]
    ego.setdefault("type", "car")
    # 'ego' means car; anything else must be routable: the hero is a <Vehicle> that drives its events.
    if ego["type"] in (None, "", "ego"):
        ego["type"] = "car"
    if ego["type"] not in _ROUTE_ACTOR_TYPES:
        raise ValueError(f"ego type '{ego['type']}' is not a vehicle type")
    ego.setdefault("z", 0.2)
    ego.setdefault("yaw", 0.0)
    if "x" not in ego or "y" not in ego:
        raise ValueError("ego must have x and y coordinates")

    params.setdefault("trafficSignals", [])
    if not isinstance(params["trafficSignals"], list):
        params["trafficSignals"] = []
    for idx, signal in enumerate(params["trafficSignals"]):
        if not isinstance(signal, dict):
            params["trafficSignals"][idx] = signal = {}
        signal["id"] = str(signal.get("id", f"signal_{idx + 1}"))
        signal["x"] = float(signal.get("x", 0.0))
        signal["y"] = float(signal.get("y", 0.0))
        signal["z"] = float(signal.get("z", 0.0))
        raw_events = signal.get("events") if isinstance(signal.get("events"), list) else []
        signal["events"] = []
        for event_idx, event in enumerate(raw_events):
            if not isinstance(event, dict):
                event = {}
            event["id"] = str(event.get("id", f"event_{event_idx + 1}"))
            event["trigger_distance"] = max(0.0, float(event.get("trigger_distance", 40.0)))
            event["state"] = event.get("state", "red")
            if event["state"] not in {"red", "yellow", "green"}:
                event["state"] = "red"
            signal["events"].append(event)
    _reject_phantom_signals(params)

    params.setdefault("npcs", [])
    actor_refs = {}
    if ego.get("id"):
        actor_refs[str(ego["id"])] = "hero"
    for idx, npc in enumerate(params["npcs"]):
        if isinstance(npc, dict) and npc.get("id"):
            actor_refs[str(npc["id"])] = "adversary" if idx == 0 else f"adversary{idx}"
    # Entity names the emitter will write, from the npc count (a payload may name entities directly).
    valid_refs = {"hero"} | {"adversary" if idx == 0 else f"adversary{idx}" for idx in range(len(params["npcs"]))}

    _normalize_actor_types(params)

    _normalize_actor(ego, "hero", actor_refs, valid_refs, "ego")

    scenario_actors = [(ego, "hero", "ego")]
    for npc_idx, npc in enumerate(params["npcs"]):
        npc.setdefault("type", "car")
        npc_name = "adversary" if npc_idx == 0 else f"adversary{npc_idx}"
        _normalize_actor(npc, npc_name, actor_refs, valid_refs, f"npcs[{npc_idx}]")
        scenario_actors.append((npc, npc_name, f"npcs[{npc_idx}]"))

    # After every actor: a reference may name another actor's event.
    _normalize_after_event_chains(scenario_actors)

    # Nothing with events anywhere means a Story with no Acts (XSD-invalid, over at once): 400.
    # Checked after normalisation; signal events count, they get an Act of their own.
    if not any(actor.get("events") for actor in [ego, *params["npcs"]]) and not any(
        signal["events"] for signal in params["trafficSignals"]
    ):
        raise ValueError(
            "No actor has any events — the scenario would end immediately. Add at least one event before exporting."
        )

    _normalize_static_objects(params)

    params.setdefault("weather", {})
    weather_keys = ["fog", "rainy", "cloudy", "sunny", "wet_road", "snowy", "dust_storm"]
    for k in weather_keys:
        if k in params["weather"]:
            params["weather"][k] = max(0.0, min(1.0, float(params["weather"][k])))

    valid_times = {"daytime", "morning", "noon", "afternoon", "dusk", "nighttime"}
    if params.get("time") not in valid_times:
        params["time"] = "daytime"

    # Route waypoints: derived here too, for a payload posted straight to /api/export-route.
    if not params.get("route_waypoints"):
        params["route_waypoints"] = _ego_route_waypoints(ego)

    return params


def _ego_route_waypoints(ego: dict) -> list[dict]:
    """The ego's path event as route.xml waypoints with per-segment yaw (as scenarioIO.js does)."""
    points = []
    for event in ego.get("events") or []:
        if not isinstance(event, dict):
            continue
        action = event.get("action") or {}
        if action.get("type") == "follow_trajectory" and len(action.get("trajectory") or []) > 0:
            points = action["trajectory"]
            break
        if action.get("type") == "assign_route" and len(action.get("waypoints") or []) > 0:
            points = action["waypoints"]
            break
    if not points:
        return []

    import math as _math

    ego_yaw = float(ego.get("yaw", 0.0))
    waypoints = []
    for i, wp in enumerate(points):
        yaw = ego_yaw
        nxt = points[i + 1] if i + 1 < len(points) else None
        prv = points[i - 1] if i > 0 else None
        if nxt:
            yaw = _math.degrees(_math.atan2(nxt["y"] - wp["y"], nxt["x"] - wp["x"]))
        elif prv:
            yaw = _math.degrees(_math.atan2(wp["y"] - prv["y"], wp["x"] - prv["x"]))
        waypoints.append(
            {
                "x": wp["x"],
                "y": wp["y"],
                "z": wp.get("z", 0.2),
                "yaw": round(yaw, 2),
            }
        )
    return waypoints


def export_route_xml(params: dict) -> str:
    """Write a route XML for the params to a temp file and return its path."""
    _ensure_llmgen_on_path()
    from generator.route_builder import build_route  # type: ignore

    params = validate_scenario_params(params)
    uid = str(uuid.uuid4())[:8]
    map_name = params.get("map", "scenario")
    tmp_path = f"/tmp/route_{map_name}_{uid}.xml"

    build_route(params, tmp_path)
    return tmp_path


def export_to_xosc(params: dict) -> str:
    """Write a .xosc for the params to a temp file and return its path; the caller deletes it."""
    _ensure_llmgen_on_path()
    from generator.xml_builder import build_xosc  # type: ignore

    params = validate_scenario_params(params)
    uid = str(uuid.uuid4())[:8]
    map_name = params.get("map", "scenario")
    tmp_path = f"/tmp/scenario_{map_name}_{uid}.xosc"

    build_xosc(params, tmp_path)
    return tmp_path
