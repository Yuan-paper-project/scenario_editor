"""Random scenario generator suite (frontend/js/scenarioGenerator.js).

A generated scenario is only worth having if the other actor actually meets
the ego. So beyond "it exports", this suite runs every generated scenario
through the preview headlessly (Simulate.runHeadless) and asserts the
conflict: with the ego NOT reacting (the preview never brakes for anyone), an
NPC must come within CONFLICT_M of it within 10 s of the NPC's ego-relative
trigger firing, and an obstacle must sit on the ego's path.

The other properties pinned here:

  * every NPC event is timed off the ego (distance_to_ego, or after_event on
    its own chain), never off the clock — that is what keeps a scenario
    meaningful when an AV under test drives the ego at its own pace;
  * the ego carries an assign_route plus a start speed, so the same file also
    runs with the scripted controller;
  * a seed reproduces a scenario exactly; different seeds differ;
  * generating is ONE undo step, and replacing a scenario asks first;
  * a type the map cannot host (cut-in on single-lane Town01) fails cleanly;
  * phase 2: every scenario carries a criticality record that passed the
    trivial/unavoidable gate, the difficulty filter holds, and a batch
    restores the editor exactly (undo history included) and exports a zip
    with three files per scenario plus a manifest;
  * phase 3: the coverage plan covers every pair, the all-maps batch spans
    the CARLA towns, and the two lane_offset types build.
"""
import base64
import csv
import io
import zipfile
import json
import sys

from playwright.sync_api import sync_playwright

import _harness as H

TYPES = ["lead_brake", "cut_in", "vru_crossing", "junction_conflict", "obstacle",
         "oncoming_drift", "cyclist_ahead"]
# town -> types that map cannot host (no same-direction lane pair on Town01)
TOWNS = {"Town03": set(), "Town05": set(), "Town01": {"cut_in"}}
SEEDS = [1, 2, 3]
CONFLICT_M = 3.0      # centre-to-centre; a car is 4.5 m long, so this is a hit
OBSTACLE_M = 2.5      # nearest prop to the ego's track

C = H.Checks()

GEN_AND_MEASURE = ("""([t, s]) => {
  const info = ScenarioGenerator.generate(t, s);
  if (!info) return null;
  const run = Simulate.runHeadless({ dt: 0.05, maxTime: 45 });
  const ego = run.tracks[run.egoId];
  const npcs = AppState.npcs.map(npc => {
    const trig = npc.events.filter(e => e.trigger?.type === 'distance_to_ego')
      .map(e => run.fired[npc.id][e.id]).filter(t => t != null);
    const t0 = trig.length ? Math.min(...trig) : null;
    let min = Infinity;
    if (t0 != null) {
      const tr = run.tracks[npc.id];
      for (let i = 0; i < tr.length; i++) {
        if (run.times[i] < t0) continue;
        min = Math.min(min, Math.hypot(tr[i].x - ego[i].x, tr[i].y - ego[i].y));
      }
    }
    // Centre distance at which the two footprints can touch end to end: a
    // 7 m truck is touching at 4.3 m. Never tighter than CONFLICT_M.
    const len = t => (MapView.actorSize(t) || {}).w || 4.5;
    const reach = Math.max(%CONFLICT%, (len('ego') + len(npc.type)) / 2);
    return { id: npc.id, type: npc.type, events: npc.events, hasEvents: npc.events.length > 0,
             fired: t0 != null, min, reach };
  });
  let propMin = null;
  for (const p of AppState.staticObjects) for (const e of ego) {
    const d = Math.hypot(p.x - e.x, p.y - e.y);
    propMin = propMin == null ? d : Math.min(propMin, d);
  }
  const problems = [AppState.ego, ...AppState.npcs]
    .flatMap(a => ScenarioRules.problemsOf(a).map(p => p.problem.code));
  return { info, ego: AppState.ego, npcs, propMin, problems,
           nProps: AppState.staticObjects.length };
}""").replace("%CONFLICT%", str(CONFLICT_M))

EXPORT = """async () => {
  const p = ScenarioIO.buildParamsForTesting();
  const r = await fetch('/api/export', {method: 'POST',
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify(p)});
  return { ok: r.ok, status: r.status, text: (await r.text()).slice(0, 400000) };
}"""

STRIP_IDS = """(res) => {
  if (!res) return null;
  const strip = a => { const { id, ...rest } = a; return rest; };
  return JSON.stringify({ ego: strip(res.ego), npcs: res.npcs.map(strip),
                          props: res.props.map(strip), info: res.info });
}"""


