"""
generate_pptx.py — Erzeugt die Projektpräsentation als .pptx (TUM-Stil).
Ausführen:  python generate_pptx.py
"""

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.util import Inches, Pt
from pptx.oxml.ns import qn
from pptx.dml.color import RGBColor
import copy
from lxml import etree

# ── Palette ───────────────────────────────────────────────────────────────────

TUM       = RGBColor(0x00, 0x65, 0xBD)   # TUM Blue
TUM_DARK  = RGBColor(0x00, 0x3F, 0x75)   # darker TUM
NAVY      = RGBColor(0x1A, 0x3A, 0x6B)   # step circle navy
WHITE     = RGBColor(0xFF, 0xFF, 0xFF)
BLACK     = RGBColor(0x1A, 0x1A, 0x1A)
DIM       = RGBColor(0x55, 0x55, 0x55)
LIGHT     = RGBColor(0xE8, 0xF0, 0xFB)
BORDER    = RGBColor(0xD0, 0xD6, 0xE2)
COVER_BG  = RGBColor(0x0A, 0x16, 0x28)

# ── Slide dimensions (widescreen 16:9) ────────────────────────────────────────

W = Inches(13.33)
H = Inches(7.50)

# Common layout constants
MARGIN_L  = Inches(0.55)
MARGIN_R  = Inches(0.55)
MARGIN_T  = Inches(0.50)
LOGO_TOP  = Inches(0.20)
LOGO_R    = Inches(0.40)
TITLE_TOP = Inches(0.38)
DIVIDER_Y = Inches(1.18)
BODY_TOP  = Inches(1.30)
FOOTER_Y  = Inches(6.98)
FOOTER_H  = Inches(0.42)
BODY_H    = FOOTER_Y - BODY_TOP - Inches(0.06)

# ── Helpers ───────────────────────────────────────────────────────────────────

def add_text_box(slide, x, y, w, h, text, font_size=12, bold=False,
                 color=BLACK, align=PP_ALIGN.LEFT, wrap=True):
    txb  = slide.shapes.add_textbox(x, y, w, h)
    tf   = txb.text_frame
    tf.word_wrap = wrap
    p    = tf.paragraphs[0]
    p.alignment = align
    run  = p.add_run()
    run.text = text
    run.font.size  = Pt(font_size)
    run.font.bold  = bold
    run.font.color.rgb = color
    return txb


def add_rect(slide, x, y, w, h, fill=None, line_color=None, line_width=Pt(0.75)):
    shape = slide.shapes.add_shape(1, x, y, w, h)   # 1 = MSO_SHAPE_TYPE.RECTANGLE
    sp    = shape.fill
    if fill:
        sp.solid(); sp.fore_color.rgb = fill
    else:
        sp.background()
    line = shape.line
    if line_color:
        line.color.rgb = line_color
        line.width     = line_width
    else:
        line.fill.background()
    return shape


def add_logos(slide):
    """AUS LAB box + TUM wordmark top-right."""
    logo_w = Inches(0.72)
    logo_h = Inches(0.50)
    lx = W - LOGO_R - Inches(1.65)
    ly = LOGO_TOP

    # AUS LAB box
    box = add_rect(slide, lx, ly, logo_w, logo_h,
                   fill=None, line_color=TUM, line_width=Pt(1.2))
    txb = slide.shapes.add_textbox(lx, ly, logo_w, logo_h)
    tf  = txb.text_frame
    tf.word_wrap = False
    for i, word in enumerate(["AUS", "LAB"]):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = PP_ALIGN.CENTER
        run = p.add_run()
        run.text = word
        run.font.size  = Pt(9)
        run.font.bold  = True
        run.font.color.rgb = TUM

    # TUM wordmark
    tx = lx + logo_w + Inches(0.12)
    txb2 = slide.shapes.add_textbox(tx, ly + Inches(0.04), Inches(0.80), Inches(0.40))
    tf2  = txb2.text_frame
    p2   = tf2.paragraphs[0]
    p2.alignment = PP_ALIGN.LEFT
    run2 = p2.add_run()
    run2.text = "TUM"
    run2.font.size  = Pt(20)
    run2.font.bold  = True
    run2.font.color.rgb = TUM_DARK


