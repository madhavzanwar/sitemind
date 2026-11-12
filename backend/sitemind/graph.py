"""Durable LangGraph state machine: plan -> execute(1 task) -> monitor -> [replan] -> finish.

* Compiled with ``SqliteSaver`` (thread_id = run_id); every super-step runs exactly ONE plan
  task, so a checkpoint is persisted after every task (``durability="sync"``).
* Every external side effect (RFQ, quote refresh, negotiation, PM notification, approval
  request, PO transmission, LLM call) goes through ``store.perform_once`` - a node replayed
  after ``kill -9`` returns the stored results instead of acting twice.
* Audit / timeline writes carry deterministic dedupe keys, so replays never duplicate them.
* Sim time lives in the checkpointed state and is mirrored to the run's ``SimClock``.
* HITL approvals use ``interrupt()``; the approval row is created (idempotently) first.
"""

from __future__ import annotations

import contextlib
import sqlite3
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Literal, TypedDict, cast

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

from .clock import SimClock
from .config import Settings, get_settings
from .llm import LLM, LLMResult
from .models import (
    ApprovalRequest,
    ApprovalStatus,
    BudgetCheck,
    DecisionMemo,
    Goal,
    Plan,
    PlanTask,
    PurchaseOrder,
    Quote,
    ScheduleResult,
    TakeoffLine,
    TakeoffResult,
    TaskStatus,
    TimelineEvent,
    VendorAttempt,
    VendorOption,
)
from .planner import (
    HUMAN_ACTIONS,
    get_task,
    is_complete,
    make_plan,
    ready_tasks,
    replan,
    task_action,
)
from .specialists._data import SPEC_PDF, load_scenario
from .specialists.approvals import build_decision_memo, is_feasible, rank_options
from .specialists.budget import check_budget
from .specialists.quotes import collect_quotes, refresh_quotes
from .specialists.schedule import schedule_for_lead_time, schedule_for_quote
from .specialists.takeoff import run_takeoff
from .specialists.vendors import ExpediteOffer, VendorNetwork, VendorTimeout
from .store import Store

# --------------------------------------------------------------------------- sim durations

DURATION_DAYS: dict[str, float] = {
    "takeoff": 0.5,
    "rfq": 2.0,  # per attempt window (RFQ round trip); actual = attempts * window
    "levelling": 3.0,
    "schedule": 0.25,
    "budget": 0.25,
    "negotiate": 4.0,
    "expedite": 2.0,
    "chase": 2.0,
    "rank": 1.0,
    "escalate": 0.5,
    "approve-vendor": 5.0,  # human turnaround (steering committee)
    "draft-po": 3.0,
    "approve-po": 3.0,  # human turnaround (finance sign-off)
    "send-po": 0.5,
}
RFQ_WINDOW_DAYS = 2.0
RFQ_MAX_ATTEMPTS = 3
PO_BUFFER_DAYS = 3.0  # schedule-risk buffer on the projected PO issue date
REPLAN_HOURS = 3.0
ROBUST_FLOAT_DAYS = 14  # an option with less float is "thin" (see approvals.LOW_FLOAT_DAYS)
PROCESS_COST_INR: dict[str, float] = {
    "takeoff": 21_000.0,
    "rfq": 6_000.0,  # per RFQ actually sent
    "levelling": 16_000.0,
    "schedule": 4_500.0,
    "budget": 3_000.0,
    "negotiate": 12_000.0,
    "expedite": 6_500.0,
    "chase": 2_500.0,
    "rank": 8_000.0,
    "escalate": 1_500.0,
    "approve-vendor": 0.0,
    "draft-po": 12_500.0,
    "approve-po": 0.0,
    "send-po": 1_500.0,
}


class RunState(TypedDict, total=False):
    run_id: str
    goal: dict[str, Any]
    scenario: str
    sim_now: str
    plan: dict[str, Any] | None
    plan_history: list[dict[str, Any]]
    facts: dict[str, Any]
    triggers: list[str]
    handled: list[str]
    last_task: str | None


# --------------------------------------------------------------------------- runtime


@dataclass
class Runtime:
    run_id: str
    store: Store
    settings: Settings
    llm: LLM
    goal: Goal
    scenario_name: str
    scenario: dict[str, Any]
    network: VendorNetwork
    spec_pdf: Path = SPEC_PDF
    step_delay: float = 0.0
    on_step: Callable[[str], None] | None = None

    @property
    def clock(self) -> SimClock:
        return SimClock(self.store, self.run_id)


def make_runtime(run_id: str, store: Store, settings: Settings | None = None) -> Runtime:
    settings = settings or get_settings()
    run = store.get_run(run_id)
    if run is None:
        raise KeyError(f"unknown run {run_id}")
    scenario = load_scenario(run.scenario)
    delay = run.step_delay if run.step_delay is not None else settings.step_delay_s
    return Runtime(
        run_id=run_id,
        store=store,
        settings=settings,
        llm=LLM(settings, store, run_id),
        goal=run.goal,
        scenario_name=run.scenario,
        scenario=scenario,
        network=VendorNetwork(scenario),
        step_delay=float(delay or 0.0),
    )


def initial_state(rt: Runtime, sim_start: datetime) -> RunState:
    return RunState(
        run_id=rt.run_id,
        goal=rt.goal.model_dump(mode="json"),
        scenario=rt.scenario_name,
        sim_now=sim_start.isoformat(),
        plan=None,
        plan_history=[],
        facts={},
        triggers=[],
        handled=[],
        last_task=None,
    )


# --------------------------------------------------------------------------- formatting


def inr(x: float) -> str:
    if abs(x) >= 1e7:
        return f"₹{x / 1e7:.2f} Cr"
    if abs(x) >= 1e5:
        return f"₹{x / 1e5:.1f} L"
    return f"₹{x:,.0f}"


def _d(dt: datetime | date) -> str:
    return dt.strftime("%d %b")


# --------------------------------------------------------------------------- node context


@dataclass
class Ctx:
    """Per-node helper: deterministic dedupe keys for audit/timeline, sim time, ledger."""

    rt: Runtime
    scope: str
    now: datetime
    plan_version: int | None
    task_id: str | None = None
    facts: dict[str, Any] = field(default_factory=dict)
    n: int = 0
    cost: float = 0.0
    tokens: int = 0

    def at(self, days: float = 0.0, hours: float = 0.0) -> datetime:
        return self.now + timedelta(days=days, hours=hours)

    def _key(self, kind: str) -> str:
        self.n += 1
        return f"{self.rt.run_id}:{self.scope}:{self.n}:{kind}"

    def audit(
        self,
        actor: str,
        action: str,
        summary: str,
        *,
        sim_time: datetime | None = None,
        inputs: dict[str, Any] | None = None,
        outputs: dict[str, Any] | None = None,
        cost_inr: float = 0.0,
        llm_tokens: int = 0,
        confidence: float | None = None,
    ) -> None:
        self.rt.store.add_audit(
            self.rt.run_id,
            sim_time=sim_time or self.now,
            actor=actor,
            action=action,
            summary=summary,
            inputs=inputs,
            outputs=outputs,
            cost_inr=cost_inr,
            llm_tokens=llm_tokens,
            confidence=confidence,
            task_id=self.task_id,
            plan_version=self.plan_version,
            dedupe_key=self._key(f"audit:{action}"),
        )

    def event(
        self,
        lane: str,
        label: str,
        kind: Literal["info", "success", "warning", "error", "human", "kill"] = "info",
        sim_time: datetime | None = None,
    ) -> None:
        self.rt.store.add_timeline(
            self.rt.run_id,
            TimelineEvent(sim_time=sim_time or self.now, lane=lane, label=label, kind=kind),
            dedupe_key=self._key("timeline"),
        )

    def once(
        self,
        action: str,
        disc: str,
        kind: str,
        payload: dict[str, Any],
        fn: Callable[[], dict[str, Any]],
        sim_time: datetime | None = None,
    ) -> dict[str, Any]:
        key = f"{self.rt.run_id}:{self.task_id or self.scope}:{action}:{disc}"
        return self.rt.store.perform_once(
            key, kind, payload, fn, run_id=self.rt.run_id, sim_time=sim_time or self.now
        )

    def llm_meta(self, res: LLMResult[Any]) -> dict[str, Any]:
        if not res.cached:
            self.tokens += res.tokens
        return {
            "provider": res.provider,
            "model": res.model,
            "tokens": res.tokens,
            "latency_ms": res.latency_ms,
            "cached": res.cached,
            "key": res.key,
            **({"error": res.error} if res.error else {}),
        }


