"""'Generate here' suite: the generator's conflict types placed at a map click.

ScenarioGenerator.build(type, seed, {near: {x, y}}) runs the ego's corridor
through a lane at the click and keeps a candidate only when its conflict
(assess's `at`) is within FOCUS_RADIUS_M of it. Pinned here:

  * the conflict lands within 40 m of the click and the ego's route passes it;
  * a seed plus a spot reproduces the same scenario;
  * a spot with no driving lane near it returns null;
  * UI: the Templates tab's „Konflikt hier erzeugen" buttons and the menu's
    „Ort auf der Karte wählen" checkbox both arm `pendingGenerate` (crosshair
    on), Esc disarms, and a map click builds the scenario as ONE undo step;
  * a click where nothing fits toasts and stays armed for the next click.
"""

import sys

from playwright.sync_api import sync_playwright

import _harness as H

C = H.Checks()
TOWN = "Town03"
RADIUS = 40

# The first few spawn points by a fixed stride: spots on real driving lanes
# spread over the town, the same each run.
SPOTS_JS = """(n) => {
  const sp = AppState.mapData.spawnPoints || [];
  let k = 7; const pts = [];
  for (let i = 0; i < n; i++) { k = (k * 7919 + 13) % sp.length; pts.push({ x: sp[k].x, y: sp[k].y }); }
  return pts;
}"""

BUILD_JS = """([type, seed, p]) => {
  const r = ScenarioGenerator.build(type, seed, { near: p });
  if (!r) return null;
  const wps = r.ego.events[0].action.waypoints;
  const route = Simulate.routeGeometry(r.ego, r.ego.events[0]) || wps;
  let routeDist = Infinity;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], b = route[i];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    routeDist = Math.min(routeDist, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  const at = r.info.criticality.at;
  return { at, dist: Math.hypot(at.x - p.x, at.y - p.y), routeDist, near: r.info.near,
           sig: JSON.stringify([r.ego.x, r.ego.y, r.npcs.map(n => [n.type, n.x, n.y]), r.props.length]) };
}"""


def click_world(page, wx, wy, ctrl=False):
    page.evaluate("([x, y]) => MapView.centreOn(x, y, 300)", [wx, wy])
    page.wait_for_timeout(100)
    sx, sy = H.assert_on_screen(page, wx, wy)
    if ctrl:
        page.keyboard.down("Control")
    page.mouse.click(sx, sy)
    if ctrl:
        page.keyboard.up("Control")


