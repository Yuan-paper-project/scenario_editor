"""Preview lock, Ablauf playhead, trajectory speed and scenario clearing.

* a trajectory has ONE speed field (no per-vertex inputs); setting it
  writes every vertex, a legacy file shows the effective average, and the
  collapsed summary states it;
* Datei → „Neues Szenario" empties the scenario after a confirm, one undo
  step brings it back, Strg skips the confirm;
* a map switch with a scenario on screen asks first: cancel keeps both the
  scenario and the selected town, confirm empties it and the history;
* during a preview nothing on the map is draggable, and the properties
  panel is full opacity, scrollable, framed, bannered and not clickable;
* the „Ablauf" panel has a playhead that follows the preview and scrubs it,
  and a block click selects the actor and highlights its card.
"""

import sys

from playwright.sync_api import sync_playwright

import _harness as H

C = H.Checks()

LEGACY = """() => AppState.loadJSON({map: 'Town01', weather: {}, time: 'daytime',
  ego: {id: 'obj-9', type: 'ego', x: 200, y: 1.9, z: 0.5, yaw: 180, events: []},
  staticObjects: [], trafficSignals: [],
  npcs: [{id: 'obj-1', type: 'car', x: 300, y: 1.9, z: 0.5, yaw: 180, initial_speed: 0,
          events: [{id: 'evt-1', name: 'Pfad', trigger: {type: 'simulation_time', value: 0},
                    action: {type: 'follow_trajectory', trajectory: [
                      {x: 300, y: 1.9, z: 0.5, velocity: 4},
                      {x: 280, y: 1.9, z: 0.5, velocity: 4},
                      {x: 260, y: 1.9, z: 0.5, velocity: 12}]}}]}]})"""


def trajectory_speed(page):
    page.evaluate(LEGACY)
    page.wait_for_timeout(300)
    page.evaluate("AppState.select('obj-1')")
    page.wait_for_timeout(300)
    C("trajectory: no per-waypoint speed inputs", page.locator("#event-list .waypoint-item input").count() == 0)
    inp = page.locator("#event-list .trajectory-speed-input")
    C("trajectory: one speed field", inp.count() == 1)
    # 20 m at 4 m/s (5 s) + 20 m at 8 m/s (2.5 s) → 40 / 7.5 = 5.33
    C(
        "trajectory: legacy velocities show the effective average",
        inp.input_value() == "5.5" or abs(float(inp.input_value()) - 5.33) < 0.06,
        inp.input_value(),
    )
    inp.fill("7")
    inp.dispatch_event("change")
    page.wait_for_timeout(200)
    vs = page.evaluate("AppState.npcs[0].events[0].action.trajectory.map(p => p.velocity)")
    C("trajectory: setting it writes every vertex", vs == [7, 7, 7], vs)
    params = page.evaluate("ScenarioIO.buildParamsForTesting()")
    exp = [p["velocity"] for p in params["npcs"][0]["events"][0]["action"]["trajectory"]]
    C("trajectory: export payload carries it on every vertex", exp == [7, 7, 7], exp)
    page.evaluate("""() => { const a = AppState.npcs[0];
      AppState.updateById(a.id, {events: a.events.map(e => ({...e, collapsed: true}))}); }""")
    page.wait_for_timeout(200)
    summary = page.inner_text("#event-list .event-summary")
    C("trajectory: collapsed summary states the speed", "7.0 m/s" in summary, summary)
    page.evaluate("AppState.select(null)")


