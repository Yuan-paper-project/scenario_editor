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


def _entity_ref(
    raw,
    actor_refs: dict[str, str],
    valid_refs: set[str],
    where: str,
    fallback: str = "hero",
    *,
    forbid: str | None = None,
) -> str:
    """Resolve an internal 'obj-N' id to its OpenSCENARIO entity name.

    Raises rather than coercing, the same deliberate break from the
    silent-coercion pattern as _normalize_static_objects and
    _normalize_actor_types. An unresolvable ref used to pass through verbatim,
    which put '<EntityRef entityRef="obj-10"/>' in the .xosc: ScenarioRunner
    matches no actor, leaves trigger_actor None, and the condition never fires.
    That costs a full CARLA run to notice and reads as a tuning problem.

    valid_refs is derived from the npc *count*, not from the ids present, so a
    hand-written or LLM-generated payload that already names 'adversary1'
    directly still validates.

    `forbid`, when given, additionally rejects a ref equal to the acting
    entity itself — used only for set_distance, where KeepLongitudinalGap
    against yourself computes a gap of 0 and succeeds on the first tick. It
    also catches an omitted entity_ref, which would otherwise silently fall
    back to `fallback` ("hero") and become the same self-reference for a
    hero-owned event.
    """
    if raw is None or raw == "":
        ref = fallback
    else:
        ref = actor_refs.get(str(raw), str(raw))
    if ref not in valid_refs:
        raise ValueError(
            f"{where}: entity_ref '{raw}' names no entity in this scenario "
            f"(expected one of {sorted(valid_refs)})"
        )
    if forbid is not None and ref == forbid:
        raise ValueError(
            f"{where}: entity_ref '{raw}' resolves to '{forbid}', the acting "
            f"entity itself — a distance to oneself is always 0, making the "
            f"action a silent no-op"
        )
    return ref


def _normalize_structured_event(
    event: dict,
    actor_refs: dict[str, str],
    valid_refs: set[str],
    where: str,
    default_entity_ref: str = "hero",
    *,
    self_ref: str | None = None,
) -> None:
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
        event["trigger"]["entity_ref"] = _entity_ref(
            trigger.get("entity_ref"), actor_refs, valid_refs, where, default_entity_ref
        )
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
            speed_target["entity_ref"] = _entity_ref(
                target.get("entity_ref"), actor_refs, valid_refs, where
            )
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
            "entity_ref": _entity_ref(
                action.get("entity_ref"), actor_refs, valid_refs, where, forbid=self_ref
            ),
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


def _normalize_actor(
    actor: dict,
    entity_name: str,
    actor_refs: dict[str, str],
    valid_refs: set[str],
    where: str,
) -> None:
    """Defaults + event normalisation for one scenario actor.

    Shared by the ego and every NPC — the ego is a scenario actor with the
    entity name 'hero', not a special case. `entity_name` is the actor's own
    OpenSCENARIO name, used only to reject/rewrite a self-reference.
    """
    actor.setdefault("z", 0.2)
    actor.setdefault("yaw", 0.0)
    actor.setdefault("behaviors", ["constant_speed"])
    actor.setdefault("events", [])
    if not isinstance(actor["events"], list):
        actor["events"] = []
    actor.setdefault("trigger_distance", 400)
    actor["trigger_distance"] = max(5.0, min(1000.0, float(actor["trigger_distance"])))

    # Speed the actor has on the first tick, emitted as a SpeedAction in the
    # Storyboard Init. The floor at 0 is not cosmetic: ScenarioRunner's
    # openscenario_configuration._get_actor_speed *raises* on a negative
    # AbsoluteTargetSpeed in Init, killing the run.
    #
    # Defaults to 0, NOT to the editor's placement default of 10. This function
    # also normalises hand-written and LLM-generated payloads and every
    # tests/carla_cases.py case, none of which mention the field — defaulting
    # those to 10 would put every previously stationary actor into motion.
    actor.setdefault("initial_speed", 0.0)
    actor["initial_speed"] = max(0.0, min(100.0, float(actor["initial_speed"])))

    for idx, event in enumerate(actor["events"]):
        if not isinstance(event, dict):
            actor["events"][idx] = event = {}
        event.setdefault("id", f"event_{idx + 1}")
        _normalize_structured_event(
            event, actor_refs, valid_refs, f"{where}.events[{idx}]", self_ref=entity_name
        )

    assign_route_ids = {
        str(event.get("id"))
        for event in actor["events"]
        if isinstance(event, dict) and event.get("action", {}).get("type") == "assign_route"
    }
    for event in actor["events"]:
        trigger = event.get("trigger", {})
        if trigger.get("type") == "after_event" and str(trigger.get("event_id")) in assign_route_ids:
            event["trigger"] = {"type": "distance_to_ego", "value": 400.0}

    # Must run LAST, after the after_event rewrite above: the ego cannot gate
    # on its own distance to itself (always 0, fires on tick 1), so any
    # distance_to_ego trigger it ends up with — direct or rewritten — becomes
    # a plain simulation_time start instead.
    if entity_name == "hero":
        for event in actor["events"]:
            if event.get("trigger", {}).get("type") == "distance_to_ego":
                event["trigger"] = {"type": "simulation_time", "value": 0.0}


