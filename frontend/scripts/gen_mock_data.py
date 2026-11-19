"""Regenerate frontend/src/mock/data/<package>.json from the real (pure) backend specialists.

    PYTHONPATH=backend python3 frontend/scripts/gen_mock_data.py            # all packages
    PYTHONPATH=backend python3 frontend/scripts/gen_mock_data.py dg-2mw     # one package
"""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from sitemind.models import Goal
from sitemind.specialists import (
    VendorNetwork, build_decision_memo, check_budget, collect_quotes, draft_po, get_package,
    load_package_catalog, load_package_scenario, package_spec_pdf, rank_options, refresh_quotes,
    run_takeoff, schedule_for_quote,
)

IST = timezone(timedelta(hours=5, minutes=30))
NOW = datetime(2027, 1, 11, 9, 0, tzinfo=IST)
PO_DATE = date(2027, 1, 20)
PO_NUMBER = {"swgr-480v": "PO-ALPHA-SWGR-0001", "dg-2mw": "PO-ALPHA-DG-0001"}
SITUATION = {
    "swgr-480v": "Kestrel (V2) revised its quote on refresh and now breaches the ₹4.6 Cr ceiling.",
    "dg-2mw": "Corvane (D2) revised its quote +14.9 % on refresh (USD/INR, steel) and breaches the ₹38 Cr ceiling; Halvik (D3) slipped its lead time 45 d and now misses the 15 Nov site date. Tarangini (D1) leads but its CPCB IV+ emissions certificate is still outstanding — PO release is blocked until it is received or waived.",
}
dump = lambda m: json.loads(m.model_dump_json())  # noqa: E731


def generate(pid: str) -> None:
    pkg = get_package(pid)
    ros = pkg.required_on_site
    budget = pkg.default_budget_inr
    goal = Goal(text=pkg.default_goal_text, project=pkg.default_project, package=pkg.title,
                need_by=pkg.default_need_by, required_on_site=ros, budget_inr=budget)
    net = VendorNetwork(load_package_scenario(pid, "demo"), load_package_catalog(pid))
    takeoff = run_takeoff(package_spec_pdf(pid), pid)
    qr = collect_quotes(net, list(pkg.vendor_ids), takeoff.lines, NOW)

    def evaluate(quotes):
        scheds = [schedule_for_quote(q, PO_DATE, ros) for q in quotes]
        buds = [check_budget(q, budget) for q in quotes]
        return rank_options(quotes, scheds, buds, net.expedite_offers()), scheds, buds

    opts1, _s1, bud1 = evaluate(qr.quotes)
    refreshed, ref_attempts = refresh_quotes(net, qr.quotes, NOW + timedelta(days=6))
    opts2, sch2, bud2 = evaluate(refreshed)
    memo = build_decision_memo(goal, opts2, SITUATION.get(pid, "Quotes changed on refresh."))
    pos = {}
    for o in opts2:
        if o.budget_verdict != "breach" and o.meets_deadline:
            q = next(x for x in refreshed if x.vendor_id == o.vendor_id)
            pos[o.option_id] = draft_po(goal, o, q, takeoff, PO_NUMBER.get(pid, "PO-0001"), PO_DATE)
    out = {
        "takeoff": dump(takeoff),
        "quotes_r1": [dump(q) for q in qr.quotes],
        "attempts_r1": [dump(a) for a in qr.attempts],
        "options_initial": [dump(o) for o in opts1],
        "budgets_initial": [dump(b) for b in bud1],
        "quotes_refreshed": [dump(q) for q in refreshed],
        "attempts_refresh": [dump(a) for a in ref_attempts],
        "options_replan": [dump(o) for o in opts2],
        "budgets_replan": [dump(b) for b in bud2],
        "schedules": {s.vendor_id: dump(s) for s in sch2},
        "expedite": {k: dump(v) for k, v in net.expedite_offers().items()},
        "memo": dump(memo),
        "pos": {k: dump(v) for k, v in pos.items()},
    }
    dest = Path(__file__).resolve().parents[1] / "src" / "mock" / "data" / f"{pid}.json"
    dest.write_text(json.dumps(out, indent=1, ensure_ascii=False))
    print("wrote", dest.name)
    for tag, opts in (("initial", opts1), ("replan", opts2)):
        print(" ", tag, [(o.option_id, round(o.total_inr / 1e7, 2), o.float_days, o.budget_verdict, o.score, o.recommended) for o in opts])


for pid in sys.argv[1:] or ["swgr-480v", "dg-2mw"]:
    generate(pid)
