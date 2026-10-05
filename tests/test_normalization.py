"""Backend event normalization: the silent coercions, in isolation.

No browser, no simulator, no HTTP — direct calls into backend/scenario_io.py.
Runs in milliseconds, so this is the layer to run on every edit.

Why it exists: _normalize_structured_event coerces rather than raises. A typo'd
action name becomes follow_trajectory, a typo'd trigger becomes simulation_time,
and two triggers get silently rewritten to something else entirely. Every one of
those is intentional, and every one is invisible at runtime — the scenario
exports cleanly and the actor just does nothing surprising. These assertions
pin the intended behaviour down so a change to it has to be deliberate.

    .venv/bin/python3 tests/test_normalization.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _harness import Checks  # noqa: E402
from backend.scenario_io import validate_scenario_params  # noqa: E402

check = Checks()


def norm(events, npcs=None, ego_id="obj-1"):
    """Run validate_scenario_params over one NPC's events; return them back."""
    params = {
        "map": "Town01",
        "ego": {"id": ego_id, "type": "car", "x": 1.0, "y": 2.0},
        "npcs": npcs if npcs is not None else [
            {"id": "obj-2", "type": "car", "x": 3.0, "y": 4.0, "events": events},
        ],
    }
    return validate_scenario_params(params)


def norm_ego(events, ego_extra=None, npcs=None):
    """Run validate_scenario_params over the ego's events; return the params back.

    Mirrors norm() but targets the ego — the ego is a scenario actor with the
    entity name 'hero', not a special case, so it goes through the identical
    _normalize_actor() path as an NPC. The one place it differs is
    distance_to_ego, which is meaningless for the ego itself (see below).
    """
    ego = {"id": "obj-1", "type": "car", "x": 1.0, "y": 2.0, "events": events}
    if ego_extra:
        ego.update(ego_extra)
    params = {
        "map": "Town01",
        "ego": ego,
        "npcs": npcs if npcs is not None else [],
    }
    return validate_scenario_params(params)


# validate_scenario_params rejects a payload in which nothing has events at all
# — every actor would contribute zero Acts and the storyboard would complete on
# the first tick. The default-checking payloads below are about one actor's own
# fields, so they carry this second actor whose only job is to hold an event and
# keep the scenario exportable.
KEEPALIVE_NPC = {
    "id": "obj-9", "type": "car", "x": 9.0, "y": 9.0,
    "events": [{"id": "k1", "trigger": {"type": "simulation_time", "value": 0},
                "action": {"type": "set_speed"}}],
}


def raises(fn):
    try:
        fn()
        return False
    except ValueError:
        return True


# ── Unknown action / trigger are coerced, not rejected ───────────────────────

out = norm([{"id": "e1", "trigger": {"type": "nonsense"},
             "action": {"type": "also_nonsense",
                        "trajectory": [{"x": 0, "y": 0}, {"x": 10, "y": 0}]}}])
ev = out["npcs"][0]["events"][0]
check("unknown action coerces to follow_trajectory",
      ev["action"]["type"] == "follow_trajectory", ev["action"]["type"])
check("unknown trigger coerces to simulation_time",
      ev["trigger"]["type"] == "simulation_time", ev["trigger"]["type"])
check("the coerced follow_trajectory keeps its waypoints",
      len(ev["action"]["trajectory"]) == 2, str(ev["action"]["trajectory"]))

# The coercion above is only half the story: a typo'd action name that carries
# no trajectory coerces to a follow_trajectory with nothing to follow. That used
# to export cleanly and vanish inside the emitter (the action builder returns
# False under 2 waypoints, and build_custom_event_chain skips the whole event).
# It is now rejected, so the typo is named once instead of surfacing as an actor
# that mysteriously does nothing.
check("unknown action with no trajectory is rejected, not silently dropped",
      raises(lambda: norm([{"id": "e1", "trigger": {"type": "nonsense"},
                            "action": {"type": "also_nonsense"}}])))


# ── Path actions the emitter would drop are rejected ─────────────────────────

check("follow_trajectory with 0 waypoints is rejected",
      raises(lambda: norm([{"id": "e1", "trigger": {"type": "simulation_time"},
                            "action": {"type": "follow_trajectory", "trajectory": []}}])))
check("follow_trajectory with 1 waypoint is rejected",
      raises(lambda: norm([{"id": "e1", "trigger": {"type": "simulation_time"},
                            "action": {"type": "follow_trajectory",
                                       "trajectory": [{"x": 1, "y": 2}]}}])))
check("assign_route with 1 waypoint is rejected",
      raises(lambda: norm([{"id": "e1", "trigger": {"type": "simulation_time"},
                            "action": {"type": "assign_route",
                                       "waypoints": [{"x": 1, "y": 2}]}}])))

# AssignRouteAction is vehicle-only (_ROUTE_ACTION_TYPES in event_builders.py);
# on a walker the builder returns False and the event disappears.
check("assign_route on a pedestrian is rejected",
      raises(lambda: norm([{"id": "e1", "trigger": {"type": "simulation_time"},
                            "action": {"type": "assign_route",
                                       "waypoints": [{"x": 1, "y": 2}, {"x": 3, "y": 4}]}}],
                          npcs=[{"id": "obj-2", "type": "pedestrian", "x": 3.0, "y": 4.0,
                                 "events": [{"id": "e1",
                                             "trigger": {"type": "simulation_time"},
                                             "action": {"type": "assign_route",
                                                        "waypoints": [{"x": 1, "y": 2},
                                                                      {"x": 3, "y": 4}]}}]}])))

# 'lorry' aliases to 'truck', which IS routable — the alias table runs before
# the emitter's own check, so the backend copy has to know about it too.
out = norm([], npcs=[{"id": "obj-2", "type": "lorry", "x": 3.0, "y": 4.0,
                      "events": [{"id": "e1", "trigger": {"type": "simulation_time"},
                                  "action": {"type": "assign_route",
                                             "waypoints": [{"x": 1, "y": 2},
                                                           {"x": 3, "y": 4}]}}]}])