# ------------------------------------------------------------------ ledger-backed vendor channel


class LedgerNetwork:
    """Wraps :class:`VendorNetwork` so each vendor message is sent at most once."""

    def __init__(self, inner: VendorNetwork, ctx: Ctx) -> None:
        self.inner = inner
        self.ctx = ctx
        self.sent = 0

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)

    def request_quote(
        self, vendor_id: str, lines: list[TakeoffLine], attempt: int, now: datetime
    ) -> Quote:
        ctx = self.ctx
        ref = f"RFQ-{ctx.rt.run_id[-6:]}-{vendor_id}-A{attempt}"

        def fn() -> dict[str, Any]:
            ctx.rt.store.outbox_send(
                ctx.rt.run_id,
                channel="rfq",
                vendor_id=vendor_id,
                ref=ref,
                idempotency_key=f"{ctx.task_id}:rfq:{vendor_id}:a{attempt}",
                payload={"attempt": attempt, "lines": [ln.item_code for ln in lines]},
                sim_time=now,
            )
            self.sent += 1
            try:
                q = self.inner.request_quote(vendor_id, lines, attempt, now)
            except VendorTimeout as exc:
                return {"ref": ref, "timeout": True, "hours": exc.timeout_hours}
            return {"ref": ref, "quote": q.model_dump(mode="json")}

        res = ctx.once(
            "rfq",
            f"{vendor_id}:a{attempt}",
            "rfq.sent",
            {"vendor_id": vendor_id, "attempt": attempt, "ref": ref},
            fn,
            sim_time=now,
        )
        if res.get("timeout"):
            raise VendorTimeout(vendor_id, attempt, int(res.get("hours", 24)))
        return Quote.model_validate(res["quote"])

    def refresh_quote(self, vendor_id: str, quote: Quote, now: datetime) -> Quote:
        return self._refresh("refresh", vendor_id, quote, now)

    def _refresh(self, action: str, vendor_id: str, quote: Quote, now: datetime) -> Quote:
        ctx = self.ctx
        ref = f"{action.upper()}-{quote.quote_id}"

        def fn() -> dict[str, Any]:
            ctx.rt.store.outbox_send(
                ctx.rt.run_id,
                channel=action,
                vendor_id=vendor_id,
                ref=ref,
                idempotency_key=f"{ctx.task_id}:{action}:{vendor_id}:r{quote.revision}",
                payload={"quote_id": quote.quote_id, "revision": quote.revision},
                sim_time=now,
            )
            q = self.inner.refresh_quote(vendor_id, quote, now)
            return {"ref": ref, "quote": q.model_dump(mode="json")}

        res = ctx.once(
            action,
            f"{vendor_id}:r{quote.revision}",
            f"quote.{action}",
            {"vendor_id": vendor_id, "quote_id": quote.quote_id},
            fn,
            sim_time=now,
        )
        return Quote.model_validate(res["quote"])


# --------------------------------------------------------------------------- fact helpers


def _quotes(facts: dict[str, Any]) -> dict[str, Quote]:
    return {k: Quote.model_validate(v) for k, v in (facts.get("quotes") or {}).items()}


def _priced(facts: dict[str, Any]) -> list[Quote]:
    return [
        q
        for _, q in sorted(_quotes(facts).items())
        if q.status not in ("timeout", "declined") and q.lines
    ]


def _budgets(facts: dict[str, Any]) -> dict[str, BudgetCheck]:
    return {k: BudgetCheck.model_validate(v) for k, v in (facts.get("budgets") or {}).items()}


def _schedules(facts: dict[str, Any]) -> dict[str, ScheduleResult]:
    return {k: ScheduleResult.model_validate(v) for k, v in (facts.get("schedules") or {}).items()}


def _offers(facts: dict[str, Any]) -> dict[str, ExpediteOffer]:
    return {
        k: ExpediteOffer(
            vendor_id=k,
            days_saved=int(v["days"]),
            fee_inr=float(v["fee_inr"]),
            description=str(v.get("description", "")),
        )
        for k, v in (facts.get("expedite_offers") or {}).items()
    }


def _required_on_site(rt: Runtime) -> date:
    if rt.goal.required_on_site:
        return rt.goal.required_on_site
    return date.fromisoformat(str(rt.scenario.get("required_on_site", "2027-07-30")))


def projected_po_date(plan: Plan, now: datetime, exclude: str | None = None) -> date:
    """Expected PO issue date: now + remaining (sequential) task durations + buffer."""
    remaining = 0.0
    for t in plan.tasks:
        if t.id == exclude or t.status in (TaskStatus.done, TaskStatus.skipped, TaskStatus.failed):
            continue
        action, _ = task_action(t)
        if action == "send-po":
            continue
        if action == "rfq":
            remaining += RFQ_WINDOW_DAYS * RFQ_MAX_ATTEMPTS
        else:
            remaining += DURATION_DAYS.get(action, 0.5)
    return (now + timedelta(days=remaining + PO_BUFFER_DAYS)).date()


def _add_budget_point(facts: dict[str, Any], when: datetime, rt: Runtime, label: str = "") -> None:
    committed = float(facts.get("committed_inr", 0.0))
    forecast = _forecast(facts)
    pts: list[dict[str, Any]] = facts.setdefault("budget_points", [])
    pts.append(
        {
            "sim_time": when.isoformat(),
            "committed_inr": round(committed, 2),
            "forecast_inr": round(forecast, 2),
            "budget_inr": rt.goal.budget_inr,
            "process_inr": round(float(facts.get("process_cost_inr", 0.0)), 2),
            "label": label,
        }
    )


def _forecast(facts: dict[str, Any]) -> float:
    """Best current forecast of committed cost (ex-GST incl. contingency and fees)."""
    if facts.get("po_committed_forecast"):
        return float(facts["po_committed_forecast"])
    opts = [VendorOption.model_validate(o) for o in facts.get("options") or []]
    if opts:
        rec = next((o for o in opts if o.recommended), opts[0])
        bud = _budgets(facts).get(rec.vendor_id)
        pct = (bud.contingency_inr / bud.quote_total_inr) if bud and bud.quote_total_inr else 0.05
        return (
            rec.total_inr
            - rec.expedite_fee_inr
            + (rec.total_inr - rec.expedite_fee_inr) * pct
            + rec.expedite_fee_inr
        )
    buds = [b for b in _budgets(facts).values() if b.committed_inr > 0]
    ok = [b for b in buds if b.verdict != "breach"] or buds
    return min((b.committed_inr for b in ok), default=0.0)


@dataclass
class Outcome:
    duration_days: float
    summary: str
    status: TaskStatus = TaskStatus.done
    note: str | None = None
    confidence: float | None = None
    outputs: dict[str, Any] = field(default_factory=dict)


Handler = Callable[[Ctx, Plan, PlanTask, str | None], Outcome]


# --------------------------------------------------------------------------- task handlers


