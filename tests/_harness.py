"""Shared helpers for the event/template suites.

Deliberately mirrors the style the props suites established (a flat `check()`
that accumulates, a PASS/FAIL listing, `sys.exit(1 if fails else 0)`) rather
than pulling in pytest — see tests/README.md.

`test_props_e2e.py` and `test_prop_yaw_e2e.py` predate this module and still
carry their own copies of `check()` and the world->screen transform. That
duplication is deliberate for now: they are 77 passing checks and rewriting
them to import from here would be risk without payoff.
"""
import math
import os
import sys
import xml.etree.ElementTree as ET

BASE = os.environ.get("EDITOR_URL", "http://localhost:9090")
VIEWPORT = {"width": 1600, "height": 900}


# ── Result accumulation ──────────────────────────────────────────────────────

class Checks:
    def __init__(self):
        self.results = []
        self.fails = []
        self.known = []

    def __call__(self, name, cond, extra=""):
        self.results.append((name, "PASS" if cond else "FAIL", extra))
        if not cond:
            self.fails.append(f"{name} {extra}".strip())
        return bool(cond)

    def known_issue(self, name, cond, extra=""):
        """Record a check that is EXPECTED to fail because of an open defect.

        Keeps the defect visible in the output without making the suite
        permanently red — otherwise the exit code stops meaning anything and
        real regressions get ignored along with it. When the underlying bug is
        fixed this reports KFIXED, which is the cue to promote it to a normal
        check.
        """
        status = "KFIXED" if cond else "KNOWN"
        self.results.append((name, status, extra))
        if not cond:
            self.known.append(f"{name} {extra}".strip())
        return bool(cond)

    def report(self):
        print()
        for name, status, extra in self.results:
            line = f"  {status:<6}  {name}"
            if extra and status in ("FAIL", "KNOWN"):
                line += f"   [{extra}]"
            print(line)
        passed = sum(1 for _, s, _ in self.results if s in ("PASS", "KFIXED"))
        print(f"\n{passed}/{len(self.results)} passed")
        if self.known:
            print(f"{len(self.known)} known defect(s), not counted as failures:")
            for k in self.known:
                print(f"  - {k}")
        return 1 if self.fails else 0


# ── Browser bootstrap ────────────────────────────────────────────────────────

W2S = """([wx,wy])=>{
    const svg=document.getElementById('map-svg');
    const g=document.getElementById('world');
    const pt=svg.createSVGPoint(); pt.x=wx; pt.y=wy;
    const s=pt.matrixTransform(g.getScreenCTM());
    return [s.x, s.y];
}"""


def open_editor(playwright, town="Town01"):
    """Launch chromium on the editor with `town` loaded.

    Returns (browser, page, errors) — `errors` accumulates pageerror and
    console.error text so a suite can assert the run was clean.
    """
    browser = playwright.chromium.launch()
    page = browser.new_page(viewport=VIEWPORT, accept_downloads=True)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console",
            lambda m: errors.append("console.error: " + m.text)
            if m.type == "error" else None)

    page.goto(BASE, wait_until="networkidle")
    page.evaluate("document.getElementById('welcome-overlay')?.classList.add('hidden')")
    select_map(page, town)
    return browser, page, errors


def select_map(page, town):
    """Load a town and wait for its geometry.

    Must go through the real selector: placement snapping reads AppState.mapData,
    so setting AppState.map alone leaves lane snapping working off the previous
    town's geometry — which places actors in plausible-looking but wrong lanes.
    """
    if page.evaluate("AppState.map") == town and page.evaluate("!!AppState.mapData"):
        return
    page.evaluate("AppState.mapData = null")
    page.select_option("#map-select", town)
    page.wait_for_function("AppState.mapData !== null", timeout=60000)


def world_to_screen(page, wx, wy):
    return page.evaluate(W2S, [wx, wy])


def assert_on_screen(page, wx, wy):
    """Playwright silently clamps out-of-viewport clicks to the viewport edge.

    A clamped click lands somewhere else entirely and produces a confident but
    meaningless result, so refuse rather than guess. Same guard as `place()` in
    test_prop_yaw_e2e.py.
    """
    sx, sy = world_to_screen(page, wx, wy)
    if not (0 <= sx <= VIEWPORT["width"] and 0 <= sy <= VIEWPORT["height"]):
        raise AssertionError(
            f"world ({wx},{wy}) maps to off-screen ({sx:.0f},{sy:.0f}); "
            f"zoom/pan first")
    return sx, sy


