"""
scenario_io.py — Wrapper around llm-scenario-gen's xml_builder to export .xosc files.
Also validates and normalises incoming scenario JSON from the frontend.
"""

import sys
import math
import uuid
import tempfile
from pathlib import Path

_LLMGEN = Path(__file__).resolve().parent.parent.parent / "llm-scenario-gen"
if not _LLMGEN.exists():
    _LLMGEN = Path("/home/dellpro2/CC/llm-scenario-gen")


def _ensure_llmgen_on_path():
    llmgen_str = str(_LLMGEN)
    if llmgen_str not in sys.path:
        sys.path.insert(0, llmgen_str)


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

    # NPCs
    params.setdefault("npcs", [])
    for npc in params["npcs"]:
        npc.setdefault("type", "car")
        npc.setdefault("z", 0.2)
        npc.setdefault("yaw", 0.0)
        npc.setdefault("behaviors", ["constant_speed"])
        npc.setdefault("trajectory", [])
        npc.setdefault("route", [])
        npc.setdefault("path_mode", "trajectory")
        npc.setdefault("route_velocity", 10.0)
        npc.setdefault("route_speed_dynamics_value", 0.0)
        npc.setdefault("route_speed_dynamics_dimension", "distance")
        npc.setdefault("trigger_distance", 400)
        npc["trigger_distance"] = max(5.0, min(1000.0, float(npc["trigger_distance"])))
        npc["route_velocity"] = max(0.0, min(100.0, float(npc["route_velocity"])))
        npc["route_speed_dynamics_value"] = max(0.0, float(npc["route_speed_dynamics_value"]))
        if npc["route_speed_dynamics_dimension"] not in {"distance", "time"}:
            npc["route_speed_dynamics_dimension"] = "distance"

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

    # Road type (informational, used in file header)
    params.setdefault("road_type", "road")

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
