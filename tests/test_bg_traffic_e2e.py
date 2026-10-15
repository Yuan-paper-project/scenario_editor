"""Hintergrundverkehr suite: background traffic (bgTraffic.js, backend/bg_traffic.py).

* off by default: the export is the plain .xosc, the map has no cars;
* switched on in the Umgebung menu (Umkreis 80 m by default), it is a bubble
  that moves with the ego: on average `count` cars around it, no frame shown
  farther than the radius + 20 m from where the preview has the ego, and a
  car that appears mid-run drives in at the bubble's edge;
* Umkreis 0 is the whole map: `count` cars, each for the whole window;
* KEEP-OUT, in space and time: no car ever comes within `clearance` (body
  edge to body edge) of where the preview has the ego or an NPC within 8 s
  of that moment, nor of a prop — and cars do use the scenario's roads at
  other times (that is what keeps the bubble full);
* deterministic for the same settings and scenario; a new seed or a moved
  actor regenerates it;
* the preview draws every car exactly at the file's pose, and Stop removes
  them;
* the export is a zip of the .xosc and the very traffic the preview showed;
* saved with the scenario; a file from before the feature loads with it off.
"""

import io
import json
import sys
import zipfile

from playwright.sync_api import sync_playwright

import _harness as H

C = H.Checks()

WAIT_DATA = "BgTraffic.data && !BgTraffic.busy && BgTraffic.data.town === AppState.map"

# Minimum edge-to-edge gap between every background car and every point the
# preview's scripted actors pass through within KEEPOUT_TIME_S (8 s) of the
# car being there (`worst`), and every prop; `spatial` is the same ignoring
# time — under the clearance when a car uses a scenario road at another time.
KEEPOUT_JS = """() => {
  const d = BgTraffic.data, s = AppState.bgTraffic, WINDOW = 8;
  const run = Simulate.runHeadless({ dt: 0.1, maxTime: 60, props: AppState.staticObjects || [],
                                    reactiveEgo: AppState.ego.obey_obstacles !== false });
  const pts = [];
  for (const a of [AppState.ego, ...AppState.npcs].filter(Boolean)) {
    const sz = MapView.actorSize(a.type), w = (sz.h || sz.w) / 2;
    pts.push([a.x, a.y, w, 0]);
    (run.tracks[a.id] || []).forEach((p, i) => pts.push([p.x, p.y, w, run.times[i]]));
  }
  for (const o of AppState.staticObjects || []) {
    const ps = PropCatalog.planSize(o.prop);
    pts.push([o.x, o.y, Math.max(ps.len, ps.wid) / 2, null]);
  }
  let worst = Infinity, at = null, spatial = Infinity;
  for (const v of d.vehicles) {
    const hw = v.width / 2, t0 = v.t0 || 0;
    for (let i = 0; i < v.frames.length; i += 2) {
      const f = v.frames[i], t = t0 + i * d.dt;
      for (const p of pts) {
        const gap = Math.hypot(f[0] - p[0], f[1] - p[1]) - p[2] - hw;
        if (gap < spatial) spatial = gap;
        if (p[3] !== null && Math.abs(t - p[3]) > WINDOW) continue;
        if (gap < worst) { worst = gap; at = [v.id, t]; }
      }
    }
  }
  return { worst, at, spatial, clearance: s.clearance, points: pts.length };
}"""


