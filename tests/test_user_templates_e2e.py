"""User templates suite („Eigene Vorlagen", templates.js).

An actor's event chain saved as a template, with positions stored relative to
the actor (u along its heading, v to its right) and actor references as
'$self' / '$ego'. Pinned here:

  * „Als Vorlage speichern" in the event panel stores the chain in
    localStorage with no absolute coordinates in it;
  * the template appears under „Eigene Vorlagen" and places through the real
    click like a built-in one: same events, a trajectory that keeps its shape
    and turns with the new actor, heights from the surface, self refs on the
    new actor, an Init speed, and an export the backend accepts;
  * it is offered by the event panel's „Ablauf aus Template" picker;
  * a chain naming another NPC is refused, and nothing is stored;
  * rename, delete (with confirm), survive a reload, export + import a file.
"""
import json
import math
import os
import sys
import tempfile

from playwright.sync_api import sync_playwright

import _harness as H

C = H.Checks()
EGO = (300.631, -2.025)
SRC = (265.364, 1.967)     # a kerb spot across Town01 road 1 (test_templates_e2e.py)
DST = (200.0, 1.967)       # further along the same road

SEED_JS = """() => {
  localStorage.removeItem('scenarioEditor.userTemplates');
  ScenarioTemplates._loadUserTemplates();
  // Ids from nextId(), never literals: a literal does not advance the counter,
  // and the next placed actor would be handed the ego's own id.
  const egoId = AppState.nextId(), bikeId = AppState.nextId();
  AppState.npcs = []; AppState.staticObjects = [];
  AppState.ego = { id: egoId, type: 'ego', x: 300.631, y: -2.025, z: 0.2, yaw: 180, initial_speed: 8,
                   events: [{ id: 'evt-1', trigger: { type: 'simulation_time', value: 0 },
                              action: { type: 'set_speed', dynamics: { shape: 'step', dimension: 'time', value: 5 },
                                        target: { mode: 'absolute', value: 8 } } }] };
  const bike = { id: bikeId, type: 'cyclist', x: 265.364, y: 1.967, z: 0.8, yaw: 90, initial_speed: 0, events: [] };
  bike.events = ScenarioTemplates.eventsForActor(bike, 'cyclist-crossing');
  // A self-referencing positional trigger, so '$self' is exercised too.
  bike.events.push({ id: 'evt-9', trigger: { type: 'distance_to_point', value: 2, entity_ref: bikeId,
                     point: { name: 'Point 1', x: 265.4, y: -1.0, z: 0.7 } },
                     action: { type: 'set_speed', dynamics: { shape: 'step', dimension: 'time', value: 2 },
                               target: { mode: 'absolute', value: 2 } } });
  AppState.npcs = [bike];
  AppState.set({});
  return { egoId, bikeId };
}"""


def vertex_dists(traj):
    return [round(math.hypot(b["x"] - a["x"], b["y"] - a["y"]), 1) for a, b in zip(traj, traj[1:])]