def add_slide_header(slide, title, subtitle):
    """Title, subtitle, blue divider line."""
    add_logos(slide)
    # Title
    txb = slide.shapes.add_textbox(MARGIN_L, TITLE_TOP, W - MARGIN_L - Inches(2.2), Inches(0.52))
    tf  = txb.text_frame
    p   = tf.paragraphs[0]
    run = p.add_run()
    run.text = title
    run.font.size  = Pt(28)
    run.font.bold  = True
    run.font.color.rgb = BLACK

    # Subtitle
    txb2 = slide.shapes.add_textbox(MARGIN_L, TITLE_TOP + Inches(0.50), W - MARGIN_L - Inches(2.2), Inches(0.36))
    tf2  = txb2.text_frame
    p2   = tf2.paragraphs[0]
    run2 = p2.add_run()
    run2.text = subtitle
    run2.font.size  = Pt(14)
    run2.font.bold  = True
    run2.font.color.rgb = TUM

    # Divider
    add_rect(slide, MARGIN_L, DIVIDER_Y, W - MARGIN_L - MARGIN_R, Inches(0.03), fill=TUM)


def add_footer(slide, slide_num):
    """Footer line + author + slide number."""
    add_rect(slide, MARGIN_L, FOOTER_Y, W - MARGIN_L - MARGIN_R, Pt(0.5), fill=BORDER)
    txb = slide.shapes.add_textbox(MARGIN_L, FOOTER_Y + Inches(0.06),
                                   W - MARGIN_L - MARGIN_R - Inches(0.5), Inches(0.30))
    tf  = txb.text_frame
    p   = tf.paragraphs[0]
    run = p.add_run()
    run.text = "Yuan Gao, M. Sc. (TUM)  |  11.05.2026  |  Supertestgenerator"
    run.font.size  = Pt(9)
    run.font.color.rgb = RGBColor(0x99, 0x99, 0x99)

    # Slide number
    txb2 = slide.shapes.add_textbox(W - MARGIN_R - Inches(0.5), FOOTER_Y + Inches(0.06),
                                    Inches(0.5), Inches(0.30))
    tf2  = txb2.text_frame
    p2   = tf2.paragraphs[0]
    p2.alignment = PP_ALIGN.RIGHT
    run2 = p2.add_run()
    run2.text = str(slide_num)
    run2.font.size  = Pt(9)
    run2.font.bold  = True
    run2.font.color.rgb = RGBColor(0xAA, 0xAA, 0xAA)


def add_step_box(slide, x, y, w, h, num, title, desc):
    """Numbered step box with circle + bold title + grey description."""
    # Box background
    box = add_rect(slide, x, y, w, h, fill=WHITE, line_color=BORDER, line_width=Pt(0.75))

    # Circle
    cx, cy = x + Inches(0.12), y + Inches(0.10)
    cr = Inches(0.22)
    circ = slide.shapes.add_shape(9, cx, cy, cr, cr)  # 9 = OVAL
    circ.fill.solid(); circ.fill.fore_color.rgb = NAVY
    circ.line.fill.background()

    # Circle number
    txb = slide.shapes.add_textbox(cx, cy, cr, cr)
    tf  = txb.text_frame
    p   = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    run = p.add_run()
    run.text = str(num)
    run.font.size  = Pt(10)
    run.font.bold  = True
    run.font.color.rgb = WHITE

    # Title
    tx = x + Inches(0.45)
    txb2 = slide.shapes.add_textbox(tx, y + Inches(0.06), w - Inches(0.50), Inches(0.22))
    tf2  = txb2.text_frame
    p2   = tf2.paragraphs[0]
    run2 = p2.add_run()
    run2.text = title
    run2.font.size  = Pt(11)
    run2.font.bold  = True
    run2.font.color.rgb = BLACK

    # Description
    txb3 = slide.shapes.add_textbox(tx, y + Inches(0.28), w - Inches(0.50), h - Inches(0.30))
    tf3  = txb3.text_frame
    tf3.word_wrap = True
    p3   = tf3.paragraphs[0]
    run3 = p3.add_run()
    run3.text = desc
    run3.font.size  = Pt(9.5)
    run3.font.color.rgb = DIM


def add_info_box(slide, x, y, w, h, text, font_size=11):
    """Blue left-border info box."""
    add_rect(slide, x, y, Inches(0.05), h, fill=TUM)
    add_rect(slide, x + Inches(0.05), y, w - Inches(0.05), h, fill=LIGHT)
    txb = slide.shapes.add_textbox(x + Inches(0.15), y + Inches(0.08),
                                   w - Inches(0.25), h - Inches(0.12))
    tf  = txb.text_frame
    tf.word_wrap = True
    p   = tf.paragraphs[0]
    run = p.add_run()
    run.text = text
    run.font.size  = Pt(font_size)
    run.font.color.rgb = BLACK


def add_section_label(slide, x, y, w, text):
    txb = slide.shapes.add_textbox(x, y, w, Inches(0.25))
    tf  = txb.text_frame
    p   = tf.paragraphs[0]
    run = p.add_run()
    run.text = text
    run.font.size  = Pt(12)
    run.font.bold  = True
    run.font.color.rgb = TUM_DARK


# ── Presentation setup ────────────────────────────────────────────────────────