def clear_scenario(page):
    page.evaluate("ScenarioGenerator.generate('lead_brake', 3)")
    page.wait_for_timeout(600)
    n0 = page.evaluate("1 + AppState.npcs.length")
    page.click("#file-menu-btn")
    page.click("#btn-new-scenario")
    page.wait_for_timeout(100)
    C("clear: asks first", page.evaluate("Confirm.isOpen"))
    page.click("#confirm-cancel")
    C("clear: cancel keeps the scenario", page.evaluate("!!AppState.ego && AppState.npcs.length") > 0)
    page.click("#file-menu-btn")
    page.click("#btn-new-scenario")
    page.wait_for_timeout(100)
    page.click("#confirm-ok")
    page.wait_for_timeout(200)
    st = page.evaluate("""() => ({ego: AppState.ego, npcs: AppState.npcs.length, props: AppState.staticObjects.length,
        sig: AppState.trafficSignals.length, gen: AppState.generated, map: AppState.map,
        markers: document.querySelectorAll('#layer-actors .actor-group, #layer-actors-top .actor-group').length})""")
    C(
        "clear: everything gone",
        st["ego"] is None and st["npcs"] == 0 and st["props"] == 0 and st["sig"] == 0 and st["gen"] is None,
        st,
    )
    C("clear: map stays", st["map"] == "Town03", st)
    C("clear: no markers left on the map", st["markers"] == 0, st)
    page.keyboard.press("Control+z")
    page.wait_for_timeout(300)
    C("clear: one Strg+Z restores it", page.evaluate("(AppState.ego ? 1 : 0) + AppState.npcs.length") == n0)
    page.click("#file-menu-btn")
    page.click("#btn-new-scenario", modifiers=["Control"])
    page.wait_for_timeout(200)
    C(
        "clear: Strg skips the confirm",
        not page.evaluate("Confirm.isOpen") and page.evaluate("!AppState.ego && AppState.npcs.length === 0"),
    )
    page.click("#file-menu-btn")
    page.click("#btn-new-scenario")
    page.wait_for_timeout(100)
    C("clear: an empty scenario needs no confirm", not page.evaluate("Confirm.isOpen"))


SCENE = """() => JSON.stringify({ego: AppState.ego, npcs: AppState.npcs, props: AppState.staticObjects,
                                  gen: AppState.generated && AppState.generated.seed})"""


def opt_text(page, town):
    return page.evaluate(
        f"[...document.getElementById('map-select').options].find(o => o.value === '{town}').textContent"
    )


def switch(page, town):
    page.select_option("#map-select", town)
    page.wait_for_timeout(100)
    C(f"switch to {town}: no question asked", not page.evaluate("Confirm.isOpen"))
    page.wait_for_function(
        f"AppState.map === '{town}' && AppState.mapData && AppState.mapData.town === '{town}'", timeout=60000
    )
    page.wait_for_timeout(300)


