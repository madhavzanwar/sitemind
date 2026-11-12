"""Budget guard specialist.

Basis: all money is **ex-GST** (18% GST is recoverable as input tax credit and is shown only on
the PO). ``committed = quote total (lines + freight) + contingency + expedite/fees``;
``utilisation = committed / budget``. Verdict: ``ok`` < 90 %, ``warn`` 90-100 %, ``breach`` > 100 %.
"""

from __future__ import annotations

from sitemind.models import BudgetCheck, Quote

WARN_AT = 0.90
BREACH_ABOVE = 1.00


def verdict_for(utilisation: float) -> str:
    if utilisation > BREACH_ABOVE:
        return "breach"
    if utilisation >= WARN_AT:
        return "warn"
    return "ok"


def check_budget(
    quote: Quote,
    budget_inr: float,
    contingency_pct: float = 0.05,
    expedite_fee_inr: float = 0.0,
) -> BudgetCheck:
    """Check a quote (plus contingency and any expedite fee) against the budget ceiling."""
    if budget_inr <= 0:
        raise ValueError("budget_inr must be > 0")
    reasons: list[str] = []
    if quote.status in ("timeout", "declined") or not quote.lines:
        return BudgetCheck(
            vendor_id=quote.vendor_id,
            quote_total_inr=0.0,
            contingency_inr=0.0,
            committed_inr=0.0,
            budget_inr=budget_inr,
            headroom_inr=budget_inr,
            utilisation=0.0,
            verdict="breach",
            reasons=[
                f"No priced quote from {quote.vendor_name} (status {quote.status}); "
                "cannot be committed."
            ],
        )
    contingency = round(quote.total_inr * contingency_pct, 2)
    committed = round(quote.total_inr + contingency + expedite_fee_inr, 2)
    headroom = round(budget_inr - committed, 2)
    util = committed / budget_inr
    verdict = verdict_for(util)
    reasons.append(
        f"Quote {quote.quote_id} INR {quote.total_inr:,.0f} + {contingency_pct:.0%} contingency "
        f"INR {contingency:,.0f}"
        + (f" + expedite INR {expedite_fee_inr:,.0f}" if expedite_fee_inr else "")
        + f" = INR {committed:,.0f} committed vs budget INR {budget_inr:,.0f} "
        f"({util:.1%} utilised)."
    )
    if verdict == "breach":
        reasons.append(
            f"Over budget by INR {-headroom:,.0f}; needs re-negotiation, an alternative "
            "vendor or a budget exception."
        )
    elif verdict == "warn":
        reasons.append(
            f"Within budget but above the {WARN_AT:.0%} warning line; only INR "
            f"{headroom:,.0f} headroom left for variations."
        )
    else:
        reasons.append(f"Healthy headroom of INR {headroom:,.0f}.")
    if quote.status == "revised":
        reasons.append(f"Quote is revision {quote.revision}: {quote.notes}")
    return BudgetCheck(
        vendor_id=quote.vendor_id,
        quote_total_inr=quote.total_inr,
        contingency_inr=contingency,
        committed_inr=committed,
        budget_inr=budget_inr,
        headroom_inr=headroom,
        utilisation=round(util, 4),
        verdict=verdict,
        reasons=reasons,
    )