check("assign_route on an alias of a routable type is allowed",
      out["npcs"][0]["events"][0]["action"]["type"] == "assign_route")


# ── Per-waypoint routeStrategy ───────────────────────────────────────────────
#
# A waypoint's strategy governs the LEG THAT ENDS AT IT: 'shortest' is appended
# to the route verbatim and driven as a straight line (exactly what
# FollowTrajectoryAction becomes — its parser tags every vertex 'shortest'),
# anything else routes that leg through the GlobalRoutePlanner. Mixing them is
# how one path action expresses both.

def route(waypoints, strategy=None):
    action = {"type": "assign_route", "waypoints": waypoints}
    if strategy is not None:
        action["route_strategy"] = strategy
    return norm([{"id": "e1", "trigger": {"type": "simulation_time"}, "action": action}])


WP = [{"x": 1, "y": 2}, {"x": 3, "y": 4}, {"x": 5, "y": 6}]

out = route(WP)
check("a waypoint with no strategy defaults to fastest",
      [w["strategy"] for w in out["npcs"][0]["events"][0]["action"]["waypoints"]]
      == ["fastest"] * 3)

out = route([WP[0], {**WP[1], "strategy": "shortest"}, WP[2]])
check("a per-waypoint strategy survives normalization",
      [w["strategy"] for w in out["npcs"][0]["events"][0]["action"]["waypoints"]]
      == ["fastest", "shortest", "fastest"])

# The XSD also allows leastIntersections and random, but ScenarioRunner treats
# everything that is not 'shortest' as the planner — so folding them into
# 'fastest' changes the file without changing what CARLA does.
out = route([WP[0], {**WP[1], "strategy": "leastIntersections"}, WP[2]])
check("an unsupported strategy folds into fastest",
      out["npcs"][0]["events"][0]["action"]["waypoints"][1]["strategy"] == "fastest")

# The one hard rule. Waypoint 0's leg runs from the actor's own pose to itself,
# so on an editor-built route the choice is meaningless — but 'shortest' there
# leaves ChangeActorWaypoints.initialise's `ego_next_wp` unbound on the first
# routed leg and kills the run with an UnboundLocalError, on stock 0.9.15 as
# well as here. Rejected rather than coerced: a payload the editor did not build
# may have no waypoint on the actor at all, and rewriting its first leg from a
# straight line into a routed one hands back a different scenario.
check("a route whose first waypoint is shortest is rejected",
      raises(lambda: route([{**WP[0], "strategy": "shortest"}, WP[1]])))
check("action-level route_strategy=shortest is rejected the same way",
      raises(lambda: route([WP[0], WP[1]], strategy="shortest")))
check("shortest on a later waypoint is fine",
      route([WP[0], WP[1], {**WP[2], "strategy": "shortest"}])
      ["npcs"][0]["events"][0]["action"]["waypoints"][2]["strategy"] == "shortest")

# follow_trajectory vertices carry no strategy at all — the emitter writes a
# Polyline, not a Route, and a stray key would be silently dropped anyway.
out = norm([{"id": "e1", "trigger": {"type": "simulation_time"},
             "action": {"type": "follow_trajectory",
                        "trajectory": [{"x": 1, "y": 2, "strategy": "shortest"},
                                       {"x": 3, "y": 4}]}}])
check("a trajectory vertex carries no strategy",
      all("strategy" not in w
          for w in out["npcs"][0]["events"][0]["action"]["trajectory"]))


# ── Trigger defaults ─────────────────────────────────────────────────────────

out = norm([{"id": "e1", "trigger": {"type": "distance_to_ego"},
             "action": {"type": "set_speed"}}])
check("distance_to_ego defaults to 400 m",
      out["npcs"][0]["events"][0]["trigger"]["value"] == 400.0,
      str(out["npcs"][0]["events"][0]["trigger"]["value"]))

out = norm([{"id": "e1", "trigger": {"type": "simulation_time"},
             "action": {"type": "set_speed"}}])
check("simulation_time defaults to 0 s",
      out["npcs"][0]["events"][0]["trigger"]["value"] == 0.0)

out = norm([{"id": "e1", "trigger": {"type": "distance_to_ego", "value": -5},
             "action": {"type": "set_speed"}}])
check("negative trigger distance clamps to 0",
      out["npcs"][0]["events"][0]["trigger"]["value"] == 0.0)


# ── distance_to_point defaults its triggering entity to the ego ──────────────
# The whole point of the trigger is "when the EGO reaches this spot"; leaving
# entity_ref unset must not silently make the NPC trigger off its own position.

out = norm([{"id": "e1",
             "trigger": {"type": "distance_to_point", "value": 25,
                         "point": {"name": "P", "x": 10, "y": 20}},
             "action": {"type": "set_speed"}}])
trig = out["npcs"][0]["events"][0]["trigger"]
check("distance_to_point with no entity_ref defaults to hero",
      trig["entity_ref"] == "hero", trig.get("entity_ref"))
check("distance_to_point keeps its point", (trig["point"]["x"], trig["point"]["y"]) == (10.0, 20.0),
      str(trig["point"]))
check("distance_to_point defaults z to 0.2", trig["point"]["z"] == 0.2, str(trig["point"]["z"]))

out = norm([{"id": "e1",
             "trigger": {"type": "distance_to_point", "value": 25,
                         "entity_ref": "obj-2", "point": {"x": 0, "y": 0}},
             "action": {"type": "set_speed"}}])
check("distance_to_point maps an explicit npc id to its entity ref",
      out["npcs"][0]["events"][0]["trigger"]["entity_ref"] == "adversary",
      out["npcs"][0]["events"][0]["trigger"]["entity_ref"])

