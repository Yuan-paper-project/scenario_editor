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

# The ego carries one trivial event, and nothing in this suite asserts against
# it — NPC events are the subject throughout. It is here because an actor with
# no events contributes no <Act>, so a fixture whose NPC has no events (several
# below do, deliberately) would otherwise be a scenario in which NOTHING has
# events, which is rejected before it can be exported.
EGO = {"id": "obj-1", "type": "ego", "x": 300.631, "y": -2.025,
       "z": 0.2, "yaw": 180, "events": [H.MIN_EVENT]}


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
            "z": 0.2, "yaw": 0, "events": events,
        }] + (extra_npcs or []),
    })


def speed_event(eid, trigger, value=10.0, duration=5.0):
    return {"id": eid, "trigger": trigger,
            "action": {"type": "set_speed",
                       "dynamics": {"shape": "step", "dimension": "time",
                                    "value": duration},
                       "target": {"mode": "absolute", "value": value}}}


def _params(page):
    """The export payload, bypassing the client-side gate.

    The Export button now refuses an incomplete scenario, so this is the only
    way to hand the backend one — which is exactly what a hand-written or
    LLM-generated payload does.
    """
    return page.evaluate("() => ScenarioIO.buildParamsForTesting()")


def _export_blocked(page):
    """True if clicking Export .xosc raises an error toast and sends nothing."""
    page.evaluate("document.getElementById('toast-container')?.replaceChildren()")
    fired = []

    def _watch(request):
        if request.url.endswith("/api/export"):
            fired.append(request.url)

    page.on("request", _watch)
    try:
        page.click("#btn-export")
        page.wait_for_timeout(500)
        toast = page.evaluate(
            "document.querySelector('#toast-container .toast-error')?.textContent || ''")
    finally:
        page.remove_listener("request", _watch)
    return not fired and "nvollständig" in toast


