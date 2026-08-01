"""Actor types: toolbar, placement, map rendering, and the entity they export.

Why this exists: an actor type is a bare string threaded through ~8 hand-kept
lookup tables across two repos, and EVERY one of them falls back silently rather
than raising. Miss `_VEHICLE_PARAMS` and the actor exports with car physics;
miss `vehicle_catalog.yaml` and it exports as a Lincoln MKZ; miss
`vehicle_category` and a firetruck claims `vehicleCategory="car"`. All three
produce a file that opens cleanly and looks right. Nothing but reading the
emitted XML catches them, which is what the EXPECTED table below does.

The table is written out literally rather than read back from the catalogue —
comparing the exporter against its own configuration would pass no matter what
either said.

    bash run.sh 9090            # terminal 1  (RESTART it if ../llm-scenario-gen
    .venv/bin/python3 tests/test_actor_types_e2e.py     changed — --reload does
                                                        not watch that repo)
"""
import os
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from playwright.sync_api import sync_playwright  # noqa: E402
import _harness as H  # noqa: E402

check = H.Checks()

# The complete actor palette, in toolbar order. `ego` is excluded: it is placed
# through a different branch of _placeActor and buildScenarioParams coerces its
# type to 'car', so it has nothing type-specific to assert here.
#
# elem      — 'Vehicle' or 'Pedestrian'; picks which XML element must appear
# category  — vehicleCategory / pedestrianCategory, the attribute that silently
#             degrades to "car" when vehicle_catalog.yaml's mapping is missing
# length/width — the exported BoundingBox, which must also equal ACTOR_SIZES
# max_speed — Performance/@maxSpeed, the tell-tale for a missing
#             _VEHICLE_PARAMS row (car's 69.444 leaks through)
EXPECTED = {
    "car": {
        "label": "Auto", "elem": "Vehicle", "category": "car",
        "blueprint": "vehicle.lincoln.mkz_2017",
        "length": 4.5, "width": 2.1, "max_speed": 69.444,
        "controller": "simple_vehicle_control", "routable": True,
    },
    "van": {
        "label": "Transporter", "elem": "Vehicle", "category": "van",
        "blueprint": "vehicle.mercedes.sprinter",
        "length": 5.8, "width": 2.2, "max_speed": 45.0,
        "controller": "simple_vehicle_control", "routable": True,
    },
    "truck": {
        "label": "LKW", "elem": "Vehicle", "category": "truck",
        "blueprint": "vehicle.carlamotors.carlacola",
        "length": 7.0, "width": 2.5, "max_speed": 30.0,
        "controller": "simple_vehicle_control", "routable": True,
    },
    "bus": {
        "label": "Bus", "elem": "Vehicle", "category": "bus",
        "blueprint": "vehicle.volkswagen.t2",
        "length": 10.0, "width": 2.5, "max_speed": 25.0,
        "controller": "simple_vehicle_control", "routable": True,
    },
    "motorcycle": {
        "label": "Moto", "elem": "Vehicle", "category": "motorbike",
        "blueprint": "vehicle.harley-davidson.low_rider",
        "length": 2.2, "width": 0.9, "max_speed": 55.0,
        "controller": "simple_vehicle_control", "routable": True,
    },
    "scooter": {
        "label": "Roller", "elem": "Vehicle", "category": "motorbike",
        "blueprint": "vehicle.vespa.zx125",
        "length": 1.7, "width": 0.8, "max_speed": 18.0,
        "controller": "simple_vehicle_control", "routable": True,
    },
    "police": {
        "label": "Polizei", "elem": "Vehicle", "category": "car",
        "blueprint": "vehicle.dodge.charger_police_2020",
        "length": 5.0, "width": 2.1, "max_speed": 75.0,
        "controller": "simple_vehicle_control", "routable": True,
    },
    "ambulance": {
        "label": "Rettung", "elem": "Vehicle", "category": "van",
        "blueprint": "vehicle.ford.ambulance",
        "length": 6.0, "width": 2.4, "max_speed": 40.0,
        "controller": "simple_vehicle_control", "routable": True,
    },
    "firetruck": {
        "label": "Feuerwehr", "elem": "Vehicle", "category": "truck",
        "blueprint": "vehicle.carlamotors.firetruck",
        "length": 8.5, "width": 2.8, "max_speed": 30.0,
        "controller": "simple_vehicle_control", "routable": True,
    },
    "pedestrian": {
        "label": "Fußgänger", "elem": "Pedestrian", "category": "pedestrian",
        "blueprint": "walker.pedestrian.0001",
        "length": 1.0, "width": 1.0, "max_speed": None,
        "controller": "pedestrian_control", "routable": False,
    },
    "child": {
        "label": "Kind", "elem": "Pedestrian", "category": "pedestrian",
        "blueprint": "walker.pedestrian.0011",
        "length": 0.6, "width": 0.6, "max_speed": None,
        "controller": "pedestrian_control", "routable": False,
    },
    "cyclist": {
        "label": "Radfahrer", "elem": "Vehicle", "category": "bicycle",
        "blueprint": "vehicle.diamondback.century",
        "length": 1.7, "width": 0.6, "max_speed": 10.0,
        "controller": "simple_vehicle_control", "routable": False,
    },
}

