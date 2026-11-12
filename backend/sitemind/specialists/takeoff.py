"""Spec / drawing takeoff specialist: PDF -> :class:`TakeoffResult`.

Approach (ideas reused from Kentucky-ai/opentakeoff, https://github.com/Kentucky-ai/opentakeoff):

* **Provenance on every measurement.** OpenTakeoff records, for every shape, the sheet it was
  measured on, the method that produced it and who (person or agent) drew it. We do the same
  at line level: each :class:`TakeoffLine` carries ``source`` = ``"<file> p<page> table 1 row
  <n>"`` so a reviewer can jump to the exact row, and every warning names the sheet.
* **Count and linear takeoff as separate measurement kinds.** OpenTakeoff distinguishes count
  (fixtures), linear (walls/runs) and area takeoffs. Here device tags on the single-line
  diagram are *counted* (``FDR A1-03 800A``, ``ATS-2 1200A``...) and busway runs are measured
  *linearly* by summing ``BD-xx ... 30 m`` labels.
* **Agent output is a proposal, not truth.** OpenTakeoff keeps an agent's takeoff as a dashed
  proposal until a person accepts it. We express that as ``confidence`` < 1 plus explicit
  ``warnings`` whenever the drawing and the schedule disagree; the schedule governs (per the
  drawing note) and the discrepancy is surfaced for an RFI rather than silently "fixed".

Extraction is deterministic: pdfplumber table extraction on the equipment-schedule sheet, with a
regex fallback over the page text if no ruled table is found.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path

import pdfplumber

from sitemind.models import TakeoffLine, TakeoffResult

SCHEDULE_MARKER = "EQUIPMENT SCHEDULE"
DRAWING_MARKER = "SINGLE-LINE DIAGRAM"

_CODE_RE = re.compile(r"^[A-Z]{2,6}(?:-[A-Z0-9.]+)+$")
_ROW_RE = re.compile(
    r"^(?P<item>\d+)\s+(?P<code>[A-Z]{2,6}(?:-[A-Z0-9.]+)+)\s+(?P<rest>.+?)\s+"
    r"(?P<qty>\d+)\s+(?P<unit>ea|m|set|lot)\b\s*(?P<remarks>.*)$"
)
_RATING_RE = re.compile(r"(\d{3,4} A(?:, \d+ kA)?|Class [\d.]+S|\d+ kA)$")

# Drawing-label counters: item code -> (description, function(text) -> count/length)
_DrawingCounter = Callable[[str], int]


def _count(pattern: str) -> _DrawingCounter:
    rx = re.compile(pattern)
    return lambda text: len(set(rx.findall(text)))


def _busway_metres(text: str) -> int:
    return sum(
        int(m) for _, m in re.findall(r"\b(BD-[A-Z]\d)\s+BUSWAY\s+4000A\s+CU\s+(\d+)\s*m\b", text)
    )


DRAWING_COUNTERS: dict[str, tuple[str, _DrawingCounter]] = {
    "SWGR-MAIN-4000A": ("SWGR-xx incomer tags", _count(r"\bSWGR-([A-Z]\d) 4000A\b")),
    "BKR-TIE-4000A": ("TIE-x tags", _count(r"\b(TIE-[A-Z]) 4000A\b")),
    "BKR-FDR-1600A": ("FDR xx-nn 1600A tags", _count(r"\bFDR ([A-Z]\d-\d{2}) 1600A\b")),
    "BKR-FDR-800A": ("FDR xx-nn 800A tags", _count(r"\bFDR ([A-Z]\d-\d{2}) 800A\b")),
    "ATS-1200A-4P": ("ATS-n tags", _count(r"\b(ATS-\d) 1200A\b")),
    "MTR-PQ-02S": ("PQM-xx tags", _count(r"\b(PQM-[A-Z0-9-]+)\b")),
    "SPD-T1-200KA": ("SPD-xx tags", _count(r"\b(SPD-[A-Z]\d) 200kA\b")),
    "BUSWAY-4000A-CU": ("BD-xx run lengths (linear, m)", _busway_metres),
}


def _clean(cell: str | None) -> str:
    return " ".join((cell or "").split())


def _split_desc_rating(rest: str) -> tuple[str, str]:
    m = _RATING_RE.search(rest)
    if not m:
        return rest.strip(), ""
    return rest[: m.start()].strip(), m.group(1)


def _lines_from_table(table: list[list[str | None]], doc: str, page_no: int) -> list[TakeoffLine]:
    if not table:
        return []
    header = [_clean(c).lower() for c in table[0]]
    try:
        i_code = header.index("item code")
        i_desc = header.index("description")
        i_qty = header.index("qty")
    except ValueError:
        return []
    i_rating = header.index("rating") if "rating" in header else None
    i_unit = header.index("unit") if "unit" in header else None
    out: list[TakeoffLine] = []
    for row_no, row in enumerate(table[1:], start=1):
        code = _clean(row[i_code])
        qty_txt = _clean(row[i_qty]).replace(",", "")
        if not _CODE_RE.match(code) or not qty_txt.isdigit():
            continue
        out.append(
            TakeoffLine(
                item_code=code,
                description=_clean(row[i_desc]),
                qty=int(qty_txt),
                unit=_clean(row[i_unit]) if i_unit is not None else "ea",
                rating=_clean(row[i_rating]) if i_rating is not None else "",
                source=f"{doc} p{page_no} table 1 row {row_no}",
            )
        )
    return out


def _lines_from_text(text: str, doc: str, page_no: int) -> list[TakeoffLine]:
    out: list[TakeoffLine] = []
    for raw in text.splitlines():
        m = _ROW_RE.match(raw.strip())
        if not m:
            continue
        desc, rating = _split_desc_rating(m.group("rest"))
        out.append(
            TakeoffLine(
                item_code=m.group("code"),
                description=desc,
                qty=int(m.group("qty")),
                unit=m.group("unit"),
                rating=rating,
                source=f"{doc} p{page_no} text row {m.group('item')}",
            )
        )
    return out


def cross_check(lines: list[TakeoffLine], drawing_text: str, drawing_page: int) -> list[str]:
    """Compare schedule quantities with counts/lengths of labels on the drawing sheet."""
    warnings: list[str] = []
    for line in lines:
        counter = DRAWING_COUNTERS.get(line.item_code)
        if counter is None:
            continue
        what, fn = counter
        found = fn(drawing_text)
        if found != line.qty:
            warnings.append(
                f"{line.item_code}: drawing p{drawing_page} shows {found} {line.unit} ({what}) but "
                f"the equipment schedule lists {line.qty} {line.unit}; schedule quantity used - "
                "raise an RFI to confirm."
            )
    return warnings


def run_takeoff(pdf_path: str | Path) -> TakeoffResult:
    """Extract the equipment schedule from a spec PDF and cross-check it against the drawing.

    Confidence starts at 0.98 for a ruled-table read (0.85 for the regex fallback) and drops
    0.06 per drawing/schedule mismatch, 0.15 if no drawing sheet is found to cross-check.
    """
    path = Path(pdf_path)
    doc = path.name
    lines: list[TakeoffLine] = []
    warnings: list[str] = []
    confidence = 0.98
    drawing: tuple[int, str] | None = None
    with pdfplumber.open(str(path)) as pdf:
        for idx, page in enumerate(pdf.pages, start=1):
            text = page.extract_text() or ""
            if DRAWING_MARKER in text and drawing is None and SCHEDULE_MARKER not in text:
                drawing = (idx, text)
            if SCHEDULE_MARKER in text and not lines:
                for table in page.extract_tables():
                    lines = _lines_from_table(table, doc, idx)
                    if lines:
                        break
                if not lines:
                    lines = _lines_from_text(text, doc, idx)
                    if lines:
                        confidence = 0.85
                        warnings.append(
                            f"p{idx}: schedule read from page text (no ruled table detected)."
                        )
    if not lines:
        return TakeoffResult(
            document=doc,
            lines=[],
            confidence=0.0,
            warnings=["No equipment schedule found in document."],
        )
    if drawing is None:
        confidence -= 0.15
        warnings.append("No single-line diagram sheet found; quantities not cross-checked.")
    else:
        mismatches = cross_check(lines, drawing[1], drawing[0])
        warnings.extend(mismatches)
        confidence -= 0.06 * len(mismatches)
    return TakeoffResult(
        document=doc,
        lines=lines,
        confidence=round(max(0.0, min(1.0, confidence)), 2),
        warnings=warnings,
    )
