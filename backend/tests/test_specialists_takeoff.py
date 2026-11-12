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