def h_takeoff(ctx: Ctx, plan: Plan, task: PlanTask, vendor: str | None) -> Outcome:
    res = run_takeoff(ctx.rt.spec_pdf)
    ctx.facts["takeoff"] = res.model_dump(mode="json")
    for w in res.warnings:
        ctx.audit("takeoff", "takeoff.warning", w, confidence=res.confidence)
        ctx.event("takeoff", f"RFI raised: {w.split(';')[0][:90]}", "warning", ctx.at(hours=4))
    ctx.event(
        "takeoff",
        f"Takeoff: {len(res.lines)} line items from spec (confidence {res.confidence:.0%})",
        "success",
        ctx.at(hours=6),
    )
    return Outcome(
        DURATION_DAYS["takeoff"],
        f"Extracted {len(res.lines)} line items from {res.document} with "
        f"{len(res.warnings)} warning(s); schedule quantities govern.",
        confidence=res.confidence,
        outputs={
            "lines": [f"{ln.qty} {ln.unit} {ln.item_code}" for ln in res.lines],
            "warnings": res.warnings,
        },
    )


def h_rfq(ctx: Ctx, plan: Plan, task: PlanTask, vendor: str | None) -> Outcome:
    takeoff = TakeoffResult.model_validate(ctx.facts["takeoff"])
    net = LedgerNetwork(ctx.rt.network, ctx)
    vendors = ctx.rt.network.vendor_ids()
    qr = collect_quotes(
        cast(VendorNetwork, net),
        vendors,
        takeoff.lines,
        ctx.now,
        max_attempts=RFQ_MAX_ATTEMPTS,
        retry_interval=timedelta(days=RFQ_WINDOW_DAYS),
    )
    quotes = ctx.facts.setdefault("quotes", {})
    attempts: list[dict[str, Any]] = ctx.facts.setdefault("attempts", [])
    per_vendor: dict[str, int] = {}
    sent = 0
    for a in qr.attempts:
        attempts.append(a.model_dump(mode="json"))
        per_vendor[a.vendor_id] = max(per_vendor.get(a.vendor_id, 0), a.attempt)
        sent += 1
        name = ctx.rt.network.profile(a.vendor_id)["name"]
        ctx.event("quotes", f"RFQ → {a.vendor_id} {name} (attempt {a.attempt})", "info", a.at)
        if a.outcome == "timeout":
            ctx.audit(
                "quotes",
                "rfq.timeout",
                f"{a.vendor_id} did not answer RFQ attempt {a.attempt}: {a.detail}.",
                sim_time=a.at + timedelta(days=RFQ_WINDOW_DAYS),
                outputs=a.model_dump(mode="json"),
            )
            ctx.event(
                "quotes",
                f"{a.vendor_id} silent after {RFQ_WINDOW_DAYS:.0f} d (attempt {a.attempt}/"
                f"{RFQ_MAX_ATTEMPTS}) — retrying",
                "warning",
                a.at + timedelta(days=RFQ_WINDOW_DAYS),
            )
    for q in qr.quotes:
        quotes[q.vendor_id] = q.model_dump(mode="json")
        when = ctx.now + timedelta(
            days=RFQ_WINDOW_DAYS * max(0, per_vendor.get(q.vendor_id, 1) - 1),
            hours=ctx.rt.network.response_hours(q.vendor_id),
        )
        if q.status == "timeout":
            ctx.audit("quotes", "rfq.exhausted", q.notes, sim_time=when)
            ctx.event("quotes", f"{q.vendor_id} excluded: {q.notes}", "error", when)
        else:
            ctx.audit(
                "quotes",
                "quote.received",
                f"{q.vendor_name} quoted {inr(q.total_inr)} ex-GST, lead {q.lead_time_days} d, "
                f"valid to {q.valid_until} (attempt {per_vendor.get(q.vendor_id, 1)}).",
                sim_time=when,
                outputs={"quote_id": q.quote_id, "total_inr": q.total_inr},
            )
            ctx.event(
                "quotes",
                f"{q.vendor_id} quoted {inr(q.total_inr)}, {q.lead_time_days} d lead",
                "success",
                when,
            )
    ctx.facts["expedite_offers"] = {
        k: {"days": o.days_saved, "fee_inr": o.fee_inr, "description": o.description}
        for k, o in ctx.rt.network.expedite_offers().items()
    }
    ctx.cost += PROCESS_COST_INR["rfq"] * sent
    rounds = max(per_vendor.values(), default=1)
    got = sum(1 for q in qr.quotes if q.status != "timeout")
    retries = sum(1 for a in qr.attempts if a.outcome == "timeout")
    return Outcome(
        RFQ_WINDOW_DAYS * rounds,
        f"Sent {sent} RFQ messages to {len(vendors)} vendors; {got} quotes received, "
        f"{retries} timeout(s) retried.",
        outputs={"attempts": sent, "quotes": got},
    )


def h_levelling(ctx: Ctx, plan: Plan, task: PlanTask, vendor: str | None) -> Outcome:
    quotes = _quotes(ctx.facts)
    net = LedgerNetwork(ctx.rt.network, ctx)
    when = ctx.at(days=1)
    new, log = refresh_quotes(cast(VendorNetwork, net), [quotes[k] for k in sorted(quotes)], when)
    hist: list[dict[str, Any]] = ctx.facts.setdefault("quote_history", [])
    revised = []
    for old, q in zip([quotes[k] for k in sorted(quotes)], new, strict=True):
        if q.revision != old.revision:
            hist.append(old.model_dump(mode="json"))
            revised.append(q.vendor_id)
            pct = (q.total_inr / old.total_inr - 1) * 100 if old.total_inr else 0.0
            ctx.audit(
                "quotes",
                "quote.revised",
                f"{q.vendor_name} revised {old.quote_id} → {q.quote_id}: "
                f"{inr(old.total_inr)} → {inr(q.total_inr)} ({pct:+.1f} %). {q.notes}",
                sim_time=when,
                inputs={"old_total_inr": old.total_inr},
                outputs={"new_total_inr": q.total_inr, "revision": q.revision},
            )
            ctx.event(
                "quotes",
                f"{q.vendor_id} revised price {pct:+.1f} % → {inr(q.total_inr)} (copper surcharge)",
                "warning",
                when,
            )
        ctx.facts["quotes"][q.vendor_id] = q.model_dump(mode="json")
    for a in log:
        ctx.facts.setdefault("attempts", []).append(a.model_dump(mode="json"))
    ctx.event(
        "quotes",
        f"Bid levelling done: {len(new)} quotes confirmed, {len(revised)} revised",
        "info",
        ctx.at(days=DURATION_DAYS["levelling"]),
    )
    return Outcome(
        DURATION_DAYS["levelling"],
        f"Refreshed {len(new)} quotes before evaluation; revisions from "
        f"{', '.join(revised) or 'none'}.",
        outputs={"revised": revised},
    )


def h_schedule(ctx: Ctx, plan: Plan, task: PlanTask, vendor: str | None) -> Outcome:
    assert vendor
    q = _quotes(ctx.facts).get(vendor)
    if q is None or q.status in ("timeout", "declined"):
        ctx.event("schedule", f"{vendor}: no quote — schedule skipped", "warning")
        return Outcome(0.05, f"No priced quote from {vendor}; nothing to schedule.")
    po_date = projected_po_date(plan, ctx.now, exclude=task.id)
    s = schedule_for_quote(q, po_date, _required_on_site(ctx.rt))
    ctx.facts.setdefault("schedules", {})[vendor] = s.model_dump(mode="json")
    if not ctx.facts.get("selected_schedule"):
        ctx.facts["preview_schedule"] = s.model_dump(mode="json")
    late = not s.meets_deadline
    ctx.event(
        "schedule",
        f"{vendor}: delivery {_d(s.delivery_date)} ({s.float_days:+d} d float)"
        + (" — LATE" if late else ""),
        "warning" if late else "success",
        ctx.at(hours=6),
    )
    return Outcome(
        DURATION_DAYS["schedule"],
        f"CPM for {q.vendor_name}: PO {po_date} → delivery {s.delivery_date} vs required "
        f"{s.required_on_site} ({s.float_days:+d} d float); critical path "
        f"{' → '.join(s.critical_path)}.",
        outputs={"float_days": s.float_days, "meets_deadline": s.meets_deadline},
        confidence=0.9,
    )


