"""Schedule specialist: Critical Path Method over the procurement chain of one quote.

Network for a switchgear PO (calendar days, finish-to-start)::

    PO -> SUB (shop drawings, 14) -> APR (engineer approval, 10) -+-> MFG (lead time) --+
                                                                  +-> ITP (FAT procedure |
                                                                      & ITP approval, 21)+
                                                     -> FAT (5) -> SHP (7) -> DEL (milestone)

Forward pass gives early start/finish, backward pass gives late start/finish, total float
(slack) = LS - ES; activities with zero slack form the critical path. ``schedule_for_quote``
then compares the delivery milestone with the required-on-site date: ``float_days`` is the
schedule float against that date (negative = late).

Inspired by the scheduling / estimation skills in DataDrivenConstruction's
"DDC Skills for AI Agents in Construction"
(https://github.com/datadrivenconstruction/DDC_Skills_for_AI_Agents_in_Construction,
Part III "Estimation and scheduling" and the ``schedule-delay-analyzer`` / ``budget-tracker``
skills): keep schedule math as small, deterministic, auditable functions that an agent calls
as a tool, rather than letting the model reason about dates.
"""

from __future__ import annotations

from datetime import date, timedelta

from sitemind.models import Quote, ScheduleActivity, ScheduleResult

SUBMITTAL_DAYS = 14
APPROVAL_DAYS = 10
ITP_DAYS = 21
FAT_DAYS = 5
SHIPPING_DAYS = 7  # domestic road freight incl. loading / unloading


class ScheduleError(ValueError):
    """Invalid activity network (unknown dependency or cycle)."""


def _topo_order(acts: list[ScheduleActivity]) -> list[ScheduleActivity]:
    by_id = {a.id: a for a in acts}
    if len(by_id) != len(acts):
        raise ScheduleError("duplicate activity ids")
    for a in acts:
        for d in a.depends_on:
            if d not in by_id:
                raise ScheduleError(f"activity {a.id} depends on unknown {d}")
    indeg = {a.id: len(a.depends_on) for a in acts}
    succ: dict[str, list[str]] = {a.id: [] for a in acts}
    for a in acts:
        for d in a.depends_on:
            succ[d].append(a.id)
    ready = [a.id for a in acts if indeg[a.id] == 0]  # keep input order for determinism
    order: list[str] = []
    while ready:
        nid = ready.pop(0)
        order.append(nid)
        for s in succ[nid]:
            indeg[s] -= 1
            if indeg[s] == 0:
                ready.append(s)
    if len(order) != len(acts):
        raise ScheduleError("activity network has a cycle")
    return [by_id[i] for i in order]


def critical_path(
    activities: list[ScheduleActivity], deadline_offset: int | None = None
) -> list[ScheduleActivity]:
    """Run CPM forward/backward passes; return new activities in topological order.

    ``deadline_offset`` (days from start) anchors the backward pass; by default the project
    finish (max early finish) is used, so critical activities have exactly zero slack. With a
    deadline, slack is measured against it (and may be negative); ``critical`` marks the
    activities with the minimum slack.
    """
    order = [a.model_copy(deep=True) for a in _topo_order(activities)]
    by_id = {a.id: a for a in order}
    for a in order:
        a.early_start = max((by_id[d].early_finish for d in a.depends_on), default=0)
        a.early_finish = a.early_start + a.duration_days
    finish = max((a.early_finish for a in order), default=0)
    anchor = finish if deadline_offset is None else deadline_offset
    succ: dict[str, list[str]] = {a.id: [] for a in order}
    for a in order:
        for d in a.depends_on:
            succ[d].append(a.id)
    for a in reversed(order):
        a.late_finish = min((by_id[s].late_start for s in succ[a.id]), default=anchor)
        a.late_start = a.late_finish - a.duration_days
        a.slack_days = a.late_start - a.early_start
    min_slack = min((a.slack_days for a in order), default=0)
    for a in order:
        a.critical = a.slack_days == min_slack
    return order


def procurement_activities(lead_time_days: int) -> list[ScheduleActivity]:
    """The standard PO -> delivery network for a manufactured electrical package."""
    return [
        ScheduleActivity(id="PO", name="PO issued", duration_days=0),
        ScheduleActivity(
            id="SUB",
            name="Submittals / shop drawings",
            duration_days=SUBMITTAL_DAYS,
            depends_on=["PO"],
        ),
        ScheduleActivity(
            id="APR", name="Engineer approval", duration_days=APPROVAL_DAYS, depends_on=["SUB"]
        ),
        ScheduleActivity(
            id="MFG",
            name="Manufacture (vendor lead time)",
            duration_days=lead_time_days,
            depends_on=["APR"],
        ),
        ScheduleActivity(
            id="ITP",
            name="FAT procedure & ITP approval",
            duration_days=ITP_DAYS,
            depends_on=["APR"],
        ),
        ScheduleActivity(
            id="FAT",
            name="Factory acceptance test (witnessed)",
            duration_days=FAT_DAYS,
            depends_on=["MFG", "ITP"],
        ),
        ScheduleActivity(
            id="SHP",
            name="Shipping to site (domestic)",
            duration_days=SHIPPING_DAYS,
            depends_on=["FAT"],
        ),
        ScheduleActivity(id="DEL", name="Delivered to site", duration_days=0, depends_on=["SHP"]),
    ]


def schedule_for_lead_time(
    vendor_id: str, lead_time_days: int, po_issue_date: date, required_on_site: date
) -> ScheduleResult:
    """CPM schedule for a given manufacturing lead time (used for expedite what-ifs too)."""
    acts = critical_path(procurement_activities(lead_time_days))
    finish = max(a.early_finish for a in acts)
    delivery = po_issue_date + timedelta(days=finish)
    float_days = (required_on_site - delivery).days
    return ScheduleResult(
        vendor_id=vendor_id,
        activities=acts,
        critical_path=[a.id for a in acts if a.critical],
        po_issue_date=po_issue_date,
        delivery_date=delivery,
        required_on_site=required_on_site,
        float_days=float_days,
        meets_deadline=float_days >= 0,
    )


def schedule_for_quote(quote: Quote, po_issue_date: date, required_on_site: date) -> ScheduleResult:
    """CPM schedule PO issue -> delivery for a vendor quote."""
    return schedule_for_lead_time(
        quote.vendor_id, quote.lead_time_days, po_issue_date, required_on_site
    )


def latest_po_date(lead_time_days: int, required_on_site: date) -> date:
    """Last PO issue date that still delivers on ``required_on_site`` (zero float)."""
    acts = critical_path(procurement_activities(lead_time_days))
    return required_on_site - timedelta(days=max(a.early_finish for a in acts))