def _assert_npc_added(page, before, what, wx, wy):
    """Fail loudly when a placement click created nothing.

    Reading AppState.npcs[len-1] cannot distinguish "placed" from "the click
    was swallowed" — it just re-returns the previous actor, which then gets
    checked against the wrong expectations. Two template placements silently
    landed on an earlier actor's marker this way, and the position guard missed
    it because consecutive test spots were closer together than the tolerance.
    """
    after = page.evaluate("AppState.npcs.length")
    if after != before + 1:
        raise AssertionError(
            f"{what} at ({wx},{wy}) added no npc (count stayed {before}); "
            f"the click probably landed on an existing actor's marker — "
            f"space test points further apart or zoom in")


def place_actor(page, tool, wx, wy, tolerance=2.5):
    """Arm an actor tool and click at a WORLD point; return the placed actor.

    Verifies the actor landed near where we aimed. The tolerance is looser than
    the props suite's 1.5 m because actor placement snaps to spawn points and
    to lane centres (objects.js `_placeActor`), which legitimately moves it.
    """
    page.click('[data-toolbar-tab="actors"]')
    page.click(f'.tool-btn[data-tool="{tool}"]')
    before = page.evaluate("AppState.npcs.length")
    sx, sy = assert_on_screen(page, wx, wy)
    page.mouse.click(sx, sy)
    if tool != "ego":
        _assert_npc_added(page, before, f"tool '{tool}'", wx, wy)
    actor = page.evaluate(
        "(t) => t === 'ego' ? AppState.ego : AppState.npcs[AppState.npcs.length-1]",
        tool)
    if actor is None:
        raise AssertionError(f"no actor placed for tool '{tool}' at ({wx},{wy})")
    if abs(actor["x"] - wx) > tolerance or abs(actor["y"] - wy) > tolerance:
        raise AssertionError(
            f"{tool} landed at ({actor['x']},{actor['y']}), aimed at ({wx},{wy})")
    return actor


def place_template(page, template_id, wx, wy, tolerance=14.0):
    """Place an actor from a scenario template and return it.

    The template buttons live in the RIGHT panel's overview view, which only
    renders when nothing is selected (properties.js `_renderOverviewPanel`).
    `_placeActor` selects the actor it just created, so the panel must be
    reset to overview before each template.

    The default tolerance is generous: `vehicle-pull-out` snaps to a lane
    centre within 12 m (templates.js `placement.maxDistance`), so a strict
    bound would reject a correct placement.
    """
    page.evaluate("AppState.select(null)")
    page.click('[data-overview-tab="templates"]')
    page.click(f'[data-template-action="{template_id}"]')
    before = page.evaluate("AppState.npcs.length")
    sx, sy = assert_on_screen(page, wx, wy)
    page.mouse.click(sx, sy)
    _assert_npc_added(page, before, f"template '{template_id}'", wx, wy)
    actor = page.evaluate("AppState.npcs[AppState.npcs.length-1]")
    if actor is None:
        raise AssertionError(f"template '{template_id}' placed no actor")
    if abs(actor["x"] - wx) > tolerance or abs(actor["y"] - wy) > tolerance:
        raise AssertionError(
            f"template '{template_id}' landed at ({actor['x']},{actor['y']}), "
            f"aimed at ({wx},{wy})")
    return actor


def zoom_at(page, wx, wy, ticks):
    """Wheel `ticks` notches with the cursor over world point (wx, wy).

    Positive zooms in, negative out. The wheel handler keeps the world point
    under the cursor fixed (`mapView.js` `_pan.x = cursor.x - world.x * _zoom`),
    so zooming in N ticks and back out N ticks at the SAME world point restores
    the previous view — which is how a caller places one object at street scale
    without disturbing the next one's screen coordinates.

    Zoom is needed because the map fits a whole town into 1600x900: on Town05
    that is ~2.5 px/m, so Playwright's integer-pixel click quantises placement
    to ~0.4 m and a 3.5 m lane is 9 px wide. Actors tolerate that (they snap);
    a prop placed free-hand does not.
    """
    sx, sy = world_to_screen(page, wx, wy)
    page.mouse.move(sx, sy)
    for _ in range(abs(ticks)):
        page.mouse.wheel(0, -240 if ticks > 0 else 240)
    page.wait_for_timeout(120)