def map_switch(page, tmpdir):
    page.evaluate("ScenarioGenerator.generate('lead_brake', 3)")
    page.wait_for_timeout(600)
    town03 = page.evaluate(SCENE)
    undo03 = page.evaluate("UndoStack.length")
    C("map switch: the Town03 scene has history to keep", undo03 > 0, undo03)

    switch(page, "Town01")
    C(
        "map switch: a new town starts empty",
        page.evaluate("!AppState.ego && AppState.npcs.length === 0 && !AppState.generated"),
    )
    C("map switch: ...with no history", page.evaluate("UndoStack.length + UndoStack.redoLength") == 0)
    C(
        "map switch: the town left is marked in the selector",
        opt_text(page, "Town03").endswith("●"),
        opt_text(page, "Town03"),
    )
    C("map switch: the current town is not", not opt_text(page, "Town01").endswith("●"))
    page.evaluate("""() => { AppState.npcs = [...AppState.npcs, {id: AppState.nextId(), type: 'car',
        x: 300, y: 1.9, z: 0.5, yaw: 180, initial_speed: 0, events: []}]; AppState.set({}); }""")
    town01 = page.evaluate(SCENE)

    switch(page, "Town03")
    C("map switch: coming back restores the scenario", page.evaluate(SCENE) == town03)
    C(
        "map switch: ...and its undo history",
        page.evaluate("UndoStack.length") == undo03,
        (page.evaluate("UndoStack.length"), undo03),
    )
    C("map switch: ...with a toast", page.locator(".toast", has_text="wiederhergestellt").count() >= 1)
    C(
        "map switch: the actors are drawn",
        page.locator("#layer-actors .actor-group, #layer-actors-top .actor-group").count()
        == page.evaluate("1 + AppState.npcs.length"),
    )
    C(
        "map switch: marks follow (Town01 parked, Town03 live)",
        opt_text(page, "Town01").endswith("●") and not opt_text(page, "Town03").endswith("●"),
    )
    page.keyboard.press("Control+z")
    page.wait_for_timeout(300)
    C("map switch: the restored history undoes", page.evaluate("UndoStack.length") == undo03 - 1)
    page.keyboard.press("Control+y")
    page.wait_for_timeout(300)
    C("map switch: ...and redoes", page.evaluate(SCENE) == town03)

    switch(page, "Town01")
    C("map switch: Town01's scenario is back too", page.evaluate(SCENE) == town01)

    # Neues Szenario clears this town only.
    page.click("#file-menu-btn")
    page.click("#btn-new-scenario", modifiers=["Control"])
    page.wait_for_timeout(200)
    C("clear: other towns keep theirs", opt_text(page, "Town03").endswith("●"))

    # Laden of another town's file: this town is parked, the geometry follows.
    page.evaluate("""() => { AppState.npcs = [{id: AppState.nextId(), type: 'car', x: 300, y: 1.9, z: 0.5,
        yaw: 180, initial_speed: 0, events: []}]; AppState.set({}); }""")
    data = page.evaluate("AppState.toJSON()")
    data["map"] = "Town05"
    data["npcs"] = []
    path = f"{tmpdir}/town05.json"
    with open(path, "w") as fh:
        import json

        json.dump(data, fh)
    page.set_input_files("#btn-load-input", path)
    page.wait_for_function(
        "AppState.map === 'Town05' && AppState.mapData && AppState.mapData.town === 'Town05'", timeout=60000
    )
    page.wait_for_timeout(300)
    C("load: another town's file loads its own geometry", page.evaluate("AppState.mapData.town") == "Town05")
    C("load: the town it replaced is parked", opt_text(page, "Town01").endswith("●"))
    switch(page, "Town03")
    C("load: Town03 still restores", page.evaluate(SCENE) == town03)


