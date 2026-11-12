"""Builds ../SiteMind_pitch.pptx from the rendered slide PNGs (run render.mjs first).

Each slide is the full-bleed 1920x1080 render; the slide's text is added to the
speaker notes so it stays searchable. Usage: python3 submission/deck/make_pptx.py
"""
import re
from html.parser import HTMLParser
from pathlib import Path

from pptx import Presentation
from pptx.util import Inches

HERE = Path(__file__).resolve().parent


class Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.slides, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "section":
            self.slides.append({"title": a.get("data-title", ""), "text": []})
        if tag in ("style", "svg"):
            self.skip += 1

    def handle_endtag(self, tag):
        if tag in ("style", "svg"):
            self.skip -= 1

    def handle_data(self, data):
        d = re.sub(r"\s+", " ", data).strip()
        if d and not self.skip and self.slides:
            self.slides[-1]["text"].append(d)


parser = Text()
parser.feed((HERE / "slides.html").read_text(encoding="utf-8"))

prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
for i, meta in enumerate(parser.slides, 1):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    slide.shapes.add_picture(str(HERE / "png" / f"slide-{i:02d}.png"), 0, 0, prs.slide_width, prs.slide_height)
    slide.notes_slide.notes_text_frame.text = meta["title"] + "\n\n" + " ".join(meta["text"])
out = HERE.parent / "SiteMind_pitch.pptx"
prs.save(out)
print(f"{len(parser.slides)} slides -> {out}")
