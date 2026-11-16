"""Test helpers shared by graph / API / durability tests."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any
from datetime import date

from sitemind.models import CreateRunRequest, RunSnapshot
from sitemind.runner import snapshot


def demo_request(scenario: str = "demo", delay: float | None = None) -> CreateRunRequest:
    return CreateRunRequest(
        goal_text="Get the 480 V switchgear package for Project Alpha ordered by 2027-03-15 "
        "within budget ₹4.6 Cr",
        need_by=date(2027, 3, 15),
        budget_inr=46_000_000,
        scenario=scenario,  # type: ignore[arg-type]
        step_delay_s=delay,
    )


def wait_for(
    run_id: str, pred: Callable[[RunSnapshot], bool], timeout: float = 60.0, poll: float = 0.05
) -> RunSnapshot:
    deadline = time.monotonic() + timeout
    while True:
        snap = snapshot(run_id)
        if pred(snap):
            return snap
        if snap.status.value == "failed":
            raise AssertionError(f"run failed: {snap.error}")
        if time.monotonic() > deadline:
            raise AssertionError(f"timeout waiting; status={snap.status} node={snap.current_node}")
        time.sleep(poll)


def drive_events(
    run_id: str,
    at_task: dict[str, list[Any]] | None = None,
    at_wait: dict[int, list[Any]] | None = None,
    decisions: list[Any] | None = None,
    max_rounds: int = 20,
) -> list[str]:
    """Run in-process; inject events when a task starts (by id prefix) or at the n-th
    human wait (1-based), auto-approving otherwise. Returns the statuses seen."""
    from sitemind.models import ApprovalDecision, ApprovalStatus
    from sitemind.runner import decide_approval, inject_event, run_worker

    pending_task = {k: list(v) for k, v in (at_task or {}).items()}
    queue = list(decisions or [])
    waits = 0
    seen: list[str] = []

    def on_step(task_id: str) -> None:
        for prefix in list(pending_task):
            if task_id.startswith(prefix):
                for req in pending_task.pop(prefix):
                    inject_event(run_id, req, spawn=False)

    for _ in range(max_rounds):
        status = run_worker(run_id, on_step=on_step)
        seen.append(status)
        if status != "waiting_human":
            return seen
        waits += 1
        reqs = (at_wait or {}).pop(waits, None)
        if reqs:
            for req in reqs:
                inject_event(run_id, req, spawn=False)
            continue  # the next worker wakes on the event instead of a decision
        snap = snapshot(run_id)
        appr = next(a for a in snap.approvals if a.status == ApprovalStatus.pending)
        d = queue.pop(0) if queue else ApprovalDecision(decision="approve")
        decide_approval(run_id, appr.id, d, spawn=False)
    raise AssertionError(f"run did not finish: {seen}")