prs = Presentation()
prs.slide_width  = W
prs.slide_height = H
blank = prs.slide_layouts[6]   # blank layout

# ═════════════════════════════════════════════════════════════════════════════
# FOLIE 1 — Cover
# ═════════════════════════════════════════════════════════════════════════════
sl = prs.slides.add_slide(blank)

# Dark blue background
add_rect(sl, 0, 0, W, H, fill=COVER_BG)

# AUS LAB box (white border)
lx = W - LOGO_R - Inches(1.65)
box = add_rect(sl, lx, LOGO_TOP, Inches(0.72), Inches(0.50),
               fill=None, line_color=RGBColor(0xCC, 0xDD, 0xFF), line_width=Pt(1.2))
for i, word in enumerate(["AUS", "LAB"]):
    txb = sl.shapes.add_textbox(lx, LOGO_TOP + i * Inches(0.23), Inches(0.72), Inches(0.24))
    tf  = txb.text_frame
    p   = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    run = p.add_run()
    run.text = word
    run.font.size  = Pt(9)
    run.font.bold  = True
    run.font.color.rgb = RGBColor(0xCC, 0xDD, 0xFF)

txb_tum = sl.shapes.add_textbox(lx + Inches(0.80), LOGO_TOP + Inches(0.06), Inches(0.80), Inches(0.38))
tf_tum  = txb_tum.text_frame
p_tum   = tf_tum.paragraphs[0]
run_tum = p_tum.add_run()
run_tum.text = "TUM"
run_tum.font.size  = Pt(20)
run_tum.font.bold  = True
run_tum.font.color.rgb = RGBColor(0xCC, 0xDD, 0xFF)

# Kicker
add_text_box(sl, MARGIN_L, Inches(1.55), Inches(8), Inches(0.28),
             "AUTONOMES FAHREN  ·  TESTSZENARIO-ENTWICKLUNG",
             font_size=9, color=RGBColor(0x66, 0x88, 0xAA))

# Title
txb_h = sl.shapes.add_textbox(MARGIN_L, Inches(1.90), Inches(8.5), Inches(1.60))
tf_h  = txb_h.text_frame
tf_h.word_wrap = True
p_h   = tf_h.paragraphs[0]
run_h = p_h.add_run()
run_h.text = "OpenSCENARIO Editor"
run_h.font.size  = Pt(44)
run_h.font.bold  = True
run_h.font.color.rgb = WHITE

# Subtitle
add_text_box(sl, MARGIN_L, Inches(3.55), Inches(8), Inches(0.50),
             "Visueller Szenario-Editor für autonome Fahrzeuge\nauf Basis von CARLA & OpenSCENARIO 1.0",
             font_size=15, color=RGBColor(0x99, 0xBB, 0xDD))

# Divider bar
add_rect(sl, MARGIN_L, Inches(4.25), Inches(7), Inches(0.04),
         fill=RGBColor(0x33, 0x55, 0x88))

# Feature boxes (2×2 grid)
feats = [
    ("🗺  Interaktive Karten",   "9 CARLA-Stadtkarten aus OpenDRIVE gerendert"),
    ("🚗  Akteur-Platzierung",    "Ego + 6 NPC-Typen mit Trajektorien & Triggern"),
    ("📤  OpenSCENARIO Export",  "Direkt nutzbare .xosc für CARLA ScenarioRunner"),
    ("⚡  Ohne Code",             "Komplexe Szenarien visuell erstellen — kein Programmieren"),
]
col_w = Inches(3.28)
col_gap = Inches(0.16)
for i, (title, desc) in enumerate(feats):
    col = i % 2
    row = i // 2
    bx = MARGIN_L + col * (col_w + col_gap)
    by = Inches(4.42) + row * Inches(0.78)
    box = add_rect(sl, bx, by, col_w, Inches(0.70),
                   fill=RGBColor(0x14, 0x28, 0x50),
                   line_color=RGBColor(0x2A, 0x4A, 0x80), line_width=Pt(0.75))
    add_text_box(sl, bx + Inches(0.12), by + Inches(0.04), col_w - Inches(0.18), Inches(0.28),
                 title, font_size=11, bold=True, color=WHITE)
    add_text_box(sl, bx + Inches(0.12), by + Inches(0.30), col_w - Inches(0.18), Inches(0.34),
                 desc, font_size=9.5, color=RGBColor(0x88, 0xAA, 0xCC))

# Meta row
meta = [("FORMAT","OpenSCENARIO 1.0"),("KARTE","OpenDRIVE (.xodr)"),
        ("BACKEND","Python · FastAPI"),("FRONTEND","Vanilla JS · SVG")]
add_rect(sl, MARGIN_L, Inches(6.20), W - MARGIN_L - MARGIN_R, Pt(0.5),
         fill=RGBColor(0x22, 0x3A, 0x60))
