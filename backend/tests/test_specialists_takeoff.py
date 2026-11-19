from pathlib import Path

from sitemind.specialists import SPEC_PDF, run_takeoff
from sitemind.specialists.takeoff import cross_check

EXPECTED = {
    "SWGR-MAIN-4000A": (4, "ea"),
    "BKR-TIE-4000A": (2, "ea"),
    "BKR-FDR-1600A": (8, "ea"),
    "BKR-FDR-800A": (16, "ea"),
    "ATS-1200A-4P": (4, "ea"),
    "MTR-PQ-02S": (10, "ea"),
    "SPD-T1-200KA": (4, "ea"),
    "BUSWAY-4000A-CU": (120, "m"),
}


def test_sample_pdf_exists() -> None:
    assert Path(SPEC_PDF).is_file()


def test_takeoff_extracts_schedule_quantities() -> None:
    r = run_takeoff(SPEC_PDF)
    got = {ln.item_code: (ln.qty, ln.unit) for ln in r.lines}
    assert got == EXPECTED
    main = r.lines[0]
    assert main.rating == "4000 A, 65 kA"
    assert main.source.endswith("p4 table 1 row 1")
    assert all(ln.description for ln in r.lines)


def test_takeoff_flags_drawing_mismatch() -> None:
    r = run_takeoff(SPEC_PDF)
    assert len(r.warnings) == 1
    assert "SPD-T1-200KA" in r.warnings[0] and "shows 3" in r.warnings[0]
    assert r.confidence == 0.92


def test_cross_check_counts_and_linear_runs() -> None:
    r = run_takeoff(SPEC_PDF)
    text = "FDR A1-01 1600A FDR A1-01 1600A BD-A1 BUSWAY 4000A CU 30 m"
    warns = cross_check(
        [ln for ln in r.lines if ln.item_code in ("BKR-FDR-1600A", "BUSWAY-4000A-CU")], text, 3
    )
    assert any("shows 1 ea" in w for w in warns)  # duplicate tag counted once
    assert any("shows 30 m" in w for w in warns)


def test_takeoff_is_deterministic() -> None:
    assert run_takeoff(SPEC_PDF) == run_takeoff(str(SPEC_PDF))


# ------------------------------------------------------------------ v2: any PDF

FIXTURE = Path(__file__).parent / "fixtures" / "chiller_schedule_thirdparty.pdf"


def test_takeoff_dg_spec_different_layout() -> None:
    from sitemind.specialists import package_spec_pdf

    r = run_takeoff(package_spec_pdf("dg-2mw"))  # package auto-detected
    got = {ln.item_code: (ln.qty, ln.unit) for ln in r.lines}
    assert got == {
        "DG-2000-11KV": (4, "ea"),
        "ENCL-AC-75DBA": (4, "ea"),
        "TANK-DAY-990L": (4, "ea"),
        "SYNC-PNL-11KV": (1, "set"),
        "EXH-STACK-30M": (4, "set"),
        "NGR-11KV-200A": (4, "ea"),
        "CBL-11KV-3C300": (1200, "m"),
    }
    assert r.lines[0].rating == "2000 kWe / 2500 kVA"
    assert r.lines[4].source.endswith("p2 table 2 row 1")  # second table on the sheet
    assert len(r.warnings) == 1 and "1350 m" in r.warnings[0]  # datasheet cross-check
    assert r.confidence == 0.92
    assert r == run_takeoff(package_spec_pdf("dg-2mw"), "dg-2mw")


def test_takeoff_foreign_unruled_pdf() -> None:
    r = run_takeoff(FIXTURE)
    assert [(ln.item_code, ln.qty) for ln in r.lines] == [
        ("CH-1", 4),
        ("CHWP-1", 6),
        ("CT-1", 4),
        ("AHU-1", 12),
        ("EXP-1", 2),
    ]
    assert r.lines[0].description == "Water-cooled centrifugal chiller"
    assert r.lines[0].rating == "1000 TR"
    assert all(" p1 text row " in ln.source for ln in r.lines)
    assert any("page text" in w for w in r.warnings)
    assert sum("does not match a category" in w for w in r.warnings) == 5  # kept, flagged
    assert any("hand to a human" in w for w in r.warnings)
    assert r.confidence <= 0.5


def test_header_mapping_and_qty_parsing() -> None:
    from sitemind.specialists.takeoff import header_role, map_columns, parse_qty

    assert map_columns(
        ["Sl. No.", "Tag No", "Item Description", "Duty / Capacity", "No. Off", "UoM", "Remarks"]
    ) == {"code": 1, "description": 2, "rating": 3, "qty": 4, "unit": 5}
    assert header_role("Item") is None and header_role("Item Code") == "code"
    assert parse_qty("1,200 m") == (1200, "m") and parse_qty("4 Nos") == (4, "ea")
    assert parse_qty("TBC") is None