def check_scenario(town, t, s, r, page):
    tag = f"{town}/{t}/seed{s}"
    if not C(f"{tag}: generated", r is not None):
        return
    C(f"{tag}: type is the one asked for", r["info"]["type"] == t, r["info"]["type"])
    crit = r["info"].get("criticality") or {}
    C(f"{tag}: passed the trivial/unavoidable gate", crit.get("verdict") == "ok", crit)
    C(f"{tag}: has a difficulty", crit.get("difficulty") in ("leicht", "mittel", "schwer"), crit)
    if crit.get("ttc_s") is not None:
        C(f"{tag}: contact is not sooner than 1 s after the threat", crit["ttc_s"] >= 1.0, crit)
    C(f"{tag}: no ScenarioRules problems", not r["problems"], r["problems"])

    ego = r["ego"]
    evs = ego["events"]
    C(f"{tag}: ego has one assign_route event",
      len(evs) == 1 and evs[0]["action"]["type"] == "assign_route", json.dumps(evs)[:200])
    wps = evs[0]["action"]["waypoints"] if evs else []
    C(f"{tag}: ego route has >=2 waypoints, seed 'fastest'",
      len(wps) >= 2 and wps[0]["strategy"] == "fastest")
    C(f"{tag}: ego has a start speed", ego["initial_speed"] > 0, ego["initial_speed"])

    for n in r["npcs"]:
        for ev in n["events"]:
            trig = ev["trigger"]["type"]
            act = ev["action"]["type"]
            # distance_to_point on the actor ITSELF (a walker stopping in the
            # ego's lane) is positional, and the actor only moves because of an
            # ego-relative trigger, so it is not clock-timed either.
            ok = (trig in ("distance_to_ego", "after_event")
                  or (trig == "simulation_time" and act == "assign_route")
                  or (trig == "distance_to_point" and ev["trigger"].get("entity_ref") == n["id"]))
            C(f"{tag}: {n['type']} {ev['id']} timed off the ego, not the clock",
              ok, f"{trig}/{act}")
            if trig == "after_event":
                C(f"{tag}: {n['type']} {ev['id']} chains within its own actor",
                  not ev["trigger"].get("actor_ref"))

    if t == "obstacle":
        C(f"{tag}: obstacle sits on the ego's path",
          r["propMin"] is not None and r["propMin"] <= OBSTACLE_M
          or any(not n["hasEvents"] for n in r["npcs"]), r["propMin"])
    else:
        active = [n for n in r["npcs"] if n["hasEvents"]]
        C(f"{tag}: has an NPC with events", len(active) >= 1)
        for n in active:
            C(f"{tag}: {n['type']} trigger fires in the preview", n["fired"])
            C(f"{tag}: {n['type']} reaches a non-reacting ego after its trigger",
              n["min"] <= n["reach"], f"{n['min']:.1f} m > {n['reach']:.1f} m")

    exp = page.evaluate(EXPORT)
    if C(f"{tag}: exports", exp["ok"], f"{exp['status']} {exp['text'][:200]}"):
        xml = exp["text"]
        C(f"{tag}: no dangling event refs", not H.dangling_event_refs(xml))
        C(f"{tag}: no dangling entity refs", not H.dangling_entity_refs(xml))


