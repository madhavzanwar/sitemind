from datetime import date

import pytest

from sitemind.models import Quote, QuoteLine
from sitemind.specialists.budget import check_budget


def _q(total: float, status: str = "received") -> Quote:
    return Quote(
        vendor_id="VX",
        vendor_name="X",
        quote_id="Q-X",
        status=status,  # type: ignore[arg-type]
        lines=[QuoteLine(item_code="A", qty=1, unit_price_inr=total, total_inr=total)],
        total_inr=total,
        lead_time_days=100,
        valid_until=date(2027, 2, 1),
        reliability=0.9,
    )


@pytest.mark.parametrize(
    ("total", "fee", "verdict"),
    [
        (80.0, 0.0, "ok"),  # 84 %
        (85.0, 0.0, "ok"),  # 89.25 %
        (90.0, 0.0, "warn"),  # 94.5 %
        (80.0, 10.0, "warn"),  # 94 % with expedite fee
        (95.0, 0.0, "warn"),  # 99.75 %
        (100.0, 0.0, "breach"),  # 105 %
    ],
)
def test_thresholds(total: float, fee: float, verdict: str) -> None:
    b = check_budget(_q(total), 100.0, contingency_pct=0.05, expedite_fee_inr=fee)
    assert b.verdict == verdict
    assert b.committed_inr == pytest.approx(total * 1.05 + fee)
    assert b.headroom_inr == pytest.approx(100.0 - b.committed_inr)
    assert b.utilisation == pytest.approx(b.committed_inr / 100.0, abs=1e-4)
    assert b.reasons


def test_boundaries_exact() -> None:
    assert check_budget(_q(90.0), 100.0, contingency_pct=0.0).verdict == "warn"  # 90 % -> warn
    assert check_budget(_q(100.0), 100.0, contingency_pct=0.0).verdict == "warn"  # 100 % -> warn
    assert check_budget(_q(100.01), 100.0, contingency_pct=0.0).verdict == "breach"


def test_timeout_quote_is_not_committable() -> None:
    q = _q(1.0, status="timeout").model_copy(update={"lines": []})
    b = check_budget(q, 100.0)
    assert b.verdict == "breach" and "No priced quote" in b.reasons[0]


def test_invalid_budget() -> None:
    with pytest.raises(ValueError):
        check_budget(_q(1.0), 0.0)
