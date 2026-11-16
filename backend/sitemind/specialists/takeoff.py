"""Spec / drawing takeoff specialist: any spec PDF -> :class:`TakeoffResult`.

Approach (ideas reused from Kentucky-ai/opentakeoff, https://github.com/Kentucky-ai/opentakeoff):

* **Provenance on every measurement.** OpenTakeoff records, for every shape, the sheet it was
  measured on, the method that produced it and who drew it. Each :class:`TakeoffLine` carries
  ``source`` = ``"<file> p<page> table <t> row <n>"`` (or ``text row <n>`` for the text
  fallback) so a reviewer can jump to the exact row; every warning names the page.
* **Count and linear takeoff as separate measurement kinds.** Cross-checks declared per package
  (``package.json`` ``cross_checks``) *count* device tags on a drawing (``FDR A1-03 800A``) or
  *sum* run lengths (``BD-A1 ... 30 m``), or read a *value* from a datasheet.
* **Agent output is a proposal, not truth.** Discrepancies and unclassified lines lower
  ``confidence`` and raise ``warnings``; nothing is silently fixed or dropped.

Generalisation: tables are found by **header names**, not positions. pdfplumber ruled tables
are tried first; pages without a ruled schedule fall back to a word-position parser that
detects a header line and slices the following lines into the same columns. Each line is
classified to a package item category (``classify_line``); unclassified lines are kept and
flagged.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pdfplumber

from sitemind.models import TakeoffLine, TakeoffResult
from sitemind.specialists.packages import (
    DEFAULT_PACKAGE,
    classify_line,
    get_package,
    load_package_raw,
    match_package,
)

# role -> header synonyms (normalised: lower case, single spaces, no trailing punctuation)
HEADER_SYNONYMS: dict[str, list[str]] = {
    "qty": [
        "qty",
        "quantity",
        "qty reqd",
        "qty req'd",
        "nos",
        "no off",
        "no. off",
        "number",
        "count",
        "quantity required",
        "no of units",
        "no. of units",
    ],
    "unit": ["unit", "units", "uom", "u/m", "unit of measure"],
    "code": [
        "item code",
        "code",
        "tag",
        "tag no",
        "equipment tag",
        "mark",
        "ref",
        "ref no",
        "part no",
        "model code",
    ],
    "rating": [
        "rating",
        "capacity",
        "specification",
        "spec",
        "size",
        "duty",
        "duty / capacity",
        "duty/capacity",
        "kva",
        "kw",
        "kva rating",
    ],
    "description": [
        "description",
        "equipment",
        "item description",
        "particulars",
        "equipment description",
        "name",
        "service",
        "item name",
    ],
}
ROLE_ORDER = ("qty", "unit", "code", "rating", "description")
UNIT_ALIASES = {
    "nos": "ea",
    "no": "ea",
    "no.": "ea",
    "each": "ea",
    "ea": "ea",
    "pcs": "ea",
    "pc": "ea",
    "set": "set",
    "sets": "set",
    "lot": "lot",
    "ls": "lot",
    "m": "m",
    "rm": "m",
    "rmt": "m",
    "mtr": "m",
    "mtrs": "m",
    "metre": "m",
    "metres": "m",
    "meter": "m",
    "meters": "m",
}
_CODE_RE = re.compile(r"^[A-Z0-9]{1,8}(?:[-/.][A-Z0-9.]+)*$")
_QTY_RE = re.compile(r"^(\d[\d,]*(?:\.\d+)?)\s*([A-Za-z.]+)?$")
BASE_TABLE_CONF = 0.98
BASE_TEXT_CONF = 0.85


def _norm(h: str | None) -> str:
    return " ".join((h or "").lower().replace("\n", " ").split()).strip(" .:")


def header_role(header: str | None) -> str | None:
    """Map a column header to a role (qty/unit/code/rating/description) or None."""
    h = _norm(header)
    if not h:
        return None
    for role in ROLE_ORDER:
        if h in HEADER_SYNONYMS[role]:
            return role
    words = set(re.split(r"[\s/]+", h))
    for role in ROLE_ORDER:
        for syn in HEADER_SYNONYMS[role]:
            sw = set(re.split(r"[\s/]+", syn))
            if " " not in syn and syn in words and len(words) <= 3:
                return role
            if " " in syn and sw <= words:
                return role
    return None


def map_columns(headers: list[str | None]) -> dict[str, int]:
    """First column index for each role found in a header row."""
    roles: dict[str, int] = {}
    for i, h in enumerate(headers):
        role = header_role(h)
        if role and role not in roles:
            roles[role] = i
    return roles


def _is_schedule(roles: dict[str, int]) -> bool:
    return "qty" in roles and ("code" in roles or "description" in roles)


def _clean(cell: str | None) -> str:
    return " ".join((cell or "").split())


def _slug(text: str) -> str:
    s = re.sub(r"[^A-Z0-9]+", "-", text.upper()).strip("-")
    return s[:28].rstrip("-") or "ITEM"


def parse_qty(text: str) -> tuple[int, str | None] | None:
    """'4' -> (4, None); '1,200 m' -> (1200, 'm'); '4 Nos' -> (4, 'ea'); else None."""
    m = _QTY_RE.match(_clean(text))
    if not m:
        return None
    num = float(m.group(1).replace(",", ""))
    unit = m.group(2)
    return int(round(num)), (UNIT_ALIASES.get(unit.lower(), unit.lower()) if unit else None)


@dataclass
class _Row:
    cells: dict[str, str]
    source: str
    page: int


def _rows_from_grid(
    grid: list[list[str]], roles: dict[str, int], where: str, page: int
) -> list[_Row]:
    out: list[_Row] = []
    for r, row in enumerate(grid, start=1):
        cells = {role: _clean(row[i]) if i < len(row) else "" for role, i in roles.items()}
        if any(cells.values()):
            out.append(_Row(cells=cells, source=f"{where} row {r}", page=page))
    return out


def _ruled_tables(page: Any, doc: str, page_no: int) -> list[_Row]:
    rows: list[_Row] = []
    t_no = 0
    for table in page.extract_tables():
        if not table:
            continue
        for h in range(min(3, len(table))):
            roles = map_columns(table[h])
            if _is_schedule(roles):
                t_no += 1
                grid = [[c or "" for c in row] for row in table[h + 1 :]]
                rows += _rows_from_grid(grid, roles, f"{doc} p{page_no} table {t_no}", page_no)
                break
    return rows


def _text_lines(page: Any) -> list[list[dict[str, Any]]]:
    words = sorted(page.extract_words(), key=lambda w: (round(w["top"] / 3), w["x0"]))
    lines: list[list[dict[str, Any]]] = []
    for w in words:
        if lines and abs(lines[-1][0]["top"] - w["top"]) <= 3:
            lines[-1].append(w)
        else:
            lines.append([w])
    return [sorted(ln, key=lambda w: w["x0"]) for ln in lines]


def _cells(line: list[dict[str, Any]], gap: float = 7.0) -> list[tuple[float, str]]:
    cells: list[tuple[float, str]] = []
    last_x1 = -1e9
    for w in line:
        if cells and w["x0"] - last_x1 <= gap:
            x0, txt = cells[-1]
            cells[-1] = (x0, f"{txt} {w['text']}")
        else:
            cells.append((w["x0"], w["text"]))
        last_x1 = w["x1"]
    return cells


def _text_tables(page: Any, doc: str, page_no: int) -> list[_Row]:
    """Word-position fallback for unruled schedules: header line -> column x positions."""
    rows: list[_Row] = []
    cols: list[tuple[float, str | None]] | None = None
    misses = 0
    r = 0
    for line in _text_lines(page):
        cells = _cells(line)
        roles = map_columns([c[1] for c in cells])
        if _is_schedule(roles):
            cols = [(x0, header_role(txt)) for x0, txt in cells]
            misses, r = 0, 0
            continue
        if cols is None:
            continue
        vals: dict[str, list[str]] = {}
        for w in line:
            idx = max((i for i, (x0, _) in enumerate(cols) if x0 <= w["x0"] + 4), default=0)
            role = cols[idx][1]
            if role:
                vals.setdefault(role, []).append(w["text"])
        cell_map = {k: " ".join(v) for k, v in vals.items()}
        if parse_qty(cell_map.get("qty", "")) is None:
            misses += 1
            if misses >= 2:
                cols = None
            continue
        misses = 0
        r += 1
        rows.append(_Row(cells=cell_map, source=f"{doc} p{page_no} text row {r}", page=page_no))
    return rows


def _to_line(row: _Row, warnings: list[str]) -> TakeoffLine | None:
    c = row.cells
    desc = c.get("description", "")
    q = parse_qty(c.get("qty", ""))
    if q is None:
        if desc or c.get("code"):
            warnings.append(
                f"{row.source}: quantity '{c.get('qty', '')}' not readable for "
                f"'{desc or c.get('code')}'; line skipped - confirm quantity."
            )
        return None
    qty, qty_unit = q
    raw_code = c.get("code", "").upper().replace(" ", "")
    code = raw_code if raw_code and _CODE_RE.match(raw_code) else _slug(desc or raw_code)
    unit_txt = c.get("unit", "").strip().lower()
    unit = UNIT_ALIASES.get(unit_txt, unit_txt) if unit_txt else (qty_unit or "ea")
    return TakeoffLine(
        item_code=code,
        description=desc or code,
        qty=qty,
        unit=unit,
        rating=c.get("rating", ""),
        source=row.source,
    )


def _cross_value(text: str, chk: dict[str, Any]) -> int | None:
    rx = re.compile(str(chk["pattern"]))
    mode = chk.get("mode", "count_unique")
    if mode == "count_unique":
        return len(set(rx.findall(text)))
    if mode == "sum":
        return sum(int(str(m).replace(",", "")) for m in rx.findall(text))
    m = rx.search(text)
    return int(m.group(1).replace(",", "")) if m else None


def cross_check(
    lines: list[TakeoffLine],
    text: str,
    page: int,
    package_id: str = DEFAULT_PACKAGE,
    checks: list[dict[str, Any]] | None = None,
) -> list[str]:
    """Compare schedule quantities with counts/lengths/values found in ``text`` (one page)."""
    checks = checks if checks is not None else load_package_raw(package_id).get("cross_checks", [])
    by_code = {ln.item_code: ln for ln in lines}
    warnings: list[str] = []
    for chk in checks:
        line = by_code.get(str(chk["item_code"]))
        if line is None:
            continue
        found = _cross_value(text, chk)
        if found is None or found == line.qty:
            continue
        warnings.append(
            f"{line.item_code}: p{page} shows {found} {line.unit} ({chk.get('what', 'check')}) "
            f"but the equipment schedule lists {line.qty} {line.unit}; schedule quantity used - "
            "raise an RFI to confirm."
        )
    return warnings


def run_takeoff(pdf_path: str | Path, package_id: str | None = None) -> TakeoffResult:
    """Extract equipment-schedule lines from any spec PDF, classify and cross-check them.

    ``package_id`` selects categories and cross-checks; ``None`` auto-detects the package from
    the document text (``match_package``). Confidence starts at 0.98 (ruled tables) or 0.85
    (text fallback used) and drops 0.06 per cross-check mismatch, 0.15 if the package's
    drawing/datasheet page is missing, 0.05 per unclassified line (max 0.40); a document with
    no classifiable line is capped at 0.5 and flagged for a human.
    """
    path = Path(pdf_path)
    doc = path.name
    warnings: list[str] = []
    rows: list[_Row] = []
    used_text = False
    texts: list[str] = []
    with pdfplumber.open(str(path)) as pdf:
        for idx, page in enumerate(pdf.pages, start=1):
            texts.append(page.extract_text() or "")
            found = _ruled_tables(page, doc, idx)
            if not found:
                found = _text_tables(page, doc, idx)
                if found:
                    used_text = True
                    warnings.append(f"p{idx}: schedule read from page text (no ruled table).")
            rows += found
    lines: list[TakeoffLine] = []
    for row in rows:
        ln = _to_line(row, warnings)
        if ln is not None:
            lines.append(ln)
    if not lines:
        return TakeoffResult(
            document=doc,
            lines=[],
            confidence=0.0,
            warnings=[*warnings, "No equipment schedule found in document."],
        )
    full_text = "\n".join(texts)
    pid = package_id or match_package(full_text)[0]
    confidence = BASE_TEXT_CONF if used_text else BASE_TABLE_CONF

    # classification
    unclassified = 0
    for ln in lines:
        if classify_line(ln, pid) is None:
            unclassified += 1
            where = f"the {get_package(pid).title} package" if pid else "any supported package"
            warnings.append(
                f"{ln.source}: '{ln.description}' ({ln.item_code}) does not match a category of "
                f"{where}; kept for manual pricing/review."
            )
    confidence -= min(0.40, 0.05 * unclassified)
    if unclassified == len(lines):
        warnings.append(
            "No line matches a supported package category: SiteMind cannot buy this package "
            "automatically - hand to a human buyer."
        )
        confidence = min(confidence, 0.5)

    # cross-checks against drawing / datasheet pages
    if pid:
        checks: list[dict[str, Any]] = load_package_raw(pid).get("cross_checks", [])
        markers = sorted({str(c.get("page_marker", "")) for c in checks if c.get("page_marker")})
        codes = {ln.item_code for ln in lines}
        for marker in markers:
            pages = [(i, t) for i, t in enumerate(texts, start=1) if marker in t]
            mine = [c for c in checks if c.get("page_marker") == marker]
            if not any(c["item_code"] in codes for c in mine):
                continue
            if not pages:
                confidence -= 0.15
                warnings.append(f"No '{marker}' sheet found; quantities not cross-checked.")
                continue
            for page_no, text in pages:
                mismatches = cross_check(lines, text, page_no, pid, mine)
                warnings.extend(mismatches)
                confidence -= 0.06 * len(mismatches)
    return TakeoffResult(
        document=doc,
        lines=lines,
        confidence=round(max(0.0, min(1.0, confidence)), 2),
        warnings=warnings,
    )
