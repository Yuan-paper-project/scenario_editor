"""Recipe panel suite: a generated scenario's parameters, editable and rebuilt.

`generate()` stores a recipe on `AppState.generated` ({type, seed, near,
anchored, attempt, overrides, params, criticality, signature}); the Übersicht
tab's „Generiert" block (ScenarioGenerator.recipeHtml / bindRecipe) shows one
field per parameter. Pinned here:

  * every type's recipe lists ego speed plus its own parameters;
  * changing a field through the real panel pins it, rebuilds with exactly
    that value on the same site (the original attempt is retried first), and
    is ONE undo step that restores the old scenario AND the old recipe;
  * × unpins and the value goes back to the seed's own draw;
  * „Variante würfeln" changes the seed, keeps the pins, stays near the spot;
  * a pin the site cannot honour is flagged, and shows the value used;
  * a hand edit is detected and the next rebuild asks first; cancelling keeps it;
  * the recipe is saved to and loaded from the .json save file;
  * on another map the panel says so and does not rebuild.
"""

import json
import sys

from playwright.sync_api import sync_playwright

import _harness as H

C = H.Checks()
TOWN = "Town05"
TYPES = [
    "lead_brake",
    "slow_lead",
    "cut_in",
    "vru_crossing",
    "turn_vru",
    "junction_conflict",
    "obstacle",
    "oncoming_drift",
    "cut_out",
    "cyclist_ahead",
    "pull_out",
    "rear_approach",
]

STATE = """() => ({ g: AppState.generated, ego: AppState.ego && { x: AppState.ego.x, y: AppState.ego.y },
                    npcs: JSON.stringify(AppState.npcs), undo: UndoStack.length })"""


def show_overview(page):
    page.evaluate("AppState.select(null)")
    page.click('[data-overview-tab="overview"]')
    page.wait_for_selector("[data-recipe]", timeout=5000)


def set_field(page, key, value):
    loc = page.locator(f'[data-recipe-key="{key}"]')
    kind = loc.evaluate("el => el.tagName === 'SELECT' ? 'select' : el.type")
    if kind == "select":
        loc.select_option(value)
    elif kind == "checkbox":
        loc.set_checked(bool(value))
    else:
        loc.fill(str(value))
        loc.press("Enter")
        loc.evaluate("el => el.blur()")
    page.wait_for_timeout(250)


