"""Package abstraction, the dg-2mw package, overrides/apply_event and rate-card pricing."""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone

import pytest

from sitemind.models import Goal, TakeoffLine
from sitemind.specialists import (
    SPEC_PDF,
    VendorNetwork,
    build_decision_memo,
    check_budget,
    classify_line,
    collect_quotes,
    draft_po,
    get_package,
    list_packages,
    load_package_catalog,
    load_package_scenario,
    load_scenario,
    load_vendors,
    match_package,
    package_for_vendor,
    package_spec_pdf,
    rank_options,
    refresh_quotes,
    run_takeoff,
    schedule_for_quote,
    vendor_profile,
)

IST = timezone(timedelta(hours=5, minutes=30))
NOW = datetime(2027, 1, 11, 9, 0, tzinfo=IST)
PO = date(2027, 1, 20)
DG = "dg-2mw"


def test_list_and_get_packages() -> None:
    ids = [p.package_id for p in list_packages()]
    assert ids == ["swgr-480v", DG]
    dg = get_package(DG)
    assert dg.vendor_ids == ["D1", "D2", "D3"]
    assert dg.default_budget_inr == 380_000_000 and dg.default_need_by == date(2027, 4, 30)
    assert dg.required_on_site == date(2027, 11, 15)
    assert package_spec_pdf(DG).is_file() and package_spec_pdf("swgr-480v") == SPEC_PDF
    with pytest.raises(KeyError):
        get_package("chillers")


def test_default_package_aliases_unchanged() -> None:
    assert load_vendors() == load_package_catalog("swgr-480v")
    assert load_scenario("demo") == load_package_scenario("swgr-480v", "demo")
    assert vendor_profile("V2")["name"] == "Kestrel Power Systems"
    assert vendor_profile("D2")["name"] == "Corvane Diesel Systems"
    assert package_for_vendor("D3") == DG
    with pytest.raises(ValueError):
        load_package_scenario(DG, "chaos")


@pytest.mark.parametrize(
    ("text", "pid"),
    [
        ("Get the 2 MW DG sets for Project Alpha", DG),
        ("diesel gensets", DG),
        ("480 V switchgear package", "swgr-480v"),
        ("LV switchboard and busway", "swgr-480v"),
        ("chilled water plant", None),
    ],
)
def test_match_package(text: str, pid: str | None) -> None:
    got, conf, kw = match_package(text)
    assert got == pid
    assert (conf > 0.5 and kw) if pid else (conf == 0 and kw is None)


def test_classify_line() -> None:
    assert classify_line(TakeoffLine(item_code="X-1", description="Feeder MCCB", qty=1)) == (
        "swgr-480v",
        "breaker",
    )
    assert classify_line(TakeoffLine(item_code="DG-2000-11KV", description="", qty=1), DG) == (
        DG,
        "genset",
    )
    assert classify_line(TakeoffLine(item_code="CH-1", description="Chiller", qty=1)) is None


def _dg_quotes(scenario: str = "demo", overrides: dict | None = None):  # type: ignore[no-untyped-def,type-arg]
    t = run_takeoff(package_spec_pdf(DG), DG)
    net = VendorNetwork(load_package_scenario(DG, scenario), overrides=overrides)
    return t, net, collect_quotes(net, net.vendor_ids(), t.lines, NOW)


def _rank(net: VendorNetwork, quotes):  # type: ignore[no-untyped-def]
    pkg = get_package(DG)
    s = [schedule_for_quote(q, PO, pkg.required_on_site) for q in quotes]
    b = [check_budget(q, pkg.default_budget_inr) for q in quotes]
    return rank_options(quotes, s, b, net.expedite_offers()), b


def test_dg_demo_numbers_and_replan_path() -> None:
    t, net, res = _dg_quotes()
    totals = {q.vendor_id: (q.total_inr, q.lead_time_days) for q in res.quotes}
    assert totals == {
        "D1": (292_571_200.0, 245),
        "D2": (320_612_000.0, 180),
        "D3": (303_548_000.0, 240),
    }
    assert net.missing_documents("D1") == ["CPCB IV+ emissions type-approval certificate"]
    assert "Missing document" in res.quotes[0].notes
    opts, budgets = _rank(net, res.quotes)
    assert [o.option_id for o in opts] == ["O-D2", "O-D3", "O-D1"] and opts[0].recommended
    assert all(b.verdict == "ok" for b in budgets)
    # refresh: D2 +15 % -> breach, D3 slips 45 d -> late => re-plan picks D1 (doc chase)
    quotes, log = refresh_quotes(net, res.quotes, NOW + timedelta(days=3))
    assert [a.outcome for a in log] == ["ok", "revised", "revised"]
    by = {q.vendor_id: q for q in quotes}
    assert by["D2"].total_inr == 368_373_600.0 and by["D3"].lead_time_days == 285
    opts, budgets = _rank(net, quotes)
    o = {x.option_id: x for x in opts}
    assert o["O-D1"].recommended and o["O-D1"].float_days == 18
    assert o["O-D2"].budget_verdict == "breach" and o["O-D3"].float_days == -22
    assert "submittal incomplete" in o["O-D1"].rationale
    pkg = get_package(DG)
    goal = Goal(
        text=pkg.default_goal_text,
        package=pkg.title,
        need_by=pkg.default_need_by,
        required_on_site=pkg.required_on_site,
        budget_inr=pkg.default_budget_inr,
    )
    memo = build_decision_memo(goal, opts, "D2 revised, D3 slipped")
    assert memo.recommendation == "O-D1"
    assert any("PO release is blocked" in r for r in memo.risks)
    po = draft_po(goal, o["O-D1"], by["D1"], t, "PO-ALPHA-DG-0001", PO)
    assert po.total_inr == pytest.approx(345_234_016.0)
    assert any("ISO 8528" in term for term in po.terms)
    assert not any("IEC 61439" in term for term in po.terms)


