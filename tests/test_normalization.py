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


def raises(fn):
    try:
        fn()
        return False
    except ValueError:
        return True


# ── Unknown action / trigger are coerced, not rejected ───────────────────────

out = norm([{"id": "e1", "trigger": {"type": "nonsense"},
             "action": {"type": "also_nonsense"}}])
ev = out["npcs"][0]["events"][0]
check("unknown action coerces to follow_trajectory",
      ev["action"]["type"] == "follow_trajectory", ev["action"]["type"])
check("unknown trigger coerces to simulation_time",
      ev["trigger"]["type"] == "simulation_time", ev["trigger"]["type"])

# The coerced follow_trajectory has no waypoints, which makes the generator's
# action builder return False and drop the event entirely. Worth knowing: a
# typo'd action name is not just wrong, it vanishes.
check("coerced follow_trajectory has an empty trajectory",
      ev["action"]["trajectory"] == [], str(ev["action"]["trajectory"]))


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

out = norm([{"id": "e1",
             "trigger": {"type": "distance_to_point", "value": 25, "point": {}},
             "action": {"type": "set_speed"}}])
check("distance_to_point with an empty point defaults to origin",
      (out["npcs"][0]["events"][0]["trigger"]["point"]["x"],
       out["npcs"][0]["events"][0]["trigger"]["point"]["y"]) == (0.0, 0.0))


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
             "action": {"type": "lane_change", "direction": "sideways"}}])
check("unknown lane_change direction coerces to left",
      out["npcs"][0]["events"][0]["action"]["direction"] == "left")

out = norm([{"id": "e1", "trigger": {"type": "simulation_time"},
             "action": {"type": "set_distance", "axis": "diagonal"}}])
check("unknown set_distance axis coerces to longitudinal",
      out["npcs"][0]["events"][0]["action"]["axis"] == "longitudinal")


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
             "action": {"type": "set_distance", "entity_ref": "obj-2"}}]},
        {"id": "obj-4", "type": "car", "x": 3, "y": 3, "events": [
            {"id": "e", "trigger": {"type": "simulation_time"},
             "action": {"type": "set_distance", "entity_ref": "obj-4"}}]},
    ],
}
out = validate_scenario_params(params)
refs = [n["events"][0]["action"]["entity_ref"] for n in out["npcs"]]
check("ego id maps to 'hero'", refs[0] == "hero", refs[0])
check("npc[0] maps to 'adversary'", refs[1] == "adversary", refs[1])
check("npc[2] maps to 'adversary2'", refs[2] == "adversary2", refs[2])

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
out = norm([{"id": "e1", "trigger": {"type": "simulation_time"},
             "action": {"type": "set_distance", "entity_ref": "adversary"}}])
check("an already-resolved 'adversary' ref survives",
      out["npcs"][0]["events"][0]["action"]["entity_ref"] == "adversary",
      out["npcs"][0]["events"][0]["action"]["entity_ref"])
check("a ref naming an adversary index that does not exist raises",
      raises(lambda: norm([{"id": "e1", "trigger": {"type": "simulation_time"},
                            "action": {"type": "set_distance",
                                       "entity_ref": "adversary7"}}])))


# ── NPC-level defaults ───────────────────────────────────────────────────────

out = norm([], npcs=[{"id": "obj-2", "type": "car", "x": 1, "y": 1}])
npc = out["npcs"][0]
check("npc defaults z to 0.2", npc["z"] == 0.2)
check("npc defaults behaviors to constant_speed", npc["behaviors"] == ["constant_speed"])
check("npc defaults trigger_distance to 400", npc["trigger_distance"] == 400.0)

out = norm([], npcs=[{"id": "obj-2", "type": "car", "x": 1, "y": 1, "trigger_distance": 2}])
check("trigger_distance clamps up to 5", out["npcs"][0]["trigger_distance"] == 5.0)
out = norm([], npcs=[{"id": "obj-2", "type": "car", "x": 1, "y": 1, "trigger_distance": 9999}])
check("trigger_distance clamps down to 1000", out["npcs"][0]["trigger_distance"] == 1000.0)

out = norm([{"trigger": {"type": "simulation_time"}, "action": {"type": "set_speed"}}])
check("an event with no id is given one",
      out["npcs"][0]["events"][0]["id"] == "event_1",
      out["npcs"][0]["events"][0].get("id"))


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
    return lambda: validate_scenario_params({
        "map": "Town01",
        "ego": {"id": "obj-1", "type": "car", "x": 0, "y": 0},
        "npcs": [{"id": "obj-2", "type": actor_type, "x": 1, "y": 1}],
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

out = validate_scenario_params({"ego": {"type": "car", "x": 0, "y": 0}})
check("map defaults to Town01", out["map"] == "Town01")
check("unknown time-of-day coerces to daytime",
      validate_scenario_params(
          {"ego": {"type": "car", "x": 0, "y": 0}, "time": "midnightish"}
      )["time"] == "daytime")


sys.exit(check.report())