def main():
    with sync_playwright() as pw:
        browser, page, errors = H.open_editor(pw, TOWN)
        page.wait_for_function("AppState.laneGraph !== null", timeout=60000)

        # ── Every type: recipe fields ───────────────────────────────────────
        for t in TYPES:
            info = page.evaluate("t => ScenarioGenerator.generate(t, 5)", t)
            if not C(f"{t}: generated", info is not None):
                continue
            show_overview(page)
            # Every parameter this build used, in PARAMS order; one it never
            # used (a breakdown's person type) is left out unless pinned.
            keys = page.evaluate(
                """t => ScenarioGenerator.PARAMS[t].filter(k => k === 'ego_speed'
                                     || AppState.generated.params[k] !== undefined)""",
                t,
            )
            shown = page.evaluate(
                "() => [...document.querySelectorAll('[data-recipe-key]')].map(e => e.dataset.recipeKey)"
            )
            C(f"{t}: panel lists ego speed + every parameter the build used", shown == keys, (shown, keys))
            g = page.evaluate("AppState.generated")
            C(
                f"{t}: recipe stores type, seed, attempt, site",
                g["type"] == t and g["seed"] == 5 and isinstance(g["attempt"], int) and g["near"] is not None,
                g,
            )

        # ── Edit through the panel: pin, same site, one undo step ───────────
        page.evaluate("ScenarioGenerator.generate('lead_brake', 5)")
        show_overview(page)
        before = page.evaluate(STATE)
        set_field(page, "decel", 7)
        after = page.evaluate(STATE)
        C("edit: rebuilt with the pinned value", after["g"]["params"]["decel"] == 7, after["g"]["params"])
        C("edit: value is pinned", after["g"]["overrides"] == {"decel": 7}, after["g"]["overrides"])
        C(
            "edit: same site (ego start unchanged)",
            abs(after["ego"]["x"] - before["ego"]["x"]) < 0.01 and abs(after["ego"]["y"] - before["ego"]["y"]) < 0.01,
            (before["ego"], after["ego"]),
        )
        C("edit: the NPC events changed", after["npcs"] != before["npcs"])
        C("edit: one undo step", after["undo"] == before["undo"] + 1, after["undo"] - before["undo"])
        C("edit: panel shows the pin marker", page.locator('[data-recipe-row="decel"].pinned').count() == 1)
        C(
            "edit: other parameters keep their seed values",
            all(
                after["g"]["params"][k] == before["g"]["params"][k] for k in ("brake_headway_s", "hold_s", "lead_type")
            ),
            after["g"]["params"],
        )

        page.mouse.click(5, 5)
        page.keyboard.press("Control+z")
        undone = page.evaluate(STATE)
        C("undo: scenario back", undone["npcs"] == before["npcs"])
        C("undo: recipe back (no pins)", undone["g"]["overrides"] == {}, undone["g"]["overrides"])
        page.keyboard.press("Control+y")
        C("redo: pinned recipe back", page.evaluate("AppState.generated.overrides") == {"decel": 7})

        # ── Unpin ───────────────────────────────────────────────────────────
        show_overview(page)
        page.click('[data-recipe-unpin="decel"]')
        page.wait_for_timeout(250)
        st = page.evaluate(STATE)
        C("unpin: no pins left", st["g"]["overrides"] == {}, st["g"]["overrides"])
        C(
            "unpin: value back to the seed's draw",
            st["g"]["params"]["decel"] == before["g"]["params"]["decel"],
            (st["g"]["params"]["decel"], before["g"]["params"]["decel"]),
        )
        C(
            "unpin: scenario identical to the original",
            st["npcs"].replace('"obj-', '') != ""
            and json.loads(st["npcs"])[0]["events"] == json.loads(before["npcs"])[0]["events"],
        )

        # ── Variant ─────────────────────────────────────────────────────────
        show_overview(page)
        set_field(page, "hold_s", 9)
        near = page.evaluate("AppState.generated.near")
        page.click("[data-recipe-variant]")
        page.wait_for_timeout(400)
        v = page.evaluate(STATE)
        C("variant: new seed", v["g"]["seed"] != 5, v["g"]["seed"])
        C(
            "variant: pin kept",
            v["g"]["overrides"].get("hold_s") == 9 and v["g"]["params"]["hold_s"] == 9,
            v["g"]["overrides"],
        )
        at = v["g"]["criticality"]["at"]
        C(
            "variant: conflict near the same spot",
            ((at["x"] - near["x"]) ** 2 + (at["y"] - near["y"]) ** 2) ** 0.5 <= 40,
            (at, near),
        )

        # ── A pin the site cannot honour is flagged ─────────────────────────
        page.evaluate("""() => {
          const g = AppState.generated;
          AppState.set({ generated: { ...g, overrides: { ...g.overrides, resumes: !g.params.resumes },
                                      params: { ...g.params } } });
        }""")
        show_overview(page)
        C("unmet pin: row flagged", page.locator('[data-recipe-row="resumes"].unmet').count() == 1)
        page.keyboard.press("Control+z")

        # ── Hand edit: detected, rebuild asks, cancel keeps it ──────────────
        page.evaluate("""() => { const n = AppState.npcs[0]; AppState.updateById(n.id, { x: n.x + 3 }); }""")
        show_overview(page)
        C("hand edit: panel warns", page.locator(".gen-recipe-warn").count() == 1)
        edited = page.evaluate("JSON.stringify(AppState.npcs)")
        page.locator('[data-recipe-key="decel"]').fill("6")
        page.locator('[data-recipe-key="decel"]').press("Enter")
        page.wait_for_selector("#confirm-overlay:not(.hidden)", timeout=5000)
        page.keyboard.press("Escape")
        page.wait_for_timeout(250)
        C("hand edit: cancelling keeps the edited scenario", page.evaluate("JSON.stringify(AppState.npcs)") == edited)
        C(
            "hand edit: the field shows the old value again",
            float(page.locator('[data-recipe-key="decel"]').input_value())
            == page.evaluate("AppState.generated.params.decel"),
        )

        # ── Sweep: one scenario per value, same site, editor untouched ──────
        page.evaluate("ScenarioGenerator.generate('lead_brake', 5)")
        before = page.evaluate(STATE)
        sw = page.evaluate("""async () => {
          const r = await ScenarioGenerator.sweepFromRecipe({ key: 'decel', from: 3, to: 7, steps: 3 });
          return { values: r.values, n: r.entries.length, skipped: r.skipped.length,
                   got: r.entries.map(e => e.meta.params.decel), pinned: r.entries.map(e => e.meta.sweep_value),
                   egos: r.entries.map(e => [e.scenario.ego.x, e.scenario.ego.y]),
                   recipes: r.entries.map(e => e.scenario.generated && e.scenario.generated.seed),
                   names: r.entries.map(e => e.name) };
        }""")
        C("sweep: values evenly spaced", sw["values"] == [3, 5, 7], sw["values"])
        C("sweep: one scenario per value", sw["n"] == 3 and sw["skipped"] == 0, sw)
        C("sweep: each built with its value", sw["got"] == [3, 5, 7], sw["got"])
        C(
            "sweep: all on the original site",
            all(abs(x - before["ego"]["x"]) < 0.01 and abs(y - before["ego"]["y"]) < 0.01 for x, y in sw["egos"]),
            sw["egos"],
        )
        C("sweep: names carry parameter and value", all("decel-" in n for n in sw["names"]), sw["names"])
        after = page.evaluate(STATE)
        C("sweep: editor scenario untouched", after["npcs"] == before["npcs"] and after["undo"] == before["undo"])
        C("sweep: recipe untouched", after["g"] == before["g"])
        sw2 = page.evaluate("""async () => {
          const r = await ScenarioGenerator.sweepFromRecipe({ key: 'lead_type', weathers: true });
          return { values: r.values, n: r.entries.length,
                   weathers: [...new Set(r.entries.map(e => e.meta.weather))].length,
                   types: [...new Set(r.entries.map(e => e.meta.params.lead_type))] };
        }""")
        C(
            "sweep (choice × weather): every option",
            sw2["values"] == ["car", "van", "truck", "bus", "motorcycle"],
            sw2["values"],
        )
        C("sweep (choice × weather): 6 weathers each", sw2["weathers"] == 6 and sw2["n"] == len(sw2["types"]) * 6, sw2)

        show_overview(page)
        page.click(".gen-sweep summary")
        page.select_option("[data-sweep-key]", "hold_s")
        page.fill("[data-sweep-steps]", "3")
        page.locator("[data-sweep-steps]").press("Enter")
        page.wait_for_timeout(200)
        C("sweep panel: stays open across re-renders", page.locator(".gen-sweep[open]").count() == 1)
        C(
            "sweep panel: button counts the scenarios",
            "3 Szenarien" in page.locator("[data-sweep-run]").inner_text(),
            page.locator("[data-sweep-run]").inner_text(),
        )
        with page.expect_download(timeout=60000) as dl:
            page.click("[data-sweep-run]")
        path = dl.value.path()
        import zipfile

        z = zipfile.ZipFile(path)
        names = z.namelist()
        C(
            "sweep panel: zip holds 3 × (.xosc, .json, route) + manifest",
            sum(n.endswith(".xosc") for n in names) == 3 and "manifest.csv" in names,
            names,
        )
        man = json.loads(z.read("manifest.json"))
        rows = man if isinstance(man, list) else man.get("scenarios", man.get("entries", []))
        C(
            "sweep panel: manifest records the swept values",
            sorted(r.get("sweep_value") for r in rows) == [1.0, 5.5, 10.0],
            rows[:1],
        )

        # ── Save file round trip ────────────────────────────────────────────
        saved = page.evaluate("JSON.stringify(AppState.toJSON())")
        C("save: recipe in the .json", json.loads(saved).get("generated", {}).get("type") == "lead_brake")
        page.evaluate("s => AppState.loadJSON(JSON.parse(s))", saved)
        C(
            "load: recipe restored",
            page.evaluate("AppState.generated && AppState.generated.seed") == json.loads(saved)["generated"]["seed"],
        )

        # ── Another map ─────────────────────────────────────────────────────
        # Switching maps empties the scenario, recipe included (toolbar.js).
        H.select_map(page, "Town03")
        page.wait_for_function("AppState.laneGraph !== null && AppState.map === 'Town03'", timeout=60000)
        C("other map: a map switch clears the recipe", page.evaluate("AppState.generated") is None)
        # A recipe can still name another town in a (hand-edited) save file:
        # the panel says so and refuses to rebuild there.
        page.evaluate("s => { const d = JSON.parse(s); d.map = 'Town03'; AppState.loadJSON(d); }", saved)
        page.wait_for_timeout(500)
        show_overview(page)
        C("other map: panel says where it was built", page.locator(".gen-recipe-warn", has_text="Town05").count() == 1)
        npcs0 = page.evaluate("JSON.stringify(AppState.npcs)")
        C(
            "other map: rebuild refused",
            page.evaluate("ScenarioGenerator.rebuild({ decel: 5 })") is None
            and page.evaluate("JSON.stringify(AppState.npcs)") == npcs0,
        )

        C("no JS errors", not [e for e in errors if "404" not in e], errors[:5])
        browser.close()
    sys.exit(C.report())


if __name__ == "__main__":
    main()
