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
    DEFAULT_PACKAGE,
    REGISTRY,
    build_decision_memo,
    collect_quotes,
    draft_po,
    get_package,
    list_packages,
    load_package_scenario,
    package_spec_pdf,
    parse_goal,
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
DEFAULT_ROS = date(2027, 7, 30)  # swgr-480v; other packages use their PackageSpec dates
DEFAULT_NEED_BY = date(2027, 3, 15)
DEFAULT_BUDGET = 46_000_000.0

mcp: Any = _server_class()(
    "sitemind",
    instructions=(
        "SiteMind procurement specialists for Project Alpha. Packages: call list_packages "
        "(e.g. 'swgr-480v' 480 V switchgear, 'dg-2mw' 2 MW DG sets); most tools take a "
        "package_id. All arithmetic is deterministic; money is INR ex-GST unless stated. Typical "
        "flow: parse_goal -> takeoff_from_pdf -> request_vendor_quotes -> compute_schedule / "
        "check_budget -> rank_vendor_options -> draft_purchase_order."
    ),
)


def _dump(obj: Any) -> Any:
    if isinstance(obj, list):
        return [_dump(o) for o in obj]
    if hasattr(obj, "model_dump"):
        return obj.model_dump(mode="json")
    return obj


def _goal(package_id: str, required_on_site: date, budget_inr: float) -> Goal:
    pkg = get_package(package_id)
    return Goal(
        text=pkg.default_goal_text,
        project=pkg.default_project,
        package=pkg.title,
        need_by=pkg.default_need_by,
        required_on_site=required_on_site,
        budget_inr=budget_inr,
    )


def _evaluate(
    scenario: str,
    po_issue_date: date,
    required_on_site: date,
    budget_inr: float,
    refreshed: bool,
    pdf_path: str | None = None,
    package_id: str = DEFAULT_PACKAGE,
) -> tuple[TakeoffResult, list[Quote], list[VendorOption], dict[str, Any]]:
    """Run takeoff -> quotes (-> refresh) -> schedule + budget -> ranking for a scenario."""
    takeoff = run_takeoff(pdf_path or package_spec_pdf(package_id), package_id)
    net = VendorNetwork(load_package_scenario(package_id, scenario))
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
        "missing_documents": {v: net.missing_documents(v) for v in net.vendor_ids()},
    }
    return takeoff, quotes, options, extra


def _defaults(
    package_id: str, required_on_site: date | None, budget_inr: float | None
) -> tuple[date, float]:
    pkg = get_package(package_id)
    return (required_on_site or pkg.required_on_site, budget_inr or pkg.default_budget_inr)


@mcp.tool(name="list_packages")
def list_packages_() -> list[dict[str, Any]]:
    """List the procurement packages SiteMind can buy (id, title, keywords, vendors, default
    goal, need-by, budget, required-on-site date)."""
    return [p.model_dump(mode="json") for p in list_packages()]


@mcp.tool(name="parse_goal")
def parse_goal_(text: str, today: date | None = None) -> dict[str, Any]:
    """Parse a plain-English procurement goal into package / project / need-by / budget with the
    exact evidence span for each, missing fields and questions; unsupported packages come back
    with supported=false (hand to a human). Deterministic."""
    out: dict[str, Any] = parse_goal(text, today or DEFAULT_NOW.date()).model_dump(mode="json")
    return out


@mcp.tool()
def takeoff_from_pdf(pdf_path: str | None = None, package_id: str | None = None) -> dict[str, Any]:
    """Extract the equipment schedule (quantities, ratings, page refs) from any spec PDF,
    classify lines to package categories and cross-check against drawing/datasheet pages.
    Defaults to the bundled sample spec of package_id (or 480 V switchgear)."""
    path = Path(pdf_path) if pdf_path else package_spec_pdf(package_id or DEFAULT_PACKAGE)
    result: dict[str, Any] = run_takeoff(path, package_id).model_dump(mode="json")
    return result


@mcp.tool()
def request_vendor_quotes(
    vendor_ids: list[str] | None = None,
    scenario: str = "demo",
    now: datetime = DEFAULT_NOW,
    max_attempts: int = 3,
    refresh: bool = False,
    package_id: str = DEFAULT_PACKAGE,
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Send RFQs for the package's sample takeoff to the mock vendor network (scenario 'demo' or
    'happy'), retrying timeouts up to max_attempts. With refresh=true, quotes are re-confirmed 3
    days later and any revision is returned. `overrides` replays live events (VendorNetwork
    overrides). Includes expedite offers and missing documents."""
    takeoff = run_takeoff(package_spec_pdf(package_id), package_id)
    net = VendorNetwork(load_package_scenario(package_id, scenario), overrides=overrides)
    res = collect_quotes(net, vendor_ids or net.vendor_ids(), takeoff.lines, now, max_attempts)
    quotes, attempts = res.quotes, list(res.attempts)
    if refresh:
        quotes, log = refresh_quotes(net, quotes, now + timedelta(days=3))
        attempts += log
    return {
        "quotes": _dump(quotes),
        "attempts": _dump(attempts),
        "expedite_offers": [o.model_dump(mode="json") for o in net.expedite_offers().values()],
        "missing_documents": {v: net.missing_documents(v) for v in net.vendor_ids()},
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
    required_on_site: date | None = None,
    budget_inr: float | None = None,
    refreshed: bool = True,
    package_id: str = DEFAULT_PACKAGE,
) -> dict[str, Any]:
    """Evaluate every vendor option for the package + scenario (incl. expedited variants), rank
    them by weighted score (cost 40 %, float 35 %, reliability 25 %; breach / late =
    infeasible) and return the decision memo. Dates/budget default to the package's."""
    ros, budget = _defaults(package_id, required_on_site, budget_inr)
    _, _, options, extra = _evaluate(
        scenario, po_issue_date, ros, budget, refreshed, package_id=package_id
    )
    situation = (
        f"{get_package(package_id).title}, scenario '{scenario}': quotes "
        f"{'after refresh' if refreshed else 'as first received'}; PO issue "
        f"{po_issue_date.isoformat()}, required on site {ros.isoformat()}."
    )
    memo = build_decision_memo(_goal(package_id, ros, budget), options, situation)
    return {"options": _dump(options), "memo": memo.model_dump(mode="json"), **extra}


@mcp.tool()
def draft_purchase_order(
    option_id: str | None = None,
    scenario: str = "demo",
    po_number: str = "PA-PO-0001",
    po_issue_date: date = DEFAULT_PO_DATE,
    required_on_site: date | None = None,
    budget_inr: float | None = None,
    package_id: str = DEFAULT_PACKAGE,
) -> dict[str, Any]:
    """Draft the purchase order (lines, freight, expedite, GST 18 %, package terms, markdown)
    for an option id from rank_vendor_options (default: the recommended option)."""
    ros, budget = _defaults(package_id, required_on_site, budget_inr)
    takeoff, quotes, options, _ = _evaluate(
        scenario, po_issue_date, ros, budget, refreshed=True, package_id=package_id
    )
    chosen = (
        next((o for o in options if o.option_id == option_id), None)
        if option_id
        else next((o for o in options if o.recommended), options[0])
    )
    if chosen is None:
        raise ValueError(f"unknown option {option_id!r}; options: {[o.option_id for o in options]}")
    quote = next(q for q in quotes if q.vendor_id == chosen.vendor_id)
    po = draft_po(_goal(package_id, ros, budget), chosen, quote, takeoff, po_number, po_issue_date)
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
