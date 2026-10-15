"""The properties panel for a map traffic light.

A light shares #props-content with actors and props, so every section they
show must be hidden again when a light is selected — the type picker was not,
and a light clicked after a car showed „Typ: Auto". Also covers the signal's
own card: add, switch state, change distance, delete, undo, export.

    bash run.sh 9090 && .venv/bin/python3 tests/test_signal_panel_e2e.py
"""

import sys

from playwright.sync_api import sync_playwright

import _harness as H

check = H.Checks()

VISIBLE = """(id) => { const el = document.getElementById(id);
    return !!el && !el.classList.contains('hidden') && el.offsetParent !== null; }"""


def visible(page, el_id):
    return page.evaluate(VISIBLE, el_id)


with sync_playwright() as p:
    browser, page, errors = H.open_editor(p, "Town01")
    check("no JS errors on load", not errors, str(errors[:3]))

    light = page.evaluate("AppState.mapData.trafficLights[0]")
    page.evaluate("""() => AppState.loadJSON({map: 'Town01', weather: {}, time: 'daytime',
        ego: {id: 'obj-1', type: 'ego', x: 300.6, y: -2.0, z: 0.5, yaw: 180, events: []},
        npcs: [{id: 'obj-2', type: 'car', x: 265.4, y: 2.0, z: 0.5, yaw: 0, events: []}],
        staticObjects: [{id: 'obj-3', type: 'prop', prop: 'static.prop.trafficcone01',
                         x: 250, y: 2.0, z: 0, yaw: 0}],
        trafficSignals: []})""")

    # ── The reported bug: car first, then the light ─────────────────────────
    page.evaluate("AppState.select('obj-2')")
    check("a car shows its type picker", visible(page, "actor-type-row"))
    page.evaluate("(id) => TrafficSignals.select(id)", light["id"])
    for el_id, what in (
        ("actor-type-row", "the actor type picker"),
        ("prop-type-row", "the prop type picker"),
        ("spawn-panel", "the Spawnpunkt section"),
        ("props-npc-section", "the actor events"),
        ("props-delete", "the delete button"),
    ):
        check(f"a light selected after a car hides {what}", not visible(page, el_id))
    check("... and shows its own panel", visible(page, "traffic-signal-panel"))

    # Same with a prop selected first.
    page.evaluate("AppState.select('obj-3')")
    check("a prop shows its prop picker", visible(page, "prop-type-row"))
    page.evaluate("(id) => TrafficSignals.select(id)", light["id"])
    check("a light selected after a prop hides the prop picker", not visible(page, "prop-type-row"))

    # And back: the light's panel must not linger on an actor.
    page.evaluate("AppState.select('obj-2')")
    check("selecting the car again hides the light panel", not visible(page, "traffic-signal-panel"))
    check("... and brings its type picker back", visible(page, "actor-type-row"))

    # ── The light's own panel ────────────────────────────────────────────────
    page.evaluate("(id) => TrafficSignals.select(id)", light["id"])
    title = page.inner_text("#props-title")
    num = light["id"].rsplit("_", 1)[-1]
    check("title is 'Ampel <n>'", title == f"Ampel {num}", title)
    meta = page.inner_text("#traffic-signal-meta")
    check("the meta line carries the map id", light["id"] in meta, meta)
    check(
        "no schaltung yet: count 0 and the normal-cycle note",
        page.inner_text("#traffic-event-count") == "0"
        and "normalen Zyklus" in page.inner_text("#traffic-signal-event-list"),
    )

    page.click("#btn-add-traffic-event")
    page.click("#btn-add-traffic-event")
    sig = page.evaluate("(id) => TrafficSignals.actionById(id).events", light["id"])
    check(
        "'+ Schaltung' adds a red, 40 m event each click",
        len(sig) == 2 and all(e["state"] == "red" and e["trigger_distance"] == 40 for e in sig),
        str(sig),
    )
    check("the count pill follows", page.inner_text("#traffic-event-count") == "2")
    titles = page.locator(".traffic-event-card .event-title-text").all_inner_texts()
    check("cards are numbered", titles == ["Schaltung 1", "Schaltung 2"], str(titles))

    page.locator(".traffic-event-card").nth(1).locator(".traffic-state-option.green").click()
    page.locator(".traffic-event-card").nth(1).locator("input").fill("25")
    page.locator(".traffic-event-card").nth(1).locator("input").dispatch_event("change")
    sig = page.evaluate("(id) => TrafficSignals.actionById(id).events", light["id"])
    check(
        "state and distance edit the second event only",
        sig[0]["state"] == "red"
        and sig[1]["state"] == "green"
        and sig[1]["trigger_distance"] == 25
        and sig[0]["trigger_distance"] == 40,
        str(sig),
    )
    active = page.locator(".traffic-event-card").nth(1).locator(".traffic-state-option.active").inner_text()
    check("the picked state is marked active, with its label", active.strip() == "Grün", active)

    page.locator(".traffic-event-card").nth(0).locator(".event-delete").click()
    sig = page.evaluate("(id) => TrafficSignals.actionById(id).events", light["id"])
    check("delete removes that card", len(sig) == 1 and sig[0]["state"] == "green", str(sig))
    page.evaluate("UndoStack.undo()")
    sig = page.evaluate("(id) => TrafficSignals.actionById(id).events", light["id"])
    check("... and undo brings it back", len(sig) == 2, str(sig))

    params = page.evaluate("ScenarioIO.buildParamsForTesting()")
    exported = [s for s in params["trafficSignals"] if s["id"] == light["id"]]
    check("both events reach the export payload", exported and len(exported[0]["events"]) == 2, str(exported))

    # ── A light the .xodr has but CARLA does not (Town10HD) ─────────────────
    # A Schaltung on one aborts the run with "Unknown traffic light"
    # (maps/<town>/carla_traffic_lights.json, tests/probe_carla_traffic_lights.py).
    H.select_map(page, "Town10HD")
    ghost = page.evaluate("AppState.mapData.trafficLights.find(l => l.inCarla === false)")
    real = page.evaluate("AppState.mapData.trafficLights.find(l => l.inCarla === true)")
    check("Town10HD has a light marked not-in-CARLA", ghost is not None)
    if ghost:
        page.evaluate(
            """(id) => AppState.loadJSON({map: 'Town10HD', weather: {}, time: 'daytime',
            ego: {id: 'obj-1', type: 'ego', x: -41.7, y: 28.0, z: 0.5, yaw: 0, events: []},
            npcs: [], staticObjects: [],
            trafficSignals: [{id, x: 0, y: 0, events: [{id: 'e', state: 'green', trigger_distance: 30}]}]})""",
            ghost["id"],
        )
        page.evaluate("(id) => TrafficSignals.select(id)", ghost["id"])
        check(
            "its panel warns it does not exist in CARLA",
            "gibt es in CARLA nicht" in page.inner_text("#traffic-signal-panel"),
        )
        check(
            "... and '+ Schaltung' is disabled",
            page.evaluate("document.getElementById('btn-add-traffic-event').disabled"),
        )
        check(
            "... and it is drawn as a ghost on the map",
            page.evaluate(
                "(id) => !!document.querySelector(`[data-traffic-light-id='${id}'].not-in-carla`)", ghost["id"]
            ),
        )
        gate = page.evaluate("ScenarioIO.validate()")
        check(
            "the export gate refuses a Schaltung on it",
            any("gibt es in CARLA nicht" in e for e in gate["errors"]),
            str(gate),
        )
        prm = page.evaluate("ScenarioIO.buildParamsForTesting()")
        check("the backend refuses it with a 400", H.export_status(page, prm) == 400)
        page.evaluate("(id) => TrafficSignals.select(id)", real["id"])
        check(
            "a real light's panel has no warning and can be switched",
            "gibt es in CARLA nicht" not in page.inner_text("#traffic-signal-panel")
            and not page.evaluate("document.getElementById('btn-add-traffic-event').disabled"),
        )

    errors[:] = [e for e in errors if "status of 400" not in e]
    check("no JS errors during the run", not errors, str(errors[:3]))
    browser.close()

sys.exit(check.report())
