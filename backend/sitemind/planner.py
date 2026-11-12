"""Planner: goal -> dependency DAG of :class:`PlanTask` with deadlines, allowances and risks.

The *structure* of a plan is deterministic (so it is testable and replayable); the LLM only
words the rationale and the risk mitigations, with a template fallback.

Task ids follow ``T<n>-<action>[-<vendor>]`` and the graph dispatches on ``<action>``:

=================  ===========  =============================================================
action             specialist   meaning
=================  ===========  =============================================================
takeoff            takeoff      read spec PDF -> bill of quantities
rfq                quotes       send RFQs to every vendor, retry on timeout, collect quotes
levelling          quotes       bid levelling: refresh/confirm each quote before evaluation
schedule-<V>       schedule     CPM schedule for vendor V (delivery vs required-on-site)
budget-<V>         budget       budget check for vendor V
negotiate-<V>      quotes       (re-plan) re-quote / negotiate a revised price with V
expedite-<V>       schedule     (re-plan) evaluate V's expedite offer (schedule + budget)
chase-<V>          quotes       (re-plan) final chase of an unresponsive vendor, then exclude
rank               approvals    rank options, write decision memo
escalate           approvals    (re-plan) escalate the trade-off to the project manager
approve-vendor     approvals    HITL: vendor selection
draft-po           po           draft purchase order for the selected option
approve-po         approvals    HITL: PO release
send-po            po           transmit PO to vendor (external side effect)
=================  ===========  =============================================================
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from datetime import date, datetime, timedelta
from typing import Any

from pydantic import BaseModel, Field

from .llm import LLM
from .models import Goal, Plan, PlanTask, Risk, SpecialistSpec, TaskStatus

DEFAULT_VENDORS = ("V1", "V2", "V3")
ACTION_SPECIALIST = {
    "takeoff": "takeoff",
    "rfq": "quotes",
    "levelling": "quotes",
    "schedule": "schedule",
    "budget": "budget",
    "negotiate": "quotes",
    "expedite": "schedule",
    "chase": "quotes",
    "rank": "approvals",
    "escalate": "approvals",
    "approve-vendor": "approvals",
    "draft-po": "po",
    "approve-po": "approvals",
    "send-po": "po",
}
HUMAN_ACTIONS = frozenset({"approve-vendor", "approve-po"})
# Process-cost allowance per task (INR): engineer hours, RFQ admin, legal vetting...
ALLOWANCE_INR = {
    "takeoff": 25_000.0,
    "rfq": 18_000.0,
    "levelling": 20_000.0,
    "schedule": 6_000.0,
    "budget": 4_000.0,
    "negotiate": 15_000.0,
    "expedite": 8_000.0,
    "chase": 3_000.0,
    "rank": 10_000.0,
    "escalate": 2_000.0,
    "approve-vendor": 0.0,
    "draft-po": 15_000.0,
    "approve-po": 0.0,
    "send-po": 2_000.0,
}
_ID_RE = re.compile(r"^T(?P<n>\d+)-(?P<rest>.+)$")
_VENDOR_RE = re.compile(r"^V\d+$")


class PlanError(ValueError):
    pass


# --------------------------------------------------------------------------- id helpers


def task_action(task: PlanTask | str) -> tuple[str, str | None]:
    """``"T4-schedule-V1"`` -> ``("schedule", "V1")``; ``"T6-rank"`` -> ``("rank", None)``."""
    tid = task if isinstance(task, str) else task.id
    m = _ID_RE.match(tid)
    if not m:
        raise PlanError(f"bad task id {tid!r}")
    rest = m.group("rest")
    head, _, tail = rest.rpartition("-")
    if head and _VENDOR_RE.match(tail):
        return head, tail
    return rest, None


def _task_no(tid: str) -> int:
    m = _ID_RE.match(tid)
    return int(m.group("n")) if m else 0


def _next_no(plan: Plan) -> int:
    return max((_task_no(t.id) for t in plan.tasks), default=0) + 1


# --------------------------------------------------------------------------- DAG helpers


def validate_plan(plan: Plan) -> None:
    """Raise :class:`PlanError` unless ids are unique, deps exist, DAG is acyclic and no
    live task depends on a superseded one."""
    ids = [t.id for t in plan.tasks]
    if len(ids) != len(set(ids)):
        raise PlanError("duplicate task ids")
    by_id = {t.id: t for t in plan.tasks}
    for t in plan.tasks:
        task_action(t)
        for d in t.depends_on:
            if d not in by_id:
                raise PlanError(f"{t.id} depends on unknown task {d}")
            if d == t.id:
                raise PlanError(f"{t.id} depends on itself")
            if t.status in (TaskStatus.pending, TaskStatus.ready) and (
                by_id[d].status in (TaskStatus.skipped, TaskStatus.failed)
            ):
                raise PlanError(f"live task {t.id} depends on dead task {d}")
    topo_order(plan)


def topo_order(plan: Plan) -> list[str]:
    """Kahn topological order, stable by plan order. Raises on cycles."""
    order_idx = {t.id: i for i, t in enumerate(plan.tasks)}
    indeg = {t.id: len(set(t.depends_on)) for t in plan.tasks}
    children: dict[str, list[str]] = {t.id: [] for t in plan.tasks}
    for t in plan.tasks:
        for d in set(t.depends_on):
            children.setdefault(d, []).append(t.id)
    ready = sorted((i for i, n in indeg.items() if n == 0), key=order_idx.__getitem__)
    out: list[str] = []
    while ready:
        cur = ready.pop(0)
        out.append(cur)
        for ch in children.get(cur, []):
            indeg[ch] -= 1
            if indeg[ch] == 0:
                ready.append(ch)
                ready.sort(key=order_idx.__getitem__)
    if len(out) != len(plan.tasks):
        raise PlanError("plan has a dependency cycle")
    return out


def ready_tasks(plan: Plan) -> list[PlanTask]:
    """Pending tasks whose dependencies are all done, in topological order."""
    by_id = {t.id: t for t in plan.tasks}
    res = []
    for tid in topo_order(plan):
        t = by_id[tid]
        if t.status not in (TaskStatus.pending, TaskStatus.ready):
            continue
        if all(by_id[d].status == TaskStatus.done for d in t.depends_on):
            res.append(t)
    return res


def is_complete(plan: Plan) -> bool:
    """No live work left (failed = rejected approvals already handled by a re-plan)."""
    return all(
        t.status in (TaskStatus.done, TaskStatus.skipped, TaskStatus.failed) for t in plan.tasks
    )


def descendants(plan: Plan, task_id: str) -> set[str]:
    kids: dict[str, set[str]] = {}
    for t in plan.tasks:
        for d in t.depends_on:
            kids.setdefault(d, set()).add(t.id)
    out: set[str] = set()
    stack = [task_id]
    while stack:
        for k in kids.get(stack.pop(), set()):
            if k not in out:
                out.add(k)
                stack.append(k)
    return out


def get_task(plan: Plan, task_id: str) -> PlanTask:
    for t in plan.tasks:
        if t.id == task_id:
            return t
    raise KeyError(task_id)


# --------------------------------------------------------------------------- narrative (LLM)


class PlanNarrative(BaseModel):
    rationale: str = Field(description="Two sentences explaining the plan")
    mitigations: list[str] = Field(description="One short mitigation per risk, same order")


def _fmt_inr(x: float) -> str:
    return f"₹{x / 1e7:.2f} Cr" if x >= 1e7 else f"₹{x / 1e5:.1f} L"


def _narrate(
    llm: LLM | None,
    key: str,
    prompt: str,
    fallback: PlanNarrative,
    sim_time: datetime,
) -> tuple[PlanNarrative, dict[str, Any]]:
    if llm is None:
        return fallback, {"provider": "off", "model": "template", "tokens": 0, "cached": False}
    res = llm.complete_json(prompt, PlanNarrative, key, fallback=fallback, sim_time=sim_time)
    value = res.value
    if not value.rationale.strip():
        value = fallback
    meta = {
        "provider": res.provider,
        "model": res.model,
        "tokens": res.tokens,
        "latency_ms": res.latency_ms,
        "cached": res.cached,
        "error": res.error,
    }
    return value, meta


def _apply_mitigations(risks: list[Risk], mitigations: Sequence[str]) -> list[Risk]:
    out = []
    for i, r in enumerate(risks):
        m = mitigations[i].strip() if i < len(mitigations) else ""
        out.append(r.model_copy(update={"mitigation": m[:300]}) if len(m) > 12 else r)
    return out


# --------------------------------------------------------------------------- make_plan


def base_risks(goal: Goal) -> list[Risk]:
    ros = goal.required_on_site.isoformat() if goal.required_on_site else "the energisation date"
    return [
        Risk(
            id="R1-lead-time",
            title=f"Switchgear manufacturing lead time (16-24 weeks) vs on-site date {ros}",
            likelihood="high",
            impact="high",
            mitigation="Compute CPM float per vendor; prefer on-time options and price expedite "
            "offers before deciding.",
        ),
        Risk(
            id="R2-price-volatility",
            title="Copper-linked price volatility and short quote validity",
            likelihood="medium",
            impact="high",
            mitigation="Refresh every quote before evaluation and re-check budget on any revision.",
        ),
        Risk(
            id="R3-vendor-non-response",
            title="Vendor non-response to RFQ",
            likelihood="medium",
            impact="medium",
            mitigation="Retry RFQs up to 3 times with escalating follow-up; never block on one "
            "vendor.",
        ),
        Risk(
            id="R4-spec-ambiguity",
            title="Drawing vs equipment-schedule discrepancies in the spec",
            likelihood="low",
            impact="medium",
            mitigation="Schedule governs; surface takeoff warnings as RFIs with the source page.",
        ),
        Risk(
            id="R5-approval-latency",
            title="Human approvals close to the order-by date",
            likelihood="medium",
            impact="medium",
            mitigation=f"Request vendor selection approval by {goal.need_by - timedelta(days=7)} "
            "with a ranked decision memo.",
        ),
    ]


def _deadlines(start: date, need_by: date) -> dict[str, date]:
    def clamp(d: date) -> date:
        return min(max(d, start), need_by)

    return {
        "takeoff": clamp(start + timedelta(days=1)),
        "rfq": clamp(start + timedelta(days=10)),
        "levelling": clamp(start + timedelta(days=14)),
        "schedule": clamp(need_by - timedelta(days=17)),
        "budget": clamp(need_by - timedelta(days=17)),
        "negotiate": clamp(need_by - timedelta(days=15)),
        "expedite": clamp(need_by - timedelta(days=15)),
        "chase": clamp(need_by - timedelta(days=15)),
        "rank": clamp(need_by - timedelta(days=12)),
        "escalate": clamp(need_by - timedelta(days=10)),
        "approve-vendor": clamp(need_by - timedelta(days=7)),
        "draft-po": clamp(need_by - timedelta(days=5)),
        "approve-po": clamp(need_by - timedelta(days=2)),
        "send-po": need_by,
    }


def _mk(
    n: int,
    action: str,
    title: str,
    deps: list[str],
    deadlines: dict[str, date],
    version: int,
    vendor: str | None = None,
    budget: float | None = None,
    note: str | None = None,
) -> PlanTask:
    tid = f"T{n}-{action}" + (f"-{vendor}" if vendor else "")
    return PlanTask(
        id=tid,
        title=title,
        specialist=ACTION_SPECIALIST[action],
        depends_on=deps,
        deadline=deadlines[action],
        budget_inr=ALLOWANCE_INR[action] if budget is None else budget,
        plan_version=version,
        output_ref=action if vendor is None else f"{action}:{vendor}",
        note=note,
    )


def make_plan(
    goal: Goal,
    registry: Iterable[SpecialistSpec] | None,
    now: datetime,
    llm: LLM | None = None,
    *,
    vendor_ids: Sequence[str] = DEFAULT_VENDORS,
) -> Plan:
    """Decompose the goal into a backward-scheduled task DAG (plan v1)."""
    names = {s.name for s in registry} if registry else None
    if names is not None:
        missing = set(ACTION_SPECIALIST.values()) - names
        if missing:
            raise PlanError(f"registry lacks specialists: {sorted(missing)}")
    dl = _deadlines(now.date(), goal.need_by)
    tasks: list[PlanTask] = []
    n = 1

    def add(action: str, title: str, deps: list[str], **kw: Any) -> PlanTask:
        nonlocal n
        t = _mk(n, action, title, deps, dl, 1, **kw)
        tasks.append(t)
        n += 1
        return t

    takeoff = add("takeoff", f"Take off {goal.package} quantities from the spec PDF", [])
    rfq = add(
        "rfq",
        f"Send RFQs to {len(vendor_ids)} vendors and collect quotes (retry ≤3)",
        [takeoff.id],
    )
    lev = add("levelling", "Bid levelling: refresh and confirm every quote", [rfq.id])
    evals: list[str] = []
    for v in vendor_ids:
        evals.append(add("schedule", f"CPM schedule check for {v}", [lev.id], vendor=v).id)
    for v in vendor_ids:
        evals.append(add("budget", f"Budget check for {v}", [lev.id], vendor=v).id)
    rank = add("rank", "Rank vendor options and write the decision memo", evals)
    appr = add("approve-vendor", "Human approval: vendor selection", [rank.id])
    draft = add("draft-po", "Draft the purchase order for the selected vendor", [appr.id])
    appo = add("approve-po", "Human approval: PO release", [draft.id])
    add("send-po", "Transmit the PO to the vendor (idempotent)", [appo.id])

    risks = base_risks(goal)
    fallback = PlanNarrative(
        rationale=(
            f"Work backwards from the order-by date {goal.need_by}: quantities first, then "
            f"competitive quotes from {len(vendor_ids)} vendors, each checked against the "
            f"on-site date with CPM and against the {_fmt_inr(goal.budget_inr)} budget. "
            "A ranked decision memo goes to the project manager before any PO is released."
        ),
        mitigations=[r.mitigation for r in risks],
    )
    prompt = (
        f"Goal: {goal.text}. Plan: takeoff, RFQ to {len(vendor_ids)} vendors, schedule and "
        "budget check per vendor, decision memo, human approval, PO. Risks: "
        + "; ".join(f"{i + 1}) {r.title}" for i, r in enumerate(risks))
        + ". Return JSON with 'rationale' (2 sentences) and 'mitigations' (one short "
        "sentence per risk, same order)."
    )
    narrative, _meta = _narrate(llm, "plan-v1:llm:rationale", prompt, fallback, now)
    plan = Plan(
        version=1,
        tasks=tasks,
        risks=_apply_mitigations(risks, narrative.mitigations),
        rationale=narrative.rationale.strip()[:900],
        created_at=now,
    )
    validate_plan(plan)
    return plan


# --------------------------------------------------------------------------- replan


def parse_trigger(trigger: str) -> tuple[str, str]:
    kind, _, arg = trigger.partition(":")
    return kind, arg


def replan(
    plan: Plan,
    trigger: str | Sequence[str],
    facts: dict[str, Any],
    now: datetime,
    llm: LLM | None = None,
    *,
    goal: Goal | None = None,
) -> Plan:
    """Produce plan ``version + 1`` reacting to ``trigger`` (one or many).

    Done tasks stay done; superseded pending tasks become ``skipped``; new tasks are added and
    downstream tasks are re-wired. Triggers:

    * ``budget_breach:<V>`` / ``quote_revised:<V>`` -> negotiate/re-quote with V
    * ``deadline_break:<V>`` -> evaluate V's expedite offer (if any)
    * ``vendor_unresponsive:<V>`` -> final chase, then exclude
    * ``approval_rejected:<task_id>`` -> redo the decision (or PO) downstream of that approval
    """
    triggers = [trigger] if isinstance(trigger, str) else list(trigger)
    new = plan.model_copy(deep=True)
    new.version = plan.version + 1
    new.created_at = now
    v = new.version
    by_id = {t.id: t for t in new.tasks}
    goal_need_by = goal.need_by if goal else _guess_need_by(new)
    dl = _deadlines(now.date(), goal_need_by)
    n = _next_no(new)
    changes: list[str] = []
    added: list[PlanTask] = []
    expedite_offers: dict[str, Any] = dict(facts.get("expedite_offers") or {})

    def add(action: str, title: str, deps: list[str], **kw: Any) -> PlanTask:
        nonlocal n
        t = _mk(n, action, title, deps, dl, v, **kw)
        n += 1
        new.tasks.append(t)
        by_id[t.id] = t
        added.append(t)
        return t

    def skip(t: PlanTask, why: str) -> None:
        if t.status in (TaskStatus.pending, TaskStatus.ready):
            t.status = TaskStatus.skipped
            t.note = f"superseded by plan v{v}: {why}"
            changes.append(f"skip {t.id}")

    def live(action: str) -> list[PlanTask]:
        return [
            t
            for t in new.tasks
            if task_action(t)[0] == action and t.status in (TaskStatus.pending, TaskStatus.ready)
        ]

    eval_triggers = [
        parse_trigger(t)
        for t in triggers
        if parse_trigger(t)[0]
        in ("budget_breach", "quote_revised", "deadline_break", "vendor_unresponsive")
    ]
    rejections = [
        parse_trigger(t)[1] for t in triggers if parse_trigger(t)[0] == "approval_rejected"
    ]

    if eval_triggers:
        old_ranks = live("rank")
        new_deps: list[str] = []
        seen: set[tuple[str, str]] = set()
        for kind, vendor in eval_triggers:
            if (kind, vendor) in seen:
                continue
            seen.add((kind, vendor))
            if kind in ("budget_breach", "quote_revised") and not any(
                task_action(t) == ("negotiate", vendor) for t in new.tasks
            ):
                t = add(
                    "negotiate",
                    f"Re-quote / negotiate {vendor}'s revised price back inside budget",
                    [],
                    vendor=vendor,
                    note=f"trigger {kind}:{vendor}",
                )
                new_deps.append(t.id)
                changes.append(f"add {t.id}")
            elif kind == "deadline_break" and not any(
                task_action(t) == ("expedite", vendor) for t in new.tasks
            ):
                offer = expedite_offers.get(vendor) or {}
                fee = float(offer.get("fee_inr", 0.0) or 0.0)
                if offer:
                    t = add(
                        "expedite",
                        f"Evaluate {vendor} expedite offer (−{offer.get('days', '?')} d for "
                        f"{_fmt_inr(fee)})",
                        [],
                        vendor=vendor,
                        budget=fee,
                        note=f"trigger {kind}:{vendor}",
                    )
                    new_deps.append(t.id)
                    changes.append(f"add {t.id}")
            elif kind == "vendor_unresponsive" and not any(
                task_action(t) == ("chase", vendor) for t in new.tasks
            ):
                t = add(
                    "chase",
                    f"Final chase of {vendor}; exclude if still silent",
                    [],
                    vendor=vendor,
                    note=f"trigger {kind}:{vendor}",
                )
                new_deps.append(t.id)
                changes.append(f"add {t.id}")
        # every evaluation task already completed remains an input of the new ranking
        done_lev = [
            t.id
            for t in new.tasks
            if task_action(t)[0] == "levelling" and t.status == TaskStatus.done
        ]
        anchor = done_lev[-1:]
        for t in added:
            t.depends_on = list(anchor)
        rank = add(
            "rank",
            "Re-rank options with negotiated / expedited figures; rewrite decision memo",
            sorted(set(new_deps)) or anchor,
        )
        esc = add(
            "escalate",
            "Escalate budget / deadline trade-off to the project manager",
            [rank.id],
        )
        for old in old_ranks:
            skip(old, "options changed (" + ", ".join(f"{k}:{a}" for k, a in seen) + ")")
            for t in new.tasks:
                if old.id in t.depends_on and t.status in (TaskStatus.pending, TaskStatus.ready):
                    t.depends_on = [esc.id if d == old.id else d for d in t.depends_on]
                    changes.append(f"rewire {t.id} -> {esc.id}")
        changes.extend([f"add {rank.id}", f"add {esc.id}"])

    for appr_id in rejections:
        if appr_id not in by_id:
            continue
        appr = by_id[appr_id]
        action, _ = task_action(appr)
        downstream = [
            by_id[d]
            for d in topo_order(new)
            if d in descendants(new, appr_id)
            and by_id[d].status in (TaskStatus.pending, TaskStatus.ready)
        ]
        for t in downstream:
            skip(t, f"{appr_id} rejected")
        if appr.status in (TaskStatus.pending, TaskStatus.ready, TaskStatus.waiting_human):
            appr.status = TaskStatus.failed
            appr.note = "rejected by human"
        prev: list[str] = [d for d in appr.depends_on if by_id[d].status == TaskStatus.done]
        if action == "approve-vendor":
            r = add("rank", "Re-rank options excluding the rejected option", prev)
            a = add("approve-vendor", "Human approval: vendor selection (re-submitted)", [r.id])
            prev = [a.id]
            changes += [f"add {r.id}", f"add {a.id}"]
        elif action == "approve-po":
            d = add("draft-po", "Re-draft the PO addressing reviewer comments", prev)
            a = add("approve-po", "Human approval: PO release (re-submitted)", [d.id])
            prev = [a.id]
            changes += [f"add {d.id}", f"add {a.id}"]
        for t in downstream:
            act, vend = task_action(t)
            c = add(act, t.title, prev, vendor=vend)
            prev = [c.id]
            changes.append(f"add {c.id}")

    if not changes:
        changes.append("no structural change")

    new.risks = list(new.risks)
    rids = {r.id for r in new.risks}
    if any(k in ("budget_breach", "quote_revised") for k, _ in eval_triggers) and (
        "R6-budget-breach" not in rids
    ):
        new.risks.append(
            Risk(
                id="R6-budget-breach",
                title="Revised quote pushes committed cost over the budget ceiling",
                likelihood="high",
                impact="high",
                mitigation="Negotiate the surcharge, compare against alternates, and escalate "
                "a budget exception only with a ranked memo.",
            )
        )
    if any(k == "deadline_break" for k, _ in eval_triggers) and "R7-expedite" not in rids:
        new.risks.append(
            Risk(
                id="R7-expedite",
                title="Expedited manufacturing slot may slip",
                likelihood="medium",
                impact="high",
                mitigation="Tie the expedite fee to a liquidated-damages clause and weekly "
                "works-progress reports.",
            )
        )

    fallback = (
        f"Plan v{v} reacts to {', '.join(triggers)}: "
        + "; ".join(changes[:6])
        + ". Completed work is kept; only the affected decision path is redone."
    )
    if llm is not None:
        prompt = (
            f"Procurement re-plan. Triggers: {', '.join(triggers)}. Facts: "
            f"{_trigger_facts(facts, triggers)}. Changes: {'; '.join(changes[:8])}. "
            "In 2 sentences, explain why the plan changed and what happens next."
        )
        res = llm.complete_text(prompt, f"plan-v{v}:llm:replan", fallback=fallback, sim_time=now)
        new.rationale = res.value.strip()[:900] or fallback
    else:
        new.rationale = fallback
    validate_plan(new)
    return new


def _trigger_facts(facts: dict[str, Any], triggers: Sequence[str]) -> str:
    bits = []
    for t in triggers:
        kind, arg = parse_trigger(t)
        detail = (facts.get("trigger_details") or {}).get(t)
        bits.append(f"{t}={detail}" if detail else t)
        del kind, arg
    return "; ".join(bits)[:400]


def _guess_need_by(plan: Plan) -> date:
    dates = [t.deadline for t in plan.tasks if t.deadline]
    return max(dates) if dates else plan.created_at.date() + timedelta(days=60)
