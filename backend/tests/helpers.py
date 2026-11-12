"""Test helpers shared by graph / API / durability tests."""

from __future__ import annotations

import time
from collections.abc import Callable
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
            raise AssertionError(
                f"timeout waiting; status={snap.status} node={snap.current_node}"
            )
        time.sleep(poll)