# The bubble, measured against where the preview has the ego at each moment:
# the farthest any shown frame is from it, the nearest a car appears to it
# (entries with t0 > 0), the average number shown, and the window bounds.
BUBBLE_JS = """() => {
  const d = BgTraffic.data, R = d.focus_radius, dt = d.dt;
  const run = Simulate.runHeadless({ dt: 0.1, maxTime: 60, props: AppState.staticObjects || [],
                                    reactiveEgo: AppState.ego.obey_obstacles !== false });
  const ego = AppState.ego, tr = run.tracks[ego.id] || [];
  const egoAt = t => {           // run.times[i] = 0.1 (i + 1); held at both ends
    if (t < 0.1 || !tr.length) return t < 0.1 ? { x: ego.x, y: ego.y } : tr[tr.length - 1];
    const f = t / 0.1 - 1, i = Math.floor(f);
    if (i >= tr.length - 1) return tr[tr.length - 1];
    const a = tr[i], b = tr[i + 1], w = f - i;
    return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
  };
  let farthest = 0, nearestAppear = Infinity, shown = 0, outOfWindow = 0;
  for (const v of d.vehicles) {
    const t0 = v.t0 || 0;
    if (t0 < -1e-6 || t0 + (v.frames.length - 1) * dt > d.duration + 1e-6) outOfWindow++;
    v.frames.forEach((f, i) => {
      const e = egoAt(t0 + i * dt);
      farthest = Math.max(farthest, Math.hypot(f[0] - e.x, f[1] - e.y));
    });
    if (t0 > 0) {
      const e = egoAt(t0);
      nearestAppear = Math.min(nearestAppear, Math.hypot(v.frames[0][0] - e.x, v.frames[0][1] - e.y));
    }
    shown += v.frames.length;
  }
  return { R, farthest, nearestAppear, avg: shown / d.frames, entries: d.vehicles.length,
           outOfWindow, statsAvg: d.stats.visible_avg };
}"""


