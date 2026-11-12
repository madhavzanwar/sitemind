"""Worker process and run-management service layer.

``python -m sitemind.runner <run_id> [--resume-value JSON]`` runs (or resumes) one run's
LangGraph from its latest SQLite checkpoint until it finishes or waits for a human. The API and
the CLI share the service functions below (create / kill / resume / decide / snapshot).
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import secrets
import signal
import subprocess
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any

from langgraph.types import Command

from .config import IST, SIM_START, Settings, get_settings
from .graph import (
    build_graph,
    count_checkpoints,
    initial_state,
    make_runtime,
    open_checkpointer,
)
from .llm import LLM
from .models import (
    ApprovalDecision,
    ApprovalStatus,
    BudgetBurn,
    CreateRunRequest,
    Goal,
    Plan,
    PurchaseOrder,
    Quote,
    RunSnapshot,
    RunStatus,
    ScheduleResult,
    TakeoffResult,
    TimelineEvent,
    VendorAttempt,
    VendorOption,
    WorkerInfo,
)
from .specialists._data import load_scenario
from .store import Store, pid_alive, utcnow

ACTIVE = {"running", "created"}


class RunError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def get_store(settings: Settings | None = None) -> Store:
    settings = settings or get_settings()
    return Store(settings.db_path)


def graph_config(run_id: str) -> dict[str, Any]:
    return {"configurable": {"thread_id": run_id}, "recursion_limit": 2000}


# --------------------------------------------------------------------------- worker


def _pending_interrupt(snap: Any) -> dict[str, Any] | None:
    intr = list(getattr(snap, "interrupts", ()) or ())
    if not intr:
        for t in getattr(snap, "tasks", ()) or ():
            intr.extend(getattr(t, "interrupts", ()) or ())
    if not intr:
        return None
    val = getattr(intr[0], "value", None)
    return val if isinstance(val, dict) else {"value": val}


def _decision_for(store: Store, approval_id: str | None) -> dict[str, Any] | None:
    if not approval_id:
        return None
    appr = store.get_approval(approval_id)
    if appr is None or appr.status == ApprovalStatus.pending:
        return None
    return {
        "decision": "approve" if appr.status == ApprovalStatus.approved else "reject",
        "option_id": appr.decided_option,
        "comment": appr.comment,
        "decided_by": appr.decided_by,
    }


def run_worker(run_id: str, resume_value: dict[str, Any] | None = None) -> str:
    """Run the graph for ``run_id`` until completion / human wait. Returns final status."""
    settings = get_settings()
    store = get_store(settings)
    run = store.get_run(run_id)
    if run is None:
        raise SystemExit(f"unknown run {run_id}")
    lock_path = settings.locks_dir / f"{run_id}.lock"
    lock = open(lock_path, "w")  # noqa: SIM115 - held for the life of the worker
    # A previous worker may still be exiting (e.g. just after interrupt()); wait for it.
    deadline = time.monotonic() + 60.0
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() > deadline:
                print(f"[worker] another worker holds {run_id}; exiting", flush=True)
                return run.status
            time.sleep(0.1)
    run = store.get_run(run_id) or run
    restarts = run.restarts
    store.update_run(
        run_id, pid=os.getpid(), status="running", worker_started_at=utcnow(), error=None
    )
    rt = make_runtime(run_id, store, settings)
    saver, conn = open_checkpointer(settings)
    try:
        graph = build_graph(rt, saver)
        cfg: Any = graph_config(run_id)
        snap = graph.get_state(cfg)
        inp: Any
        if not snap.values:
            inp = initial_state(rt, run.sim_start)
        else:
            pending = _pending_interrupt(snap)
            if pending is not None:
                decision = resume_value or _decision_for(store, pending.get("approval_id"))
                if decision is None:
                    store.update_run(run_id, status="waiting_human")
                    return "waiting_human"
                inp = Command(resume=decision)
            elif snap.next:
                inp = None
            else:
                store.update_run(run_id, status="completed")
                return "completed"
            if inp is None:  # mid-graph resume => previous worker died / was killed
                restarts += 1
                store.update_run(run_id, restarts=restarts)
                n = count_checkpoints(settings, run_id)
                store.add_timeline(
                    run_id,
                    TimelineEvent(
                        sim_time=store.get_run(run_id).sim_now,  # type: ignore[union-attr]
                        lane="system",
                        label=f"Worker pid {os.getpid()} resumed from checkpoint #{n}",
                        kind="success",
                    ),
                )
                store.add_audit(
                    run_id,
                    sim_time=store.get_run(run_id).sim_now,  # type: ignore[union-attr]
                    actor="system",
                    action="worker.resumed",
                    summary=f"Worker restarted (restart #{restarts}) and resumed from the "
                    f"latest LangGraph checkpoint ({n} persisted).",
                    outputs={"pid": os.getpid(), "checkpoints": n},
                )
        print(f"[worker {os.getpid()}] run {run_id} start ({type(inp).__name__})", flush=True)
        graph.invoke(inp, cfg, durability="sync")
        snap = graph.get_state(cfg)
        if _pending_interrupt(snap) is not None:
            store.update_run(run_id, status="waiting_human")
            status = "waiting_human"
        elif not snap.next:
            cur = store.get_run(run_id)
            status = cur.status if cur and cur.status in ("completed", "failed") else "completed"
            store.update_run(run_id, status=status)
        else:
            status = "running"
        print(f"[worker {os.getpid()}] run {run_id} -> {status}", flush=True)
        return status
    except Exception as exc:
        traceback.print_exc()
        store.update_run(run_id, status="failed", error=f"{type(exc).__name__}: {exc}"[:500])
        return "failed"
    finally:
        conn.close()
        with contextlib.suppress(OSError):
            fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


def spawn_worker(run_id: str, resume_value: dict[str, Any] | None = None) -> int:
    """Start a detached worker process; returns its pid (also stored on the run)."""
    settings = get_settings()
    store = get_store(settings)
    log = open(settings.logs_dir / f"{run_id}.log", "ab")  # noqa: SIM115
    cmd = [sys.executable, "-m", "sitemind.runner", run_id]
    if resume_value is not None:
        cmd += ["--resume-value", json.dumps(resume_value)]
    env = dict(os.environ)
    env["SITEMIND_DATA"] = str(settings.data_dir)
    backend_dir = str(Path(__file__).resolve().parent.parent)
    env["PYTHONPATH"] = backend_dir + os.pathsep + env.get("PYTHONPATH", "")
    proc = subprocess.Popen(
        cmd,
        stdout=log,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
        env=env,
        cwd=backend_dir,
    )
    log.close()
    store.update_run(run_id, pid=proc.pid, status="running", worker_started_at=utcnow())
    return proc.pid


# --------------------------------------------------------------------------- services


def new_run_id() -> str:
    return f"run-{datetime.now(IST):%Y%m%d-%H%M%S}-{secrets.token_hex(2)}"


def create_run(req: CreateRunRequest, *, spawn: bool = True) -> RunSnapshot:
    store = get_store()
    scenario = load_scenario(req.scenario)
    sim_start = datetime.fromisoformat(scenario.get("sim_start", SIM_START.isoformat()))
    ros = scenario.get("required_on_site")
    goal = Goal(
        text=req.goal_text,
        project=req.project,
        package=req.package,
        need_by=req.need_by,
        required_on_site=datetime.fromisoformat(ros).date() if ros else None,
        budget_inr=req.budget_inr,
    )
    run_id = new_run_id()
    store.create_run(run_id, goal, req.scenario, sim_start, req.step_delay_s)
    store.add_timeline(
        run_id,
        TimelineEvent(sim_time=sim_start, lane="system", label="Run created", kind="info"),
    )
    if req.auto_start and spawn:
        spawn_worker(run_id)
    return snapshot(run_id)


def kill_run(run_id: str) -> RunSnapshot:
    store = get_store()
    run = store.get_run(run_id)
    if run is None:
        raise RunError(404, "run not found")
    killed = False
    if run.pid and pid_alive(run.pid):
        with contextlib.suppress(ProcessLookupError):
            os.kill(run.pid, signal.SIGKILL)
            killed = True
        # reap if it is our child
        with contextlib.suppress(ChildProcessError, OSError):
            os.waitpid(run.pid, 0)
    if run.status in ("running", "created") or killed:
        store.update_run(run_id, status="killed", current_node=run.current_node)
        store.add_timeline(
            run_id,
            TimelineEvent(
                sim_time=run.sim_now,
                lane="system",
                label=f"Worker pid {run.pid} killed (SIGKILL) at {run.current_node or '-'}",
                kind="kill",
            ),
        )
        store.add_audit(
            run_id,
            sim_time=run.sim_now,
            actor="system",
            action="worker.killed",
            summary=f"Worker pid {run.pid} received SIGKILL while at {run.current_node}.",
            outputs={"pid": run.pid},
        )
    return snapshot(run_id)


def resume_run(run_id: str) -> RunSnapshot:
    store = get_store()
    run = store.get_run(run_id)
    if run is None:
        raise RunError(404, "run not found")
    if run.pid and pid_alive(run.pid) and run.status == "running":
        return snapshot(run_id)
    if run.status == "completed":
        return snapshot(run_id)
    spawn_worker(run_id)
    return snapshot(run_id)


def decide_approval(
    run_id: str, approval_id: str, decision: ApprovalDecision, *, spawn: bool = True
) -> RunSnapshot:
    store = get_store()
    run = store.get_run(run_id)
    if run is None:
        raise RunError(404, "run not found")
    appr = store.get_approval(approval_id)
    if appr is None or appr.run_id != run_id:
        raise RunError(404, "approval not found")
    if appr.status != ApprovalStatus.pending:
        raise RunError(409, f"approval already {appr.status.value}")
    if decision.option_id and appr.options and decision.option_id not in appr.options:
        raise RunError(422, f"option {decision.option_id} not in {appr.options}")
    approved = decision.decision == "approve"
    option = decision.option_id or (appr.memo.recommendation if appr.memo else None)
    store.upsert_approval(
        appr.model_copy(
            update={
                "status": ApprovalStatus.approved if approved else ApprovalStatus.rejected,
                "decided_option": option,
                "decided_by": decision.decided_by,
                "comment": decision.comment,
            }
        )
    )
    value = {
        "decision": decision.decision,
        "option_id": option,
        "comment": decision.comment,
        "decided_by": decision.decided_by,
    }
    if spawn and not (run.pid and pid_alive(run.pid) and run.status == "running"):
        spawn_worker(run_id, value)
    return snapshot(run_id)


# --------------------------------------------------------------------------- snapshot


def _check_dead_worker(store: Store, run_id: str) -> None:
    run = store.get_run(run_id)
    if run is None or run.status not in ACTIVE or run.pid is None:
        return
    if pid_alive(run.pid):
        return
    if store.set_status_if(run_id, {"running"}, "killed"):
        store.add_timeline(
            run_id,
            TimelineEvent(
                sim_time=run.sim_now,
                lane="system",
                label=f"Worker pid {run.pid} died unexpectedly",
                kind="kill",
            ),
        )


def snapshot(run_id: str, *, light: bool = False) -> RunSnapshot:
    settings = get_settings()
    store = get_store(settings)
    _check_dead_worker(store, run_id)
    run = store.get_run(run_id)
    if run is None:
        raise RunError(404, "run not found")
    proj = store.load_projection(run_id)

    def opt(model: Any, key: str) -> Any:
        v = proj.get(key)
        return model.model_validate(v) if v else None

    budget = BudgetBurn(
        budget_inr=run.goal.budget_inr,
        committed_inr=float(proj.get("committed_inr", 0.0) or 0.0),
        forecast_inr=float(proj.get("forecast_inr", 0.0) or 0.0),
        spent_process_inr=float(proj.get("process_cost_inr", 0.0) or 0.0),
        points=list(proj.get("budget_points", [])),
    )
    llm: dict[str, Any] = LLM(settings).describe()
    llm.update(store.llm_stats(run_id))
    return RunSnapshot(
        run_id=run.run_id,
        goal=run.goal,
        status=RunStatus(run.status),
        sim_now=run.sim_now,
        sim_start=run.sim_start,
        plan=opt(Plan, "plan"),
        plan_history=[]
        if light
        else [Plan.model_validate(p) for p in proj.get("plan_history", [])],
        takeoff=opt(TakeoffResult, "takeoff"),
        quotes=[Quote.model_validate(q) for q in proj.get("quotes", [])],
        vendor_attempts=[VendorAttempt.model_validate(a) for a in proj.get("vendor_attempts", [])],
        options=[VendorOption.model_validate(o) for o in proj.get("options", [])],
        schedule=opt(ScheduleResult, "schedule"),
        budget=budget,
        approvals=store.list_approvals(run_id),
        po=opt(PurchaseOrder, "po"),
        audit=[] if light else store.list_audit(run_id),
        ledger=[] if light else store.list_ledger(run_id),
        timeline=[] if light else store.list_timeline(run_id),
        worker=WorkerInfo(
            pid=run.pid,
            alive=pid_alive(run.pid),
            started_at=run.worker_started_at,
            restarts=run.restarts,
        ),
        checkpoints=count_checkpoints(settings, run_id),
        current_node=run.current_node,
        llm=llm,
        error=run.error,
    )


def list_snapshots() -> list[RunSnapshot]:
    store = get_store()
    return [snapshot(r.run_id, light=True) for r in store.list_runs()]


# --------------------------------------------------------------------------- CLI


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m sitemind.runner")
    ap.add_argument("run_id")
    ap.add_argument("--resume-value", default=None, help="JSON approval decision")
    args = ap.parse_args(argv)
    value = json.loads(args.resume_value) if args.resume_value else None
    status = run_worker(args.run_id, value)
    return 0 if status != "failed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