def place_prop(page, blueprint, wx, wy, zoom=12, tolerance=1.5):
    """Arm a prop tile and click at a WORLD point; return the placed prop.

    Goes through the real toolbar tile and a real map click rather than pushing
    an entry into AppState.staticObjects, because the two things a prop case
    actually depends on — `_propYawFor`'s per-lane facing rule and
    `surfaceZFor`'s elevation lookup — only run on the placement path. Seeding
    the array gives you a prop with whatever yaw and z the test made up.

    The prop tool is sticky (it stays armed for the next click), so Escape is
    pressed afterwards to disarm it; otherwise the next actor click drops
    another prop instead.
    """
    page.click('[data-toolbar-tab="props"]')
    page.click(f'.tool-btn[data-prop="{blueprint}"]')
    zoom_at(page, wx, wy, zoom)
    sx, sy = assert_on_screen(page, wx, wy)
    page.mouse.click(sx, sy)
    page.keyboard.press("Escape")
    prop = page.evaluate("AppState.staticObjects[AppState.staticObjects.length-1]")
    zoom_at(page, wx, wy, -zoom)
    if prop is None:
        raise AssertionError(f"prop '{blueprint}' placed nothing at ({wx},{wy})")
    if abs(prop["x"] - wx) > tolerance or abs(prop["y"] - wy) > tolerance:
        raise AssertionError(
            f"prop '{blueprint}' landed at ({prop['x']},{prop['y']}), "
            f"aimed at ({wx},{wy})")
    return prop


def export_xosc(page, timeout=30000):
    """Click Export .xosc and return the emitted .xosc text.

    Reads the /api/export RESPONSE rather than the saved download. The button,
    buildScenarioParams() and the backend all still run; only the blob-download
    plumbing is bypassed — and that plumbing is the problem. Chromium silently
    throttles repeated programmatic downloads from one page, so a suite that
    exports a dozen times in a row sees the first several succeed and then a
    later one hang with no toast, no JS error and an enabled button. Use
    export_download() where the download itself is what's under test.

    Toasts are cleared first: #toast-container is fixed-position with
    `pointer-events: auto`, so a stack of them can intercept the click.
    """
    return xosc_from_params(page, export_params(page, timeout))


def export_params(page, timeout=30000):
    """Click Export .xosc and return the POST body the frontend sent.

    That body IS buildScenarioParams()' output (scenarioIO.js), so this is the
    frontend's entire contribution to an export and the right thing to assert
    the UI against.
    """
    page.evaluate("document.getElementById('toast-container')?.replaceChildren()")
    page.wait_for_function("!document.getElementById('btn-export').disabled",
                           timeout=timeout)
    with page.expect_request(
            lambda r: r.url.endswith("/api/export"), timeout=timeout) as req:
        page.click("#btn-export")
    return req.value.post_data_json


def xosc_from_params(page, params):
    """POST params to /api/export from inside the page; return the .xosc text.

    Reading the button's own response body is not an option — the page's fetch
    consumes it, and Playwright then hands back an empty string.
    """
    return page.evaluate("""async (p) => {
        const r = await fetch('/api/export', {method:'POST',
          headers:{'Content-Type':'application/json'}, body: JSON.stringify(p)});
        if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + (await r.text()).slice(0,300));
        return await r.text();
    }""", params)


def export_download(page, timeout=30000):
    """Click Export .xosc and return the text of the file the browser saved.

    The full user-visible path, download included. Chromium throttles repeated
    programmatic downloads, so call this once per page rather than in a loop —
    see export_xosc().
    """
    page.evaluate("document.getElementById('toast-container')?.replaceChildren()")
    with page.expect_download(timeout=timeout) as dl:
        page.click("#btn-export")
    with open(dl.value.path()) as fh:
        return fh.read()


def export_status(page, params):
    """POST params straight to /api/export; return the HTTP status.

    For asserting rejection paths without going through the UI.
    """
    return page.evaluate("""async (p) => {
        const r = await fetch('/api/export', {method:'POST',
          headers:{'Content-Type':'application/json'}, body: JSON.stringify(p)});
        return r.status;
    }""", params)


# ── .xosc structural parsing ─────────────────────────────────────────────────

