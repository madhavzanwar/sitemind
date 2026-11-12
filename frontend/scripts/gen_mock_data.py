"""Regenerate frontend/src/mock/specialists.json from the real (pure) backend specialists.

    PYTHONPATH=backend python frontend/scripts/gen_mock_data.py
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from sitemind.models import Goal
from sitemind.specialists import (
    SPEC_PDF, VendorNetwork, build_decision_memo, check_budget, collect_quotes, draft_po,
    load_scenario, rank_options, refresh_quotes, run_takeoff, schedule_for_quote,
)

IST = timezone(timedelta(hours=5, minutes=30))
NOW = datetime(2027, 1, 11, 9, 0, tzinfo=IST)
PO_DATE = date(2027, 1, 20)
ROS = date(2027, 7, 30)
BUDGET = 46_000_000

goal = Goal(text="Get the 480 V switchgear package for Project Alpha ordered by 2027-03-15 within budget ₹4.6 Cr",
            need_by=date(2027, 3, 15), required_on_site=ROS, budget_inr=BUDGET)
net = VendorNetwork(load_scenario("demo"))
takeoff = run_takeoff(SPEC_PDF)
qr = collect_quotes(net, ["V1", "V2", "V3"], takeoff.lines, NOW)


def evaluate(quotes):
    scheds = [schedule_for_quote(q, PO_DATE, ROS) for q in quotes]
    buds = [check_budget(q, BUDGET) for q in quotes]
    return rank_options(quotes, scheds, buds, net.expedite_offers()), scheds, buds


opts1, sch1, bud1 = evaluate(qr.quotes)
refreshed, ref_attempts = refresh_quotes(net, qr.quotes, NOW + timedelta(days=6))
opts2, sch2, bud2 = evaluate(refreshed)
memo = build_decision_memo(goal, opts2, "Kestrel (V2) revised its quote on refresh and now breaches the ₹4.6 Cr ceiling.")
pos = {}
for o in opts2:
    if o.option_id in ("O-V3X", "O-V1"):
        q = next(x for x in refreshed if x.vendor_id == o.vendor_id)
        pos[o.option_id] = draft_po(goal, o, q, takeoff, "PO-ALPHA-SWGR-0001", PO_DATE)

dump = lambda m: json.loads(m.model_dump_json())  # noqa: E731
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
dest = Path(__file__).resolve().parents[1] / "src" / "mock" / "specialists.json"
dest.write_text(json.dumps(out, indent=1, ensure_ascii=False))
print("wrote", dest, {k: len(v) if isinstance(v, (list, dict)) else 1 for k, v in out.items()})
