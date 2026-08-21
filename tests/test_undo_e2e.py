"""Undo/redo suite: the history holds whole scenario states, not deleted actors.

The stack this replaced held one deleted actor per entry, so Strg+Z after any
*other* kind of edit popped an unrelated delete and resurrected that actor while
leaving the edit standing. Every scenario mutation is now captured automatically
at AppState's three mutators (app.js), which is why the checks below sweep every
kind of edit rather than only deletion.

Three properties are easy to get wrong and are what most of this file is for:

  * coalescing — a drag is dozens of updateById calls and must be ONE entry,
    while two deliberate edits to the same fields must stay separate;
  * everything in the snapshot records — an edit that is skipped is not merely
    un-undoable, it is DESTROYED by the next undo, because the entry pushed
    after it describes a world where it never happened. Noise is handled by
    coalescing (all the controls in one event card fold into one step), never by
    declining to record;
  * the baseline — the placement paths mutate the array before announcing it
    (`AppState.npcs = [...]; AppState.set({})`), so a snapshot taken when set()
    runs is already the post-edit state. app.js keeps a rolling baseline instead;
  * aliasing — AppState.toJSON() shares an event's trajectory array with the
    live state, and updateById mutates actors in place with Object.assign, so
    both directions have to deep-copy or the history rewrites itself.
"""
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("EDITOR_URL", "http://localhost:9090")
VIEWPORT = {"width": 1600, "height": 950}

TOWN = "Town03"

fails, checks = [], []


def check(name, cond, extra=""):
    checks.append((name, bool(cond), extra))
    if not cond:
        fails.append(f"{name} {extra}")


def load_map(page, town):
    page.select_option("#map-select", town)
    page.wait_for_function("AppState.mapData !== null", timeout=60000)


def blur(page):
    page.evaluate("document.activeElement && document.activeElement.blur()")


def undo(page):
    # Ctrl+Z is deliberately ignored while a field has focus — the browser's own
    # text undo owns the keystroke there (mapView.js `inInput`). Step off the
    # field first, as a user reaching for the shortcut would.
    blur(page)
    page.keyboard.press("Control+z")
    page.wait_for_timeout(220)


def redo(page):
    blur(page)
    page.keyboard.press("Control+Shift+z")
    page.wait_for_timeout(220)


def depth(page):
    return page.evaluate("[UndoStack.length, UndoStack.redoLength]")


def place(page, tool, sx, sy):
    page.click('[data-toolbar-tab="actors"]')
    page.click(f'.tool-btn[data-tool="{tool}"]')
    page.mouse.click(sx, sy)
    page.wait_for_timeout(400)


def pose(page, aid):
    return page.evaluate(
        f"(()=>{{const a=AppState.findById('{aid}');"
        f"return a ? [a.x, a.y, a.z] : null}})()")


def set_field(page, sel, value):
    page.fill(sel, str(value))
    page.dispatch_event(sel, "change")
    page.wait_for_timeout(250)