# mapView.js ACTOR_SIZES and xml_builder._VEHICLE_PARAMS are two independent
# hand-kept tables, and for every pre-existing type except `car` they disagree:
# truck 2.6 vs 2.5 wide, bus 9.0 vs 10.0 long, motorcycle 1.0 vs 0.9 wide,
# cyclist 2.0x0.8 vs 1.7x0.6. Grandfathered rather than fixed — changing them
# now would move existing scenarios' markers for no functional gain. Every type
# added after this suite must agree.
FOOTPRINT_DRIFT = {"truck", "bus", "motorcycle", "cyclist"}

# Types placed free-hand facing the nearest road rather than snapped to a spawn
# point (objects.js ROAD_FACING_TYPES). Asserted through yaw rather than
# position: Playwright clicks on integer pixels, which at map zoom is worth
# several decimetres, so "did it move" cannot separate a snap from rounding.
# Yaw can — a spawn-snapped actor inherits the lane's travel direction, while a
# road-facing one turns to look at the lane, roughly perpendicular to it.
ROAD_FACING = {"pedestrian", "child", "cyclist"}

# Emitted as <Pedestrian>. mapView.js WALKER_TYPES and xml_builder's
# _PEDESTRIAN_TYPES are two copies of this split; the marker-shape check and
# the element check below assert they agree.
WALKERS = {"pedestrian", "child"}

EGO = {"id": "obj-1", "type": "ego", "x": 300.631, "y": -2.025,
       "z": 0.2, "yaw": 180, "trajectory": [], "events": []}

# One spot per EXPECTED entry, in the same order. All on Town01 road 1, which
# runs east-west, and all on screen at the default zoom — assert_on_screen()
# refuses off-screen clicks because Playwright would silently clamp them to the
# viewport edge and place the actor somewhere else entirely.
#
# 22 m apart because _placeActor snaps to spawn points within 12 m and the
# firetruck is 8.5 m long; closer together and a placement click lands on the
# previous actor's marker, which selects instead of placing.
#
# Road-facing types sit on the y = -6 kerb, offset in x from the vehicle slots
# so the two rows cannot be confused for one another at this zoom.
SPOTS = [
    (285.0, -2.0), (263.0, -2.0), (241.0, -2.0), (219.0, -2.0),   # car..bus
    (197.0, -2.0), (175.0, -2.0), (153.0, -2.0), (131.0, -2.0),   # moto..
    (109.0, -2.0),                                                # ..firetruck
    (274.0, -6.0), (230.0, -6.0), (186.0, -6.0),                  # kerbside
]
assert len(SPOTS) >= len(EXPECTED), "add a spot per actor type"


def seed(page, npcs):
    """Load an ego plus `npcs` through AppState.loadJSON — the Load button's
    own entry point, so the state is built the way the app builds it."""
    page.evaluate("""(payload) => {
        AppState.loadJSON({
            map: 'Town01', weather: {}, time: 'daytime',
            ego: payload.ego, npcs: payload.npcs,
            staticObjects: [], trafficSignals: [],
        });
    }""", {"ego": EGO, "npcs": npcs})


