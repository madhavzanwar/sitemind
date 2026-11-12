"""SiteMind MCP server: exposes the deterministic specialists as MCP tools.

Built on the official MCP Python SDK. Works with SDK v2 (``mcp.server.mcpserver.MCPServer``)
and v1 (``mcp.server.fastmcp.FastMCP``; same decorator API).

Run::

    python -m sitemind.mcp_server                      # stdio (Claude Desktop / Code, Cursor...)
    python -m sitemind.mcp_server --http --port 8765   # streamable HTTP at /mcp

Tools are stateless: tools that need vendor quotes re-derive them from the named scenario,
which is deterministic, so an agent can call them in any order and get consistent numbers.
"""

from __future__ import annotations

import argparse
import importlib
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from sitemind.models import Goal, Quote, TakeoffResult, VendorOption
from sitemind.specialists import (
    REGISTRY,
    SPEC_PDF,
    build_decision_memo,
    collect_quotes,
    draft_po,
    load_scenario,
    rank_options,
    refresh_quotes,
    run_takeoff,
    schedule_for_lead_time,
    schedule_for_quote,
)
from sitemind.specialists import check_budget as _check_budget
from sitemind.specialists.vendors import VendorNetwork


def _server_class() -> Any:
    """MCP SDK v2 ``MCPServer`` if available, else SDK v1 ``FastMCP`` (same decorator API)."""
    try:
        return importlib.import_module("mcp.server.mcpserver").MCPServer
    except ImportError:  # pragma: no cover - SDK v1
        return importlib.import_module("mcp.server.fastmcp").FastMCP


IST = timezone(timedelta(hours=5, minutes=30))
DEFAULT_NOW = datetime(2027, 1, 11, 9, 0, tzinfo=IST)
DEFAULT_PO_DATE = date(2027, 1, 20)
DEFAULT_ROS = date(2027, 7, 30)
DEFAULT_NEED_BY = date(2027, 3, 15)
DEFAULT_BUDGET = 46_000_000.0
DEFAULT_GOAL = (
    "Get the 480 V switchgear package for Project Alpha ordered by 2027-03-15 within budget "
    "INR 4.6 Cr"
)

mcp: Any = _server_class()(
    "sitemind",
    instructions=(
        "SiteMind procurement specialists for Project Alpha (480 V switchgear). All arithmetic is "
        "deterministic; money is INR ex-GST unless stated. Typical flow: takeoff_from_pdf -> "
        "request_vendor_quotes -> compute_schedule / check_budget -> rank_vendor_options -> "
        "draft_purchase_order."
    ),
)


def _dump(obj: Any) -> Any:
    if isinstance(obj, list):
        return [_dump(o) for o in obj]
    if hasattr(obj, "model_dump"):
        return obj.model_dump(mode="json")
    return obj


def _evaluate(
    scenario: str,
    po_issue_date: date,
    required_on_site: date,
    budget_inr: float,
    refreshed: bool,
    pdf_path: str | None = None,
) -> tuple[TakeoffResult, list[Quote], list[VendorOption], dict[str, Any]]:
    """Run takeoff -> quotes (-> refresh) -> schedule + budget -> ranking for a scenario."""
    takeoff = run_takeoff(pdf_path or SPEC_PDF)
    net = VendorNetwork(load_scenario(scenario))
    res = collect_quotes(net, net.vendor_ids(), takeoff.lines, DEFAULT_NOW)
    quotes = res.quotes
    attempts = list(res.attempts)
    if refreshed:
        quotes, log = refresh_quotes(net, quotes, DEFAULT_NOW + timedelta(days=3))
        attempts += log
    priced = [q for q in quotes if q.status not in ("timeout", "declined")]
    schedules = [schedule_for_quote(q, po_issue_date, required_on_site) for q in priced]
    budgets = [_check_budget(q, budget_inr) for q in priced]
    options = rank_options(priced, schedules, budgets, net.expedite_offers())
    extra = {
        "attempts": _dump(attempts),
        "schedules": _dump(schedules),
        "budgets": _dump(budgets),
    }
    return takeoff, quotes, options, extra


@mcp.tool()
def takeoff_from_pdf(pdf_path: str | None = None) -> dict[str, Any]:
    """Extract the equipment schedule (quantities, ratings, page refs) from a spec PDF and
    cross-check it against the single-line diagram. Defaults to the bundled Project Alpha spec."""
    path = Path(pdf_path) if pdf_path else SPEC_PDF
    result: dict[str, Any] = run_takeoff(path).model_dump(mode="json")
    return result


@mcp.tool()
def request_vendor_quotes(
    vendor_ids: list[str] | None = None,
    scenario: str = "demo",
    now: datetime = DEFAULT_NOW,
    max_attempts: int = 3,
    refresh: bool = False,
) -> dict[str, Any]:
    """Send RFQs for the bundled takeoff to the mock vendor network (scenario 'demo' or 'happy'),
    retrying timeouts up to max_attempts. With refresh=true, quotes are re-confirmed 3 days later
    and any price revision is returned. Includes available expedite offers."""
    takeoff = run_takeoff(SPEC_PDF)
    net = VendorNetwork(load_scenario(scenario))
    res = collect_quotes(net, vendor_ids or net.vendor_ids(), takeoff.lines, now, max_attempts)
    quotes, attempts = res.quotes, list(res.attempts)
    if refresh:
        quotes, log = refresh_quotes(net, quotes, now + timedelta(days=3))
        attempts += log
    return {
        "quotes": _dump(quotes),
        "attempts": _dump(attempts),
        "expedite_offers": [o.model_dump(mode="json") for o in net.expedite_offers().values()],
    }


