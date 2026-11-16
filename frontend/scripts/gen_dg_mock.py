"""Generate frontend/src/mock/data/dg-2mw.json: mock specialist outputs for the 2 MW DG-set package.

Hand-calibrated, synthetic numbers that mirror the backend specialists' formulas (5 % contingency,
CPM chain 36 d + lead, scoring 0.40 cost / 0.35 float / 0.25 reliability). Regenerate the file
from the real specialists once `packages/dg-2mw` ships (same JSON shape as swgr-480v.json).

    python3 frontend/scripts/gen_dg_mock.py
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

BUDGET = 380_000_000
ROS = date(2027, 11, 15)
PO = date(2027, 2, 1)
CONT = 0.05
DOC = "dg_2mw_genset_spec.pdf"

LINES = [  # item_code, description, qty, unit, rating, page, base unit price
    ("DG-2000-11KV", "Diesel generator set, prime rated, 11 kV alternator", 4, "ea", "2000 kWe / 2500 kVA", 2, 58_500_000),
    ("ENCL-AC-75DBA", "Acoustic enclosure, 75 dB(A) @ 1 m", 4, "ea", "75 dB(A)", 2, 4_800_000),
    ("TANK-DAY-990L", "Fuel day tank with level transmitter", 4, "ea", "990 L", 2, 650_000),
    ("SYNC-PNL-11KV", "Synchronising & load-sharing panel", 1, "ea", "11 kV, 4 incomers", 3, 24_000_000),
    ("EXH-STACK-30M", "Exhaust stack with residential silencer", 4, "ea", "30 m", 3, 2_200_000),
    ("NGR-11KV-200A", "Neutral grounding resistor", 4, "ea", "11 kV, 200 A, 10 s", 3, 950_000),
    ("CBL-11KV-3C300", "11 kV XLPE cable, 3C × 300 mm² Al (allowance)", 1200, "m", "11 kV", 3, 4_200),
]
VENDORS = {
    "D1": dict(name="Brahmaputra Power Gensets Pvt Ltd", city="Pune", rel=0.86, lead=210, mult=1.0, freight=2_800_000),
    "D2": dict(name="Coromandel Diesel Systems", city="Hosur", rel=0.92, lead=180, mult=1.06, freight=2_200_000),
    "D3": dict(name="Saurashtra Engines & Alternators", city="Rajkot", rel=0.88, lead=240, mult=1.03, freight=3_500_000),
}
REVISE = ("D2", 0.15)
SLIP = ("D3", 45)


def clamp(x):
    return max(0.0, min(1.0, x))


def score(u, f, r):
    return round(0.40 * clamp((1 - u) / 0.25) + 0.35 * clamp(f / 30) + 0.25 * clamp((r - 0.70) / 0.30), 3)


def quote(vid, rev=1, extra=1.0, at="2027-01-12T15:00:00+05:30"):
    v = VENDORS[vid]
    lines = []
    for code, _d, qty, _u, _r, _p, base in LINES:
        unit = round(base * v["mult"] * extra / 100) * 100
        lines.append(dict(item_code=code, qty=qty, unit_price_inr=float(unit), total_inr=float(unit * qty)))
    total = sum(l["total_inr"] for l in lines) + v["freight"]
    notes = f"{v['city']} works; ex-works + freight to Chakan MIDC."
    if rev > 1:
        notes = f"Revision {rev}: +{round((extra - 1) * 100)} % — USD/INR movement on imported engine blocks and steel price escalation on enclosures."
    if vid == "D1" and rev == 1:
        notes += " CPCB IV+ emissions type-approval certificate not enclosed."
    return dict(vendor_id=vid, vendor_name=v["name"], quote_id=f"Q-{vid}-20270112-R{rev}", revision=rev, lines=lines,
                freight_inr=float(v["freight"]), total_inr=float(total), lead_time_days=v["lead"],
                valid_until="2027-02-28", reliability=v["rel"], status="revised" if rev > 1 else "received",
                received_at=at, notes=notes)


def schedule(vid, lead):
    acts, es = [], 0
    chain = [("PO", "PO issue", 0), ("SUB", "Submittals / GA drawings", 14), ("APR", "Drawing approval", 10),
             ("MFG", "Manufacture", lead), ("FAT", "Factory acceptance test", 5), ("SHP", "Shipping to site", 7), ("DEL", "Delivery", 0)]
    total = 36 + lead
    fl = (ROS - PO).days - total
    prev = None
    for aid, name, dur in chain:
        acts.append(dict(id=aid, name=name, duration_days=dur, depends_on=[prev] if prev else [], early_start=es,
                         early_finish=es + dur, late_start=es + fl, late_finish=es + dur + fl, slack_days=fl, critical=True))
        es += dur
        prev = aid
    deliv = PO + timedelta(days=total)
    return dict(vendor_id=vid, activities=acts, critical_path=[a["id"] for a in acts], po_issue_date=PO.isoformat(),
                delivery_date=deliv.isoformat(), required_on_site=ROS.isoformat(), float_days=fl, meets_deadline=fl >= 0)


def option(q, lead=None, doc_ok=True):
    lead = lead or q["lead_time_days"]
    s = schedule(q["vendor_id"], lead)
    committed = q["total_inr"] * (1 + CONT)
    u = committed / BUDGET
    verdict = "ok" if u < 0.9 else "warn" if u <= 1.0 else "breach"
    sc = score(u, s["float_days"], q["reliability"])
    label = q["vendor_name"] + (f" rev {q['revision']}" if q["revision"] > 1 else "")
    feas = verdict != "breach" and s["meets_deadline"] and doc_ok
    why = [f"committed INR {committed / 1e5:,.1f} L ({u * 100:.1f}% of budget, {verdict})",
           f"delivers {s['delivery_date']} ({s['float_days']:+d} d float)", f"on-time record {q['reliability'] * 100:.0f}%"]
    if not doc_ok:
        why.append("INFEASIBLE: CPCB IV+ emissions certificate missing")
    elif not feas:
        why.append("INFEASIBLE: " + ("over budget" if verdict == "breach" else "misses required-on-site"))
    return dict(option_id=f"O-{q['vendor_id']}", vendor_id=q["vendor_id"], vendor_name=label, total_inr=q["total_inr"],
                lead_time_days=lead, delivery_date=s["delivery_date"], float_days=s["float_days"], reliability=q["reliability"],
                expedite_fee_inr=0.0, budget_verdict=verdict, meets_deadline=s["meets_deadline"], score=sc, recommended=False,
                rationale="; ".join(why), _feasible=feas)


def rank(opts):
    opts.sort(key=lambda o: (not o["_feasible"], -o["score"]))
    for o in opts:
        o["recommended"] = False
    for o in opts:
        if o["_feasible"]:
            o["recommended"] = True
            break
    for o in opts:
        o.pop("_feasible")
    return opts


q1 = {v: quote(v) for v in VENDORS}
opts1 = rank([option(q1["D1"], doc_ok=False), option(q1["D2"]), option(q1["D3"])])
rev = quote("D2", 2, 1 + REVISE[1], at="2027-01-18T10:00:00+05:30")
q2 = dict(q1, D2=rev)
opts2 = rank([option(q2["D1"]), option(rev), option(q2["D3"], lead=VENDORS["D3"]["lead"] + SLIP[1])])
rec = next(o for o in opts2 if o["recommended"])
alt = next(o for o in opts2 if not o["recommended"] and o["budget_verdict"] != "breach")
memo = dict(
    memo_id="MEMO-DG2MW-0002",
    title="Project Alpha - 2 MW DG sets: vendor selection",
    situation=f"Coromandel (D2) revised its quote +15 % (USD/INR, steel) and now breaches the ₹38 Cr ceiling; Saurashtra (D3) slipped its lead time by {SLIP[1]} d and misses the 15 Nov site date. Brahmaputra (D1) has now supplied its CPCB IV+ certificate.",
    options=opts2,
    recommendation=rec["option_id"],
    reasoning=(f"Recommend {rec['option_id']} - {rec['vendor_name']}: total INR {rec['total_inr'] / 1e5:,.1f} L ex-GST, delivery {rec['delivery_date']} "
               f"({rec['float_days']:+d} d float), on-time record {rec['reliability'] * 100:.0f}%, score {rec['score']:.2f}. It is the cheapest compliant offer and now holds a valid CPCB IV+ type-approval. "
               f"Rejected O-D2 (Coromandel rev 2): over budget after the forex/steel revision. Rejected O-D3 (Saurashtra): the {SLIP[1]}-day slip makes it late for the 15 Nov 2027 site date."),
    risks=["O-D1: on-time record 86%; insist on fortnightly works-progress reports and stage inspections.",
           "O-D1: certificate received late — verify the CPCB IV+ type-approval number against the CPCB portal before PO release.",
           "Forex exposure on imported engine blocks: fix the INR price in the PO (no PVC clause)."],
    asks=f"Approve vendor selection for Project Alpha 2 MW DG sets: confirm {rec['option_id']} or pick one of the feasible options. Approval authorises a PO to be drafted for release by 2027-04-30.",
)


def inr(n):
    s = f"{n:,.2f}"
    return s


def po(o):
    q = q2[o["vendor_id"]]
    lines = []
    for i, (l, meta) in enumerate(zip(q["lines"], LINES), 1):
        lines.append(dict(line_no=i, item_code=l["item_code"], description=f"{meta[1]} ({meta[4]})", qty=l["qty"],
                          unit_price_inr=l["unit_price_inr"], total_inr=l["total_inr"]))
    sub = sum(l["total_inr"] for l in lines)
    gst = round((sub + q["freight_inr"]) * 0.18)
    total = sub + q["freight_inr"] + gst
    v = VENDORS[o["vendor_id"]]
    md = "\n".join([
        "# Purchase Order PO-ALPHA-DG-0001", "", "**Project:** Project Alpha - 2 MW DG sets  ", "**Status:** DRAFT  ",
        f"**PO date:** {PO.isoformat()}  ", f"**Contractual delivery:** {o['delivery_date']}  ", f"**Vendor quote:** {q['quote_id']} (rev {q['revision']})", "",
        "## Parties", "", "| | |", "|---|---|",
        f"| **Vendor** | {v['name']} ({o['vendor_id']}), {v['city']} (synthetic) |",
        "| **Bill to** | Alpha Data Centres Pvt Ltd (synthetic), Pune, Maharashtra |",
        "| **Ship to** | Project Alpha site - 24 MW Tier-III Data Centre, Chakan MIDC Phase II, Pune 410501 |",
        "| **Incoterms** | DAP Project Alpha site, Chakan MIDC (Incoterms 2020) |",
        "| **Payment terms** | 10% advance against ABG, 80% against delivery & inspection, 10% after load-bank test |", "",
        "## Lines", "", "| # | Item code | Description | Qty | Unit price (INR) | Amount (INR) |", "|---:|---|---|---:|---:|---:|",
        *[f"| {l['line_no']} | `{l['item_code']}` | {l['description']} | {l['qty']} | {inr(l['unit_price_inr'])} | {inr(l['total_inr'])} |" for l in lines], "",
        "## Totals", "", "| | Amount (INR) |", "|---|---:|", f"| Subtotal | {inr(sub)} |", f"| Freight | {inr(q['freight_inr'])} |",
        f"| GST 18 % | {inr(gst)} |", f"| **Total payable** | **{inr(total)}** |", "",
        "## Key terms", "", "- CPCB IV+ type-approval certificate and test report are conditions of dispatch.",
        "- 12-hour load-bank test at site; FAT witnessed by Alpha EPC.", "- LDs 0.5 % per week of delay, capped at 10 %.",
        "- Warranty 24 months from commissioning or 30 months from delivery.",
    ])
    return dict(po_number="PO-ALPHA-DG-0001", vendor_id=o["vendor_id"], vendor_name=v["name"], project="Project Alpha", lines=lines,
                subtotal_inr=sub, freight_inr=q["freight_inr"], expedite_fee_inr=0.0, gst_inr=float(gst), total_inr=float(total),
                delivery_date=o["delivery_date"], payment_terms="10% advance against ABG, 80% against delivery & inspection, 10% after load-bank test",
                incoterms="DAP Project Alpha site, Chakan MIDC (Incoterms 2020)",
                terms=["CPCB IV+ certificate is a condition of dispatch", "LDs 0.5 %/week capped at 10 %", "24-month warranty"],
                status="draft", issued_at=None, markdown=md)


takeoff = dict(
    document=DOC,
    lines=[dict(item_code=c, description=d, qty=q, unit=u, rating=r, source=f"{DOC} p{p} table 1 row {i}") for i, (c, d, q, u, r, p, _b) in enumerate(LINES, 1)],
    confidence=0.9,
    warnings=["CBL-11KV-3C300: cable length is an allowance (1200 m) — confirm with the final cable schedule (RFI raised)."],
)
out = dict(
    takeoff=takeoff,
    quotes_r1=list(q1.values()),
    attempts_r1=[],
    options_initial=opts1,
    budgets_initial=[],
    quotes_refreshed=list(q2.values()),
    attempts_refresh=[dict(vendor_id="D2", attempt=2, outcome="revised", at="2027-01-18T10:00:00+05:30",
                           detail=f"{rev['quote_id']}: INR {q1['D2']['total_inr']:,.0f} -> {rev['total_inr']:,.0f} (+{(rev['total_inr'] / q1['D2']['total_inr'] - 1) * 100:.1f}%). USD/INR + steel escalation")],
    options_replan=opts2,
    budgets_replan=[],
    schedules={v: schedule(v, VENDORS[v]["lead"] + (SLIP[1] if v == "D3" else 0)) for v in VENDORS},
    expedite={},
    memo=memo,
    pos={rec["option_id"]: po(rec), alt["option_id"]: po(alt)},
)
dest = Path(__file__).resolve().parents[1] / "src" / "mock" / "data" / "dg-2mw.json"
dest.write_text(json.dumps(out, indent=1, ensure_ascii=False))
for o in opts1 + [None] + opts2:
    print(o and (o["option_id"], round(o["total_inr"] / 1e7, 2), o["float_days"], o["budget_verdict"], o["score"], o["recommended"]))
