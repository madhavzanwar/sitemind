from datetime import datetime, timedelta, timezone

import pytest

from sitemind.specialists import (
    SPEC_PDF,
    VendorNetwork,
    VendorTimeout,
    collect_quotes,
    load_scenario,
    refresh_quotes,
    run_takeoff,
)

IST = timezone(timedelta(hours=5, minutes=30))
NOW = datetime(2027, 1, 11, 9, 0, tzinfo=IST)
LINES = run_takeoff(SPEC_PDF).lines


def test_v1_times_out_twice_then_answers() -> None:
    net = VendorNetwork(load_scenario("demo"))
    for attempt in (1, 2):
        with pytest.raises(VendorTimeout) as ei:
            net.request_quote("V1", LINES, attempt, NOW)
        assert ei.value.vendor_id == "V1"
    q = net.request_quote("V1", LINES, 3, NOW)
    assert q.status == "received" and q.total_inr == 35_475_400.0 and q.lead_time_days == 140


def test_collect_quotes_records_attempts() -> None:
    net = VendorNetwork(load_scenario("demo"))
    res = collect_quotes(net, ["V1", "V2", "V3"], LINES, NOW, retry_interval=timedelta(hours=24))
    outcomes = [(a.vendor_id, a.attempt, a.outcome) for a in res.attempts]
    assert outcomes == [
        ("V1", 1, "timeout"),
        ("V1", 2, "timeout"),
        ("V1", 3, "ok"),
        ("V2", 1, "ok"),
        ("V3", 1, "ok"),
    ]
    assert res.attempts[2].at == NOW + timedelta(hours=48)
    totals = {q.vendor_id: q.total_inr for q in res.quotes}
    assert totals == {"V1": 35_475_400.0, "V2": 38_651_400.0, "V3": 37_258_400.0}


def test_fallback_after_max_attempts() -> None:
    net = VendorNetwork(load_scenario("demo"))
    res = collect_quotes(net, ["V1", "V2"], LINES, NOW, max_attempts=2)
    v1 = res.quotes[0]
    assert v1.status == "timeout" and v1.total_inr == 0 and not v1.lines
    assert res.quotes[1].status == "received"
    assert [a.outcome for a in res.attempts if a.vendor_id == "V1"] == ["timeout", "timeout"]


def test_v2_revision_on_refresh_is_deterministic_and_once() -> None:
    net = VendorNetwork(load_scenario("demo"))
    q = net.request_quote("V2", LINES, 1, NOW)
    r1 = net.refresh_quote("V2", q, NOW + timedelta(days=3))
    r2 = net.refresh_quote("V2", q, NOW + timedelta(days=3))
    assert r1 == r2
    assert r1.status == "revised" and r1.revision == 2 and r1.total_inr == 44_166_800.0
    # each unit price = list price x 1.11 (discount withdrawn)
    assert r1.lines[0].unit_price_inr == round(5_252_000 * 1.11 / 100) * 100
    assert net.refresh_quote("V2", r1, NOW + timedelta(days=4)) == r1  # no second revision
    quotes, log = refresh_quotes(net, [q], NOW)
    assert log[0].outcome == "revised" and quotes[0].revision == 2


def test_happy_scenario_has_no_failures() -> None:
    net = VendorNetwork(load_scenario("happy"))
    res = collect_quotes(net, net.vendor_ids(), LINES, NOW)
    assert all(a.outcome == "ok" and a.attempt == 1 for a in res.attempts)
    quotes, log = refresh_quotes(net, res.quotes, NOW)
    assert all(a.outcome == "ok" for a in log) and quotes == res.quotes


def test_expedite_offer_only_v3() -> None:
    offers = VendorNetwork(load_scenario("demo")).expedite_offers()
    assert list(offers) == ["V3"]
    assert offers["V3"].days_saved == 42 and offers["V3"].fee_inr == 2_600_000


def test_unknown_scenario() -> None:
    with pytest.raises(ValueError):
        load_scenario("nope")