@mcp.tool()
def compute_schedule(
    lead_time_days: int,
    po_issue_date: date = DEFAULT_PO_DATE,
    required_on_site: date = DEFAULT_ROS,
    vendor_id: str = "ANY",
) -> dict[str, Any]:
    """CPM schedule (forward/backward pass, slack, critical path) for PO -> submittals (14 d) ->
    approval (10 d) -> manufacture (lead time) -> FAT (5 d) -> shipping (7 d) -> delivery, with
    float against the required-on-site date (negative = late)."""
    sched = schedule_for_lead_time(vendor_id, lead_time_days, po_issue_date, required_on_site)
    out: dict[str, Any] = sched.model_dump(mode="json")
    return out


@mcp.tool()
def check_budget(
    quote: Quote,
    budget_inr: float = DEFAULT_BUDGET,
    contingency_pct: float = 0.05,
    expedite_fee_inr: float = 0.0,
) -> dict[str, Any]:
    """Budget guard: quote total + contingency + expedite fee vs the ceiling (ex-GST).
    Verdict ok < 90 %, warn 90-100 %, breach > 100 %."""
    out: dict[str, Any] = _check_budget(
        quote, budget_inr, contingency_pct, expedite_fee_inr
    ).model_dump(mode="json")
    return out


@mcp.tool()
def rank_vendor_options(
    scenario: str = "demo",
    po_issue_date: date = DEFAULT_PO_DATE,
    required_on_site: date = DEFAULT_ROS,
    budget_inr: float = DEFAULT_BUDGET,
    refreshed: bool = True,
) -> dict[str, Any]:
    """Evaluate every vendor option for the scenario (incl. expedited variants), rank them by
    weighted score (cost 40 %, float 35 %, reliability 25 %; breach / late = infeasible) and
    return the decision memo."""
    _, _, options, extra = _evaluate(
        scenario, po_issue_date, required_on_site, budget_inr, refreshed
    )
    goal = Goal(
        text=DEFAULT_GOAL,
        need_by=DEFAULT_NEED_BY,
        required_on_site=required_on_site,
        budget_inr=budget_inr,
    )
    situation = (
        f"Scenario '{scenario}': quotes {'after refresh' if refreshed else 'as first received'}; "
        f"PO issue {po_issue_date.isoformat()}, required on site {required_on_site.isoformat()}."
    )
    memo = build_decision_memo(goal, options, situation)
    return {"options": _dump(options), "memo": memo.model_dump(mode="json"), **extra}


@mcp.tool()
def draft_purchase_order(
    option_id: str | None = None,
    scenario: str = "demo",
    po_number: str = "PA-PO-480-0001",
    po_issue_date: date = DEFAULT_PO_DATE,
    required_on_site: date = DEFAULT_ROS,
    budget_inr: float = DEFAULT_BUDGET,
) -> dict[str, Any]:
    """Draft the purchase order (lines, freight, expedite, GST 18 %, terms, markdown package)
    for an option id from rank_vendor_options (default: the recommended option)."""
    takeoff, quotes, options, _ = _evaluate(
        scenario, po_issue_date, required_on_site, budget_inr, refreshed=True
    )
    chosen = (
        next((o for o in options if o.option_id == option_id), None)
        if option_id
        else next((o for o in options if o.recommended), options[0])
    )
    if chosen is None:
        raise ValueError(f"unknown option {option_id!r}; options: {[o.option_id for o in options]}")
    quote = next(q for q in quotes if q.vendor_id == chosen.vendor_id)
    goal = Goal(
        text=DEFAULT_GOAL,
        need_by=DEFAULT_NEED_BY,
        required_on_site=required_on_site,
        budget_inr=budget_inr,
    )
    po = draft_po(goal, chosen, quote, takeoff, po_number, po_issue_date)
    out: dict[str, Any] = po.model_dump(mode="json")
    return out


@mcp.tool()
def list_specialists() -> list[dict[str, Any]]:
    """List the SiteMind specialist registry (name, inputs, outputs, MCP tool, determinism)."""
    return [s.model_dump(mode="json") for s in REGISTRY]


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="SiteMind MCP server")
    parser.add_argument(
        "--http", action="store_true", help="serve streamable HTTP instead of stdio"
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    if not args.http:
        mcp.run("stdio")
        return
    if hasattr(getattr(mcp, "settings", None), "host"):  # SDK v1: host/port on settings
        mcp.settings.host = args.host
        mcp.settings.port = args.port
        mcp.run("streamable-http")
    else:
        mcp.run("streamable-http", host=args.host, port=args.port)


if __name__ == "__main__":
    main()
