"""Génère les guides PDF téléchargeables (newsletter, lead-magnet) à partir de guides/*.md.

Sortie : private/guides/<slug>.pdf + private/guides/guides.json.
Le dossier private/ n'est pas servi publiquement : le serveur ne livre un guide
qu'avec un lien signé, envoyé par e-mail après confirmation de l'inscription.

Usage : python3 build_guides.py [--out DOSSIER]
"""
import datetime
import json
import os
import re
import sys

import yaml
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, CondPageBreak, Frame, KeepTogether, ListFlowable, ListItem, NextPageTemplate,
                                PageBreak, PageTemplate, Paragraph, Spacer, Table, TableStyle)

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "guides")
OUT = os.path.join(ROOT, "private", "guides")
HOST = "www.sereina.fr"
if "--site-url" in sys.argv:
    HOST = sys.argv[sys.argv.index("--site-url") + 1].split("//", 1)[-1].rstrip("/")
if "--out" in sys.argv:
    OUT = sys.argv[sys.argv.index("--out") + 1]
FONTS = os.path.join(ROOT, "assets", "fonts")

# Ordre d'affichage et thèmes reliés (pour la page /guides/ et les encarts des articles)
ORDER = ["anxiete", "sommeil", "epuisement", "deuil", "prendre-soin"]

STEEL, INK, MUTED, LINE, MIST = HexColor("#1d5a55"), HexColor("#241f1a"), HexColor("#52483f"), HexColor("#e3d9ca"), HexColor("#e8f1ed")
ALERT_BG, ALERT_FG = HexColor("#fbf1e6"), HexColor("#6f3a1a")

pdfmetrics.registerFont(TTFont("Plex", os.path.join(FONTS, "IBMPlexSans-Regular.ttf")))
pdfmetrics.registerFont(TTFont("PlexSB", os.path.join(FONTS, "IBMPlexSans-SemiBold.ttf")))
pdfmetrics.registerFont(TTFont("Serif", os.path.join(FONTS, "IBMPlexSerif-Regular.ttf")))
pdfmetrics.registerFont(TTFont("SerifI", os.path.join(FONTS, "IBMPlexSerif-Italic.ttf")))
pdfmetrics.registerFontFamily("Serif", normal="Serif", bold="PlexSB", italic="SerifI", boldItalic="PlexSB")
pdfmetrics.registerFontFamily("Plex", normal="Plex", bold="PlexSB", italic="Plex", boldItalic="PlexSB")

# Texte volontairement grand : public de 30 à 70 ans et plus, guides faits pour être imprimés.
S = {
    "body": ParagraphStyle("body", fontName="Serif", fontSize=12.5, leading=19, textColor=INK, spaceAfter=8, alignment=TA_LEFT),
    "h2": ParagraphStyle("h2", fontName="PlexSB", fontSize=19, leading=24, textColor=STEEL, spaceBefore=6, spaceAfter=10),
    "h3": ParagraphStyle("h3", fontName="PlexSB", fontSize=14, leading=19, textColor=INK, spaceBefore=10, spaceAfter=5),
    "li": ParagraphStyle("li", fontName="Serif", fontSize=12.5, leading=18.5, textColor=INK),
    "call": ParagraphStyle("call", fontName="Serif", fontSize=12.5, leading=18.5, textColor=INK),
    "cover_t": ParagraphStyle("ct", fontName="PlexSB", fontSize=30, leading=36, textColor=INK, spaceAfter=16),
    "cover_s": ParagraphStyle("cs", fontName="SerifI", fontSize=15, leading=22, textColor=MUTED, spaceAfter=24),
    "cover_m": ParagraphStyle("cm", fontName="Plex", fontSize=11, leading=16, textColor=MUTED),
    "toc": ParagraphStyle("toc", fontName="Plex", fontSize=12.5, leading=22, textColor=INK),
    "small": ParagraphStyle("sm", fontName="Plex", fontSize=10, leading=14, textColor=MUTED),
}


def inline(t):
    t = t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<i>\1</i>", t)
    return t