def h_budget(ctx: Ctx, plan: Plan, task: PlanTask, vendor: str | None) -> Outcome:
    assert vendor
    q = _quotes(ctx.facts).get(vendor)
    if q is None:
        return Outcome(0.05, f"No quote from {vendor}.")
    b = check_budget(q, ctx.rt.goal.budget_inr)
    ctx.facts.setdefault("budgets", {})[vendor] = b.model_dump(mode="json")
    kind: Literal["success", "warning", "error"] = (
        "success" if b.verdict == "ok" else "warning" if b.verdict == "warn" else "error"
    )
    ctx.event(
        "budget",
        f"{vendor}: {inr(b.committed_inr)} committed = {b.utilisation:.0%} of budget ({b.verdict})",
        kind,
        ctx.at(hours=6),
    )
    _add_budget_point(ctx.facts, ctx.at(hours=6), ctx.rt, f"budget {vendor}")
    return Outcome(
        DURATION_DAYS["budget"],
        " ".join(b.reasons),
        outputs={"verdict": b.verdict, "utilisation": b.utilisation},
    )


def h_negotiate(ctx: Ctx, plan: Plan, task: PlanTask, vendor: str | None) -> Outcome:
    assert vendor
    q = _quotes(ctx.facts)[vendor]
    net = LedgerNetwork(ctx.rt.network, ctx)
    ctx.event("quotes", f"Negotiation call with {vendor}: ask to absorb surcharge", "info")
    q2 = net._refresh("negotiate", vendor, q, ctx.at(days=2))
    ctx.facts["quotes"][vendor] = q2.model_dump(mode="json")
    b = check_budget(q2, ctx.rt.goal.budget_inr)
    ctx.facts.setdefault("budgets", {})[vendor] = b.model_dump(mode="json")
    held = q2.total_inr >= q.total_inr
    msg = (
        f"{q.vendor_name} holds {q.quote_id} at {inr(q2.total_inr)} (copper surcharge is LME "
        f"pass-through); still {b.verdict} at {b.utilisation:.0%} of budget."
        if held
        else f"{q.vendor_name} cut price to {inr(q2.total_inr)} ({b.verdict})."
    )
    ctx.event(
        "quotes",
        f"{vendor} negotiation: " + ("price held" if held else "price reduced") + f" ({b.verdict})",
        "warning" if b.verdict == "breach" else "success",
        ctx.at(days=DURATION_DAYS["negotiate"]),
    )
    _add_budget_point(ctx.facts, ctx.at(days=DURATION_DAYS["negotiate"]), ctx.rt, "negotiation")
    return Outcome(DURATION_DAYS["negotiate"], msg, outputs={"verdict": b.verdict, "held": held})


def h_expedite(ctx: Ctx, plan: Plan, task: PlanTask, vendor: str | None) -> Outcome:
    assert vendor
    q = _quotes(ctx.facts)[vendor]
    offer = _offers(ctx.facts).get(vendor)
    if offer is None:
        return Outcome(0.25, f"{vendor} has no expedite offer.")

    def confirm() -> dict[str, Any]:
        ctx.rt.store.outbox_send(
            ctx.rt.run_id,
            channel="expedite",
            vendor_id=vendor,
            ref=f"EXP-{q.quote_id}",
            idempotency_key=f"{ctx.task_id}:expedite:{vendor}",
            payload={"days_saved": offer.days_saved, "fee_inr": offer.fee_inr},
            sim_time=ctx.now,
        )
        return {"confirmed": True, "days_saved": offer.days_saved, "fee_inr": offer.fee_inr}

    ctx.once("expedite", vendor, "expedite.confirm", {"vendor_id": vendor}, confirm)
    po_date = projected_po_date(plan, ctx.now, exclude=task.id)
    lead = max(1, q.lead_time_days - offer.days_saved)
    s = schedule_for_lead_time(vendor, lead, po_date, _required_on_site(ctx.rt))
    pct = 0.05
    b = check_budget(q, ctx.rt.goal.budget_inr, contingency_pct=pct, expedite_fee_inr=offer.fee_inr)
    ctx.facts.setdefault("expedite_evals", {})[vendor] = {
        "schedule": s.model_dump(mode="json"),
        "budget": b.model_dump(mode="json"),
        "offer": offer.model_dump(mode="json"),
    }
    ok = s.meets_deadline and b.verdict != "breach"
    ctx.event(
        "schedule",
        f"{vendor} expedited (−{offer.days_saved} d, {inr(offer.fee_inr)}): delivery "
        f"{_d(s.delivery_date)} ({s.float_days:+d} d), {b.utilisation:.0%} of budget",
        "success" if ok else "warning",
        ctx.at(days=DURATION_DAYS["expedite"]),
    )
    return Outcome(
        DURATION_DAYS["expedite"],
        f"{q.vendor_name} expedite: lead {q.lead_time_days} → {lead} d for {inr(offer.fee_inr)}; "
        f"delivery {s.delivery_date} ({s.float_days:+d} d float), committed "
        f"{inr(b.committed_inr)} ({b.verdict}).",
        outputs={"feasible": ok, "float_days": s.float_days, "verdict": b.verdict},
        confidence=0.8,
    )


def h_chase(ctx: Ctx, plan: Plan, task: PlanTask, vendor: str | None) -> Outcome:
    assert vendor
    takeoff = TakeoffResult.model_validate(ctx.facts["takeoff"])
    net = LedgerNetwork(ctx.rt.network, ctx)
    try:
        q = net.request_quote(vendor, takeoff.lines, RFQ_MAX_ATTEMPTS + 1, ctx.now)
    except VendorTimeout:
        ctx.event("quotes", f"{vendor} still silent after final chase — excluded", "error")
        return Outcome(DURATION_DAYS["chase"], f"{vendor} unresponsive; excluded from award.")
    ctx.facts["quotes"][vendor] = q.model_dump(mode="json")
    b = check_budget(q, ctx.rt.goal.budget_inr)
    ctx.facts.setdefault("budgets", {})[vendor] = b.model_dump(mode="json")
    s = schedule_for_quote(
        q, projected_po_date(plan, ctx.now, exclude=task.id), _required_on_site(ctx.rt)
    )
    ctx.facts.setdefault("schedules", {})[vendor] = s.model_dump(mode="json")
    ctx.event("quotes", f"{vendor} answered final chase: {inr(q.total_inr)}", "success")
    return Outcome(DURATION_DAYS["chase"], f"{vendor} quoted {inr(q.total_inr)} after chase.")