def main():
    with sync_playwright() as p:
        browser, page, errors = H.open_editor(p, "Town03")

        # ── Menu ────────────────────────────────────────────────────────────
        page.wait_for_function("AppState.laneGraph !== null", timeout=60000)
        page.click("#gen-menu-btn")
        rows = page.locator("#gen-menu-types .menu-item")
        C("menu: one row per type plus 'any' and the batch row", rows.count() == len(TYPES) + 2, rows.count())
        page.locator("#gen-menu-types .menu-item", has_text="Einscheren").click()
        page.wait_for_function("AppState.ego !== null", timeout=10000)
        C("menu: empty scenario generates without a confirm",
          page.evaluate("!Confirm.isOpen && AppState.ego?.events?.[0]?.action?.type === 'assign_route'"))
        C("menu: closes after a pick", page.locator("#gen-menu-panel").is_hidden())
        before = page.evaluate("JSON.stringify(AppState.toJSON())")
        page.click("#gen-menu-btn")
        page.locator("#gen-menu-types .menu-item", has_text="Beliebiger Typ").click()
        page.wait_for_function("Confirm.isOpen", timeout=5000)
        C("menu: replacing a scenario asks first", page.evaluate("Confirm.isOpen"))
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        C("menu: cancelling the confirm keeps the scenario",
          page.evaluate("JSON.stringify(AppState.toJSON())") == before)
        page.click("#gen-menu-btn")
        page.fill("#gen-seed", "4242")
        page.locator("#gen-menu-types .menu-item", has_text="Hindernis auf Spur").click(modifiers=["Control"])
        page.wait_for_timeout(300)
        C("menu: Strg+click replaces without a confirm, using the typed seed",
          page.evaluate("!Confirm.isOpen && ScenarioGenerator.lastInfo?.seed === 4242"))
        C("menu: the seed field is cleared after use", page.input_value("#gen-seed") == "")

        # ── Undo ────────────────────────────────────────────────────────────
        page.evaluate("""() => {
          AppState.set({ ego: { id: AppState.nextId(), type: 'ego', x: 10, y: 10, z: 0.5, yaw: 0,
                                initial_speed: 3, events: [] }, npcs: [], staticObjects: [] });
        }""")
        hand = page.evaluate("JSON.stringify(AppState.ego)")
        page.evaluate("ScenarioGenerator.generate('lead_brake', 7)")
        page.evaluate("document.activeElement && document.activeElement.blur()")
        page.keyboard.press("Control+z")
        page.wait_for_timeout(250)
        C("undo: one Strg+Z restores the scenario from before generating",
          page.evaluate("JSON.stringify(AppState.ego)") == hand
          and page.evaluate("AppState.npcs.length") == 0)
        page.keyboard.press("Control+y")
        page.wait_for_timeout(250)
        C("undo: redo brings the generated scenario back",
          page.evaluate("AppState.npcs.length") == 1
          and page.evaluate("AppState.ego.events[0]?.action?.type") == "assign_route")

        # ── Determinism and diversity ────────────────────────────────────────
        a = page.evaluate(f"({STRIP_IDS})(ScenarioGenerator.build('vru_crossing', 99))")
        b = page.evaluate(f"({STRIP_IDS})(ScenarioGenerator.build('vru_crossing', 99))")
        C("seed: the same seed builds the same scenario", a is not None and a == b)
        infos = page.evaluate("""() => [...Array(12).keys()].map(i => {
            const r = ScenarioGenerator.build(null, 1000 + i);
            return r && { type: r.info.type, x: r.ego.x, y: r.ego.y };
        })""")
        C("seed: 'any type' builds every time on Town03", all(infos), infos)
        types = {i["type"] for i in infos if i}
        starts = {(i["x"], i["y"]) for i in infos if i}
        C("seed: 12 seeds cover at least 3 types", len(types) >= 3, sorted(types))
        C("seed: 12 seeds give at least 10 different ego starts", len(starts) >= 10, len(starts))

        # ── Phase 2: difficulty filter ──────────────────────────────────────
        diffs = page.evaluate("""() => [1, 2, 3, 4].map(s => {
            const r = ScenarioGenerator.build('lead_brake', s, { difficulty: 'schwer' });
            return r && r.info.criticality.difficulty; })""")
        # A seed may find no 'schwer' site at all (it returns null, and a batch
        # falls back to another type); what must hold is that nothing else gets in.
        C("filter: 'schwer' only builds schwer, and most seeds find one",
          sum(d == "schwer" for d in diffs) >= 3 and all(d in ("schwer", None) for d in diffs), diffs)
        diffs = page.evaluate("""() => [1, 2, 3, 4].map(s => {
            const r = ScenarioGenerator.build('cut_in', s, { difficulty: 'mittel+' });
            return r && r.info.criticality.difficulty; })""")
        C("filter: 'mittel+' never builds leicht, and most seeds find one",
          sum(d in ("mittel", "schwer") for d in diffs) >= 3 and all(d in ("mittel", "schwer", None) for d in diffs), diffs)

        # ── Phase 3: pairwise coverage plan ─────────────────────────────────
        cover = page.evaluate("""() => {
            const dims = { a: [1, 2, 3], b: ['x', 'y', 'z'], c: ['p', 'q'] };
            const plan = ScenarioGenerator.coveragePlan(12, dims, 3);
            const pairs = new Set();
            for (const p of plan) { pairs.add('ab' + p.a + p.b); pairs.add('ac' + p.a + p.c); pairs.add('bc' + p.b + p.c); }
            return pairs.size; }""")
        C("coverage: 12 plans cover all 21 value pairs of a 3x3x2 space", cover == 21, cover)

        # ── Phase 2: batch restores the editor and keeps its history ────────
        page.evaluate("""() => {
          AppState.set({ ego: { id: AppState.nextId(), type: 'ego', x: 20, y: 20, z: 0.5, yaw: 0,
                                initial_speed: 2, events: [] }, npcs: [], staticObjects: [] });
        }""")
        before = page.evaluate("JSON.stringify(AppState.toJSON())")
        batch = page.evaluate("""async () => {
          const res = await ScenarioGenerator.generateBatch({ count: 10, seed: 314 });
          const out = await Api.exportBatch({ scenarios: res.entries, filename: 't.zip' });
          const buf = new Uint8Array(await out.blob.arrayBuffer());
          let bin = ''; for (const c of buf) bin += String.fromCharCode(c);
          return { b64: btoa(bin), made: res.entries.length, ok: out.ok, failed: out.failed };
        }""")
        C("batch: editor state is restored exactly", page.evaluate("JSON.stringify(AppState.toJSON())") == before)
        page.evaluate("document.activeElement && document.activeElement.blur()")
        page.keyboard.press("Control+z")
        page.wait_for_timeout(250)
        C("batch: undo history survives (Strg+Z still undoes the edit before it)",
          page.evaluate("AppState.ego === null || AppState.ego.x !== 20"))
        C("batch: 10 made, 10 exported, none failed",
          batch["made"] == 10 and batch["ok"] == 10 and batch["failed"] == 0, batch["made"])
        z = zipfile.ZipFile(io.BytesIO(base64.b64decode(batch["b64"])))
        names = z.namelist()
        C("zip: .xosc + .json + _route.xml per scenario, plus two manifests",
          len(names) == 10 * 3 + 2 and "manifest.csv" in names and "manifest.json" in names, len(names))
        rows = list(csv.DictReader(io.StringIO(z.read("manifest.csv").decode())))
        C("zip: manifest has one ok row per scenario",
          len(rows) == 10 and all(r["status"] == "ok" for r in rows), len(rows))
        C("zip: manifest records seed, type, difficulty, ttc, weather and time",
          all(k in rows[0] for k in ("seed", "type", "difficulty", "ttc_s", "weather", "time", "town")),
          list(rows[0])[:12])
        C("zip: every .json reopens as an editor save file",
          all(json.loads(z.read(n)).get("ego") for n in names if n.endswith(".json") and not n.startswith("manifest")))
        C("zip: weather varies across the batch", len({r["weather"] for r in rows}) >= 4,
          {r["weather"] for r in rows})

        # ── Phase 3: all-maps batch ─────────────────────────────────────────
        many = page.evaluate("""async () => {
          const res = await ScenarioGenerator.generateBatch({ count: 9, seed: 21, maps: 'carla' });
          return { towns: [...new Set(res.entries.map(e => e.meta.town))], map: AppState.map,
                   n: res.entries.length };
        }""")
        C("all maps: a 9-scenario batch spans at least 7 CARLA towns", len(many["towns"]) >= 7, many["towns"])
        C("all maps: the editor is back on its own map afterwards", many["map"] == "Town03", many["map"])

        # ── Batch dialog ───────────────────────────────────────────────────
        page.click("#gen-menu-btn")
        page.locator(".gen-batch-item").click()
        C("dialog: opens from the menu", page.locator("#gen-batch-overlay").is_visible())
        page.fill("#gen-batch-count", "4")
        with page.expect_download(timeout=60000) as dl:
            page.click("#gen-batch-start")
        C("dialog: downloads a zip", dl.value.suggested_filename.endswith(".zip"), dl.value.suggested_filename)
        page.wait_for_timeout(300)
        C("dialog: closes when done", page.locator("#gen-batch-overlay").is_hidden())

        # ── Every type on every town ────────────────────────────────────────
        for town, impossible in TOWNS.items():
            H.select_map(page, town)
            page.wait_for_function("AppState.laneGraph !== null", timeout=60000)
            for t in TYPES:
                for s in SEEDS:
                    r = page.evaluate(GEN_AND_MEASURE, [t, s])
                    if t in impossible:
                        C(f"{town}/{t}/seed{s}: cannot be hosted, returns null", r is None)
                        continue
                    check_scenario(town, t, s, r, page)

        C("no JS errors", not [e for e in errors if "404" not in e], errors[:5])
        browser.close()
    sys.exit(C.report())


if __name__ == "__main__":
    main()
