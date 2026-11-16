"""Headless CLI: ``python -m sitemind.cli demo`` runs the Project Alpha goal end to end.

Workers run as real subprocesses (exactly like the API); human approvals are auto-approved
with the agent's recommendation. ``--kill-after N`` SIGKILLs the worker after N timeline
events and resumes it, to show durability from the terminal.

``--package dg-2mw`` runs another package; ``--inject SPEC`` (repeatable) fires live events:
``type[:vendor][:k=v,k=v][@when]`` where ``when`` is a task-id prefix (``T5``: when that task
starts), ``waiting`` / ``waiting2`` (the 1st / 2nd human approval wait) or omitted (at start).
Examples: ``price_change:V2:pct=8@T5``, ``restart@T4``, ``approver_unavailable::days=3@waiting``,
``date_slip::days=-20,target=required_on_site@T7``.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .models import (
    ApprovalDecision,
    ApprovalStatus,
    CreateRunRequest,
    EventType,
    InjectEventRequest,
)
from .runner import create_run, decide_approval, inject_event, kill_run, resume_run, snapshot


@dataclass
class Injection:
    spec: str
    request: InjectEventRequest
    when: str  # "" (start), "T5" (task prefix), "waiting", "waiting2", ...
    done: bool = False


def _value(v: str) -> Any:
    for cast in (int, float):
        try:
            return cast(v)
        except ValueError:
            pass
    return v


def parse_injection(spec: str) -> Injection:
    """``price_change:V2:pct=8@T5`` -> Injection (raises ValueError on a bad spec)."""
    body, _, when = spec.partition("@")
    parts = body.split(":")
    etype = EventType(parts[0].strip())
    vendor = parts[1].strip() if len(parts) > 1 and parts[1].strip() else None
    params: dict[str, Any] = {}
    if len(parts) > 2 and parts[2].strip():
        for kv in parts[2].split(","):
            k, _, v = kv.partition("=")
            if not k or not _:
                raise ValueError(f"bad param {kv!r} in {spec!r}")
            params[k.strip()] = _value(v.strip())
    return Injection(
        spec,
        InjectEventRequest(
            type=etype, vendor_id=vendor, params=params, note=f"cli --inject {spec}"
        ),
        when.strip(),
    )


def _inr(x: float) -> str:
    return f"₹{x / 1e7:.2f} Cr"


def demo(args: argparse.Namespace) -> int:
    if args.provider:
        os.environ["SITEMIND_LLM_PROVIDER"] = args.provider
    from .api import demo_defaults_for

    injections = [parse_injection(x) for x in (args.inject or [])]
    delay = args.delay if args.delay or not (args.kill_during or injections) else 1.0
    req = demo_defaults_for(args.package).model_copy(
        update={"scenario": args.scenario, "step_delay_s": delay}
    )
    snap = create_run(CreateRunRequest.model_validate(req.model_dump()))
    rid = snap.run_id
    print(f"SiteMind run {rid}  package={args.package}  scenario={args.scenario}")
    print(f"  goal: {req.goal_text}")
    waits = 0
    in_wait = False
    printed: set[tuple[str, str, str]] = set()
    seen = 0
    killed = False
    kill_tid = ""
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
        node = snap.current_node or ""
        if snap.status.value == "waiting_human" and not in_wait:
            in_wait, waits = True, waits + 1
        elif snap.status.value != "waiting_human":
            in_wait = False
        for inj in injections:
            due = (
                inj.when == ""
                or (inj.when.startswith("T") and node.startswith(f"execute:{inj.when}"))
                or (
                    inj.when.startswith("waiting")
                    and in_wait
                    and waits == int(inj.when[len("waiting") :] or 1)
                )
            )
            if due and not inj.done and snap.status.value not in ("completed", "failed"):
                inj.done = True
                print(f"  >>> inject {inj.spec}")
                snap = inject_event(rid, inj.request)
        holding = any(e.status == "pending" for e in snap.events)
        if (
            args.kill_during
            and not killed
            and snap.status.value == "running"
            and node.startswith(f"execute:{args.kill_during}")
            and node.endswith(":pacing")
        ):
            tid = node.split(":")[1]
            done = [e for e in snap.ledger if f":{tid}:" in e.idempotency_key]
            print(
                f"  >>> kill -9 worker pid {snap.worker.pid} during {tid} "
                f"(after {len(done)} ledgered side effect(s), before its checkpoint)"
            )
            kill_run(rid)
            time.sleep(0.5)
            print("  >>> resume from checkpoint (side effects will be replayed from the ledger)")
            resume_run(rid)
            killed = True
            kill_tid = tid
            continue
        st = snap.status.value
        if st == "waiting_human" and not holding:
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
        time.sleep(0.1)
    dt = time.monotonic() - t0
    po = snap.po
    print(
        f"\nstatus={snap.status.value}  plan v{snap.plan.version if snap.plan else 0}  "
        f"checkpoints={snap.checkpoints}  restarts={snap.worker.restarts}  wall={dt:.1f}s  "
        f"llm={json.dumps(snap.llm)}"
    )
    for ev in snap.events:
        print(f"  event {ev.id} {ev.type.value} {ev.vendor_id or ''} [{ev.status}] {ev.outcome}")
    if kill_tid:
        for le in snap.ledger:
            if f":{kill_tid}:" in le.idempotency_key:
                print(f"  ledger {le.idempotency_key}: kind={le.kind} executions={le.executions}")
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
    d.add_argument("--package", default="swgr-480v", help="package id (see GET /api/packages)")
    d.add_argument(
        "--inject",
        action="append",
        metavar="SPEC",
        help="live event 'type[:vendor][:k=v,...][@T5|@waiting]' (repeatable)",
    )
    d.add_argument("--delay", type=float, default=0.0, help="wall seconds per step")
    d.add_argument("--provider", default=None, help="ollama | openai | off")
    d.add_argument("--kill-after", type=int, default=0, help="SIGKILL after N timeline events")
    d.add_argument(
        "--kill-during",
        default="",
        metavar="TASK_ID_PREFIX",
        help="SIGKILL the worker inside that task's pacing window (after its side effects, "
        "before its checkpoint), e.g. T2-rfq or T3-levelling; implies --delay 1 if unset",
    )
    d.add_argument("--out", default=None, help="write final RunSnapshot JSON here")
    args = ap.parse_args(argv)
    if args.cmd == "demo":
        return demo(args)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