def h_rank(ctx: Ctx, plan: Plan, task: PlanTask, vendor: str | None) -> Outcome:
    rt = ctx.rt
    po_date = projected_po_date(plan, ctx.now, exclude=task.id)
    ros = _required_on_site(rt)
    quotes = _priced(ctx.facts)
    if not quotes:
        raise RuntimeError("no priced quotes to rank")
    scheds = [schedule_for_quote(q, po_date, ros) for q in quotes]
    buds_by = _budgets(ctx.facts)
    buds = [buds_by.get(q.vendor_id) or check_budget(q, rt.goal.budget_inr) for q in quotes]
    opts = rank_options(quotes, scheds, buds, _offers(ctx.facts))
    rejected = set(ctx.facts.get("rejected_options") or [])
    opts = [o for o in opts if o.option_id not in rejected]
    if not opts:
        raise RuntimeError("every option was rejected")
    for o in opts:
        o.recommended = False
    rec = next((o for o in opts if is_feasible(o)), None)
    if rec is not None:
        rec.recommended = True
    triggers = [t for t in ctx.facts.get("handled_triggers", [])]
    situation = (
        f"Order-by {rt.goal.need_by}, required on site {ros}, budget {inr(rt.goal.budget_inr)}. "
        f"Projected PO issue {po_date}. {len(quotes)} priced quotes"
        + (f"; events: {', '.join(triggers)}" if triggers else "")
        + (f"; rejected earlier: {', '.join(sorted(rejected))}" if rejected else "")
        + "."
    )
    memo = build_decision_memo(rt.goal, opts, situation)
    top = memo.recommendation
    opt_lines = "; ".join(
        f"{o.option_id} {o.vendor_name} {inr(o.total_inr)} float {o.float_days:+d}d "
        f"{o.budget_verdict}{' REC' if o.option_id == top else ''}"
        for o in opts[:4]
    )
    res = rt.llm.complete_text(
        f"Options: {opt_lines}. Recommended: {top}. Write 2 sentences for the project "
        "manager explaining the recommendation. Use only the numbers given.",
        f"{task.id}:llm:memo",
        fallback="",
        sim_time=ctx.now,
    )
    meta = ctx.llm_meta(res)
    if res.value.strip():
        memo.reasoning = f"{res.value.strip()}\n\n{memo.reasoning}"
    ctx.facts["options"] = [o.model_dump(mode="json") for o in opts]
    ctx.facts["memo"] = memo.model_dump(mode="json")
    rec_opt = next(o for o in opts if o.option_id == top)
    lead = rec_opt.lead_time_days
    ctx.facts["preview_schedule"] = schedule_for_lead_time(
        rec_opt.vendor_id, lead, po_date, ros
    ).model_dump(mode="json")
    _add_budget_point(ctx.facts, ctx.at(days=DURATION_DAYS["rank"]), rt, "decision memo")
    ctx.event(
        "approvals",
        f"Decision memo: recommend {top} ({rec_opt.vendor_name}"
        + (", expedited" if rec_opt.expedite_fee_inr else "")
        + f"), {sum(1 for o in opts if is_feasible(o))}/{len(opts)} options feasible",
        "success" if rec else "warning",
        ctx.at(days=DURATION_DAYS["rank"]),
    )
    return Outcome(
        DURATION_DAYS["rank"],
        f"Ranked {len(opts)} options; recommend {top}. {memo.reasoning[:400]}",
        outputs={
            "recommendation": top,
            "options": [f"{o.option_id}:{o.score}" for o in opts],
            "llm": meta,
        },
        confidence=rec_opt.score if rec else 0.3,
    )


def h_escalate(ctx: Ctx, plan: Plan, task: PlanTask, vendor: str | None) -> Outcome:
    memo = DecisionMemo.model_validate(ctx.facts["memo"])
    rec = next(o for o in memo.options if o.option_id == memo.recommendation)
    reasons = []
    if rec.expedite_fee_inr:
        reasons.append(f"expedite fee {inr(rec.expedite_fee_inr)} needs sign-off")
    if rec.budget_verdict != "ok":
        reasons.append(f"budget {rec.budget_verdict}")
    if not is_feasible(rec):
        reasons.append("no option meets both budget and on-site date")
    breaches = [o.option_id for o in memo.options if o.budget_verdict == "breach"]
    if breaches:
        reasons.append(f"{', '.join(breaches)} over budget after price revision")
    reason = "; ".join(reasons) or "trade-off changed after re-plan"

    def notify() -> dict[str, Any]:
        mid = ctx.rt.store.outbox_send(
            ctx.rt.run_id,
            channel="email",
            vendor_id="PM",
            ref=f"ESC-{memo.memo_id}",
            idempotency_key=f"{ctx.task_id}:notify",
            payload={"to": "project.manager@alpha", "memo": memo.memo_id, "reason": reason},
            sim_time=ctx.now,
        )
        return {"message_id": mid}

    ctx.once("notify", "pm", "notify.pm", {"memo": memo.memo_id}, notify)
    ctx.audit(
        "planner",
        "escalation",
        f"Escalated to project manager: {reason}. Recommendation {rec.option_id} "
        f"({rec.vendor_name}) with memo {memo.memo_id}.",
        outputs={"memo_id": memo.memo_id, "recommendation": rec.option_id},
    )
    ctx.event("human", f"Escalated to PM: {reason}", "human")
    return Outcome(DURATION_DAYS["escalate"], f"Escalation sent ({reason}).")


def _approval(
    ctx: Ctx, plan: Plan, task: PlanTask, kind: Literal["vendor_selection", "po_release"]
) -> tuple[ApprovalRequest, dict[str, Any]]:
    rt = ctx.rt
    appr_id = f"{rt.run_id}:{task.id}"
    memo = DecisionMemo.model_validate(ctx.facts["memo"]) if ctx.facts.get("memo") else None
    po = PurchaseOrder.model_validate(ctx.facts["po"]) if ctx.facts.get("po") else None
    if kind == "vendor_selection":
        assert memo is not None
        rec = next(o for o in memo.options if o.option_id == memo.recommendation)
        title = f"Select vendor for {rt.goal.package}"
        summary = (
            f"Recommend {rec.option_id} {rec.vendor_name}: {inr(rec.total_inr)} ex-GST, "
            f"delivery {rec.delivery_date} ({rec.float_days:+d} d float), budget "
            f"{rec.budget_verdict}."
        )
        options = [o.option_id for o in memo.options]
    else:
        assert po is not None
        title = f"Release PO {po.po_number}"
        summary = (
            f"{po.vendor_name}: {inr(po.total_inr)} incl. GST ({inr(po.subtotal_inr)} ex-GST "
            f"+ freight/fees), delivery {po.delivery_date}, {po.payment_terms[:80]}."
        )
        options = []
        memo = None

    def create() -> dict[str, Any]:
        req = ApprovalRequest(
            id=appr_id,
            run_id=rt.run_id,
            kind=kind,
            title=title,
            summary=summary,
            memo=memo,
            po=po if kind == "po_release" else None,
            options=options,
            requested_at=ctx.now,
        )
        if rt.store.get_approval(appr_id) is None:
            rt.store.upsert_approval(req)
        return {"approval_id": appr_id}

    ctx.once("approval", "requested", "approval.requested", {"kind": kind}, create)
    ctx.audit(
        "approvals",
        "approval.requested",
        f"Human approval requested ({kind}): {summary}",
        outputs={"approval_id": appr_id, "options": options},
    )
    ctx.event("human", f"Awaiting human: {title}", "human")
    req = rt.store.get_approval(appr_id)
    assert req is not None
    if req.status == ApprovalStatus.pending:
        rt.store.update_run(rt.run_id, status="waiting_human", current_node=f"approval:{task.id}")
        waiting = plan.model_copy(deep=True)
        get_task(waiting, task.id).status = TaskStatus.waiting_human
        get_task(waiting, task.id).started_at = ctx.now
        _save_projection(rt, waiting, None, ctx.facts, ctx.now)
    decision = interrupt({"approval_id": appr_id, "kind": kind, "title": title})
    rt.store.update_run(rt.run_id, status="running", current_node=f"execute:{task.id}")
    if not isinstance(decision, dict):
        decision = {"decision": str(decision)}
    return req, decision


def _record_decision(
    ctx: Ctx, req: ApprovalRequest, decision: dict[str, Any], wait_days: float
) -> ApprovalRequest:
    approved = decision.get("decision") == "approve"
    current = ctx.rt.store.get_approval(req.id) or req
    upd = current.model_copy(
        update={
            "status": ApprovalStatus.approved if approved else ApprovalStatus.rejected,
            "decided_option": decision.get("option_id") or current.decided_option,
            "decided_by": decision.get("decided_by") or current.decided_by or "human",
            "comment": decision.get("comment") or current.comment,
            "decided_at": ctx.at(days=wait_days),
        }
    )
    ctx.rt.store.upsert_approval(upd)
    return upd


