"""Shared, typed contracts for SiteMind.

Every specialist, the planner, the durable graph, the API and the MCP server
exchange these pydantic models. The frontend mirrors them in
``frontend/src/types.ts``. Change them deliberately: they are the contract.
"""

from __future__ import annotations

from datetime import date, datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field

# --------------------------------------------------------------------------- goal


class Goal(BaseModel):
    """A long-horizon procurement goal."""

    text: str = Field(description="Natural-language goal as typed by the user")
    project: str = "Project Alpha"
    package: str = "480 V switchgear"
    need_by: date = Field(description="Date the PO must be issued (ordered-by date)")
    required_on_site: date | None = Field(
        default=None, description="Date equipment must be on site (derived if None)"
    )
    budget_inr: float = Field(gt=0, description="Hard budget ceiling in INR")
    currency: Literal["INR"] = "INR"


# --------------------------------------------------------------------------- registry


class SpecialistSpec(BaseModel):
    """Declaration of a specialist agent in the registry (inputs -> outputs)."""

    name: str  # e.g. "takeoff"
    title: str  # e.g. "Spec / Takeoff"
    description: str
    inputs: list[str]
    outputs: list[str]
    deterministic: bool = True
    side_effects: bool = False  # True => goes through idempotent action ledger
    mcp_tool: str  # MCP tool name exposing it


# --------------------------------------------------------------------------- plan


class TaskStatus(StrEnum):
    pending = "pending"
    ready = "ready"
    running = "running"
    waiting_human = "waiting_human"
    done = "done"
    failed = "failed"
    skipped = "skipped"  # superseded by a re-plan


class Risk(BaseModel):
    id: str
    title: str
    likelihood: Literal["low", "medium", "high"]
    impact: Literal["low", "medium", "high"]
    mitigation: str


class PlanTask(BaseModel):
    id: str  # e.g. "T1-takeoff"
    title: str
    specialist: str  # registry name
    depends_on: list[str] = []
    deadline: date | None = None
    budget_inr: float = 0.0  # cost allowance for executing this task (e.g. expedite)
    status: TaskStatus = TaskStatus.pending
    attempts: int = 0
    plan_version: int = 1
    started_at: datetime | None = None  # sim time
    finished_at: datetime | None = None  # sim time
    output_ref: str | None = None  # key into RunState.facts
    note: str | None = None


class Plan(BaseModel):
    version: int = 1
    tasks: list[PlanTask]
    risks: list[Risk] = []
    rationale: str = ""
    created_at: datetime  # sim time


# --------------------------------------------------------------------------- specialist outputs


class TakeoffLine(BaseModel):
    item_code: str  # e.g. "SWGR-MAIN-4000A"
    description: str
    qty: int
    unit: str = "ea"
    rating: str = ""  # e.g. "4000 A, 65 kA"
    source: str = ""  # "spec.pdf p2 table 1"


class TakeoffResult(BaseModel):
    document: str
    lines: list[TakeoffLine]
    confidence: float = Field(ge=0, le=1)
    warnings: list[str] = []


class QuoteLine(BaseModel):
    item_code: str
    qty: int
    unit_price_inr: float
    total_inr: float


class Quote(BaseModel):
    vendor_id: str
    vendor_name: str
    quote_id: str
    revision: int = 1
    lines: list[QuoteLine]
    freight_inr: float = 0.0
    total_inr: float
    lead_time_days: int
    valid_until: date
    reliability: float = Field(ge=0, le=1)  # historical on-time delivery
    status: Literal["received", "revised", "timeout", "declined"] = "received"
    received_at: datetime | None = None  # sim time
    notes: str = ""


class VendorAttempt(BaseModel):
    vendor_id: str
    attempt: int
    outcome: Literal["ok", "timeout", "revised", "declined"]
    at: datetime  # sim time
    detail: str = ""


class QuotesResult(BaseModel):
    quotes: list[Quote]
    attempts: list[VendorAttempt]


class ScheduleActivity(BaseModel):
    id: str
    name: str
    duration_days: int
    depends_on: list[str] = []
    early_start: int = 0  # day offsets from plan start
    early_finish: int = 0
    late_start: int = 0
    late_finish: int = 0
    slack_days: int = 0
    critical: bool = False


class ScheduleResult(BaseModel):
    vendor_id: str
    activities: list[ScheduleActivity]
    critical_path: list[str]
    po_issue_date: date
    delivery_date: date
    required_on_site: date
    float_days: int  # negative => late
    meets_deadline: bool


class BudgetCheck(BaseModel):
    vendor_id: str
    quote_total_inr: float
    contingency_inr: float
    committed_inr: float  # quote + contingency + expedite/fees
    budget_inr: float
    headroom_inr: float
    utilisation: float  # committed / budget
    verdict: Literal["ok", "warn", "breach"]
    reasons: list[str] = []


class VendorOption(BaseModel):
    """One ranked option shown in the decision memo / vendor comparison."""

    option_id: str
    vendor_id: str
    vendor_name: str
    total_inr: float
    lead_time_days: int
    delivery_date: date
    float_days: int
    reliability: float
    expedite_fee_inr: float = 0.0
    budget_verdict: Literal["ok", "warn", "breach"]
    meets_deadline: bool
    score: float
    recommended: bool = False
    rationale: str = ""


