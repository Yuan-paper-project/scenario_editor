"""Scenario templates: placement flow, pre-filled event chains, exported .xosc.

The templates are the least-covered part of the editor — none of the .xosc
fixtures in scenario_runner's scenario_tester/ carries a template's signature
chain, so until now they had never been checked beyond the UI.

Two layers here, and they catch different things:
  1. the event chain the template ATTACHES (templates.js data + objects.js
     _placeActor wiring). Pure UI, no export.
  2. the event chain that SURVIVES to the .xosc (buildScenarioParams ->
     validate_scenario_params -> event_builders). A template can be perfectly
     correct in the editor and still emit nothing usable.

The expectations below are written out literally rather than read back from
ScenarioTemplates — comparing the panel against itself would pass no matter
what the template data said.

    bash run.sh 9090            # terminal 1
    .venv/bin/python3 tests/test_templates_e2e.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from playwright.sync_api import sync_playwright  # noqa: E402
import _harness as H  # noqa: E402

check = H.Checks()

# (trigger_kind, trigger_arg, action_kind, action_arg, dynamics_value)
#   trigger_arg: metres for distance_to_ego, referenced event id for after_event
#   action_arg : target speed for set_speed, direction for lane_change
EXPECTED = {
    "vehicle-accelerating": ("car", [
        ("distance_to_ego", 400, "set_speed", 10.0, 5.0),
        ("after_event", "evt-1", "set_speed", 15.0, 10.0),
    ]),
    "vehicle-braking": ("car", [
        ("distance_to_ego", 400, "set_speed", 10.0, 5.0),
        ("after_event", "evt-1", "set_speed", 5.0, 10.0),
    ]),
    "vehicle-stopping": ("car", [
        ("distance_to_ego", 400, "set_speed", 10.0, 5.0),
        ("after_event", "evt-1", "set_speed", 5.0, 2.0),
        ("after_event", "evt-2", "set_speed", 0.0, 10.0),
    ]),
    "vehicle-stop-and-go": ("car", [
        ("distance_to_ego", 400, "set_speed", 10.0, 5.0),
        ("after_event", "evt-1", "set_speed", 5.0, 2.0),
        ("after_event", "evt-2", "set_speed", 0.0, 2.0),
        ("after_event", "evt-3", "set_speed", 5.0, 5.0),
    ]),
    "vehicle-lane-change-left": ("car", [
        ("distance_to_ego", 400, "set_speed", 10.0, 5.0),
        ("after_event", "evt-1", "lane_change", "left", 15.0),
        ("after_event", "evt-2", "set_speed", 10.0, 5.0),
    ]),
    "vehicle-lane-change-right": ("car", [
        ("distance_to_ego", 400, "set_speed", 10.0, 5.0),
        ("after_event", "evt-1", "lane_change", "right", 15.0),
        ("after_event", "evt-2", "set_speed", 10.0, 5.0),
    ]),
    "vehicle-pull-out": ("car", [
        ("distance_to_ego", 20, "set_speed", 5.0, 10.0),
        ("distance_to_ego", 20, "lane_change", "left", 10.0),
    ]),
    "pedestrian-crossing": ("pedestrian", [
        ("distance_to_ego", 50, "set_speed", 2.0, 10.0),
        ("after_event", "evt-1", "set_speed", 0.0, 5.0),
    ]),
    "pedestrian-along-lane": ("pedestrian", [
        ("distance_to_ego", 400, "set_speed", 2.0, 10.0),
    ]),
    "cyclist-crossing": ("cyclist", [
        ("distance_to_ego", 30, "set_speed", 4.0, 5.0),
        ("after_event", "evt-1", "set_speed", 0.0, 5.0),
    ]),
    "cyclist-along-lane": ("cyclist", [
        ("distance_to_ego", 400, "set_speed", 4.0, 10.0),
    ]),
}

EGO = (300.631, -2.025)
# One known-good spot on the ego's carriageway (borrowed from pedestrian.xosc),
# reused for every template with the actor removed in between. Placing all 11
# at once instead puts their SVG markers within a marker-width of each other at
# default zoom, and a click that lands on an existing marker selects it rather
# than placing anything. Using one spot also makes the along-lane vs crossing
# yaw comparison meaningful, since both are then on the same lane.
SPOT = (265.364, 1.967)


def summarise(events):
    """Editor-side event list -> the same tuple shape as EXPECTED."""
    out = []
    for ev in events:
        trig, act = ev.get("trigger") or {}, ev.get("action") or {}
        kind = trig.get("type")
        arg = trig.get("event_id") if kind == "after_event" else trig.get("value")
        if act.get("type") == "lane_change":
            out.append((kind, arg, "lane_change", act.get("direction"),
                        (act.get("dynamics") or {}).get("value")))
        else:
            out.append((kind, arg, act.get("type"),
                        (act.get("target") or {}).get("value"),
                        (act.get("dynamics") or {}).get("value")))
    return out


with sync_playwright() as p:
    browser, page, errors = H.open_editor(p, "Town01")

    check("no JS errors on load", not errors, str(errors[:3]))
    check("ScenarioTemplates global exists", page.evaluate("!!window.ScenarioTemplates"))

    n = page.evaluate("Object.keys(ScenarioTemplates.templates).length")
    check("11 templates registered", n == 11, f"got {n}")
    missing = page.evaluate("(ids)=>ids.filter(i=>!ScenarioTemplates.templates[i])",
                            list(EXPECTED))
    check("every expected template id exists", missing == [], str(missing))

    # ── Panel renders every template as a button ─────────────────────────────
    page.evaluate("AppState.select(null)")
    page.click('[data-overview-tab="templates"]')
    n_btns = page.evaluate("document.querySelectorAll('[data-template-action]').length")
    check("11 template buttons rendered", n_btns == 11, f"got {n_btns}")
    unbound = page.evaluate(
        "(ids)=>ids.filter(i=>!document.querySelector(`[data-template-action=\"${i}\"]`))",
        list(EXPECTED))
    check("every template has a button", unbound == [], str(unbound))

    # ── Placement + attached event chain, per template ───────────────────────
    H.place_actor(page, "ego", *EGO)
    check("ego placed", page.evaluate("!!AppState.ego"))

    placed = {}
    for tpl_id, (want_type, want_events) in EXPECTED.items():
        try:
            actor = H.place_template(page, tpl_id, *SPOT)
        except AssertionError as exc:
            check(f"{tpl_id}: placed", False, str(exc))
            continue
        placed[tpl_id] = actor
        check(f"{tpl_id}: actor type is {want_type}",
              actor["type"] == want_type, actor["type"])
        got = summarise(actor.get("events") or [])
        check(f"{tpl_id}: {len(want_events)} events attached",
              len(got) == len(want_events), f"got {len(got)}")
        check(f"{tpl_id}: event chain matches the template",
              got == want_events, f"got {got}")
        page.evaluate("(id) => AppState.removeById(id)", actor["id"])

    check("every template placed an actor", len(placed) == len(EXPECTED),
          f"{len(placed)}/{len(EXPECTED)}")
    check("map is empty again after removals",
          page.evaluate("AppState.npcs.length") == 0,
          str(page.evaluate("AppState.npcs.length")))

    check("templates do not leave the tool armed",
          page.evaluate("AppState.activeTool") is None,
          str(page.evaluate("AppState.activeTool")))
    check("templates clear pendingTemplate after placing",
          page.evaluate("AppState.pendingTemplate") is None)

    # ── Template-specific placement rules ────────────────────────────────────
    # Only three templates declare `placement`; the rest fall through to the
    # default spawn-point snap.
    decl = page.evaluate("""() => Object.fromEntries(
        Object.entries(ScenarioTemplates.templates)
              .map(([k,v]) => [k, v.placement || null]))""")
    with_placement = sorted(k for k, v in decl.items() if v)
    check("exactly 3 templates declare a placement rule",
          with_placement == ["cyclist-along-lane", "pedestrian-along-lane",
                             "vehicle-pull-out"], str(with_placement))
    check("pull-out snaps to lane centre within 12 m",
          decl["vehicle-pull-out"]["snap"] == "lane-center"
          and decl["vehicle-pull-out"]["maxDistance"] == 12,
          str(decl["vehicle-pull-out"]))
    check("along-lane templates orient along the lane",
          decl["pedestrian-along-lane"]["orientation"] == "along-lane"
          and decl["cyclist-along-lane"]["orientation"] == "along-lane")

    # A pedestrian placed by the along-lane template must run WITH the lane;
    # the crossing template leaves the default road-facing yaw, which is
    # perpendicular to it. If these two ever agree, the rule stopped applying.
    if "pedestrian-along-lane" in placed and "pedestrian-crossing" in placed:
        along = placed["pedestrian-along-lane"]["yaw"]
        cross = placed["pedestrian-crossing"]["yaw"]
        delta = abs(((along - cross) + 180) % 360 - 180)
        check("along-lane yaw differs from crossing yaw",
              delta > 20, f"along={along} crossing={cross} delta={delta:.1f}")

    # ── Export: does the chain survive to the .xosc? ─────────────────────────
    # Re-seed with a single template so entity refs stay predictable, then let
    # the real export path run.
    def export_template(tpl_id):
        page.evaluate("""(id) => {
            AppState.npcs = [];
            AppState.staticObjects = [];
            AppState.ego = {id:'obj-1', type:'ego', x:300.631, y:-2.025,
                            z:0.2, yaw:180, trajectory:[], events:[]};
            const actor = {id:'obj-2',
                           type: ScenarioTemplates.templates[id].actorType,
                           x:265.364, y:1.967, z:0.2, yaw:0,
                           events:[]};
            actor.events = ScenarioTemplates.eventsForActor(actor, id);
            AppState.npcs = [actor];
            AppState.set({});
        }""", tpl_id)
        return H.export_xosc(page)

    for tpl_id in ("vehicle-stopping", "vehicle-lane-change-left",
                   "vehicle-pull-out", "pedestrian-crossing", "cyclist-crossing"):
        want_type, want_events = EXPECTED[tpl_id]
        xml = export_template(tpl_id)
        evs = H.parse_events(xml, entity="adversary")

        check(f"{tpl_id}: exports {len(want_events)} events",
              len(evs) == len(want_events), f"got {len(evs)}")
        check(f"{tpl_id}: no dangling after_event refs",
              H.dangling_event_refs(xml) == [], str(H.dangling_event_refs(xml)))

        for i, (want, got) in enumerate(zip(want_events, evs)):
            t_kind, t_arg, a_kind, a_arg, dyn = want
            check(f"{tpl_id}[{i}]: action is {a_kind}",
                  got["action"]["kind"] == a_kind, got["action"]["kind"])
            if a_kind == "set_speed":
                check(f"{tpl_id}[{i}]: target speed {a_arg}",
                      got["action"].get("value") == a_arg,
                      str(got["action"].get("value")))
                # 'step' is what makes the duration a hold rather than a ramp;
                # if this ever becomes 'linear' the CARLA timing assertions in
                # carla_cases.py stop being valid.
                check(f"{tpl_id}[{i}]: dynamicsShape is step",
                      got["action"].get("shape") == "step",
                      str(got["action"].get("shape")))
                check(f"{tpl_id}[{i}]: duration {dyn} survives export",
                      got["action"].get("dynamics_value") == dyn,
                      str(got["action"].get("dynamics_value")))
            elif a_kind == "lane_change":
                want_offset = 1 if a_arg == "left" else -1
                check(f"{tpl_id}[{i}]: lane offset {want_offset} ({a_arg})",
                      got["action"].get("lane_offset") == want_offset,
                      str(got["action"].get("lane_offset")))
                check(f"{tpl_id}[{i}]: lane change is relative to itself",
                      got["action"].get("relative_to") == "adversary",
                      str(got["action"].get("relative_to")))

            check(f"{tpl_id}[{i}]: trigger is {t_kind}",
                  got["trigger"]["kind"] == t_kind, got["trigger"]["kind"])
            if t_kind == "distance_to_ego":
                check(f"{tpl_id}[{i}]: trigger distance {t_arg} m",
                      got["trigger"].get("value") == float(t_arg),
                      str(got["trigger"].get("value")))
                check(f"{tpl_id}[{i}]: hero is the triggering entity",
                      got["trigger"].get("triggered_by") == ["hero"],
                      str(got["trigger"].get("triggered_by")))
                check(f"{tpl_id}[{i}]: 60 s time fallback present",
                      got["trigger"].get("fallback_time") == 60.0,
                      str(got["trigger"].get("fallback_time")))
            elif t_kind == "after_event":
                # ids are remapped to generated event NAMES on export
                check(f"{tpl_id}[{i}]: chains off event {i-1}",
                      got["trigger"].get("ref") == evs[i - 1]["name"],
                      f"{got['trigger'].get('ref')} vs {evs[i-1]['name']}")
                check(f"{tpl_id}[{i}]: waits for completeState",
                      got["trigger"].get("state") == "completeState",
                      str(got["trigger"].get("state")))

    # pedestrians and cyclists must reach the .xosc as the right entity kind
    xml = export_template("pedestrian-crossing")
    check("pedestrian template exports a Pedestrian entity",
          "<Pedestrian" in xml, "no <Pedestrian> element")
    # The editor says 'cyclist'; the catalogue only knows 'bike'. This asserts
    # xml_builder._TYPE_ALIASES actually resolved it, rather than falling
    # through to the 'car' default the way an unknown type would.
    xml = export_template("cyclist-crossing")
    check("cyclist resolves through the bike alias to its blueprint",
          "vehicle.diamondback.century" in xml,
          "expected vehicle.diamondback.century (bike npc_default)")

    unexpected = [e for e in errors if "400 (Bad Request)" not in e]
    check("no unexpected JS errors during the run", not unexpected, str(unexpected[:3]))
    browser.close()

sys.exit(check.report())
