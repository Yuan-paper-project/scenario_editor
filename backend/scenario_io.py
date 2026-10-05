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


# A route waypoint's strategy governs the LEG THAT ENDS AT IT, not the point:
# ChangeActorWaypoints routes from waypoint i-1 to waypoint i using waypoint i's
# strategy. "shortest" appends the authored point verbatim (a straight line, and
# exactly what FollowTrajectoryAction becomes — its parser tags every vertex
# "shortest"); anything else routes the leg through the GlobalRoutePlanner.
#
# Only those two are offered. The XSD also allows "leastIntersections" and
# "random", but ScenarioRunner treats everything that is not "shortest" as the
# planner, so folding them into "fastest" changes the file without changing what
# CARLA does — and stops the file claiming a strategy nothing implements.
ROUTE_STRATEGIES = {"fastest", "shortest"}


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


# Actor types AssignRouteAction accepts — _ROUTE_ACTION_TYPES in
# ../llm-scenario-gen/generator/event_builders.py, and ROUTE_ACTION_TYPES in
# frontend/js/app.js; the three must stay in step. 'ego' is here because a saved
# scenario carries the literal type (the frontend exports it as 'car').
#
# The emitter runs the type through _TYPE_ALIASES first, so the aliases that
# resolve to a routable type are listed too — without 'lorry' and 'moped' this
# would reject payloads the emitter is perfectly happy with. 'cyclist' and
# 'bicycle' alias to 'bike', which is not routable, so their absence is correct.
_ROUTE_ACTOR_TYPES = {
    "car", "van", "truck", "bus", "motorcycle", "scooter",
    "police", "ambulance", "firetruck", "ego",
    "lorry", "moped",
}
# ChangeActorLaneOffset writes through to the controller's `_offset`, which only
# SimpleVehicleControl and NpcVehicleControl read — PedestrianControl stores it
# and never looks at it again, so a walker would get a valid file in which it
# simply never moves sideways.
#
# Deliberately NOT _ROUTE_ACTOR_TYPES, which is narrower: that set is limited by
# the GlobalRoutePlanner and leaves out 'cyclist', which aliases to 'bike' and is
# a <Vehicle> on simple_vehicle_control — it honours an offset perfectly well.
# The rule here is exactly "is this a <Pedestrian>", so it is stated as an
# exclusion. No alias in _TYPE_ALIASES resolves TO a walker, so unlike the route
# set this one needs no alias entries.
#
# Same split as xml_builder._PEDESTRIAN_TYPES and mapView.js's WALKER_TYPES.
_WALKER_ACTOR_TYPES = {"pedestrian", "child"}

# A lane is ~3.5 m wide, so 10 m covers an oncoming-lane overtake with room to
# spare while still rejecting a value that would put the actor off the road
# entirely. The magnitude is unsigned in the payload — `direction` carries the
# side, exactly as it does for lane_change — and the emitter applies the sign.
_MAX_LANE_OFFSET_M = 10.0


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
    if trigger_kind not in {"simulation_time", "distance_to_ego", "distance_to_point", "after_event"}:
        trigger_kind = "simulation_time"
    event["trigger"] = {"type": trigger_kind}
    if trigger_kind == "after_event":
        event["trigger"]["event_id"] = str(trigger.get("event_id", ""))
        # Which actor owns the referenced event. An omitted/blank actor_ref is
        # the acting entity itself, so every payload written before cross-actor
        # references existed resolves exactly as it did. Resolved to an entity
        # name here (obj-N -> hero/adversaryN), like every other entity ref, so
        # the emitter's name table can be keyed on (entity, event_id).
        event["trigger"]["actor_ref"] = _entity_ref(
            trigger.get("actor_ref"), actor_refs, valid_refs, where,
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
                f"{where}: distance_to_point trigger has no point — set one on "
                f"the map, or the condition can never fire"
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
    else:
        default_value = 400.0 if trigger_kind == "distance_to_ego" else 0.0
        event["trigger"]["value"] = max(0.0, float(trigger.get("value", default_value)))

    action = event.get("action")
    if not isinstance(action, dict):
        action = {}
    action_kind = action.get("type", "follow_trajectory")
    if action_kind not in {"follow_trajectory", "assign_route", "set_speed",
                           "set_distance", "lane_change", "lane_offset"}:
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
                f"{where}: assign_route is not available for actor type "
                f"'{actor_type}' — only vehicles may be routed"
            )
        route_strategy = action.get("route_strategy", "fastest")
        if route_strategy not in ROUTE_STRATEGIES:
            route_strategy = "fastest"
        waypoints = _normalize_waypoints(
            action.get("waypoints"), default_strategy=route_strategy)
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
        if mode == "relative":
            speed_target["entity_ref"] = _entity_ref(
                target.get("entity_ref"), actor_refs, valid_refs, where
            )
            speed_target["delta"] = max(-100.0, min(100.0, float(target.get("delta", 0.0))))
        else:
            speed_target["value"] = max(0.0, min(100.0, float(target.get("value", 10.0))))
        dimension = dynamics.get("dimension", "time")
        if dimension not in {"distance", "time", "rate"}:
            dimension = "time"
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
            "entity_ref": _entity_ref(
                action.get("entity_ref"), actor_refs, valid_refs, where, forbid=self_ref
            ),
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

    for idx, event in enumerate(actor["events"]):
        if not isinstance(event, dict):
            actor["events"][idx] = event = {}
        event.setdefault("id", f"event_{idx + 1}")
        _normalize_structured_event(
            event, actor_refs, valid_refs, f"{where}.events[{idx}]",
            self_ref=entity_name,
            actor_type=str(actor.get("type", "car")),
        )


