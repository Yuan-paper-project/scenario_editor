"""Whitelists, entity-ref resolution and the scenario-wide event-reference rules shared by the normalisers."""

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
            f"{where}: entity_ref '{raw}' names no entity in this scenario (expected one of {sorted(valid_refs)})"
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
# frontend/js/scenarioRules.js; the three must stay in step. 'ego' is here because a saved
# scenario carries the literal type (the frontend exports it as 'car').
#
# The emitter runs the type through _TYPE_ALIASES first, so the aliases that
# resolve to a routable type are listed too — without 'lorry' and 'moped' this
# would reject payloads the emitter is perfectly happy with. 'cyclist' and
# 'bicycle' alias to 'bike', which is not routable, so their absence is correct.
_ROUTE_ACTOR_TYPES = {
    "car",
    "van",
    "truck",
    "bus",
    "motorcycle",
    "scooter",
    "police",
    "ambulance",
    "firetruck",
    "ego",
    "lorry",
    "moped",
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
# Same split as xml_builder._PEDESTRIAN_TYPES and mapMarkers.js's WALKER_TYPES.
_WALKER_ACTOR_TYPES = {"pedestrian", "child"}

# A lane is ~3.5 m wide, so 10 m covers an oncoming-lane overtake with room to
# spare while still rejecting a value that would put the actor off the road
# entirely. The magnitude is unsigned in the payload — `direction` carries the
# side, exactly as it does for lane_change — and the emitter applies the sign.
_MAX_LANE_OFFSET_M = 10.0

# Triggers that name another storyboard event by (actor_ref, event_id).
# after_event fires on the target's completeState, event_started on its
# startTransition; ScenarioRunner writes both to the same global blackboard
# ('(EVENT)<name>-END' / '-START'), so the two share every rule below except the
# lane_offset ban, which is about completion only.
_EVENT_REF_TRIGGERS = {"after_event", "event_started"}

# simple_vehicle_control rate limits, see _normalize_actor and
# xml_builder._DYNAMICS_DEFAULTS (same numbers).
_DYNAMICS_DEFAULTS = {"max_acceleration": 3.0, "max_deceleration": 10.0}


def _never_completes(action: dict) -> bool:
    """True for an action whose Event never reports completeState on its own:
    a held lane_offset (continuous) and a continuous relative set_speed. Both
    end only when superseded, so after_event may not name one. Mirrored by
    ScenarioRules.neverCompletes (frontend/js/scenarioRules.js)."""
    kind = action.get("type")
    if kind == "lane_offset":
        return action.get("continuous") is not False
    if kind == "set_speed":
        target = action.get("target") or {}
        return target.get("mode") == "relative" and target.get("continuous") is True
    return False


_TRIGGER_KINDS = {
    "simulation_time",
    "distance_to_ego",
    "distance_to_point",
    "ego_speed",
    "relative_speed",
    *_EVENT_REF_TRIGGERS,
}
# SpeedCondition rules offered for ego_speed. equalTo is valid OpenSCENARIO but
# a measured speed is almost never exactly equal to anything.
_EGO_SPEED_RULES = {"greaterThan", "lessThan"}


def _after_event_target(trigger: dict, owner_entity: str) -> tuple[str, str]:
    """The (entity_name, event_id) an event-reference trigger points at.

    _normalize_structured_event always fills actor_ref in, but this also has to
    read a trigger it has already rewritten, and the ego rewrite drops the key.
    """
    return (str(trigger.get("actor_ref") or owner_entity), str(trigger.get("event_id", "")))


def _normalize_after_event_chains(actors: list[tuple[dict, str, str]]) -> None:
    """The scenario-wide rules for triggers that name another event
    (after_event and event_started): two silent rewrites, the NPC->ego ban,
    the lane_offset ban and cycle rejection — all scenario-wide, because such a
    trigger may name an event on ANOTHER actor.

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

    def is_ref(event):
        return event.get("trigger", {}).get("type") in _EVENT_REF_TRIGGERS

    # An assign_route's own trigger is forced to simulation_time@0, so "after
    # the route" (or "when the route starts") names a start condition that is
    # discarded — the reference is rewritten to an ego-distance instead of
    # left pointing at it.
    route_refs = {ref for ref, event in events_by_ref.items() if event.get("action", {}).get("type") == "assign_route"}
    for ref, event in events_by_ref.items():
        if not is_ref(event):
            continue
        if _after_event_target(event["trigger"], ref[0]) in route_refs:
            event["trigger"] = {"type": "distance_to_ego", "value": 400.0}

    # An NPC may not wait on an ego event. The ego may be driven by the AV
    # under test, whose run has no ego storyboard events at all — an NPC
    # chained onto one would never move, in a file that looks perfectly
    # well formed. An NPC reacts to the ego through what the ego does
    # (distance_to_ego, distance_to_point, ego_speed). Runs after the route
    # rewrite: a reference to the ego's route is no longer a reference.
    # Mirrored by ScenarioRules.mayWaitOnActor (frontend/js/scenarioRules.js).
    for ref, event in events_by_ref.items():
        if not is_ref(event) or ref[0] == "hero":
            continue
        target_ref = _after_event_target(event["trigger"], ref[0])
        if target_ref[0] == "hero":
            raise ValueError(
                f"{ref[0]}.{ref[1]}: {event['trigger']['type']} waits for the "
                f"ego's event {target_ref[1]} — an NPC may not depend on an ego "
                f"event (an AV-driven ego has none); use distance_to_ego, "
                f"distance_to_point or ego_speed instead"
            )

    # A held lane_offset and a continuous relative set_speed never complete on
    # their own (_never_completes), so "after" either one is not a start
    # condition the editor offers at all. Rejected outright rather than
    # rewritten: unlike a route there is no stand-in trigger that says the same
    # thing. Their START is well defined, so event_started may name one.
    offset_refs = {ref for ref, event in events_by_ref.items() if _never_completes(event.get("action", {}))}
    for ref, event in events_by_ref.items():
        trigger = event.get("trigger", {})
        if trigger.get("type") != "after_event":
            continue
        target_ref = _after_event_target(trigger, ref[0])
        if target_ref in offset_refs:
            raise ValueError(
                f"{ref[0]}.{ref[1]}: after_event waits for "
                f"{events_by_ref[target_ref]['action']['type']} "
                f"{target_ref[0]}.{target_ref[1]}, which never completes — "
                f"use a simulation_time or distance trigger instead"
            )

    # A cycle is not a smaller scenario, it is a dead one: every event on the
    # loop waits for a state change that can never arrive, with nothing in the
    # file or the run log to say why. The editor's own dropdown cannot build
    # one (ScenarioRules.canWaitFor, frontend/js/scenarioRules.js), so this catches a
    # save file, a hand-written payload or an LLM one. Each event has exactly
    # one trigger, hence at most one outgoing edge — a plain walk finds the loop
    # without a full SCC pass. after_event and event_started edges are walked
    # alike: "starts when the other starts" round a loop never fires either.
    for start_ref, start_event in events_by_ref.items():
        chain = [start_ref]
        ref, event = start_ref, start_event
        while True:
            if not is_ref(event):
                break
            target_ref = _after_event_target(event["trigger"], ref[0])
            target = events_by_ref.get(target_ref)
            if target is None:
                break
            if target_ref in chain:
                loop = " -> ".join(f"{ent}.{eid}" for ent, eid in (*chain[chain.index(target_ref) :], target_ref))
                raise ValueError(
                    f"event triggers form a cycle ({loop}) — every event on it waits for one that never fires"
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
            trigger = event.get("trigger", {})
            if trigger.get("type") == "distance_to_ego" and trigger.get("entity_ref") in (None, "", "hero"):
                event["trigger"] = {"type": "simulation_time", "value": 0.0}