for i, (lbl, val) in enumerate(meta):
    mx = MARGIN_L + i * Inches(2.9)
    add_text_box(sl, mx, Inches(6.30), Inches(2.7), Inches(0.22),
                 lbl, font_size=8, color=RGBColor(0x55, 0x77, 0x99))
    add_text_box(sl, mx, Inches(6.52), Inches(2.7), Inches(0.26),
                 val, font_size=11, bold=True, color=RGBColor(0xCC, 0xDD, 0xFF))

# Cover footer
add_rect(sl, 0, Inches(7.12), W, Inches(0.38), fill=RGBColor(0x06, 0x0E, 0x1C))
add_text_box(sl, MARGIN_L, Inches(7.18), Inches(9), Inches(0.26),
             "Yuan Gao, M. Sc. (TUM)  |  11.05.2026  |  Supertestgenerator",
             font_size=9, color=RGBColor(0x55, 0x66, 0x77))
add_text_box(sl, W - MARGIN_R - Inches(0.4), Inches(7.18), Inches(0.35), Inches(0.26),
             "1", font_size=9, bold=True, color=RGBColor(0x66, 0x77, 0x88),
             align=PP_ALIGN.RIGHT)

# ═════════════════════════════════════════════════════════════════════════════
# FOLIE 2 — OpenSCENARIO Editor Einführung (wie Screenshot)
# ═════════════════════════════════════════════════════════════════════════════
sl = prs.slides.add_slide(blank)
add_rect(sl, 0, 0, W, H, fill=WHITE)
add_slide_header(sl, "OpenSCENARIO Editor", "Szenario-Editor für CARLA")
add_footer(sl, 2)

# Left column — bullet text
left_w = Inches(4.40)
txb = sl.shapes.add_textbox(MARGIN_L, BODY_TOP, left_w, Inches(5.20))
tf  = txb.text_frame
tf.word_wrap = True
p   = tf.paragraphs[0]
run = p.add_run()
run.text = (
    "Erstellen Sie komplexe Testszenarien für autonome Fahrzeuge im "
    "OpenSCENARIO 1.0-Format — ohne eine einzige Zeile Code zu schreiben. "
    "Platzieren Sie Akteure, zeichnen Sie Trajektorien und exportieren Sie "
    "direkt für den CARLA ScenarioRunner."
)
run.font.size  = Pt(15)
run.font.color.rgb = BLACK

# Right column — 6 steps
right_x = MARGIN_L + left_w + Inches(0.30)
right_w = W - right_x - MARGIN_R
step_h  = Inches(0.82)
step_gap = Inches(0.10)
steps = [
    ("Karte auswählen",
     "Wählen Sie im Dropdown oben eine der 9 CARLA-Stadtkarten (Town01–Town10HD)."),
    ("Ego-Fahrzeug platzieren",
     "Klicken Sie auf Ego in der linken Werkzeugleiste, dann auf die Karte. Das Fahrzeug rastet automatisch am nächsten Startpunkt ein."),
    ("Route des Ego zeichnen",
     "Wählen Sie das Ego → klicken Sie auf Pfad zeichnen → setzen Sie Wegpunkte → Fertig."),
    ("NPC-Akteure hinzufügen",
     "Werkzeuge: Auto, LKW, Bus, Motorrad, Fußgänger, Radfahrer. NPCs erhalten Events wie das Ego."),
    ("Umgebung konfigurieren",
     "Wetterleiste unten: Tageszeit, Nebel, Regen, Wolken, Sonne, nasse Straße, Schnee, Staub (je 0–1)."),
    ("Vorschau & Export",
     "Mit ▶ Abspielen animieren. Export als .xosc (OpenSCENARIO), Route-.xml (Autoware) oder .json."),
]
for i, (title, desc) in enumerate(steps):
    sy = BODY_TOP + i * (step_h + step_gap)
    add_step_box(sl, right_x, sy, right_w, step_h, i + 1, title, desc)

# ═════════════════════════════════════════════════════════════════════════════
# FOLIE 3 — Was ist OpenSCENARIO?
# ═════════════════════════════════════════════════════════════════════════════
sl = prs.slides.add_slide(blank)
add_rect(sl, 0, 0, W, H, fill=WHITE)
add_slide_header(sl, "Was ist OpenSCENARIO?", "ASAM-Standard für Fahrsimulationsszenarien")
add_footer(sl, 3)

mid = W / 2 + Inches(0.10)
col_w3 = mid - MARGIN_L - Inches(0.20)

# Info box
add_info_box(sl, MARGIN_L, BODY_TOP, col_w3, Inches(0.90),
             "OpenSCENARIO ist ein offener, XML-basierter Standard der ASAM e.V. zur Beschreibung "
             "dynamischer Inhalte in Fahrsimulationsszenarien — hersteller-unabhängig und reproduzierbar.",
             font_size=11)