with sync_playwright() as p:
    browser, page, errors = H.open_editor(p, "Town01")
    check("no JS errors on load", not errors, str(errors[:3]))

    # ── The action grid, through the real panel ──────────────────────────────
    seed(page, [])
    page.evaluate("AppState.select('obj-2')")
    labels = page.evaluate(
        "[...document.querySelectorAll('#event-action-grid .event-action-button')]"
        ".map(b => b.textContent)")
    check("event panel offers 6 actions", len(labels) == 6, str(labels))
    check("action grid lists the documented actions",
          labels == ["Trajektorie folgen", "Route zuweisen", "Geschw. setzen",
                     "Abstand halten", "Spurwechsel", "Spurversatz"], str(labels))

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
    check("all 6 actions stay listed once one path event exists",
          labels == ["Trajektorie folgen", "Route zuweisen", "Geschw. setzen",
                     "Abstand halten", "Spurwechsel", "Spurversatz"], str(labels))
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

    # ── lane_offset ──────────────────────────────────────────────────────────
    # Emitted continuous="true" and nothing else: with an
    # AbsoluteTargetLaneOffset, ChangeActorLaneOffset's continuous="false" branch
    # compares the actor's live offset against _current_target_offset, which the
    # atomic only writes in its RELATIVE branch — so it stays 0, the test passes
    # on the first tick while the actor is still centred, and terminate() puts
    # the offset straight back. A valid file that does nothing.
    seed(page, [{"id": "e1", "trigger": {"type": "simulation_time", "value": 2.0},
                 "action": {"type": "lane_offset", "direction": "left", "offset": 1.5}}])
    xml = H.export_xosc(page)
    ev = H.parse_events(xml, entity="adversary")[0]
    check("lane_offset exports a LaneOffsetAction",
          ev["action"]["kind"] == "lane_offset", str(ev["action"]))
    # Positive is RIGHT of travel (SimpleVehicleControl._offset_waypoint uses
    # get_right_vector), which is the OPPOSITE of lane_change's
    # RelativeTargetLane, where right is -1 because that is a lane-id delta.
    check("a left lane_offset exports a negative value",
          ev["action"]["value"] == -1.5, str(ev["action"]["value"]))
    check("lane_offset is always continuous",
          ev["action"]["continuous"] == "true", str(ev["action"]["continuous"]))
    check("lane_offset carries the XSD-required dynamics shape",
          ev["action"]["shape"] == "linear", str(ev["action"]["shape"]))
    check("lane_offset keeps its own trigger, unlike assign_route",
          ev["trigger"]["kind"] == "simulation_time" and ev["trigger"]["value"] == 2.0,
          str(ev["trigger"]))

    seed(page, [{"id": "e1", "trigger": {"type": "simulation_time", "value": 0},
                 "action": {"type": "lane_offset", "direction": "right", "offset": 40.0}}])
    xml = H.export_xosc(page)
    ev = H.parse_events(xml, entity="adversary")[0]
    check("a right lane_offset exports a positive value, clamped to 10 m",
          ev["action"]["value"] == 10.0, str(ev["action"]["value"]))

    # "Drift back to the centre" is a SECOND lane_offset of 0 — the only way to
    # end one, since a second offset command sets the first atomic's
    # _overwritten flag and so skips its terminate reset. -0.0 is falsy, hence
    # the emitter's `or 0.0`: without it this writes value="-0".
    seed(page, [{"id": "e1", "trigger": {"type": "simulation_time", "value": 0},
                 "action": {"type": "lane_offset", "direction": "left", "offset": 0}}])
    xml = H.export_xosc(page)
    check("a zero lane_offset writes 0, never -0",
          'AbsoluteTargetLaneOffset value="0"' in xml,
          [l for l in xml.splitlines() if "AbsoluteTargetLaneOffset" in l])

    # PedestrianControl stores the controller offset and never reads it, so the
    # action is barred at the UI, in ScenarioRules and in the backend — a wider
    # set than assign_route's, since a cyclist is a <Vehicle> and does honour it.
    seed(page, [], npc_type="pedestrian")
    page.evaluate("AppState.select('obj-2')")
    disabled = page.evaluate(
        "[...document.querySelectorAll('#event-action-grid .event-action-button')]"
        ".filter(b => b.disabled).map(b => b.textContent)")
    check("Spurversatz is disabled for a pedestrian",
          "Spurversatz" in disabled, str(disabled))
    check("...and so is Route zuweisen, for a different reason",
          "Route zuweisen" in disabled, str(disabled))
    seed(page, [], npc_type="cyclist")
    page.evaluate("AppState.select('obj-2')")
    disabled = page.evaluate(
        "[...document.querySelectorAll('#event-action-grid .event-action-button')]"
        ".filter(b => b.disabled).map(b => b.textContent)")
    check("Spurversatz IS offered to a cyclist, unlike Route zuweisen",
          "Spurversatz" not in disabled and "Route zuweisen" in disabled, str(disabled))

    seed(page, [{"id": "e1", "trigger": {"type": "simulation_time", "value": 0},
                 "action": {"type": "lane_offset", "direction": "left", "offset": 1.0}}],
         npc_type="pedestrian")
    params = _params(page)
    check("a pedestrian lane_offset is a 400, not a silent no-op",
          H.export_status(page, params) == 400, str(H.export_status(page, params)))

    # A lane_offset never completes on its own, so it is left out of the
    # 'Nach Event' dropdown entirely — the same treatment assign_route gets.
    seed(page, [{"id": "e1", "trigger": {"type": "simulation_time", "value": 0},
                 "action": {"type": "lane_offset", "direction": "left", "offset": 1.0}},
                speed_event("e2", {"type": "simulation_time", "value": 5})])
    page.evaluate("AppState.select('obj-2')")
    page.evaluate("""() => {
        const card = [...document.querySelectorAll('.event-card')][1];
        card.querySelector('select').value = 'after_event';
        card.querySelector('select').dispatchEvent(new Event('change', {bubbles: true}));
    }""")
    page.wait_for_timeout(200)
    options = page.evaluate("""() => {
        const card = [...document.querySelectorAll('.event-card')][1];
        return [...card.querySelectorAll('option')].map(o => o.textContent);
    }""")
    check("the Nach-Event dropdown never offers a Spurversatz",
          not any("Spurversatz" in o for o in options), str(options))

    # Adding an event after a Spurversatz must not default to waiting on it —
    # the dropdown already refused it, but the new-event default did not, so a
    # second Spurversatz arrived pre-chained onto the first. Through the real
    # button, the way it was reported.
    seed(page, [{"id": "e1", "trigger": {"type": "simulation_time", "value": 0},
                 "action": {"type": "lane_offset", "direction": "left", "offset": 1.0}}])
    page.evaluate("AppState.select('obj-2')")
    page.click('.event-action-button:has-text("Spurversatz")')
    page.wait_for_timeout(200)
    added = page.evaluate("AppState.findById('obj-2').events[1].trigger")
    check("a second Spurversatz does not default to waiting on the first",
          added.get("type") != "after_event", str(added))
    page.click('.event-action-button:has-text("Geschw. setzen")')
    page.wait_for_timeout(200)
    added = page.evaluate("AppState.findById('obj-2').events[2].trigger")
    check("...nor does any other action added after one",
          added.get("type") != "after_event", str(added))

    # Deleting the event between a Spurversatz and its successor re-points the
    # successor onto the event before — which must not be the Spurversatz.
    seed(page, [{"id": "e1", "trigger": {"type": "simulation_time", "value": 0},
                 "action": {"type": "lane_offset", "direction": "left", "offset": 1.0}},
                speed_event("e2", {"type": "simulation_time", "value": 3}),
                speed_event("e3", {"type": "after_event", "event_id": "e2"})])
    page.evaluate("AppState.select('obj-2')")
    page.wait_for_timeout(200)
    page.locator(".event-card").nth(1).locator(".event-delete").click()
    page.wait_for_timeout(200)
    if page.evaluate("Confirm.isOpen"):
        page.keyboard.press("Enter")
        page.wait_for_timeout(200)
    events = page.evaluate("AppState.findById('obj-2').events")
    survivor = next((e for e in events if e["id"] == "e3"), None)
    check("deleting the middle event does not re-point onto a Spurversatz",
          survivor is not None and not (survivor["trigger"].get("type") == "after_event"
                                        and survivor["trigger"].get("event_id") == "e1"),
          str(survivor and survivor["trigger"]))

    # A loaded file that names one anyway: the card chips it and the export
    # gate refuses — even with a second offset that would supersede the first
    # in CARLA. The ban is blanket by decision.
    seed(page, [{"id": "e1", "trigger": {"type": "simulation_time", "value": 0},
                 "action": {"type": "lane_offset", "direction": "left", "offset": 1.0}},
                {"id": "e2", "trigger": {"type": "simulation_time", "value": 4},
                 "action": {"type": "lane_offset", "direction": "left", "offset": 0.0}},
                speed_event("e3", {"type": "after_event", "event_id": "e1"})])
    page.evaluate("AppState.select('obj-2')")
    page.wait_for_timeout(200)
    chips = page.evaluate(
        "[...document.querySelectorAll('.event-problem')].map(c => c.textContent)")
    check("an after_event on a Spurversatz is chipped",
          any("Spurversatz endet nicht" in c for c in chips), str(chips))
    check("...and the export gate refuses it", _export_blocked(page))
    check("...and the backend 400s it",
          H.export_status(page, _params(page)) == 400)

    # ── lane_offset in the preview ───────────────────────────────────────────
    # simulate.js keeps sim.x/sim.y on the driven centreline and adds the offset
    # when the pose is written back (_pose), mirroring _offset_waypoint: the
    # controller displaces the point it AIMS at and leaves its waypoint list
    # alone. Town01 road 1 runs due east-west, so "across the road" is world y.
    page.evaluate("""() => AppState.loadJSON({
        map: 'Town01', weather: {}, time: 'daytime',
        ego: {id: 'obj-1', type: 'ego', x: 300.631, y: -2.025, z: 0.2, yaw: 180,
              initial_speed: 0, events: [{id: 'k1',
                trigger: {type: 'simulation_time', value: 0},
                action: {type: 'set_speed',
                         dynamics: {shape: 'step', dimension: 'time', value: 5},
                         target: {mode: 'absolute', value: 0}}}]},
        npcs: [{id: 'obj-2', type: 'car', x: 265.364, y: 1.967, z: 0.2, yaw: 180,
                initial_speed: 8, events: [
          {id: 'e1', trigger: {type: 'simulation_time', value: 0.4},
           action: {type: 'lane_offset', direction: 'left', offset: 2.0}},
          {id: 'e2', trigger: {type: 'simulation_time', value: 2.5},
           action: {type: 'lane_offset', direction: 'right', offset: 2.0}}]}],
        staticObjects: [], trafficSignals: [],
    })""")
    page.wait_for_timeout(200)
    centre_y = page.evaluate("AppState.findById('obj-2').y")
    page.click("#sim-play")
    page.wait_for_timeout(1400)
    left_y = page.evaluate("AppState.findById('obj-2').y")
    # Left of an east-bound vehicle is -y: the editor's frame IS CARLA's, which
    # is left-handed, so right is +y and get_right_vector() takes the positive
    # sign. Getting this backwards is invisible in the .xosc and obvious here.
    check("a left lane_offset displaces the previewed actor to -y",
          abs((left_y - centre_y) + 2.0) < 0.3, f"{centre_y} -> {left_y}")
    page.wait_for_timeout(2400)
    right_y = page.evaluate("AppState.findById('obj-2').y")
    check("a second lane_offset replaces the first rather than stacking",
          abs((right_y - centre_y) - 2.0) < 0.3, f"{centre_y} -> {right_y}")
    badge = page.evaluate(
        "document.querySelector('#layer-sim-badges text')?.textContent || ''")
    check("the preview badges the standing offset", "Spurversatz" in badge, badge)
    page.click("#sim-stop")
    page.wait_for_timeout(300)
    check("Stop restores the authored pose, offset and all",
          abs(page.evaluate("AppState.findById('obj-2').y") - centre_y) < 1e-6,
          str(page.evaluate("AppState.findById('obj-2').y")))

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

    # ── Events that would vanish from the export are now refused ─────────────
    # _add_follow_trajectory_action returns False below 2 waypoints, so the
    # event used to be dropped while build_custom_event_chain kept its NAME —
    # anything chained onto it held a storyboardElementRef pointing at an Event
    # that was not in the file, and could never fire. Both ends are now closed:
    # the editor refuses to export it, and so does the backend.
    seed(page, [
        {"id": "e1", "trigger": {"type": "simulation_time", "value": 0},
         "action": {"type": "follow_trajectory", "trajectory": []}},
        speed_event("e2", {"type": "after_event", "event_id": "e1"}, 9.0, 5.0),
    ])
    # Both cards are flagged, and that is the point: the chained event is just
    # as dead as the one it waits for.
    problems = page.evaluate("""() => {
        AppState.select('obj-2');
        return [...document.querySelectorAll('.event-card.has-problem .event-problem')]
            .map(el => el.textContent);
    }""")
    check("the panel flags the incomplete path event and the one chained onto it",
          len(problems) == 2, str(problems))
    check("...naming the missing waypoints",
          any("2 Wegpunkte" in text for text in problems), str(problems))
    check("...and the trigger that can never fire",
          any("feuert nie" in text for text in problems), str(problems))
    check("the section header counts them",
          page.evaluate("document.getElementById('event-warn').textContent") == "2",
          page.evaluate("document.getElementById('event-warn').textContent"))
    check("the export gate refuses a path event under 2 waypoints",
          _export_blocked(page), "export was not blocked")
    check("the backend rejects it too",
          H.export_status(page, _params(page)) == 400,
          str(H.export_status(page, _params(page))))

    # Same failure via a different route: pedestrians cannot take an
    # AssignRouteAction, so the event was dropped for them specifically.
    seed(page, [
        {"id": "r1", "trigger": {"type": "simulation_time", "value": 0},
         "action": {"type": "assign_route", "route_strategy": "fastest",
                    "waypoints": route}},
        speed_event("s1", {"type": "after_event", "event_id": "r1"}, 2.0, 5.0),
    ], npc_type="pedestrian")
    check("the export gate refuses a route on a pedestrian",
          _export_blocked(page), "export was not blocked")
    check("the backend rejects a route on a pedestrian",
          H.export_status(page, _params(page)) == 400,
          str(H.export_status(page, _params(page))))
    check("the action grid does not offer a route to a pedestrian at all",
          page.evaluate("""() => {
              AppState.select('obj-2');
              const btn = [...document.querySelectorAll('#event-action-grid button')]
                  .find(b => b.textContent.includes('Route zuweisen'));
              return !!btn && btn.disabled;
          }"""))

    # ── Multi-NPC entity refs ────────────────────────────────────────────────
    seed(page,
         [speed_event("e1", {"type": "simulation_time", "value": 0}, 10.0)],
         extra_npcs=[
             {"id": "obj-3", "type": "car", "x": 240.0, "y": 1.967, "z": 0.2,
              "yaw": 0,
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
    # The typo'd action still coerces to follow_trajectory — that coercion is
    # deliberate — but the result has no waypoints, and an event that cannot be
    # built is now rejected instead of silently vanishing. The old behaviour was
    # the worst of both: the NPC got no Act at all and simply held its Init
    # speed, with nothing anywhere pointing at the typo.
    seed(page, [{"id": "e1", "trigger": {"type": "teleport_when_ready"},
                 "action": {"type": "make_it_fly"}}],
         extra_npcs=[
             {"id": "obj-3", "type": "car", "x": 240.0, "y": 1.967, "z": 0.2,
              "yaw": 0, "events": [
                  speed_event("k1", {"type": "simulation_time", "value": 0}, 10.0)]},
         ])
    check("a typo'd action is rejected rather than silently dropped",
          H.export_status(page, _params(page)) == 400,
          str(H.export_status(page, _params(page))))

    # The coercion itself is unchanged — given waypoints, the typo'd action
    # still exports as a follow_trajectory.
    seed(page, [{"id": "e1", "trigger": {"type": "teleport_when_ready"},
                 "action": {"type": "make_it_fly", "trajectory": traj}}])
    xml = H.export_xosc(page)
    ev = H.parse_events(xml, entity="adversary")[0]
    check("an unknown action still coerces to follow_trajectory",
          ev["action"]["kind"] == "follow_trajectory", str(ev["action"]))
    check("an unknown trigger still coerces to simulation_time",
          ev["trigger"]["kind"] == "simulation_time", str(ev["trigger"]))

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
