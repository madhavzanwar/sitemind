from datetime import date

import pytest

from sitemind.models import Quote, ScheduleActivity
from sitemind.specialists.schedule import (
    ScheduleError,
    critical_path,
    latest_po_date,
    schedule_for_lead_time,
    schedule_for_quote,
)


def _a(i: str, d: int, deps: list[str] | None = None) -> ScheduleActivity:
    return ScheduleActivity(id=i, name=i, duration_days=d, depends_on=deps or [])


def test_cpm_textbook_network() -> None:
    # A(3) -> B(4) -> D(2); A -> C(2) -> D ; C -> E(5)   (hand-checked)
    acts = critical_path(
        [
            _a("A", 3),
            _a("B", 4, ["A"]),
            _a("C", 2, ["A"]),
            _a("D", 2, ["B", "C"]),
            _a("E", 5, ["C"]),
        ]
    )
    by = {a.id: a for a in acts}
    assert (by["A"].early_start, by["A"].early_finish) == (0, 3)
    assert (by["B"].early_start, by["B"].early_finish) == (3, 7)
    assert (by["C"].early_start, by["C"].early_finish) == (3, 5)
    assert (by["D"].early_start, by["D"].early_finish) == (7, 9)
    assert (by["E"].early_start, by["E"].early_finish) == (5, 10)
    # project finish 10: E is critical, D has 1 day slack, B 1 day slack
    assert by["E"].late_finish == 10 and by["E"].slack_days == 0
    assert by["D"].late_start == 8 and by["D"].slack_days == 1
    assert by["B"].late_start == 4 and by["B"].slack_days == 1
    assert by["C"].slack_days == 0 and by["A"].slack_days == 0
    assert [a.id for a in acts if a.critical] == ["A", "C", "E"]


def test_cpm_deadline_anchor_gives_negative_slack() -> None:
    acts = critical_path([_a("A", 5), _a("B", 5, ["A"])], deadline_offset=8)
    assert all(a.slack_days == -2 for a in acts)
    assert all(a.critical for a in acts)


def test_cpm_rejects_cycles_and_unknown_deps() -> None:
    with pytest.raises(ScheduleError):
        critical_path([_a("A", 1, ["B"]), _a("B", 1, ["A"])])
    with pytest.raises(ScheduleError):
        critical_path([_a("A", 1, ["Z"])])


def test_procurement_chain_float_sign() -> None:
    ros = date(2027, 7, 30)
    po = date(2027, 1, 20)  # 191 days before ROS; chain = 36 + lead
    on_time = schedule_for_lead_time("V1", 140, po, ros)
    assert on_time.delivery_date == date(2027, 7, 15)
    assert on_time.float_days == 15 and on_time.meets_deadline
    assert on_time.critical_path == ["PO", "SUB", "APR", "MFG", "FAT", "SHP", "DEL"]
    itp = next(a for a in on_time.activities if a.id == "ITP")
    assert not itp.critical and itp.slack_days == 140 - 21
    late = schedule_for_lead_time("V3", 168, po, ros)
    assert late.float_days == -13 and not late.meets_deadline
    assert schedule_for_lead_time("V3", 168 - 42, po, ros).float_days == 29


def test_short_lead_time_moves_critical_path_to_itp() -> None:
    s = schedule_for_lead_time("X", 10, date(2027, 1, 1), date(2027, 12, 31))
    assert "ITP" in s.critical_path and "MFG" not in s.critical_path


def test_schedule_for_quote_and_latest_po_date() -> None:
    q = Quote(
        vendor_id="V2",
        vendor_name="K",
        quote_id="q",
        lines=[],
        total_inr=1.0,
        lead_time_days=112,
        valid_until=date(2027, 2, 1),
        reliability=0.93,
    )
    s = schedule_for_quote(q, date(2027, 1, 20), date(2027, 7, 30))
    assert s.float_days == 43 and s.vendor_id == "V2"
    last = latest_po_date(112, date(2027, 7, 30))
    assert schedule_for_lead_time("V2", 112, last, date(2027, 7, 30)).float_days == 0
