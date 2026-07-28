"""
scenario_io.py — Wrapper around llm-scenario-gen's xml_builder to export .xosc files.
Also validates and normalises incoming scenario JSON from the frontend.
"""

import sys
import uuid
from pathlib import Path

_LLMGEN = Path(__file__).resolve().parent.parent.parent / "llm-scenario-gen"
if not _LLMGEN.exists():
    _LLMGEN = Path("/home/dellpro2/CC/llm-scenario-gen")


def _ensure_llmgen_on_path():
    llmgen_str = str(_LLMGEN)
    if llmgen_str not in sys.path:
        sys.path.insert(0, llmgen_str)


def _normalize_waypoints(points, include_velocity: bool = False) -> list[dict]:
    if not isinstance(points, list):
        return []
    normalized = []
    for point in points:
        if not isinstance(point, dict):
            continue
        wp = {
            "x": float(point.get("x", 0.0)),
            "y": float(point.get("y", 0.0)),
            "z": float(point.get("z", 0.2)),
        }
        if include_velocity:
            wp["velocity"] = max(0.0, float(point.get("velocity", 10.0)))
        normalized.append(wp)
    return normalized


def _entity_ref(raw, actor_refs: dict[str, str], fallback: str = "hero") -> str:
    if raw is None or raw == "":
        return fallback
    return actor_refs.get(str(raw), str(raw))


def _normalize_structured_event(event: dict, actor_refs: dict[str, str], default_entity_ref: str = "hero") -> None:
    trigger = event.get("trigger")
    if not isinstance(trigger, dict):
        trigger = {}
    trigger_kind = trigger.get("type", "simulation_time")
    if trigger_kind not in {"simulation_time", "distance_to_ego", "distance_to_point", "after_event"}:
        trigger_kind = "simulation_time"
    event["trigger"] = {"type": trigger_kind}
    if trigger_kind == "after_event":
        event["trigger"]["event_id"] = str(trigger.get("event_id", ""))
    elif trigger_kind == "distance_to_point":
        point = trigger.get("point") if isinstance(trigger.get("point"), dict) else {}
        event["trigger"]["value"] = max(0.0, float(trigger.get("value", 20.0)))
        event["trigger"]["entity_ref"] = _entity_ref(trigger.get("entity_ref"), actor_refs, default_entity_ref)
        event["trigger"]["point"] = {
            "name": str(point.get("name", "Point")),
            "x": float(point.get("x", 0.0)),
            "y": float(point.get("y", 0.0)),
            "z": float(point.get("z", 0.2)),
        }
    else:
        default_value = 400.0 if trigger_kind == "distance_to_ego" else 0.0
        event["trigger"]["value"] = max(0.0, float(trigger.get("value", default_value)))

    action = event.get("action")
    if not isinstance(action, dict):
        action = {}
    action_kind = action.get("type", "follow_trajectory")
    if action_kind not in {"follow_trajectory", "assign_route", "set_speed", "set_distance", "lane_change"}:
        action_kind = "follow_trajectory"

    if action_kind == "follow_trajectory":
        event["action"] = {
            "type": "follow_trajectory",
            "trajectory": _normalize_waypoints(action.get("trajectory"), include_velocity=True),
        }
    elif action_kind == "assign_route":
        event["action"] = {
            "type": "assign_route",
            "route_strategy": action.get("route_strategy", "fastest"),
            "waypoints": _normalize_waypoints(action.get("waypoints")),
        }
        event["trigger"] = {"type": "simulation_time", "value": 0.0}
    elif action_kind == "set_speed":
        target = action.get("target") if isinstance(action.get("target"), dict) else {}
        dynamics = action.get("dynamics") if isinstance(action.get("dynamics"), dict) else {}
        mode = "relative" if target.get("mode") == "relative" else "absolute"
        speed_target = {"mode": mode}
        if mode == "relative":
            speed_target["entity_ref"] = _entity_ref(target.get("entity_ref"), actor_refs)
            speed_target["delta"] = max(-100.0, min(100.0, float(target.get("delta", 0.0))))
        else:
            speed_target["value"] = max(0.0, min(100.0, float(target.get("value", 10.0))))
        dimension = dynamics.get("dimension", "time")
        if dimension not in {"distance", "time"}:
            dimension = "time"
        event["action"] = {
            "type": "set_speed",
            "dynamics": {
                "shape": dynamics.get("shape", "step"),
                "dimension": dimension,
                "value": max(0.0, float(dynamics.get("value", 5.0))),
            },
            "target": speed_target,
        }
    elif action_kind == "set_distance":
        axis = "lateral" if action.get("axis") == "lateral" else "longitudinal"
        event["action"] = {
            "type": "set_distance",
            "axis": axis,
            "entity_ref": _entity_ref(action.get("entity_ref"), actor_refs),
            "value": float(action.get("value", 10.0)),
        }
    else:
        dynamics = action.get("dynamics") if isinstance(action.get("dynamics"), dict) else {}
        event["action"] = {
            "type": "lane_change",
            "direction": "right" if action.get("direction") == "right" else "left",
            "dynamics": {
                "shape": dynamics.get("shape", "linear"),
                "value": max(0.0, float(dynamics.get("value", 12.0))),
            },
        }


