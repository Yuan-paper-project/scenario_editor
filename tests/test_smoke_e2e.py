"""Smoke test: the editor boots, loads a scenario, previews, generates and exports valid OpenSCENARIO.

A fast end-to-end pass over the main features, meant to run after every
refactoring step (`bash tests/run_tests.sh --quick`). It catches the two ways a
file split breaks this app silently: a script that no longer loads (a global
missing, or a ReferenceError at load) and an export that no longer validates.
"""

import json
import os
import re
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
import _harness as H  # noqa: E402
from _harness import Checks, open_editor  # noqa: E402

check = Checks()

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXAMPLE = os.path.join(REPO_ROOT, "example", "Town01_scenario2.json")
XSD = "/home/dellpro2/Antonio/scenario_runner/srunner/openscenario/OpenSCENARIO.xsd"

# Every global the frontend modules attach (CLAUDE.md, "Frontend conventions").
GLOBALS = [
    "AppState",
    "Api",
    "MapView",
    "ObjectsManager",
    "EventPanel",
    "TrafficSignals",
    "ScenarioTemplates",
    "PropCatalog",
    "PropData",
    "PropShapes",
    "LaneGraph",
    "Dropdown",
    "SpecialBuildings",
    "AerialMap",
    "ScenarioGenerator",
    "EventTimeline",
    "BgTraffic",
    "Simulate",
    "ScenarioIO",
    "Toast",
    "Confirm",
    "UndoStack",
    "UIUtils",
    "ScenarioRules",
]

MISSING_GLOBALS_JS = "(names) => names.filter(n => typeof window[n] === 'undefined' && !(() => { try { return eval(n) !== undefined; } catch (e) { return false; } })())"


def xsd_errors(xosc_text):
    """Schema errors from xmllint, minus the known `<Vertex relativeTime>` emitter defect (CLAUDE.md)."""
    with tempfile.NamedTemporaryFile("w", suffix=".xosc", delete=False) as fh:
        fh.write(xosc_text)
        path = fh.name
    try:
        out = subprocess.run(["xmllint", "--noout", "--schema", XSD, path], capture_output=True, text=True).stderr
    finally:
        os.unlink(path)
    errors = [ln for ln in out.splitlines() if "error" in ln.lower()]
    return [e for e in errors if "relativeTime" not in e and "'time' is required" not in e]


can_validate = os.path.exists(XSD) and subprocess.run(["which", "xmllint"], capture_output=True).returncode == 0