def _normalize_actor_types(params: dict):
    """Reject NPC types the emitter cannot resolve.

    Same deliberate break from the silent-coercion pattern as
    _normalize_static_objects, and for the same reason: every lookup in
    xml_builder falls back to `car`, so a typo'd type exports cleanly and shows
    up as a Lincoln MKZ in the simulation with nothing pointing at the cause.
    Actions and triggers keep coercing — those are enumerated in the UI and
    cannot be mistyped by a user.

    The ego is exempt: the frontend always sends it as 'car'
    (scenarioIO.js buildScenarioParams), and saved scenarios carry the literal
    'ego' that _placeActor wrote.

    Puts the sibling repo on the path itself rather than relying on the export
    entry points having done it, so test_normalization.py can exercise this
    without a browser or a server. A missing sibling repo still only surfaces
    when something calls validate_scenario_params, i.e. at export time.
    """
    _ensure_llmgen_on_path()
    from generator.xml_builder import actor_types  # type: ignore

    known = set(actor_types())
    for idx, npc in enumerate(params.get("npcs") or []):
        if not isinstance(npc, dict):
            continue
        npc_type = str(npc.get("type", "car")).strip()
        if npc_type not in known:
            raise ValueError(
                f"npcs[{idx}]: unknown actor type '{npc_type}' "
                f"(not in config/vehicle_catalog.yaml)"
            )
        npc["type"] = npc_type


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
    # Every entity name _inject_npcs will actually emit, derived from the npc
    # count rather than from actor_refs — a payload may omit ids and name its
    # entities directly. Anything outside this set is a dangling reference.
    valid_refs = {"hero"} | {
        "adversary" if idx == 0 else f"adversary{idx}"
        for idx in range(len(params["npcs"]))
    }

    _normalize_actor_types(params)

    _normalize_actor(ego, "hero", actor_refs, valid_refs, "ego")

    for npc_idx, npc in enumerate(params["npcs"]):
        npc.setdefault("type", "car")
        npc_name = "adversary" if npc_idx == 0 else f"adversary{npc_idx}"
        _normalize_actor(npc, npc_name, actor_refs, valid_refs, f"npcs[{npc_idx}]")

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

    # Route waypoints — normally sent by scenarioIO.js's buildScenarioParams()
    # (derived client-side from the ego's path event). Derive them here too,
    # from the now-normalized ego.events, so a hand-written or reloaded
    # payload posted straight to /api/export-route doesn't silently fall back
    # to route_builder's single-waypoint spawn fallback.
    if not params.get("route_waypoints"):
        params["route_waypoints"] = _ego_route_waypoints(ego)

    return params


def _ego_route_waypoints(ego: dict) -> list[dict]:
    """The ego's follow_trajectory/assign_route path event, as route.xml
    waypoints with per-segment yaw — mirrors scenarioIO.js buildScenarioParams.
    """
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
        waypoints.append({
            "x": wp["x"], "y": wp["y"], "z": wp.get("z", 0.2),
            "yaw": round(yaw, 2),
        })
    return waypoints


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