def _trigger_of(event):
    """Summarise an <Event>'s StartTrigger as {kind, ...}.

    Mirrors event_builders._add_custom_event_start_trigger. `distance_to_ego`
    emits TWO ConditionGroups (the relative-distance condition OR'd with a 60 s
    SimulationTimeCondition fallback), so a bare SimulationTimeCondition only
    means `simulation_time` when no other condition type is present.
    """
    trig = event.find("StartTrigger")
    if trig is None:
        return {"kind": None}

    rel = trig.find(".//RelativeDistanceCondition")
    if rel is not None:
        fallback = None
        for cond in trig.findall(".//SimulationTimeCondition"):
            fallback = float(cond.get("value"))
        return {
            "kind": "distance_to_ego",
            "value": float(rel.get("value")),
            "target": rel.get("entityRef"),
            "triggered_by": [e.get("entityRef")
                             for e in trig.findall(".//TriggeringEntities/EntityRef")],
            "fallback_time": fallback,
        }

    dist = trig.find(".//DistanceCondition")
    if dist is not None:
        pos = dist.find("./Position/WorldPosition")
        return {
            "kind": "distance_to_point",
            "value": float(dist.get("value")),
            "point": (float(pos.get("x")), float(pos.get("y"))) if pos is not None else None,
            "triggered_by": [e.get("entityRef")
                             for e in trig.findall(".//TriggeringEntities/EntityRef")],
        }

    sb = trig.find(".//StoryboardElementStateCondition")
    if sb is not None:
        return {
            "kind": "after_event",
            "ref": sb.get("storyboardElementRef"),
            "element_type": sb.get("storyboardElementType"),
            "state": sb.get("state"),
        }

    sim = trig.find(".//SimulationTimeCondition")
    if sim is not None:
        return {"kind": "simulation_time", "value": float(sim.get("value"))}

    return {"kind": "unknown"}


def _action_of(event):
    """Summarise an <Event>'s first PrivateAction as {kind, ...}."""
    pa = event.find(".//PrivateAction")
    if pa is None:
        return {"kind": None}

    speed = pa.find("./LongitudinalAction/SpeedAction")
    if speed is not None:
        dyn = speed.find("SpeedActionDynamics")
        absolute = speed.find("./SpeedActionTarget/AbsoluteTargetSpeed")
        relative = speed.find("./SpeedActionTarget/RelativeTargetSpeed")
        out = {
            "kind": "set_speed",
            "shape": dyn.get("dynamicsShape") if dyn is not None else None,
            "dimension": dyn.get("dynamicsDimension") if dyn is not None else None,
            "dynamics_value": float(dyn.get("value")) if dyn is not None else None,
        }
        if absolute is not None:
            out["mode"] = "absolute"
            out["value"] = float(absolute.get("value"))
        elif relative is not None:
            out["mode"] = "relative"
            out["value"] = float(relative.get("value"))
            out["entity_ref"] = relative.get("entityRef")
        return out

    for axis, tag in (("longitudinal", "./LongitudinalAction/LongitudinalDistanceAction"),
                      ("lateral", "./LateralAction/LateralDistanceAction")):
        node = pa.find(tag)
        if node is not None:
            return {
                "kind": "set_distance",
                "axis": axis,
                "entity_ref": node.get("entityRef"),
                "value": float(node.get("distance")),
            }

    lane = pa.find("./LateralAction/LaneChangeAction")
    if lane is not None:
        dyn = lane.find("LaneChangeActionDynamics")
        target = lane.find("./LaneChangeTarget/RelativeTargetLane")
        return {
            "kind": "lane_change",
            "shape": dyn.get("dynamicsShape") if dyn is not None else None,
            "dimension": dyn.get("dynamicsDimension") if dyn is not None else None,
            "dynamics_value": float(dyn.get("value")) if dyn is not None else None,
            "lane_offset": int(target.get("value")) if target is not None else None,
            "relative_to": target.get("entityRef") if target is not None else None,
        }

    traj = pa.find("./RoutingAction/FollowTrajectoryAction")
    if traj is not None:
        return {
            "kind": "follow_trajectory",
            "vertices": len(traj.findall(".//Polyline/Vertex")),
        }

    route = pa.find("./RoutingAction/AssignRouteAction")
    if route is not None:
        return {
            "kind": "assign_route",
            "waypoints": len(route.findall(".//Route/Waypoint")),
        }

    return {"kind": "unknown"}


def parse_events(xml_text, entity=None):
    """All storyboard <Event>s as {name, actors, trigger, action} dicts.

    `entity` filters to one ManeuverGroup's actor (e.g. 'adversary').
    """
    root = ET.fromstring(xml_text)
    out = []
    for mg in root.iter("ManeuverGroup"):
        actors = [e.get("entityRef") for e in mg.findall("./Actors/EntityRef")]
        if entity is not None and entity not in actors:
            continue
        for event in mg.iter("Event"):
            out.append({
                "name": event.get("name"),
                "actors": actors,
                "trigger": _trigger_of(event),
                "action": _action_of(event),
            })
    return out