def main():
    with sync_playwright() as pw:
        browser, page, errors = H.open_editor(pw, "Town03")
        page.wait_for_function("AppState.laneGraph !== null", timeout=60000)
        page.evaluate("ScenarioGenerator.generate('lead_brake', 5)")
        page.wait_for_timeout(400)

        # ── off by default ────────────────────────────────────────────────
        C("default: off", page.evaluate("AppState.bgTraffic.enabled") is False and not page.is_checked("#bg-enabled"))
        page.click("#env-menu-btn")
        C("default: status says Aus", page.inner_text("#bg-status").strip() == "Aus")
        page.keyboard.press("Escape")
        params = H.export_params(page)
        C("default: export is the plain .xosc request", isinstance(params, dict) and params.get("map") == "Town03")
        page.click("#sim-play")
        page.wait_for_timeout(500)
        C("default: preview draws no background cars", page.locator("#layer-bg-traffic .bg-car-group").count() == 0)
        page.click("#sim-stop")
        page.wait_for_timeout(300)

        # ── on, through the menu ──────────────────────────────────────────
        page.click("#env-menu-btn")
        page.check("#bg-enabled")
        page.fill("#bg-count", "30")
        page.dispatch_event("#bg-count", "change")
        page.wait_for_function(WAIT_DATA, timeout=60000)
        d = page.evaluate("({req: BgTraffic.data.requested, key: BgTraffic.data.key})")
        status = page.inner_text("#bg-status")
        C("on: the Umkreis field shows the 80 m default", page.input_value("#bg-radius") == "80")
        bub = page.evaluate(BUBBLE_JS)
        # Town03's lead_brake is the tightest case measured (two actors on one
        # lane through a dense grid): ~11 of 30 fit.
        C(
            "bubble: on average up to 30 cars around the ego, and more than a handful",
            d["req"] == 30 and 8 <= bub["avg"] <= 34.5,
            bub,
        )
        C("bubble: the stats' average is what the file shows", abs(bub["avg"] - bub["statsAvg"]) < 0.3, bub)
        C("bubble: the status says so", "im Umkreis von 80 m" in status and "Ø" in status, status)
        C("bubble: no car shown farther than radius + 20 m from the ego", bub["farthest"] <= 100.5, bub)
        C(
            "bubble: a car appearing mid-run drives in at the bubble's edge, not beside the ego",
            bub["nearestAppear"] >= 70,
            bub,
        )
        C("bubble: every entry lies inside the window", bub["outOfWindow"] == 0, bub)
        page.keyboard.press("Escape")

        # ── keep-out ──────────────────────────────────────────────────────
        k = page.evaluate(KEEPOUT_JS)
        C(
            "keep-out: no car within the clearance of a scripted actor within 8 s, nor of a prop",
            k["worst"] >= k["clearance"] - 0.15,
            k,
        )
        C(
            "keep-out: is timed — cars use the scenario's roads when its actors are elsewhere",
            k["spatial"] < k["clearance"],
            k,
        )

        # ── Umkreis 0: the whole map, the whole window ──────────────────────
        page.click("#env-menu-btn")
        page.fill("#bg-radius", "0")
        page.dispatch_event("#bg-radius", "change")
        page.wait_for_function(f"{WAIT_DATA} && BgTraffic.data.focus_radius === 0", timeout=60000)
        w = page.evaluate(
            "({n: BgTraffic.data.vehicles.length, frames: BgTraffic.data.frames,"
            " ok: BgTraffic.data.vehicles.every(v => !v.t0 && v.frames.length === BgTraffic.data.frames)})"
        )
        C("whole map: 30 cars, each for the whole window", w["n"] == 30 and w["ok"], w)
        C(
            "whole map: the status counts cars",
            "30 Fahrzeuge" in page.inner_text("#bg-status") and "Umkreis" not in page.inner_text("#bg-status"),
            page.inner_text("#bg-status"),
        )
        k = page.evaluate(KEEPOUT_JS)
        C("whole map: keeps clear of the scenario too", k["worst"] >= k["clearance"] - 0.15, k)
        page.fill("#bg-radius", "80")
        page.dispatch_event("#bg-radius", "change")
        page.wait_for_function(f"{WAIT_DATA} && BgTraffic.data.key === '{d['key']}'", timeout=60000)
        page.keyboard.press("Escape")

        # ── deterministic; seed and edits regenerate ──────────────────────
        key0 = d["key"]
        page.evaluate("AppState.bgTraffic = { ...AppState.bgTraffic, seed: 2 }; BgTraffic.ensure()")
        page.wait_for_function(f"{WAIT_DATA} && BgTraffic.data.key !== '{key0}'", timeout=60000)
        key2 = page.evaluate("BgTraffic.data.key")
        C("seed: a new seed is new traffic", key2 != key0)
        page.evaluate("AppState.bgTraffic = { ...AppState.bgTraffic, seed: 1 }; BgTraffic.ensure()")
        page.wait_for_function(f"{WAIT_DATA} && BgTraffic.data.key === '{key0}'", timeout=60000)
        C("seed: back to seed 1 is the same traffic as before", page.evaluate("BgTraffic.data.key") == key0)

        npc = page.evaluate("AppState.npcs[0].id")
        page.evaluate(
            "id => { const a = AppState.npcs.find(n => n.id === id); AppState.updateById(id, { x: a.x + 0.8 }); }", npc
        )
        page.wait_for_function(f"{WAIT_DATA} && BgTraffic.data.key !== '{key0}'", timeout=60000)
        C("edit: moving an NPC regenerates the traffic", page.evaluate("BgTraffic.data.key") != key0)
        k = page.evaluate(KEEPOUT_JS)
        C("edit: the new traffic keeps clear of the moved scenario", k["worst"] >= k["clearance"] - 0.15, k)
        page.keyboard.press("Control+z")
        page.wait_for_function(f"{WAIT_DATA} && BgTraffic.data.key === '{key0}'", timeout=60000)
        C("edit: undo brings the original traffic back (cache)", page.evaluate("BgTraffic.data.key") == key0)

        # ── preview ───────────────────────────────────────────────────────
        page.click("#sim-play")
        page.wait_for_timeout(600)
        page.evaluate("Simulate.seek(7.3)")
        page.wait_for_timeout(200)
        drawn = page.evaluate("""() => {
          const els = [...document.querySelectorAll('#layer-bg-traffic .bg-car-group')];
          const d = BgTraffic.data, t = Simulate.time;
          let worst = 0, shown = 0, alive = 0, wrong = 0;
          els.forEach((g, i) => {
            const p = BgTraffic.poseAt(d.vehicles[i], t, d.dt);
            const visible = g.style.display !== 'none';
            if (p) alive++;
            if (!!p !== visible) { wrong++; return; }
            if (!p) return;
            shown++;
            const m = /translate\\(([-\\d.]+),([-\\d.]+)\\) rotate\\(([-\\d.]+)\\)/.exec(g.getAttribute('transform'));
            worst = Math.max(worst, Math.hypot(+m[1] - p[0], +m[2] - p[1]));
          });
          return { n: els.length, entries: d.vehicles.length, shown, alive, wrong, worst, t };
        }""")
        C(
            "preview: exactly the entries alive at that moment are drawn",
            drawn["n"] == drawn["entries"] and drawn["wrong"] == 0 and drawn["shown"] > 0,
            drawn,
        )
        C("preview: drawn exactly where the file puts it", drawn["worst"] < 0.02, drawn)
        visible = "[...document.querySelectorAll('#layer-bg-traffic .bg-car-group')].filter(g => g.style.display !== 'none').map(g => g.getAttribute('transform')).join('|')"
        t1 = page.evaluate(visible)
        page.evaluate("Simulate.seek(12.0)")
        page.wait_for_timeout(200)
        t2 = page.evaluate(visible)
        C("preview: cars move with the timeline", t1 != t2)
        C(
            "preview: cars are not hit-tested",
            page.evaluate("getComputedStyle(document.getElementById('layer-bg-traffic')).pointerEvents") == "none",
        )
        page.click("#sim-stop")
        page.wait_for_timeout(300)
        C("stop: cars removed", page.locator("#layer-bg-traffic .bg-car-group").count() == 0)

        # ── export bundle ─────────────────────────────────────────────────
        page.evaluate("document.getElementById('toast-container')?.replaceChildren()")
        with page.expect_download(timeout=60000) as dl:
            page.click("#btn-export")
        blob = open(dl.value.path(), "rb").read()
        try:
            z = zipfile.ZipFile(io.BytesIO(blob))
            names = z.namelist()
        except zipfile.BadZipFile:
            names = []
        C(
            "export: a zip of .xosc + .bgtraffic.json",
            dl.value.suggested_filename == "Town03_scenario.zip"
            and sorted(names) == ["Town03_scenario.bgtraffic.json", "Town03_scenario.xosc"],
            names,
        )
        if names:
            bg = json.loads(z.read("Town03_scenario.bgtraffic.json"))
            xosc = z.read("Town03_scenario.xosc").decode()
            C("export: the traffic is the one the preview showed", bg["key"] == key0)
            C(
                "export: the .xosc is a normal scenario (no background actors in it)",
                "<ScenarioObject name=\"hero\"" in xosc and "background" not in xosc,
            )

        # ── save / load ───────────────────────────────────────────────────
        saved = page.evaluate("AppState.toJSON()")
        C(
            "save: settings in the save file",
            saved.get("bgTraffic", {}).get("enabled") is True
            and saved["bgTraffic"]["count"] == 30
            and saved["bgTraffic"].get("radius") == 80,
        )
        old = dict(saved)
        old.pop("bgTraffic")
        page.evaluate("data => { AppState.loadJSON(data); }", old)
        page.wait_for_timeout(300)
        C(
            "load: a file without the setting loads with traffic off",
            page.evaluate("AppState.bgTraffic.enabled") is False and not page.is_checked("#bg-enabled"),
        )
        page.evaluate("data => { AppState.loadJSON(data); }", saved)
        page.wait_for_timeout(300)
        C(
            "load: a file with it on switches the menu on",
            page.is_checked("#bg-enabled") and page.input_value("#bg-count") == "30",
        )

        # ── a town too small for the request ──────────────────────────────
        page.evaluate(
            "AppState.bgTraffic = { ...AppState.bgTraffic, count: 200, clearance: 6, radius: 0 }; BgTraffic.ensure()"
        )
        page.wait_for_function(f"{WAIT_DATA} && BgTraffic.data.requested === 200", timeout=120000)
        n = page.evaluate("BgTraffic.data.vehicles.length")
        status = page.inner_text("#bg-status")
        C("shortfall: the status says how many fit", n == 200 or f"{n} von 200" in status, (n, status))

        C("no JS errors", not [e for e in errors if "404" not in e], errors[:5])
        browser.close()
    sys.exit(C.report())


if __name__ == "__main__":
    main()