def test_dg_happy_has_no_failures() -> None:
    _, net, res = _dg_quotes("happy")
    quotes, log = refresh_quotes(net, res.quotes, NOW)
    assert all(a.outcome == "ok" for a in log) and quotes == res.quotes
    assert net.missing_documents("D1") == []
    opts, _ = _rank(net, quotes)
    assert opts[0].option_id == "O-D2" and opts[0].recommended


# ------------------------------------------------------------------ overrides / apply_event


def test_apply_event_is_json_and_replay_safe() -> None:
    net = VendorNetwork(load_scenario("happy"))
    lines = run_takeoff(SPEC_PDF).lines
    q = net.request_quote("V2", lines, 1, NOW)
    assert "Kestrel" in net.apply_event("price_change", "V2", {"pct": 8})
    net.apply_event("lead_slip", "V2", {"days": 20})
    net.apply_event("delay_reply", "V2", {"days": 3})
    net.apply_event("missing_document", "V2", {"document": "type-test certificate"})
    net.apply_event("timeout", "V1", {"count": 2})
    ov = json.loads(json.dumps(net.overrides))  # round-trips through JSON
    assert ov == net.overrides
    r1 = net.refresh_quote("V2", q, NOW + timedelta(days=1))
    assert r1.revision == 2 and r1.status == "revised" and r1.lead_time_days == 112 + 20
    assert r1.lines[0].unit_price_inr == round(q.lines[0].unit_price_inr * 1.08 / 100) * 100
    assert "Missing document: type-test certificate." in r1.notes
    assert net.response_hours("V2") == 20 + 72
    assert net.will_timeout("V1", 1) and net.will_timeout("V1", 2) and not net.will_timeout("V1", 3)
    # a fresh network built from the stored overrides behaves identically (restart)
    net2 = VendorNetwork(load_scenario("happy"), overrides=ov)
    assert net2.refresh_quote("V2", q, NOW + timedelta(days=1)) == r1
    assert net2.refresh_quote("V2", r1, NOW + timedelta(days=2)) == r1  # idempotent
    net2.apply_event("document_received", "V2", {"document": "type-test certificate"})
    assert net2.missing_documents("V2") == []
    assert net.overrides["vendors"]["V2"]["price_changes_pct"] == [8.0]  # copy, not alias


def test_event_aliases_and_errors() -> None:
    net = VendorNetwork(load_package_scenario(DG, "demo"))
    net.apply_event("date_slip", "D2", {"days": 10})
    net.apply_event("vendor_late_reply", "D2", {"days": 1})
    net.apply_event("document_missing", "D3", {"document": "PESO approval"})
    assert net.overrides["vendors"]["D2"]["lead_slip_days"] == 10
    assert net.missing_documents("D3") == ["PESO approval"]
    with pytest.raises(ValueError):
        net.apply_event("earthquake", "D1", {})
    with pytest.raises(KeyError):
        net.apply_event("lead_slip", "V1", {"days": 1})  # V1 is not a DG vendor


def test_injected_timeouts_feed_collect_quotes() -> None:
    _, net, _ = _dg_quotes("happy")
    net.apply_event("timeout", "D2", {"count": 3})
    t = run_takeoff(package_spec_pdf(DG), DG)
    res = collect_quotes(net, ["D2"], t.lines, NOW, max_attempts=3)
    assert res.quotes[0].status == "timeout"


# ------------------------------------------------------------------ rate card


def test_rate_card_prices_non_catalogue_items() -> None:
    net = VendorNetwork(load_scenario("happy"))
    lines = [
        TakeoffLine(item_code="BKR-FDR-400A", description="Feeder MCCB", qty=6, rating="400 A"),
        TakeoffLine(item_code="SWGR-MAIN-4000A", description="Main lineup", qty=1),
        TakeoffLine(item_code="CH-1", description="Centrifugal chiller", qty=2),
    ]
    q = net.request_quote("V1", lines, 3, NOW)  # V1 answers attempt 3 in any scenario
    codes = {ln.item_code: ln for ln in q.lines}
    assert set(codes) == {"BKR-FDR-400A", "SWGR-MAIN-4000A"}
    assert codes["BKR-FDR-400A"].unit_price_inr == round(400 * 390 * 0.91 / 100) * 100
    assert "Rate-card estimate: BKR-FDR-400A (breaker" in q.notes
    assert "Not quoted" in q.notes and "CH-1" in q.notes
    # refresh without takeoff lines re-derives the estimate from the recorded base
    net.apply_event("price_change", "V1", {"pct": 10})
    r = net.refresh_quote("V1", q, NOW)
    rc = {ln.item_code: ln for ln in r.lines}["BKR-FDR-400A"]
    assert rc.unit_price_inr == round(codes["BKR-FDR-400A"].unit_price_inr * 1.1 / 100) * 100


def test_dg_rate_card_per_kva() -> None:
    net = VendorNetwork(load_package_scenario(DG, "happy"))
    ln = TakeoffLine(
        item_code="DG-1500", description="Diesel generator set", qty=1, rating="1500 kVA"
    )
    q = net.request_quote("D3", [ln], 1, NOW)
    assert q.lines[0].unit_price_inr == round(1500 * 24800 * 0.98 / 100) * 100
