"""Whitelists, entity-ref resolution and the scenario-wide event-reference rules shared by the normalisers."""

# A waypoint's strategy governs the leg ENDING at it. "shortest" is appended verbatim (what a
# FollowTrajectoryAction becomes); anything else is routed. The XSD's other two values fold into
# "fastest": ScenarioRunner treats everything but "shortest" as the planner.
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
    """Resolve an internal 'obj-N' id to its OpenSCENARIO entity name, or raise a 400.

    An unresolved ref would leave the condition matching no actor, so it never fires.
    valid_refs comes from the npc count, so a payload naming 'adversary1' directly validates.
    `forbid` rejects the acting entity itself (set_distance against yourself succeeds at once),
    including an omitted ref that would fall back to it.
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


# Types AssignRouteAction accepts; mirrors event_builders._ROUTE_ACTION_TYPES and scenarioRules.js.
# Includes the aliases the emitter resolves to a routable type (lorry, moped); 'ego' because a
# saved scenario may carry it literally.
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
# Types that ignore a lane offset (PedestrianControl never reads it). Wider than the route set:
# a cyclist is a <Vehicle> and honours it. Same split as xml_builder._PEDESTRIAN_TYPES.
_WALKER_ACTOR_TYPES = {"pedestrian", "child"}

# Room for an oncoming-lane overtake without leaving the road; the magnitude is unsigned.
_MAX_LANE_OFFSET_M = 10.0

# Triggers naming another event: after_event (its completion) and event_started (its start).
# They share every rule below except the lane_offset ban, which is about completion.
_EVENT_REF_TRIGGERS = {"after_event", "event_started"}

# Same numbers as xml_builder._DYNAMICS_DEFAULTS.
_DYNAMICS_DEFAULTS = {"max_acceleration": 3.0, "max_deceleration": 10.0}


def _never_completes(action: dict) -> bool:
    """True for an action that never completes on its own (held lane_offset, continuous follow).

    Mirrored by ScenarioRules.neverCompletes.
    """
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
# equalTo is left out: a measured speed is almost never exactly equal.
_EGO_SPEED_RULES = {"greaterThan", "lessThan"}


def _after_event_target(trigger: dict, owner_entity: str) -> tuple[str, str]:
    """The (entity_name, event_id) an event-reference trigger points at (actor_ref absent = owner)."""
    return (str(trigger.get("actor_ref") or owner_entity), str(trigger.get("event_id", "")))


# The rules run in a fixed order (see the docstring); one function keeps it readable.
def _normalize_after_event_chains(actors: list[tuple[dict, str, str]]) -> None:  # pylint: disable=too-many-branches
    """Scenario-wide rules for event references, which may name another actor's event.

    `actors` is [(actor, entity_name, where)] over the ego and every NPC. Order matters: route
    rewrite, NPC→ego ban, lane_offset ban, cycle check, ego self-distance coercion.
    """
    events_by_ref: dict[tuple[str, str], dict] = {}
    for actor, entity_name, _where in actors:
        for event in actor["events"]:
            events_by_ref[(entity_name, str(event.get("id")))] = event

    def is_ref(event):
        return event.get("trigger", {}).get("type") in _EVENT_REF_TRIGGERS

    # A route's own trigger is discarded at export, so a reference to it becomes an ego distance.
    route_refs = {ref for ref, event in events_by_ref.items() if event.get("action", {}).get("type") == "assign_route"}
    for ref, event in events_by_ref.items():
        if not is_ref(event):
            continue
        if _after_event_target(event["trigger"], ref[0]) in route_refs:
            event["trigger"] = {"type": "distance_to_ego", "value": 400.0}

    # An NPC may not wait on an ego event: an AV-driven ego has none, and the NPC would never
    # move. After the route rewrite, so a reference to the ego's route is not caught.
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

    # "After" a never-completing event: rejected, since no stand-in trigger means the same.
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

    # A cycle never fires and nothing says why. One trigger per event makes the graph
    # functional, so a forward walk finds a loop; both reference kinds are edges.
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

    # Last, after the route rewrite: a distance from the ego to itself fires on tick 1.
    for actor, entity_name, _where in actors:
        if entity_name != "hero":
            continue
        for event in actor["events"]:
            trigger = event.get("trigger", {})
            if trigger.get("type") == "distance_to_ego" and trigger.get("entity_ref") in (None, "", "hero"):
                event["trigger"] = {"type": "simulation_time", "value": 0.0}