# Bullets
bullets_l = [
    "Beschreibt Akteure, Trajektorien, Trigger, Wetter und Umgebung in einer .xosc-Datei",
    "Kompatibel mit CARLA, IPG CarMaker, dSPACE, AVL und weiteren Simulatoren",
    "Szenarien sind exakt reproduzierbar, versionierbar und CI/CD-fähig",
    "Kartenbasis: OpenDRIVE (.xodr) — ebenfalls ein ASAM-Standard für Straßennetze",
]
by = BODY_TOP + Inches(1.00)
for txt in bullets_l:
    add_rect(sl, MARGIN_L + Inches(0.05), by + Inches(0.10), Inches(0.07), Inches(0.07), fill=TUM)
    add_text_box(sl, MARGIN_L + Inches(0.22), by, col_w3 - Inches(0.25), Inches(0.50),
                 txt, font_size=11, color=BLACK)
    by += Inches(0.54)

# Right col — section label + table
rx = mid + Inches(0.10)
rw = W - rx - MARGIN_R
add_section_label(sl, rx, BODY_TOP, rw, "Version 1.0 (2020)")

# Table header
th_y = BODY_TOP + Inches(0.28)
add_rect(sl, rx, th_y, rw, Inches(0.30), fill=TUM)
add_text_box(sl, rx + Inches(0.08), th_y + Inches(0.05), Inches(1.8), Inches(0.22),
             "Element", font_size=10, bold=True, color=WHITE)
add_text_box(sl, rx + Inches(1.95), th_y + Inches(0.05), rw - Inches(2.0), Inches(0.22),
             "Beschreibung", font_size=10, bold=True, color=WHITE)

rows = [
    ("Entities",         "Ego & NPC-Definitionen (Vehicle, Pedestrian …)"),
    ("TeleportAction",   "Startposition der Akteure (x, y, z, Yaw)"),
    ("FollowTrajectory", "Bewegungspfade mit Wegpunkten & Geschwindigkeit"),
    ("DistanceCondition","Abstands-Auslöser für Events"),
    ("EnvironmentAction","Wetter & Tageszeit (Nebel, Regen, Sonne …)"),
    ("RoadNetwork",      "Referenz auf OpenDRIVE (.xodr) Kartendatei"),
]
for i, (elem, desc) in enumerate(rows):
    ry = th_y + Inches(0.30) + i * Inches(0.44)
    bg = LIGHT if i % 2 == 0 else WHITE
    add_rect(sl, rx, ry, rw, Inches(0.42), fill=bg, line_color=BORDER, line_width=Pt(0.5))
    add_text_box(sl, rx + Inches(0.08), ry + Inches(0.09), Inches(1.80), Inches(0.28),
                 elem, font_size=10, bold=True, color=TUM_DARK)
    add_text_box(sl, rx + Inches(1.95), ry + Inches(0.09), rw - Inches(2.0), Inches(0.28),
                 desc, font_size=9.5, color=DIM)

# ═════════════════════════════════════════════════════════════════════════════
# FOLIE 4 — Systemarchitektur
# ═════════════════════════════════════════════════════════════════════════════
sl = prs.slides.add_slide(blank)
add_rect(sl, 0, 0, W, H, fill=WHITE)
add_slide_header(sl, "Systemarchitektur", "Backend · Frontend · Datenfluss")
add_footer(sl, 4)

# Architecture flow boxes
arch_boxes = [
    ("🗂", "maps/*.xodr",     "OpenDRIVE\nKartendaten"),
    ("🐍", "FastAPI Backend", "map_renderer.py\nscenario_io.py"),
    ("🌐", "Browser Frontend","Vanilla JS\nSVG Rendering"),
    ("📄", "Export",          ".xosc / .xml\n/ .json"),
]
ab_w   = Inches(2.60)
ab_h   = Inches(1.05)
ab_gap = Inches(0.28)
ab_tot = len(arch_boxes) * ab_w + (len(arch_boxes) - 1) * ab_gap + (len(arch_boxes) - 1) * Inches(0.24)
ab_x0  = (W - ab_tot) / 2
ab_y   = BODY_TOP + Inches(0.08)