def h_approve_vendor(ctx: Ctx, plan: Plan, task: PlanTask, vendor: str | None) -> Outcome:
    req, decision = _approval(ctx, plan, task, "vendor_selection")
    memo = DecisionMemo.model_validate(ctx.facts["memo"])
    wait = DURATION_DAYS["approve-vendor"]
    choice = decision.get("option_id") or memo.recommendation
    if choice not in {o.option_id for o in memo.options}:
        choice = memo.recommendation
    decision = {**decision, "option_id": choice}
    upd = _record_decision(ctx, req, decision, wait)
    who = upd.decided_by or "human"
    when = ctx.at(days=wait)
    ctx.facts.setdefault("approvals", {})[task.id] = decision
    if decision.get("decision") != "approve":
        ctx.facts.setdefault("rejected_options", []).append(choice)
        ctx.audit(
            "human",
            "approval.rejected",
            f"{who} rejected vendor selection {choice}: {decision.get('comment') or '-'}",
            sim_time=when,
            inputs=decision,
        )
        ctx.event("human", f"Rejected {choice} — agent will re-plan", "error", when)
        return Outcome(
            wait,
            f"Vendor selection {choice} rejected.",
            status=TaskStatus.failed,
            note="rejected by human",
        )
    ctx.facts["selected_option"] = choice
    opt = next(o for o in memo.options if o.option_id == choice)
    ctx.audit(
        "human",
        "approval.approved",
        f"{who} approved {choice} ({opt.vendor_name}, {inr(opt.total_inr)})"
        + (f": {decision['comment']}" if decision.get("comment") else "."),
        sim_time=when,
        inputs=decision,
        cost_inr=0.0,
    )
    ctx.event("human", f"Approved {choice} {opt.vendor_name}", "human", when)
    return Outcome(wait, f"Vendor selection approved: {choice}.", outputs={"option": choice})


def h_draft_po(ctx: Ctx, plan: Plan, task: PlanTask, vendor: str | None) -> Outcome:
    from .specialists.po import draft_po

    memo = DecisionMemo.model_validate(ctx.facts["memo"])
    choice = ctx.facts["selected_option"]
    opt = next(o for o in memo.options if o.option_id == choice)
    q = _quotes(ctx.facts)[opt.vendor_id]
    takeoff = TakeoffResult.model_validate(ctx.facts["takeoff"])
    issued = ctx.at(days=DURATION_DAYS["draft-po"])
    seq = 1 + sum(
        1 for t in plan.tasks if task_action(t)[0] == "draft-po" and t.status == TaskStatus.done
    )
    po_number = f"PO-ALPHA-{issued:%Y%m%d}-{opt.vendor_id}-{seq:02d}"
    po = draft_po(rt_goal(ctx), opt, q, takeoff, po_number, issued.date())
    ctx.facts["po"] = po.model_dump(mode="json")
    ctx.event(
        "po",
        f"PO {po_number} drafted: {opt.vendor_name}, {inr(po.total_inr)} incl. GST",
        "info",
        issued,
    )
    return Outcome(
        DURATION_DAYS["draft-po"],
        f"Drafted {po_number} for {opt.vendor_name}: subtotal {inr(po.subtotal_inr)}, freight "
        f"{inr(po.freight_inr)}, expedite {inr(po.expedite_fee_inr)}, GST {inr(po.gst_inr)}, "
        f"total {inr(po.total_inr)}.",
        outputs={"po_number": po_number, "total_inr": po.total_inr},
    )


def rt_goal(ctx: Ctx) -> Goal:
    return ctx.rt.goal


def _rerender_po(ctx: Ctx, po: PurchaseOrder) -> PurchaseOrder:
    """Refresh the rendered PO package after a status change (draft -> approved -> sent)."""
    from .specialists._data import vendor_profile
    from .specialists.po import render_po_markdown

    q = _quotes(ctx.facts).get(po.vendor_id)
    if q is not None:
        # rendering is cosmetic; never fail the task on it
        with contextlib.suppress(Exception):
            po.markdown = render_po_markdown(po, ctx.rt.goal, q, vendor_profile(po.vendor_id))
    return po


def h_approve_po(ctx: Ctx, plan: Plan, task: PlanTask, vendor: str | None) -> Outcome:
    req, decision = _approval(ctx, plan, task, "po_release")
    wait = DURATION_DAYS["approve-po"]
    upd = _record_decision(ctx, req, decision, wait)
    when = ctx.at(days=wait)
    ctx.facts.setdefault("approvals", {})[task.id] = decision
    po = PurchaseOrder.model_validate(ctx.facts["po"])
    if decision.get("decision") != "approve":
        ctx.audit(
            "human",
            "approval.rejected",
            f"{upd.decided_by} rejected PO release {po.po_number}: "
            f"{decision.get('comment') or '-'}",
            sim_time=when,
            inputs=decision,
        )
        ctx.event("human", f"PO {po.po_number} release rejected", "error", when)
        return Outcome(
            wait, "PO release rejected.", status=TaskStatus.failed, note="rejected by human"
        )
    po.status = "approved"
    ctx.facts["po"] = _rerender_po(ctx, po).model_dump(mode="json")
    ctx.audit(
        "human",
        "approval.approved",
        f"{upd.decided_by} approved release of {po.po_number} ({inr(po.total_inr)}).",
        sim_time=when,
        inputs=decision,
    )
    ctx.event("human", f"PO {po.po_number} release approved", "human", when)
    return Outcome(wait, f"PO {po.po_number} release approved.")


def h_send_po(ctx: Ctx, plan: Plan, task: PlanTask, vendor: str | None) -> Outcome:
    rt = ctx.rt
    po = PurchaseOrder.model_validate(ctx.facts["po"])

    def send() -> dict[str, Any]:
        mid = rt.store.outbox_send(
            rt.run_id,
            channel="po",
            vendor_id=po.vendor_id,
            ref=po.po_number,
            idempotency_key=f"{ctx.task_id}:po:{po.po_number}",
            payload={"po_number": po.po_number, "total_inr": po.total_inr},
            sim_time=ctx.now,
        )
        return {"message_id": mid, "po_number": po.po_number, "sent_at": ctx.now.isoformat()}

    res = ctx.once("po", po.po_number, "po.sent", {"po_number": po.po_number}, send)
    po.status = "sent"
    po.issued_at = datetime.fromisoformat(res["sent_at"])
    ctx.facts["po"] = _rerender_po(ctx, po).model_dump(mode="json")
    memo = DecisionMemo.model_validate(ctx.facts["memo"])
    opt = next(o for o in memo.options if o.option_id == ctx.facts["selected_option"])
    s = schedule_for_lead_time(
        opt.vendor_id, opt.lead_time_days, ctx.now.date(), _required_on_site(rt)
    )
    ctx.facts["selected_schedule"] = s.model_dump(mode="json")
    ex_gst = po.subtotal_inr + po.freight_inr + po.expedite_fee_inr
    ctx.facts["committed_inr"] = ex_gst
    bud = _budgets(ctx.facts).get(opt.vendor_id)
    pct = (bud.contingency_inr / bud.quote_total_inr) if bud and bud.quote_total_inr else 0.05
    ctx.facts["po_committed_forecast"] = ex_gst + (ex_gst - po.expedite_fee_inr) * pct
    _add_budget_point(ctx.facts, ctx.now, rt, f"PO {po.po_number} sent")
    ctx.event(
        "po",
        f"PO {po.po_number} sent to {po.vendor_name} ({inr(ex_gst)} ex-GST)",
        "success",
    )
    ctx.event(
        "po",
        f"{po.vendor_id} acknowledged PO; delivery {_d(s.delivery_date)} ({s.float_days:+d} d "
        "float)",
        "success",
        ctx.at(hours=8),
    )
    return Outcome(
        DURATION_DAYS["send-po"],
        f"Transmitted {po.po_number} to {po.vendor_name} (message {res['message_id']}); "
        f"committed {inr(ex_gst)} ex-GST; delivery {s.delivery_date} with {s.float_days:+d} d "
        "float.",
        outputs={"po_number": po.po_number, "message_id": res["message_id"]},
    )


