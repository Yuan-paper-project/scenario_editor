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

# The ego carries one trivial event so every fixture here is exportable: an
# actor with no events gets no Act, and a scenario in which nothing at all has
# events is rejected before it is POSTed. Actor TYPES are the subject here, so
# the NPCs stay event-less on purpose — that is also the shape this suite is
# meant to exercise.
EGO = {"id": "obj-1", "type": "ego", "x": 300.631, "y": -2.025,
       "z": 0.2, "yaw": 180, "trajectory": [], "events": [H.MIN_EVENT]}

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
            "z": 0.2, "yaw": 180, "events": events or []}


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
        check(f"{t}: a placed actor carries no behaviors field",
              "behaviors" not in actor, str(sorted(actor.keys())))

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
                // Both layers: the SELECTED actor is drawn in layer-actors-top,
                // above its own path, and placement selects what it places.
                const g = document.querySelector(
                    `#layer-actors [data-id="${id}"], #layer-actors-top [data-id="${id}"]`);
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
        """() => [...document.querySelectorAll(
                 '#layer-actors .actor-body, #layer-actors-top .actor-body')]
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

    # ── Switching a placed actor's type ──────────────────────────────────────
    # A swap must change the type and NOTHING else, and it must renumber both
    # the type it left and the type it joined. Numbering is not stored — it is
    # derived from array position by actorLabel — so the swap works by moving
    # the actor to the end of AppState.npcs, exactly where _placeActor appends.

    # The groups are asserted against EXPECTED rather than read back from
    # ACTOR_TYPE_GROUPS alone: comparing the table to itself would pass however
    # wrong it is, and a type missing from it is placeable but never swappable.
    groups = page.evaluate(
        "(types) => Object.fromEntries(types.map(t => [t, AppState.switchGroupFor(t)]))",
        list(EXPECTED))
    check("every placeable type belongs to a switch group",
          all(groups.values()), str({t: g for t, g in groups.items() if not g}))
    check("vehicles and emergency vehicles share one group",
          {t for t, g in groups.items() if g == "vehicle"}
          == set(EXPECTED) - ROAD_FACING, str(groups))
    check("the VRU group is exactly the road-facing types",
          {t for t, g in groups.items() if g == "vru"} == ROAD_FACING, str(groups))
    check("ego and prop are in no group",
          page.evaluate("AppState.switchGroupFor('ego') === null "
                        "&& AppState.switchGroupFor('prop') === null"))

    # Cross-group swaps are refused in logic, not merely hidden in the UI: the
    # groups line up with ROAD_FACING_TYPES and _ROUTE_ACTION_TYPES, so crossing
    # one would strand an actor off-lane or silently drop its route event.
    check("a within-group swap is allowed",
          page.evaluate("AppState.canSwitchType('car', 'bus')"))
    check("a cross-group swap is refused",
          not page.evaluate("AppState.canSwitchType('car', 'pedestrian')"))
    check("a cross-group swap is refused in the other direction",
          not page.evaluate("AppState.canSwitchType('cyclist', 'truck')"))
    check("swapping a type for itself is a no-op",
          not page.evaluate("AppState.canSwitchType('car', 'car')"))
    check("ego cannot be swapped",
          not page.evaluate("AppState.canSwitchType('ego', 'car')"))
    check("an unknown type cannot be swapped",
          not page.evaluate("AppState.canSwitchType('car', 'pedestrain')"))

    # The renumbering case: car 1, car 2, bus 1 — switch car 1 to a bus and the
    # remaining car closes the gap while the swapped actor takes the NEXT bus
    # number rather than displacing the bus already there.
    seed(page, [npc(0, "car"), npc(1, "car"), npc(2, "bus")])
    before = page.evaluate(
        "() => AppState.npcs.map(n => AppState.actorLabel(n))")
    check("start state is CAR 1, CAR 2, BUS 1",
          before == ["CAR 1", "CAR 2", "BUS 1"], str(before))

    first_car = page.evaluate("AppState.npcs[0].id")
    original = page.evaluate("(id) => JSON.parse(JSON.stringify("
                             "AppState.findById(id)))", first_car)

    # Through the real select, so this covers the panel wiring and not just the
    # state helper underneath it.
    page.evaluate("(id) => AppState.select(id)", first_car)
    check("the type picker is visible for an NPC",
          page.locator("#actor-type-row").is_visible())
    options = page.evaluate(
        "[...document.querySelectorAll('#actor-type-select option')].map(o => o.value)")
    check("the picker offers only the actor's own group",
          set(options) == set(EXPECTED) - ROAD_FACING, str(options))
    check("the picker shows the actor's current type",
          page.evaluate("document.getElementById('actor-type-select').value") == "car")
    page.select_option("#actor-type-select", "bus")

    after = page.evaluate("() => AppState.npcs.map(n => AppState.actorLabel(n))")
    check("the swapped actor is now a bus",
          page.evaluate("(id) => AppState.findById(id).type", first_car) == "bus")
    check("the type it left closes its gap",
          page.evaluate("(id) => AppState.actorLabel(AppState.findById(id))",
                        page.evaluate("AppState.npcs.find(n => n.type === 'car').id"))
          == "CAR 1", str(after))
    check("the swapped actor takes the NEXT number in its new type",
          page.evaluate("(id) => AppState.actorLabel(AppState.findById(id))",
                        first_car) == "BUS 2", str(after))
    check("the bus already placed keeps BUS 1",
          "BUS 1" in after and after.count("BUS 1") == 1, str(after))
    check("both type groups are contiguous after the swap",
          sorted(after) == ["BUS 1", "BUS 2", "CAR 1"], str(after))

    swapped = page.evaluate("(id) => JSON.parse(JSON.stringify("
                            "AppState.findById(id)))", first_car)
    changed = [k for k in original
               if k != "type" and original[k] != swapped.get(k)]
    check("the swap changes the type and nothing else", changed == [],
          f"also changed: {changed}")
    check("the id is unchanged", swapped["id"] == original["id"])

    # Everything the marker derives from type must follow it; renderAllActors
    # rebuilds from scratch, so a stale marker means the redraw never ran.
    marker = page.evaluate(
        """(id) => {
            const b = document.querySelector(
                `#layer-actors [data-id="${id}"] .actor-body,`
                + ` #layer-actors-top [data-id="${id}"] .actor-body`);
            return b && {w: b.getAttribute('width'), fill: b.getAttribute('fill')};
        }""", first_car)
    check("the map marker redraws at the new type's footprint",
          marker is not None and abs(float(marker["w"]) - 9.0) < 0.01,
          str(marker))   # ACTOR_SIZES bus, which FOOTPRINT_DRIFT exempts from
                         # matching the exported 10.0 bounding box

    # An event chain must survive intact — the reason to swap in place at all.
    seed(page, [npc(0, "car", route_events), npc(1, "truck")])
    target = page.evaluate("AppState.npcs[0].id")
    page.evaluate("(id) => AppState.select(id)", target)
    page.select_option("#actor-type-select", "firetruck")
    events_after = page.evaluate("(id) => AppState.findById(id).events", target)
    check("events survive a swap untouched", events_after == route_events,
          str(events_after))

    xml = H.export_xosc(page)
    # The swap moved it to the end of npcs, so it is adversary1 now, not
    # adversary — the entity refs are positional.
    el = entity(xml, "adversary1")
    check("the swapped actor exports as its new type",
          el is not None and el.get("name") == EXPECTED["firetruck"]["blueprint"],
          el.get("name") if el is not None else "no entity")
    acts = [e["action"]["kind"] for e in H.parse_events(xml, "adversary1")]
    check("its route event still reaches the .xosc", "assign_route" in acts, str(acts))
    check("no dangling event references after a swap",
          H.dangling_event_refs(xml) == [], str(H.dangling_event_refs(xml)))

    # A cross-group swap forced past the UI leaves the actor untouched.
    seed(page, [npc(0, "car")])
    forced = page.evaluate(
        """() => {
            const id = AppState.npcs[0].id;
            const ok = AppState.switchActorType(id, 'pedestrian');
            return {ok, type: AppState.findById(id).type};
        }""")
    check("switchActorType refuses a cross-group swap",
          forced["ok"] is False and forced["type"] == "car", str(forced))

    # Ego and props expose no picker at all.
    page.evaluate("AppState.select(AppState.ego.id)")
    check("ego exposes no type picker",
          page.locator("#actor-type-row").is_hidden())
    page.evaluate("""() => {
        AppState.staticObjects = [{id: 'prop-1', type: 'prop',
            prop: 'static.prop.constructioncone', x: 285, y: -6, z: 0, yaw: 0}];
        AppState.select('prop-1');
    }""")
    check("a prop exposes no actor type picker",
          page.locator("#actor-type-row").is_hidden())
    check("a prop still exposes its own blueprint picker",
          page.locator("#prop-type-row").is_visible())

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
