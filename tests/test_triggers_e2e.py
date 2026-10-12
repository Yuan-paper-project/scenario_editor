"""End-to-end checks for the event_started and ego_speed triggers, the ban on
an NPC waiting for an ego event, and the per-vehicle obey toggles.

Covers every layer each feature crosses: the event card (eventPanel.js), the
shared rules (ScenarioRules in app.js), the export payload (scenarioIO.js), the
backend (scenario_io.py, via a real /api/export), the emitted .xosc
(event_builders.py / xml_builder.py) and the preview (simulate.js).

    bash run.sh 9090 && .venv/bin/python3 tests/test_triggers_e2e.py
"""
import sys
import xml.etree.ElementTree as ET

from playwright.sync_api import sync_playwright

import _harness as H

check = H.Checks()

EGO_ID, NPC1, NPC2 = "obj-1", "obj-2", "obj-3"


def speed_event(eid, trigger, value=10.0, duration=5.0):
    return {"id": eid, "trigger": trigger,
            "action": {"type": "set_speed",
                       "dynamics": {"shape": "step", "dimension": "time", "value": duration},
                       "target": {"mode": "absolute", "value": value}}}


def offset_event(eid, trigger):
    return {"id": eid, "trigger": trigger,
            "action": {"type": "lane_offset", "direction": "left", "offset": 1.0}}


def seed(page, ego_events, npc1_events=(), npc2_events=None, ego_speed=0.0, npc_type="car"):
    """Ego + one or two NPCs on Town01 road 1, via loadJSON (the Laden path)."""
    npcs = [{"id": NPC1, "type": npc_type, "x": 265.364, "y": 1.967, "z": 0.5, "yaw": 0,
             "events": list(npc1_events)}]
    if npc2_events is not None:
        npcs.append({"id": NPC2, "type": "car", "x": 240.0, "y": 1.967, "z": 0.5, "yaw": 0,
                     "events": list(npc2_events)})
    page.evaluate("""(p) => AppState.loadJSON({
        map: 'Town01', weather: {}, time: 'daytime', ego: p.ego, npcs: p.npcs,
        staticObjects: [], trafficSignals: [] })""", {
        "ego": {"id": EGO_ID, "type": "ego", "x": 300.631, "y": -2.025, "z": 0.5,
                "yaw": 180, "initial_speed": ego_speed, "events": list(ego_events)},
        "npcs": npcs,
    })


def trigger_options(page):
    """[value] of the first card's Auslöser select."""
    return page.evaluate("""() => [...document.querySelector('.event-card .event-trigger-block select')
        .options].map(o => o.value)""")


def ref_select_groups(page, card=0):
    """{group label: [option values]} of a card's event-reference select."""
    return page.evaluate("""(card) => {
        const sel = document.querySelectorAll('.event-card')[card]
            .querySelectorAll('.event-trigger-block select')[1];
        const out = {};
        for (const g of sel.querySelectorAll('optgroup'))
            out[g.label] = [...g.querySelectorAll('option')].map(o => o.value);
        return out;
    }""", card)


def problems(page, actor_id):
    return page.evaluate("""(id) => ScenarioRules.problemsOf(AppState.findById(id))
        .map(p => p.problem.code)""", actor_id)


def params(page):
    return page.evaluate("() => ScenarioIO.buildParamsForTesting()")


def headless(page, max_time=12):
    return page.evaluate(f"() => Simulate.runHeadless({{ dt: 0.05, maxTime: {max_time} }})")


