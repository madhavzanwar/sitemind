"""Purchase-order specialist: draft a PO package from the approved option.

Totals: ``subtotal`` = sum(lines); ``taxable = subtotal + freight + expedite``;
``gst = 18 % of taxable``; ``total = taxable + gst``. Money is rounded to the paisa.
"""

from __future__ import annotations

from datetime import date, datetime, time
from typing import Any

from sitemind.models import Goal, POLine, PurchaseOrder, Quote, TakeoffResult, VendorOption
from sitemind.specialists._data import vendor_profile

GST_RATE = 0.18
SHIP_TO = (
    "Project Alpha site - 24 MW Tier-III Data Centre, Plot A-7, Chakan MIDC Phase II, "
    "Chakan, Pune 410501, Maharashtra, India"
)
BILL_TO = "Alpha Data Centres Pvt Ltd (synthetic), GSTIN 27AAACA0000Z1Z9, Pune, Maharashtra"

STANDARD_TERMS = [
    "Liquidated damages: 0.5% of order value per week (or part) of delay beyond the contractual "
    "delivery date, capped at 10% of order value.",
    "Warranty: 24 months from energisation or 30 months from delivery, whichever is earlier; "
    "defects rectified at site within 72 h of notice.",
    "Factory acceptance test: witnessed by Owner and Engineer (5 days) with 14 days' notice; "
    "despatch only after signed FAT report and release note.",
    "Submittals: GA, SLD, wiring diagrams and protection coordination study within 14 days of "
    "PO; Engineer review 10 days; manufacture only on approved drawings.",
    "Compliance: IEC 61439-1/-2 type-tested assemblies, 65 kA 1 s, arc-fault containment per "
    "IEC TR 61641; type-test certificates with the first submittal.",
    "Bank guarantees: advance against ABG of equal value; 10% performance bank guarantee valid "
    "for the warranty period plus 3 months.",
    "Price basis: firm, ex-GST; GST 18% charged on invoice per prevailing law.",
]


def _r2(x: float) -> float:
    return round(x + 0.0, 2)


def _inr(x: float) -> str:
    return f"INR {x:,.2f}"


def draft_po(
    goal: Goal,
    option: VendorOption,
    quote: Quote,
    takeoff: TakeoffResult,
    po_number: str,
    issued: date,
    vendor: dict[str, Any] | None = None,
) -> PurchaseOrder:
    """Build the PO (status ``draft``) and its rendered markdown package.

    ``issued`` may be a ``date`` (stamped 10:00, naive) or a sim-time ``datetime`` (kept as-is).
    ``vendor`` overrides the catalogue profile (payment terms, incoterms, GSTIN, contact).
    """
    if option.vendor_id != quote.vendor_id:
        raise ValueError(
            f"option {option.option_id} is for {option.vendor_id}, quote is for {quote.vendor_id}"
        )
    prof = vendor if vendor is not None else vendor_profile(quote.vendor_id)
    qbycode = {q.item_code: q for q in quote.lines}
    lines: list[POLine] = []
    for t in takeoff.lines:
        q = qbycode.get(t.item_code)
        if q is None:
            raise ValueError(f"quote {quote.quote_id} has no price for {t.item_code}")
        desc = t.description + (f" ({t.rating})" if t.rating else "")
        lines.append(
            POLine(
                line_no=len(lines) + 1,
                item_code=t.item_code,
                description=desc,
                qty=t.qty,
                unit_price_inr=q.unit_price_inr,
                total_inr=_r2(q.unit_price_inr * t.qty),
            )
        )
    subtotal = _r2(sum(ln.total_inr for ln in lines))
    freight = _r2(quote.freight_inr)
    fee = _r2(option.expedite_fee_inr)
    taxable = _r2(subtotal + freight + fee)
    gst = _r2(taxable * GST_RATE)
    total = _r2(taxable + gst)
    terms = list(STANDARD_TERMS)
    ros = goal.required_on_site.isoformat() if goal.required_on_site else "n/a"
    terms.insert(
        0,
        f"Contractual delivery: on or before {option.delivery_date.isoformat()} "
        f"(required on site {ros}).",
    )
    if fee:
        terms.append(
            f"Expedite fee {_inr(fee)} is payable only on delivery by the contractual date; "
            "forfeited in full if delivery is late (in addition to LDs)."
        )
    terms.append(
        f"Reference: vendor quote {quote.quote_id} rev {quote.revision}; takeoff from "
        f"{takeoff.document}."
    )
    po = PurchaseOrder(
        po_number=po_number,
        vendor_id=quote.vendor_id,
        vendor_name=quote.vendor_name,
        project=goal.project,
        lines=lines,
        subtotal_inr=subtotal,
        freight_inr=freight,
        expedite_fee_inr=fee,
        gst_inr=gst,
        total_inr=total,
        delivery_date=option.delivery_date,
        payment_terms=str(prof.get("payment_terms", "")),
        incoterms=str(prof.get("incoterms", "")),
        terms=terms,
        status="draft",
        issued_at=issued if isinstance(issued, datetime) else datetime.combine(issued, time(10, 0)),
    )
    po.markdown = render_po_markdown(po, goal, quote, prof)
    return po