def dangling_event_refs(xml_text):
    """`after_event` triggers whose storyboardElementRef names no real Event.

    build_custom_event_chain() maps event ids to names for ALL events, then
    skips any whose action builder returns False — a follow_trajectory with
    fewer than 2 waypoints, or an assign_route on a type that cannot route.
    A later event chained onto the skipped one keeps a reference that now
    resolves to nothing.
    """
    root = ET.fromstring(xml_text)
    names = {e.get("name") for e in root.iter("Event")}
    dangling = []
    for cond in root.iter("StoryboardElementStateCondition"):
        if cond.get("storyboardElementType") != "event":
            continue
        ref = cond.get("storyboardElementRef")
        if ref not in names:
            dangling.append(ref)
    return dangling


def dangling_entity_refs(xml_text):
    """Every `entityRef` attribute that names no declared ScenarioObject.

    Catches an internal editor id (`obj-N`) leaking into the file, which is what
    happens when a layer forgets to run a value through the id → OSC-ref map.
    ScenarioRunner resolves entityRef by scanning its actor list and simply
    finds nothing (openscenario_parser.py, TriggeringEntities), leaving the
    trigger actor None — so the condition never fires and the scenario looks
    mis-tuned rather than malformed. Unlike dangling_event_refs, which is about
    storyboard element names, this is about entities.
    """
    root = ET.fromstring(xml_text)
    names = {o.get("name") for o in root.iter("ScenarioObject")}
    return sorted({
        el.get("entityRef") for el in root.iter()
        if el.get("entityRef") is not None and el.get("entityRef") not in names
    })


def entity_names(xml_text):
    root = ET.fromstring(xml_text)
    return [o.get("name") for o in root.iter("ScenarioObject")]


def controller_of(xml_text, entity):
    """The `module` Property value of `entity`'s Init AssignControllerAction.

    Reads the emitted <Controller><Properties><Property name="module"> under
    the Init <Private entityRef=entity>. Returns None if no controller was
    assigned (e.g. a static prop, which deliberately gets none).
    """
    root = ET.fromstring(xml_text)
    for private in root.iter("Private"):
        if private.get("entityRef") != entity:
            continue
        prop = private.find(
            ".//AssignControllerAction/Controller/Properties/Property[@name='module']")
        return None if prop is None else prop.get("value")
    return None


def acts(xml_text):
    """Every <Act> in the storyboard, summarised.

    {name, groups: [[entityRef, ...], ...], hero_distance_gate: bool,
     act_start_sim_time: float|None}

    `hero_distance_gate` used to be True for every NPC Act's StartTrigger — a
    `hero traveled 0.1 m` condition from the external_control era, when NPCs
    had to wait for evidence an outside agent had taken the ego over. Every
    actor is authored and controlled inside the .xosc now, so
    xml_builder._add_act_start_stop_triggers no longer emits that condition
    for any Act, and this must be False everywhere.
    """
    root = ET.fromstring(xml_text)
    out = []
    for act in root.iter("Act"):
        groups = [
            [e.get("entityRef") for e in mg.findall("./Actors/EntityRef")]
            for mg in act.findall("ManeuverGroup")
        ]
        start = act.find("StartTrigger")
        hero_gate = start is not None and start.find(".//TraveledDistanceCondition") is not None
        sim_time = None
        if start is not None:
            for cond in start.iter("SimulationTimeCondition"):
                sim_time = float(cond.get("value"))
        out.append({
            "name": act.get("name"),
            "groups": groups,
            "hero_distance_gate": hero_gate,
            "act_start_sim_time": sim_time,
        })
    return out


def teleport_of(xml_text, entity):
    """The Init TeleportAction pose for `entity`, as (x, y, z, h)."""
    root = ET.fromstring(xml_text)
    for private in root.iter("Private"):
        if private.get("entityRef") != entity:
            continue
        wp = private.find(".//TeleportAction/Position/WorldPosition")
        if wp is not None:
            return tuple(float(wp.get(k, 0.0)) for k in ("x", "y", "z", "h"))
    return None


def approx(a, b, tol=1e-6):
    return a is not None and b is not None and math.isclose(a, b, abs_tol=tol)
