"""Mock vendor "network": deterministic RFQ responses driven by a scenario + live overrides.

The network never reads the wall clock and never sleeps. Whether a vendor answers, times out,
revises its price or slips its lead time is a pure function of
``(catalogue, scenario, overrides, vendor_id, attempt)``; the sim time ``now`` is only stamped
onto the returned quote. ``overrides`` is a plain JSON-serialisable dict mutated by
:meth:`VendorNetwork.apply_event` (live events injected by a person); the graph stores it in its
facts and passes it back after a restart, so replays are byte-identical.

Refresh semantics are *state based*: ``refresh_quote`` rebuilds the quote the vendor would
issue now (scenario revision + all overrides) and returns a new revision only if prices or lead
time differ from the quote given; otherwise the quote comes back unchanged. That makes refresh
idempotent and safe to replay.

Price basis: unit prices are ex-works and **ex-GST**. ``Quote.total_inr`` = sum(lines) + freight.
Items not in the vendor's price table but classifiable to a package category are priced from
the category ``rate_card`` (x the vendor's ``rate_card_factor``) and flagged "rate-card
estimate" in ``Quote.notes``; items with no category are excluded and listed in the notes.
"""

from __future__ import annotations

import copy
import re
from datetime import datetime, timedelta
from typing import Any

from pydantic import BaseModel

from sitemind.models import Quote, QuoteLine, TakeoffLine
from sitemind.specialists.packages import DEFAULT_PACKAGE, classify_line, load_package_catalog


class VendorTimeout(Exception):  # name fixed by the contract
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


EVENT_KINDS = (
    "delay_reply",
    "price_change",
    "lead_slip",
    "missing_document",
    "document_received",
    "timeout",
)
# API / EventType names -> network kinds
EVENT_ALIASES = {
    "vendor_late_reply": "delay_reply",
    "date_slip": "lead_slip",
    "document_missing": "missing_document",
}

_RC_NOTE = re.compile(r"(\S+) \(([\w-]+), base INR (\d+)/(\w+)\)")


def _round100(x: float) -> float:
    return float(round(x / 100.0) * 100)


def rate_card_unit_price(
    rate: dict[str, Any], line: TakeoffLine | None, factor: float = 1.0
) -> float:
    """Unit price from a rate-card entry: per-rating rate if the rating parses, else flat rate."""
    base = float(rate.get("rate_inr", 0.0))
    per = rate.get("per_rating")
    if per and line is not None:
        m = re.search(str(per["regex"]), f"{line.rating} {line.description}", re.IGNORECASE)
        if m:
            base = float(m.group(1).replace(",", "")) * float(per["rate_inr"])
    return _round100(base * factor)