def main():
    with sync_playwright() as pw:
        browser, page, errors = H.open_editor(pw, TOWN)
        page.wait_for_function("AppState.laneGraph !== null", timeout=60000)
        spots = page.evaluate(SPOTS_JS, 6)

        # ── build() with a focus ────────────────────────────────────────────
        for t in ["lead_brake", "vru_crossing", "obstacle"]:
            built = 0
            for i, p in enumerate(spots):
                r = page.evaluate(BUILD_JS, [t, 1234, p])
                if not r:
                    continue
                built += 1
                C(f"{t}/spot{i}: conflict within {RADIUS} m of the click", r["dist"] <= RADIUS, round(r["dist"], 1))
                C(f"{t}/spot{i}: the ego's route passes the click", r["routeDist"] <= 12, round(r["routeDist"], 1))
                C(f"{t}/spot{i}: info records the spot", r["near"] is not None)
            C(f"{t}: builds at most of {len(spots)} spots", built >= len(spots) // 2, built)

        p = spots[0]
        a = page.evaluate(BUILD_JS, ["lead_brake", 77, p])
        b = page.evaluate(BUILD_JS, ["lead_brake", 77, p])
        C("seed + spot reproduces the scenario", a and b and a["sig"] == b["sig"])
        far = page.evaluate("ScenarioGenerator.build('lead_brake', 1, { near: { x: 1e5, y: 1e5 } })")
        C("a spot with no lane near it returns null", far is None)

        # ── UI: Templates tab arms, Esc disarms ─────────────────────────────
        page.evaluate("AppState.select(null)")
        page.click('[data-overview-tab="templates"]')
        n = page.evaluate("document.querySelectorAll('[data-generate-here]').length")
        C(
            "templates tab: one button per type plus 'Beliebig'",
            n == 1 + len(page.evaluate("Object.keys(ScenarioGenerator.TYPES)")),
            n,
        )
        page.click('[data-generate-here="lead_brake"]')
        C("templates tab: arms pendingGenerate", page.evaluate("AppState.pendingGenerate") == "lead_brake")
        C("armed: the map shows the placement cursor", page.evaluate("MapView.svg.classList.contains('placing')"))
        page.keyboard.press("Escape")
        C("Esc disarms", page.evaluate("AppState.pendingGenerate") is None)
        C("Esc drops the placement cursor", not page.evaluate("MapView.svg.classList.contains('placing')"))

        # ── UI: the click builds, as one undo step ──────────────────────────
        page.click('[data-generate-here="lead_brake"]')
        page.evaluate("document.getElementById('gen-seed').value = '1234'")
        undo0 = page.evaluate("UndoStack.length")
        click_world(page, p["x"], p["y"])
        page.wait_for_function("AppState.ego !== null", timeout=30000)
        C(
            "click: builds a scenario with an ego and an NPC",
            page.evaluate("!!AppState.ego && AppState.npcs.length >= 1"),
        )
        C("click: disarms afterwards", page.evaluate("AppState.pendingGenerate") is None)
        C(
            "click: one undo step",
            page.evaluate("UndoStack.length") == undo0 + 1,
            page.evaluate("UndoStack.length") - undo0,
        )
        info = page.evaluate("ScenarioGenerator.lastInfo")
        C(
            "click: built at the clicked spot",
            info
            and info.get("near") is not None
            and abs(info["near"]["x"] - p["x"]) < 3
            and abs(info["near"]["y"] - p["y"]) < 3,
            info and info.get("near"),
        )
        C(
            "click: the seed field was used and cleared",
            info["seed"] == 1234 and page.input_value("#gen-seed") == "",
            info["seed"],
        )

        # ── UI: menu checkbox arms instead of generating; replace confirms ──
        ego_before = page.evaluate("JSON.stringify(AppState.ego)")
        page.click("#gen-menu-btn")
        page.check("#gen-pick-spot")
        page.locator("#gen-menu-types .menu-item", has_text="Querende Person").click()
        C("menu + checkbox: arms instead of generating", page.evaluate("AppState.pendingGenerate") == "vru_crossing")
        C("menu + checkbox: scenario untouched", page.evaluate("JSON.stringify(AppState.ego)") == ego_before)

        # A click far off any road: nothing fits, toast, stays armed.
        bounds = page.evaluate("AppState.mapData.bounds")
        off_x, off_y = bounds["xMin"] - 40, bounds["yMin"] - 40
        click_world(page, off_x, off_y, ctrl=True)
        page.wait_for_timeout(300)
        C("no site: stays armed for another click", page.evaluate("AppState.pendingGenerate") == "vru_crossing")
        C("no site: scenario untouched", page.evaluate("JSON.stringify(AppState.ego)") == ego_before)
        C("no site: an error toast says so", page.locator(".toast", has_text="an dieser Stelle").count() >= 1)

        # Over an existing scenario a click asks first; cancelling keeps it.
        click_world(page, spots[1]["x"], spots[1]["y"])
        page.wait_for_selector("#confirm-overlay:not(.hidden)", timeout=5000)
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        C(
            "replace: cancelling the confirm keeps the scenario",
            page.evaluate("JSON.stringify(AppState.ego)") == ego_before,
        )

        C("no JS errors", not [e for e in errors if "404" not in e], errors[:5])
        browser.close()
    sys.exit(C.report())


if __name__ == "__main__":
    main()
