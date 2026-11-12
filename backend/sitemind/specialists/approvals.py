"""Approvals specialist: rank vendor options and write the decision memo for a human.

Scoring (deterministic, 0..1, higher is better)::

    cost        = clamp((1 - utilisation) / 0.25)      # 75 % utilisation or less -> 1.0
    float       = clamp(float_days / 30)               # 30+ days of float -> 1.0, late -> 0
    reliability = clamp((on_time_rate - 0.70) / 0.30)  # 70 % -> 0, 100 % -> 1
    score       = 0.40 * cost + 0.35 * float + 0.25 * reliability

Hard constraints: budget ``breach`` or a missed required-on-site date make an option
*infeasible*; infeasible options are still listed (so the human sees why they lost) but are
ranked after every feasible one and are never recommended.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping

from sitemind.models import BudgetCheck, DecisionMemo, Goal, Quote, ScheduleResult, VendorOption
from sitemind.specialists.budget import check_budget
from sitemind.specialists.schedule import schedule_for_lead_time
from sitemind.specialists.vendors import ExpediteOffer

W_COST, W_FLOAT, W_REL = 0.40, 0.35, 0.25
LOW_FLOAT_DAYS = 14
LOW_RELIABILITY = 0.85


def _clamp(x: float) -> float:
    return max(0.0, min(1.0, x))


def score_components(utilisation: float, float_days: int, reliability: float) -> dict[str, float]:
    return {
        "cost": round(_clamp((1.0 - utilisation) / 0.25), 4),
        "float": round(_clamp(float_days / 30.0), 4),
        "reliability": round(_clamp((reliability - 0.70) / 0.30), 4),
    }


def score_option(utilisation: float, float_days: int, reliability: float) -> float:
    c = score_components(utilisation, float_days, reliability)
    return round(W_COST * c["cost"] + W_FLOAT * c["float"] + W_REL * c["reliability"], 3)


def _inr_lakh(x: float) -> str:
    return f"INR {x / 1e5:,.1f} L"


def _option(
    option_id: str,
    quote: Quote,
    sched: ScheduleResult,
    bud: BudgetCheck,
    fee: float,
    lead: int,
    label: str,
) -> VendorOption:
    feasible = bud.verdict != "breach" and sched.meets_deadline
    score = score_option(bud.utilisation, sched.float_days, quote.reliability)
    bits = [
        f"{label}: committed {_inr_lakh(bud.committed_inr)} ({bud.utilisation:.1%} of budget, "
        f"{bud.verdict})",
        f"delivers {sched.delivery_date.isoformat()} ({sched.float_days:+d} d float)",
        f"on-time record {quote.reliability:.0%}",
    ]
    if not feasible:
        why = []
        if bud.verdict == "breach":
            why.append("over budget")
        if not sched.meets_deadline:
            why.append(f"misses required-on-site by {-sched.float_days} d")
        bits.append("INFEASIBLE: " + " and ".join(why))
    return VendorOption(
        option_id=option_id,
        vendor_id=quote.vendor_id,
        vendor_name=quote.vendor_name,
        total_inr=round(quote.total_inr + fee, 2),
        lead_time_days=lead,
        delivery_date=sched.delivery_date,
        float_days=sched.float_days,
        reliability=quote.reliability,
        expedite_fee_inr=fee,
        budget_verdict=bud.verdict,
        meets_deadline=sched.meets_deadline,
        score=score,
        rationale="; ".join(bits) + ".",
    )


def is_feasible(o: VendorOption) -> bool:
    return o.budget_verdict != "breach" and o.meets_deadline


def rank_options(
    quotes: list[Quote],
    schedules: list[ScheduleResult],
    budgets: list[BudgetCheck],
    expedite_offers: Mapping[str, ExpediteOffer] | Iterable[ExpediteOffer] | None = None,
) -> list[VendorOption]:
    """Build and rank vendor options (one per priced quote, plus an expedited variant per offer).

    ``schedules`` and ``budgets`` are matched to quotes by ``vendor_id``. Expedited variants
    (``O-<vendor>X``) are recomputed here with the base schedule's dates and the base budget's
    contingency rate. Exactly one option (best feasible) gets ``recommended=True`` if any is
    feasible. Option totals include the expedite fee (ex-GST, ex-contingency).
    """
    if expedite_offers is None:
        offers: dict[str, ExpediteOffer] = {}
    elif isinstance(expedite_offers, Mapping):
        offers = dict(expedite_offers)
    else:
        offers = {o.vendor_id: o for o in expedite_offers}
    sched_by = {s.vendor_id: s for s in schedules}
    bud_by = {b.vendor_id: b for b in budgets}
    opts: list[VendorOption] = []
    for q in quotes:
        if q.status in ("timeout", "declined") or not q.lines:
            continue
        s, b = sched_by.get(q.vendor_id), bud_by.get(q.vendor_id)
        if s is None or b is None:
            raise ValueError(f"missing schedule or budget check for {q.vendor_id}")
        label = f"{q.vendor_name} rev {q.revision}" if q.revision > 1 else q.vendor_name
        opts.append(_option(f"O-{q.vendor_id}", q, s, b, 0.0, q.lead_time_days, label))
        offer = offers.get(q.vendor_id)
        if offer is not None:
            lead = max(1, q.lead_time_days - offer.days_saved)
            sx = schedule_for_lead_time(q.vendor_id, lead, s.po_issue_date, s.required_on_site)
            pct = b.contingency_inr / b.quote_total_inr if b.quote_total_inr else 0.05
            bx = check_budget(q, b.budget_inr, contingency_pct=pct, expedite_fee_inr=offer.fee_inr)
            opts.append(
                _option(
                    f"O-{q.vendor_id}X",
                    q,
                    sx,
                    bx,
                    offer.fee_inr,
                    lead,
                    f"{q.vendor_name} expedited (-{offer.days_saved} d)",
                )
            )
    opts.sort(key=lambda o: (not is_feasible(o), -o.score, o.total_inr, o.option_id))
    for i, o in enumerate(opts):
        o.recommended = i == 0 and is_feasible(o)
    return opts


def _memo_id(goal: Goal, options: list[VendorOption], situation: str) -> str:
    h = hashlib.sha1(
        (
            goal.project + situation + "|".join(f"{o.option_id}:{o.total_inr}" for o in options)
        ).encode()
    ).hexdigest()[:8]
    return f"MEMO-{h.upper()}"


def memo_risks(options: list[VendorOption]) -> list[str]:
    risks: list[str] = []
    for o in options:
        if not is_feasible(o):
            continue
        if o.float_days < LOW_FLOAT_DAYS:
            risks.append(
                f"{o.option_id}: only {o.float_days} d float against the energisation "
                "window; any slip in approvals or FAT eats it."
            )
        if o.reliability < LOW_RELIABILITY:
            risks.append(
                f"{o.option_id}: {o.vendor_name} on-time record is {o.reliability:.0%}; "
                "expect expediting effort and weekly progress audits."
            )
        if o.budget_verdict == "warn":
            risks.append(
                f"{o.option_id}: above the 90% budget warning line - little headroom "
                "for variations or copper price movement."
            )
        if o.expedite_fee_inr:
            risks.append(
                f"{o.option_id}: expedite fee {_inr_lakh(o.expedite_fee_inr)} must be "
                "tied to a contractual delivery date with LDs, payable only on milestone."
            )
    return risks


def build_decision_memo(
    goal: Goal, options: list[VendorOption], situation: str, prose: str | None = None
) -> DecisionMemo:
    """Deterministic decision memo; ``prose`` (e.g. LLM-written) replaces the reasoning text."""
    if not options:
        raise ValueError("no options to decide between")
    rec = next((o for o in options if o.recommended), None)
    feasible = [o for o in options if is_feasible(o)]
    lines: list[str] = []
    if rec is None:
        top = options[0]
        lines.append(
            "No option satisfies both the budget ceiling and the required-on-site date. "
            f"Least-bad option is {top.option_id} ({top.vendor_name}); approving it needs a "
            "budget or schedule exception."
        )
        rec_id = top.option_id
    else:
        rec_id = rec.option_id
        lines.append(
            f"Recommend {rec.option_id} - {rec.vendor_name}"
            + (
                f" with expedite ({_inr_lakh(rec.expedite_fee_inr)})"
                if rec.expedite_fee_inr
                else ""
            )
            + f": total {_inr_lakh(rec.total_inr)} ex-GST, "
            f"delivery {rec.delivery_date.isoformat()} "
            f"({rec.float_days:+d} d float), on-time record {rec.reliability:.0%}, score "
            f"{rec.score:.2f}."
        )
        for alt in feasible:
            if alt.option_id == rec.option_id:
                continue
            d_cost = alt.total_inr - rec.total_inr
            d_float = alt.float_days - rec.float_days
            lines.append(
                f"Versus {alt.option_id} ({alt.vendor_name}, score {alt.score:.2f}): "
                f"{'is' if d_cost < 0 else 'costs'} {_inr_lakh(abs(d_cost))} "
                f"{'cheaper' if d_cost < 0 else 'more'} but has {abs(d_float)} d "
                f"{'more' if d_float > 0 else 'less'} float and a "
                f"{alt.reliability:.0%} vs {rec.reliability:.0%} on-time record."
            )
            if d_cost < 0 and d_float < 0:
                lines.append(
                    f"The {_inr_lakh(-d_cost)} saving buys schedule risk: missing the energisation "
                    "window delays the data-hall handover, which costs far more than the delta."
                )
    for o in options:
        if not is_feasible(o):
            lines.append(f"Rejected {o.option_id}: {o.rationale}")
    reasoning = prose.strip() if prose and prose.strip() else " ".join(lines)
    asks = (
        f"Approve vendor selection for {goal.project} {goal.package}: confirm {rec_id} or pick one "
        f"of {', '.join(o.option_id for o in feasible) or 'the listed options'}. Approval "
        f"authorises a PO to be drafted for release by {goal.need_by.isoformat()}."
    )
    return DecisionMemo(
        memo_id=_memo_id(goal, options, situation),
        title=f"{goal.project} - {goal.package}: vendor selection",
        situation=situation,
        options=options,
        recommendation=rec_id,
        reasoning=reasoning,
        risks=memo_risks(options),
        asks=asks,
    )