# A point-less trigger used to be defaulted to (0, 0, 0.2) — the map origin.
# DistanceCondition is 3-D, so that is a real condition measured against a
# corner of the town: it never becomes true, and reads as a badly tuned radius
# rather than an unfinished event. The editor now places the point on the actor
# the moment the trigger is chosen, so this only guards loaded/LLM payloads.
check("distance_to_point with an empty point is rejected",
      raises(lambda: norm([{"id": "e1",
                            "trigger": {"type": "distance_to_point", "value": 25, "point": {}},
                            "action": {"type": "set_speed"}}])))
check("distance_to_point with no point at all is rejected",
      raises(lambda: norm([{"id": "e1",
                            "trigger": {"type": "distance_to_point", "value": 25},
                            "action": {"type": "set_speed"}}])))


# ── The two silent trigger rewrites ──────────────────────────────────────────

out = norm([{"id": "e1", "trigger": {"type": "simulation_time", "value": 30},
             "action": {"type": "assign_route",
                        "waypoints": [{"x": 1, "y": 2}, {"x": 3, "y": 4}]}}])
trig = out["npcs"][0]["events"][0]["trigger"]
check("assign_route overrides its own trigger to simulation_time@0",
      trig == {"type": "simulation_time", "value": 0.0}, str(trig))

out = norm([
    {"id": "route", "trigger": {"type": "simulation_time", "value": 0},
     "action": {"type": "assign_route",
                "waypoints": [{"x": 1, "y": 2}, {"x": 3, "y": 4}]}},
    {"id": "after", "trigger": {"type": "after_event", "event_id": "route"},
     "action": {"type": "set_speed"}},
])
trig = out["npcs"][0]["events"][1]["trigger"]
check("after_event pointing at an assign_route becomes distance_to_ego@400",
      trig == {"type": "distance_to_ego", "value": 400.0}, str(trig))

out = norm([
    {"id": "spd", "trigger": {"type": "distance_to_ego", "value": 50},
     "action": {"type": "set_speed"}},
    {"id": "after", "trigger": {"type": "after_event", "event_id": "spd"},
     "action": {"type": "set_speed"}},
])
trig = out["npcs"][0]["events"][1]["trigger"]
check("after_event pointing at a non-route event is left alone",
      trig["type"] == "after_event" and trig["event_id"] == "spd", str(trig))


# ── Action payload clamps and defaults ───────────────────────────────────────

out = norm([{"id": "e1", "trigger": {"type": "simulation_time"},
             "action": {"type": "set_speed",
                        "target": {"mode": "absolute", "value": 500}}}])
check("absolute speed clamps to 100",
      out["npcs"][0]["events"][0]["action"]["target"]["value"] == 100.0)

out = norm([{"id": "e1", "trigger": {"type": "simulation_time"},
             "action": {"type": "set_speed",
                        "target": {"mode": "absolute", "value": -20}}}])
check("negative absolute speed clamps to 0",
      out["npcs"][0]["events"][0]["action"]["target"]["value"] == 0.0)

out = norm([{"id": "e1", "trigger": {"type": "simulation_time"},
             "action": {"type": "set_speed",
                        "target": {"mode": "relative", "delta": -500}}}])
target = out["npcs"][0]["events"][0]["action"]["target"]
check("relative speed delta clamps to -100", target["delta"] == -100.0, str(target))
check("relative speed defaults its entity_ref to hero",
      target["entity_ref"] == "hero", str(target.get("entity_ref")))

out = norm([{"id": "e1", "trigger": {"type": "simulation_time"},
             "action": {"type": "set_speed",
                        "dynamics": {"shape": "step", "dimension": "furlongs", "value": 5}}}])
check("unknown dynamics dimension coerces to time",
      out["npcs"][0]["events"][0]["action"]["dynamics"]["dimension"] == "time")

out = norm([{"id": "e1", "trigger": {"type": "simulation_time"},
             "action": {"type": "set_speed",
                        "dynamics": {"shape": "step", "dimension": "rate", "value": 2.5}}}])
dyn = out["npcs"][0]["events"][0]["action"]["dynamics"]
check("rate dynamics dimension survives the whitelist",
      dyn["dimension"] == "rate", str(dyn))
# 'step' + 'rate' is self-contradictory; this runtime never reads dynamicsShape
# but the file should still say what it means.
check("rate dynamics forces a linear shape", dyn["shape"] == "linear", str(dyn))
check("rate dynamics keeps its value", dyn["value"] == 2.5, str(dyn))

# A rate of 0 makes ChangeActorTargetSpeed's ramp never reach its target, so the
# atomic never reports SUCCESS, the storyboard never completes and run.sh blocks
# forever in `wait`. The floor is that guard.
out = norm([{"id": "e1", "trigger": {"type": "simulation_time"},
             "action": {"type": "set_speed",
                        "dynamics": {"shape": "linear", "dimension": "rate", "value": 0}}}])
check("a rate of 0 floors to 0.1",
      out["npcs"][0]["events"][0]["action"]["dynamics"]["value"] == 0.1,
      str(out["npcs"][0]["events"][0]["action"]["dynamics"]))

out = norm([{"id": "e1", "trigger": {"type": "simulation_time"},
             "action": {"type": "set_speed",
                        "dynamics": {"shape": "linear", "dimension": "time", "value": 0}}}])
dyn = out["npcs"][0]["events"][0]["action"]["dynamics"]
check("the time dimension keeps its 0.0 floor and its shape",
      dyn["value"] == 0.0 and dyn["shape"] == "linear", str(dyn))

out = norm([{"id": "e1", "trigger": {"type": "simulation_time"},
             "action": {"type": "lane_change", "direction": "sideways"}}])
check("unknown lane_change direction coerces to left",
      out["npcs"][0]["events"][0]["action"]["direction"] == "left")

out = norm([{"id": "e1", "trigger": {"type": "simulation_time"},
             "action": {"type": "set_distance", "axis": "diagonal"}}])
check("unknown set_distance axis coerces to longitudinal",
      out["npcs"][0]["events"][0]["action"]["axis"] == "longitudinal")


# ── lane_offset ────────────────────────────────────────────────────────────────
# The payload carries an UNSIGNED magnitude plus a side, the same shape
# lane_change uses; the emitter applies the sign (positive = right of travel).