with sync_playwright() as p:
    browser, page, errors = H.open_editor(p, "Town01")
    check("no JS errors on load", not errors, str(errors[:3]))

    # ── Trigger dropdown ─────────────────────────────────────────────────────
    seed(page, [H.MIN_EVENT], [speed_event("e1", {"type": "simulation_time", "value": 1})])
    page.evaluate(f"AppState.select('{NPC1}')")
    opts = trigger_options(page)
    check("an NPC is offered all seven triggers",
          opts == ["simulation_time", "distance_to_ego", "distance_to_point",
                   "ego_speed", "relative_speed", "after_event", "event_started"], str(opts))
    page.evaluate(f"AppState.select('{EGO_ID}')")
    opts = trigger_options(page)
    # With an NPC to measure against, the ego gets „Abstand zu Akteur" too
    # (naming the NPC); without one it does not — test_actions_ext_e2e.py.
    check("the ego is offered ego_speed, event_started and the actor-relative triggers",
          "ego_speed" in opts and "event_started" in opts and "distance_to_ego" in opts
          and "relative_speed" in opts, str(opts))

    # ── An NPC may not wait on an ego event ──────────────────────────────────
    seed(page, [speed_event("ea", {"type": "simulation_time", "value": 1})],
         [speed_event("n1", {"type": "simulation_time", "value": 1}),
          speed_event("n2", {"type": "after_event", "event_id": "n1"})],
         [speed_event("m1", {"type": "simulation_time", "value": 2})])
    page.evaluate(f"AppState.select('{NPC1}')")
    groups = ref_select_groups(page, 1)
    flat = [v for vs in groups.values() for v in vs]
    check("an NPC's 'Nach Event' dropdown has no ego group",
          "EGO" not in groups and not any(v.startswith(EGO_ID + "::") for v in flat), str(groups))
    check("... but still offers another NPC's event",
          f"{NPC2}::m1" in flat, str(groups))

    # Switch n2 to event_started through the real select.
    page.evaluate("""() => {
        const sel = document.querySelectorAll('.event-card')[1]
            .querySelector('.event-trigger-block select');
        sel.value = 'event_started';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
    }""")
    trig = page.evaluate(f"AppState.findById('{NPC1}').events[1].trigger")
    check("choosing 'Mit Start eines Events' writes an event_started on the first offered event",
          trig == {"type": "event_started", "event_id": "n1"}, str(trig))
    groups = ref_select_groups(page, 1)
    check("the event_started dropdown has no ego group either",
          "EGO" not in groups, str(groups))
    summary = page.evaluate("() => document.querySelectorAll('.event-card')[1]"
                            ".querySelector('.event-trigger-block').textContent")
    check("the reference row is labelled 'Mit Event'", "Mit Event" in summary, summary[:120])

    page.evaluate(f"AppState.select('{EGO_ID}')")
    page.click('#event-action-grid .event-action-button:has-text("Geschw. setzen")')
    page.evaluate("""() => {
        const cards = document.querySelectorAll('.event-card');
        const sel = cards[cards.length - 1].querySelector('.event-trigger-block select');
        sel.value = 'after_event';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
    }""")
    groups = ref_select_groups(page, 1)
    check("the ego's own dropdown still offers NPC events",
          any(v.startswith(NPC1 + "::") for vs in groups.values() for v in vs), str(groups))

    # A file that already has an NPC -> ego reference: chipped, gated, 400.
    for kind in ("after_event", "event_started"):
        seed(page, [speed_event("ea", {"type": "simulation_time", "value": 1})],
             [speed_event("n1", {"type": kind, "event_id": "ea", "actor_ref": EGO_ID})])
        check(f"a loaded NPC {kind} naming an ego event is chipped",
              problems(page, NPC1) == ["npc_waits_on_ego"], str(problems(page, NPC1)))
        page.evaluate(f"AppState.select('{NPC1}')")
        chip = page.evaluate("document.querySelector('.event-problem')?.textContent || ''")
        check(f"... and the card says why ({kind})", "Ego-Event" in chip, chip)
        status = H.export_status(page, params(page))
        check(f"... and the backend refuses it with a 400 ({kind})", status == 400, str(status))

    # A reference to the ego's ROUTE is rewritten, not banned (the rewrite
    # runs first in every layer).
    route = {"id": "r", "trigger": {"type": "simulation_time", "value": 0},
             "action": {"type": "assign_route", "route_strategy": "fastest",
                        "waypoints": [{"x": 300.6, "y": -2.0, "z": 0.5, "strategy": "fastest"},
                                      {"x": 250.0, "y": -2.0, "z": 0.5, "strategy": "fastest"}]}}
    seed(page, [route], [speed_event("n1", {"type": "after_event", "event_id": "r",
                                            "actor_ref": EGO_ID})])
    check("an NPC reference to the ego's assign_route is not chipped (it is rewritten)",
          problems(page, NPC1) == [], str(problems(page, NPC1)))
    check("... and exports", H.export_status(page, params(page)) == 200)

    # ── event_started: lane_offset rule, payload, .xosc ──────────────────────
    seed(page, [H.MIN_EVENT],
         [offset_event("o1", {"type": "distance_to_ego", "value": 30}),
          speed_event("n2", {"type": "simulation_time", "value": 1})])
    page.evaluate(f"AppState.select('{NPC1}')")
    page.evaluate("""() => {
        const sel = document.querySelectorAll('.event-card')[1]
            .querySelector('.event-trigger-block select');
        sel.value = 'after_event';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
    }""")
    flat = [v for vs in ref_select_groups(page, 1).values() for v in vs]
    check("after_event never offers a lane_offset", f"{NPC1}::o1" not in flat, str(flat))
    page.evaluate("""() => {
        const sel = document.querySelectorAll('.event-card')[1]
            .querySelector('.event-trigger-block select');
        sel.value = 'event_started';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
    }""")
    flat = [v for vs in ref_select_groups(page, 1).values() for v in vs]
    check("event_started does offer a lane_offset (its start is well defined)",
          f"{NPC1}::o1" in flat, str(flat))
    check("an event_started onto a lane_offset has no problem",
          problems(page, NPC1) == [], str(problems(page, NPC1)))

    seed(page, [speed_event("ea", {"type": "event_started", "event_id": "m1",
                                    "actor_ref": NPC2})],
         [speed_event("n1", {"type": "distance_to_ego", "value": 40}),
          speed_event("n2", {"type": "event_started", "event_id": "n1"}),
          speed_event("n3", {"type": "ego_speed", "rule": "lessThan", "value": 3.5})],
         [speed_event("m1", {"type": "event_started", "event_id": "n1",
                             "actor_ref": NPC1})])
    prm = params(page)
    check("the payload remaps an event_started actor_ref to an entity name",
          prm["npcs"][1]["events"][0]["trigger"] ==
          {"type": "event_started", "event_id": "n1", "actor_ref": "adversary"},
          str(prm["npcs"][1]["events"][0]["trigger"]))
    check("the payload fills a same-actor event_started's actor_ref too",
          prm["npcs"][0]["events"][1]["trigger"]["actor_ref"] == "adversary",
          str(prm["npcs"][0]["events"][1]["trigger"]))
    xosc = H.xosc_from_params(page, prm)
    root = ET.fromstring(xosc)
    events = {e.get("name"): e for e in root.iter("Event")}

    def state_cond(name):
        c = events[name].find(".//StoryboardElementStateCondition")
        return None if c is None else (c.get("storyboardElementRef"), c.get("state"))

    check("same-actor event_started -> startTransition",
          state_cond("adversary_SpeedEvent1") == ("adversary_SpeedEvent0", "startTransition"),
          str(state_cond("adversary_SpeedEvent1")))
    check("cross-actor event_started -> startTransition on the other actor's event",
          state_cond("adversary1_SpeedEvent0") == ("adversary_SpeedEvent0", "startTransition"),
          str(state_cond("adversary1_SpeedEvent0")))
    check("the ego may wait for an NPC's start",
          state_cond("hero_SpeedEvent0") == ("adversary1_SpeedEvent0", "startTransition"),
          str(state_cond("hero_SpeedEvent0")))
    spd = events["adversary_SpeedEvent2"].find(".//SpeedCondition")
    ent = events["adversary_SpeedEvent2"].find(".//TriggeringEntities/EntityRef")
    check("ego_speed -> SpeedCondition lessThan 3.5 on hero",
          spd is not None and spd.get("rule") == "lessThan"
          and float(spd.get("value")) == 3.5 and ent.get("entityRef") == "hero",
          str(spd.attrib if spd is not None else None))
    check("no storyboardElementRef dangles", not H.dangling_event_refs(xosc),
          str(H.dangling_event_refs(xosc)))
    check("no entityRef dangles", not H.dangling_entity_refs(xosc),
          str(H.dangling_entity_refs(xosc)))

    # ── Cycles through event_started ─────────────────────────────────────────
    seed(page, [H.MIN_EVENT],
         [speed_event("n1", {"type": "event_started", "event_id": "m1", "actor_ref": NPC2})],
         [speed_event("m1", {"type": "after_event", "event_id": "n1", "actor_ref": NPC1})])
    check("a mixed event_started / after_event loop is chipped as a cycle",
          problems(page, NPC1) == ["cyclic_after_event"], str(problems(page, NPC1)))
    check("... and refused by the backend", H.export_status(page, params(page)) == 400)

    # ── Delete sweep keeps the trigger kind ──────────────────────────────────
    seed(page, [H.MIN_EVENT],
         [speed_event("n1", {"type": "simulation_time", "value": 1}),
          speed_event("n2", {"type": "simulation_time", "value": 2})],
         [speed_event("m1", {"type": "event_started", "event_id": "n2", "actor_ref": NPC1})])
    page.evaluate(f"AppState.select('{NPC1}')")
    page.evaluate("document.querySelectorAll('.event-card .event-delete')[1].click()")
    trig = page.evaluate(f"AppState.findById('{NPC2}').events[0].trigger")
    check("deleting the target re-points a foreign event_started and keeps its kind",
          trig == {"type": "event_started", "event_id": "n1", "actor_ref": NPC1}, str(trig))

    # ── Preview ──────────────────────────────────────────────────────────────
    # n1 fires at t > 2 s; n2 starts WITH it; m1 (other NPC) starts with it too;
    # n3 waits for n1 to complete (5 s hold). n2 is a lane_offset on purpose: a
    # second set_speed would supersede n1 and so END it on the spot, exactly as
    # ChangeActorTargetSpeed does in CARLA. The ego steps from 4 to 12 m/s at
    # t > 3 s, so ego_speed > 8 fires then.
    seed(page,
         [speed_event("ea", {"type": "simulation_time", "value": 3}, value=12.0, duration=20)],
         [speed_event("n1", {"type": "simulation_time", "value": 2}, value=2.0),
          offset_event("n2", {"type": "event_started", "event_id": "n1"}),
          speed_event("n3", {"type": "after_event", "event_id": "n1"}, value=4.0)],
         [speed_event("m1", {"type": "event_started", "event_id": "n1", "actor_ref": NPC1}),
          speed_event("m2", {"type": "ego_speed", "rule": "greaterThan", "value": 8.0})],
         ego_speed=4.0)
    run = headless(page)
    f1, f2 = run["fired"][NPC1], run["fired"][NPC2]
    t_n1 = f1.get("n1")
    check("preview: n1 fires on its clock", t_n1 is not None and 2.0 <= t_n1 < 2.2, str(f1))
    check("preview: same-actor event_started fires with its target",
          f1.get("n2") is not None and abs(f1["n2"] - t_n1) < 0.11, str(f1))
    check("preview: cross-actor event_started fires within one tick of its target",
          f2.get("m1") is not None and 0 <= f2["m1"] - t_n1 < 0.11, str(f2))
    check("preview: after_event still waits for completion",
          f1.get("n3") is not None and f1["n3"] - t_n1 > 4.9, str(f1))
    # The step to 12 m/s at t > 3 s is a ramp at the ego's max_acceleration
    # (3 m/s², SimpleVehicleControl), so 8 m/s is passed ~4/3 s later.
    check("preview: ego_speed fires once the ego passes 8 m/s (≈ 3 + 4/3 s)",
          f2.get("m2") is not None and 4.2 < f2["m2"] < 4.6, str(f2))

    seed(page, [speed_event("ea", {"type": "simulation_time", "value": 1})],
         [speed_event("n1", {"type": "after_event", "event_id": "ea", "actor_ref": EGO_ID})])
    run = headless(page, 8)
    check("preview: an NPC waiting on an ego event never fires",
          "n1" not in run["fired"][NPC1], str(run["fired"][NPC1]))

    # ── Obey toggles ─────────────────────────────────────────────────────────
    seed(page, [H.MIN_EVENT], [speed_event("n1", {"type": "simulation_time", "value": 1})])
    page.evaluate(f"AppState.select('{NPC1}')")
    visible = page.evaluate("!document.getElementById('obey-row').classList.contains('hidden')")
    checked = page.evaluate("[document.getElementById('prop-obey-lights').checked,"
                            " document.getElementById('prop-obey-obstacles').checked]")
    check("a car shows both obey toggles, on by default", visible and checked == [True, True],
          str((visible, checked)))
    page.uncheck("#prop-obey-lights")
    check("unchecking 'Ampeln beachten' writes obey_traffic_lights: false",
          page.evaluate(f"AppState.findById('{NPC1}').obey_traffic_lights") is False)
    page.evaluate("UndoStack.undo()")
    check("... and is one undo step",
          page.evaluate(f"AppState.findById('{NPC1}').obey_traffic_lights") is not False)
    page.evaluate("UndoStack.redo()")
    page.evaluate(f"AppState.select('{EGO_ID}')")
    check("the ego shows the toggles too",
          page.evaluate("!document.getElementById('obey-row').classList.contains('hidden')"))
    page.uncheck("#prop-obey-obstacles")
    prm = params(page)
    check("payload carries the flags (ego obstacles off, NPC lights off)",
          (prm["ego"]["obey_traffic_lights"], prm["ego"]["obey_obstacles"],
           prm["npcs"][0]["obey_traffic_lights"], prm["npcs"][0]["obey_obstacles"])
          == (True, False, False, True), str(prm["ego"]))
    xosc = H.xosc_from_params(page, prm)
    root = ET.fromstring(xosc)

    def consider(entity):
        return {pp.get("name"): pp.get("value") for pp in root.findall(
            f".//Private[@entityRef='{entity}']//Controller/Properties/Property")
            if pp.get("name", "").startswith("consider_")}

    check("hero controller: consider_obstacles false, lights true",
          consider("hero") == {"consider_trafficlights": "true", "consider_obstacles": "false"},
          str(consider("hero")))
    check("NPC controller: consider_trafficlights false, obstacles true",
          consider("adversary") == {"consider_trafficlights": "false", "consider_obstacles": "true"},
          str(consider("adversary")))
    saved = page.evaluate("AppState.toJSON()")
    page.evaluate("(d) => AppState.loadJSON(d)", saved)
    check("the flags survive a save/load round trip",
          page.evaluate(f"[AppState.ego.obey_obstacles, AppState.findById('{NPC1}').obey_traffic_lights]")
          == [False, False])

    seed(page, [H.MIN_EVENT], [], npc_type="pedestrian")
    page.evaluate(f"AppState.select('{NPC1}')")
    check("a pedestrian has no obey toggles",
          page.evaluate("document.getElementById('obey-row').classList.contains('hidden')"))

    # The deliberate 400 exports above log a failed request; nothing else may.
    errors = [e for e in errors if "status of 400" not in e]
    check("no JS errors during the run", not errors, str(errors[:3]))
    browser.close()

sys.exit(check.report())