def callout(text):
    p = Paragraph(inline(text), S["call"])
    t = Table([[p]], colWidths=[None])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), MIST), ("LINEBEFORE", (0, 0), (0, -1), 3, STEEL),
                           ("LEFTPADDING", (0, 0), (-1, -1), 14), ("RIGHTPADDING", (0, 0), (-1, -1), 14),
                           ("TOPPADDING", (0, 0), (-1, -1), 10), ("BOTTOMPADDING", (0, 0), (-1, -1), 10)]))
    return [Spacer(1, 4), t, Spacer(1, 10)]


def checklist(items):
    rows = [[Paragraph("☐", ParagraphStyle("bx", fontName="Plex", fontSize=14, leading=18, textColor=STEEL)),
             Paragraph(inline(i), S["li"])] for i in items]
    t = Table(rows, colWidths=[8 * mm, None])
    t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), 5), ("TOPPADDING", (0, 0), (-1, -1), 1)]))
    return [t, Spacer(1, 8)]


def blist(items, ordered):
    lf = ListFlowable([ListItem(Paragraph(inline(i), S["li"]), leftIndent=16, spaceAfter=4) for i in items],
                      bulletType="1" if ordered else "bullet", start=1 if ordered else None,
                      bulletFontName="PlexSB" if ordered else "Plex", bulletFontSize=11.5 if ordered else 9,
                      bulletColor=STEEL, leftIndent=16, bulletDedent=14, **({} if ordered else {"bulletChar": "■"}))
    return [lf, Spacer(1, 8)]


def parse(md):
    """Transforme le markdown simplifié des guides en flowables. Retourne (flowables, titres h2)."""
    out, h2s, para, items, kind = [], [], [], [], None

    def flush_para():
        if para:
            out.append(Paragraph(inline(" ".join(para)), S["body"]))
            para.clear()

    def flush_list():
        nonlocal kind
        if items:
            out.extend(checklist(items) if kind == "check" else blist(items, kind == "ol"))
            items.clear()
        kind = None

    for raw in md.splitlines():
        line = raw.rstrip()
        m_ol, m_ul = re.match(r"^\d+\.\s+(.*)", line), re.match(r"^-\s+(.*)", line)
        if not line.strip():
            flush_para(); flush_list(); continue
        if line.startswith("## "):
            flush_para(); flush_list()
            title = line[3:].strip()
            if h2s:
                out.append(CondPageBreak(110 * mm))
            h2s.append(title)
            out.append(Paragraph(inline(title), S["h2"]))
        elif line.startswith("### "):
            flush_para(); flush_list()
            out.append(KeepTogether([Paragraph(inline(line[4:].strip()), S["h3"])]))
        elif line.startswith("> "):
            flush_para(); flush_list(); out.extend(callout(line[2:].strip()))
        elif m_ul:
            flush_para()
            txt = m_ul.group(1)
            k = "check" if txt.startswith("[ ]") else "ul"
            if kind and kind != k:
                flush_list()
            kind = k
            items.append(txt[3:].strip() if k == "check" else txt)
        elif m_ol:
            flush_para()
            if kind and kind != "ol":
                flush_list()
            kind = "ol"
            items.append(m_ol.group(1))
        elif items:
            items[-1] += " " + line.strip()
        else:
            para.append(line.strip())
    flush_para(); flush_list()
    return out, h2s