for i, (icon, title, sub) in enumerate(arch_boxes):
    bx = MARGIN_L + i * (ab_w + ab_gap + Inches(0.24))
    add_rect(sl, bx, ab_y, ab_w, ab_h, fill=LIGHT, line_color=TUM, line_width=Pt(1.0))
    add_text_box(sl, bx + Inches(0.10), ab_y + Inches(0.06), ab_w - Inches(0.15), Inches(0.30),
                 title, font_size=11, bold=True, color=TUM_DARK)
    add_text_box(sl, bx + Inches(0.10), ab_y + Inches(0.38), ab_w - Inches(0.15), Inches(0.52),
                 sub, font_size=9.5, color=DIM)
    if i < len(arch_boxes) - 1:
        ax = bx + ab_w + Inches(0.04)
        add_text_box(sl, ax, ab_y + Inches(0.35), Inches(0.20), Inches(0.30),
                     "→", font_size=16, bold=True, color=TUM)

# Two-column tables
tab_y  = ab_y + ab_h + Inches(0.28)
tab_h  = FOOTER_Y - tab_y - Inches(0.10)
half_w = (W - MARGIN_L - MARGIN_R - Inches(0.30)) / 2

# Backend table
add_section_label(sl, MARGIN_L, tab_y, half_w, "Backend (Python 3.10+)")
th_y2 = tab_y + Inches(0.28)
add_rect(sl, MARGIN_L, th_y2, half_w, Inches(0.28), fill=TUM)
for lbl, col_w_ in [("Modul", Inches(1.7)), ("Aufgabe", half_w - Inches(1.8))]:
    cx = MARGIN_L + (Inches(0.08) if lbl == "Modul" else Inches(1.80))
    add_text_box(sl, cx, th_y2 + Inches(0.04), col_w_, Inches(0.22), lbl, font_size=9.5, bold=True, color=WHITE)

be_rows = [
    ("main.py",        "FastAPI REST-Server, Karten-Cache beim Start"),
    ("map_renderer.py","OpenDRIVE-Parser → Geometrie-JSON für SVG"),
    ("scenario_io.py", "Validierung + .xosc / .xml Generierung"),
]
for i, (mod, task) in enumerate(be_rows):
    ry = th_y2 + Inches(0.28) + i * Inches(0.42)
    bg = LIGHT if i % 2 == 0 else WHITE
    add_rect(sl, MARGIN_L, ry, half_w, Inches(0.40), fill=bg, line_color=BORDER, line_width=Pt(0.5))
    add_text_box(sl, MARGIN_L + Inches(0.08), ry + Inches(0.08), Inches(1.65), Inches(0.26),
                 mod, font_size=9.5, bold=True, color=TUM_DARK)
    add_text_box(sl, MARGIN_L + Inches(1.80), ry + Inches(0.08), half_w - Inches(1.88), Inches(0.26),
                 task, font_size=9.5, color=DIM)

# Frontend table
rx2 = MARGIN_L + half_w + Inches(0.30)
add_section_label(sl, rx2, tab_y, half_w, "Frontend (Vanilla JS — kein Build-Schritt)")
add_rect(sl, rx2, th_y2, half_w, Inches(0.28), fill=TUM)
for lbl in [("Datei", Inches(0.08)), ("Aufgabe", Inches(1.55))]:
    add_text_box(sl, rx2 + lbl[1], th_y2 + Inches(0.04), Inches(1.4), Inches(0.22),
                 lbl[0], font_size=9.5, bold=True, color=WHITE)

fe_rows = [
    ("mapView.js",   "SVG-Rendering, Pan/Zoom, Layer-Steuerung"),
    ("objects.js",   "Akteur-Platzierung, Drag, Trajektorien"),
    ("simulate.js",  "Animationsvorschau aller Akteure"),
    ("scenarioIO.js","Speichern / Laden / Exportieren"),
]
for i, (f, t) in enumerate(fe_rows):
    ry = th_y2 + Inches(0.28) + i * Inches(0.42)
    bg = LIGHT if i % 2 == 0 else WHITE
    add_rect(sl, rx2, ry, half_w, Inches(0.40), fill=bg, line_color=BORDER, line_width=Pt(0.5))
    add_text_box(sl, rx2 + Inches(0.08), ry + Inches(0.08), Inches(1.45), Inches(0.26),
                 f, font_size=9.5, bold=True, color=TUM_DARK)
    add_text_box(sl, rx2 + Inches(1.58), ry + Inches(0.08), half_w - Inches(1.65), Inches(0.26),
                 t, font_size=9.5, color=DIM)

# ═════════════════════════════════════════════════════════════════════════════
# FOLIE 5 — Akteure & Trajektorien
# ═════════════════════════════════════════════════════════════════════════════
sl = prs.slides.add_slide(blank)
add_rect(sl, 0, 0, W, H, fill=WHITE)
add_slide_header(sl, "Akteure & Trajektorien", "Platzierung, Pfade und NPC-Events")
add_footer(sl, 5)

half_w5 = (W - MARGIN_L - MARGIN_R - Inches(0.30)) / 2

