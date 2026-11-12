from datetime import date, datetime, timedelta, timezone

import pytest

from sitemind.models import Goal
from sitemind.specialists import (
    SPEC_PDF,
    VendorNetwork,
    build_decision_memo,
    check_budget,
    collect_quotes,
    load_scenario,
    rank_options,
    refresh_quotes,
    run_takeoff,
    schedule_for_quote,
    score_option,
)

IST = timezone(timedelta(hours=5, minutes=30))
NOW = datetime(2027, 1, 11, 9, 0, tzinfo=IST)
PO, ROS, BUDGET = date(2027, 1, 20), date(2027, 7, 30), 46_000_000.0
GOAL = Goal(text="switchgear", need_by=date(2027, 3, 15), required_on_site=ROS, budget_inr=BUDGET)


def _options(refreshed: bool):  # type: ignore[no-untyped-def]
    net = VendorNetwork(load_scenario("demo"))
    quotes = collect_quotes(net, net.vendor_ids(), run_takeoff(SPEC_PDF).lines, NOW).quotes
    if refreshed:
        quotes, _ = refresh_quotes(net, quotes, NOW + timedelta(days=3))
    s = [schedule_for_quote(q, PO, ROS) for q in quotes]
    b = [check_budget(q, BUDGET) for q in quotes]
    return rank_options(quotes, s, b, net.expedite_offers()), b


def test_score_monotonic() -> None:
    assert score_option(0.8, 20, 0.9) > score_option(0.9, 20, 0.9)
    assert score_option(0.8, 20, 0.9) > score_option(0.8, 5, 0.9)
    assert score_option(0.8, 20, 0.9) > score_option(0.8, 20, 0.8)
    assert 0.0 <= score_option(2.0, -50, 0.1) <= score_option(0.5, 60, 1.0) <= 1.0


def test_initial_quotes_recommend_v2() -> None:
    opts, budgets = _options(refreshed=False)
    assert [o.option_id for o in opts] == ["O-V2", "O-V3X", "O-V1", "O-V3"]
    assert opts[0].recommended and sum(o.recommended for o in opts) == 1
    assert {b.vendor_id: b.verdict for b in budgets} == {"V1": "ok", "V2": "ok", "V3": "ok"}


def test_after_v2_revision_replan_recommends_v3_expedited() -> None:
    opts, budgets = _options(refreshed=True)
    by = {o.option_id: o for o in opts}
    assert {b.vendor_id: b.verdict for b in budgets}["V2"] == "breach"
    assert by["O-V2"].budget_verdict == "breach" and not by["O-V2"].recommended
    assert not by["O-V3"].meets_deadline and by["O-V3"].float_days == -13
    x = by["O-V3X"]
    assert x.recommended and x.float_days == 29 and x.budget_verdict == "warn"
    assert x.expedite_fee_inr == 2_600_000 and x.total_inr == 37_258_400 + 2_600_000
    assert by["O-V1"].float_days == 15 and by["O-V1"].budget_verdict == "ok"
    # infeasible options ranked last
    assert [o.option_id for o in opts][-2:] == ["O-V2", "O-V3"]


def test_decision_memo_weighs_tradeoffs() -> None:
    opts, _ = _options(refreshed=True)
    memo = build_decision_memo(GOAL, opts, "V2 revised +11% copper surcharge")
    assert memo.recommendation == "O-V3X"
    assert "O-V1" in memo.reasoning and "cheaper" in memo.reasoning
    assert "Rejected O-V2" in memo.reasoning and "Rejected O-V3" in memo.reasoning
    assert any("82%" in r for r in memo.risks)
    assert memo == build_decision_memo(GOAL, opts, "V2 revised +11% copper surcharge")
    custom = build_decision_memo(GOAL, opts, "s", prose="LLM text")
    assert custom.reasoning == "LLM text" and custom.recommendation == "O-V3X"


def test_memo_requires_options() -> None:
    with pytest.raises(ValueError):
        build_decision_memo(GOAL, [], "x")
