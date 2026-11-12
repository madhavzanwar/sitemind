"""RFQ collection specialist: request quotes from vendors with retries and fallback."""

from __future__ import annotations

from datetime import datetime, timedelta

from sitemind.models import Quote, QuotesResult, TakeoffLine, VendorAttempt
from sitemind.specialists.vendors import VendorNetwork, VendorTimeout


def timeout_quote(network: VendorNetwork, vendor_id: str, attempts: int, now: datetime) -> Quote:
    """Placeholder quote for a vendor that never answered (status ``timeout``, no lines)."""
    prof = network.profile(vendor_id)
    return Quote(
        vendor_id=vendor_id,
        vendor_name=str(prof["name"]),
        quote_id=f"Q-{vendor_id}-{now:%Y%m%d}-TIMEOUT",
        revision=0,
        lines=[],
        freight_inr=0.0,
        total_inr=0.0,
        lead_time_days=int(prof["lead_time_days"]),
        valid_until=now.date(),
        reliability=float(prof["reliability"]),
        status="timeout",
        received_at=None,
        notes=f"No response after {attempts} attempts; excluded from evaluation.",
    )


def collect_quotes(
    network: VendorNetwork,
    vendors: list[str],
    lines: list[TakeoffLine],
    now: datetime,
    max_attempts: int = 3,
    retry_interval: timedelta = timedelta(0),
) -> QuotesResult:
    """Request a quote from every vendor, retrying timeouts up to ``max_attempts``.

    This function never touches a clock: attempt *k* is stamped ``now + (k-1) * retry_interval``
    (``retry_interval`` defaults to zero; the caller owns sim-time advancement). A vendor that
    still times out after ``max_attempts`` is returned as a ``status="timeout"`` quote so the
    evaluation can fall back to the remaining vendors.
    """
    if max_attempts < 1:
        raise ValueError("max_attempts must be >= 1")
    quotes: list[Quote] = []
    attempts: list[VendorAttempt] = []
    for vid in vendors:
        got: Quote | None = None
        for attempt in range(1, max_attempts + 1):
            at = now + retry_interval * (attempt - 1)
            try:
                got = network.request_quote(vid, lines, attempt, at)
            except VendorTimeout as exc:
                detail = f"no response within {exc.timeout_hours} h"
                if attempt < max_attempts:
                    detail += f"; retrying (attempt {attempt + 1}/{max_attempts})"
                else:
                    detail += "; giving up, vendor excluded"
                attempts.append(
                    VendorAttempt(
                        vendor_id=vid, attempt=attempt, outcome="timeout", at=at, detail=detail
                    )
                )
                continue
            outcome = "declined" if got.status == "declined" else "ok"
            attempts.append(
                VendorAttempt(
                    vendor_id=vid,
                    attempt=attempt,
                    outcome=outcome,
                    at=at,
                    detail=f"{got.quote_id}: INR {got.total_inr:,.0f} ex-GST, "
                    f"lead {got.lead_time_days} d",
                )
            )
            break
        quotes.append(got if got is not None else timeout_quote(network, vid, max_attempts, now))
    return QuotesResult(quotes=quotes, attempts=attempts)


def refresh_quotes(
    network: VendorNetwork, quotes: list[Quote], now: datetime
) -> tuple[list[Quote], list[VendorAttempt]]:
    """Re-confirm received quotes before award; returns (quotes, attempts) with revisions marked."""
    out: list[Quote] = []
    log: list[VendorAttempt] = []
    for q in quotes:
        if q.status == "timeout":
            out.append(q)
            continue
        new = network.refresh_quote(q.vendor_id, q, now)
        if new.revision != q.revision:
            pct = (new.total_inr / q.total_inr - 1.0) * 100.0 if q.total_inr else 0.0
            log.append(
                VendorAttempt(
                    vendor_id=q.vendor_id,
                    attempt=new.revision,
                    outcome="revised",
                    at=now,
                    detail=f"{new.quote_id}: INR {q.total_inr:,.0f} -> {new.total_inr:,.0f} "
                    f"({pct:+.1f}%). {new.notes}",
                )
            )
        else:
            log.append(
                VendorAttempt(
                    vendor_id=q.vendor_id,
                    attempt=q.revision,
                    outcome="ok",
                    at=now,
                    detail=f"{q.quote_id} re-confirmed unchanged",
                )
            )
        out.append(new)
    return out, log