def preview_lock(page):
    page.evaluate("ScenarioGenerator.generate('lead_brake', 3)")
    page.wait_for_timeout(600)
    lead = page.evaluate("AppState.npcs[0].id")
    page.evaluate(f"MapView.focusActor('{lead}')")
    page.wait_for_timeout(400)
    # Opened before the preview: it cannot compute while one runs.
    page.click("#sim-lanes-toggle")
    page.wait_for_selector("#sim-lanes:not(.hidden) .sim-lane-row", timeout=5000)
    C("playhead: idle before a preview", page.locator(".sim-lane-playhead.idle").count() == 1)
    page.evaluate("Simulate.seek(0)")
    page.wait_for_timeout(300)
    C("preview: running, paused", page.evaluate("Simulate.running && Simulate.paused"))

    # Drag the lead's marker: nothing moves, nothing is recorded.
    pose0 = page.evaluate(f"(a => [a.x, a.y, a.yaw])(AppState.findById('{lead}'))")
    undo0 = page.evaluate("UndoStack.length")
    box = (
        page.locator(f'.actor-group[data-id="{lead}"]').first.bounding_box()
        if page.locator(f'.actor-group[data-id="{lead}"]').count()
        else None
    )
    if box is None:
        x, y = H.world_to_screen(page, pose0[0], pose0[1])
    else:
        x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + 40, y + 30, steps=5)
    page.mouse.up()
    page.wait_for_timeout(200)
    pose1 = page.evaluate(f"(a => [a.x, a.y, a.yaw])(AppState.findById('{lead}'))")
    C("preview: an actor cannot be dragged", pose1 == pose0, (pose0, pose1))
    C("preview: the grab recorded nothing", page.evaluate("UndoStack.length") == undo0)

    # Ablauf: block click selects + highlights.
    blocks = page.evaluate(f"""() => [...document.querySelectorAll('.sim-lane-block[data-actor="{lead}"]')]
        .map(b => b.dataset.event)""")
    target = blocks[-1]
    page.click(f'.sim-lane-block[data-actor="{lead}"][data-event="{target}"]')
    page.wait_for_timeout(500)
    C("timeline click: selects the actor", page.evaluate("AppState.selectedId") == lead)
    card = page.locator(f'#event-list .event-card.timeline-focus[data-event-id="{target}"]')
    C("timeline click: highlights that card", card.count() == 1)
    C("timeline click: only that card", page.locator("#event-list .event-card.timeline-focus").count() == 1)
    inview = page.evaluate("""() => { const c = document.querySelector('#event-list .event-card.timeline-focus');
        const p = document.getElementById('properties-panel').getBoundingClientRect();
        const r = c.getBoundingClientRect(); return r.top < p.bottom && r.bottom > p.top; }""")
    C("timeline click: the card is scrolled into view", inview)

    # Panel: full opacity, banner, frame, not clickable, still scrollable.
    st = page.evaluate("""() => { const p = document.getElementById('properties-panel'), cs = getComputedStyle(p);
        const b = document.getElementById('preview-lock-banner');
        return {opacity: cs.opacity, shadow: cs.boxShadow, banner: getComputedStyle(b).display,
                bannerText: b.innerText}; }""")
    C("panel: full opacity", st["opacity"] == "1", st)
    C("panel: banner shown", st["banner"] != "none" and "Vorschau" in st["bannerText"], st)
    C("panel: accent frame", st["shadow"] not in ("none", ""), st)
    hit = page.evaluate("""() => { const i = [...document.querySelectorAll('#properties-panel input')]
          .find(i => { const r = i.getBoundingClientRect(); return r.width && r.height
                && r.top > 0 && r.bottom < innerHeight; });
        if (!i) return 'no-input'; const r = i.getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return el === i ? 'input' : el.id || el.className; }""")
    C("panel: an input cannot be clicked", hit not in ("input", "no-input"), hit)
    ev0 = page.evaluate(f"JSON.stringify(AppState.findById('{lead}').events)")
    page.locator("#event-list .event-collapse").first.click(force=True)
    page.wait_for_timeout(200)
    C(
        "panel: a forced click edits nothing",
        page.evaluate(f"JSON.stringify(AppState.findById('{lead}').events)") == ev0,
    )
    page.evaluate("document.getElementById('properties-panel').scrollTop = 0")
    pb = page.locator("#properties-panel").bounding_box()
    page.mouse.move(pb["x"] + pb["width"] / 2, pb["y"] + pb["height"] / 2)
    scrollable = page.evaluate("(p => p.scrollHeight > p.clientHeight)(document.getElementById('properties-panel'))")
    page.mouse.wheel(0, 300)
    page.wait_for_timeout(300)
    top = page.evaluate("document.getElementById('properties-panel').scrollTop")
    C("panel: scrolls with the wheel", (not scrollable) or top > 0, (scrollable, top))
    page.keyboard.press("Tab")
    page.keyboard.press("Tab")
    C(
        "panel: Tab does not reach a field",
        not page.evaluate("document.getElementById('properties-panel').contains(document.activeElement)"),
    )

    # Playhead follows the preview and scrubs it.
    def head_frac():
        return page.evaluate("""() => { const h = document.querySelector('.sim-lane-playhead');
            const t = document.querySelector('.sim-lane-axis .sim-lane-track').getBoundingClientRect();
            const hr = h.getBoundingClientRect();
            return (hr.left + hr.width / 2 - t.left) / t.width; }""")

    end = page.evaluate("EventTimeline.data.end")
    page.evaluate(f"Simulate.seek({end} * 0.5)")
    page.wait_for_timeout(100)
    C("playhead: follows the preview time", abs(head_frac() - 0.5) < 0.02, head_frac())
    hb = page.locator(".sim-lane-playhead").bounding_box()
    tb = page.locator(".sim-lane-axis .sim-lane-track").bounding_box()
    page.mouse.move(hb["x"] + hb["width"] / 2, hb["y"] + 4)
    page.mouse.down()
    page.mouse.move(tb["x"] + tb["width"] * 0.25, hb["y"] + 4, steps=6)
    page.mouse.up()
    page.wait_for_timeout(200)
    t = page.evaluate("Simulate.time")
    C("playhead: dragging scrubs the preview", abs(t - end * 0.25) < max(0.3, end * 0.03), (t, end))
    C("playhead: it moved with the drag", abs(head_frac() - 0.25) < 0.03, head_frac())
    page.mouse.click(tb["x"] + tb["width"] * 0.75, tb["y"] + tb["height"] / 2)
    page.wait_for_timeout(200)
    C(
        "playhead: a press on the axis jumps there",
        abs(page.evaluate("Simulate.time") - end * 0.75) < max(0.3, end * 0.03),
    )
    C("playhead: scrubbing leaves it paused", page.evaluate("Simulate.paused"))

    page.click("#sim-stop")
    page.wait_for_timeout(500)
    C("stop: highlight removed", page.locator("#event-list .event-card.timeline-focus").count() == 0)
    C(
        "stop: banner hidden",
        page.evaluate("getComputedStyle(document.getElementById('preview-lock-banner')).display") == "none",
    )
    C("stop: playhead back to idle", page.locator(".sim-lane-playhead.idle").count() == 1)
    C("stop: actor back on its pose", page.evaluate(f"(a => [a.x, a.y, a.yaw])(AppState.findById('{lead}'))") == pose0)
    page.click("#sim-lanes-toggle")