def build(slug):
    with open(os.path.join(SRC, f"{slug}.md"), encoding="utf-8") as f:
        raw = f.read()
    _, fm, body = raw.split("---", 2)
    meta = yaml.safe_load(fm)
    flow, h2s = parse(body)
    # Le premier paragraphe d'accueil (avant le premier ##) reste en tête, après le sommaire.
    first_h2 = next(i for i, f in enumerate(flow) if isinstance(f, Paragraph) and f.style.name == "h2")
    intro, rest = flow[:first_h2], flow[first_h2:]

    path = os.path.join(OUT, f"{slug}.pdf")
    W, H = A4
    margin = 22 * mm

    def on_cover(c, d):
        c.saveState()
        c.setFillColor(STEEL); c.rect(0, H - 14 * mm, W, 14 * mm, stroke=0, fill=1)
        c.setFillColor(HexColor("#ffffff")); c.setFont("PlexSB", 12); c.drawString(margin, H - 9.3 * mm, "Sereina")
        c.setFont("Plex", 10); c.drawRightString(W - margin, H - 9.3 * mm, "Guide gratuit")
        c.setFillColor(ALERT_BG); c.rect(margin, 22 * mm, W - 2 * margin, 24 * mm, stroke=0, fill=1)
        c.setFillColor(ALERT_FG); c.setFont("PlexSB", 11.5); c.drawString(margin + 6 * mm, 38 * mm, "En cas d'urgence : 15 (SAMU) ou 3114 (prévention du suicide)")
        c.setFont("Plex", 10.5); c.drawString(margin + 6 * mm, 31.5 * mm, "Gratuits, jour et nuit. Un humain vous répond. Pour les sourds et malentendants : 114 par SMS.")
        c.setFillColor(MUTED); c.setFont("Plex", 9); c.drawString(margin, 13 * mm, HOST)
        c.restoreState()

    def on_page(c, d):
        c.saveState()
        c.setStrokeColor(LINE); c.setLineWidth(.6); c.line(margin, H - 15 * mm, W - margin, H - 15 * mm)
        c.setFillColor(MUTED); c.setFont("Plex", 9)
        c.drawString(margin, H - 12 * mm, "Sereina · " + meta["titre"][:80])
        c.line(margin, 15 * mm, W - margin, 15 * mm)
        c.drawString(margin, 10 * mm, "Ce guide informe et ne remplace pas un avis médical. Urgence : 15 ou 3114.")
        c.drawRightString(W - margin, 10 * mm, str(d.page))
        c.restoreState()

    doc = BaseDocTemplate(path, pagesize=A4, title=meta["titre"], author="Sereina", subject=meta.get("accroche", ""),
                          creator="Sereina", lang="fr-FR",
                          leftMargin=margin, rightMargin=margin, topMargin=24 * mm, bottomMargin=22 * mm)
    fr_cover = Frame(margin, 52 * mm, W - 2 * margin, H - 52 * mm - 40 * mm, id="cover")
    fr = Frame(margin, 22 * mm, W - 2 * margin, H - 46 * mm, id="main")
    doc.addPageTemplates([PageTemplate("cover", [fr_cover], onPage=on_cover), PageTemplate("page", [fr], onPage=on_page)])

    toc = [Paragraph("Dans ce guide", S["h2"])] + [Paragraph(f"{i}. &nbsp;{inline(t)}", S["toc"]) for i, t in enumerate(h2s, 1)]
    story = [Spacer(1, 30 * mm), Paragraph(inline(meta["titre"]), S["cover_t"]), Paragraph(inline(meta["sous_titre"]), S["cover_s"]),
             Paragraph(f"Un guide à lire à votre rythme et à imprimer. Édition {datetime.date.today().strftime('%m/%Y')}.", S["cover_m"]),
             NextPageTemplate("page"), PageBreak(), *toc, Spacer(1, 12), *intro, PageBreak(), *rest,
             Spacer(1, 14),
             *callout("Pour en parler : les accompagnants d'écoute Sereina répondent jour et nuit sur " + HOST + "/parler/. "
                      "Ce sont des programmes d'intelligence artificielle, pas des soignants. Votre médecin traitant, un psychologue "
                      "ou le 3114 restent les bons interlocuteurs quand ça ne va vraiment pas.")]
    doc.build(story)
    pages = doc.page
    return {"slug": slug, "titre": meta["titre"], "sous_titre": meta["sous_titre"], "accroche": meta.get("accroche", ""), "pages": pages}


def main():
    os.makedirs(OUT, exist_ok=True)
    out = [build(s) for s in ORDER if os.path.exists(os.path.join(SRC, f"{s}.md"))]
    with open(os.path.join(OUT, "guides.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    for g in out:
        print(f"{g['slug']}.pdf : {g['pages']} pages")


if __name__ == "__main__":
    main()