def offset(action_extra, npc_type="car"):
    return norm([{"id": "e1", "trigger": {"type": "simulation_time"},
                  "action": {"type": "lane_offset", **action_extra}}],
                npcs=[{"id": "obj-2", "type": npc_type, "x": 3.0, "y": 4.0,
                       "events": [{"id": "e1", "trigger": {"type": "simulation_time"},
                                   "action": {"type": "lane_offset", **action_extra}}]}])


act = offset({})["npcs"][0]["events"][0]["action"]
check("lane_offset defaults to 1 m left", act["direction"] == "left" and act["offset"] == 1.0,
      str(act))

act = offset({"direction": "sideways", "offset": 2.5})["npcs"][0]["events"][0]["action"]
check("unknown lane_offset direction coerces to left", act["direction"] == "left", str(act))

act = offset({"direction": "right", "offset": 40.0})["npcs"][0]["events"][0]["action"]
check("a lane_offset magnitude is clamped to 10 m", act["offset"] == 10.0, str(act))

act = offset({"direction": "right", "offset": -3.0})["npcs"][0]["events"][0]["action"]
check("a negative lane_offset magnitude floors at 0", act["offset"] == 0.0, str(act))

# PedestrianControl stores the controller offset and never reads it, so a walker
# would get a valid file in which it simply never moves sideways — rejected for
# the same reason assign_route is, rather than exported as a silent no-op.
check("lane_offset on a pedestrian raises",
      raises(lambda: offset({"direction": "left"}, npc_type="pedestrian")))
# A lane_offset is emitted continuous="true" and never ends on its own, so it is
# never a valid after_event target — rejected rather than rewritten, since there
# is no stand-in trigger that means the same thing.
check("an after_event waiting on a lane_offset raises",
      raises(lambda: norm([
          {"id": "e1", "trigger": {"type": "simulation_time"},
           "action": {"type": "lane_offset", "direction": "left", "offset": 1.0}},
          {"id": "e2", "trigger": {"type": "after_event", "event_id": "e1"},
           "action": {"type": "set_speed"}}])))
check("...even when a later lane_offset would supersede it",
      raises(lambda: norm([
          {"id": "e1", "trigger": {"type": "simulation_time"},
           "action": {"type": "lane_offset", "direction": "left", "offset": 1.0}},
          {"id": "e2", "trigger": {"type": "simulation_time", "value": 5},
           "action": {"type": "lane_offset", "direction": "left", "offset": 0.0}},
          {"id": "e3", "trigger": {"type": "after_event", "event_id": "e1"},
           "action": {"type": "set_speed"}}])))

check("lane_offset on a child raises",
      raises(lambda: offset({"direction": "left"}, npc_type="child")))
# Wider than the routable set on purpose: a cyclist aliases to 'bike', which is
# a <Vehicle> on simple_vehicle_control, so it honours an offset even though the
# route planner will not route it.
check("lane_offset on a cyclist is allowed, unlike assign_route",
      offset({"direction": "left"}, npc_type="cyclist")["npcs"][0]["events"][0]
      ["action"]["type"] == "lane_offset")


# ── Entity-ref mapping must match frontend buildScenarioParams() ─────────────
# scenarioIO.js duplicates this mapping; the two have to agree or an event's
# target silently points at the wrong actor.

params = {
    "map": "Town01",
    "ego": {"id": "obj-1", "type": "car", "x": 0, "y": 0},
    "npcs": [
        {"id": "obj-2", "type": "car", "x": 1, "y": 1, "events": [
            {"id": "e", "trigger": {"type": "simulation_time"},
             "action": {"type": "set_distance", "entity_ref": "obj-1"}}]},
        {"id": "obj-3", "type": "car", "x": 2, "y": 2, "events": [
            {"id": "e", "trigger": {"type": "simulation_time"},
             "action": {"type": "set_distance", "entity_ref": "obj-4"}}]},
        {"id": "obj-4", "type": "car", "x": 3, "y": 3, "events": [
            {"id": "e", "trigger": {"type": "simulation_time"},
             "action": {"type": "set_distance", "entity_ref": "obj-2"}}]},
    ],
}
out = validate_scenario_params(params)
refs = [n["events"][0]["action"]["entity_ref"] for n in out["npcs"]]
check("ego id maps to 'hero'", refs[0] == "hero", refs[0])
check("npc id obj-4 maps to 'adversary2'", refs[1] == "adversary2", refs[1])
check("npc id obj-2 maps to 'adversary'", refs[2] == "adversary", refs[2])

# A trigger's entity_ref goes through the same map as an action's. It used not
# to: buildScenarioParams remapped actions only and omitted ego.id, so the ego
# fell through both layers and '<EntityRef entityRef="obj-N"/>' reached the
# .xosc, where ScenarioRunner matches no actor and the condition never fires.
out = norm([{"id": "e1",
             "trigger": {"type": "distance_to_point", "value": 9.7,
                         "entity_ref": "obj-1", "point": {"x": -142.8, "y": 37.4}},
             "action": {"type": "set_speed"}}])
check("distance_to_point maps an explicit ego id to 'hero'",
      out["npcs"][0]["events"][0]["trigger"]["entity_ref"] == "hero",
      out["npcs"][0]["events"][0]["trigger"]["entity_ref"])

# An unresolvable ref used to be passed through verbatim, which is exactly how
# the bug above reached the file. It is a hard error now — same policy as an
# unknown actor type or prop id, and for the same reason: the value is an opaque
# string whose only symptom is a scenario that quietly does nothing.
check("an unresolvable action entity_ref raises",
      raises(lambda: norm([{"id": "e1", "trigger": {"type": "simulation_time"},
                            "action": {"type": "set_distance",
                                       "entity_ref": "obj-does-not-exist"}}])))
check("an unresolvable trigger entity_ref raises",
      raises(lambda: norm([{"id": "e1",
                            "trigger": {"type": "distance_to_point", "value": 25,
                                        "entity_ref": "obj-999", "point": {"x": 0, "y": 0}},
                            "action": {"type": "set_speed"}}])))

