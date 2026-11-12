"""In-process graph runs (no subprocess): full demo / happy / rejection paths."""

from __future__ import annotations

from sitemind.models import ApprovalDecision, ApprovalStatus, TaskStatus
from sitemind.planner import task_action
from sitemind.runner import create_run, decide_approval, get_store, run_worker, snapshot

from helpers import demo_request


def drive(run_id: str, decisions: list[ApprovalDecision] | None = None) -> None:
    queue = list(decisions or [])
    for _ in range(10):
        status = run_worker(run_id)
        if status != "waiting_human":
            return
        snap = snapshot(run_id)
        pending = next(a for a in snap.approvals if a.status == ApprovalStatus.pending)
        d = queue.pop(0) if queue else ApprovalDecision(decision="approve")
        decide_approval(run_id, pending.id, d, spawn=False)


def test_demo_run_end_to_end() -> None:
    rid = create_run(demo_request(), spawn=False).run_id
    drive(rid)
    snap = snapshot(rid)
    assert snap.status.value == "completed"
    assert snap.plan is not None and snap.plan.version == 2
    assert len(snap.plan_history) == 2
    assert snap.po is not None and snap.po.status == "sent" and snap.po.vendor_id == "V3"
    rec = next(o for o in snap.options if o.recommended)
    assert rec.option_id == "O-V3X"
    actions = [a.action for a in snap.audit]
    for a in ("plan.created", "rfq.timeout", "quote.revised", "trigger.detected", "replan",
              "escalation", "approval.approved", "run.completed"):
        assert a in actions, a
    # timeline spans weeks of sim time and is sorted
    times = [e.sim_time for e in snap.timeline]
    assert times == sorted(times)
    assert (times[-1] - times[0]).days >= 25
    assert len(snap.budget.points) >= 5 and snap.budget.committed_inr > 0
    assert snap.budget.committed_inr <= snap.goal.budget_inr
    assert snap.schedule is not None and snap.schedule.meets_deadline
    store = get_store()
    assert len(store.list_outbox(rid, "po")) == 1
    rfqs = [(m["vendor_id"], m["payload"]["attempt"]) for m in store.list_outbox(rid, "rfq")]
    assert sorted(rfqs) == [("V1", 1), ("V1", 2), ("V1", 3), ("V2", 1), ("V3", 1)]
    assert snap.checkpoints > 20
    skipped = [t for t in snap.plan.tasks if t.status == TaskStatus.skipped]
    assert [task_action(t)[0] for t in skipped] == ["rank"]


def test_happy_run_no_replan() -> None:
    rid = create_run(demo_request("happy"), spawn=False).run_id
    drive(rid)
    snap = snapshot(rid)
    assert snap.status.value == "completed"
    assert snap.plan is not None and snap.plan.version == 1
    assert snap.po is not None and snap.po.vendor_id == "V2"


def test_rejection_triggers_replan_and_alternative() -> None:
    rid = create_run(demo_request(), spawn=False).run_id
    drive(rid, [ApprovalDecision(decision="reject", comment="Need a second option")])
    snap = snapshot(rid)
    assert snap.plan is not None and snap.plan.version == 3
    assert "approval_rejected" in " ".join(
        str(a.inputs) for a in snap.audit if a.action == "replan"
    )
    assert any(a.status == ApprovalStatus.rejected for a in snap.approvals)
    # O-V3X rejected -> no feasible option left; least-bad option still goes to the human
    assert snap.status.value == "completed"
    assert snap.po is not None and snap.po.status == "sent"
    assert "O-V3X" not in {o.option_id for o in snap.options}