class DecisionMemo(BaseModel):
    memo_id: str
    title: str
    situation: str
    options: list[VendorOption]
    recommendation: str  # option_id
    reasoning: str
    risks: list[str]
    asks: str  # what the human must decide


class POLine(BaseModel):
    line_no: int
    item_code: str
    description: str
    qty: int
    unit_price_inr: float
    total_inr: float


class PurchaseOrder(BaseModel):
    po_number: str
    vendor_id: str
    vendor_name: str
    project: str
    lines: list[POLine]
    subtotal_inr: float
    freight_inr: float
    expedite_fee_inr: float = 0.0
    gst_inr: float
    total_inr: float
    delivery_date: date
    payment_terms: str
    incoterms: str
    terms: list[str]
    status: Literal["draft", "approved", "sent"] = "draft"
    issued_at: datetime | None = None
    markdown: str = ""  # rendered PO package


# --------------------------------------------------------------------------- HITL


class ApprovalStatus(StrEnum):
    pending = "pending"
    approved = "approved"
    rejected = "rejected"


class ApprovalRequest(BaseModel):
    id: str  # stable, e.g. "<run_id>:vendor-selection:v2"
    run_id: str
    kind: Literal["vendor_selection", "po_release", "budget_exception", "deadline_risk"]
    title: str
    summary: str
    memo: DecisionMemo | None = None
    po: PurchaseOrder | None = None
    options: list[str] = []  # option ids allowed for selection
    status: ApprovalStatus = ApprovalStatus.pending
    decided_option: str | None = None
    decided_by: str | None = None
    comment: str | None = None
    requested_at: datetime  # sim time
    decided_at: datetime | None = None


class ApprovalDecision(BaseModel):
    decision: Literal["approve", "reject"]
    option_id: str | None = None
    comment: str | None = None
    decided_by: str = "project.manager@alpha"


# --------------------------------------------------------------------------- audit / ledger


class AuditEntry(BaseModel):
    seq: int
    run_id: str
    sim_time: datetime
    wall_time: datetime
    actor: str  # "planner", "takeoff", "quotes", ..., "human", "system"
    action: str  # e.g. "plan.created", "quote.received", "replan", "po.sent"
    summary: str  # reasoning summary, one or two sentences
    inputs: dict[str, Any] = {}
    outputs: dict[str, Any] = {}
    cost_inr: float = 0.0  # money committed/spent by this decision
    llm_tokens: int = 0
    confidence: float | None = None
    task_id: str | None = None
    plan_version: int | None = None


class LedgerEntry(BaseModel):
    """An external side effect, executed at most once per idempotency key."""

    idempotency_key: str
    run_id: str
    kind: str  # "rfq.sent", "po.sent", "approval.requested", "llm.call", ...
    status: Literal["done"] = "done"
    payload: dict[str, Any] = {}
    result: dict[str, Any] = {}
    sim_time: datetime
    wall_time: datetime
    executions: int = 1  # how many times the key was *requested*; executed once


# --------------------------------------------------------------------------- run snapshot


class RunStatus(StrEnum):
    created = "created"
    running = "running"
    waiting_human = "waiting_human"
    killed = "killed"  # worker died / was killed; resumable
    completed = "completed"
    failed = "failed"


class WorkerInfo(BaseModel):
    pid: int | None = None
    alive: bool = False
    started_at: datetime | None = None
    restarts: int = 0


class BudgetBurn(BaseModel):
    budget_inr: float
    committed_inr: float  # money committed so far (POs, fees)
    forecast_inr: float  # best current option total + contingency
    spent_process_inr: float  # process cost (LLM, expediting calls...)
    points: list[dict[str, Any]] = []  # [{sim_time, committed_inr, forecast_inr}]


class TimelineEvent(BaseModel):
    sim_time: datetime
    lane: str  # "planner" | specialist name | "human" | "system"
    label: str
    kind: Literal["info", "success", "warning", "error", "human", "kill"] = "info"


class RunSnapshot(BaseModel):
    run_id: str
    goal: Goal
    status: RunStatus
    sim_now: datetime
    sim_start: datetime
    plan: Plan | None = None
    plan_history: list[Plan] = []
    takeoff: TakeoffResult | None = None
    quotes: list[Quote] = []
    vendor_attempts: list[VendorAttempt] = []
    options: list[VendorOption] = []
    schedule: ScheduleResult | None = None
    budget: BudgetBurn
    approvals: list[ApprovalRequest] = []
    po: PurchaseOrder | None = None
    audit: list[AuditEntry] = []
    ledger: list[LedgerEntry] = []
    timeline: list[TimelineEvent] = []
    worker: WorkerInfo
    checkpoints: int = 0  # number of LangGraph checkpoints persisted
    current_node: str | None = None
    llm: dict[str, Any] = {}  # {"provider": "ollama", "model": "...", "calls": n}
    error: str | None = None


class CreateRunRequest(BaseModel):
    goal_text: str
    project: str = "Project Alpha"
    package: str = "480 V switchgear"
    need_by: date
    budget_inr: float
    scenario: Literal["demo", "happy"] = "demo"  # demo = with injected failures
    step_delay_s: float | None = None  # wall-clock pacing per step (demo)
    auto_start: bool = True
