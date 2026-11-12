"""Mock vendor "network": deterministic RFQ responses driven by a scenario.

The network never reads the wall clock and never sleeps: whether a vendor answers, times out
or revises its price is a pure function of ``(scenario, vendor_id, attempt, quote revision)``.
The sim time ``now`` passed in is only stamped onto the returned quote (``received_at``,
``valid_until``) so that resume-from-checkpoint replays produce byte-identical quotes.

Price basis: unit prices are ex-works and **ex-GST** (GST is input-tax-credit recoverable for
the owner, so budgets are tracked ex-GST; GST is shown on the PO). ``Quote.total_inr`` =
sum(lines) + freight.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from pydantic import BaseModel

from sitemind.models import Quote, QuoteLine, TakeoffLine
from sitemind.specialists._data import load_vendors


class VendorTimeout(Exception):
    """Raised when a vendor does not answer an RFQ within its response window."""

    def __init__(self, vendor_id: str, attempt: int = 0, timeout_hours: int = 24) -> None:
        super().__init__(f"vendor {vendor_id} timed out on attempt {attempt} ({timeout_hours} h)")
        self.vendor_id = vendor_id
        self.attempt = attempt
        self.timeout_hours = timeout_hours


class ExpediteOffer(BaseModel):
    """A vendor's paid offer to shorten its manufacturing lead time."""

    vendor_id: str
    days_saved: int
    fee_inr: float
    description: str = ""


def _round100(x: float) -> float:
    return float(round(x / 100.0) * 100)


class VendorNetwork:
    """Deterministic mock of the vendor RFQ channel for one scenario."""

    def __init__(self, scenario: dict[str, Any], catalog: dict[str, Any] | None = None) -> None:
        self.scenario = scenario
        self.catalog = catalog if catalog is not None else load_vendors()
        self.vendors: dict[str, dict[str, Any]] = self.catalog["vendors"]

    # ------------------------------------------------------------------ helpers
    def vendor_ids(self) -> list[str]:
        return sorted(self.vendors)

    def profile(self, vendor_id: str) -> dict[str, Any]:
        if vendor_id not in self.vendors:
            raise KeyError(f"unknown vendor {vendor_id!r}")
        return self.vendors[vendor_id]

    def _rules(self, vendor_id: str) -> dict[str, Any]:
        rules: dict[str, Any] = self.scenario.get("vendors", {}).get(vendor_id, {}) or {}
        return rules

    def response_hours(self, vendor_id: str) -> int:
        """Sim hours a successful round trip takes (callers advance their clock by this)."""
        return int(self.profile(vendor_id).get("response_hours", 24))

    def timeout_hours(self, vendor_id: str) -> int:
        """Sim hours a timed-out attempt costs before the caller gives up on it."""
        return int(self._rules(vendor_id).get("timeout_hours", 24))

    def will_timeout(self, vendor_id: str, attempt: int) -> bool:
        return attempt in set(self._rules(vendor_id).get("timeout_on_attempts", []))

    def expedite_offer(self, vendor_id: str) -> ExpediteOffer | None:
        exp = self.profile(vendor_id).get("expedite")
        if not exp or not self._rules(vendor_id).get("offer_expedite", True):
            return None
        return ExpediteOffer(
            vendor_id=vendor_id,
            days_saved=int(exp["days_saved"]),
            fee_inr=float(exp["fee_inr"]),
            description=str(exp.get("description", "")),
        )

    def expedite_offers(self) -> dict[str, ExpediteOffer]:
        out: dict[str, ExpediteOffer] = {}
        for vid in self.vendor_ids():
            offer = self.expedite_offer(vid)
            if offer is not None:
                out[vid] = offer
        return out

    def _build_quote(
        self,
        vendor_id: str,
        lines: list[TakeoffLine],
        now: datetime,
        revision: int,
        price_factor: float,
        lead_delta: int = 0,
        status: str = "received",
        notes: str = "",
    ) -> Quote:
        prof = self.profile(vendor_id)
        prices: dict[str, float] = prof["unit_prices_inr"]
        qlines: list[QuoteLine] = []
        missing: list[str] = []
        for ln in lines:
            if ln.item_code not in prices:
                missing.append(ln.item_code)
                continue
            unit = _round100(prices[ln.item_code] * price_factor)
            qlines.append(
                QuoteLine(
                    item_code=ln.item_code,
                    qty=ln.qty,
                    unit_price_inr=unit,
                    total_inr=round(unit * ln.qty, 2),
                )
            )
        if missing:
            notes = (notes + " " if notes else "") + f"Not quoted: {', '.join(missing)}."
        freight = float(prof.get("freight_inr", 0.0))
        total = round(sum(q.total_inr for q in qlines) + freight, 2)
        return Quote(
            vendor_id=vendor_id,
            vendor_name=str(prof["name"]),
            quote_id=f"Q-{vendor_id}-{now:%Y%m%d}-R{revision}",
            revision=revision,
            lines=qlines,
            freight_inr=freight,
            total_inr=total,
            lead_time_days=int(prof["lead_time_days"]) + lead_delta,
            valid_until=(now + timedelta(days=int(prof.get("quote_validity_days", 30)))).date(),
            reliability=float(prof["reliability"]),
            status="declined" if not qlines else status,
            received_at=now,
            notes=notes,
        )

    # ------------------------------------------------------------------ contract API
    def request_quote(
        self, vendor_id: str, lines: list[TakeoffLine], attempt: int, now: datetime
    ) -> Quote:
        """Return the vendor's initial quote, or raise :class:`VendorTimeout` per scenario."""
        prof = self.profile(vendor_id)
        if self.will_timeout(vendor_id, attempt):
            raise VendorTimeout(vendor_id, attempt, self.timeout_hours(vendor_id))
        disc = float(prof.get("early_order_discount_pct", 0.0))
        notes_parts = [str(prof.get("notes", ""))]
        if disc:
            notes_parts.append(
                f"Includes {disc:g}% early-order discount, valid "
                f"{prof.get('quote_validity_days')} days."
            )
        offer = self.expedite_offer(vendor_id)
        if offer is not None:
            notes_parts.append(
                f"Expedite available: -{offer.days_saved} days for INR {offer.fee_inr:,.0f}."
            )
        return self._build_quote(
            vendor_id,
            lines,
            now,
            revision=1,
            price_factor=1.0 - disc / 100.0,
            notes=" ".join(p for p in notes_parts if p),
        )

    def refresh_quote(self, vendor_id: str, quote: Quote, now: datetime) -> Quote:
        """Re-confirm a quote; the scenario may make the vendor issue a revision.

        A revision is issued at most once (only when refreshing revision 1). Otherwise the
        original quote is returned unchanged.
        """
        rev = self._rules(vendor_id).get("revision_on_refresh")
        if not rev or quote.revision > 1 or quote.status == "timeout":
            return quote.model_copy(deep=True)
        prof = self.profile(vendor_id)
        disc = float(prof.get("early_order_discount_pct", 0.0))
        keep = 0.0 if rev.get("withdraw_discount") else disc
        factor = (1.0 + float(rev.get("price_uplift_pct", 0.0)) / 100.0) * (1.0 - keep / 100.0)
        lines = [TakeoffLine(item_code=q.item_code, description="", qty=q.qty) for q in quote.lines]
        return self._build_quote(
            vendor_id,
            lines,
            now,
            revision=quote.revision + 1,
            price_factor=factor,
            lead_delta=int(rev.get("lead_time_delta_days", 0)),
            status="revised",
            notes=f"Revision {quote.revision + 1} of {quote.quote_id}: {rev.get('reason', '')}",
        )