def npc(idx, actor_type, events=None):
    x, y = SPOTS[idx % len(SPOTS)]
    return {"id": f"obj-{idx + 2}", "type": actor_type, "x": x, "y": y,
            "z": 0.2, "yaw": 180, "behaviors": ["constant_speed"],
            "trigger_distance": 400, "events": events or []}


def entity(xml_text, name):
    """The <Vehicle>/<Pedestrian> under ScenarioObject `name`, or None."""
    root = ET.fromstring(xml_text)
    for so in root.iter("ScenarioObject"):
        if so.get("name") != name:
            continue
        return so.find("Vehicle") if so.find("Vehicle") is not None \
            else so.find("Pedestrian")
    return None


def controller_of(xml_text, name):
    """The ScenarioRunner controller module assigned to `name` in Init."""
    root = ET.fromstring(xml_text)
    for private in root.iter("Private"):
        if private.get("entityRef") != name:
            continue
        for prop in private.iter("Property"):
            if prop.get("name") == "module":
                return prop.get("value")
    return None


with sync_playwright() as p:
    browser, page, errors = H.open_editor(p, "Town01")
    check("no JS errors on load", not errors, str(errors[:3]))

    # ── Toolbar ──────────────────────────────────────────────────────────────
    # A hardcoded count so a button silently dropped from index.html fails here
    # rather than showing up as a mysteriously absent entity much later.
    page.click('[data-toolbar-tab="actors"]')
    tools = page.evaluate(
        "[...document.querySelectorAll('[data-toolbar-panel=\"actors\"] "
        ".tool-btn')].map(b => b.dataset.tool)")
    check(f"{len(EXPECTED)} NPC actor tools plus ego and ruler",
          len(tools) == len(EXPECTED) + 2, str(tools))
    missing = [t for t in EXPECTED if t not in tools]
    check("every expected actor type has a toolbar button", missing == [],
          str(missing))

    for t, exp in EXPECTED.items():
        btn = page.locator(f'[data-toolbar-panel="actors"] .tool-btn[data-tool="{t}"]')
        check(f"{t}: toolbar button visible", btn.is_visible())
        check(f"{t}: toolbar button has a glyph",
              btn.locator("svg").count() == 1)
        check(f"{t}: German label is '{exp['label']}'",
              btn.locator("span").inner_text() == exp["label"],
              btn.locator("span").inner_text())

    # ── Placement and map rendering ──────────────────────────────────────────
    # ACTOR_COLORS and ACTOR_SIZES are module-local to mapView.js, so they are
    # probed through what they actually drive — the rendered marker — rather
    # than read directly.
    # Through the real tool button and a real map click, so this covers
    # toolbar.js delegation and objects.js _placeActor together.
    seed(page, [])
    for i, (t, exp) in enumerate(EXPECTED.items()):
        wx, wy = SPOTS[i % len(SPOTS)]
        # Vehicles snap to the nearest spawn point within 12 m (objects.js
        # _placeActor), which legitimately moves them; road-facing types do not.
        actor = H.place_actor(page, t, wx, wy,
                              tolerance=1.0 if t in ROAD_FACING else 12.5)
        check(f"{t}: placed actor carries its type", actor["type"] == t,
              str(actor["type"]))
        check(f"{t}: default behaviour is constant_speed",
              actor["behaviors"] == ["constant_speed"], str(actor.get("behaviors")))
        check(f"{t}: default trigger_distance is 400",
              actor["trigger_distance"] == 400, str(actor.get("trigger_distance")))

        # SPOTS put road-facing types 4 m south of a lane running east-west, so
        # facing the lane means yaw ~90 while inheriting the lane's direction
        # means yaw ~0 or ~180.
        yaw = actor["yaw"] % 360
        perpendicular = min(abs(yaw - 90), abs(yaw - 270)) < 25
        if t in ROAD_FACING:
            check(f"{t}: turns to face the road, not along it", perpendicular,
                  f"yaw {actor['yaw']}")
        else:
            check(f"{t}: takes the lane direction from its spawn point",
                  not perpendicular, f"yaw {actor['yaw']}")

        marker = page.evaluate(
            """(id) => {
                const g = document.querySelector(`#layer-actors [data-id="${id}"]`);
                if (!g) return null;
                const body = g.querySelector('.actor-body');
                return {tag: body && body.tagName.toLowerCase(),
                        fill: body && body.getAttribute('fill'),
                        w: body && body.getAttribute('width'),
                        h: body && body.getAttribute('height')};
            }""", actor["id"])
        check(f"{t}: renders a marker on the map", marker is not None)
        if marker:
            want_tag = "circle" if t in WALKERS else "rect"
            check(f"{t}: marker is a <{want_tag}>", marker["tag"] == want_tag,
                  str(marker["tag"]))
            check(f"{t}: marker has its own colour",
                  marker["fill"] not in (None, ""), str(marker["fill"]))
            if want_tag == "rect" and t not in FOOTPRINT_DRIFT:
                check(f"{t}: map footprint matches the exported bounding box",
                      abs(float(marker["w"]) - exp["length"]) < 0.01
                      and abs(float(marker["h"]) - exp["width"]) < 0.01,
                      f"map {marker['w']}x{marker['h']}, "
                      f"xosc {exp['length']}x{exp['width']}")

    # Distinct colours: two types sharing one fill makes them indistinguishable
    # on the map, which is the whole point of having separate types.
    fills = page.evaluate(
        """() => [...document.querySelectorAll('#layer-actors .actor-body')]
             .map(b => b.getAttribute('fill'))""")
    check("every placed actor has a distinct colour",
          len(set(fills)) == len(fills), str(fills))

    # ── Export: the entity each type actually emits ──────────────────────────
    seed(page, [npc(i, t) for i, t in enumerate(EXPECTED)])
    xml = H.export_xosc(page)
    names = H.entity_names(xml)
    check("every seeded NPC reaches the .xosc as an entity",
          len(names) == len(EXPECTED) + 1, str(names))

    for i, (t, exp) in enumerate(EXPECTED.items()):
        name = "adversary" if i == 0 else f"adversary{i}"
        el = entity(xml, name)
        if not check(f"{t}: exports an entity", el is not None):
            continue
        check(f"{t}: exports a <{exp['elem']}>", el.tag == exp["elem"], el.tag)
        model = el.get("name") if el.tag == "Vehicle" else el.get("model")
        check(f"{t}: resolves to {exp['blueprint']}",
              model == exp["blueprint"], str(model))
        cat = el.get("vehicleCategory") or el.get("pedestrianCategory")
        check(f"{t}: category is '{exp['category']}'", cat == exp["category"],
              str(cat))

        dims = el.find("BoundingBox/Dimensions")
        check(f"{t}: bounding box is {exp['length']}x{exp['width']}",
              dims is not None
              and H.approx(float(dims.get("length")), exp["length"], 1e-3)
              and H.approx(float(dims.get("width")), exp["width"], 1e-3),
              dims.attrib if dims is not None else "no BoundingBox")

        if exp["max_speed"] is not None:
            perf = el.find("Performance")
            check(f"{t}: maxSpeed is {exp['max_speed']}",
                  perf is not None
                  and H.approx(float(perf.get("maxSpeed")), exp["max_speed"], 1e-3),
                  perf.get("maxSpeed") if perf is not None else "no Performance")

        check(f"{t}: controller module is {exp['controller']}",
              controller_of(xml, name) == exp["controller"],
              str(controller_of(xml, name)))

    # ── assign_route reaches the file for every routable type ────────────────
    # event_builders._ROUTE_ACTION_TYPES gates this. A type left out of it has
    # its route event SILENTLY DROPPED, and anything chained after it keeps a
    # storyboardElementRef pointing at an <Event> that is no longer in the file
    # — the open defect test_events_e2e.py tracks as KNOWN. This is the check
    # that proves the new types are not walking into it.
    route_events = [
        {"id": "r1", "trigger": {"type": "simulation_time", "value": 0},
         "action": {"type": "assign_route", "route_strategy": "fastest",
                    "waypoints": [{"x": 265.0, "y": -2.0, "z": 0.2},
                                  {"x": 180.0, "y": -2.0, "z": 0.2}]}},
        {"id": "s1", "trigger": {"type": "after_event", "event_id": "r1"},
         "action": {"type": "set_speed",
                    "dynamics": {"shape": "step", "dimension": "time", "value": 5.0},
                    "target": {"mode": "absolute", "value": 9.0}}},
    ]
    for t, exp in EXPECTED.items():
        if not exp["routable"]:
            continue
        seed(page, [npc(0, t, route_events)])
        xml = H.export_xosc(page)
        acts = [e["action"]["kind"] for e in H.parse_events(xml, "adversary")]
        check(f"{t}: assign_route survives to the .xosc", "assign_route" in acts,
              str(acts))
        check(f"{t}: no dangling event references",
              H.dangling_event_refs(xml) == [], str(H.dangling_event_refs(xml)))

    # ── A walker first, a vehicle second ─────────────────────────────────────
    # _template_for picks the base .xosc from the FIRST npc's type, so a walker
    # in slot 0 is the only arrangement that exercises pedestrian.xosc. The two
    # templates differ in their criteria_* StopTriggers: car.xosc carries
    # OnSidewalkTest and friends, which are meaningless for a walker.
    seed(page, [npc(0, "child"), npc(1, "van")])
    xml = H.export_xosc(page)
    check("walker-first scenario still emits both entities",
          entity(xml, "adversary") is not None
          and entity(xml, "adversary1") is not None)
    check("walker-first: the child is a <Pedestrian>",
          entity(xml, "adversary").tag == "Pedestrian",
          entity(xml, "adversary").tag)
    check("walker-first: the van is still a <Vehicle>",
          entity(xml, "adversary1").tag == "Vehicle",
          entity(xml, "adversary1").tag)
    check("walker-first selects the pedestrian base template",
          "OnSidewalkTest" not in xml,
          "car.xosc criteria present — _template_for did not see the walker")

    seed(page, [npc(0, "van"), npc(1, "child")])
    xml = H.export_xosc(page)
    check("vehicle-first selects the car base template",
          "OnSidewalkTest" in xml, "expected car.xosc criteria")
    check("vehicle-first: the child is still a <Pedestrian>",
          entity(xml, "adversary1").tag == "Pedestrian",
          entity(xml, "adversary1").tag)

    # ── Save/load round-trip ─────────────────────────────────────────────────
    seed(page, [npc(i, t) for i, t in enumerate(EXPECTED)])
    types_back = page.evaluate(
        """() => { const j = AppState.toJSON();
                   AppState.loadJSON(j);
                   return AppState.npcs.map(n => n.type); }""")
    check("every actor type survives a save/load round-trip",
          types_back == list(EXPECTED), str(types_back))

    # ── Labels ───────────────────────────────────────────────────────────────
    labels = page.evaluate(
        "() => AppState.npcs.map(n => AppState.actorLabel(n))")
    check("each type gets its own label series",
          labels == [f"{t.upper()} 1" for t in EXPECTED], str(labels))

    # ── An unknown type is rejected, not silently exported as a car ──────────
    # The counterpart to the prop check in _normalize_static_objects. Asserted
    # through the API rather than the UI because no toolbar button can produce
    # a bad type — the risk is a hand-edited .json or a future code change.
    seed(page, [npc(0, "van")])
    params = H.export_params(page)
    check("a valid scenario exports", H.export_status(page, params) == 200)
    params["npcs"][0]["type"] = "pedestrain"
    check("a typo'd actor type is rejected with 400",
          H.export_status(page, params) == 400)

    unexpected = [e for e in errors if "400 (Bad Request)" not in e]
    check("no unexpected JS errors during the run", not unexpected,
          str(unexpected[:3]))
    browser.close()

sys.exit(check.report())
