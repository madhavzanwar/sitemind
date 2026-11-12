"""Generate the synthetic Project Alpha 480 V switchgear specification PDF.

Output: ``backend/sitemind/data/project_alpha_480V_switchgear_spec.pdf`` (4 pages):

1. Cover sheet / title block / revision table
2. General requirements (technical clauses)
3. Single-line diagram (drawn with reportlab primitives, every device labelled)
4. Equipment schedule table (the quantities the takeoff specialist extracts)

The drawing intentionally shows only three surge protective devices while the schedule
lists four, so the takeoff cross-check has a realistic discrepancy to flag.

Run: ``python backend/scripts/make_spec_pdf.py`` (deterministic: fixed metadata, no dates
from the wall clock).
"""

from __future__ import annotations

import sys
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A3, A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import Paragraph, Table, TableStyle

OUT = (
    Path(__file__).resolve().parents[1]
    / "sitemind"
    / "data"
    / "project_alpha_480V_switchgear_spec.pdf"
)

DOC_NO = "PA-EL-SPC-480-001"
REV = "B"
TITLE = "480 V LOW-VOLTAGE SWITCHGEAR PACKAGE - TECHNICAL SPECIFICATION"

# (item code, description, rating, qty, unit, remarks)
SCHEDULE: list[tuple[str, str, str, int, str, str]] = [
    (
        "SWGR-MAIN-4000A",
        "Main LV switchgear lineup, draw-out ACB incomer",
        "4000 A, 65 kA",
        4,
        "ea",
        "SWGR-A1/A2/B1/B2",
    ),
    (
        "BKR-TIE-4000A",
        "Bus-tie air circuit breaker, draw-out",
        "4000 A, 65 kA",
        2,
        "ea",
        "TIE-A, TIE-B",
    ),
    (
        "BKR-FDR-1600A",
        "Feeder ACB, electronic trip LSIG",
        "1600 A, 65 kA",
        8,
        "ea",
        "UPS / chiller feeders",
    ),
    (
        "BKR-FDR-800A",
        "Feeder MCCB, electronic trip LSI",
        "800 A, 65 kA",
        16,
        "ea",
        "PDU / mech feeders",
    ),
    (
        "ATS-1200A-4P",
        "Automatic transfer switch, 4-pole, open transition",
        "1200 A",
        4,
        "ea",
        "ATS-1..4 gen backup",
    ),
    (
        "MTR-PQ-02S",
        "Power quality meter, Modbus TCP",
        "Class 0.2S",
        10,
        "ea",
        "Incomers, ties, ATS",
    ),
    ("SPD-T1-200KA", "Surge protective device Type 1+2", "200 kA", 4, "ea", "One per main bus"),
    (
        "BUSWAY-4000A-CU",
        "Sandwich busway, copper, IP54",
        "4000 A",
        120,
        "m",
        "TX to SWGR, 4 runs x 30 m",
    ),
]


def _title_block(c: Canvas, w: float, sheet: str, sheet_title: str) -> None:
    c.setStrokeColor(colors.black)
    c.setLineWidth(0.8)
    c.rect(10 * mm, 10 * mm, w - 20 * mm, 18 * mm)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(13 * mm, 22 * mm, "PROJECT ALPHA - 24 MW TIER-III DATA CENTRE, CHAKAN MIDC, PUNE")
    c.setFont("Helvetica", 7)
    c.drawString(13 * mm, 17 * mm, f"Doc {DOC_NO}  Rev {REV}   Sheet {sheet}   {sheet_title}")
    c.drawString(
        13 * mm,
        13 * mm,
        "Prepared: Alpha EPC Electrical  |  Checked: MEP Lead  |  "
        "Synthetic document for SiteMind demo - not for construction",
    )


