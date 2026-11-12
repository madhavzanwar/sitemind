from __future__ import annotations

import contextlib
import multiprocessing as mp
from datetime import date
from pathlib import Path

from sitemind.clock import SimClock
from sitemind.config import SIM_START
from sitemind.models import Goal, TimelineEvent
from sitemind.store import Store

GOAL = Goal(text="g", need_by=date(2027, 3, 15), budget_inr=46e6)


def _store(tmp: Path) -> Store:
    s = Store(tmp / "app.sqlite")
    s.create_run("r1", GOAL, "demo", SIM_START)
    return s


def test_perform_once_repeated(tmp_path: Path) -> None:
    s = _store(tmp_path)
    calls = []

    def fn() -> dict:
        calls.append(1)
        s.outbox_send(
            "r1",
            channel="po",
            vendor_id="V1",
            ref="PO-1",
            idempotency_key="k",
            payload={},
            sim_time=SIM_START,
        )
        return {"n": len(calls)}

    results = [s.perform_once("r1:T1:po:1", "po.sent", {}, fn) for _ in range(5)]
    assert results == [{"n": 1}] * 5
    assert len(calls) == 1
    led = s.list_ledger("r1")
    assert len(led) == 1 and led[0].executions == 5
    assert len(s.list_outbox("r1", "po")) == 1


def _worker(db: str, key: str, q: mp.Queue[dict]) -> None:
    st = Store(db)

    def fn() -> dict:
        import os
        import time

        time.sleep(0.3)  # widen the race window
        st.outbox_send(
            "r1",
            channel="rfq",
            vendor_id="V2",
            ref="RFQ",
            idempotency_key=key,
            payload={},
            sim_time=SIM_START,
        )
        return {"pid": os.getpid()}

    q.put(st.perform_once(key, "rfq.sent", {}, fn))


def test_perform_once_concurrent_processes(tmp_path: Path) -> None:
    s = _store(tmp_path)
    ctx = mp.get_context("spawn")
    q: mp.Queue[dict] = ctx.Queue()
    procs = [
        ctx.Process(target=_worker, args=(str(s.db_path), "r1:T2:rfq:V2:a1", q)) for _ in range(2)
    ]
    for p in procs:
        p.start()
    for p in procs:
        p.join(30)
    a, b = q.get(timeout=5), q.get(timeout=5)
    assert a == b  # both processes see the single execution's result
    assert len(s.list_outbox("r1", "rfq")) == 1
    assert s.list_ledger("r1")[0].executions == 2


def test_perform_once_failure_releases_claim(tmp_path: Path) -> None:
    s = _store(tmp_path)

    def boom() -> dict:
        raise RuntimeError("x")

    with contextlib.suppress(RuntimeError):
        s.perform_once("r1:k", "x", {}, boom)
    assert s.perform_once("r1:k", "x", {}, lambda: {"ok": True}) == {"ok": True}


def test_audit_and_timeline_dedupe(tmp_path: Path) -> None:
    s = _store(tmp_path)
    for _ in range(3):
        s.add_audit(
            "r1",
            sim_time=SIM_START,
            actor="planner",
            action="plan.created",
            summary="s",
            dedupe_key="r1:plan:1",
        )
        s.add_timeline(
            "r1",
            TimelineEvent(sim_time=SIM_START, lane="planner", label="x"),
            dedupe_key="r1:plan:2",
        )
    assert len(s.list_audit("r1")) == 1
    assert len(s.list_timeline("r1")) == 1


def test_sim_clock(tmp_path: Path) -> None:
    s = _store(tmp_path)
    c = SimClock(s, "r1")
    assert c.now() == SIM_START
    c.advance(days=2, hours=3)
    assert (c.now() - SIM_START).total_seconds() == (2 * 24 + 3) * 3600
    assert SimClock(s, "r1").now() == c.now()  # persisted
    c.set(SIM_START)
    assert c.now() == SIM_START
    try:
        c.advance(days=-1)
        raise AssertionError("must not go backwards")
    except ValueError:
        pass