# Payloads the editor did not build may name entities directly rather than by
# internal id — valid_refs is derived from the npc count so those still pass.
out = norm([{"id": "e1", "trigger": {"type": "simulation_time"},
             "action": {"type": "set_distance", "entity_ref": "hero"}}])
check("an already-resolved 'hero' ref survives",
      out["npcs"][0]["events"][0]["action"]["entity_ref"] == "hero",
      out["npcs"][0]["events"][0]["action"]["entity_ref"])
out = norm([], npcs=[
    {"id": "obj-2", "type": "car", "x": 1, "y": 1},
    {"id": "obj-3", "type": "car", "x": 2, "y": 1, "events": [
        {"id": "e1", "trigger": {"type": "simulation_time"},
         "action": {"type": "set_distance", "entity_ref": "adversary"}}]},
])
check("an already-resolved 'adversary' ref survives",
      out["npcs"][1]["events"][0]["action"]["entity_ref"] == "adversary",
      out["npcs"][1]["events"][0]["action"]["entity_ref"])
check("a ref naming an adversary index that does not exist raises",
      raises(lambda: norm([{"id": "e1", "trigger": {"type": "simulation_time"},
                            "action": {"type": "set_distance",
                                       "entity_ref": "adversary7"}}])))


# ── NPC-level defaults ───────────────────────────────────────────────────────

out = norm([], npcs=[{"id": "obj-2", "type": "car", "x": 1, "y": 1}, KEEPALIVE_NPC])
npc = out["npcs"][0]
check("npc defaults z to 0.2", npc["z"] == 0.2)
check("npc defaults events to []", npc["events"] == [])
check("npc gets no behaviors key", "behaviors" not in npc, str(npc.keys()))
check("npc gets no trigger_distance key", "trigger_distance" not in npc, str(npc.keys()))

# initial_speed — the Init SpeedAction. The default is 0 and NOT the editor's
# placement default of 10: this function also normalises hand-written payloads,
# LLM output and every tests/carla_cases.py case, none of which mention the
# field, and defaulting those to 10 would put every previously stationary actor
# into motion at t=0.
check("npc defaults initial_speed to 0", npc["initial_speed"] == 0.0,
      str(npc.get("initial_speed")))

out = norm([], npcs=[{"id": "obj-2", "type": "car", "x": 1, "y": 1, "initial_speed": 12.5},
               KEEPALIVE_NPC])
check("initial_speed passes through intact", out["npcs"][0]["initial_speed"] == 12.5)
# ScenarioRunner's _get_actor_speed *raises* on a negative AbsoluteTargetSpeed
# in Init, so the floor is a real guard rather than tidiness.
out = norm([], npcs=[{"id": "obj-2", "type": "car", "x": 1, "y": 1, "initial_speed": -5},
               KEEPALIVE_NPC])
check("initial_speed clamps up to 0", out["npcs"][0]["initial_speed"] == 0.0)
out = norm([], npcs=[{"id": "obj-2", "type": "car", "x": 1, "y": 1, "initial_speed": 9999},
               KEEPALIVE_NPC])
check("initial_speed clamps down to 100", out["npcs"][0]["initial_speed"] == 100.0)

out = norm([{"trigger": {"type": "simulation_time"}, "action": {"type": "set_speed"}}])
check("an event with no id is given one",
      out["npcs"][0]["events"][0]["id"] == "event_1",
      out["npcs"][0]["events"][0].get("id"))


# ── Ego events go through the same normalization NPCs get ───────────────────
# The ego is a scenario actor with the entity name 'hero', not a special case
# — _normalize_actor() is shared. The one real difference: a distance_to_ego
# trigger measures the ego's distance to itself (always 0, fires on tick 1),
# so it is coerced to simulation_time@0 rather than left alone.

out = norm_ego([{"id": "e1", "trigger": {"type": "nonsense"},
                 "action": {"type": "also_nonsense",
                            "trajectory": [{"x": 0, "y": 0}, {"x": 10, "y": 0}]}}])
ev = out["ego"]["events"][0]
check("ego: unknown action coerces to follow_trajectory",
      ev["action"]["type"] == "follow_trajectory", ev["action"]["type"])
check("ego: unknown trigger coerces to simulation_time",
      ev["trigger"]["type"] == "simulation_time", ev["trigger"]["type"])

out = norm_ego([{"id": "e1", "trigger": {"type": "distance_to_ego", "value": 400},
                 "action": {"type": "set_speed"}}])
check("ego: distance_to_ego is coerced to simulation_time@0 (self-distance is always 0)",
      out["ego"]["events"][0]["trigger"] == {"type": "simulation_time", "value": 0.0},
      str(out["ego"]["events"][0]["trigger"]))

out = norm([{"id": "e1", "trigger": {"type": "distance_to_ego", "value": 123},
             "action": {"type": "set_speed"}}])
check("npc: distance_to_ego is left alone (npc-to-ego is a real distance)",
      out["npcs"][0]["events"][0]["trigger"] == {"type": "distance_to_ego", "value": 123.0},
      str(out["npcs"][0]["events"][0]["trigger"]))

# The distance_to_ego -> simulation_time coercion must also catch a trigger
# that becomes distance_to_ego via the after_event/assign_route rewrite —
# ordering regression: _normalize_actor runs the hero coercion AFTER that
# rewrite, not before, or this would slip through.
out = norm_ego([
    {"id": "route", "trigger": {"type": "simulation_time", "value": 0},
     "action": {"type": "assign_route",
                "waypoints": [{"x": 1, "y": 2}, {"x": 3, "y": 4}]}},
    {"id": "after", "trigger": {"type": "after_event", "event_id": "route"},
     "action": {"type": "set_speed"}},
])
trig = out["ego"]["events"][1]["trigger"]
check("ego: after_event onto assign_route still lands on simulation_time@0, not distance_to_ego",
      trig == {"type": "simulation_time", "value": 0.0}, str(trig))