with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport=VIEWPORT)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console",
            lambda m: errors.append("console.error: " + m.text)
            if m.type == "error" else None)

    page.goto(BASE, wait_until="networkidle")
    page.evaluate("document.getElementById('welcome-overlay')?.classList.add('hidden')")
    load_map(page, TOWN)
    check("no JS errors on load", not errors, str(errors[:2]))

    # ── Placement: one entry each, undone newest first ───────────────────────
    place(page, "ego", 700, 500)
    place(page, "car", 650, 470)
    place(page, "car", 760, 530)
    check("ego and two NPCs placed",
          page.evaluate("!!AppState.ego && AppState.npcs.length === 2"))
    check("three placements are three entries", depth(page)[0] == 3, str(depth(page)))

    undo(page)
    check("undo drops only the last NPC", page.evaluate("AppState.npcs.length") == 1,
          str(page.evaluate("AppState.npcs.length")))
    undo(page)
    check("undo drops the first NPC", page.evaluate("AppState.npcs.length") == 0)
    undo(page)
    check("undo drops the ego", page.evaluate("AppState.ego") is None)
    check("undo stack is empty, redo stack is full", depth(page) == [0, 3], str(depth(page)))

    redo(page)
    redo(page)
    redo(page)
    check("redo rebuilds all three",
          page.evaluate("!!AppState.ego && AppState.npcs.length === 2"))

    nid = page.evaluate("AppState.npcs[0].id")

    # ── A drag is one entry, and it carries the mouseup z with it ────────────
    #
    # Aim below the body's centre: the yaw arrow's shaft is drawn from the actor
    # centre outward and sits above the body, so a click at the exact centre
    # grabs the rotate handle instead. The group's own box is no better — it
    # also spans the label above the marker.
    before = pose(page, nid)
    d0 = depth(page)[0]
    box = page.eval_on_selector(
        f'.actor-group[data-id="{nid}"] .actor-body',
        "e => { const r = e.getBoundingClientRect();"
        "       return [r.x + r.width / 2, r.y + r.height * 0.8]; }")
    page.mouse.move(box[0], box[1])
    page.mouse.down()
    for i in range(1, 9):
        page.mouse.move(box[0] + i * 6, box[1] + i * 4)
        page.wait_for_timeout(20)
    page.mouse.up()
    page.wait_for_timeout(400)
    after = pose(page, nid)

    check("the drag moved the actor", abs(after[0] - before[0]) > 0.5,
          f"{before} -> {after}")
    check("a whole drag is ONE undo entry", depth(page)[0] - d0 == 1,
          f"{d0} -> {depth(page)[0]}")
    undo(page)
    check("one undo restores x, y AND the re-derived z",
          [round(v, 3) for v in pose(page, nid)] == [round(v, 3) for v in before],
          f"{before} vs {pose(page, nid)}")

    # ── Two deliberate edits to the same fields stay separate ────────────────
    #
    # _onPosChange sends all four of x/y/z/yaw every time, so both edits produce
    # the same coalescing key. Only the seal on `change` keeps them apart.
    page.evaluate(f"AppState.select('{nid}')")
    page.wait_for_timeout(250)
    d0 = depth(page)[0]
    set_field(page, "#prop-yaw", 45)
    set_field(page, "#prop-yaw", 90)
    check("two field edits are two entries", depth(page)[0] - d0 == 2,
          f"{d0} -> {depth(page)[0]}")
    undo(page)
    check("undo steps back one field edit, not both",
          page.evaluate(f"AppState.findById('{nid}').yaw") == 45,
          str(page.evaluate(f"AppState.findById('{nid}').yaw")))

    # A no-op change writes no entry: blurring a field re-fires `change` with the
    # value already in it, so without the guard, tabbing through the Spawnpunkt
    # grid fills the history with steps that undo to where they started.
    d0 = depth(page)[0]
    set_field(page, "#prop-yaw", 45)
    check("re-committing the same value adds no entry", depth(page)[0] == d0,
          f"{d0} -> {depth(page)[0]}")

    # ── Events: adding and removing are history, tweaking is not ─────────────
    #
    # Editing an event inside its card is one control away from being put back
    # by hand, and recording every dropdown evicted the placements and drags
    # from the stack. Gaining or losing a whole card is the opposite. The test
    # is the event count changing, in either direction.
    d0 = depth(page)[0]
    page.click('.event-action-button:has-text("Geschw. setzen")')
    page.wait_for_timeout(400)
    check("event added", page.evaluate(f"AppState.findById('{nid}').events.length") == 1)
    check("adding an event is one entry", depth(page)[0] - d0 == 1,
          f"{d0} -> {depth(page)[0]}")
    undo(page)
    check("undo removes the added event",
          page.evaluate(f"AppState.findById('{nid}').events.length") == 0)
    redo(page)
    check("redo brings the added event back",
          page.evaluate(f"AppState.findById('{nid}').events.length") == 1)

    # Every control in ONE card folds into a single step: the coalescing key is
    # the changed event's own id, and app.js skips the seal inside .event-card.
    d0 = depth(page)[0]
    for value in (12, 18, 22):
        set_field(page, ".event-speed-row input[type=number]", value)
    page.select_option(".event-trigger-block select", "distance_to_ego")
    page.wait_for_timeout(400)
    check("the speed value actually changed",
          page.evaluate(
              f"AppState.findById('{nid}').events[0].action.target.value") == 22,
          str(page.evaluate(
              f"AppState.findById('{nid}').events[0].action.target.value")))
    check("the trigger type actually changed",
          page.evaluate(
              f"AppState.findById('{nid}').events[0].trigger.type") == "distance_to_ego",
          str(page.evaluate(f"AppState.findById('{nid}').events[0].trigger.type")))
    check("tuning one card is ONE entry, not four", depth(page)[0] - d0 == 1,
          f"{d0} -> {depth(page)[0]}")
    undo(page)
    check("one undo reverts the whole card-tuning session",
          page.evaluate(
              f"AppState.findById('{nid}').events[0].action.target.value") == 10,
          str(page.evaluate(
              f"AppState.findById('{nid}').events[0].action.target.value")))
    redo(page)

    # ── The ride-along guard: an edit that is not recorded is DESTROYED ───────
    #
    # Add event A, then retune event B, then undo. The undo must step back the
    # retune and leave A alone — when event tweaks were skipped, it stepped back
    # to before A was added and silently threw the retune away.
    page.click('.event-action-button:has-text("Spurwechsel")')
    page.wait_for_timeout(400)
    check("a second event was added",
          page.evaluate(f"AppState.findById('{nid}').events.length") == 2)
    set_field(page, ".event-speed-row input[type=number]", 33)
    undo(page)
    check("undo reverts the retune of the OTHER event",
          page.evaluate(
              f"AppState.findById('{nid}').events[0].action.target.value") == 22,
          str(page.evaluate(
              f"AppState.findById('{nid}').events[0].action.target.value")))
    check("...and leaves the newly added event in place",
          page.evaluate(f"AppState.findById('{nid}').events.length") == 2,
          str(page.evaluate(f"AppState.findById('{nid}').events.length")))
    undo(page)
    check("the next undo is the one that removes the added event",
          page.evaluate(f"AppState.findById('{nid}').events.length") == 1)

    # Deleting one IS recorded, and comes back with its parameters intact.
    d0 = depth(page)[0]
    page.click(".event-card .event-delete")
    page.wait_for_timeout(400)
    check("event deleted",
          page.evaluate(f"AppState.findById('{nid}').events.length") == 0)
    check("deleting an event is one entry", depth(page)[0] - d0 == 1,
          f"{d0} -> {depth(page)[0]}")
    undo(page)
    check("undo restores the deleted event",
          page.evaluate(f"AppState.findById('{nid}').events.length") == 1)
    check("the restored event keeps its edited speed",
          page.evaluate(
              f"AppState.findById('{nid}').events[0].action.target.value") == 22,
          str(page.evaluate(
              f"AppState.findById('{nid}').events[0].action.target.value")))
    check("the restored event keeps its edited trigger",
          page.evaluate(
              f"AppState.findById('{nid}').events[0].trigger.type") == "distance_to_ego")

    # ── Delete restores the object AND the selection it had ──────────────────
    page.evaluate(f"AppState.select('{nid}')")
    page.wait_for_timeout(200)
    page.keyboard.press("Shift+Delete")   # Shift skips the confirm
    page.wait_for_timeout(400)
    check("actor deleted", page.evaluate(f"!AppState.findById('{nid}')"))
    undo(page)
    check("undo restores the actor", page.evaluate(f"!!AppState.findById('{nid}')"))
    check("undo restores the selection it had",
          page.evaluate("AppState.selectedId") == nid,
          str(page.evaluate("AppState.selectedId")))
    check("the restored actor keeps its events",
          page.evaluate(f"AppState.findById('{nid}').events.length") == 1)

    # ── A bulk prop delete is one entry, not one per prop ────────────────────
    page.evaluate("AppState.select(null)")
    page.wait_for_timeout(200)
    page.click('[data-toolbar-tab="props"]')
    page.wait_for_timeout(250)
    page.click('.tool-btn[data-prop="static.prop.trafficcone01"]')
    page.wait_for_timeout(200)
    for i in range(4):
        page.mouse.click(600 + i * 15, 620)
        page.wait_for_timeout(280)
    check("four cones placed", page.evaluate("AppState.staticObjects.length") == 4,
          str(page.evaluate("AppState.staticObjects.length")))

    d0 = depth(page)[0]
    page.evaluate(
        "document.querySelector('.scene-del-all')"
        ".dispatchEvent(new MouseEvent('click', {bubbles: true, shiftKey: true}))")
    page.wait_for_timeout(600)
    check("the whole cone type is gone",
          page.evaluate("AppState.staticObjects.length") == 0)
    check("a bulk delete is ONE entry", depth(page)[0] - d0 == 1,
          f"{d0} -> {depth(page)[0]}")
    undo(page)
    check("one undo brings all four back",
          page.evaluate("AppState.staticObjects.length") == 4,
          str(page.evaluate("AppState.staticObjects.length")))

    # ── The preview writes actor poses every tick and must record none ───────
    d0 = depth(page)[0]
    page.click("#sim-play")
    page.wait_for_timeout(2500)
    page.click("#sim-stop")
    page.wait_for_timeout(600)
    check("a preview run adds no history", depth(page)[0] == d0,
          f"{d0} -> {depth(page)[0]}")

    # ── Entries are independent copies, not views of the live state ──────────
    page.evaluate(f"AppState.select('{nid}')")
    page.wait_for_timeout(250)
    x0 = page.evaluate(f"AppState.findById('{nid}').x")
    set_field(page, "#prop-x", round(x0 + 25, 2))
    set_field(page, "#prop-x", round(x0 + 50, 2))
    undo(page)
    undo(page)
    xnow = page.evaluate(f"AppState.findById('{nid}').x")
    check("two undos land back on the original x", abs(xnow - x0) < 0.01,
          f"{x0} vs {xnow}")

    # ── Opening a file resets the history ────────────────────────────────────
    check("history is non-empty before the load", depth(page)[0] > 0)
    page.evaluate(
        "AppState.loadJSON({map:'Town03', ego:null, npcs:[], staticObjects:[]})")
    page.wait_for_timeout(400)
    check("loadJSON clears undo and redo", depth(page) == [0, 0], str(depth(page)))

    check("no unexpected JS errors during the run",
          not [e for e in errors if "favicon" not in e], str(errors[:3]))
    b.close()

for name, ok, extra in checks:
    print(f"  {'PASS' if ok else 'FAIL'}    {name}" + (f"   [{extra}]" if not ok else ""))
print(f"\n{len(checks) - len(fails)}/{len(checks)} passed")
sys.exit(1 if fails else 0)
