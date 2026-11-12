"""kill -9 the worker mid-run (twice), resume, approve via the REST API, verify exactly-once.

Real OS processes: the worker is ``python -m sitemind.runner`` spawned exactly like the API
does; the kill is a real SIGKILL.
"""

from __future__ import annotations

from collections import Counter

from fastapi.testclient import TestClient
from helpers import demo_request, wait_for

from sitemind.api import app
from sitemind.models import ApprovalStatus, RunSnapshot, TaskStatus
from sitemind.planner import task_action
from sitemind.runner import get_store
from sitemind.store import pid_alive


def store_refreshes(rid: str) -> list[str]:
    return sorted(m["ref"] for m in get_store().list_outbox(rid, "refresh"))


def _done(snap: RunSnapshot, action: str) -> bool:
    return snap.plan is not None and any(
        task_action(t)[0] == action and t.status == TaskStatus.done for t in snap.plan.tasks
    )


def _pending_approval(snap: RunSnapshot) -> bool:
    return snap.status.value == "waiting_human" and any(
        a.status == ApprovalStatus.pending for a in snap.approvals
    )


def test_kill_resume_exactly_once() -> None:
    client = TestClient(app)
    r = client.post("/api/runs", json=demo_request(delay=0.4).model_dump(mode="json"))
    assert r.status_code == 200
    rid = r.json()["run_id"]

    # 1) mid-run: quotes collected; kill INSIDE the bid-levelling node after its vendor
    #    refresh requests were sent (ledgered) but before the node's checkpoint was written.
    snap = wait_for(
        rid, lambda s: (s.current_node or "").startswith("execute:T3-levelling:pacing"), 60
    )
    assert not snap.approvals
    sent_before = store_refreshes(rid)
    assert len(sent_before) == 3
    pid1 = snap.worker.pid
    assert pid1 and pid_alive(pid1)
    killed = RunSnapshot.model_validate(client.post(f"/api/runs/{rid}/kill").json())
    assert killed.status.value == "killed"
    assert not pid_alive(pid1)
    assert any(e.kind == "kill" for e in killed.timeline)
    cp_at_kill = killed.checkpoints
    assert cp_at_kill > 0

    # 2) resume -> new worker continues from the checkpoint and reaches the vendor approval
    client.post(f"/api/runs/{rid}/resume")
    snap = wait_for(rid, _pending_approval, timeout=90)
    assert snap.worker.pid != pid1
    assert snap.worker.restarts >= 1
    appr = next(a for a in snap.approvals if a.status == ApprovalStatus.pending)
    assert appr.kind == "vendor_selection" and appr.memo is not None
    rec = appr.memo.recommendation
    r = client.post(
        f"/api/runs/{rid}/approvals/{appr.id}",
        json={"decision": "approve", "option_id": rec, "comment": "go"},
    )
    assert r.status_code == 200
    # double-submit is rejected (409) - the decision is recorded exactly once
    r2 = client.post(f"/api/runs/{rid}/approvals/{appr.id}", json={"decision": "approve"})
    assert r2.status_code == 409

    # 3) kill again right after the approval-resume worker starts drafting the PO
    snap = wait_for(rid, lambda s: _done(s, "approve-vendor") or _pending_approval(s), 60)
    if snap.status.value == "running":
        client.post(f"/api/runs/{rid}/kill")
        client.post(f"/api/runs/{rid}/resume")

    snap = wait_for(rid, _pending_approval, timeout=90)
    po_appr = next(a for a in snap.approvals if a.status == ApprovalStatus.pending)
    assert po_appr.kind == "po_release" and po_appr.po is not None
    client.post(f"/api/runs/{rid}/approvals/{po_appr.id}", json={"decision": "approve"})
    snap = wait_for(rid, lambda s: s.status.value == "completed", timeout=90)

    # ---------------------------------------------------------------- exactly-once checks
    store = get_store()
    assert len(store.list_outbox(rid, "po")) == 1, "exactly one PO transmitted"
    rfq = Counter((m["vendor_id"], m["payload"]["attempt"]) for m in store.list_outbox(rid, "rfq"))
    assert all(n == 1 for n in rfq.values()), f"duplicate RFQs: {rfq}"
    assert set(rfq) == {("V1", 1), ("V1", 2), ("V1", 3), ("V2", 1), ("V3", 1)}
    assert store_refreshes(rid) == sent_before, "refresh requests were not re-sent on resume"
    refresh_rows = [e for e in store.list_ledger(rid) if e.kind == "quote.refresh"]
    assert len(refresh_rows) == 3
    assert all(e.executions >= 2 for e in refresh_rows), "replayed node reused stored results"
    for ch in ("refresh", "negotiate", "expedite", "email"):
        msgs = Counter(m["ref"] for m in store.list_outbox(rid, ch))
        assert all(n == 1 for n in msgs.values()), (ch, msgs)
    ledger = store.list_ledger(rid)
    keys = [e.idempotency_key for e in ledger]
    assert len(keys) == len(set(keys))
    assert any(e.executions > 1 for e in ledger), "a resumed node reused a stored result"
    snap = RunSnapshot.model_validate(client.get(f"/api/runs/{rid}").json())
    assert snap.status.value == "completed"
    assert snap.plan is not None and snap.plan.version >= 2
    actions = {a.action for a in snap.audit}
    assert {"replan", "escalation", "worker.killed", "worker.resumed"} <= actions
    assert snap.po is not None and snap.po.status == "sent"
    assert snap.worker.restarts >= 1
    assert snap.checkpoints > cp_at_kill
    # no duplicated audit entries from replays
    audit_keys = Counter((a.action, a.task_id, a.summary) for a in snap.audit)
    assert all(n == 1 for k, n in audit_keys.items() if k[0] != "worker.killed"), audit_keys
    md = client.get(f"/api/runs/{rid}/po.md")
    assert md.status_code == 200 and snap.po.po_number in md.text