# Left — actor table
add_section_label(sl, MARGIN_L, BODY_TOP, half_w5, "Akteur-Typen")
th_y5 = BODY_TOP + Inches(0.28)
add_rect(sl, MARGIN_L, th_y5, half_w5, Inches(0.28), fill=TUM)
for lbl, ox in [("Typ", 0.08), ("Rolle", 1.30), ("Farbe", 4.20)]:
    add_text_box(sl, MARGIN_L + Inches(ox), th_y5 + Inches(0.04), Inches(2.0), Inches(0.22),
                 lbl, font_size=9.5, bold=True, color=WHITE)

actor_rows = [
    ("Ego",        "Zu testendes AV (Ego-Fahrzeug)",        RGBColor(0,101,189), "■ Blau"),
    ("Auto",       "NPC-Personenkraftwagen",                 RGBColor(0xE0,0x7A,0x00), "■ Orange"),
    ("LKW",        "NPC-Lastkraftwagen",                     RGBColor(0xCC,0x55,0x22), "■ Rot-Braun"),
    ("Bus",        "NPC-Bus",                                RGBColor(0xB8,0x86,0x0B), "■ Gelb"),
    ("Motorrad",   "NPC-Kraftrad",                           RGBColor(0xCC,0x44,0x33), "■ Lachs"),
    ("Fußgänger",  "Vulnerable Road User",                   RGBColor(0x99,0x33,0xAA), "■ Lila"),
    ("Radfahrer",  "Vulnerable Road User",                   RGBColor(0x22,0x88,0x66), "■ Grün"),
]
for i, (typ, role, col, col_lbl) in enumerate(actor_rows):
    ry = th_y5 + Inches(0.28) + i * Inches(0.40)
    bg = LIGHT if i % 2 == 0 else WHITE
    add_rect(sl, MARGIN_L, ry, half_w5, Inches(0.38), fill=bg, line_color=BORDER, line_width=Pt(0.5))
    add_text_box(sl, MARGIN_L + Inches(0.08), ry + Inches(0.07), Inches(1.15), Inches(0.26),
                 typ, font_size=10, bold=True, color=BLACK)
    add_text_box(sl, MARGIN_L + Inches(1.30), ry + Inches(0.07), Inches(2.85), Inches(0.26),
                 role, font_size=9.5, color=DIM)
    add_text_box(sl, MARGIN_L + Inches(4.22), ry + Inches(0.07), Inches(1.10), Inches(0.26),
                 col_lbl, font_size=10, bold=True, color=col)

# Right — NPC config steps
rx5 = MARGIN_L + half_w5 + Inches(0.30)
add_section_label(sl, rx5, BODY_TOP, half_w5, "NPC-Konfiguration")

npc_steps = [
    ("➤", "Trajektorienpfad",
     "Klick-Wegpunkte mit individueller Geschwindigkeit (m/s) — erzeugt FollowTrajectoryAction in der .xosc"),
    ("⏱", "Event-Auslöser",
     "Simulationszeit · Abstand zum Ego · Abstand zu einem Punkt · nach einem anderen Event"),
    ("⚙", "Event-Aktionen",
     "Trajektorie folgen · Route zuweisen · Geschwindigkeit setzen · Abstand halten · Spurwechsel"),
    ("↩", "Rückgängig (Strg+Z)",
     "Letzte 20 Löschaktionen wiederherstellbar — kein versehentlicher Datenverlust"),
]
nstep_h  = Inches(0.90)
nstep_gap= Inches(0.10)
for i, (sym, title, desc) in enumerate(npc_steps):
    sy = BODY_TOP + Inches(0.30) + i * (nstep_h + nstep_gap)
    add_rect(sl, rx5, sy, half_w5, nstep_h, fill=WHITE, line_color=BORDER, line_width=Pt(0.75))
    circ = sl.shapes.add_shape(9, rx5 + Inches(0.12), sy + Inches(0.12), Inches(0.24), Inches(0.24))
    circ.fill.solid(); circ.fill.fore_color.rgb = TUM
    circ.line.fill.background()
    add_text_box(sl, rx5 + Inches(0.12), sy + Inches(0.12), Inches(0.24), Inches(0.24),
                 sym, font_size=9, bold=True, color=WHITE, align=PP_ALIGN.CENTER)
    add_text_box(sl, rx5 + Inches(0.46), sy + Inches(0.07), half_w5 - Inches(0.55), Inches(0.26),
                 title, font_size=11, bold=True, color=BLACK)
    add_text_box(sl, rx5 + Inches(0.46), sy + Inches(0.33), half_w5 - Inches(0.55), Inches(0.48),
                 desc, font_size=9.5, color=DIM)

