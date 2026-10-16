"""Record or compare the computed style of every element across a set of editor states.

For CSS changes that must not change what is drawn (moving rules, lint fixes):
dump before, dump after, diff. Needs a running editor (EDITOR_URL, default
http://localhost:9091 — use a server without --reload) and the .venv's Playwright.

    .venv/bin/python3 tools/css_fingerprint.py dump before.json
    .venv/bin/python3 tools/css_fingerprint.py dump after.json
    .venv/bin/python3 tools/css_fingerprint.py diff before.json after.json

Elements are keyed by document position under <body>, so a change to the page's
markup shows up as "element sets differ" rather than as style differences.
"""

import json
import os
import sys

BASE = os.environ.get("EDITOR_URL", "http://localhost:9091")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXAMPLE = os.path.join(REPO, "example", "Town01_scenario2.json")
MENUS = ["#file-menu-btn", "#gen-menu-btn", "#env-menu-btn", "#layer-menu-btn", "#help-menu-btn"]

DUMP_JS = r"""
() => {
  // Thousands of elements share a handful of styles (every lane polygon looks
  // alike), so each distinct style is stored once and elements point at it.
  const index = new Map();
  const styles = [];
  const elements = {};
  const els = [document.documentElement, document.body, ...document.body.querySelectorAll('*')];
  const cls = (el) => {
    const c = typeof el.className === 'string' ? el.className : el.className?.baseVal || '';
    return c.trim() ? '.' + c.trim().split(/\s+/).join('.') : '';
  };
  els.forEach((el, i) => {
    const key = i + ':' + el.tagName + (el.id ? '#' + el.id : '') + cls(el);
    for (const pseudo of [null, '::before', '::after']) {
      const cs = getComputedStyle(el, pseudo);
      if (pseudo && (cs.content === 'none' || cs.content === 'normal')) continue;
      const parts = [];
      for (let k = 0; k < cs.length; k++) parts.push(cs[k] + '\u0001' + cs.getPropertyValue(cs[k]));
      // Custom properties enumerate in no fixed order.
      const style = parts.sort().join('\u0002');
      if (!index.has(style)) {
        index.set(style, styles.length);
        styles.push(style);
      }
      elements[key + (pseudo || '')] = index.get(style);
    }
  });
  return JSON.stringify({ styles, elements });
}
"""


def _walk_states(page, dump):
    """Drive the editor through the recorded states, calling dump(name) in each."""
    dump("welcome")
    page.evaluate("document.getElementById('welcome-overlay')?.classList.add('hidden')")
    dump("empty")

    page.select_option("#map-select", "Town03")
    page.wait_for_function("AppState.mapData !== null", timeout=60000)
    dump("town03")
    page.click('[data-toolbar-tab="props"]')
    dump("props-tab")

    page.set_input_files("#btn-load-input", EXAMPLE)
    page.wait_for_function("AppState.npcs.length === 3 && AppState.mapData", timeout=60000)
    page.wait_for_timeout(500)
    dump("example-overview")
    page.evaluate("AppState.select(AppState.npcs[0].id)")
    dump("npc-selected")
    page.evaluate("AppState.select(AppState.ego.id)")
    dump("ego-selected")
    page.evaluate("AppState.select(null)")

    for btn in MENUS:
        page.click(btn)
        dump("menu" + btn)
        page.keyboard.press("Escape")

    page.keyboard.press("?")
    dump("shortcuts")
    page.keyboard.press("Escape")

    page.click("#gen-menu-btn")
    page.get_by_text("Mehrere generieren").click()
    dump("batch")
    page.keyboard.press("Escape")

    page.click("#sim-play")
    page.wait_for_timeout(800)
    page.keyboard.press(" ")
    page.click("#sim-lanes-toggle")
    page.wait_for_timeout(500)
    page.evaluate("Simulate.seek(2)")
    dump("preview")
    page.keyboard.press("Escape")

    page.set_viewport_size({"width": 1100, "height": 800})
    dump("narrow")


def dump_states(out_path):
    """Write {state: {styles: [...], elements: {key: style index}}} to out_path."""
    from playwright.sync_api import sync_playwright  # noqa: PLC0415 — diff needs no browser

    result = {}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1600, "height": 900})
        page.add_init_script("try { localStorage.clear(); } catch (e) {}")
        page.goto(BASE, wait_until="networkidle")
        # Animations would be caught at a different frame on each run.
        page.add_style_tag(content="*,*::before,*::after{animation:none!important;transition:none!important}")

        def dump(name):
            page.wait_for_timeout(150)
            # One string: Playwright serializes a nested object of this size very slowly.
            result[name] = json.loads(page.evaluate(DUMP_JS))

        _walk_states(page, dump)
        browser.close()
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh)
    n_el = sum(len(v["elements"]) for v in result.values())
    n_st = sum(len(v["styles"]) for v in result.values())
    print(f"{len(result)} states, {n_el} elements, {n_st} distinct styles → {out_path}")


def _load(path):
    """Read a dump as {state: {element: {property: value}}}, built lazily per style."""
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    out = {}
    for state, data in raw.items():
        parsed = [dict(p.split("\u0001", 1) for p in s.split("\u0002")) for s in data["styles"]]
        out[state] = {key: parsed[idx] for key, idx in data["elements"].items()}
    return out


def diff_states(path_a, path_b, show=5):
    """Print what differs between two dumps; return the number of differences."""
    a, b = _load(path_a), _load(path_b)
    total = 0
    for state, elems in a.items():
        other = b.get(state)
        if other is None:
            print(f"{state}: missing in {path_b}")
            total += 1
            continue
        if set(elems) != set(other):
            print(f"{state}: element sets differ ({len(set(elems) ^ set(other))} keys)")
            total += 1
        n = 0
        for key in sorted(set(elems) & set(other)):
            pa, pb = elems[key], other[key]
            if pa is pb or pa == pb:
                continue
            d = {p: (pa.get(p), pb.get(p)) for p in set(pa) | set(pb) if pa.get(p) != pb.get(p)}
            if n < show:
                print(f"{state} {key} {d}")
            n += 1
        if n:
            print(f"{state}: {n} elements differ")
            total += n
    print(f"TOTAL differences {total}")
    return total


def main(argv):
    if len(argv) == 2 and argv[0] == "dump":
        dump_states(argv[1])
        return 0
    if len(argv) == 3 and argv[0] == "diff":
        return 1 if diff_states(argv[1], argv[2]) else 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
