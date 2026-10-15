"""Ego vehicle type: the ego can be any vehicle in the editor, not only a car.

The ego keeps `type: 'ego'` as its identity and carries its body in
`vehicleType` (absent = 'car'). The properties panel's `Typ` select offers the
vehicle group for it; the choice must reach the map marker, the export payload
and the hero <Vehicle> — blueprint, vehicleCategory and geometry, which the
emitter used to leave frozen at the template's car values.

Also covers the compact welcome / help modal.
"""

import os
import sys
import xml.etree.ElementTree as ET

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
import _harness as H  # noqa: E402
from _harness import Checks, assert_on_screen, open_editor, zoom_at  # noqa: E402

check = Checks()

# type -> (vehicleCategory, BoundingBox length, map marker length) — the emitter's
# _VEHICLE_PARAMS / vehicle_category table and mapMarkers.js's ACTOR_SIZES.
EXPECTED = {
    "car": ("car", 4.5, 4.5),
    "van": ("van", 5.8, 5.8),
    "truck": ("truck", 7.0, 7.0),
    "bus": ("bus", 10.0, 9.0),
    "motorcycle": ("motorbike", 2.2, 2.2),
    "scooter": ("motorbike", 1.7, 1.7),
    "police": ("car", 5.0, 5.0),
    "ambulance": ("van", 6.0, 6.0),
    "firetruck": ("truck", 8.5, 8.5),
}
WALKERS = ["pedestrian", "child", "cyclist"]


def hero_vehicle(xosc):
    root = ET.fromstring(xosc)
    return root.find(".//ScenarioObject[@name='hero']/Vehicle")


def marker_len(page, aid):
    return page.evaluate(
        """(id) => {
        for (const g of document.querySelectorAll('.actor-group'))
            if (g.dataset.id === id) return +g.querySelector('rect.actor-body').getAttribute('width');
        return null; }""",
        aid,
    )