def load_during_preview(page, tmpdir):
    """Laden while the preview runs must stop it first. Left running, it kept
    animating the loaded actors (two hand-made saves share obj-1, obj-2, ...)
    and its Stop wrote the OLD scenario's authored poses onto them."""
    import json
    import os

    page.evaluate("ScenarioGenerator.generate('lead_brake', 9)")
    other = page.evaluate("AppState.toJSON()")
    page.evaluate("ScenarioGenerator.generate('cut_in', 3)")
    cur = page.evaluate("AppState.toJSON()")
    other["ego"]["id"] = cur["ego"]["id"]
    other["npcs"][0]["id"] = cur["npcs"][0]["id"]
    path = os.path.join(tmpdir, "other.json")
    with open(path, "w") as fh:
        json.dump(other, fh)
    page.click("#sim-play")
    page.wait_for_timeout(1200)
    page.set_input_files("#btn-load-input", path)
    page.wait_for_timeout(600)
    C("load during preview: the preview stops", not page.evaluate("Simulate.running"))
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    ego = page.evaluate("[AppState.ego.x, AppState.ego.y]")
    C(
        "load during preview: the loaded ego keeps the file's pose",
        ego == [other["ego"]["x"], other["ego"]["y"]],
        (ego, other["ego"]["x"], other["ego"]["y"]),
    )


def main():
    with sync_playwright() as pw:
        browser, page, errors = H.open_editor(pw, "Town03")
        page.wait_for_function("AppState.laneGraph !== null", timeout=60000)
        preview_lock(page)
        clear_scenario(page)
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            map_switch(page, tmp)
            H.select_map(page, "Town04")
            page.wait_for_function("AppState.laneGraph !== null", timeout=60000)
            load_during_preview(page, tmp)
        H.select_map(page, "Town01")
        trajectory_speed(page)
        C("no JS errors", not [e for e in errors if "404" not in e], errors[:5])
        browser.close()
    sys.exit(C.report())


if __name__ == "__main__":
    main()
