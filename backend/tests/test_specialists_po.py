from datetime import date, datetime, timedelta, timezone

import pytest

from sitemind.models import Goal
from sitemind.specialists import (
    REGISTRY,
    SPEC_PDF,
    VendorNetwork,
    check_budget,
    collect_quotes,
    draft_po,
    get_specialist,
    load_scenario,
    rank_options,
    run_takeoff,
    schedule_for_quote,
)

IST = timezone(timedelta(hours=5, minutes=30))
NOW = datetime(2027, 1, 11, 9, 0, tzinfo=IST)
ROS = date(2027, 7, 30)
GOAL = Goal(text="g", need_by=date(2027, 3, 15), required_on_site=ROS, budget_inr=46_000_000)


def _setup(option_id: str):  # type: ignore[no-untyped-def]
    t = run_takeoff(SPEC_PDF)
    net = VendorNetwork(load_scenario("demo"))
    quotes = collect_quotes(net, net.vendor_ids(), t.lines, NOW).quotes
    opts = rank_options(
        quotes,
        [schedule_for_quote(q, date(2027, 1, 20), ROS) for q in quotes],
        [check_budget(q, 46_000_000) for q in quotes],
        net.expedite_offers(),
    )
    opt = next(o for o in opts if o.option_id == option_id)
    q = next(q for q in quotes if q.vendor_id == opt.vendor_id)
    return t, opt, q


def test_po_totals_add_up_with_expedite() -> None:
    t, opt, q = _setup("O-V3X")
    po = draft_po(GOAL, opt, q, t, "PA-PO-480-0001", date(2027, 1, 20))
    assert len(po.lines) == len(t.lines) == 8
    assert all(ln.total_inr == pytest.approx(ln.qty * ln.unit_price_inr) for ln in po.lines)
    assert po.subtotal_inr == pytest.approx(sum(ln.total_inr for ln in po.lines))
    assert po.subtotal_inr + po.freight_inr == pytest.approx(q.total_inr)
    taxable = po.subtotal_inr + po.freight_inr + po.expedite_fee_inr
    assert po.gst_inr == pytest.approx(taxable * 0.18)
    assert po.total_inr == pytest.approx(taxable * 1.18)
    assert po.total_inr == pytest.approx(47_032_912.0)
    assert po.delivery_date == opt.delivery_date and po.status == "draft"
    md = po.markdown
    for needle in (
        "# Purchase Order PA-PO-480-0001",
        "Chakan MIDC",
        "GST @ 18%",
        "Expedite fee",
        "0.5%",
        "24 months",
        "Approvals",
        "Anvil Electric India",
    ):
        assert needle in md
    assert any("capped at 10%" in term for term in po.terms)


def test_po_without_expedite_and_vendor_mismatch() -> None:
    t, opt, q = _setup("O-V1")
    po = draft_po(GOAL, opt, q, t, "PO-1", date(2027, 1, 20))
    assert po.expedite_fee_inr == 0 and "Expedite fee" not in po.markdown
    assert po.incoterms.startswith("DAP")
    _, opt3, _ = _setup("O-V3")
    with pytest.raises(ValueError):
        draft_po(GOAL, opt3, q, t, "PO-1", date(2027, 1, 20))


def test_registry() -> None:
    names = [s.name for s in REGISTRY]
    assert names == ["planner", "takeoff", "quotes", "schedule", "budget", "approvals", "po"]
    assert get_specialist("po").side_effects and get_specialist("takeoff").deterministic
    assert not get_specialist("planner").deterministic
    with pytest.raises(KeyError):
        get_specialist("nope")