with sync_playwright() as p:
    browser, page, errors = open_editor(p, "Town01")

    # ── Welcome / help modal ─────────────────────────────────────────────────
    page.click("#help-menu-btn")
    page.click("#btn-help")
    check("Hilfe → Schnellstart opens the welcome modal", page.is_visible("#welcome-overlay .welcome-card"))
    steps = page.locator("#welcome-overlay .welcome-steps li")
    check("welcome modal is six short steps", steps.count() == 6, str(steps.count()))
    words = len(page.inner_text("#welcome-overlay .welcome-card").split())
    check("welcome modal stays short (< 140 words)", words < 140, str(words))
    check(
        "welcome modal points at the Umgebung menu (weather, time, background traffic)",
        all(
            w in page.inner_text("#welcome-overlay .welcome-steps")
            for w in ("Umgebung", "Wetter", "Tageszeit", "Hintergrundverkehr")
        ),
    )
    card_h = page.evaluate("document.querySelector('#welcome-overlay .welcome-card').scrollHeight")
    check("welcome modal fits without scrolling at 900 px", card_h <= page.viewport_size["height"] * 0.92, str(card_h))
    check(
        "welcome modal mentions the ego's vehicle type",
        "Fahrzeugtyp" in page.inner_text("#welcome-overlay .welcome-steps"),
    )
    page.click("#welcome-close")
    check("Jetzt starten closes it", not page.is_visible("#welcome-overlay .welcome-card"))

    # ── Place the ego with a real click ──────────────────────────────────────
    zoom_at(page, 250.0, 0.0, 14)
    page.click('[data-toolbar-tab="actors"]')
    page.click('.tool-btn[data-tool="ego"]')
    sx, sy = assert_on_screen(page, 258.0, -2.0)
    page.mouse.click(sx, sy)
    page.wait_for_timeout(250)
    ego_id = page.evaluate("AppState.ego && AppState.ego.id")
    check("ego placed and selected", ego_id and page.evaluate("AppState.selectedId") == ego_id)
    # One event so the scenario is exportable (a scenario with no events is a 400).
    page.evaluate("""() => AppState.updateById(AppState.ego.id, {events: [{id: 'evt-1', name: 'S',
        trigger: {type: 'simulation_time', value: 0},
        action: {type: 'set_speed', target: {mode: 'absolute', value: 5},
                 dynamics: {dimension: 'time', value: 2, shape: 'step'}}}]})""")

    check("the Typ row is shown for the ego", page.is_visible("#actor-type-select"))
    opts = page.eval_on_selector_all("#actor-type-select option", "os => os.map(o => o.value)")
    check("ego type picker offers every vehicle type", set(opts) == set(EXPECTED), str(opts))
    check("ego type picker offers no walker or cyclist", not set(opts) & set(WALKERS), str(opts))
    check("a fresh ego reads as Auto", page.input_value("#actor-type-select") == "car")

    xosc = H.export_xosc(page)
    v = hero_vehicle(xosc)
    check(
        "default ego exports the car blueprint (negative control)",
        v.get("name") == "vehicle.tesla.model3" and v.get("vehicleCategory") == "car",
        str(v.attrib),
    )
    check("default ego keeps the car's 4.5 m box", v.find("BoundingBox/Dimensions").get("length") == "4.5")

    # ── Switch through the real select ──────────────────────────────────────
    u0 = page.evaluate("UndoStack.length")
    page.select_option("#actor-type-select", "truck")
    page.wait_for_timeout(150)
    st = page.evaluate("({t: AppState.ego.type, v: AppState.ego.vehicleType, id: AppState.ego.id})")
    check("switching keeps the ego's identity", st["t"] == "ego" and st["id"] == ego_id, str(st))
    check("switching sets vehicleType", st["v"] == "truck", str(st))
    check("switching is one undo step", page.evaluate("UndoStack.length") == u0 + 1)
    check("the map marker takes the truck's length", marker_len(page, ego_id) == 7.0, str(marker_len(page, ego_id)))
    check(
        "the marker stays ego-coloured",
        page.evaluate(
            """(id) => [...document.querySelectorAll('.actor-group')]
              .find(g => g.dataset.id === id).querySelector('rect.actor-body').getAttribute('fill')""",
            ego_id,
        )
        == "#4488ff",
    )
    check("the ego still labels as EGO", page.evaluate("AppState.actorLabel(AppState.ego, {short: true})") == "EGO")

    params = H.export_params(page)
    check("export payload carries the vehicle type", params["ego"]["type"] == "truck", str(params["ego"]["type"]))
    v = hero_vehicle(H.xosc_from_params(page, params))
    check("truck ego: blueprint", v.get("name") == "vehicle.carlamotors.carlacola", v.get("name"))
    check("truck ego: vehicleCategory", v.get("vehicleCategory") == "truck")
    check("truck ego: Performance", v.find("Performance").get("maxSpeed") == "30.0")
    check("truck ego: 7 m box", v.find("BoundingBox/Dimensions").get("length") == "7.0")
    check("truck ego: axles", v.find("Axles/FrontAxle").get("positionX") == "4.0")

    page.evaluate("document.activeElement && document.activeElement.blur()")
    page.keyboard.press("Control+z")
    page.wait_for_timeout(150)
    check(
        "Strg+Z puts the car back",
        page.evaluate("AppState.bodyType(AppState.ego)") == "car" and page.input_value("#actor-type-select") == "car",
    )
    page.keyboard.press("Control+y")
    page.wait_for_timeout(150)
    check("Strg+Y redoes the truck", page.evaluate("AppState.bodyType(AppState.ego)") == "truck")

    # ── Every vehicle type, exported ────────────────────────────────────────
    for vtype, (cat, length, mlen) in EXPECTED.items():
        page.select_option("#actor-type-select", vtype)
        page.wait_for_timeout(80)
        params = H.export_params(page)
        v = hero_vehicle(H.xosc_from_params(page, params))
        check(
            f"{vtype} ego exports vehicleCategory={cat} and a {length} m box",
            v.get("vehicleCategory") == cat and float(v.find("BoundingBox/Dimensions").get("length")) == length,
            str(v.attrib),
        )
        check(f"{vtype} ego marker is {mlen} m", marker_len(page, ego_id) == mlen, str(marker_len(page, ego_id)))

    # ── Preview footprint ───────────────────────────────────────────────────
    page.select_option("#actor-type-select", "bus")
    page.wait_for_timeout(80)
    fp = page.evaluate("""() => { const r = Simulate.runHeadless({maxTime: 1});
        return r ? 'ok' : null; }""")
    check("headless preview runs with a bus ego", fp == "ok")

    # ── Save / load ─────────────────────────────────────────────────────────
    saved = page.evaluate("AppState.toJSON()")
    check("save file keeps vehicleType", saved["ego"].get("vehicleType") == "bus")
    page.evaluate("(s) => AppState.loadJSON(s)", saved)
    check("loading restores it", page.evaluate("AppState.bodyType(AppState.ego)") == "bus")
    legacy = dict(saved)
    legacy["ego"] = {k: val for k, val in saved["ego"].items() if k != "vehicleType"}
    page.evaluate("(s) => AppState.loadJSON(s)", legacy)
    check("a save file without vehicleType loads as a car", page.evaluate("AppState.bodyType(AppState.ego)") == "car")

    # ── Backend guards ──────────────────────────────────────────────────────
    base = params
    for bad in WALKERS + ["spaceship"]:
        body = {**base, "ego": {**base["ego"], "type": bad}}
        check(f"backend rejects an ego of type {bad}", H.export_status(page, body) == 400)
    body = {**base, "ego": {**base["ego"], "type": "ego"}}
    check("backend reads a literal 'ego' type as a car", H.export_status(page, body) == 200)

    # ── NPC picker unchanged ────────────────────────────────────────────────
    page.click('.tool-btn[data-tool="van"]')
    sx, sy = assert_on_screen(page, 236.0, -2.0)
    page.mouse.click(sx, sy)
    page.wait_for_timeout(250)
    npc_id = page.evaluate("AppState.selectedId")
    page.select_option("#actor-type-select", "bus")
    page.wait_for_timeout(100)
    check("an NPC's picker still swaps its type", page.evaluate("(id) => AppState.findById(id).type", npc_id) == "bus")
    check("...and leaves the ego alone", page.evaluate("AppState.bodyType(AppState.ego)") == "car")

    # The four 400s are the backend-guard checks above, provoked on purpose.
    unexpected = [e for e in errors if "status of 400" not in e]
    check("no unexpected JS errors during the run", not unexpected, str(unexpected[:5]))
    browser.close()

sys.exit(check.report())