def page_cover(c: Canvas) -> None:
    w, h = A4
    c.setFont("Helvetica-Bold", 20)
    c.drawCentredString(w / 2, h - 60 * mm, "PROJECT ALPHA")
    c.setFont("Helvetica", 12)
    c.drawCentredString(
        w / 2, h - 70 * mm, "24 MW Tier-III Data Centre - Chakan MIDC Phase II, Pune"
    )
    c.setFont("Helvetica-Bold", 14)
    c.drawCentredString(w / 2, h - 95 * mm, "480 V Low-Voltage Switchgear Package")
    c.setFont("Helvetica", 11)
    c.drawCentredString(
        w / 2, h - 103 * mm, "Technical Specification, Single-Line Diagram & Equipment Schedule"
    )
    c.drawCentredString(w / 2, h - 115 * mm, f"Document No. {DOC_NO}   Revision {REV}")
    data = [
        ["Rev", "Date", "Description", "By", "Chk"],
        ["A", "2026-11-02", "Issued for review", "RK", "SD"],
        ["B", "2026-12-14", "Issued for tender (RFQ)", "RK", "SD"],
    ]
    t = Table(data, colWidths=[15 * mm, 28 * mm, 70 * mm, 15 * mm, 15 * mm])
    t.setStyle(
        TableStyle(
            [
                ("GRID", (0, 0), (-1, -1), 0.5, colors.black),
                ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
                ("FONT", (0, 1), (-1, -1), "Helvetica", 9),
                ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
            ]
        )
    )
    tw, _ = t.wrap(0, 0)
    t.drawOn(c, (w - tw) / 2, h - 165 * mm)
    c.setFont("Helvetica", 9)
    c.drawCentredString(
        w / 2,
        45 * mm,
        "Required on site (energisation window): 2027-07-30   |   PO to be placed by: 2027-03-15",
    )
    _title_block(c, w, "1 of 4", "COVER SHEET")
    c.showPage()


GENERAL = [
    (
        "1. Scope",
        "Design, manufacture, type-test, factory acceptance test (FAT), supply and delivery "
        "to site of the 480 V low-voltage switchgear package for Data Hall Blocks A and B, "
        "including main "
        "lineups, bus-tie breakers, feeder breakers, automatic transfer switches, metering, surge "
        "protection and copper busway as listed in the Equipment Schedule (Sheet 4).",
    ),
    (
        "2. System",
        "480 V, 3-phase, 3-wire + PE, 50 Hz, TN-S. Short-circuit withstand 65 kA for 1 s. "
        "Main busbar 4000 A copper, tin-plated. Form 4b type 6 internal separation. IP42 indoor.",
    ),
    (
        "3. Standards",
        "IEC 61439-1/-2 (type-tested assemblies), IEC 60947-2 (breakers), IEC 60947-6-1 "
        "(ATS), IEC 61643-11 (SPD), IEC 61439-6 (busway), IS/IEC 60947 where applicable. Arc-fault "
        "containment per IEC TR 61641, 65 kA 0.5 s.",
    ),
    (
        "4. Redundancy",
        "2N topology: Block A and Block B lineups each fed from a dedicated 3000 kVA "
        "transformer; normally-open tie breakers allow either transformer to carry both lineups.",
    ),
    (
        "5. Submittals",
        "General arrangement, single-line, wiring and protection coordination study "
        "within 14 days of PO; Engineer review period 10 days. Manufacture shall not start before "
        "approval of shop drawings.",
    ),
    (
        "6. Testing",
        "Routine tests per IEC 61439. Witnessed FAT (5 days) at the manufacturer's works "
        "with Owner and Engineer. Type-test certificates from an accredited lab (CPRI / KEMA / "
        "ASTA).",
    ),
    (
        "7. Delivery",
        "Deliver DAP site, Chakan MIDC Phase II, Pune 410501, in shipping splits not "
        "exceeding 2.4 m, on or before 2027-07-30 (energisation window). Liquidated damages 0.5 "
        "% per "
        "week of delay, capped at 10 % of order value.",
    ),
    (
        "8. Warranty",
        "24 months from energisation or 30 months from delivery, whichever is earlier. "
        "Critical spares list and 5-year spares pricing to be submitted with the offer.",
    ),
    (
        "9. Commercial",
        "Prices firm in INR ex-works, freight quoted separately, GST extra at 18 %. "
        "Quote validity minimum 14 days. Bidders shall state lead time from shop-drawing approval.",
    ),
]