HANDLERS: dict[str, Handler] = {
    "takeoff": h_takeoff,
    "rfq": h_rfq,
    "levelling": h_levelling,
    "schedule": h_schedule,
    "budget": h_budget,
    "negotiate": h_negotiate,
    "expedite": h_expedite,
    "chase": h_chase,
    "rank": h_rank,
    "escalate": h_escalate,
    "approve-vendor": h_approve_vendor,
    "draft-po": h_draft_po,
    "approve-po": h_approve_po,
    "send-po": h_send_po,
}


# --------------------------------------------------------------------------- projection


def _save_projection(
    rt: Runtime,
    plan: Plan | None,
    history: list[dict[str, Any]] | None,
    facts: dict[str, Any],
    now: datetime,
) -> None:
    cur = rt.store.load_projection(rt.run_id)
    quotes = [v for _, v in sorted((facts.get("quotes") or {}).items())]
    schedule = (
        facts.get("selected_schedule")
        or facts.get("preview_schedule")
        or next(iter((facts.get("schedules") or {}).values()), None)
    )
    proj = {
        "plan": plan.model_dump(mode="json") if plan else cur.get("plan"),
        "plan_history": history if history is not None else cur.get("plan_history", []),
        "takeoff": facts.get("takeoff"),
        "quotes": quotes,
        "quote_history": facts.get("quote_history", []),
        "vendor_attempts": facts.get("attempts", []),
        "options": facts.get("options", []),
        "schedule": schedule,
        "schedules": facts.get("schedules", {}),
        "budgets": facts.get("budgets", {}),
        "expedite_evals": facts.get("expedite_evals", {}),
        "memo": facts.get("memo"),
        "po": facts.get("po"),
        "budget_points": facts.get("budget_points", []),
        "committed_inr": facts.get("committed_inr", 0.0),
        "forecast_inr": _forecast(facts),
        "process_cost_inr": facts.get("process_cost_inr", 0.0),
        "sim_now": now.isoformat(),
    }
    rt.store.save_projection(rt.run_id, proj)
    rt.clock.set(now)


# --------------------------------------------------------------------------- nodes


def _load(state: RunState) -> tuple[Plan | None, dict[str, Any], datetime]:
    plan = Plan.model_validate(state["plan"]) if state.get("plan") else None
    # deep copy so in-node mutation never touches the checkpointed object
    facts: dict[str, Any] = _deepcopy(dict(state.get("facts") or {}))
    return plan, facts, datetime.fromisoformat(state["sim_now"])


def _deepcopy(obj: Any) -> Any:
    import copy

    return copy.deepcopy(obj)


def build_graph(rt: Runtime, checkpointer: Any) -> Any:
    def plan_node(state: RunState) -> dict[str, Any]:
        _, facts, now = _load(state)
        rt.store.update_run(rt.run_id, current_node="plan", status="running")
        ctx = Ctx(rt, "plan-v1", now, 1, facts=facts)
        ctx.event("planner", f"Goal received: {rt.goal.text}", "info")
        from .specialists.registry import REGISTRY

        plan = make_plan(rt.goal, REGISTRY, now, rt.llm, vendor_ids=rt.network.vendor_ids())
        llm_res = rt.store.get_ledger(f"{rt.run_id}:plan-v1:llm:rationale")
        llm_meta = (
            {k: llm_res.result.get(k) for k in ("provider", "model", "tokens", "latency_ms")}
            if llm_res
            else {"provider": rt.llm.provider}
        )
        ctx.audit(
            "planner",
            "plan.created",
            plan.rationale,
            inputs={"goal": rt.goal.model_dump(mode="json")},
            outputs={
                "tasks": [f"{t.id} (due {t.deadline})" for t in plan.tasks],
                "risks": [r.title for r in plan.risks],
                "llm": llm_meta,
            },
            llm_tokens=int(llm_meta.get("tokens") or 0),
            confidence=0.85,
        )
        ctx.event(
            "planner",
            f"Plan v1: {len(plan.tasks)} tasks, {len(plan.risks)} risks, PO by {rt.goal.need_by}",
            "success",
        )
        now2 = now + timedelta(hours=2)
        history = [plan.model_dump(mode="json")]
        _add_budget_point(facts, now, rt, "plan v1")
        _save_projection(rt, plan, history, facts, now2)
        return {
            "plan": plan.model_dump(mode="json"),
            "plan_history": history,
            "facts": facts,
            "sim_now": now2.isoformat(),
        }

    def execute_node(state: RunState) -> dict[str, Any]:
        plan, facts, now = _load(state)
        assert plan is not None
        ready = ready_tasks(plan)
        if not ready:
            return {}
        task = ready[0]
        action, vendor = task_action(task)
        rt.store.update_run(rt.run_id, current_node=f"execute:{task.id}")
        if rt.on_step:
            rt.on_step(task.id)
        ctx = Ctx(rt, task.id, now, plan.version, task_id=task.id, facts=facts)
        if action not in HUMAN_ACTIONS:
            running = plan.model_copy(deep=True)
            get_task(running, task.id).status = TaskStatus.running
            get_task(running, task.id).started_at = now
            _save_projection(rt, running, None, facts, now)
        out = HANDLERS[action](ctx, plan, task, vendor)
        # Demo pacing happens AFTER the task's side effects (perform_once) and BEFORE the node
        # returns / is checkpointed: a SIGKILL in this window re-runs the node on resume and
        # every ledgered effect returns its stored result (executions += 1, executed once).
        if rt.step_delay > 0 and action not in HUMAN_ACTIONS:
            rt.store.update_run(rt.run_id, current_node=f"execute:{task.id}:pacing")
            time.sleep(rt.step_delay)
        cost = ctx.cost + (PROCESS_COST_INR.get(action, 0.0) if action != "rfq" else 0.0)
        facts["process_cost_inr"] = float(facts.get("process_cost_inr", 0.0)) + cost
        end = now + timedelta(days=out.duration_days)
        t = get_task(plan, task.id)
        t.status = out.status
        t.attempts += 1
        t.started_at = now
        t.finished_at = end
        if out.note:
            t.note = out.note
        actor = task.specialist if action not in HUMAN_ACTIONS else "approvals"
        ctx.audit(
            actor,
            f"task.{'done' if out.status == TaskStatus.done else out.status.value}",
            out.summary,
            sim_time=end,
            inputs={"task": task.id, "title": task.title},
            outputs=out.outputs,
            cost_inr=cost,
            llm_tokens=ctx.tokens,
            confidence=out.confidence,
        )
        if t.deadline and end.date() > t.deadline:
            ctx.audit(
                "planner",
                "deadline.missed",
                f"{task.id} finished {end.date()} after its deadline {t.deadline}.",
                sim_time=end,
            )
            ctx.event("planner", f"{task.id} late vs deadline {t.deadline}", "warning", end)
        history = list(state.get("plan_history") or [])
        if history:
            history[-1] = plan.model_dump(mode="json")
        _save_projection(rt, plan, history, facts, end)
        return {
            "plan": plan.model_dump(mode="json"),
            "plan_history": history,
            "facts": facts,
            "sim_now": end.isoformat(),
            "last_task": task.id,
        }

    def monitor_node(state: RunState) -> dict[str, Any]:
        plan, facts, now = _load(state)
        assert plan is not None
        handled = set(state.get("handled") or [])
        found = detect_triggers(plan, facts, rt)
        new = [t for t, _ in found if t not in handled]
        if not new:
            return {"triggers": []}
        details = facts.setdefault("trigger_details", {})
        ctx = Ctx(
            rt, f"monitor-v{plan.version}:{state.get('last_task')}", now, plan.version, facts=facts
        )
        for trig, detail in found:
            if trig in new:
                details[trig] = detail
                ctx.audit(
                    "monitor", "trigger.detected", f"{trig}: {detail}", outputs={"trigger": trig}
                )
                ctx.event("planner", f"Monitor: {detail}", "warning")
        return {"triggers": new, "facts": facts}

    def replan_node(state: RunState) -> dict[str, Any]:
        plan, facts, now = _load(state)
        assert plan is not None
        triggers = list(state.get("triggers") or [])
        rt.store.update_run(rt.run_id, current_node="replan")
        v = plan.version + 1
        ctx = Ctx(rt, f"plan-v{v}", now, v, facts=facts)
        new = replan(plan, triggers, facts, now, rt.llm, goal=rt.goal)
        before = {t.id: t.status for t in plan.tasks}
        added = [t.id for t in new.tasks if t.id not in before]
        skipped = [
            t.id
            for t in new.tasks
            if t.status == TaskStatus.skipped and before.get(t.id) != TaskStatus.skipped
        ]
        llm_res = rt.store.get_ledger(f"{rt.run_id}:plan-v{v}:llm:replan")
        llm_meta = (
            {k: llm_res.result.get(k) for k in ("provider", "model", "tokens", "latency_ms")}
            if llm_res
            else {"provider": rt.llm.provider}
        )
        ctx.audit(
            "planner",
            "replan",
            new.rationale,
            inputs={"triggers": triggers, "from_version": plan.version},
            outputs={"version": v, "added": added, "skipped": skipped, "llm": llm_meta},
            llm_tokens=int(llm_meta.get("tokens") or 0),
            confidence=0.75,
        )
        ctx.event(
            "planner",
            f"Re-plan v{v}: +{len(added)} tasks ({', '.join(a.split('-', 1)[1] for a in added)}), "
            f"{len(skipped)} superseded",
            "warning",
        )
        facts["handled_triggers"] = list(facts.get("handled_triggers", [])) + triggers
        history = [*(state.get("plan_history") or []), new.model_dump(mode="json")]
        end = now + timedelta(hours=REPLAN_HOURS)
        _save_projection(rt, new, history, facts, end)
        return {
            "plan": new.model_dump(mode="json"),
            "plan_history": history,
            "facts": facts,
            "triggers": [],
            "handled": list(state.get("handled") or []) + triggers,
            "sim_now": end.isoformat(),
        }

    def finish_node(state: RunState) -> dict[str, Any]:
        plan, facts, now = _load(state)
        assert plan is not None
        ctx = Ctx(rt, "finish", now, plan.version, facts=facts)
        po = facts.get("po") or {}
        ok = is_complete(plan) and po.get("status") == "sent"
        run = rt.store.get_run(rt.run_id)
        start = run.sim_start if run else now
        days = (now - start).total_seconds() / 86400
        if ok:
            summary = (
                f"Goal met: PO {po.get('po_number')} sent to {po.get('vendor_name')} on "
                f"{now.date()} (order-by {rt.goal.need_by}); {days:.0f} sim days, plan "
                f"v{plan.version}."
            )
            ctx.audit("system", "run.completed", summary, outputs={"po": po.get("po_number")})
            ctx.event("system", f"Goal met — PO sent {_d(now)}, {days:.0f} sim days", "success")
            rt.store.update_run(rt.run_id, status="completed", current_node="finish")
        else:
            stuck = [
                t.id for t in plan.tasks if t.status not in (TaskStatus.done, TaskStatus.skipped)
            ]
            summary = f"Run stopped without completing: {', '.join(stuck)}"
            ctx.audit("system", "run.failed", summary)
            ctx.event("system", summary, "error")
            rt.store.update_run(rt.run_id, status="failed", error=summary, current_node="finish")
        _save_projection(rt, plan, list(state.get("plan_history") or []), facts, now)
        return {}

    def route_start(state: RunState) -> str:
        return "execute" if state.get("plan") else "plan"

    def route_monitor(state: RunState) -> str:
        if state.get("triggers"):
            return "replan"
        plan = Plan.model_validate(state["plan"])
        if is_complete(plan):
            return "finish"
        return "execute" if ready_tasks(plan) else "finish"

    g: StateGraph[RunState] = StateGraph(RunState)
    g.add_node("plan", plan_node)
    g.add_node("execute", execute_node)
    g.add_node("monitor", monitor_node)
    g.add_node("replan", replan_node)
    g.add_node("finish", finish_node)
    g.add_conditional_edges(START, route_start, {"plan": "plan", "execute": "execute"})
    g.add_edge("plan", "execute")
    g.add_edge("execute", "monitor")
    g.add_conditional_edges(
        "monitor", route_monitor, {"replan": "replan", "execute": "execute", "finish": "finish"}
    )
    g.add_edge("replan", "execute")
    g.add_edge("finish", END)
    return g.compile(checkpointer=checkpointer)