def _after_event_target(trigger: dict, owner_entity: str) -> tuple[str, str]:
    """The (entity_name, event_id) an after_event trigger points at.

    _normalize_structured_event always fills actor_ref in, but this also has to
    read a trigger it has already rewritten, and the ego rewrite drops the key.
    """
    return (str(trigger.get("actor_ref") or owner_entity), str(trigger.get("event_id", "")))


def _normalize_after_event_chains(actors: list[tuple[dict, str, str]]) -> None:
    """The two silent after_event rewrites, plus cycle rejection — all three
    scenario-wide, because an after_event trigger may name an event on ANOTHER
    actor.

    `actors` is [(actor, entity_name, where)] over the ego and every NPC.

    These used to run per actor at the end of _normalize_actor. That was
    correct only while a reference could not leave its own actor: a trigger
    chained onto another actor's assign_route would otherwise keep a start
    condition the file does not contain.
    """
    events_by_ref: dict[tuple[str, str], dict] = {}
    for actor, entity_name, _where in actors:
        for event in actor["events"]:
            events_by_ref[(entity_name, str(event.get("id")))] = event

    # An assign_route's own trigger is forced to simulation_time@0, so "after
    # the route" names a start condition that is discarded — the reference is
    # rewritten to an ego-distance instead of left pointing at it.
    route_refs = {
        ref for ref, event in events_by_ref.items()
        if event.get("action", {}).get("type") == "assign_route"
    }
    for ref, event in events_by_ref.items():
        trigger = event.get("trigger", {})
        if trigger.get("type") != "after_event":
            continue
        if _after_event_target(trigger, ref[0]) in route_refs:
            event["trigger"] = {"type": "distance_to_ego", "value": 400.0}

    # A lane_offset is always emitted continuous="true" (the only mode that does
    # anything with an AbsoluteTargetLaneOffset), so its Event never completes
    # on its own and "after the Spurversatz" is not a start condition the editor
    # offers at all. Rejected outright rather than rewritten: unlike a route
    # there is no stand-in trigger that says the same thing.
    offset_refs = {
        ref for ref, event in events_by_ref.items()
        if event.get("action", {}).get("type") == "lane_offset"
    }
    for ref, event in events_by_ref.items():
        trigger = event.get("trigger", {})
        if trigger.get("type") != "after_event":
            continue
        target_ref = _after_event_target(trigger, ref[0])
        if target_ref in offset_refs:
            raise ValueError(
                f"{ref[0]}.{ref[1]}: after_event waits for lane_offset "
                f"{target_ref[0]}.{target_ref[1]}, which never completes — "
                f"use a simulation_time or distance trigger instead"
            )

    # A cycle is not a smaller scenario, it is a dead one: every event on the
    # loop waits for a completeState that can never arrive, with nothing in the
    # file or the run log to say why. The editor's own dropdown cannot build
    # one (ScenarioRules.afterEventCycleKeys, frontend/js/app.js), so this
    # catches a save file, a hand-written payload or an LLM one. Each event has
    # exactly one trigger, hence at most one outgoing edge — a plain walk finds
    # the loop without a full SCC pass.
    for start_ref, start_event in events_by_ref.items():
        chain = [start_ref]
        ref, event = start_ref, start_event
        while True:
            trigger = event.get("trigger", {})
            if trigger.get("type") != "after_event":
                break
            target_ref = _after_event_target(trigger, ref[0])
            target = events_by_ref.get(target_ref)
            if target is None:
                break
            if target_ref in chain:
                loop = " -> ".join(
                    f"{ent}.{eid}" for ent, eid in (*chain[chain.index(target_ref):], target_ref)
                )
                raise ValueError(
                    f"after_event triggers form a cycle ({loop}) — every event on "
                    f"it waits for one that never completes"
                )
            chain.append(target_ref)
            ref, event = target_ref, target

    # Must run LAST, after the assign_route rewrite above: the ego cannot gate
    # on its own distance to itself (always 0, fires on tick 1), so any
    # distance_to_ego trigger it ends up with — direct or rewritten — becomes
    # a plain simulation_time start instead.
    for actor, entity_name, _where in actors:
        if entity_name != "hero":
            continue
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

    scenario_actors = [(ego, "hero", "ego")]
    for npc_idx, npc in enumerate(params["npcs"]):
        npc.setdefault("type", "car")
        npc_name = "adversary" if npc_idx == 0 else f"adversary{npc_idx}"
        _normalize_actor(npc, npc_name, actor_refs, valid_refs, f"npcs[{npc_idx}]")
        scenario_actors.append((npc, npc_name, f"npcs[{npc_idx}]"))

    # Scenario-wide, so it must come after every actor is normalised: an
    # after_event trigger may point at another actor's event.
    _normalize_after_event_chains(scenario_actors)

    # An actor with no events gets no <Act> at all (xml_builder._build_actor_act),
    # so a scenario in which nothing has events emits a <Story> with zero Acts:
    # XSD-invalid, and there would be nothing for ScenarioRunner to run — the
    # storyboard would complete on the first tick. Rejected rather than coerced,
    # same policy as an unknown prop id or a dangling entity_ref, because the
    # alternative is a clean file that silently does nothing. Checked *after*
    # normalisation so it sees the events that actually survive it, and traffic
    # signals count: _inject_traffic_signals emits a ScenarioBehavior Act of its
    # own, which is a real scenario even with every actor inert.
    if not any(actor.get("events") for actor in [ego, *params["npcs"]]) and not any(
        signal["events"] for signal in params["trafficSignals"]
    ):
        raise ValueError(
            "No actor has any events — the scenario would end immediately. "
            "Add at least one event before exporting."
        )

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
