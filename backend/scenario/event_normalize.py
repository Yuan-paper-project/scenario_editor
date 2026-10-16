"""Per-event and per-actor normalisation of the editor's export payload: whitelists, clamps, defaults, entity refs."""

from backend.scenario.event_rules import (
    _DYNAMICS_DEFAULTS,
    _EGO_SPEED_RULES,
    _EVENT_REF_TRIGGERS,
    _MAX_LANE_OFFSET_M,
    _ROUTE_ACTOR_TYPES,
    _TRIGGER_KINDS,
    _WALKER_ACTOR_TYPES,
    ROUTE_STRATEGIES,
    _entity_ref,
)


def _normalize_waypoints(
    points,
    include_velocity: bool = False,
    default_strategy: str | None = None,
) -> list[dict]:
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
        if default_strategy is not None:
            strategy = point.get("strategy", default_strategy)
            wp["strategy"] = strategy if strategy in ROUTE_STRATEGIES else default_strategy
        normalized.append(wp)
    return normalized


# A flat list of per-field clamps and defaults: long, but each line stands alone.
def _normalize_structured_event(  # pylint: disable=too-many-branches,too-many-statements
    event: dict,
    actor_refs: dict[str, str],
    valid_refs: set[str],
    where: str,
    default_entity_ref: str = "hero",
    *,
    self_ref: str | None = None,
    actor_type: str = "car",
) -> None:
    trigger = event.get("trigger")
    if not isinstance(trigger, dict):
        trigger = {}
    trigger_kind = trigger.get("type", "simulation_time")
    if trigger_kind not in _TRIGGER_KINDS:
        trigger_kind = "simulation_time"
    event["trigger"] = {"type": trigger_kind}
    if trigger_kind in _EVENT_REF_TRIGGERS:
        event["trigger"]["event_id"] = str(trigger.get("event_id", ""))
        # The referenced event's owner, resolved to an entity name; omitted = the acting entity.
        event["trigger"]["actor_ref"] = _entity_ref(
            trigger.get("actor_ref"),
            actor_refs,
            valid_refs,
            where,
            self_ref or default_entity_ref,
        )
    elif trigger_kind == "distance_to_point":
        point = trigger.get("point") if isinstance(trigger.get("point"), dict) else None
        # A missing point is rejected: DistanceCondition is 3-D and a default could never fire.
        if point is None or point.get("x") is None or point.get("y") is None:
            raise ValueError(
                f"{where}: distance_to_point trigger has no point — set one on the map, or the condition can never fire"
            )
        event["trigger"]["value"] = max(0.0, float(trigger.get("value", 20.0)))
        event["trigger"]["entity_ref"] = _entity_ref(
            trigger.get("entity_ref"), actor_refs, valid_refs, where, default_entity_ref
        )
        event["trigger"]["point"] = {
            "name": str(point.get("name", "Point")),
            "x": float(point.get("x")),
            "y": float(point.get("y")),
            "z": float(point.get("z", 0.2)),
        }
    elif trigger_kind == "ego_speed":
        rule = trigger.get("rule", "greaterThan")
        event["trigger"]["rule"] = rule if rule in _EGO_SPEED_RULES else "greaterThan"
        event["trigger"]["value"] = max(0.0, min(100.0, float(trigger.get("value", 10.0))))
    elif trigger_kind == "relative_speed":
        # speed(entity_ref) − speed(acting actor); a self-reference (also an omitted ref on hero) is a 400.
        rule = trigger.get("rule", "greaterThan")
        event["trigger"]["rule"] = rule if rule in _EGO_SPEED_RULES else "greaterThan"
        event["trigger"]["value"] = max(-100.0, min(100.0, float(trigger.get("value", 0.0))))
        event["trigger"]["entity_ref"] = _entity_ref(
            trigger.get("entity_ref"), actor_refs, valid_refs, where, forbid=self_ref
        )
    elif trigger_kind == "distance_to_ego":
        # „Abstand zu Akteur" from `entity_ref` (default hero). A hero event naming hero keeps no ref,
        # for the self-distance coercion later; an NPC naming itself is a 400.
        event["trigger"]["value"] = max(0.0, float(trigger.get("value", 400.0)))
        raw_ref = trigger.get("entity_ref")
        if raw_ref not in (None, ""):
            ref = _entity_ref(raw_ref, actor_refs, valid_refs, where)
            if ref == self_ref and self_ref != "hero":
                raise ValueError(
                    f"{where}: distance_to_ego names the acting entity itself "
                    f"('{ref}') — a distance to oneself is always 0"
                )
            if ref != "hero":
                event["trigger"]["entity_ref"] = ref
    else:
        default_value = 400.0 if trigger_kind == "distance_to_ego" else 0.0
        event["trigger"]["value"] = max(0.0, float(trigger.get("value", default_value)))

    action = event.get("action")
    if not isinstance(action, dict):
        action = {}
    action_kind = action.get("type", "follow_trajectory")
    if action_kind not in {
        "follow_trajectory",
        "assign_route",
        "set_speed",
        "set_distance",
        "lane_change",
        "lane_offset",
    }:
        action_kind = "follow_trajectory"

    # A path action the emitter cannot build would drop the event and dangle its dependents: 400.
    if action_kind == "follow_trajectory":
        trajectory = _normalize_waypoints(action.get("trajectory"), include_velocity=True)
        if len(trajectory) < 2:
            raise ValueError(
                f"{where}: follow_trajectory needs at least 2 waypoints, got "
                f"{len(trajectory)} — the event would be dropped from the file"
            )
        event["action"] = {
            "type": "follow_trajectory",
            "trajectory": trajectory,
        }
    elif action_kind == "assign_route":
        if actor_type not in _ROUTE_ACTOR_TYPES:
            raise ValueError(
                f"{where}: assign_route is not available for actor type '{actor_type}' — only vehicles may be routed"
            )
        route_strategy = action.get("route_strategy", "fastest")
        if route_strategy not in ROUTE_STRATEGIES:
            route_strategy = "fastest"
        waypoints = _normalize_waypoints(action.get("waypoints"), default_strategy=route_strategy)
        if len(waypoints) < 2:
            raise ValueError(
                f"{where}: assign_route needs at least 2 waypoints, got "
                f"{len(waypoints)} — the event would be dropped from the file"
            )
        # Waypoint 0 must be "fastest": "shortest" then "fastest" kills unpatched ScenarioRunner
        # with an UnboundLocalError. A 400, not a coercion: rewriting the first leg of a payload
        # the editor did not build would change its scenario.
        if waypoints[0]["strategy"] != "fastest":
            raise ValueError(
                f"{where}: the first assign_route waypoint must use the "
                f"'fastest' strategy, got '{waypoints[0]['strategy']}' — "
                f"ScenarioRunner cannot seed a route that starts with a "
                f"straight-line leg"
            )
        event["action"] = {
            "type": "assign_route",
            "route_strategy": route_strategy,
            "waypoints": waypoints,
        }
        event["trigger"] = {"type": "simulation_time", "value": 0.0}
    elif action_kind == "set_speed":
        target = action.get("target") if isinstance(action.get("target"), dict) else {}
        dynamics = action.get("dynamics") if isinstance(action.get("dynamics"), dict) else {}
        mode = "relative" if target.get("mode") == "relative" else "absolute"
        speed_target = {"mode": mode}
        dimension = dynamics.get("dimension", "time")
        if dimension not in {"distance", "time", "rate"}:
            dimension = "time"
        if mode == "relative":
            speed_target["entity_ref"] = _entity_ref(target.get("entity_ref"), actor_refs, valid_refs, where)
            value_type = "factor" if target.get("value_type") == "factor" else "delta"
            speed_target["value_type"] = value_type
            if value_type == "factor":
                speed_target["factor"] = max(0.0, min(10.0, float(target.get("factor", 1.0))))
            else:
                speed_target["delta"] = max(-100.0, min(100.0, float(target.get("delta", 0.0))))
            continuous = target.get("continuous") is True
            speed_target["continuous"] = continuous
            # A self-relative target compounds every tick unless a non-continuous `rate` ramp snapshots it.
            if speed_target["entity_ref"] == self_ref and (dimension != "rate" or continuous):
                raise ValueError(
                    f"{where}: a set_speed relative to the acting actor itself "
                    f"needs the 'rate' dynamics and must not be continuous — "
                    f"otherwise the target compounds every tick"
                )
        else:
            speed_target["value"] = max(0.0, min(100.0, float(target.get("value", 10.0))))
            if target.get("reverse") is True:
                # PedestrianControl raises on a negative target speed.
                if actor_type in _WALKER_ACTOR_TYPES:
                    raise ValueError(
                        f"{where}: reverse speed is not available for actor type "
                        f"'{actor_type}' — only vehicles can drive backwards"
                    )
                speed_target["reverse"] = True
        if dimension == "rate":
            # A rate ramp ends on reaching the target, so a rate of 0 never ends and hangs run.sh.
            dyn_value = max(0.1, float(dynamics.get("value", 2.5)))
            # 'step' + 'rate' contradict each other; nothing reads the shape, but say what it means.
            shape = "linear"
        else:
            dyn_value = max(0.0, float(dynamics.get("value", 5.0)))
            shape = dynamics.get("shape", "step")
        event["action"] = {
            "type": "set_speed",
            "dynamics": {
                "shape": shape,
                "dimension": dimension,
                "value": dyn_value,
            },
            "target": speed_target,
        }
    elif action_kind == "set_distance":
        axis = "lateral" if action.get("axis") == "lateral" else "longitudinal"
        event["action"] = {
            "type": "set_distance",
            "axis": axis,
            "entity_ref": _entity_ref(action.get("entity_ref"), actor_refs, valid_refs, where, forbid=self_ref),
            "value": float(action.get("value", 10.0)),
        }
    elif action_kind == "lane_offset":
        # A walker never reads the offset: a 400 rather than a file that silently does nothing.
        if actor_type in _WALKER_ACTOR_TYPES:
            raise ValueError(
                f"{where}: lane_offset is not available for actor type "
                f"'{actor_type}' — only vehicles honour a lane offset"
            )
        event["action"] = {
            "type": "lane_offset",
            "direction": "right" if action.get("direction") == "right" else "left",
            "offset": max(0.0, min(_MAX_LANE_OFFSET_M, float(action.get("offset", 1.0)))),
            # False = Hin & zurück (completes, then resets; needs the local patch); absent = held.
            "continuous": action.get("continuous") is not False,
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
    """Defaults and event normalisation for one scenario actor, ego or NPC.

    `entity_name` is its own OpenSCENARIO name, used to reject or rewrite self-references.
    """
    actor.setdefault("z", 0.2)
    actor.setdefault("yaw", 0.0)
    actor.setdefault("events", [])
    if not isinstance(actor["events"], list):
        actor["events"] = []

    # The Init speed: ScenarioRunner raises on a negative one. Defaults to 0, not the editor's 10,
    # so payloads that never mention it (LLM, hand-written) stay stationary.
    actor.setdefault("initial_speed", 0.0)
    actor["initial_speed"] = max(0.0, min(100.0, float(actor["initial_speed"])))

    # consider_trafficlights / consider_obstacles: default True; only a literal False turns one off.
    for key in ("obey_traffic_lights", "obey_obstacles"):
        actor[key] = actor.get(key) is not False

    # Rate limits (m/s²); floored at 0.1, since at 0 the speed never changes.
    for key, default in _DYNAMICS_DEFAULTS.items():
        try:
            value = float(actor.get(key, default))
        except (TypeError, ValueError):
            value = default
        actor[key] = max(0.1, min(50.0, value))

    for idx, event in enumerate(actor["events"]):
        if not isinstance(event, dict):
            actor["events"][idx] = event = {}
        event.setdefault("id", f"event_{idx + 1}")
        _normalize_structured_event(
            event,
            actor_refs,
            valid_refs,
            f"{where}.events[{idx}]",
            self_ref=entity_name,
            actor_type=str(actor.get("type", "car")),
        )
