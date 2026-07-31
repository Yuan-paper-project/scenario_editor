"""Static props regression suite: catalogue, placement, editing, save/load, export."""
import os
from playwright.sync_api import sync_playwright
import re as _re
import sys

BASE = os.environ.get("EDITOR_URL", "http://localhost:9090")
fails, checks = [], []

def check(name, cond, extra=""):
    checks.append((name, bool(cond), extra))
    if not cond:
        fails.append(f"{name} {extra}")

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1600, "height": 900}, accept_downloads=True)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append("console.error: " + m.text) if m.type == "error" else None)

    page.goto(BASE, wait_until="networkidle")
    page.evaluate("document.getElementById('welcome-overlay')?.classList.add('hidden')")

    check("no JS errors on load", not errors, str(errors[:3]))
    check("PropCatalog global exists", page.evaluate("!!window.PropCatalog"))
    check("16 props in catalogue", page.evaluate("PropCatalog.ids().length") == 16,
          str(page.evaluate("PropCatalog.ids().length")))
    gone = page.evaluate("""() => ['chainbarrier','streetsign','streetsign01','dirtdebris02']
        .filter(n => PropCatalog.get('static.prop.'+n) !== null)""")
    check("removed props absent from catalogue", gone == [], str(gone))
    check("Verkehrsfuehrung group removed",
          page.evaluate("PropCatalog.GROUPS.filter(g=>g.id==='control').length") == 0)
    check("dirtdebris01 kept", page.evaluate("!!PropCatalog.get('static.prop.dirtdebris01')"))

    # every prop declares a known facing rule
    bad = page.evaluate("""() => { const ok=['none','oncoming','along','alongside','toward-road'];
        return PropCatalog.ids().filter(i => !ok.includes(PropCatalog.facing(i))); }""")
    check("every prop has a valid facing rule", bad == [], str(bad))

    # ── Toolbar tabs ──────────────────────────────────────────────────────────
    n_tiles = page.evaluate(
        "document.querySelectorAll('[data-toolbar-panel=\"props\"] .tool-btn').length")
    check("16 prop tiles rendered", n_tiles == 16, f"got {n_tiles}")
    check("props panel hidden initially",
          page.locator('[data-toolbar-panel="props"]').is_hidden())
    page.click('[data-toolbar-tab="props"]')
    check("props panel visible after tab click",
          page.locator('[data-toolbar-panel="props"]').is_visible())
    check("actors panel hidden after tab click",
          page.locator('[data-toolbar-panel="actors"]').is_hidden())
    check("prop tiles have glyph svg",
          page.evaluate("!!document.querySelector('[data-toolbar-panel=\"props\"] .tool-btn svg')"))

    # ── Map ───────────────────────────────────────────────────────────────────
    page.select_option("#map-select", "Town01")
    page.wait_for_function("AppState.mapData !== null", timeout=60000)
    check("map loaded", page.evaluate("!!AppState.mapData"))
    check("layer-props exists", page.evaluate("!!document.getElementById('layer-props')"))
    check("toggle-props checkbox exists", page.evaluate("!!document.getElementById('toggle-props')"))

    box = page.locator("#map-svg").bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2

    page.click('[data-toolbar-tab="actors"]')
    page.click('.tool-btn[data-tool="ego"]')
    page.mouse.click(cx - 120, cy - 60)
    check("ego placed", page.evaluate("!!AppState.ego"))

    # ── Sticky prop placement ─────────────────────────────────────────────────
    page.click('[data-toolbar-tab="props"]')
    page.click('.tool-btn[data-prop="static.prop.trafficcone01"]')
    check("prop tool armed", page.evaluate("AppState.activeTool") == "prop")
    check("pendingProp set",
          page.evaluate("AppState.pendingProp") == "static.prop.trafficcone01")
    check("prop tile shows active",
          page.evaluate("document.querySelector('.tool-btn[data-prop=\"static.prop.trafficcone01\"]').classList.contains('active')"))

    for i in range(5):
        page.mouse.click(cx + i * 26, cy + i * 14)
    n = page.evaluate("AppState.staticObjects.length")
    check("5 cones placed (sticky)", n == 5, f"got {n}")
    check("tool still armed after placing", page.evaluate("AppState.activeTool") == "prop")
    check("prop placement does not steal selection",
          page.evaluate("AppState.selectedId === (AppState.ego && AppState.ego.id)"))
    check("5 prop groups in SVG",
          page.evaluate("document.querySelectorAll('#layer-props .prop-group').length") == 5)
    check("cone has no yaw arrow (not oriented)",
          page.evaluate("document.querySelectorAll('#layer-props .yaw-arrow').length") == 0)

    # ── Shift-click still snaps POSITION ──────────────────────────────────────
    page.keyboard.down("Shift")
    page.mouse.click(cx + 200, cy + 100)
    page.keyboard.up("Shift")
    snapped = page.evaluate("AppState.staticObjects[AppState.staticObjects.length-1]")
    free = page.evaluate(
        "(()=>{const w=MapView.svgToWorld({clientX:%d,clientY:%d});"
        "return {x:Math.round(w.x*10)/10,y:Math.round(w.y*10)/10};})()" % (cx + 200, cy + 100))
    moved = abs(snapped["x"] - free["x"]) > 0.05 or abs(snapped["y"] - free["y"]) > 0.05
    check("shift-click snapped to lane", moved,
          f"snapped={snapped['x']},{snapped['y']} free={free['x']},{free['y']}")

    page.keyboard.press("Escape")
    check("Escape disarms tool", page.evaluate("AppState.activeTool") is None)
    check("Escape clears pendingProp", page.evaluate("AppState.pendingProp") is None)

    page.click('.tool-btn[data-prop="static.prop.container"]')
    page.mouse.click(cx - 220, cy + 140)
    page.keyboard.press("Escape")
    check("container has yaw arrow (oriented)",
          page.evaluate("document.querySelectorAll('#layer-props .yaw-arrow').length") == 1)

    # ── Selection: picker and properties coexist ──────────────────────────────
    page.evaluate("AppState.select(AppState.staticObjects[0].id)")
    check("prop selected", page.evaluate("AppState.selectedId") is not None)
    check("PICKER STILL VISIBLE while prop selected",
          page.locator('[data-toolbar-panel="props"]').is_visible())
    check("properties panel visible", page.locator("#props-content").is_visible())
    check("prop-type row visible", page.locator("#prop-type-row").is_visible())
    check("NPC section hidden for prop", page.locator("#props-npc-section").is_hidden())
    check("title uses prop label",
          "KEGEL" in page.evaluate("document.getElementById('props-title').textContent").upper(),
          page.evaluate("document.getElementById('props-title').textContent"))

    page.fill("#prop-z", "0.1")
    page.dispatch_event("#prop-z", "change")
    z = page.evaluate("AppState.findById(AppState.selectedId).z")
    check("z=0.1 sticks (not forced to 0.2)", abs(z - 0.1) < 1e-9, f"got {z}")

    page.select_option("#prop-type-select", "static.prop.barrel")
    check("prop type swapped to barrel",
          page.evaluate("AppState.findById(AppState.selectedId).prop") == "static.prop.barrel")

    # ── Drag; map must not pan ────────────────────────────────────────────────
    tf_before = page.evaluate("document.getElementById('world').getAttribute('transform')")
    pid = page.evaluate("AppState.staticObjects[2].id")
    pos0 = page.evaluate(f"(()=>{{const o=AppState.findById('{pid}');return [o.x,o.y];}})()")
    org = page.evaluate(f"""(()=>{{
        const g = document.querySelector('#layer-props .prop-group[data-id="{pid}"]');
        const pt = document.getElementById('map-svg').createSVGPoint();
        pt.x = 0; pt.y = 0;
        const s = pt.matrixTransform(g.getScreenCTM());
        return [s.x, s.y];
    }})()""")
    check("prop origin is hit-testable",
          page.evaluate("([x,y])=>!!document.elementFromPoint(x,y)?.closest('.prop-group')", org))
    page.mouse.move(org[0], org[1]); page.mouse.down()
    page.mouse.move(org[0] + 60, org[1] + 40, steps=8); page.mouse.up()
    pos1 = page.evaluate(f"(()=>{{const o=AppState.findById('{pid}');return [o.x,o.y];}})()")
    check("prop moved by drag", pos0 != pos1, f"{pos0} -> {pos1}")
    check("MAP DID NOT PAN during prop drag",
          tf_before == page.evaluate("document.getElementById('world').getAttribute('transform')"))

    # ── Save / load round-trip ────────────────────────────────────────────────
    n_before = page.evaluate("AppState.staticObjects.length")
    saved = page.evaluate("JSON.stringify(AppState.toJSON())")
    page.evaluate(f"AppState.loadJSON({saved})")
    rt = page.evaluate("AppState.staticObjects")
    check("props survive save/load", len(rt) == n_before, f"{n_before} -> {len(rt)}")
    check("prop fields survive",
          all(("prop" in o and "yaw" in o and "z" in o) for o in rt), str(rt[:1]))

    existing = set(page.evaluate("AppState.staticObjects.map(o=>o.id)"))
    check("nextId does not collide after loadJSON",
          page.evaluate("AppState.nextId()") not in existing)
    check("toJSON survives null ego",
          page.evaluate("(()=>{try{AppState.ego=null;AppState.toJSON();return true;}"
                        "catch(e){return String(e);}})()") is True)

    # ── Export ────────────────────────────────────────────────────────────────
    page.evaluate("""() => {
        AppState.map = 'Town01';
        AppState.ego = {id:'obj-1',type:'ego',x:10,y:-20,z:0.2,yaw:0,trajectory:[],events:[]};
        AppState.npcs = [];
        AppState.staticObjects = [
          {id:'obj-2',type:'prop',prop:'static.prop.trafficcone01',x:12.3,y:-45.6,z:0,yaw:90},
          {id:'obj-3',type:'prop',prop:'static.prop.streetbarrier',x:15,y:-46,z:0,yaw:0},
        ];
    }""")
    with page.expect_download(timeout=30000) as dl:
        page.click("#btn-export")
    xml = open(dl.value.path()).read()

    check("export: 2 MiscObject entries", xml.count("<MiscObject") == 2, str(xml.count("<MiscObject")))
    check("export: cone is obstacle, not barrier",
          'miscObjectCategory="obstacle" mass="5.0" name="static.prop.trafficcone01"' in xml)
    check("export: streetbarrier keeps barrier category",
          'miscObjectCategory="barrier" mass="200.0" name="static.prop.streetbarrier"' in xml)
    check("export: prop0 teleport, yaw 90deg -> radians (cone, offset 0)",
          '<WorldPosition x="12.3" y="-45.6" z="0.0" h="1.570796" />' in xml)
    # streetbarrier carries a measured yaw_offset of +90: yaw 0 -> h = radians(90)
    check("export: mesh yaw_offset applied (barrier yaw 0 -> h=90deg)",
          '<WorldPosition x="15.0" y="-46.0" z="0.0" h="1.570796" />' in xml,
          "yaw_offset not reaching the exported h")
    privs = _re.findall(r'<Private entityRef="prop\d+">.*?</Private>', xml, _re.S)
    check("export: 2 prop Private blocks", len(privs) == 2, str(len(privs)))
    check("export: NO ControllerAction on props",
          all("ControllerAction" not in q for q in privs))
    story = _re.sub(r'<Init>.*?</Init>', '', xml, flags=_re.S)
    check("export: no prop in any ManeuverGroup",
          all(f'entityRef="prop{i}"' not in story for i in range(2)))

    def post_status(prop_id):
        return page.evaluate("""async (pid) => {
            const p = {schema_version:'1.0', map:'Town01', weather:{},
              ego:{type:'car',x:1,y:2,z:0.2,yaw:0}, npcs:[], trafficSignals:[],
              staticObjects:[{prop:pid,x:0,y:0,z:0,yaw:0}], route_waypoints:[]};
            const r = await fetch('/api/export', {method:'POST',
              headers:{'Content-Type':'application/json'}, body: JSON.stringify(p)});
            return r.status;
        }""", prop_id)

    check("export: removed prop id -> HTTP 400",
          post_status("static.prop.chainbarrier") == 400)
    check("export: unknown prop id -> HTTP 400",
          post_status("static.prop.nonexistent") == 400)

    unexpected = [e for e in errors if "400 (Bad Request)" not in e]
    check("no unexpected JS errors during whole run", not unexpected, str(unexpected[:3]))
    b.close()

print()
for name, ok, extra in checks:
    print(("  PASS  " if ok else "  FAIL  ") + name + (f"   [{extra}]" if extra and not ok else ""))
print(f"\n{sum(1 for _,o,_ in checks if o)}/{len(checks)} passed")
sys.exit(1 if fails else 0)