# set_distance targeting the acting entity itself is a hard error for BOTH the
# ego and an NPC — KeepLongitudinalGap against yourself computes a gap of 0
# and succeeds on the first tick, a silent no-op.
check("ego: set_distance naming itself raises",
      raises(lambda: norm_ego([{"id": "e1", "trigger": {"type": "simulation_time"},
                                "action": {"type": "set_distance", "entity_ref": "obj-1"}}])))
check("ego: set_distance with entity_ref omitted raises (falls back to 'hero' = self)",
      raises(lambda: norm_ego([{"id": "e1", "trigger": {"type": "simulation_time"},
                                "action": {"type": "set_distance"}}])))
check("npc: set_distance naming itself raises",
      raises(lambda: norm([{"id": "e1", "trigger": {"type": "simulation_time"},
                            "action": {"type": "set_distance", "entity_ref": "obj-2"}}])))
check("ego: set_distance naming a real npc passes",
      not raises(lambda: norm_ego(
          [{"id": "e1", "trigger": {"type": "simulation_time"},
            "action": {"type": "set_distance", "entity_ref": "obj-2"}}],
          npcs=[{"id": "obj-2", "type": "car", "x": 5, "y": 5}])))

# Relative set_speed naming the acting entity itself is legal — "my current
# speed plus a delta" is a well-defined one-shot action, unlike set_distance.
out = norm_ego([{"id": "e1", "trigger": {"type": "simulation_time"},
                 "action": {"type": "set_speed",
                            "target": {"mode": "relative", "entity_ref": "obj-1", "delta": 5}}}])
check("ego: relative set_speed naming itself is allowed",
      out["ego"]["events"][0]["action"]["target"]["entity_ref"] == "hero",
      str(out["ego"]["events"][0]["action"]["target"]))

# distance_to_point naming the ego on an ego event is legitimate ("when I
# reach this spot") and must not be coerced or rejected.
out = norm_ego([{"id": "e1",
                 "trigger": {"type": "distance_to_point", "value": 10,
                             "entity_ref": "obj-1", "point": {"x": 5, "y": 5}},
                 "action": {"type": "set_speed"}}])
check("ego: distance_to_point naming itself is allowed",
      out["ego"]["events"][0]["trigger"]["entity_ref"] == "hero",
      out["ego"]["events"][0]["trigger"].get("entity_ref"))

# Ego-level defaults mirror the NPC ones exactly.
out = norm_ego([], npcs=[KEEPALIVE_NPC])
check("ego defaults events to []", out["ego"]["events"] == [])
check("ego gets no behaviors key", "behaviors" not in out["ego"], str(out["ego"].keys()))
check("ego gets no trigger_distance key", "trigger_distance" not in out["ego"],
      str(out["ego"].keys()))

check("ego defaults initial_speed to 0", out["ego"]["initial_speed"] == 0.0,
      str(out["ego"].get("initial_speed")))

out = norm_ego([], ego_extra={"initial_speed": -3}, npcs=[KEEPALIVE_NPC])
check("ego initial_speed clamps up to 0", out["ego"]["initial_speed"] == 0.0)
out = norm_ego([], ego_extra={"initial_speed": 9999}, npcs=[KEEPALIVE_NPC])
check("ego initial_speed clamps down to 100", out["ego"]["initial_speed"] == 100.0)

# route_waypoints, when omitted, is derived from the ego's own path event.
out = norm_ego([{"id": "e1", "trigger": {"type": "simulation_time", "value": 0},
                 "action": {"type": "follow_trajectory",
                            "trajectory": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 20, "y": 0}]}}])
check("route_waypoints derives from the ego's follow_trajectory event",
      [(w["x"], w["y"]) for w in out["route_waypoints"]] == [(0.0, 0.0), (10.0, 0.0), (20.0, 0.0)],
      str(out["route_waypoints"]))
check("derived route_waypoints carry a per-segment yaw",
      out["route_waypoints"][0]["yaw"] == 0.0, str(out["route_waypoints"][0]))

out = norm_ego([], npcs=[KEEPALIVE_NPC])
check("route_waypoints is empty when the ego has no path event",
      out["route_waypoints"] == [], str(out["route_waypoints"]))


# ── Hard errors (the few things that are NOT coerced) ────────────────────────

check("missing ego raises",
      raises(lambda: validate_scenario_params({"map": "Town01"})))
check("ego without coordinates raises",
      raises(lambda: validate_scenario_params(
          {"map": "Town01", "ego": {"type": "car"}})))
check("non-dict params raises", raises(lambda: validate_scenario_params([])))


# ── Actor types are whitelisted, unlike actions and triggers ─────────────────
# The asymmetry is deliberate. An action or trigger comes from a fixed grid in
# the UI and cannot be mistyped, so coercing a bad one is harmless. An actor
# type reaches the exporter as a free string and every lookup there falls back
# to `car`, so a typo would export a Lincoln MKZ and only look wrong once
# someone watched the simulation. Same policy as static props.

def npc_of(actor_type):
    # KEEPALIVE_NPC keeps the payload exportable: these cases are about the type
    # string alone, and a payload where nothing has events is rejected for an
    # entirely different reason.
    return lambda: validate_scenario_params({
        "map": "Town01",
        "ego": {"id": "obj-1", "type": "car", "x": 0, "y": 0},
        "npcs": [{"id": "obj-2", "type": actor_type, "x": 1, "y": 1},
                 dict(KEEPALIVE_NPC)],
    })


for known in ("car", "van", "truck", "bus", "motorcycle", "scooter",
              "police", "ambulance", "firetruck",
              "pedestrian", "child", "cyclist"):
    check(f"'{known}' is accepted as an actor type", not raises(npc_of(known)))

for alias in ("bike", "bicycle", "lorry", "moped"):
    check(f"alias '{alias}' is accepted", not raises(npc_of(alias)))

