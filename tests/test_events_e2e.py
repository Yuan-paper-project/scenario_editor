"""The event editor: every action and trigger type, through to the .xosc.

Complements test_templates_e2e.py, which only reaches the subset of the event
model the templates happen to use (set_speed, lane_change, distance_to_ego,
after_event). This covers the rest — distance_to_point, simulation_time,
set_distance, assign_route, follow_trajectory — plus the editing rules and the
failure modes where an event silently disappears from the export.

    bash run.sh 9090            # terminal 1
    .venv/bin/python3 tests/test_events_e2e.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from playwright.sync_api import sync_playwright  # noqa: E402
import _harness as H  # noqa: E402

check = H.Checks()

EGO = {"id": "obj-1", "type": "ego", "x": 300.631, "y": -2.025,
       "z": 0.2, "yaw": 180, "behaviors": ["constant_speed"],
       "trigger_distance": 400, "events": []}


def seed(page, events, npc_type="car", extra_npcs=None):
    """Put one NPC with `events` into AppState and return nothing.

    Uses AppState.loadJSON — the same entry point the Load-scenario button
    uses — so the state is built the way the app builds it.
    """
    page.evaluate("""(payload) => {
        AppState.loadJSON({
            map: 'Town01', weather: {}, time: 'daytime',
            ego: payload.ego,
            npcs: payload.npcs,
            staticObjects: [], trafficSignals: [],
        });
    }""", {
        "ego": EGO,
        "npcs": [{
            "id": "obj-2", "type": npc_type, "x": 265.364, "y": 1.967,
            "z": 0.2, "yaw": 0, "behaviors": ["constant_speed"],
            "trigger_distance": 400, "events": events,
        }] + (extra_npcs or []),
    })


def speed_event(eid, trigger, value=10.0, duration=5.0):
    return {"id": eid, "trigger": trigger,
            "action": {"type": "set_speed",
                       "dynamics": {"shape": "step", "dimension": "time",
                                    "value": duration},
                       "target": {"mode": "absolute", "value": value}}}


with sync_playwright() as p:
    browser, page, errors = H.open_editor(p, "Town01")
    check("no JS errors on load", not errors, str(errors[:3]))

    # ── The action grid, through the real panel ──────────────────────────────
    seed(page, [])
    page.evaluate("AppState.select('obj-2')")
    labels = page.evaluate(
        "[...document.querySelectorAll('#event-action-grid .event-action-button')]"
        ".map(b => b.textContent)")
    check("event panel offers 5 actions", len(labels) == 5, str(labels))
    check("action grid lists the documented actions",
          labels == ["Trajektorie folgen", "Route zuweisen", "Geschw. setzen",
                     "Abstand halten", "Spurwechsel"], str(labels))

    # One path-producing event per actor: once a trajectory or route exists,
    # both path buttons stay in the grid but go disabled — hiding them reflowed
    # the grid with nothing to explain the rule (eventPanel.js
    # _renderEventActionGrid).
    seed(page, [{"id": "e1", "trigger": {"type": "simulation_time", "value": 0},
                 "action": {"type": "follow_trajectory", "trajectory": []}}])
    page.evaluate("AppState.select('obj-2')")
    labels = page.evaluate(
        "[...document.querySelectorAll('#event-action-grid .event-action-button')]"
        ".map(b => b.textContent)")
    check("all 5 actions stay listed once one path event exists",
          labels == ["Trajektorie folgen", "Route zuweisen", "Geschw. setzen",
                     "Abstand halten", "Spurwechsel"], str(labels))
    disabled = page.evaluate(
        "[...document.querySelectorAll('#event-action-grid .event-action-button')]"
        ".filter(b => b.disabled).map(b => b.textContent)")
    check("path actions are disabled once one path event exists",
          disabled == ["Trajektorie folgen", "Route zuweisen"], str(disabled))

    # Clicking an action button appends a new event of that kind.
    seed(page, [])
    page.evaluate("AppState.select('obj-2')")
    page.click('#event-action-grid .event-action-button:has-text("Geschw. setzen")')
    evs = page.evaluate("AppState.findById('obj-2').events")
    check("Set speed adds one event", len(evs) == 1, str(len(evs)))
    check("new set_speed event has the right action type",
          evs and evs[0]["action"]["type"] == "set_speed",
          str(evs[0]["action"]["type"] if evs else None))
    page.click('#event-action-grid .event-action-button:has-text("Spurwechsel")')
    evs = page.evaluate("AppState.findById('obj-2').events")
    check("Lane change appends a second event",
          len(evs) == 2 and evs[1]["action"]["type"] == "lane_change",
          str([e["action"]["type"] for e in evs]))

    # ── simulation_time ──────────────────────────────────────────────────────
    seed(page, [speed_event("e1", {"type": "simulation_time", "value": 10.0})])
    xml = H.export_xosc(page)
    ev = H.parse_events(xml, entity="adversary")[0]
    check("simulation_time exports a SimulationTimeCondition",
          ev["trigger"]["kind"] == "simulation_time", ev["trigger"]["kind"])
    check("simulation_time keeps its value",
          ev["trigger"]["value"] == 10.0, str(ev["trigger"]["value"]))

    # ── distance_to_point, entity_ref left unset ─────────────────────────────
    # The trigger means "when the EGO reaches this spot". Leaving the actor
    # unset must not quietly make the NPC trigger off its own position.
    seed(page, [{"id": "e1",
                 "trigger": {"type": "distance_to_point", "value": 25.0,
                             "point": {"name": "P", "x": 240.0, "y": -2.0, "z": 0.2}},
                 "action": {"type": "set_speed",
                            "dynamics": {"shape": "step", "dimension": "time", "value": 5.0},
                            "target": {"mode": "absolute", "value": 8.0}}}])
    xml = H.export_xosc(page)
    ev = H.parse_events(xml, entity="adversary")[0]
    check("distance_to_point exports a DistanceCondition + WorldPosition",
          ev["trigger"]["kind"] == "distance_to_point", ev["trigger"]["kind"])
    check("distance_to_point keeps its radius",
          ev["trigger"]["value"] == 25.0, str(ev["trigger"]["value"]))
    check("distance_to_point keeps its point",
          ev["trigger"]["point"] == (240.0, -2.0), str(ev["trigger"]["point"]))
    check("DISTANCE_TO_POINT DEFAULTS TO THE EGO AS TRIGGERING ENTITY",
          ev["trigger"]["triggered_by"] == ["hero"],
          str(ev["trigger"]["triggered_by"]))

    # ...and an explicit NPC target is honoured rather than overridden.
    seed(page, [{"id": "e1",
                 "trigger": {"type": "distance_to_point", "value": 25.0,
                             "entity_ref": "obj-2",
                             "point": {"x": 240.0, "y": -2.0, "z": 0.2}},
                 "action": {"type": "set_speed",
                            "dynamics": {"shape": "step", "dimension": "time", "value": 5.0},
                            "target": {"mode": "absolute", "value": 8.0}}}])
    xml = H.export_xosc(page)
    ev = H.parse_events(xml, entity="adversary")[0]
    check("distance_to_point honours an explicit npc target",
          ev["trigger"]["triggered_by"] == ["adversary"],
          str(ev["trigger"]["triggered_by"]))

    # ── distance_to_point naming the EGO explicitly ──────────────────────────
    # The dropdown's default (eventPanel.js _defaultPointTriggerActorId) and the
    # map click handler both write AppState.ego.id here, so this is the ordinary
    # path, not an edge case. buildScenarioParams used to remap actions only and
    # to omit ego.id from the payload, so the ego id fell through BOTH layers and
    # reached the file as <EntityRef entityRef="obj-1"/> — a reference to nothing.
    seed(page, [{"id": "e1",
                 "trigger": {"type": "distance_to_point", "value": 9.7,
                             "entity_ref": "obj-1",
                             "point": {"name": "P", "x": 240.0, "y": -2.0, "z": 0.2}},
                 "action": {"type": "set_speed",
                            "dynamics": {"shape": "step", "dimension": "time", "value": 2.0},
                            "target": {"mode": "absolute", "value": 8.0}}}])
    params = H.export_params(page)
    # The frontend half: resolveTrigger must have run before the POST.
    check("BUILDSCENARIOPARAMS RESOLVES A TRIGGER'S EGO REF TO 'hero'",
          params["npcs"][0]["events"][0]["trigger"]["entity_ref"] == "hero",
          str(params["npcs"][0]["events"][0]["trigger"].get("entity_ref")))
    # The backend half: the ego id is sent, so actor_refs can resolve it too.
    check("the export payload carries the ego id",
          params["ego"].get("id") == "obj-1", str(params["ego"].get("id")))
    xml = H.xosc_from_params(page, params)
    ev = H.parse_events(xml, entity="adversary")[0]
    check("distance_to_point with an explicit ego ref triggers off hero",
          ev["trigger"]["triggered_by"] == ["hero"],
          str(ev["trigger"]["triggered_by"]))
    check("no internal obj- id survives into the .xosc",
          "obj-" not in xml)
    check("no entityRef in the .xosc names an undeclared entity",
          H.dangling_entity_refs(xml) == [], str(H.dangling_entity_refs(xml)))

    # An entity_ref that resolves to nothing is a hard 400, not a file with a
    # dangling reference in it — same policy as an unknown actor type or prop id.
    seed(page, [{"id": "e1",
                 "trigger": {"type": "distance_to_point", "value": 25.0,
                             "entity_ref": "obj-999",
                             "point": {"x": 240.0, "y": -2.0, "z": 0.2}},
                 "action": {"type": "set_speed",
                            "dynamics": {"shape": "step", "dimension": "time", "value": 5.0},
                            "target": {"mode": "absolute", "value": 8.0}}}])
    params = H.export_params(page)
    params["npcs"][0]["events"][0]["trigger"]["entity_ref"] = "obj-999"  # bypass the frontend remap
    status = H.export_status(page, params)
    check("an unresolvable entity_ref is rejected with a 400",
          status == 400, str(status))

    # ── set_distance ─────────────────────────────────────────────────────────
    for axis, tag in (("longitudinal", "longitudinal"), ("lateral", "lateral")):
        seed(page, [{"id": "e1", "trigger": {"type": "simulation_time", "value": 0},
                     "action": {"type": "set_distance", "axis": axis,
                                "entity_ref": "obj-1", "value": 12.0}}])
        xml = H.export_xosc(page)
        ev = H.parse_events(xml, entity="adversary")[0]
        check(f"set_distance {axis} exports the matching action",
              ev["action"]["kind"] == "set_distance" and ev["action"]["axis"] == tag,
              str(ev["action"]))
        check(f"set_distance {axis} targets hero at 12 m",
              ev["action"]["entity_ref"] == "hero" and ev["action"]["value"] == 12.0,
              str(ev["action"]))

    # ── relative set_speed ───────────────────────────────────────────────────
    seed(page, [{"id": "e1", "trigger": {"type": "simulation_time", "value": 0},
                 "action": {"type": "set_speed",
                            "dynamics": {"shape": "linear", "dimension": "time", "value": 4.0},
                            "target": {"mode": "relative", "entity_ref": "obj-1",
                                       "delta": -3.0}}}])
    xml = H.export_xosc(page)
    ev = H.parse_events(xml, entity="adversary")[0]
    check("relative speed exports RelativeTargetSpeed vs hero",
          ev["action"]["mode"] == "relative" and ev["action"]["entity_ref"] == "hero",
          str(ev["action"]))
    check("relative speed keeps its negative delta",
          ev["action"]["value"] == -3.0, str(ev["action"]["value"]))
    check("linear dynamics survive export",
          ev["action"]["shape"] == "linear", str(ev["action"]["shape"]))
    check("relative speed events are named RelativeSpeed",
          "RelativeSpeed" in ev["name"], ev["name"])

    # ── the rate dimension ───────────────────────────────────────────────────
    # ChangeActorTargetSpeed ramps at this rate instead of stepping, and ends
    # when it ARRIVES rather than on a clock. Note this needs the locally
    # patched ScenarioRunner: stock 0.9.15 has no 'rate' branch and silently
    # reads the value as a duration in seconds.
    seed(page, [{"id": "e1", "trigger": {"type": "simulation_time", "value": 0},
                 "action": {"type": "set_speed",
                            "dynamics": {"shape": "step", "dimension": "rate", "value": 2.5},
                            "target": {"mode": "absolute", "value": 20.0}}}])
    xml = H.export_xosc(page)
    ev = H.parse_events(xml, entity="adversary")[0]
    check("rate dimension survives export",
          ev["action"]["dimension"] == "rate", str(ev["action"]["dimension"]))
    check("rate keeps its m/s2 value",
          ev["action"]["dynamics_value"] == 2.5, str(ev["action"]["dynamics_value"]))
    # 'step' went in; a ramp cannot be a step, so the normalizer overrides it.
    check("rate forces a linear shape even when step was authored",
          ev["action"]["shape"] == "linear", str(ev["action"]["shape"]))

    seed(page, [{"id": "e1", "trigger": {"type": "simulation_time", "value": 0},
                 "action": {"type": "set_speed",
                            "dynamics": {"shape": "linear", "dimension": "rate", "value": 0},
                            "target": {"mode": "absolute", "value": 20.0}}}])
    xml = H.export_xosc(page)
    ev = H.parse_events(xml, entity="adversary")[0]
    # A rate of 0 never reaches the target, so the atomic never reports SUCCESS
    # and the run hangs with an orphaned scenario_runner. The floor is the guard.
    check("a rate of 0 is floored before export",
          ev["action"]["dynamics_value"] == 0.1, str(ev["action"]["dynamics_value"]))

    # ── follow_trajectory ────────────────────────────────────────────────────
    traj = [{"x": 265.0, "y": 1.9, "z": 0.2, "velocity": 8.0},
            {"x": 240.0, "y": 1.9, "z": 0.2, "velocity": 8.0},
            {"x": 215.0, "y": 1.9, "z": 0.2, "velocity": 8.0}]
    seed(page, [{"id": "e1", "trigger": {"type": "distance_to_ego", "value": 60.0},
                 "action": {"type": "follow_trajectory", "trajectory": traj}}])
    xml = H.export_xosc(page)
    ev = H.parse_events(xml, entity="adversary")[0]
    check("follow_trajectory exports a polyline",
          ev["action"]["kind"] == "follow_trajectory", str(ev["action"]))
    check("follow_trajectory keeps all 3 vertices",
          ev["action"]["vertices"] == 3, str(ev["action"]["vertices"]))

    # ── assign_route and its forced trigger ──────────────────────────────────
    route = [{"x": 265.0, "y": 1.9, "z": 0.2}, {"x": 200.0, "y": 1.9, "z": 0.2}]
    seed(page, [
        {"id": "r1", "trigger": {"type": "simulation_time", "value": 30.0},
         "action": {"type": "assign_route", "route_strategy": "fastest",
                    "waypoints": route}},
        speed_event("s1", {"type": "after_event", "event_id": "r1"}, 12.0, 5.0),
    ])
    xml = H.export_xosc(page)
    evs = H.parse_events(xml, entity="adversary")
    check("assign_route exports a Route", evs[0]["action"]["kind"] == "assign_route",
          str(evs[0]["action"]))
    check("assign_route keeps both waypoints",
          evs[0]["action"]["waypoints"] == 2, str(evs[0]["action"]["waypoints"]))
    check("ASSIGN_ROUTE OVERRIDES ITS OWN TRIGGER TO simulation_time@0",
          evs[0]["trigger"]["kind"] == "simulation_time"
          and evs[0]["trigger"]["value"] == 0.0, str(evs[0]["trigger"]))
    check("AN after_event CHAINED ONTO assign_route BECOMES distance_to_ego@400",
          evs[1]["trigger"]["kind"] == "distance_to_ego"
          and evs[1]["trigger"]["value"] == 400.0, str(evs[1]["trigger"]))

    # ── Events that silently vanish from the export ──────────────────────────
    # _add_follow_trajectory_action returns False below 2 waypoints, so the
    # event is dropped. build_custom_event_chain still registered its NAME, so
    # anything chained onto it keeps a storyboardElementRef pointing at an
    # Event that no longer exists. ScenarioRunner has no way to satisfy that
    # trigger, so the follow-up event never fires either.
    seed(page, [
        {"id": "e1", "trigger": {"type": "simulation_time", "value": 0},
         "action": {"type": "follow_trajectory", "trajectory": []}},
        speed_event("e2", {"type": "after_event", "event_id": "e1"}, 9.0, 5.0),
    ])
    xml = H.export_xosc(page)
    evs = H.parse_events(xml, entity="adversary")
    dangling = H.dangling_event_refs(xml)
    check("an empty follow_trajectory is dropped from the export",
          len(evs) == 1, f"{len(evs)} events: {[e['name'] for e in evs]}")
    check.known_issue(
        "OPEN DEFECT: after_event ref survives when its target event is dropped",
        dangling == [],
        f"unresolvable storyboardElementRef(s): {dangling} — the chained event "
        f"can never fire. Fix in llm-scenario-gen build_custom_event_chain(): "
        f"build event_name_by_id from the events actually appended, or drop "
        f"triggers whose ref was skipped")

    # Same failure via a different route: pedestrians cannot take an
    # AssignRouteAction, so the event is dropped for them specifically.
    seed(page, [
        {"id": "r1", "trigger": {"type": "simulation_time", "value": 0},
         "action": {"type": "assign_route", "route_strategy": "fastest",
                    "waypoints": route}},
        speed_event("s1", {"type": "after_event", "event_id": "r1"}, 2.0, 5.0),
    ], npc_type="pedestrian")
    xml = H.export_xosc(page)
    evs = H.parse_events(xml, entity="adversary")
    check("assign_route on a pedestrian is dropped",
          all(e["action"]["kind"] != "assign_route" for e in evs),
          str([e["action"]["kind"] for e in evs]))
    check("no dangling ref after a dropped pedestrian route",
          H.dangling_event_refs(xml) == [], str(H.dangling_event_refs(xml)))

    # ── Multi-NPC entity refs ────────────────────────────────────────────────
    seed(page,
         [speed_event("e1", {"type": "simulation_time", "value": 0}, 10.0)],
         extra_npcs=[
             {"id": "obj-3", "type": "car", "x": 240.0, "y": 1.967, "z": 0.2,
              "yaw": 0, "behaviors": ["constant_speed"], "trigger_distance": 400,
              "events": [{"id": "d1", "trigger": {"type": "simulation_time", "value": 0},
                          "action": {"type": "set_distance", "axis": "longitudinal",
                                     "entity_ref": "obj-2", "value": 15.0}}]},
         ])
    xml = H.export_xosc(page)
    names = H.entity_names(xml)
    check("two npcs export as adversary and adversary1",
          "adversary" in names and "adversary1" in names, str(names))
    ev = H.parse_events(xml, entity="adversary1")[0]
    check("npc-to-npc set_distance resolves to the other npc's entity ref",
          ev["action"]["entity_ref"] == "adversary", str(ev["action"]))

    # ── Unknown action/trigger reach the export as the coerced kind ──────────
    seed(page, [{"id": "e1", "trigger": {"type": "teleport_when_ready"},
                 "action": {"type": "make_it_fly"}}])
    xml = H.export_xosc(page)
    evs = H.parse_events(xml, entity="adversary")
    names = [e["name"] for e in evs]
    # The typo'd action coerces to follow_trajectory, which then has no
    # waypoints and gets dropped — so build_custom_event_chain() adds nothing
    # and _inject_npcs falls back to the legacy behaviors chain. The NPC still
    # moves, just not the way the event said. Worth knowing when debugging
    # "my event did nothing": the actor driving at a constant speed is the
    # fallback, not the event.
    check("an npc whose events all vanish falls back to its behaviors chain",
          any("ConstantSpeed" in n for n in names), str(names))
    check("the typo'd event itself contributes nothing",
          not any("Speed0" in n and "ConstantSpeed" not in n for n in names),
          str(names))

    # ── Initial speed on an NPC ──────────────────────────────────────────────
    # seed() omits initial_speed, so this is also the regression guard that a
    # pre-feature payload keeps exporting exactly as it did.
    seed(page, [])
    xml = H.export_xosc(page)
    check("an npc payload without initial_speed emits no Init SpeedAction",
          H.init_speed_of(xml, "adversary") is None,
          str(H.init_speed_of(xml, "adversary")))

    seed(page, [])
    page.evaluate("AppState.updateById('obj-2', {initial_speed: 6.5})")
    xml = H.export_xosc(page)
    check("an npc's initial speed reaches its Init <Private>",
          H.init_speed_of(xml, "adversary") == 6.5,
          str(H.init_speed_of(xml, "adversary")))
    check("an npc's Init speed does not leak onto the hero",
          H.init_speed_of(xml, "hero") is None, str(H.init_speed_of(xml, "hero")))

    # Walkers get the same treatment: ScenarioRunner's
    # _extract_pedestrian_information calls the same _get_actor_speed, and
    # PedestrianControl.run_step assigns control.speed from _target_speed.
    seed(page, [], npc_type="pedestrian")
    page.evaluate("AppState.updateById('obj-2', {initial_speed: 1.4})")
    xml = H.export_xosc(page)
    check("a pedestrian's initial speed reaches its Init <Private> too",
          H.init_speed_of(xml, "adversary") == 1.4,
          str(H.init_speed_of(xml, "adversary")))
    check("the pedestrian really is emitted as <Pedestrian>",
          "<Pedestrian" in xml)

    # The backend floors a negative rather than letting it through:
    # openscenario_configuration._get_actor_speed raises on a negative value.
    seed(page, [])
    page.evaluate("AppState.updateById('obj-2', {initial_speed: -9})")
    xml = H.export_xosc(page)
    check("a negative npc initial speed is clamped to 0 and emits nothing",
          H.init_speed_of(xml, "adversary") is None,
          str(H.init_speed_of(xml, "adversary")))

    unexpected = [e for e in errors if "400 (Bad Request)" not in e]
    check("no unexpected JS errors during the run", not unexpected, str(unexpected[:3]))
    browser.close()

sys.exit(check.report())