class VendorNetwork:
    """Deterministic mock of the vendor RFQ channel for one scenario (and package)."""

    def __init__(
        self,
        scenario: dict[str, Any],
        catalog: dict[str, Any] | None = None,
        overrides: dict[str, Any] | None = None,
    ) -> None:
        self.scenario = scenario
        self.package_id: str = str(
            (catalog or {}).get("package_id") or scenario.get("package_id") or DEFAULT_PACKAGE
        )
        self.catalog = catalog if catalog is not None else load_package_catalog(self.package_id)
        self.vendors: dict[str, dict[str, Any]] = self.catalog["vendors"]
        self._overrides: dict[str, Any] = copy.deepcopy(overrides) if overrides else {}
        self._overrides.setdefault("vendors", {})
        self._overrides.setdefault("log", [])

    # ------------------------------------------------------------------ overrides
    @property
    def overrides(self) -> dict[str, Any]:
        """JSON-serialisable live state (a copy); pass it back to the constructor to restore."""
        return copy.deepcopy(self._overrides)

    def _ov(self, vendor_id: str) -> dict[str, Any]:
        ov: dict[str, Any] = self._overrides["vendors"].get(vendor_id, {})
        return ov

    def apply_event(self, kind: str, vendor_id: str, params: dict[str, Any] | None = None) -> str:
        """Apply a live event to ``overrides``; returns a one-line summary.

        * ``delay_reply {days}``     - every later reply from the vendor takes N more sim days
        * ``price_change {pct}``     - prices x (1 + pct/100), compounding; next refresh revises
        * ``lead_slip {days}``       - lead time + N days (negative = pull-in); next refresh revises
        * ``missing_document {document}`` / ``document_received {document}``
        * ``timeout {count, from_attempt=1}`` - attempts from..from+count-1 time out
        """
        p = dict(params or {})
        kind = EVENT_ALIASES.get(kind, kind)
        if kind not in EVENT_KINDS:
            raise ValueError(f"unknown vendor event {kind!r}; expected one of {EVENT_KINDS}")
        prof = self.profile(vendor_id)
        ov = self._overrides["vendors"].setdefault(vendor_id, {})
        name = prof["name"]
        if kind == "delay_reply":
            days = int(p.get("days", 2))
            ov["delay_days"] = int(ov.get("delay_days", 0)) + days
            summary = (
                f"{name} replies {days} d later than usual "
                f"(total delay {ov['delay_days']} d, reply time {self.response_hours(vendor_id)} h)."
            )
        elif kind == "price_change":
            pct = float(p.get("pct", 5.0))
            ov.setdefault("price_changes_pct", []).append(pct)
            summary = (
                f"{name} changes prices by {pct:+g}% "
                f"(cumulative factor x{self.price_factor_override(vendor_id):.4f})."
            )
        elif kind == "lead_slip":
            days = int(p.get("days", 14))
            ov["lead_slip_days"] = int(ov.get("lead_slip_days", 0)) + days
            summary = (
                f"{name} lead time {'slips' if days >= 0 else 'pulls in'} {abs(days)} d "
                f"(now {self.base_lead_time(vendor_id) + ov['lead_slip_days']} d before any "
                "scenario revision)."
            )
        elif kind == "missing_document":
            doc = str(p.get("document", "test certificate"))
            ov.setdefault("missing_documents", [])
            if doc not in ov["missing_documents"]:
                ov["missing_documents"].append(doc)
            ov["received_documents"] = [d for d in ov.get("received_documents", []) if d != doc]
            summary = f"{name} submittal incomplete: '{doc}' missing."
        elif kind == "document_received":
            doc = str(p.get("document", ""))
            ov.setdefault("received_documents", [])
            if doc not in ov["received_documents"]:
                ov["received_documents"].append(doc)
            summary = f"{name} submitted '{doc}'."
        else:  # timeout
            count = int(p.get("count", 1))
            start = int(p.get("from_attempt", 1))
            ats = set(ov.get("timeout_attempts", []))
            ats.update(range(start, start + count))
            ov["timeout_attempts"] = sorted(ats)
            summary = f"{name} will not answer attempts {start}..{start + count - 1}."
        self._overrides["log"].append({"kind": kind, "vendor_id": vendor_id, "params": p})
        return summary

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

    def base_lead_time(self, vendor_id: str) -> int:
        return int(self.profile(vendor_id)["lead_time_days"])

    def reply_delay_days(self, vendor_id: str) -> int:
        return int(self._ov(vendor_id).get("delay_days", 0))

    def response_hours(self, vendor_id: str) -> int:
        """Sim hours a successful round trip takes, incl. any injected reply delay."""
        base = int(self.profile(vendor_id).get("response_hours", 24))
        return base + 24 * self.reply_delay_days(vendor_id)

    def timeout_hours(self, vendor_id: str) -> int:
        """Sim hours a timed-out attempt costs before the caller gives up on it."""
        return int(self._rules(vendor_id).get("timeout_hours", 24))

    def will_timeout(self, vendor_id: str, attempt: int) -> bool:
        scripted = set(self._rules(vendor_id).get("timeout_on_attempts", []))
        injected = set(self._ov(vendor_id).get("timeout_attempts", []))
        return attempt in scripted | injected

    def price_factor_override(self, vendor_id: str) -> float:
        f = 1.0
        for pct in self._ov(vendor_id).get("price_changes_pct", []):
            f *= 1.0 + float(pct) / 100.0
        return f

    def missing_documents(self, vendor_id: str) -> list[str]:
        """Documents the vendor's submittal still lacks (scenario + injected - received)."""
        docs = list(self._rules(vendor_id).get("missing_documents", []))
        for d in self._ov(vendor_id).get("missing_documents", []):
            if d not in docs:
                docs.append(d)
        received = set(self._ov(vendor_id).get("received_documents", []))
        return [d for d in docs if d not in received]

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

    # ------------------------------------------------------------------ pricing
    def _unit_price(
        self, vendor_id: str, line: TakeoffLine, factor: float, rc_bases: dict[str, float]
    ) -> tuple[float, str | None]:
        """(unit price, rate-card note or None); raises KeyError if the line can't be priced."""
        prof = self.profile(vendor_id)
        prices: dict[str, float] = prof["unit_prices_inr"]
        if line.item_code in prices:
            return _round100(prices[line.item_code] * factor), None
        rcf = float(prof.get("rate_card_factor", 1.0))
        if line.item_code in rc_bases:  # refresh of an earlier rate-card estimate
            base, cat = rc_bases[line.item_code], "rate-card"
        else:
            cls = classify_line(line, self.package_id)
            card: dict[str, Any] = self.catalog.get("rate_card", {})
            if cls is None or cls[1] not in card:
                raise KeyError(line.item_code)
            cat = cls[1]
            base = rate_card_unit_price(card[cat], line, rcf)
        note = f"{line.item_code} ({cat}, base INR {int(base)}/{line.unit or 'ea'})"
        return _round100(base * factor), note

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
        rc_bases: dict[str, float] | None = None,
    ) -> Quote:
        prof = self.profile(vendor_id)
        factor = price_factor * self.price_factor_override(vendor_id)
        qlines: list[QuoteLine] = []
        missing: list[str] = []
        rc_notes: list[str] = []
        for ln in lines:
            try:
                unit, rc = self._unit_price(vendor_id, ln, factor, rc_bases or {})
            except KeyError:
                missing.append(ln.item_code)
                continue
            if rc:
                rc_notes.append(rc)
            qlines.append(
                QuoteLine(
                    item_code=ln.item_code,
                    qty=ln.qty,
                    unit_price_inr=unit,
                    total_inr=round(unit * ln.qty, 2),
                )
            )
        parts = [notes] if notes else []
        if rc_notes:
            parts.append("Rate-card estimate: " + "; ".join(rc_notes) + ".")
        if missing:
            parts.append(
                f"Not quoted (no catalogue price or rate-card category): {', '.join(missing)}."
            )
        docs = self.missing_documents(vendor_id)
        if docs:
            parts.append("Missing document: " + "; ".join(docs) + ".")
        freight = float(prof.get("freight_inr", 0.0))
        total = round(sum(q.total_inr for q in qlines) + freight, 2)
        lead = self.base_lead_time(vendor_id) + int(self._ov(vendor_id).get("lead_slip_days", 0))
        return Quote(
            vendor_id=vendor_id,
            vendor_name=str(prof["name"]),
            quote_id=f"Q-{vendor_id}-{now:%Y%m%d}-R{revision}",
            revision=revision,
            lines=qlines,
            freight_inr=freight,
            total_inr=total,
            lead_time_days=lead + lead_delta,
            valid_until=(now + timedelta(days=int(prof.get("quote_validity_days", 30)))).date(),
            reliability=float(prof["reliability"]),
            status="declined" if not qlines else status,  # type: ignore[arg-type]
            received_at=now,
            notes=" ".join(parts),
        )

    def _initial_factor(self, vendor_id: str) -> float:
        return 1.0 - float(self.profile(vendor_id).get("early_order_discount_pct", 0.0)) / 100.0

    def _refresh_factor_and_lead(self, vendor_id: str) -> tuple[float, int, str]:
        rev = self._rules(vendor_id).get("revision_on_refresh")
        if not rev:
            return self._initial_factor(vendor_id), 0, ""
        disc = float(self.profile(vendor_id).get("early_order_discount_pct", 0.0))
        keep = 0.0 if rev.get("withdraw_discount") else disc
        factor = (1.0 + float(rev.get("price_uplift_pct", 0.0)) / 100.0) * (1.0 - keep / 100.0)
        return factor, int(rev.get("lead_time_delta_days", 0)), str(rev.get("reason", ""))

    # ------------------------------------------------------------------ contract API
    def request_quote(
        self, vendor_id: str, lines: list[TakeoffLine], attempt: int, now: datetime
    ) -> Quote:
        """Return the vendor's initial quote, or raise :class:`VendorTimeout`."""
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
            price_factor=self._initial_factor(vendor_id),
            notes=" ".join(p for p in notes_parts if p),
        )

    def refresh_quote(
        self,
        vendor_id: str,
        quote: Quote,
        now: datetime,
        lines: list[TakeoffLine] | None = None,
    ) -> Quote:
        """Re-confirm a quote; returns a new revision if the vendor's current offer differs.

        ``lines`` (optional) are the takeoff lines; without them the quote's own item codes and
        quantities are used (rate-card estimates are re-derived from the base recorded in the
        quote notes).
        """
        if quote.status == "timeout" or not quote.lines:
            return quote.model_copy(deep=True)
        factor, lead_delta, reason = self._refresh_factor_and_lead(vendor_id)
        rc_bases = {m.group(1): float(m.group(3)) for m in _RC_NOTE.finditer(quote.notes)}
        units = {m.group(1): m.group(4) for m in _RC_NOTE.finditer(quote.notes)}
        src = lines or [
            TakeoffLine(
                item_code=q.item_code, description="", qty=q.qty, unit=units.get(q.item_code, "ea")
            )
            for q in quote.lines
        ]
        target = self._build_quote(
            vendor_id,
            src,
            now,
            revision=quote.revision + 1,
            price_factor=factor,
            lead_delta=lead_delta,
            status="revised",
            rc_bases=rc_bases,
        )
        same_prices = [(q.item_code, q.unit_price_inr) for q in target.lines] == [
            (q.item_code, q.unit_price_inr) for q in quote.lines
        ]
        if same_prices and target.lead_time_days == quote.lead_time_days:
            return quote.model_copy(deep=True)
        why: list[str] = []
        if reason and (factor != self._initial_factor(vendor_id) or lead_delta):
            why.append(reason)
        if self.price_factor_override(vendor_id) != 1.0:
            why.append(f"price change x{self.price_factor_override(vendor_id):.4f} (live event)")
        slip = int(self._ov(vendor_id).get("lead_slip_days", 0))
        if slip:
            why.append(f"lead time {slip:+d} d (live event)")
        head = f"Revision {quote.revision + 1} of {quote.quote_id}: " + "; ".join(why)
        return target.model_copy(update={"notes": (head + " " + target.notes).strip()})