for bad in ("pedestrain", "Car", "nonsense", ""):
    check(f"unknown actor type {bad!r} raises", raises(npc_of(bad)))

# Surrounding whitespace is trimmed rather than rejected — it is a transport
# artefact, not a different type. Case is NOT: 'Car' is a typo, and accepting
# it would mean the exporter and the editor disagree about the key.
check("surrounding whitespace is trimmed off the type",
      npc_of(" car ")()["npcs"][0]["type"] == "car")

out = validate_scenario_params(
    {"ego": {"type": "car", "x": 0, "y": 0, "events": KEEPALIVE_NPC["events"]}})
check("map defaults to Town01", out["map"] == "Town01")
check("unknown time-of-day coerces to daytime",
      validate_scenario_params(
          {"ego": {"type": "car", "x": 0, "y": 0,
                   "events": KEEPALIVE_NPC["events"]}, "time": "midnightish"}
      )["time"] == "daytime")


# ── A scenario in which nothing has events is rejected ───────────────────────
# An actor with no events contributes no <Act>, so such a payload emits a
# storyboard with nothing in it: XSD-invalid, and it would complete on the first
# tick. Rejected rather than coerced, same policy as an unknown prop id or a
# dangling entity_ref — the alternative is a clean file that silently does
# nothing. This replaces the old constant_speed fallback chain.

def no_events_anywhere():
    return validate_scenario_params({
        "map": "Town01",
        "ego": {"id": "obj-1", "type": "car", "x": 0, "y": 0},
        "npcs": [{"id": "obj-2", "type": "car", "x": 1, "y": 1}],
    })


check("a payload where no actor has events raises", raises(no_events_anywhere))

check("one ego event is enough to make it exportable",
      not raises(lambda: validate_scenario_params({
          "map": "Town01",
          "ego": {"id": "obj-1", "type": "car", "x": 0, "y": 0,
                  "events": KEEPALIVE_NPC["events"]},
          "npcs": [{"id": "obj-2", "type": "car", "x": 1, "y": 1}],
      })))

check("one npc event is enough to make it exportable",
      not raises(lambda: validate_scenario_params({
          "map": "Town01",
          "ego": {"id": "obj-1", "type": "car", "x": 0, "y": 0},
          "npcs": [dict(KEEPALIVE_NPC)],
      })))

# A traffic-signal event is a real Act too (_inject_traffic_signals builds a
# ScenarioBehavior Act of its own), so it satisfies the rule even with every
# actor inert.
check("a traffic-signal event alone is enough",
      not raises(lambda: validate_scenario_params({
          "map": "Town01",
          "ego": {"id": "obj-1", "type": "car", "x": 0, "y": 0},
          "npcs": [],
          "trafficSignals": [{"id": "sig1", "x": 0, "y": 0,
                              "events": [{"id": "t1", "state": "red"}]}],
      })))


# ── Cross-actor after_event references, and the cycles they make possible ────
#
# An after_event trigger names `event_id` plus an optional `actor_ref`. Absent
# actor_ref means the event's own actor, so everything above this block — every
# save file, template and CARLA case predating the feature — resolves as it
# always did. Everything scenario-wide about after_event lives in
# _normalize_after_event_chains, which runs once after every actor is
# normalised; that ordering is what the cross-actor rewrites below pin down.

def _spd(eid, trigger):
    return {"id": eid, "trigger": trigger,
            "action": {"type": "set_speed",
                       "target": {"mode": "absolute", "value": 10},
                       "dynamics": {"dimension": "time", "value": 5}}}


def _route(eid):
    return {"id": eid, "trigger": {"type": "simulation_time", "value": 0},
            "action": {"type": "assign_route",
                       "waypoints": [{"x": 1, "y": 2}, {"x": 3, "y": 4}]}}


def _scene(ego_events, *npc_events):
    """One ego (obj-1) plus one NPC per events list (obj-2, obj-3, ...)."""
    return {
        "map": "Town01",
        "ego": {"id": "obj-1", "type": "car", "x": 0.0, "y": 0.0, "events": ego_events},
        "npcs": [
            {"id": f"obj-{idx + 2}", "type": "car", "x": 10.0 * (idx + 1), "y": 0.0,
             "events": list(events)}
            for idx, events in enumerate(npc_events)
        ],
    }


out = validate_scenario_params(_scene(
    [_spd("a", {"type": "simulation_time", "value": 1})],
    [_spd("b", {"type": "after_event", "event_id": "a", "actor_ref": "obj-1"})],
))
trig = out["npcs"][0]["events"][0]["trigger"]
check("after_event actor_ref is remapped obj-N -> entity name",
      trig == {"type": "after_event", "event_id": "a", "actor_ref": "hero"}, str(trig))

out = validate_scenario_params(_scene(
    [_spd("a", {"type": "simulation_time", "value": 1})],
    [_spd("b", {"type": "after_event", "event_id": "a"})],
))
trig = out["npcs"][0]["events"][0]["trigger"]
check("an omitted actor_ref resolves to the event's own actor",
      trig == {"type": "after_event", "event_id": "a", "actor_ref": "adversary"},
      str(trig))

# Event ids are unique only within an actor, so every actor's first event tends
# to be 'evt-1'. The reference must resolve by (actor, event), not by id alone.
out = validate_scenario_params(_scene(
    [_spd("evt-1", {"type": "simulation_time", "value": 1})],
    [_spd("evt-1", {"type": "after_event", "event_id": "evt-1", "actor_ref": "obj-1"})],
    [_spd("evt-1", {"type": "after_event", "event_id": "evt-1", "actor_ref": "obj-2"})],
))
refs = [npc["events"][0]["trigger"]["actor_ref"] for npc in out["npcs"]]
check("a colliding event id across actors resolves per actor, not by id",
      refs == ["hero", "adversary"], str(refs))