def page_general(c: Canvas) -> None:
    w, h = A4
    styles = getSampleStyleSheet()
    body = ParagraphStyle(
        "b", parent=styles["BodyText"], fontName="Helvetica", fontSize=9.5, leading=13
    )
    head = ParagraphStyle("h", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=13)
    y = h - 25 * mm
    p = Paragraph("SECTION 26 23 00 - GENERAL REQUIREMENTS", head)
    _, ph = p.wrap(w - 40 * mm, 100)
    p.drawOn(c, 20 * mm, y - ph)
    y -= ph + 6 * mm
    for title, text in GENERAL:
        para = Paragraph(f"<b>{title}.</b> {text}" if not title.endswith(".") else text, body)
        _, ph = para.wrap(w - 40 * mm, 200)
        para.drawOn(c, 20 * mm, y - ph)
        y -= ph + 4 * mm
    _title_block(c, w, "2 of 4", "GENERAL REQUIREMENTS")
    c.showPage()


def _breaker(c: Canvas, x: float, y: float, s: float = 6) -> None:
    """Draw a breaker symbol (small square) centred on x, y."""
    c.rect(x - s / 2, y - s / 2, s, s)


def page_sld(c: Canvas) -> None:
    w, h = landscape(A3)
    c.setPageSize((w, h))
    c.setFont("Helvetica-Bold", 14)
    c.drawString(
        20 * mm, h - 18 * mm, "SINGLE-LINE DIAGRAM - 480 V SWITCHGEAR, DATA HALL BLOCKS A & B"
    )
    c.setLineWidth(1)
    lineups = ["A1", "A2", "B1", "B2"]
    spd_on = {"A1", "A2", "B1"}  # SPD on B2 omitted on the drawing (discrepancy vs schedule)
    col_w = (w - 60 * mm) / 4
    bus_y = h - 95 * mm
    for i, lu in enumerate(lineups):
        x0 = 30 * mm + i * col_w
        cx = x0 + col_w / 2
        block = lu[0]
        # transformer
        c.circle(cx - 4, h - 35 * mm, 9)
        c.circle(cx + 4, h - 35 * mm, 9)
        c.setFont("Helvetica", 7)
        c.drawString(cx + 16, h - 34 * mm, f"TX-{lu} 3000 kVA 11/0.48 kV")
        # busway
        c.setDash(3, 2)
        c.line(cx, h - 39 * mm, cx, h - 62 * mm)
        c.setDash()
        c.drawString(cx + 5, h - 50 * mm, f"BD-{lu} BUSWAY 4000A CU 30 m")
        # incomer
        _breaker(c, cx, h - 66 * mm, 9)
        c.drawString(cx + 8, h - 67 * mm, f"SWGR-{lu} 4000A 65kA INCOMER")
        c.drawString(cx + 8, h - 71 * mm, f"PQM-{lu}")
        c.line(cx, h - 70 * mm, cx, bus_y)
        # main bus
        c.setLineWidth(3)
        c.line(x0 + 4 * mm, bus_y, x0 + col_w - 4 * mm, bus_y)
        c.setLineWidth(1)
        c.setFont("Helvetica-Bold", 8)
        c.drawString(x0 + 5 * mm, bus_y + 3, f"MAIN BUS {lu} 4000A")
        c.setFont("Helvetica", 7)
        if lu in spd_on:
            c.line(x0 + col_w - 10 * mm, bus_y, x0 + col_w - 10 * mm, bus_y + 12 * mm)
            c.drawString(x0 + col_w - 26 * mm, bus_y + 13 * mm, f"SPD-{lu} 200kA")
        # feeders: 2 x 1600 A + 4 x 800 A per lineup
        feeders = [
            ("01", "1600A"),
            ("02", "1600A"),
            ("03", "800A"),
            ("04", "800A"),
            ("05", "800A"),
            ("06", "800A"),
        ]
        fx = x0 + 10 * mm
        c.line(fx, bus_y, fx, bus_y - (len(feeders) + 0.5) * 9 * mm)
        for k, (n, rating) in enumerate(feeders):
            fy = bus_y - (k + 1) * 9 * mm
            c.line(fx, fy, fx + 8 * mm, fy)
            _breaker(c, fx + 10 * mm, fy)
            c.line(fx + 12 * mm, fy, fx + 18 * mm, fy)
            c.drawString(fx + 20 * mm, fy - 2.5, f"FDR {lu}-{n} {rating}")
        # ATS (one per block pair column A1/B1 etc.)
        c.rect(cx + 8 * mm, bus_y - 66 * mm, 22 * mm, 10 * mm)
        c.drawString(cx + 10 * mm, bus_y - 62 * mm, f"ATS-{i + 1} 1200A 4P")
        c.drawString(cx + 10 * mm, bus_y - 70 * mm, f"PQM-ATS{i + 1}")
        c.drawString(cx + 8 * mm, bus_y - 76 * mm, f"GEN-{block}{i % 2 + 1} (by others)")
    # tie breakers between A1-A2 and B1-B2
    c.setFont("Helvetica", 7)
    for j, tie in enumerate(["TIE-A", "TIE-B"]):
        x = 30 * mm + (2 * j + 1) * col_w
        _breaker(c, x, bus_y, 9)
        c.drawString(x - 12 * mm, bus_y - 9 * mm, f"{tie} 4000A 65kA N.O.")
        c.drawString(x - 12 * mm, bus_y - 13 * mm, f"PQM-{tie}")
    c.setFont("Helvetica", 7)
    notes = [
        "NOTES: 1. Breaker symbols: square = draw-out ACB / MCCB. 2. Busway runs BD-xx are 4000 "
        "A copper, "
        "lengths indicative (verify on site).",
        "3. Device ratings per Equipment Schedule, Sheet 4. Where drawing and schedule differ, the "
        "schedule governs and an RFI shall be raised.",
    ]
    for k, n in enumerate(notes):
        c.drawString(20 * mm, 40 * mm - k * 5 * mm, n)
    _title_block(c, w, "3 of 4", "SINGLE-LINE DIAGRAM")
    c.showPage()