def main():
    with sync_playwright() as pw:
        browser, page, errors = H.open_editor(pw, "Town01")
        ids = page.evaluate(SEED_JS)
        src = page.evaluate("AppState.npcs[0]")

        # ── Save from the event panel ───────────────────────────────────────
        page.evaluate("id => AppState.select(id)", ids["bikeId"])
        page.wait_for_selector(".event-template-save", timeout=5000)
        page.click(".event-template-save")
        stored = page.evaluate("JSON.parse(localStorage.getItem('scenarioEditor.userTemplates') || '[]')")
        C("save: one template stored", len(stored) == 1, stored)
        t = stored[0] if stored else {}
        C("save: actor type and start speed kept", t.get("actorType") == "cyclist" and t.get("initialSpeed") == 0, t)
        blob = json.dumps(t.get("events", []))
        C("save: no absolute coordinates left", '"x":' not in blob and '"y":' not in blob, blob[:300])
        C("save: self reference stored as $self", '"$self"' in blob)
        C("save: no editor ids stored", ids["bikeId"] not in blob and ids["egoId"] not in blob)

        # ── Listed and placed through the real click ────────────────────────
        page.evaluate("AppState.select(null)")
        page.click('[data-overview-tab="templates"]')
        C("tab: listed under Eigene Vorlagen", page.locator('[data-user-template="user:1"]').count() == 1)
        placed = H.place_template(page, "user:1", *DST)
        C("place: a cyclist", placed["type"] == "cyclist", placed["type"])
        C("place: same number of events", len(placed["events"]) == len(src["events"]),
          (len(placed["events"]), len(src["events"])))
        C("place: start speed from the template", placed.get("initial_speed") == 0, placed.get("initial_speed"))
        traj_src = next(e for e in src["events"] if e["action"]["type"] == "follow_trajectory")["action"]["trajectory"]
        traj = next(e for e in placed["events"] if e["action"]["type"] == "follow_trajectory")["action"]["trajectory"]
        C("place: trajectory keeps its shape", vertex_dists(traj) == vertex_dists(traj_src),
          (vertex_dists(traj), vertex_dists(traj_src)))
        d0 = math.hypot(traj[0]["x"] - placed["x"], traj[0]["y"] - placed["y"])
        d0s = math.hypot(traj_src[0]["x"] - src["x"], traj_src[0]["y"] - src["y"])
        C("place: trajectory starts where it did relative to the actor", abs(d0 - d0s) < 0.3, (d0, d0s))
        ang = math.degrees(math.atan2(traj[-1]["y"] - traj[0]["y"], traj[-1]["x"] - traj[0]["x"])) - placed["yaw"]
        ang_s = math.degrees(math.atan2(traj_src[-1]["y"] - traj_src[0]["y"], traj_src[-1]["x"] - traj_src[0]["x"])) - src["yaw"]
        C("place: trajectory turns with the actor", abs(((ang - ang_s) + 180) % 360 - 180) < 2, (ang, ang_s))
        gz = page.evaluate("([x, y]) => ObjectsManager.groundZAt(x, y)", [traj[0]["x"], traj[0]["y"]])
        C("place: heights from the surface", abs(traj[0]["z"] - (gz + 0.5)) < 0.05, (traj[0]["z"], gz))
        pt = next(e for e in placed["events"] if e["id"] == "evt-9")["trigger"]
        C("place: $self resolved to the new actor", pt["entity_ref"] == placed["id"], pt)
        C("place: trigger point moved with the actor", abs(pt["point"]["x"] - (placed["x"] + (265.4 - src["x"]))) < 2.5, pt)

        page.evaluate("id => { AppState.npcs = AppState.npcs.filter(n => n.id === id); AppState.set({}); }", placed["id"])
        status = H.export_status(page, page.evaluate("ScenarioIO.buildParamsForTesting()"))
        C("place: exports", status == 200, status)

        # ── Picker on an existing actor ─────────────────────────────────────
        page.evaluate("id => AppState.select(id)", placed["id"])
        page.wait_for_selector(".event-template-select", timeout=5000)
        opts = page.evaluate("() => [...document.querySelectorAll('.event-template-select option')].map(o => o.value)")
        C("picker: offers the user template", "user:1" in opts, opts)

        # ── Foreign reference refused ───────────────────────────────────────
        page.evaluate("""() => {
          const a = { id: AppState.nextId(), type: 'car', x: 250, y: -2, z: 0.5, yaw: 180, initial_speed: 5,
                      events: [{ id: 'evt-1', trigger: { type: 'after_event', event_id: 'evt-1', actor_ref: '%s' },
                                 action: { type: 'set_speed', dynamics: { shape: 'step', dimension: 'time', value: 2 },
                                           target: { mode: 'absolute', value: 3 } } }] };
          AppState.npcs = [...AppState.npcs, a]; AppState.set({});
          return ScenarioTemplates.saveFromActor(a);
        }""" % placed["id"])
        n = len(page.evaluate("JSON.parse(localStorage.getItem('scenarioEditor.userTemplates'))"))
        C("foreign ref: refused, nothing stored", n == 1, n)
        C("foreign ref: toast says why", page.locator(".toast", has_text="anderen Akteur").count() >= 1)

        # ── Rename, reload, export, import, delete ──────────────────────────
        page.evaluate("AppState.select(null)")
        page.click('[data-overview-tab="templates"]')
        name = page.locator('[data-user-template="user:1"] .user-template-name')
        name.fill("Radler quer")
        name.press("Enter")
        name.evaluate("el => el.blur()")
        C("rename: stored", page.evaluate("JSON.parse(localStorage.getItem('scenarioEditor.userTemplates'))[0].label") == "Radler quer")
        page.reload(wait_until="networkidle")
        page.evaluate("document.getElementById('welcome-overlay')?.classList.add('hidden')")
        H.select_map(page, "Town01")
        C("reload: template still there", page.evaluate("ScenarioTemplates.label('user:1')") == "Radler quer")

        page.evaluate("AppState.select(null)")
        page.click('[data-overview-tab="templates"]')
        with page.expect_download(timeout=10000) as dl:
            page.click("[data-user-template-export]")
        data = json.loads(open(dl.value.path()).read())
        C("export: file holds the template", data.get("templates", [{}])[0].get("label") == "Radler quer", data)
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(data, f)
            path = f.name
        page.set_input_files("[data-user-template-import]", path)
        page.wait_for_timeout(300)
        os.unlink(path)
        C("import: added as a second template", page.locator("[data-user-template]").count() == 2)

        page.click('[data-user-template-del="user:2"]')
        page.wait_for_selector("#confirm-overlay:not(.hidden)", timeout=5000)
        page.keyboard.press("Enter")
        page.wait_for_timeout(250)
        C("delete: gone after confirm", page.locator("[data-user-template]").count() == 1
          and len(page.evaluate("JSON.parse(localStorage.getItem('scenarioEditor.userTemplates'))")) == 1)

        page.evaluate("localStorage.removeItem('scenarioEditor.userTemplates')")
        C("no JS errors", not [e for e in errors if "404" not in e], errors[:5])
        browser.close()
    sys.exit(C.report())


if __name__ == "__main__":
    main()
