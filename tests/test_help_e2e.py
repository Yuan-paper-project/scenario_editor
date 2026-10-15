"""Help: the Hilfe menu, the Handbuch page and the "?" links into it.

The Handbuch (frontend/help.html) is a standalone page opened in a new tab.
Every "?" link in the editor points at one of its chapters
(help.html#<chapter>); a link whose chapter was renamed or removed would land
at the top of the page and look fine, so each one is resolved against the
page's real ids — and that resolver is shown to reject a made-up chapter.
"""

import os
import sys
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from _harness import Checks, open_editor, place_actor, zoom_at  # noqa: E402

check = Checks()

# Where a "?" link must exist, and which chapter it should open.
EXPECTED_LINKS = {"events", "umgebung", "generieren", "vorschau", "templates"}


def chapter_of(href):
    u = urlparse(href)
    return u.path, u.fragment


with sync_playwright() as p:
    browser, page, errors = open_editor(p, "Town01")
    ctx = page.context

    # ── The Hilfe menu ───────────────────────────────────────────────────────
    page.click("#help-menu-btn")
    items = [t.strip() for t in page.locator("#help-menu-panel .menu-item").all_inner_texts()]
    check(
        "Hilfe is a menu: Schnellstart, Handbuch, Tastenkürzel",
        [i.split(None, 1)[-1] for i in items] == ["Schnellstart", "Handbuch", "Tastenkürzel"],
        str(items),
    )

    page.click("#btn-help")
    check("Schnellstart opens the short help", page.is_visible("#welcome-overlay .welcome-card"))
    check(
        "...which links to the Handbuch",
        page.get_attribute("#welcome-handbook", "href") == "/static/help.html"
        and page.get_attribute("#welcome-handbook", "target") == "_blank",
    )
    page.click("#welcome-close")

    page.click("#help-menu-btn")
    page.click("#btn-shortcuts")
    check("Tastenkürzel opens the shortcut overlay", page.is_visible("#shortcuts-overlay"))
    check("...and the menu closes behind it", page.is_hidden("#help-menu-panel"))
    page.keyboard.press("Escape")
    check("Esc closes the shortcut overlay", page.is_hidden("#shortcuts-overlay"))

    page.click("#help-menu-btn")
    with ctx.expect_page() as new_tab:
        page.click("#btn-handbook")
    hb = new_tab.value
    hb.wait_for_load_state()
    check("Handbuch opens in a new tab", hb.url.endswith("/static/help.html"), hb.url)
    check("...titled Handbuch", hb.inner_text("h1") == "Handbuch" and "Handbuch" in hb.title())
    check("...and the editor tab stays where it was", page.is_visible("#map-svg"))

    # ── The Handbuch page itself ─────────────────────────────────────────────
    ids = set(hb.eval_on_selector_all("[id]", "els => els.map(e => e.id)"))
    nav = [chapter_of(h)[1] for h in hb.eval_on_selector_all("nav a", "as => as.map(a => a.href)")]
    check(
        "every contents entry has its chapter",
        nav and all(n in ids for n in nav),
        str([n for n in nav if n not in ids]),
    )
    sections = hb.eval_on_selector_all("main section", "ss => ss.map(s => s.id)")
    check(
        "every chapter is in the contents", all(s in nav for s in sections), str([s for s in sections if s not in nav])
    )
    check(
        "the chapters cover the editor's areas",
        {
            "karte",
            "akteure",
            "requisiten",
            "ampeln",
            "events",
            "ausloeser",
            "aktionen",
            "wegpunkte",
            "fallen",
            "templates",
            "vorschau",
            "generieren",
            "umgebung",
            "hintergrundverkehr",
            "export",
            "grenzen",
            "tastenkuerzel",
        }
        <= ids,
    )
    text = hb.inner_text("main")
    for label in [
        "Simulationszeit",
        "Abstand zu Akteur",
        "Abstand zu einem Punkt",
        "Ego-Geschwindigkeit",
        "Geschw.-Differenz",
        "Nach anderem Event",
        "Mit Start eines Events",
        "Route zuweisen",
        "Trajektorie folgen",
        "Geschw. setzen",
        "Spurwechsel",
        "Spurversatz",
    ]:
        check(f"Handbuch explains „{label}\"", label in text)
    # The trigger/action names must be the ones the editor shows, not stale ones.
    words = len(text.split())
    check("Handbuch is a real reference (> 1500 words)", words > 1500, str(words))
    hb.set_viewport_size({"width": 390, "height": 800})
    check(
        "Handbuch has no horizontal scroll at phone width",
        hb.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"),
    )
    hb.close()

    # ── The "?" links in the editor ──────────────────────────────────────────
    zoom_at(page, 250.0, 0.0, 14)
    place_actor(page, "ego", 258.0, -2.0)  # selected → Events section shown
    page.click('#properties-panel .event-action-button:has-text("Geschw. setzen")')
    actions = [t.strip() for t in page.locator(".event-action-button").all_inner_texts()]
    hb_text = text
    check(
        "every action button the editor shows is named in the Handbuch",
        all(a in hb_text for a in actions if a != "Abstand halten"),
        str(actions),
    )
    triggers = page.eval_on_selector_all(
        ".event-trigger-block select option", "os => os.map(o => o.textContent.trim())"
    )
    check(
        "every trigger the editor offers is named in the Handbuch",
        triggers and all(t in hb_text for t in triggers if t),
        str(triggers),
    )

    page.evaluate("AppState.select(null)")
    page.click('[data-overview-tab="templates"]')
    page.wait_for_timeout(150)

    links = page.eval_on_selector_all(".help-link", "as => as.map(a => a.getAttribute('href'))")
    found = {chapter_of(h)[1] for h in links}
    check(
        "a „?\" link next to Events, Umgebung, Generieren, Vorschau and Templates",
        EXPECTED_LINKS <= found,
        str(sorted(found)),
    )
    check(
        "every „?\" link opens the Handbuch in a new tab",
        page.eval_on_selector_all(
            ".help-link",
            "as => as.every(a => a.target === '_blank' && a.getAttribute('href').startsWith('/static/help.html#'))",
        ),
    )

    def resolves(fragment):
        return fragment in ids

    bad = [h for h in links if not resolves(chapter_of(h)[1])]
    check("every „?\" link lands on a chapter that exists", not bad, str(bad))
    check("negative control: the resolver rejects a chapter that does not exist", not resolves("gibt-es-nicht"))

    # A real click on the preview bar's "?" (always on screen once a map is loaded).
    link = page.locator("#sim-controls .help-link")
    check("the preview bar's „?\" is visible", link.is_visible())
    with ctx.expect_page() as new_tab:
        link.click()
    hb2 = new_tab.value
    hb2.wait_for_load_state()
    hb2.wait_for_timeout(400)
    check("clicking it opens the Vorschau chapter", hb2.url.endswith("help.html#vorschau"), hb2.url)
    top = hb2.evaluate("document.getElementById('vorschau').getBoundingClientRect().top")
    check("...scrolled to that chapter", 0 <= top < 120, str(top))
    hb2.close()

    # ── Layout: the links must not disturb what they sit beside ──────────────
    check(
        "the preview bar keeps its 560 px and does not overflow",
        page.evaluate("""() => { const c = document.getElementById('sim-controls');
              const r = c.querySelector('.sim-row-top');
              return Math.round(c.getBoundingClientRect().width) === 560
                  && r.scrollWidth <= r.clientWidth + 1; }"""),
    )

    page.evaluate("AppState.select(AppState.ego.id)")
    page.wait_for_timeout(150)
    overlap = page.evaluate("""() => {
        const a = document.querySelector('#event-section > .help-link').getBoundingClientRect();
        const hits = [...document.querySelectorAll('#event-section .collapsible-title, #event-section .collapse-indicator')]
          .map(e => e.getBoundingClientRect())
          .filter(b => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top));
        return {hits: hits.length, top: a.top, h: a.height}; }""")
    check("the Events „?\" overlaps neither the title nor the collapse sign", overlap["hits"] == 0, str(overlap))
    page.click("#env-menu-btn")
    check("the Umgebung „?\" is visible in the open menu", page.locator("#env-menu-panel .help-link").is_visible())
    page.keyboard.press("Escape")
    page.click("#gen-menu-btn")
    check("the Generieren „?\" is visible in the open menu", page.locator("#gen-menu-panel .help-link").is_visible())
    page.keyboard.press("Escape")

    check("no unexpected JS errors during the run", not errors, str(errors[:5]))
    browser.close()

sys.exit(check.report())