def page_schedule(c: Canvas) -> None:
    w, h = landscape(A4)
    c.setPageSize((w, h))
    c.setFont("Helvetica-Bold", 13)
    c.drawString(15 * mm, h - 18 * mm, "EQUIPMENT SCHEDULE - 480 V SWITCHGEAR PACKAGE")
    c.setFont("Helvetica", 8)
    c.drawString(
        15 * mm,
        h - 24 * mm,
        "Table 1. Quantities for tender. Unit 'ea' = each, 'm' = linear metre.",
    )
    data: list[list[str]] = [
        ["Item", "Item Code", "Description", "Rating", "Qty", "Unit", "Remarks"]
    ]
    for i, (code, desc, rating, qty, unit, rem) in enumerate(SCHEDULE, start=1):
        data.append([str(i), code, desc, rating, str(qty), unit, rem])
    t = Table(data, colWidths=[11 * mm, 36 * mm, 85 * mm, 28 * mm, 13 * mm, 12 * mm, 50 * mm])
    t.setStyle(
        TableStyle(
            [
                ("GRID", (0, 0), (-1, -1), 0.5, colors.black),
                ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8.5),
                ("FONT", (0, 1), (-1, -1), "Helvetica", 8),
                ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
                ("ALIGN", (4, 1), (4, -1), "RIGHT"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    _, th = t.wrap(0, 0)
    t.drawOn(c, 15 * mm, h - 30 * mm - th)
    c.setFont("Helvetica", 8)
    c.drawString(
        15 * mm,
        h - 38 * mm - th,
        "All breakers draw-out, motorised, with communication module. Spare feeder cubicles "
        "(2 per lineup) fully equipped are included in the lineup price.",
    )
    _title_block(c, w, "4 of 4", "EQUIPMENT SCHEDULE")
    c.showPage()


def build(out: Path = OUT) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    c = Canvas(str(out), pagesize=A4, invariant=1)
    c.setTitle(f"{DOC_NO} Rev {REV} - {TITLE}")
    c.setAuthor("Alpha EPC Electrical (synthetic)")
    c.setSubject("Project Alpha 480 V switchgear")
    page_cover(c)
    page_general(c)
    page_sld(c)
    page_schedule(c)
    c.save()
    return out


if __name__ == "__main__":
    path = build(Path(sys.argv[1]) if len(sys.argv) > 1 else OUT)
    print(path)
