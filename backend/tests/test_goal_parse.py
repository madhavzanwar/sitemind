"""Deterministic goal parsing: phrasings, Indian number formats, missing fields, handoff."""

from __future__ import annotations

from datetime import date

import pytest

from sitemind.specialists import list_packages, parse_goal

TODAY = date(2026, 11, 16)


@pytest.mark.parametrize(
    ("text", "pid", "project", "need_by", "budget"),
    [
        (
            "Get the 480 V switchgear package for Project Alpha ordered by 2027-03-15 within "
            "budget ₹4.6 Cr",
            "swgr-480v",
            "Project Alpha",
            date(2027, 3, 15),
            46_000_000,
        ),
        (
            "Get the 2 MW DG sets for Project Alpha ordered by 2027-04-30 within budget ₹38 Cr",
            "dg-2mw",
            "Project Alpha",
            date(2027, 4, 30),
            380_000_000,
        ),
        (
            "Order switchgear for the Alpha project by 15 March 2027, budget Rs 46,00,000",
            "swgr-480v",
            "Project Alpha",
            date(2027, 3, 15),
            4_600_000,
        ),
        (
            "Need gensets for Project Beta by March 15, 2027 with a budget of 4.6 crore",
            "dg-2mw",
            "Project Beta",
            date(2027, 3, 15),
            46_000_000,
        ),
        (
            "Procure diesel generators for Project Alpha before 30/04/2027, max 460 lakh",
            "dg-2mw",
            "Project Alpha",
            date(2027, 4, 30),
            46_000_000,
        ),
        (
            "Buy LV switchboard for Project X, INR 46000000, PO by 2027-03-15, on site by "
            "2027-07-30",
            "swgr-480v",
            "Project X",
            date(2027, 3, 15),
            46_000_000,
        ),
        (
            "Place the order for DG sets (Project Alpha) by 1st April 2027; budget Rs. 38 crores",
            "dg-2mw",
            "Project Alpha",
            date(2027, 4, 1),
            380_000_000,
        ),
        (
            "Get 4 x 2 MW gensets for Project Alpha ordered in 10 weeks within budget 46 million",
            "dg-2mw",
            "Project Alpha",
            date(2027, 1, 25),
            46_000_000,
        ),
        (
            "switchgear for Project Alpha, order by Mar 1 2027, ceiling ₹3,80,00,000",
            "swgr-480v",
            "Project Alpha",
            date(2027, 3, 1),
            38_000_000,
        ),
        (
            "Get the switchgear for Project Alpha by 2027-03-15 within ₹46 lakh",
            "swgr-480v",
            "Project Alpha",
            date(2027, 3, 15),
            4_600_000,
        ),
    ],
)
def test_phrasings(text: str, pid: str, project: str, need_by: date, budget: float) -> None:
    r = parse_goal(text, TODAY)
    assert (r.package_id, r.project, r.need_by, r.budget_inr) == (pid, project, need_by, budget)
    assert r.supported and not r.missing
    assert r.confidence >= 0.85
    for field, span in r.evidence.items():
        assert span in text, field  # evidence is an exact span of the input
    assert set(r.evidence) == {"package", "project", "need_by", "budget_inr"}


def test_deterministic() -> None:
    t = "Get the 2 MW DG sets for Project Alpha ordered by 2027-04-30 within budget ₹38 Cr"
    assert parse_goal(t, TODAY) == parse_goal(t, TODAY)


def test_package_defaults_parse_back() -> None:
    for p in list_packages():
        r = parse_goal(p.default_goal_text, TODAY)
        assert r.package_id == p.package_id
        assert r.need_by == p.default_need_by and r.budget_inr == p.default_budget_inr
        assert r.project == p.default_project


def test_missing_fields_become_questions() -> None:
    r = parse_goal("switchgear please", TODAY)
    assert r.package_id == "swgr-480v"
    assert r.missing == ["project", "need_by", "budget_inr"]
    assert len(r.questions) == 3 and r.need_by is None and r.budget_inr is None
    assert r.confidence < 0.5


def test_never_invents_values() -> None:
    r = parse_goal("Get the DG sets for Project Alpha by end of April 2027 within budget 38", TODAY)
    assert r.need_by is None and r.budget_inr is None
    assert {"need_by", "budget_inr"} <= set(r.missing)
    assert any("2027-04-30" in q for q in r.questions)  # suggested, not assumed
    assert any("no currency" in q for q in r.questions)
    site_only = parse_goal(
        "Deliver switchgear on site by 2027-07-30 for Project Alpha, ₹4.6 Cr", TODAY
    )
    assert site_only.need_by is None and "need_by" in site_only.missing
    bad = parse_goal("Order switchgear for Project Alpha by 2027-02-30 within ₹4.6 Cr", TODAY)
    assert bad.need_by is None and any("not a valid date" in q for q in bad.questions)
    assert (
        parse_goal("Order switchgear for Project Alpha within 30 m of cable", TODAY).budget_inr
        is None
    )


def test_past_date_is_questioned() -> None:
    r = parse_goal("Order switchgear for Project Alpha by 2026-01-15 within ₹4.6 Cr", TODAY)
    assert r.need_by == date(2026, 1, 15)
    assert any("in the past" in q for q in r.questions)


def test_unknown_package_hands_off() -> None:
    r = parse_goal("Get the chillers for Project Alpha ordered by 2027-05-01 within ₹12 Cr", TODAY)
    assert r.supported is False and r.package_id is None and r.package == "chillers"
    assert r.evidence["package"] == "chillers"
    assert any("human" in q for q in r.questions)
    assert r.budget_inr == 120_000_000 and r.need_by == date(2027, 5, 1)
    none = parse_goal("Sort it out by 2027-05-01", TODAY)
    assert "package" in none.missing and none.supported
