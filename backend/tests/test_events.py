"""Live events (CONTRACT_V2): every event type injected into a running run reacts for real,
re-plans through the trigger machinery and never duplicates an external message."""

from __future__ import annotations

from collections import Counter

from helpers import demo_request, drive_events

from sitemind.models import ApprovalStatus, EventType, InjectEventRequest, RunSnapshot, TaskStatus
from sitemind.planner import task_action
from sitemind.runner import create_run, get_store, inject_event, snapshot


def ev(t: str, vendor: str | None = None, **params: object) -> InjectEventRequest:
    return InjectEventRequest(type=EventType(t), vendor_id=vendor, params=params)


def new_run(scenario: str = "demo", package_id: str = "swgr-480v") -> str:
    req = demo_request(scenario).model_copy(update={"package_id": package_id})
    return create_run(req, spawn=False).run_id


def assert_no_duplicate_messages(rid: str) -> None:
    msgs = Counter((m["channel"], m["ref"]) for m in get_store().list_outbox(rid))
    dup = {k: n for k, n in msgs.items() if n > 1}
    assert not dup, dup
    assert len(get_store().list_outbox(rid, "po")) == 1


def actions(snap: RunSnapshot) -> list[str]:
    return [a.action for a in snap.audit]


def live_tasks(snap: RunSnapshot, action: str) -> list[str]:
    assert snap.plan is not None
    return [t.id for t in snap.plan.tasks if task_action(t)[0] == action]


def only_event(snap: RunSnapshot) -> object:
    assert len(snap.events) == 1
    e = snap.events[0]
    assert e.status == "applied" and e.outcome and e.applied_sim_time is not None
    return e


def test_price_change_after_evaluation_rechecks_and_reranks() -> None:
    rid = new_run()
    drive_events(rid, at_task={"T16-expedite": [ev("price_change", "V3", pct=12)]})
    snap = snapshot(rid)
    e = only_event(snap)
    assert e.triggers == ["price_change:V3:ev-1"]  # type: ignore[attr-defined]
    assert snap.status.value == "completed"
    assert snap.plan is not None and snap.plan.version >= 3
    rechecks = [t for t in snap.plan.tasks if t.note == "event re-evaluation"]
    assert [task_action(t) for t in rechecks] == [("budget", "V3")]
    v3 = next(q for q in snap.quotes if q.vendor_id == "V3")
    assert v3.revision == 2 and v3.status == "revised"
    assert {"event.injected", "event.applied", "replan"} <= set(actions(snap))
    assert any(t.lane == "human" and "ev-1" in t.label for t in snap.timeline)
    assert_no_duplicate_messages(rid)


def test_price_change_while_waiting_supersedes_and_reasks() -> None:
    rid = new_run()
    drive_events(rid, at_wait={1: [ev("price_change", "V3", pct=8)]})
    snap = snapshot(rid)
    sup = [a for a in snap.approvals if (a.decided_by or "").startswith("system: superseded")]
    assert len(sup) == 1 and sup[0].status == ApprovalStatus.rejected
    assert sup[0].decided_by == "system: superseded by ev-1"
    vendor_appr = [a for a in snap.approvals if a.kind == "vendor_selection"]
    assert len(vendor_appr) == 2 and vendor_appr[1].status == ApprovalStatus.approved
    assert vendor_appr[0].memo and vendor_appr[1].memo
    assert vendor_appr[0].memo.memo_id != vendor_appr[1].memo.memo_id  # fresh memo
    assert "approval.superseded" in actions(snap)
    assert snap.status.value == "completed" and snap.po is not None
    assert_no_duplicate_messages(rid)


def test_late_reply_before_rfq_close_becomes_chase_then_received() -> None:
    rid = new_run()
    drive_events(rid, at_task={"T1-takeoff": [ev("vendor_late_reply", "V2", days=9)]})
    snap = snapshot(rid)
    only_event(snap)
    assert "rfq.late" in actions(snap)
    chase = live_tasks(snap, "chase")
    assert chase, "late vendor must be chased"
    assert snap.plan is not None
    assert all(t.status == TaskStatus.done for t in snap.plan.tasks if t.id in chase)
    v2 = next(q for q in snap.quotes if q.vendor_id == "V2")
    assert v2.status != "timeout" and v2.lines  # reply landed during the chase
    assert snap.status.value == "completed"
    assert_no_duplicate_messages(rid)


def test_late_reply_after_rfq_delays_next_vendor_step() -> None:
    rid = new_run()
    drive_events(rid, at_task={"T7-budget": [ev("vendor_late_reply", "V2", days=3)]})
    snap = snapshot(rid)
    e = only_event(snap)
    assert "next reply" in (e.outcome or "")  # type: ignore[attr-defined]
    assert "vendor.late_reply" in actions(snap)  # negotiate-V2 waited for the reply
    assert snap.status.value == "completed"


def test_lead_time_slip_recomputes_cpm_and_replans() -> None:
    rid = new_run()
    drive_events(rid, at_task={"T17-rank": [ev("date_slip", "V3", days=30, target="lead_time")]})
    snap = snapshot(rid)
    e = only_event(snap)
    assert e.triggers == ["lead_slip:V3:ev-1"]  # type: ignore[attr-defined]
    v3 = next(q for q in snap.quotes if q.vendor_id == "V3")
    assert v3.lead_time_days == 168 + 30
    assert snap.plan is not None
    assert ("schedule", "V3") in [
        task_action(t) for t in snap.plan.tasks if t.note == "event re-evaluation"
    ]
    # V3X can no longer make the site date: the memo must not recommend it
    o = next(o for o in snap.options if o.option_id == "O-V3X")
    assert not o.meets_deadline and not o.recommended
    assert snap.status.value == "completed"