# ═════════════════════════════════════════════════════════════════════════════
# FOLIE 6 — Export & CARLA Integration
# ═════════════════════════════════════════════════════════════════════════════
sl = prs.slides.add_slide(blank)
add_rect(sl, 0, 0, W, H, fill=WHITE)
add_slide_header(sl, "Export & CARLA Integration", "Von der Visualisierung zur lauffähigen Simulation")
add_footer(sl, 6)

half_w6 = (W - MARGIN_L - MARGIN_R - Inches(0.30)) / 2

# Left — 3 format cards
fmt_data = [
    (RGBColor(0xE8,0xF0,0xFB), RGBColor(0xA8,0xC0,0xF0), RGBColor(0x1A,0x4F,0xA0),
     "📄  .xosc — OpenSCENARIO 1.0",
     "Vollständige Szenario-Datei für den CARLA ScenarioRunner. Enthält Entities, "
     "TeleportAction, FollowTrajectoryAction, DistanceCondition, EnvironmentAction."),
    (RGBColor(0xE8,0xF5,0xEE), RGBColor(0xA8,0xD5,0xB8), RGBColor(0x1A,0x6A,0x3A),
     "🗺️  .xml — Route",
     "Wegpunkt-Route des Ego mit x, y, z, Yaw — kompatibel mit Autoware und CARLA-Routenplanern."),
    (RGBColor(0xFE,0xF3,0xE2), RGBColor(0xF5,0xC9,0x7A), RGBColor(0x7A,0x4A,0x00),
     "💾  .json — Editor-Zustand",
     "Vollständiger Snapshot zum Speichern und Weiterladen. Enthält alle Akteure, Trajektorien, Wetter und Kartenauswahl."),
]
fc_h = Inches(1.48)
fc_gap = Inches(0.12)
for i, (bg, border, tc, title, desc) in enumerate(fmt_data):
    fy = BODY_TOP + i * (fc_h + fc_gap)
    add_rect(sl, MARGIN_L, fy, half_w6, fc_h, fill=bg, line_color=border, line_width=Pt(0.75))
    add_text_box(sl, MARGIN_L + Inches(0.14), fy + Inches(0.10), half_w6 - Inches(0.22), Inches(0.30),
                 title, font_size=12, bold=True, color=tc)
    add_text_box(sl, MARGIN_L + Inches(0.14), fy + Inches(0.42), half_w6 - Inches(0.22), Inches(0.90),
                 desc, font_size=10, color=DIM)

# Right col
rx6 = MARGIN_L + half_w6 + Inches(0.30)
rw6 = W - rx6 - MARGIN_R

# Info box - coordinate system
add_info_box(sl, rx6, BODY_TOP, rw6, Inches(0.75),
             "Koordinatensystem: OpenDRIVE (x, y) → CARLA Left-Hand-System: carla_y = −xodr_y. "
             "Die Y-Achsenspiegelung erfolgt automatisch im Backend.",
             font_size=10)

# Code block label
add_section_label(sl, rx6, BODY_TOP + Inches(0.86), rw6, "CARLA ScenarioRunner starten")

# Code block (dark rect + text)
code_y = BODY_TOP + Inches(1.14)
code_h = Inches(1.55)
add_rect(sl, rx6, code_y, rw6, code_h, fill=RGBColor(0x1E,0x23,0x36),
         line_color=RGBColor(0x2E,0x35,0x49), line_width=Pt(0.5))

code_lines = [
    ("# CARLA Simulator starten",  RGBColor(0x5A,0x6A,0x8A)),
    ("./CarlaUE4.sh",              RGBColor(0x7D,0xE8,0x80)),
    ("",                           RGBColor(0x7D,0xE8,0x80)),
    ("# Exportiertes Szenario ausführen", RGBColor(0x5A,0x6A,0x8A)),
    ("python scenario_runner.py \\", RGBColor(0xC9,0xD1,0xE8)),
    ("  --openscenario Town01_scenario.xosc \\", RGBColor(0xC9,0xD1,0xE8)),
    ("  --reloadWorld",            RGBColor(0xC9,0xD1,0xE8)),
]
for i, (line, col) in enumerate(code_lines):
    add_text_box(sl, rx6 + Inches(0.14), code_y + Inches(0.10) + i * Inches(0.19),
                 rw6 - Inches(0.22), Inches(0.20),
                 line, font_size=9.5, color=col)

# Validation info box
val_y = code_y + code_h + Inches(0.14)
add_info_box(sl, rx6, val_y, rw6, FOOTER_Y - val_y - Inches(0.10),
             "Validierung vor Export: Der Editor prüft ob ein Ego platziert wurde und warnt bei "
             "NPCs ohne Trajektorie — bevor die .xosc Datei generiert wird.",
             font_size=10)

# ── Save ──────────────────────────────────────────────────────────────────────

out = "OpenSCENARIO_Editor_Praesentation.pptx"
prs.save(out)
print(f"✓ Gespeichert: {out}")
