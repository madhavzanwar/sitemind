"""Specialist registry: what each agent consumes / produces and which MCP tool exposes it."""

from __future__ import annotations

from sitemind.models import SpecialistSpec

REGISTRY: list[SpecialistSpec] = [
    SpecialistSpec(
        name="planner",
        title="Planner",
        description="Turns the goal into a task DAG with deadlines, budget allowances and risks; "
        "re-plans when a specialist reports a breach or a missed deadline.",
        inputs=["Goal", "RunState.facts"],
        outputs=["Plan"],
        deterministic=False,
        side_effects=False,
        mcp_tool="list_specialists",
    ),
    SpecialistSpec(
        name="takeoff",
        title="Spec / Takeoff",
        description="Reads the electrical spec PDF, extracts the equipment schedule (count and "
        "linear quantities) and cross-checks it against device labels on the single-line diagram.",
        inputs=["pdf_path"],
        outputs=["TakeoffResult"],
        mcp_tool="takeoff_from_pdf",
    ),
    SpecialistSpec(
        name="quotes",
        title="RFQ / Quotes",
        description="Sends RFQs to the vendor network with retries (timeouts recorded per "
        "attempt), falls back to remaining vendors, and refreshes quotes to detect revisions.",
        inputs=["TakeoffResult.lines", "vendor_ids", "sim_now", "scenario"],
        outputs=["QuotesResult", "VendorAttempt[]"],
        side_effects=True,
        mcp_tool="request_vendor_quotes",
    ),
    SpecialistSpec(
        name="schedule",
        title="Schedule (CPM)",
        description="Critical-path schedule PO -> submittals -> approval -> manufacture -> FAT -> "
        "shipping -> delivery; float against the required-on-site date.",
        inputs=["Quote", "po_issue_date", "required_on_site"],
        outputs=["ScheduleResult"],
        mcp_tool="compute_schedule",
    ),
    SpecialistSpec(
        name="budget",
        title="Budget guard",
        description="Quote + 5% contingency + expedite fees vs the budget ceiling (ex-GST): "
        "ok < 90%, warn 90-100%, breach > 100%.",
        inputs=["Quote", "budget_inr", "contingency_pct", "expedite_fee_inr"],
        outputs=["BudgetCheck"],
        mcp_tool="check_budget",
    ),
    SpecialistSpec(
        name="approvals",
        title="Options & decision memo",
        description="Ranks vendor options (cost 40%, float 35%, reliability 25%; budget breach and "
        "late delivery are hard constraints) and writes the decision memo for human approval.",
        inputs=["Quote[]", "ScheduleResult[]", "BudgetCheck[]", "ExpediteOffer[]", "Goal"],
        outputs=["VendorOption[]", "DecisionMemo"],
        mcp_tool="rank_vendor_options",
    ),
    SpecialistSpec(
        name="po",
        title="Purchase order",
        description="Drafts the PO package (lines from takeoff x quote, freight, expedite, "
        "GST 18%, LDs, warranty, FAT witness, submittals) rendered as markdown; sending is a "
        "ledgered side effect.",
        inputs=["Goal", "VendorOption", "Quote", "TakeoffResult", "po_number", "issued"],
        outputs=["PurchaseOrder"],
        side_effects=True,
        mcp_tool="draft_purchase_order",
    ),
]


def get_specialist(name: str) -> SpecialistSpec:
    """Look up a specialist by registry name; raises ``KeyError`` if unknown."""
    for spec in REGISTRY:
        if spec.name == name:
            return spec
    raise KeyError(f"unknown specialist {name!r}; known: {[s.name for s in REGISTRY]}")