def test_required_on_site_moves_and_every_option_is_rescheduled() -> None:
    rid = new_run()
    drive_events(
        rid,
        at_wait={1: [ev("date_slip", None, days=30, target="required_on_site")]},
    )
    snap = snapshot(rid)
    e = only_event(snap)
    assert e.triggers == ["site_date:ALL:ev-1"]  # type: ignore[attr-defined]
    assert snap.plan is not None
    rescheduled = {task_action(t)[1] for t in snap.plan.tasks if t.note == "event re-evaluation"}
    assert rescheduled == {"V1", "V2", "V3"}
    assert snap.schedule is not None and str(snap.schedule.required_on_site) == "2027-08-29"
    assert any((a.decided_by or "").startswith("system: superseded") for a in snap.approvals)
    assert snap.status.value == "completed"


def test_document_missing_gates_po_release_until_received() -> None:
    rid = new_run()
    drive_events(rid, at_wait={1: [ev("document_missing", "V3", document="FAT report")]})
    snap = snapshot(rid)
    only_event(snap)
    docs = live_tasks(snap, "docs")
    assert docs == [d for d in docs if d.endswith("-docs-V3")] and docs
    assert snap.plan is not None
    appo = [
        t
        for t in snap.plan.tasks
        if task_action(t)[0] == "approve-po" and t.status == TaskStatus.done
    ]
    assert any(set(docs) & set(t.depends_on) for t in appo), "PO approval gated on the chase"
    assert len(get_store().list_outbox(rid, "doc-chase")) == 1
    assert "document.waived" not in actions(snap)  # injected doc was received on chase
    assert_no_duplicate_messages(rid)


def test_document_missing_at_po_approval_supersedes_it() -> None:
    rid = new_run()
    drive_events(rid, at_wait={2: [ev("document_missing", "V3", document="Type-test cert")]})
    snap = snapshot(rid)
    po_appr = [a for a in snap.approvals if a.kind == "po_release"]
    assert len(po_appr) == 2 and po_appr[0].status == ApprovalStatus.rejected
    assert snap.status.value == "completed"
    assert_no_duplicate_messages(rid)


def test_tool_failure_retries_with_backoff_then_recovers() -> None:
    rid = new_run()
    drive_events(rid, at_task={"T1-takeoff": [ev("tool_failure", None, tool="schedule", count=2)]})
    snap = snapshot(rid)
    only_event(snap)
    acts = actions(snap)
    assert acts.count("tool.failed") == 2 and "tool.recovered" in acts
    assert "tool.fallback" not in acts
    assert snap.status.value == "completed"


def test_tool_failure_exhausts_retries_and_falls_back() -> None:
    rid = new_run()
    drive_events(rid, at_task={"T1-takeoff": [ev("tool_failure", None, tool="budget", count=4)]})
    snap = snapshot(rid)
    acts = actions(snap)
    assert acts.count("tool.failed") == 4  # 3 on the first budget task, 1 on the next
    assert "tool.fallback" in acts
    assert any(m["ref"].startswith("TOOL-") for m in get_store().list_outbox(rid, "email"))
    assert snap.status.value == "completed"
    assert_no_duplicate_messages(rid)


def test_approver_unavailable_stretches_wait_and_sends_delegation() -> None:
    rid = new_run()
    drive_events(rid, at_wait={1: [ev("approver_unavailable", None, days=10)]})
    snap = snapshot(rid)
    only_event(snap)
    mails = [m for m in get_store().list_outbox(rid, "email") if m["ref"].startswith("DELEGATE")]
    assert len(mails) == 1
    vendor = next(a for a in snap.approvals if a.kind == "vendor_selection")
    assert vendor.status == ApprovalStatus.approved  # not superseded: still the same decision
    assert vendor.decided_at and (vendor.decided_at - vendor.requested_at).days >= 10
    assert snap.status.value == "completed"


def test_events_on_completed_run_are_ignored() -> None:
    rid = new_run("happy")
    drive_events(rid)
    snap = inject_event(rid, ev("price_change", "V2", pct=5), spawn=False)
    assert snap.events[-1].status == "ignored" and "completed" in (snap.events[-1].outcome or "")


def test_event_validation() -> None:
    import pytest

    from sitemind.runner import RunError

    rid = new_run()
    with pytest.raises(RunError):
        inject_event(rid, ev("price_change", None, pct=5), spawn=False)  # needs a vendor
    with pytest.raises(RunError):
        inject_event(rid, ev("price_change", "Z9", pct=5), spawn=False)  # unknown vendor


def test_replayed_event_application_is_idempotent() -> None:
    rid = new_run()
    drive_events(rid, at_task={"T16-expedite": [ev("price_change", "V3", pct=12)]})
    led = get_store().get_ledger(f"{rid}:event:ev-1:apply")
    assert led is not None and led.kind == "event.apply" and led.executions == 1
    refresh = [m for m in get_store().list_outbox(rid, "refresh") if "EVENT-EV-1" in m["ref"]]
    assert len(refresh) == 1


def test_dg_package_full_run() -> None:
    rid = new_run(package_id="dg-2mw")
    drive_events(rid)
    snap = snapshot(rid)
    assert snap.package_id == "dg-2mw"
    assert snap.status.value == "completed" and snap.po is not None
    assert snap.po.status == "sent" and snap.po.vendor_id.startswith("D")
    assert snap.plan is not None and snap.plan.version >= 2  # demo scenario forces a re-plan
    assert snap.goal.package == "2 MW DG sets"
    assert all("switchgear" not in t.title.lower() for t in snap.plan.tasks)
    assert_no_duplicate_messages(rid)
