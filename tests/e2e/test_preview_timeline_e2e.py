"""The preview's scrubbable timeline, and roads drawn by height.

Two features that only exist in the browser:

  1. simulate.js simulates the whole run up front at a fixed 20 Hz and replays
     it, so the timeline can be scrubbed. Pinned here: seeking is
     deterministic (the same t gives the same pose, whichever way you got
     there), event ticks appear where events fire, Stop puts every pose back
     and leaves the undo history alone, and the keyboard steps.
  2. mapRender.js draws a road that passes OVER another one in #layer-overpass,
     above the ground-level markings, so a bridge hides what it crosses.

    bash run.sh 9090            # terminal 1
    .venv/bin/python3 tests/e2e/test_preview_timeline_e2e.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _harness as H  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

check = H.Checks()

POSE = "() => AppState.npcs.map(n => [n.id, +n.x.toFixed(2), +n.y.toFixed(2)])"


def seek(page, frac):
    box = page.locator("#sim-progress-bar").bounding_box()
    page.mouse.click(box["x"] + box["width"] * frac, box["y"] + box["height"] / 2)
    page.wait_for_timeout(150)


def view_time(page):
    return float(page.inner_text("#sim-time-label").split(" s")[0])


with sync_playwright() as p:
    browser, page, errors = H.open_editor(p, "Town03")
    page.wait_for_function("!!AppState.laneGraph", timeout=30000)

    # ── 1. Timeline ──────────────────────────────────────────────────────────
    info = page.evaluate("ScenarioGenerator.generate('lead_brake', 7)")
    check("a scenario to preview was generated", bool(info and info.get("type")), str(info))
    authored = page.evaluate(POSE)
    authored_ego = page.evaluate("[AppState.ego.x, AppState.ego.y]")
    undo_before = page.evaluate("UndoStack.length")

    # A click on the bar with nothing running starts a preview, paused there.
    seek(page, 0.5)
    check(
        "clicking the bar starts a paused preview",
        page.evaluate("Simulate.running") and page.is_visible("#sim-play") and not page.is_visible("#sim-pause"),
    )
    label = page.inner_text("#sim-time-label")
    end = float(label.split("/")[1].strip().split(" ")[0])
    check("the label reads 't / end'", "/" in label and end > 5, label)
    check("the run ends no later than every Act's 60 s MaxSimTime", end <= 60.0 + 1e-6, label)
    t_mid = view_time(page)
    check("seeking to the middle lands mid-run", abs(t_mid - end / 2) < end * 0.05, f"{t_mid} of {end}")
    mid_pose = page.evaluate(POSE)
    check("seeking moves the actors off their authored pose", mid_pose != authored, f"{mid_pose} vs {authored}")

    # Deterministic: back to the start, then forward again, same pose. Pos1,
    # not a click on the left edge: that lands on the t = 0.05 s route tick.
    page.evaluate("document.activeElement && document.activeElement.blur()")
    page.keyboard.press("Home")
    page.wait_for_timeout(100)
    check("Pos1 seeks to 0", view_time(page) == 0.0, page.inner_text("#sim-time-label"))
    check(
        "seeking to 0 puts the actors at their start pose",
        page.evaluate(POSE) == authored,
        f"{page.evaluate(POSE)} vs {authored}",
    )
    seek(page, 0.5)
    check(
        "seeking to the same time twice gives the same pose",
        page.evaluate(POSE) == mid_pose,
        f"{page.evaluate(POSE)} vs {mid_pose}",
    )

    markers = page.evaluate(
        "[...document.querySelectorAll('#sim-progress-bar .sim-marker')].map(m => ({t: +m.dataset.t, title: m.title}))"
    )
    check("event ticks are drawn on the timeline", len(markers) >= 2, str(markers))
    check("ticks are named after the event card", any("Geschw. setzen" in m["title"] for m in markers), str(markers))
    fired = page.evaluate("""() => { /* headless run is refused while Play runs */
        return Simulate.runHeadless() === null; }""")
    check("runHeadless still refuses to run beside a preview", fired)

    # A press on a tick lands exactly on its event.
    brake = next((m for m in markers if "Geschw. setzen 2" in m["title"]), None)
    if brake:
        tick = page.locator(f'.sim-marker[data-t="{brake["t"]}"]').first
        tb = tick.bounding_box()
        page.mouse.click(tb["x"] + tb["width"] / 2, tb["y"] + tb["height"] / 2)
        page.wait_for_timeout(150)
        check(
            "clicking an event tick seeks to the event's own time",
            abs(view_time(page) - brake["t"]) < 0.051,
            f"{view_time(page)} vs {brake['t']}",
        )

    # Keyboard: → steps 0.5 s, Umschalt+← steps 5 s back.
    page.evaluate("document.activeElement && document.activeElement.blur()")
    t0 = view_time(page)
    page.keyboard.press("ArrowRight")
    page.wait_for_timeout(100)
    check("→ steps the preview forward 0.5 s", abs(view_time(page) - (t0 + 0.5)) < 0.051, f"{t0} -> {view_time(page)}")
    t1 = view_time(page)
    page.keyboard.press("Shift+ArrowLeft")
    page.wait_for_timeout(100)
    check(
        "Umschalt+← steps back 5 s (clamped at 0)",
        abs(view_time(page) - max(0, t1 - 5)) < 0.051,
        f"{t1} -> {view_time(page)}",
    )

    # Playing to the end holds the last frame and offers a replay.
    seek(page, 0.98)
    page.click("#sim-play")
    page.wait_for_function("document.getElementById('sim-play-text').textContent === 'Nochmal'", timeout=10000)
    check(
        "playback stops at the end of the run and offers 'Nochmal'",
        abs(view_time(page) - end) < 0.051,
        page.inner_text("#sim-time-label"),
    )

    page.click("#sim-stop")
    page.wait_for_timeout(150)
    check(
        "Stop puts every NPC back on its authored pose",
        page.evaluate(POSE) == authored,
        f"{page.evaluate(POSE)} vs {authored}",
    )
    check("Stop puts the ego back", page.evaluate("[AppState.ego.x, AppState.ego.y]") == authored_ego)
    check(
        "a preview with scrubbing records no undo entries",
        page.evaluate("UndoStack.length") == undo_before,
        f"{undo_before} -> {page.evaluate('UndoStack.length')}",
    )
    check("Stop clears the event ticks", page.evaluate("document.querySelectorAll('.sim-marker').length") == 0)

    # ── 2. Roads by height ───────────────────────────────────────────────────
    # Town05's ring road 37 climbs to 10 m and passes over roads 3, 9 and 24;
    # Town04's road 39 passes over road 47. Nothing in Town01 overlaps.
    H.select_map(page, "Town05")
    lv = page.evaluate("""() => [...document.querySelectorAll('#layer-overpass .ovp-level')]
        .map(g => [g.dataset.level, g.querySelectorAll('.ovp-roads polygon.lane').length])""")
    check("Town05 draws a level-1 overpass", len(lv) == 1 and lv[0][1] > 0, str(lv))
    order = page.evaluate("""() => { const ids = [...document.getElementById('world').children].map(c => c.id);
        return [ids.indexOf('layer-markings'), ids.indexOf('layer-roaddir'),
                ids.indexOf('layer-overpass'), ids.indexOf('layer-spawns'), ids.indexOf('layer-actors')]; }""")
    check(
        "the overpass is painted above ground markings and arrows",
        order[2] > order[0] and order[2] > order[1],
        str(order),
    )
    check("spawn dots and actors stay above the overpass", order[3] > order[2] and order[4] > order[2], str(order))
    has_marks = page.evaluate("document.querySelectorAll('#layer-overpass .ovp-marks > *').length")
    check("the overpass carries its own lane markings", has_marks > 0, str(has_marks))
    page.evaluate("""() => { const cb = document.getElementById('toggle-markings');
        cb.checked = false; cb.dispatchEvent(new Event('change')); }""")
    hidden = page.evaluate("""() => [...document.querySelectorAll('#layer-overpass .ovp-marks')]
        .every(g => g.style.display === 'none')""")
    check("'Markierungen' off hides the overpass markings too", hidden)
    page.evaluate("""() => { const cb = document.getElementById('toggle-markings');
        cb.checked = true; cb.dispatchEvent(new Event('change')); }""")

    H.select_map(page, "Town04")
    n4 = page.evaluate("document.querySelectorAll('#layer-overpass .ovp-level').length")
    check("Town04 draws its bridge as an overpass", n4 == 1, str(n4))
    H.select_map(page, "Town01")
    n1 = page.evaluate("document.querySelectorAll('#layer-overpass .ovp-level').length")
    check("Town01 (flat, no crossings) has no overpass", n1 == 0, str(n1))

    # Narrow windows: every bar control stays inside the card and the map. Below
    # 1340 px the strip right of the ruler is under 560 px, and „Ego bremst" /
    # „Ablauf" used to spill out under the properties panel.
    for w in (1600, 1280, 1100, 1024):
        page.set_viewport_size({"width": w, "height": 800})
        page.wait_for_timeout(200)
        bad = page.evaluate("""() => {
            const R = e => e.getBoundingClientRect();
            const card = R(document.getElementById('sim-controls'));
            const map = R(document.getElementById('map-container'));
            const ruler = R(document.getElementById('scale-ruler'));
            const out = [...document.querySelectorAll('#sim-controls button, #sim-controls .sim-progress-bar')]
              .filter(e => e.offsetParent)
              .filter(e => { const b = R(e); return b.left < card.left - 0.5 || b.right > card.right + 0.5
                                                 || b.right > map.right + 0.5; })
              .map(e => e.id || e.className);
            const overlap = !(ruler.right <= card.left || ruler.left >= card.right
                              || ruler.bottom <= card.top || ruler.top >= card.bottom);
            return { out, overlap };
        }""")
        check(f"{w} px: preview bar controls inside the card and the map", not bad["out"], str(bad["out"]))
        check(f"{w} px: scale ruler clear of the preview bar", not bad["overlap"])
    page.set_viewport_size(H.VIEWPORT)

    check("no JS errors", not errors, str(errors[:3]))
    browser.close()

sys.exit(check.report())