# --------------------------------------------------------------------------- trigger detection


def detect_triggers(plan: Plan, facts: dict[str, Any], rt: Runtime) -> list[tuple[str, str]]:
    """Fact changes that require re-planning, as ``(trigger, human detail)`` pairs."""
    found: list[tuple[str, str]] = []
    for t in plan.tasks:
        if task_action(t)[0] in HUMAN_ACTIONS and t.status == TaskStatus.failed:
            found.append((f"approval_rejected:{t.id}", f"{t.title} was rejected by the human"))
    live_rank = [
        t for t in plan.tasks if task_action(t)[0] == "rank" and t.status == TaskStatus.pending
    ]
    evals_pending = any(
        task_action(t)[0] in ("schedule", "budget", "negotiate", "expedite", "chase")
        and t.status in (TaskStatus.pending, TaskStatus.ready, TaskStatus.running)
        for t in plan.tasks
    )
    if not live_rank or evals_pending:
        return found
    quotes = _quotes(facts)
    buds = _budgets(facts)
    scheds = _schedules(facts)
    offers = _offers(facts)
    for v, q in sorted(quotes.items()):
        if q.status == "timeout":
            found.append((f"vendor_unresponsive:{v}", f"{v} never answered the RFQ"))
        b = buds.get(v)
        if q.status == "revised" and b is not None and b.verdict == "breach":
            found.append(
                (
                    f"budget_breach:{v}",
                    f"{v} revision {q.revision} lifts committed cost to {inr(b.committed_inr)} "
                    f"({b.utilisation:.0%} of budget) — breach",
                )
            )
    robust = [
        v
        for v in quotes
        if v in buds
        and v in scheds
        and buds[v].verdict != "breach"
        and scheds[v].float_days >= ROBUST_FLOAT_DAYS
    ]
    if not robust:
        for v, s in sorted(scheds.items()):
            b = buds.get(v)
            if not s.meets_deadline and v in offers and b is not None and b.verdict != "breach":
                found.append(
                    (
                        f"deadline_break:{v}",
                        f"{v} delivers {s.delivery_date} ({s.float_days:+d} d vs required on "
                        f"site) and no option has ≥{ROBUST_FLOAT_DAYS} d float; expedite offer "
                        f"−{offers[v].days_saved} d available",
                    )
                )
    return found


# --------------------------------------------------------------------------- checkpointer


def open_checkpointer(settings: Settings) -> tuple[SqliteSaver, sqlite3.Connection]:
    conn = sqlite3.connect(settings.checkpoint_path, check_same_thread=False, timeout=60.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=60000")
    saver = SqliteSaver(conn)
    saver.setup()
    return saver, conn


def count_checkpoints(settings: Settings, run_id: str) -> int:
    path = settings.checkpoint_path
    if not path.exists():
        return 0
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5.0)
        try:
            r = conn.execute(
                "SELECT COUNT(*) FROM checkpoints WHERE thread_id=?", (run_id,)
            ).fetchone()
            return int(r[0]) if r else 0
        finally:
            conn.close()
    except sqlite3.Error:
        return 0


__all__ = [
    "HANDLERS",
    "Ctx",
    "RunState",
    "Runtime",
    "VendorAttempt",
    "build_graph",
    "count_checkpoints",
    "detect_triggers",
    "initial_state",
    "make_runtime",
    "open_checkpointer",
    "projected_po_date",
]