def render_po_markdown(po: PurchaseOrder, goal: Goal, quote: Quote, vendor: dict[str, Any]) -> str:
    """Render the PO package as GitHub-flavoured markdown."""
    issued = po.issued_at.date().isoformat() if po.issued_at else "-"
    out = [
        f"# Purchase Order {po.po_number}",
        "",
        f"**Project:** {po.project} - {goal.package}  ",
        f"**Status:** {po.status.upper()}  ",
        f"**PO date:** {issued}  ",
        f"**Contractual delivery:** {po.delivery_date.isoformat()}  ",
        f"**Vendor quote:** {quote.quote_id} (rev {quote.revision})",
        "",
        "## Parties",
        "",
        "| | |",
        "|---|---|",
        f"| **Vendor** | {po.vendor_name} ({po.vendor_id}), {vendor.get('city', '')} - GSTIN "
        f"{vendor.get('gstin', '-')} - {vendor.get('contact', '')} |",
        f"| **Bill to** | {BILL_TO} |",
        f"| **Ship to** | {SHIP_TO} |",
        f"| **Incoterms** | {po.incoterms} |",
        f"| **Payment terms** | {po.payment_terms} |",
        "",
        "## Lines",
        "",
        "| # | Item code | Description | Qty | Unit price (INR) | Amount (INR) |",
        "|---:|---|---|---:|---:|---:|",
    ]
    for ln in po.lines:
        out.append(
            f"| {ln.line_no} | `{ln.item_code}` | {ln.description} | {ln.qty} | "
            f"{ln.unit_price_inr:,.2f} | {ln.total_inr:,.2f} |"
        )
    out += [
        "",
        "## Totals",
        "",
        "| | INR |",
        "|---|---:|",
        f"| Subtotal (equipment) | {po.subtotal_inr:,.2f} |",
        f"| Freight to site | {po.freight_inr:,.2f} |",
    ]
    if po.expedite_fee_inr:
        out.append(f"| Expedite fee | {po.expedite_fee_inr:,.2f} |")
    taxable = po.subtotal_inr + po.freight_inr + po.expedite_fee_inr
    out += [
        f"| Taxable value | {taxable:,.2f} |",
        f"| GST @ {GST_RATE:.0%} | {po.gst_inr:,.2f} |",
        f"| **Total payable** | **{po.total_inr:,.2f}** |",
        "",
        "## Terms & conditions",
        "",
    ]
    out += [f"{i}. {t}" for i, t in enumerate(po.terms, start=1)]
    out += [
        "",
        "## Approvals",
        "",
        "| Role | Name | Signature | Date |",
        "|---|---|---|---|",
        "| Prepared by | SiteMind procurement agent | (system) | " + issued + " |",
        "| Vendor selection approved | Project Manager, Project Alpha | | |",
        "| PO release approved | Project Director / Commercial Head | | |",
        f"| Accepted by vendor | {po.vendor_name} | | |",
        "",
        f"_Budget ceiling for this package: INR {goal.budget_inr:,.0f} ex-GST. "
        "Generated deterministically by SiteMind; synthetic demo data._",
        "",
    ]
    return "\n".join(out)
