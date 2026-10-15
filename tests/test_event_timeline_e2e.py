"""„Ablauf" suite: the event timeline above the preview bar (eventTimeline.js).

* the bar's „Ablauf" button opens it; one row per actor, one block per
  event that fires in the run, an „nie" count for those that do not;
* a chained event gets a connector;
* a click on a block starts the preview, paused, at that event's time;
* blocks cannot be dragged: a drag changes no trigger and records no undo;
* the preview bar keeps its width when the panel opens.
"""

import sys

import _harness as H
from playwright.sync_api import sync_playwright

C = H.Checks()

BLOCK = '.sim-lane-block[data-actor="{a}"][data-event="{e}"]'


def drag_block(page, sel, dx):
    box = page.locator(sel).bounding_box()
    x, y = box["x"] + 4, box["y"] + box["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + dx / 2, y, steps=3)
    page.mouse.move(x + dx, y, steps=3)
    page.mouse.up()
    page.wait_for_timeout(300)


def main():
    with sync_playwright() as pw:
        browser, page, errors = H.open_editor(pw, "Town03")
        page.wait_for_function("AppState.laneGraph !== null", timeout=60000)
        page.evaluate("ScenarioGenerator.generate('lead_brake', 3)")
        page.wait_for_timeout(600)
        bar0 = page.evaluate("document.getElementById('sim-progress-bar').getBoundingClientRect().width")

        page.click("#sim-lanes-toggle")
        page.wait_for_selector("#sim-lanes:not(.hidden) .sim-lane-row", timeout=5000)
        C("open: panel shown, button pressed", page.get_attribute("#sim-lanes-toggle", "aria-pressed") == "true")
        C(
            "open: the preview bar keeps its width",
            abs(page.evaluate("document.getElementById('sim-progress-bar').getBoundingClientRect().width") - bar0)
            < 0.5,
        )
        d = page.evaluate("""() => { const d = EventTimeline.data; return {
            rows: d.rows.length, actors: 1 + AppState.npcs.length,
            fired: d.rows.reduce((n, r) => n + r.events.filter(e => e.firedAt != null).length, 0),
            never: d.rows.reduce((n, r) => n + r.events.filter(e => e.firedAt == null).length, 0) }; }""")
        C(
            "rows: one per actor",
            d["rows"] == d["actors"] and page.locator(".sim-lane-row:not(.sim-lane-axis)").count() == d["actors"],
            d,
        )
        C("blocks: one per fired event", page.locator(".sim-lane-block").count() == d["fired"], d)
        nev = page.locator(".sim-lane-never").count()
        C("never-fired events are counted", (nev > 0) == (d["never"] > 0), (nev, d))
        C("chain: a connector for the after_event", page.locator(".sim-lane-links path").count() >= 1)

        lead = page.evaluate("AppState.npcs[0].id")
        brake = page.evaluate("AppState.npcs[0].events.find(e => e.trigger.type === 'distance_to_ego').id")
        chained = page.evaluate("(AppState.npcs[0].events.find(e => e.trigger.type === 'after_event') || {}).id")

        # Click → preview at that time
        t_brake = float(page.get_attribute(BLOCK.format(a=lead, e=brake), "data-t"))
        page.click(BLOCK.format(a=lead, e=brake))
        page.wait_for_timeout(300)
        C("click: preview starts", page.evaluate("Simulate.running"))
        lbl = page.inner_text("#sim-time-label")
        C("click: at the event's time", abs(float(lbl.split(" s")[0]) - t_brake) <= 0.1, (lbl, t_brake))
        # The panel's axis ends where the preview does. It used to run on the
        # generator's end rule (10 s still AND past 60 s), so every axis
        # stretched to 60 s and squeezed a 20 s run into its first third.
        ends = page.evaluate("[EventTimeline.data.end, Simulate.end]")
        C("axis: ends where the preview run ends", abs(ends[0] - ends[1]) <= 0.1 and ends[1] < 55, ends)
        page.click("#sim-stop")
        page.wait_for_timeout(600)

        # Blocks are not draggable: no trigger changes, no undo entry
        for ev_id in [e for e in (brake, chained) if e]:
            page.wait_for_timeout(600)
            ev0 = page.evaluate("JSON.stringify(AppState.npcs[0].events)")
            undo0 = page.evaluate("UndoStack.length")
            drag_block(page, BLOCK.format(a=lead, e=ev_id), 60)
            if page.evaluate("Simulate.running"):
                page.click("#sim-stop")
                page.wait_for_timeout(600)
            C(f"drag {ev_id}: triggers unchanged", page.evaluate("JSON.stringify(AppState.npcs[0].events)") == ev0)
            C(f"drag {ev_id}: no undo entry", page.evaluate("UndoStack.length") == undo0)
            C(
                f"drag {ev_id}: block does not offer dragging",
                "ziehen" not in (page.get_attribute(BLOCK.format(a=lead, e=ev_id), "title") or "").lower()
                and page.locator(BLOCK.format(a=lead, e=ev_id) + ".draggable").count() == 0,
            )

        page.click("#sim-lanes-toggle")
        C("close: hidden", page.locator("#sim-lanes.hidden").count() == 1)

        C("no JS errors", not [e for e in errors if "404" not in e], errors[:5])
        browser.close()
    sys.exit(C.report())


if __name__ == "__main__":
    main()
