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


def _normalize_structured_event(
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
        # Which actor owns the referenced event. An omitted/blank actor_ref is
        # the acting entity itself, so every payload written before cross-actor
        # references existed resolves exactly as it did. Resolved to an entity
        # name here (obj-N -> hero/adversaryN), like every other entity ref, so
        # the emitter's name table can be keyed on (entity, event_id).
        event["trigger"]["actor_ref"] = _entity_ref(
            trigger.get("actor_ref"),
            actor_refs,
            valid_refs,
            where,
            self_ref or default_entity_ref,
        )
    elif trigger_kind == "distance_to_point":
        point = trigger.get("point") if isinstance(trigger.get("point"), dict) else None
        # A missing point used to be defaulted to (0, 0, 0.2) — the map origin.
        # DistanceCondition is 3-D, so that is a real condition measured against
        # a corner of the town: it simply never becomes true, and the event looks
        # like a badly tuned radius rather than an unfinished one. Rejected for
        # the same reason as a dangling entity_ref.
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
        # speed(entity_ref) - speed(acting actor), RelativeSpeedCondition with
        # the other actor as the triggering entity. A difference to oneself is
        # always 0 — a condition that is either true on tick 1 or never — so a
        # self-reference (including an omitted ref on a hero event) is a 400.
        rule = trigger.get("rule", "greaterThan")
        event["trigger"]["rule"] = rule if rule in _EGO_SPEED_RULES else "greaterThan"
        event["trigger"]["value"] = max(-100.0, min(100.0, float(trigger.get("value", 0.0))))
        event["trigger"]["entity_ref"] = _entity_ref(
            trigger.get("entity_ref"), actor_refs, valid_refs, where, forbid=self_ref
        )
    elif trigger_kind == "distance_to_ego":
        # „Abstand zu Akteur": the distance from `entity_ref` (default hero) to
        # the acting actor. Omitted, it is hero, which is every payload written
        # before the field existed. A hero event naming hero (or nothing) is
        # left without a ref for the self-distance coercion in
        # _normalize_after_event_chains; an NPC naming itself is a 400.
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

    # A path action the emitter cannot build is not a smaller scenario, it is a
    # different one: build_custom_event_chain skips the whole event, and any
    # after_event chained onto it is left pointing at a storyboard element that
    # is not in the file, so that event never fires either. Rejected rather than
    # dropped, so the cause is named once instead of surfacing as an actor that
    # mysteriously does nothing.
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
        # Waypoint 0 must be "fastest". Its leg runs from the actor's own pose to
        # itself, so on an editor-built route -- where waypoint 0 IS the actor --
        # the choice is meaningless and this costs nothing. What it buys is that
        # ChangeActorWaypoints.initialise binds its `ego_next_wp` seed on the
        # i == 0 pass; a route whose first waypoint is "shortest" and whose
        # second is "fastest" reaches the heading filter's fallback with that
        # variable unbound and dies on an UnboundLocalError, killing the run.
        # Stock 0.9.15 has the same bug, so honouring this keeps exports running
        # on an unpatched ScenarioRunner.
        #
        # Rejected rather than coerced, the same policy as an unknown prop id or
        # a dangling entity_ref: a payload the editor did not build (LLM,
        # hand-written, tests/carla_cases.py) may have no waypoint on the actor
        # at all, and silently rewriting its first leg from a straight line into
        # a routed one would hand back a different scenario than the one asked
        # for.
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
            # ChangeActorTargetSpeed re-applies a relative target every tick.
            # Against the acting actor itself that compounds (+delta or ×factor
            # per tick) — unless `rate` is set, whose ramp overwrites the
            # re-sample with a one-shot target snapshotted at initialise().
            # `continuous` skips that ramp, so it compounds as well.
            if speed_target["entity_ref"] == self_ref and (dimension != "rate" or continuous):
                raise ValueError(
                    f"{where}: a set_speed relative to the acting actor itself "
                    f"needs the 'rate' dynamics and must not be continuous — "
                    f"otherwise the target compounds every tick"
                )
        else:
            speed_target["value"] = max(0.0, min(100.0, float(target.get("value", 10.0))))
            if target.get("reverse") is True:
                # PedestrianControl raises NotImplementedError on a negative
                # target speed, killing the run.
                if actor_type in _WALKER_ACTOR_TYPES:
                    raise ValueError(
                        f"{where}: reverse speed is not available for actor type "
                        f"'{actor_type}' — only vehicles can drive backwards"
                    )
                speed_target["reverse"] = True
        if dimension == "rate":
            # ChangeActorTargetSpeed's rate branch ends the atomic when the
            # ramped speed *reaches* the target, never on a clock. A rate of 0
            # therefore never terminates: the storyboard stays RUNNING, run.sh
            # blocks forever in `wait`, and the orphan keeps ticking CARLA under
            # the next scenario. The floor is that guard, not tidiness.
            dyn_value = max(0.1, float(dynamics.get("value", 2.5)))
            # 'step' + 'rate' is self-contradictory. This runtime never reads
            # dynamicsShape, but the file should still say what it means.
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
        # Rejected rather than dropped, the same policy as assign_route on a
        # walker: PedestrianControl ignores the controller offset entirely, so
        # the file would be valid and the actor would simply never move
        # sideways — indistinguishable from a badly chosen offset.
        if actor_type in _WALKER_ACTOR_TYPES:
            raise ValueError(
                f"{where}: lane_offset is not available for actor type "
                f"'{actor_type}' — only vehicles honour a lane offset"
            )
        event["action"] = {
            "type": "lane_offset",
            "direction": "right" if action.get("direction") == "right" else "left",
            "offset": max(0.0, min(_MAX_LANE_OFFSET_M, float(action.get("offset", 1.0)))),
            # False = „bis erreicht, dann zurück": completes on reaching the
            # offset and resets to 0 (needs the local ScenarioRunner patch, see
            # _add_lane_offset_action). Absent/True is the held offset.
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
    """Defaults + event normalisation for one scenario actor.

    Shared by the ego and every NPC — the ego is a scenario actor with the
    entity name 'hero', not a special case. `entity_name` is the actor's own
    OpenSCENARIO name, used only to reject/rewrite a self-reference.
    """
    actor.setdefault("z", 0.2)
    actor.setdefault("yaw", 0.0)
    actor.setdefault("events", [])
    if not isinstance(actor["events"], list):
        actor["events"] = []

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

    # simple_vehicle_control's consider_trafficlights / consider_obstacles.
    # Default True, which is what every export did before the per-actor
    # toggles existed — so a payload that never mentions them (LLM, hand-
    # written, tests/carla_cases.py) is unchanged. Only a literal False turns
    # one off; a walker's are carried through and ignored by the emitter.
    for key in ("obey_traffic_lights", "obey_obstacles"):
        actor[key] = actor.get(key) is not False

    # simple_vehicle_control's max_acceleration / max_deceleration (m/s²).
    # Defaults are what every vehicle was emitted with before the fields
    # existed. Floored at 0.1: a limit of 0 means the speed can never change.
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