def _normalize_static_objects(params: dict):
    """Validate the placed CARLA static props.

    Unlike events, an unknown prop id is a hard error rather than a silent
    coercion: a typo'd blueprint would otherwise export cleanly and only fail
    much later, inside CARLA, as a missing actor.

    Requires _ensure_llmgen_on_path() to have run — the prop catalog lives in
    the sibling repo alongside vehicle_catalog.yaml. Both export entry points
    call it before this, so the "missing sibling only fails at export time"
    property is preserved.
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
            raise ValueError(
                f"staticObjects[{idx}]: unknown prop '{blueprint}' "
                f"(not in config/prop_catalog.yaml)"
            )
        params["staticObjects"].append({
            "prop": blueprint,
            "x": float(obj.get("x", 0.0)),
            "y": float(obj.get("y", 0.0)),
            "z": float(obj.get("z", 0.0)),
            "yaw": float(obj.get("yaw", 0.0)),
        })


def validate_scenario_params(params: dict) -> dict:
    """
    Validate and fill defaults for the scenario params dict.
    Raises ValueError on fatal errors.
    """
    if not isinstance(params, dict):
        raise ValueError("params must be a JSON object")

    # Map
    params.setdefault("map", "Town01")

    # Ego — required
    if "ego" not in params or params["ego"] is None:
        raise ValueError("Scenario must have an ego vehicle")
    ego = params["ego"]
    ego.setdefault("type", "car")
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

    # NPCs
    params.setdefault("npcs", [])
    actor_refs = {}
    if ego.get("id"):
        actor_refs[str(ego["id"])] = "hero"
    for idx, npc in enumerate(params["npcs"]):
        if isinstance(npc, dict) and npc.get("id"):
            actor_refs[str(npc["id"])] = "adversary" if idx == 0 else f"adversary{idx}"

    for npc in params["npcs"]:
        npc.setdefault("type", "car")
        npc.setdefault("z", 0.2)
        npc.setdefault("yaw", 0.0)
        npc.setdefault("behaviors", ["constant_speed"])
        npc.setdefault("events", [])
        if not isinstance(npc["events"], list):
            npc["events"] = []
        npc.setdefault("trigger_distance", 400)
        npc["trigger_distance"] = max(5.0, min(1000.0, float(npc["trigger_distance"])))
        for idx, event in enumerate(npc["events"]):
            if not isinstance(event, dict):
                npc["events"][idx] = event = {}
            event.setdefault("id", f"event_{idx + 1}")
            _normalize_structured_event(event, actor_refs)
        assign_route_ids = {
            str(event.get("id"))
            for event in npc["events"]
            if isinstance(event, dict) and event.get("action", {}).get("type") == "assign_route"
        }
        for event in npc["events"]:
            trigger = event.get("trigger", {})
            if trigger.get("type") == "after_event" and str(trigger.get("event_id")) in assign_route_ids:
                event["trigger"] = {"type": "distance_to_ego", "value": 400.0}

    # Static props
    _normalize_static_objects(params)

    # Weather
    params.setdefault("weather", {})
    weather_keys = ["fog", "rainy", "cloudy", "sunny", "wet_road", "snowy", "dust_storm"]
    for k in weather_keys:
        if k in params["weather"]:
            params["weather"][k] = max(0.0, min(1.0, float(params["weather"][k])))

    # Time
    valid_times = {"daytime", "morning", "noon", "afternoon", "dusk", "nighttime"}
    if params.get("time") not in valid_times:
        params["time"] = "daytime"

    # Route waypoints
    params.setdefault("route_waypoints", [])

    return params


def export_route_xml(params: dict) -> str:
    """
    Generate a route XML file from scenario params.
    Returns the path to the written temp file.
    """
    _ensure_llmgen_on_path()
    from generator.route_builder import build_route  # type: ignore

    params = validate_scenario_params(params)
    uid      = str(uuid.uuid4())[:8]
    map_name = params.get("map", "scenario")
    tmp_path = f"/tmp/route_{map_name}_{uid}.xml"

    build_route(params, tmp_path)
    return tmp_path


def export_to_xosc(params: dict) -> str:
    """
    Generate a .xosc file from scenario params.
    Returns the path to the written temp file.
    The caller is responsible for deleting it after sending.
    """
    _ensure_llmgen_on_path()
    from generator.xml_builder import build_xosc  # type: ignore

    params = validate_scenario_params(params)
    uid      = str(uuid.uuid4())[:8]
    map_name = params.get("map", "scenario")
    tmp_path = f"/tmp/scenario_{map_name}_{uid}.xosc"

    build_xosc(params, tmp_path)
    return tmp_path
