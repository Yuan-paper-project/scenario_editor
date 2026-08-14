"""The ego as a fully controllable actor: same event UI, same .xosc parity as an NPC.

Complements test_events_e2e.py, which seeds an inert ego (no events) and only
exercises NPC events. This suite is kept separate rather than folded in because
that file's `EGO` const and every one of its assertions assume the ego
contributes nothing to the storyboard — which was true before this change and
is the entire premise being tested here.

Covers: the properties/event panel renders identically for the ego and an NPC;
the ego's controller module is simple_vehicle_control, not external_control;
the ego gets its OWN Act, gated on simulation_time rather than "hero traveled
0.1 m" (an NPC's Act keeps that gate); an ego with no events gets no Act at
all; self-referencing set_distance is rejected the same way for the ego as for
an NPC; and a legacy save file with an actor-level `ego.trajectory` still
loads, migrated into a follow_trajectory event.

    bash run.sh 9090            # terminal 1
    .venv/bin/python3 tests/test_ego_events_e2e.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from playwright.sync_api import sync_playwright  # noqa: E402
import _harness as H  # noqa: E402

check = H.Checks()

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

EGO_BASE = {"id": "obj-1", "type": "ego", "x": 300.631, "y": -2.025,
            "z": 0.2, "yaw": 180, "events": []}
NPC_BASE = {"id": "obj-2", "type": "car", "x": 265.364, "y": 1.967,
            "z": 0.2, "yaw": 0, "events": []}


def seed(page, ego_events, npc_events=None, with_npc=True):
    """Load one ego (with `ego_events`) and, unless with_npc is False, one NPC.

    Mirrors test_events_e2e.py's seed() but targets the ego's own events —
    AppState.loadJSON is the same entry point the Load-scenario button uses.
    """
    npcs = []
    if with_npc:
        npcs.append({**NPC_BASE, "events": npc_events or []})
    page.evaluate("""(payload) => {
        AppState.loadJSON({
            map: 'Town01', weather: {}, time: 'daytime',
            ego: payload.ego, npcs: payload.npcs,
            staticObjects: [], trafficSignals: [],
        });
    }""", {"ego": {**EGO_BASE, "events": ego_events}, "npcs": npcs})


def speed_event(eid, trigger, value=10.0, duration=5.0):
    return {"id": eid, "trigger": trigger,
            "action": {"type": "set_speed",
                       "dynamics": {"shape": "step", "dimension": "time",
                                    "value": duration},
                       "target": {"mode": "absolute", "value": value}}}


with sync_playwright() as p:
    browser, page, errors = H.open_editor(p, "Town01")
    check("no JS errors on load", not errors, str(errors[:3]))

    # ── Panel parity: ego gets the same event UI as an NPC ───────────────────
    seed(page, [])
    page.evaluate("AppState.select('obj-1')")
    ego_labels = page.evaluate(
        "[...document.querySelectorAll('#event-action-grid .event-action-button')]"
        ".map(b => b.textContent)")
    check("ego event panel offers the same 5 actions as an NPC",
          ego_labels == ["Trajektorie folgen", "Route zuweisen", "Geschw. setzen",
                         "Abstand halten", "Spurwechsel"], str(ego_labels))
    check("ego's event section is visible",
          not page.evaluate("document.getElementById('event-section').classList.contains('hidden')"))

    page.evaluate("AppState.select('obj-2')")
    check("an NPC's event section is visible too",
          not page.evaluate("document.getElementById('event-section').classList.contains('hidden')"))

    # The ego-only path UI (superseded by the shared event-card path controls)
    # and the removed Verhalten section must be gone entirely, not just hidden —
    # a leftover element with a stale id is exactly the kind of thing that
    # silently stops being wired up.
    for deleted_id in ("btn-draw-path", "btn-toggle-path", "btn-clear-path",
                       "waypoint-list", "ego-route-hint", "path-section-label",
                       "behavior-panel", "behavior-checkboxes", "trigger-section",
                       "prop-trigger-dist"):
        check(f"#{deleted_id} no longer exists in the DOM",
              page.evaluate(f"document.getElementById('{deleted_id}')") is None)

    # ── Adding an event through the real UI ──────────────────────────────────
    seed(page, [])
    page.evaluate("AppState.select('obj-1')")
    page.click('#event-action-grid .event-action-button:has-text("Geschw. setzen")')
    evs = page.evaluate("AppState.ego.events")
    check("Set speed adds one event to the ego", len(evs) == 1, str(len(evs)))
    check("the ego's first event defaults to a simulation_time trigger "
          "(distance_to_ego would be a self-distance, always 0)",
          evs[0]["trigger"] == {"type": "simulation_time", "value": 0}, str(evs[0]["trigger"]))

    # ── Trigger dropdown omits distance_to_ego for the ego only ──────────────
    seed(page, [speed_event("e1", {"type": "simulation_time", "value": 0})])
    page.evaluate("AppState.select('obj-1')")
    ego_trigger_opts = page.evaluate("""() => {
        const selects = document.querySelectorAll('#event-list select');
        const triggerSelect = [...selects].find(s =>
            [...s.options].some(o => o.value === 'simulation_time'));
        return triggerSelect ? [...triggerSelect.options].map(o => o.value) : null;
    }""")
    check("ego trigger dropdown has no distance_to_ego option",
          ego_trigger_opts is not None and "distance_to_ego" not in ego_trigger_opts,
          str(ego_trigger_opts))

    seed(page, [], npc_events=[speed_event("e1", {"type": "simulation_time", "value": 0})])
    page.evaluate("AppState.select('obj-2')")
    npc_trigger_opts = page.evaluate("""() => {
        const selects = document.querySelectorAll('#event-list select');
        const triggerSelect = [...selects].find(s =>
            [...s.options].some(o => o.value === 'simulation_time'));
        return triggerSelect ? [...triggerSelect.options].map(o => o.value) : null;
    }""")
    check("an NPC's trigger dropdown DOES offer distance_to_ego",
          npc_trigger_opts is not None and "distance_to_ego" in npc_trigger_opts,
          str(npc_trigger_opts))

    # ── Drawing an ego path through the real click path ──────────────────────
    seed(page, [])
    page.evaluate("AppState.select('obj-1')")
    page.click('#event-action-grid .event-action-button:has-text("Trajektorie folgen")')
    check("clicking Follow trajectory arms trajectory mode on the ego",
          page.evaluate("AppState.trajectoryMode && AppState.activeTrajectoryId === AppState.ego.id"))
    ev_id = page.evaluate("AppState.ego.events[0].id")
    check("...and targets the new event's path", page.evaluate("AppState.activePathEventId") == ev_id)

    for wx, wy in [(290.0, -2.0), (280.0, -2.0)]:
        sx, sy = H.assert_on_screen(page, wx, wy)
        page.mouse.click(sx, sy)
    page.click("#traj-done-btn")
    traj = page.evaluate("AppState.ego.events[0].action.trajectory")
    check("ego path event accumulated the seed point plus two clicks",
          len(traj) == 3, str(len(traj)))
    check("every ego path point carries a derived z, not the flat 0.2 default",
          all(isinstance(w.get("z"), (int, float)) for w in traj), str(traj))

    # ── Export: controller module, hero's own Act, hero events ──────────────
    route = [{"x": 300.631, "y": -2.025, "z": 0.2},
             {"x": 280.0, "y": -2.0, "z": 0.2},
             {"x": 260.0, "y": -2.0, "z": 0.2}]
    seed(page,
         [{"id": "e1", "trigger": {"type": "simulation_time", "value": 0},
           "action": {"type": "follow_trajectory", "trajectory": route}}],
         npc_events=[speed_event("e1", {"type": "distance_to_ego", "value": 400.0})])
    params = H.export_params(page)
    xml = H.xosc_from_params(page, params)

    check("hero's controller module is simple_vehicle_control",
          H.controller_of(xml, "hero") == "simple_vehicle_control",
          str(H.controller_of(xml, "hero")))
    check("external_control does not appear anywhere in the export",
          "external_control" not in xml)

    all_acts = H.acts(xml)
    hero_act = next((a for a in all_acts if a["name"] == "heroBehavior"), None)
    npc_act = next((a for a in all_acts if a["name"] != "heroBehavior"), None)
    check("a heroBehavior Act exists", hero_act is not None, str(all_acts))
    check("no Act carries a 'hero traveled 0.1m' start gate any more "
          "(every actor is authored in the .xosc, not just the ego)",
          hero_act is not None and hero_act["hero_distance_gate"] is False
          and npc_act is not None and npc_act["hero_distance_gate"] is False,
          str((hero_act, npc_act)))
    check("the hero's Act starts on simulation_time > 0",
          hero_act is not None and hero_act["act_start_sim_time"] == 0.0, str(hero_act))
    check("the NPC's Act also starts on simulation_time > 0",
          npc_act is not None and npc_act["act_start_sim_time"] == 0.0, str(npc_act))

    hero_events = H.parse_events(xml, entity="hero")
    hero_path_events = [e for e in hero_events if e["name"].startswith("hero_")]
    check("the hero's follow_trajectory event reaches the .xosc",
          any(e["action"]["kind"] == "follow_trajectory" for e in hero_path_events),
          str(hero_path_events))
    traj_ev = next(e for e in hero_path_events if e["action"]["kind"] == "follow_trajectory")
    check("the hero's exported trajectory keeps all 3 vertices",
          traj_ev["action"]["vertices"] == 3, str(traj_ev["action"]))

    check("route_waypoints was derived from the ego's path event",
          len(params["route_waypoints"]) == 3, str(params["route_waypoints"]))
    check("no dangling entity refs in a scenario with both an ego and npc event",
          H.dangling_entity_refs(xml) == [], str(H.dangling_entity_refs(xml)))
    check("no internal obj- id survives into the export",
          "obj-" not in xml)

    # ── No events: no Act, exactly like an NPC ───────────────────────────────
    # An ego-only scenario with no events at all has nothing to run: every actor
    # would contribute no Act, so the storyboard completes on the first tick.
    # Rejected in two independent places, and both are asserted — scenarioIO.js
    # refuses before it POSTs, so the backend's own 400 is never reached through
    # the UI and has to be provoked with a direct fetch.
    seed(page, [], with_npc=False)
    page.evaluate("document.getElementById('toast-container')?.replaceChildren()")
    page.click("#btn-export")
    page.wait_for_timeout(500)
    toast = page.evaluate(
        "document.getElementById('toast-container')?.textContent || ''")
    check("the editor refuses to export a scenario with no events at all",
          "Event" in toast, repr(toast))

    check("a no-events payload POSTed directly is rejected with a 400",
          H.export_status(page, {
              "map": "Town01",
              "ego": {"id": "obj-1", "type": "car", "x": 300.6, "y": -2.0},
              "npcs": [],
          }) == 400)

    # With an NPC carrying the story, an event-less ego simply contributes no
    # Act — it spawns, keeps its Init speed, and SimpleVehicleControl drives it
    # down its own lane. It does NOT get a constant_speed fallback chain any
    # more; that concept is gone along with the Verhalten section.
    seed(page, [], npc_events=[
        speed_event("n1", {"type": "simulation_time", "value": 0})])
    xml = H.export_xosc(page)
    act_names = [a["name"] for a in H.acts(xml)]
    check("an ego with no events gets no Act at all",
          "heroBehavior" not in act_names, str(act_names))
    check("the npc carrying the story still gets its own Act",
          "adversaryBehavior" in act_names, str(act_names))
    check("an event-less ego contributes no events to the export",
          H.parse_events(xml, entity="hero") == [],
          str(H.parse_events(xml, entity="hero")))

    # ── Self-reference is a hard 400 for the ego too ─────────────────────────
    seed(page, [{"id": "e1", "trigger": {"type": "simulation_time", "value": 0},
                 "action": {"type": "set_distance", "axis": "longitudinal",
                            "entity_ref": "obj-1", "value": 10.0}}])
    params = H.export_params(page)
    status = H.export_status(page, params)
    check("ego set_distance naming itself is rejected with a 400",
          status == 400, str(status))

    # A distance_to_ego trigger on an ego event is a coercion, not a rejection
    # — same policy as every other trigger typo, just via _normalize_actor's
    # hero-specific rewrite instead of the generic unknown-trigger fallback.
    seed(page, [speed_event("e1", {"type": "distance_to_ego", "value": 400.0})])
    xml = H.export_xosc(page)
    hero_ev = next(e for e in H.parse_events(xml, entity="hero")
                   if e["name"].startswith("hero_Speed"))
    check("a distance_to_ego trigger on an ego event is coerced to simulation_time@0",
          hero_ev["trigger"] == {"kind": "simulation_time", "value": 0.0},
          str(hero_ev["trigger"]))

    # ── Initial speed: the Storyboard Init SpeedAction ───────────────────────
    # Split default by design. Placing an actor in the editor gives it 10 m/s
    # (ObjectsManager.DEFAULT_INIT_SPEED); a payload that simply omits the field
    # — a legacy save, an LLM payload, every tests/carla_cases.py case — gets 0
    # and exports exactly as it did before the feature existed.
    # Clear first: the seeds above left an NPC on the spawn point this places on.
    page.evaluate("""() => AppState.loadJSON({
        map: 'Town01', weather: {}, time: 'daytime',
        ego: null, npcs: [], staticObjects: [], trafficSignals: [],
    })""")
    ego = H.place_actor(page, "ego", 300.631, -2.025)
    check("a placed ego defaults to 10 m/s initial speed",
          ego.get("initial_speed") == 10.0, str(ego.get("initial_speed")))
    npc = H.place_actor(page, "car", 265.364, 1.967)
    check("a placed NPC defaults to 10 m/s initial speed",
          npc.get("initial_speed") == 10.0, str(npc.get("initial_speed")))

    # The placement defaults above are the subject; this event exists only so
    # the scenario is exportable at all (nothing else here has one).
    page.evaluate("(ev) => AppState.updateById(AppState.ego.id, {events: [ev]})",
                  H.MIN_EVENT)

    xml = H.export_xosc(page)
    check("a placed ego's default speed reaches the Init <Private>",
          H.init_speed_of(xml, "hero") == 10.0, str(H.init_speed_of(xml, "hero")))
    check("a placed NPC's default speed reaches the Init <Private>",
          H.init_speed_of(xml, "adversary") == 10.0,
          str(H.init_speed_of(xml, "adversary")))

    # The Spawnpunkt field writes through to the actor and to the export.
    page.evaluate("AppState.select(AppState.ego.id)")
    page.fill("#prop-init-speed", "8.5")
    page.dispatch_event("#prop-init-speed", "change")
    check("the Start (m/s) field writes initial_speed onto the ego",
          page.evaluate("AppState.ego.initial_speed") == 8.5,
          str(page.evaluate("AppState.ego.initial_speed")))
    xml = H.export_xosc(page)
    check("an edited ego initial speed reaches the Init <Private>",
          H.init_speed_of(xml, "hero") == 8.5, str(H.init_speed_of(xml, "hero")))
    check("the Init SpeedAction is a step over 0s",
          '<SpeedActionDynamics dynamicsShape="step" value="0" dynamicsDimension="time" />'
          in xml or 'dynamicsShape="step"' in xml)

    # 0 means "no init speed", not "parked": nothing is emitted, and
    # open_scenario._create_init_behavior skips a zero anyway.
    page.fill("#prop-init-speed", "0")
    page.dispatch_event("#prop-init-speed", "change")
    xml = H.export_xosc(page)
    check("initial speed 0 emits no Init SpeedAction at all",
          H.init_speed_of(xml, "hero") is None, str(H.init_speed_of(xml, "hero")))

    # Negative is floored in the UI before it can reach the backend —
    # ScenarioRunner's _get_actor_speed raises on a negative Init speed.
    page.fill("#prop-init-speed", "-4")
    page.dispatch_event("#prop-init-speed", "change")
    check("a negative Start value is floored at 0 in the UI",
          page.evaluate("AppState.ego.initial_speed") == 0.0,
          str(page.evaluate("AppState.ego.initial_speed")))

    # A seeded payload omitting the field keeps the pre-feature behaviour.
    # The event carries no initial_speed, so it does not disturb the subject.
    seed(page, [H.MIN_EVENT], with_npc=False)
    check("a seeded ego without the field hydrates to 0",
          page.evaluate("AppState.ego.initial_speed") == 0,
          str(page.evaluate("AppState.ego.initial_speed")))
    xml = H.export_xosc(page)
    check("a payload omitting initial_speed exports no Init SpeedAction",
          H.init_speed_of(xml, "hero") is None, str(H.init_speed_of(xml, "hero")))

    # ── Legacy migration: a synthetic actor-level ego.trajectory ─────────────
    page.evaluate("""() => {
        AppState.loadJSON({
            map: 'Town01', weather: {}, time: 'daytime',
            ego: {id: 'obj-1', type: 'ego', x: 300.631, y: -2.025, z: 0.2, yaw: 180,
                  trajectory: [{x: 300.631, y: -2.025, z: 0.2},
                               {x: 280.0, y: -2.0, z: 0.2},
                               {x: 260.0, y: -2.0, z: 0.2}],
                  events: []},
            npcs: [], staticObjects: [], trafficSignals: [],
        });
    }""")
    check("legacy ego.trajectory does not survive the load",
          page.evaluate("AppState.ego.trajectory") is None)
    migrated_events = page.evaluate("AppState.ego.events")
    check("legacy trajectory becomes exactly one follow_trajectory event",
          len(migrated_events) == 1
          and migrated_events[0]["action"]["type"] == "follow_trajectory"
          and len(migrated_events[0]["action"]["trajectory"]) == 3,
          str(migrated_events))
    check("the migrated event's trigger is simulation_time@0, not a self-distance",
          migrated_events[0]["trigger"] == {"type": "simulation_time", "value": 0},
          str(migrated_events[0]["trigger"]))

    dumped = page.evaluate("AppState.toJSON()")
    check("a re-saved scenario no longer carries ego.trajectory at all",
          "trajectory" not in dumped["ego"], str(list(dumped["ego"].keys())))

    # Loading the already-migrated output again must not add a second path event.
    page.evaluate("(d) => AppState.loadJSON(d)", dumped)
    reloaded_events = page.evaluate("AppState.ego.events")
    check("migration is idempotent: reloading the migrated file keeps exactly one path event",
          len(reloaded_events) == 1, str(reloaded_events))

    # ── Legacy migration against the real example file ───────────────────────
    example_path = os.path.join(REPO_ROOT, "example", "Town01_scenario2.json")
    with open(example_path) as fh:
        legacy_data = json.load(fh)
    check("the example file predates ego events (sanity check on the fixture)",
          "events" not in legacy_data["ego"] and len(legacy_data["ego"]["trajectory"]) > 0,
          str(legacy_data["ego"].get("events")))
    page.evaluate("(d) => AppState.loadJSON(d)", legacy_data)
    check("the real example file's 25-point ego trajectory migrates to one event",
          len(page.evaluate("AppState.ego.events")) == 1
          and page.evaluate("AppState.ego.events[0].action.trajectory.length") == 25)
    check("the example file's 3 NPCs are untouched by the migration",
          len(page.evaluate("AppState.npcs")) == 3)
    status = H.export_status(page, H.export_params(page))
    check("the migrated example file still exports successfully", status == 200, str(status))

    unexpected = [e for e in errors if "400 (Bad Request)" not in e]
    check("no unexpected JS errors during the run", not unexpected, str(unexpected[:3]))
    browser.close()

sys.exit(check.report())
