"""Headless CLI: ``python -m sitemind.cli demo`` runs the Project Alpha goal end to end.

Workers run as real subprocesses (exactly like the API); human approvals are auto-approved
with the agent's recommendation. ``--kill-after N`` SIGKILLs the worker after N timeline
events and resumes it, to show durability from the terminal.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

from .models import ApprovalDecision, ApprovalStatus, CreateRunRequest
from .runner import create_run, decide_approval, kill_run, resume_run, snapshot


def _inr(x: float) -> str:
    return f"₹{x / 1e7:.2f} Cr"


def demo(args: argparse.Namespace) -> int:
    if args.provider:
        os.environ["SITEMIND_LLM_PROVIDER"] = args.provider
    from .api import DEMO_DEFAULTS

    req = DEMO_DEFAULTS.model_copy(update={"scenario": args.scenario, "step_delay_s": args.delay})
    snap = create_run(CreateRunRequest.model_validate(req.model_dump()))
    rid = snap.run_id
    print(f"SiteMind run {rid}  scenario={args.scenario}  goal: {req.goal_text}")
    printed: set[tuple[str, str, str]] = set()
    seen = 0
    killed = False
    t0 = time.monotonic()
    while True:
        snap = snapshot(rid)
        for e in snap.timeline:
            k = (e.sim_time.isoformat(), e.lane, e.label)
            if k not in printed:
                printed.add(k)
                print(f"  {e.sim_time:%Y-%m-%d %H:%M}  [{e.lane:<9}] {e.label}")
        seen = len(printed)
        if (
            args.kill_after
            and not killed
            and seen >= args.kill_after
            and snap.status.value == ("running")
        ):
            print(f"  >>> kill -9 worker pid {snap.worker.pid}")
            kill_run(rid)
            time.sleep(0.5)
            print("  >>> resume from checkpoint")
            resume_run(rid)
            killed = True
            continue
        st = snap.status.value
        if st == "waiting_human":
            pending = [a for a in snap.approvals if a.status == ApprovalStatus.pending]
            if pending:
                a = pending[0]
                opt = a.memo.recommendation if a.memo else None
                print(f"  >>> auto-approve {a.kind}: {a.title} {opt or ''}")
                decide_approval(
                    rid,
                    a.id,
                    ApprovalDecision(decision="approve", option_id=opt, decided_by="cli.auto"),
                )
        elif st in ("completed", "failed"):
            break
        elif st == "killed":
            resume_run(rid)
        time.sleep(0.3)
    dt = time.monotonic() - t0
    po = snap.po
    print(
        f"\nstatus={snap.status.value}  plan v{snap.plan.version if snap.plan else 0}  "
        f"checkpoints={snap.checkpoints}  restarts={snap.worker.restarts}  wall={dt:.1f}s  "
        f"llm={json.dumps(snap.llm)}"
    )
    if po:
        print(
            f"PO {po.po_number} -> {po.vendor_name}: {_inr(po.total_inr)} incl. GST ({po.status})"
        )
    if args.out:
        Path(args.out).write_text(snap.model_dump_json(indent=2))
        print(f"snapshot written to {args.out}")
    return 0 if snap.status.value == "completed" else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="sitemind")
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("demo", help="run the Project Alpha goal headless, auto-approving")
    d.add_argument("--scenario", default="demo", choices=["demo", "happy"])
    d.add_argument("--delay", type=float, default=0.0, help="wall seconds per step")
    d.add_argument("--provider", default=None, help="ollama | openai | off")
    d.add_argument("--kill-after", type=int, default=0, help="SIGKILL after N timeline events")
    d.add_argument("--out", default=None, help="write final RunSnapshot JSON here")
    args = ap.parse_args(argv)
    if args.cmd == "demo":
        return demo(args)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