# The assign_route rewrite is scenario-wide now: it used to run per actor at the
# end of _normalize_actor, where a reference to ANOTHER actor's route was
# invisible and survived as an after_event naming a start condition the file
# discards.
out = validate_scenario_params(_scene(
    [_route("r")],
    [_spd("b", {"type": "after_event", "event_id": "r", "actor_ref": "obj-1"})],
))
trig = out["npcs"][0]["events"][0]["trigger"]
check("after_event onto ANOTHER actor's assign_route becomes distance_to_ego@400",
      trig == {"type": "distance_to_ego", "value": 400.0}, str(trig))

# ... and the hero self-distance coercion still runs after it, cross-actor too.
out = validate_scenario_params(_scene(
    [_spd("a", {"type": "after_event", "event_id": "r", "actor_ref": "obj-2"})],
    [_route("r")],
))
trig = out["ego"]["events"][0]["trigger"]
check("ego: after_event onto an NPC's assign_route lands on simulation_time@0",
      trig == {"type": "simulation_time", "value": 0.0}, str(trig))

check("an actor_ref naming no entity raises",
      raises(lambda: validate_scenario_params(_scene(
          [_spd("a", {"type": "simulation_time", "value": 1})],
          [_spd("b", {"type": "after_event", "event_id": "a", "actor_ref": "obj-99"})]))))

# Cycles. Every event on one waits for a completeState that never arrives, so
# none of them fires — a clean file that silently does nothing, which is the
# same reason a dangling entity_ref is rejected rather than coerced.
check("a same-actor after_event cycle raises",
      raises(lambda: validate_scenario_params(_scene(
          [_spd("a", {"type": "simulation_time", "value": 0})],
          [_spd("e1", {"type": "after_event", "event_id": "e2"}),
           _spd("e2", {"type": "after_event", "event_id": "e1"})]))))

check("a two-actor after_event cycle raises",
      raises(lambda: validate_scenario_params(_scene(
          [_spd("a", {"type": "after_event", "event_id": "b", "actor_ref": "obj-2"})],
          [_spd("b", {"type": "after_event", "event_id": "a", "actor_ref": "obj-1"})]))))

check("a three-actor after_event cycle raises",
      raises(lambda: validate_scenario_params(_scene(
          [_spd("a", {"type": "after_event", "event_id": "b", "actor_ref": "obj-2"})],
          [_spd("b", {"type": "after_event", "event_id": "c", "actor_ref": "obj-3"})],
          [_spd("c", {"type": "after_event", "event_id": "a", "actor_ref": "obj-1"})]))))

# An event pointing at itself is the degenerate one-node cycle, and the walk
# has to catch it on the first hop rather than looping.
check("an after_event pointing at its own event raises",
      raises(lambda: validate_scenario_params(_scene(
          [_spd("a", {"type": "simulation_time", "value": 0})],
          [_spd("e1", {"type": "after_event", "event_id": "e1"})]))))

# A chain is not a cycle, however long, and a diamond (two events waiting on the
# same one) must not be mistaken for one — the walk visits shared nodes twice.
check("a three-actor chain is accepted",
      not raises(lambda: validate_scenario_params(_scene(
          [_spd("a", {"type": "simulation_time", "value": 1})],
          [_spd("b", {"type": "after_event", "event_id": "a", "actor_ref": "obj-1"})],
          [_spd("c", {"type": "after_event", "event_id": "b", "actor_ref": "obj-2"})]))))

check("two events waiting on the same event is accepted",
      not raises(lambda: validate_scenario_params(_scene(
          [_spd("a", {"type": "simulation_time", "value": 1})],
          [_spd("b", {"type": "after_event", "event_id": "a", "actor_ref": "obj-1"})],
          [_spd("c", {"type": "after_event", "event_id": "a", "actor_ref": "obj-1"})]))))


# ── The emitted .xosc resolves a cross-actor reference by name ───────────────
#
# The only assertion here that needs the sibling repo's emitter. It is what the
# whole cross-actor feature reduces to at runtime: ScenarioRunner looks
# storyboardElementRef up on a GLOBAL py_trees blackboard key
# ('(EVENT)<name>-END'), so an Event in one actor's Act may name an Event in
# another's — provided the emitter can resolve the name at all. It could not
# until build_custom_event_chain grew its shared registry: each actor resolved
# its own triggers in isolation, and a reference leaving the actor found no
# name and degraded silently to a simulation_time start.

def _xosc_event_refs(params):
    import tempfile
    import xml.etree.ElementTree as ET

    from generator.xml_builder import build_xosc  # noqa: E402  (needs _ensure_llmgen_on_path)

    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "cross_actor.xosc")
        build_xosc(validate_scenario_params(params), path)
        root = ET.parse(path).getroot()
    waits = {}
    for event in root.iter("Event"):
        cond = event.find(".//StoryboardElementStateCondition")
        if cond is not None and cond.get("storyboardElementType") == "event":
            waits[event.get("name")] = cond.get("storyboardElementRef")
    names = {event.get("name") for event in root.iter("Event")}
    return waits, names


from backend.scenario_io import _ensure_llmgen_on_path  # noqa: E402

_ensure_llmgen_on_path()

# hero <- adversary <- adversary1: the hero's Act is built LAST, so the first
# link is a forward reference and only resolves because the trigger pass is
# deferred until every actor's actions exist.
waits, names = _xosc_event_refs(_scene(
    [_spd("evt-1", {"type": "simulation_time", "value": 2})],
    [_spd("evt-1", {"type": "after_event", "event_id": "evt-1", "actor_ref": "obj-1"})],
    [_spd("evt-1", {"type": "after_event", "event_id": "evt-1", "actor_ref": "obj-2"})],
))
check("a cross-actor after_event names the OTHER actor's event in the .xosc",
      waits.get("adversary_SpeedEvent0") == "hero_SpeedEvent0", str(waits))
check("a forward cross-actor reference resolves too (hero's Act is built last)",
      waits.get("adversary1_SpeedEvent0") == "adversary_SpeedEvent0", str(waits))
check("no storyboardElementRef in the .xosc dangles",
      set(waits.values()) <= names, str(set(waits.values()) - names))


sys.exit(check.report())