with sync_playwright() as p:
    browser, page, errors = open_editor(p, "Town01")

    # ── Boot: every script loaded and attached its global ────────────────────
    missing = page.evaluate(MISSING_GLOBALS_JS, GLOBALS)
    check("every frontend global is defined", not missing, str(missing))
    check(
        "the global check reports a global that does not exist (negative control)",
        page.evaluate(MISSING_GLOBALS_JS, ["NoSuchModuleGlobal"]) == ["NoSuchModuleGlobal"],
    )
    scripts = page.evaluate("[...document.scripts].map(s => s.src).filter(Boolean)")
    bad = [s for s in scripts if page.request.get(s).status != 200]
    check(f"all {len(scripts)} <script src> files are served", scripts and not bad, str(bad))

    # ── Backend API ───────────────────────────────────────────────────────────
    maps = page.request.get(f"{H.BASE}/api/maps").json().get("maps", [])
    check("GET /api/maps lists Town01", "Town01" in maps, str(maps)[:200])
    render = page.request.get(f"{H.BASE}/api/maps/Town01/render").json()
    check(
        "Town01 renders with roads and spawn points",
        len(render.get("roads", [])) > 50 and len(render.get("spawnPoints", [])) > 50,
    )
    check("Town01 has a lane graph", page.request.get(f"{H.BASE}/api/maps/Town01/lane_graph").status == 200)
    check("the map is drawn", page.locator("#layer-roads polygon, #layer-roads path").count() > 50)

    # ── Load a save file through Datei → Laden ───────────────────────────────
    page.set_input_files("#btn-load-input", EXAMPLE)
    page.wait_for_function("AppState.ego && AppState.npcs.length === 3", timeout=30000)
    with open(EXAMPLE) as fh:
        example = json.load(fh)
    check(
        "Laden loads the example: ego + 3 NPCs",
        page.evaluate("AppState.ego.id") == example["ego"]["id"] and len(page.evaluate("AppState.npcs")) == 3,
    )
    check(
        "the legacy ego trajectory becomes one follow_trajectory event",
        page.evaluate("AppState.ego.events.map(e => e.action.type)") == ["follow_trajectory"],
    )
    check(
        "every loaded actor is drawn on the map",
        page.locator("#layer-actors .actor-group, #layer-actors-top .actor-group").count() >= 4,
    )

    # ── Save file round trip ─────────────────────────────────────────────────
    same = page.evaluate("""() => {
        const a = JSON.stringify(AppState.toJSON());
        AppState.loadJSON(JSON.parse(a));
        return a === JSON.stringify(AppState.toJSON());
    }""")
    check("toJSON → loadJSON → toJSON is stable", same)

    # ── Preview ───────────────────────────────────────────────────────────────
    run = page.evaluate("""() => {
        const r = Simulate.runHeadless({ stopWhenIdle: true });
        if (!r) return null;
        const t = r.tracks[r.egoId];
        return { frames: r.times.length, moved: Math.hypot(t.at(-1).x - t[0].x, t.at(-1).y - t[0].y),
                 fired: Object.values(r.fired).reduce((n, f) => n + Object.keys(f).length, 0) };
    }""")
    check("the preview runs", run is not None and run["frames"] > 20, str(run))
    check("the preview ego drives its trajectory (> 20 m)", run and run["moved"] > 20, str(run))
    check("preview events fire", run and run["fired"] >= 2, str(run))

    page.click("#sim-play")
    page.wait_for_function("Simulate.running", timeout=5000)
    page.wait_for_timeout(600)
    page.click("#sim-stop")
    page.wait_for_function("!Simulate.running", timeout=5000)
    check(
        "Play/Stop restores the authored ego pose",
        page.evaluate("[AppState.ego.x, AppState.ego.y]") == [example["ego"]["x"], example["ego"]["y"]],
    )

    # ── Export through the button, validated against the XSD ─────────────────
    xosc = H.export_xosc(page)
    names = H.entity_names(xosc)
    check(
        "Export .xosc emits hero + 3 adversaries",
        {"hero", "adversary", "adversary1", "adversary2"} <= set(names),
        str(names),
    )
    check(
        "the export has no dangling entity or event references",
        not H.dangling_entity_refs(xosc) and not H.dangling_event_refs(xosc),
    )
    check(
        "the hero is driven by simple_vehicle_control",
        "external_control" not in xosc and "simple_vehicle_control" in H.controller_of(xosc, "hero"),
    )
    if can_validate:
        errs = xsd_errors(xosc)
        check("the loaded example's export is XSD-valid (apart from the known Vertex defect)", not errs, str(errs[:3]))
        broken = re.sub(r'revMajor="\d+"', "", xosc, count=1)
        check("the XSD check rejects a broken file (negative control)", bool(xsd_errors(broken)))
    else:
        check("XSD validation available (xmllint + OpenSCENARIO.xsd)", False, XSD)

    # ── Generator, then undo back to the loaded file ─────────────────────────
    info = page.evaluate("ScenarioGenerator.generate('lead_brake', 1)")
    check(
        "the generator builds a lead_brake scenario on Town01",
        info is not None and page.evaluate("AppState.npcs.length") >= 1,
        str(info)[:200],
    )
    gen_xosc = H.export_xosc(page)
    check("the generated scenario exports", "adversary" in H.entity_names(gen_xosc))
    if can_validate:
        errs = xsd_errors(gen_xosc)
        check("the generated scenario is XSD-valid", not errs, str(errs[:3]))

    page.evaluate("document.activeElement?.blur()")
    page.keyboard.press("Control+z")
    page.wait_for_function("AppState.npcs.length === 3", timeout=5000)
    check("one Strg+Z undoes the whole generation", page.evaluate("AppState.ego.id") == example["ego"]["id"])

    unexpected = [e for e in errors if "404" not in e]
    check("no JS errors during the run", not unexpected, str(unexpected[:3]))
    browser.close()

sys.exit(check.report())
