"""SQLite application store: runs, audit, idempotent action ledger, approvals, timeline.

Safe for several processes (API + worker): every operation opens its own connection in
WAL mode with a busy timeout, and writes that must be atomic use ``BEGIN IMMEDIATE``.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .models import (
    ApprovalRequest,
    AuditEntry,
    Goal,
    LedgerEntry,
    TimelineEvent,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    scenario TEXT NOT NULL,
    status TEXT NOT NULL,
    pid INTEGER,
    restarts INTEGER NOT NULL DEFAULT 0,
    worker_started_at TEXT,
    sim_now TEXT NOT NULL,
    sim_start TEXT NOT NULL,
    current_node TEXT,
    error TEXT,
    step_delay REAL,
    created TEXT NOT NULL,
    updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    dedupe_key TEXT UNIQUE,
    sim_time TEXT NOT NULL,
    wall_time TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    summary TEXT NOT NULL,
    inputs TEXT NOT NULL DEFAULT '{}',
    outputs TEXT NOT NULL DEFAULT '{}',
    cost_inr REAL NOT NULL DEFAULT 0,
    llm_tokens INTEGER NOT NULL DEFAULT 0,
    confidence REAL,
    task_id TEXT,
    plan_version INTEGER
);
CREATE INDEX IF NOT EXISTS audit_run ON audit(run_id, seq);
CREATE TABLE IF NOT EXISTS ledger (
    idempotency_key TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    owner_pid INTEGER,
    payload TEXT NOT NULL DEFAULT '{}',
    result TEXT NOT NULL DEFAULT '{}',
    sim_time TEXT NOT NULL,
    wall_time TEXT NOT NULL,
    executions INTEGER NOT NULL DEFAULT 1,
    seq INTEGER
);
CREATE INDEX IF NOT EXISTS ledger_run ON ledger(run_id);
CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL,
    data TEXT NOT NULL,
    created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_run ON approvals(run_id);
CREATE TABLE IF NOT EXISTS timeline (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    dedupe_key TEXT UNIQUE,
    sim_time TEXT NOT NULL,
    lane TEXT NOT NULL,
    label TEXT NOT NULL,
    kind TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS timeline_run ON timeline(run_id, id);
CREATE TABLE IF NOT EXISTS snapshot (
    run_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    vendor_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    sim_time TEXT NOT NULL,
    wall_time TEXT NOT NULL,
    sender_pid INTEGER
);
CREATE INDEX IF NOT EXISTS outbox_run ON outbox(run_id);
"""


def utcnow() -> datetime:
    return datetime.now(UTC)


def _dump(obj: Any) -> str:
    return json.dumps(obj, default=_json_default, ensure_ascii=False)


def _json_default(o: Any) -> Any:
    if hasattr(o, "model_dump"):
        return o.model_dump(mode="json")
    if hasattr(o, "isoformat"):
        return o.isoformat()
    if isinstance(o, set):
        return sorted(o)
    raise TypeError(f"not JSON serialisable: {type(o).__name__}")


def _iso(dt: datetime | None) -> str:
    return (dt or utcnow()).isoformat()


def pid_alive(pid: int | None) -> bool:
    """True if ``pid`` is a live (non-zombie) process."""
    if not pid or pid <= 0:
        return False
    try:
        # Reap it if it is our own exited child (API spawns workers).
        done, _ = os.waitpid(pid, os.WNOHANG)
        if done == pid:
            return False
    except ChildProcessError:
        pass
    except OSError:
        pass
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        state = stat.rsplit(")", 1)[1].split()[0]
        if state in ("Z", "X"):
            return False
    except (OSError, IndexError):
        pass
    return True


@dataclass
class RunRow:
    run_id: str
    goal: Goal
    scenario: str
    status: str
    pid: int | None
    restarts: int
    worker_started_at: datetime | None
    sim_now: datetime
    sim_start: datetime
    current_node: str | None
    error: str | None
    step_delay: float | None
    created: datetime
    updated: datetime


class Store:
    """Thin, process-safe wrapper around the app SQLite database."""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as c:
            c.executescript(SCHEMA)

    # ------------------------------------------------------------------ plumbing
    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        c = sqlite3.connect(self.db_path, timeout=60.0, isolation_level=None)
        c.row_factory = sqlite3.Row
        try:
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA busy_timeout=60000")
            c.execute("PRAGMA synchronous=NORMAL")
            yield c
        finally:
            c.close()

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                yield c
            except BaseException:
                c.execute("ROLLBACK")
                raise
            else:
                c.execute("COMMIT")

    # ------------------------------------------------------------------ runs
    def create_run(
        self,
        run_id: str,
        goal: Goal,
        scenario: str,
        sim_start: datetime,
        step_delay: float | None = None,
    ) -> RunRow:
        now = _iso(None)
        with self._tx() as c:
            c.execute(
                "INSERT INTO runs(run_id, goal, scenario, status, sim_now, sim_start, step_delay,"
                " created, updated) VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    run_id,
                    goal.model_dump_json(),
                    scenario,
                    "created",
                    sim_start.isoformat(),
                    sim_start.isoformat(),
                    step_delay,
                    now,
                    now,
                ),
            )
        row = self.get_run(run_id)
        assert row is not None
        return row

    @staticmethod
    def _run_from_row(r: sqlite3.Row) -> RunRow:
        return RunRow(
            run_id=r["run_id"],
            goal=Goal.model_validate_json(r["goal"]),
            scenario=r["scenario"],
            status=r["status"],
            pid=r["pid"],
            restarts=r["restarts"],
            worker_started_at=(
                datetime.fromisoformat(r["worker_started_at"]) if r["worker_started_at"] else None
            ),
            sim_now=datetime.fromisoformat(r["sim_now"]),
            sim_start=datetime.fromisoformat(r["sim_start"]),
            current_node=r["current_node"],
            error=r["error"],
            step_delay=r["step_delay"],
            created=datetime.fromisoformat(r["created"]),
            updated=datetime.fromisoformat(r["updated"]),
        )

    def get_run(self, run_id: str) -> RunRow | None:
        with self._conn() as c:
            r = c.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
        return self._run_from_row(r) if r else None

    def list_runs(self) -> list[RunRow]:
        with self._conn() as c:
            rows = c.execute("SELECT * FROM runs ORDER BY created DESC").fetchall()
        return [self._run_from_row(r) for r in rows]

    _RUN_FIELDS = frozenset(
        {
            "status",
            "pid",
            "restarts",
            "worker_started_at",
            "sim_now",
            "current_node",
            "error",
            "step_delay",
        }
    )

    def update_run(self, run_id: str, **fields: Any) -> None:
        bad = set(fields) - self._RUN_FIELDS
        if bad:
            raise ValueError(f"unknown run fields: {bad}")
        if not fields:
            return
        vals = [v.isoformat() if isinstance(v, datetime) else v for v in fields.values()]
        cols = ", ".join(f"{k}=?" for k in fields)
        with self._tx() as c:
            c.execute(
                f"UPDATE runs SET {cols}, updated=? WHERE run_id=?",
                (*vals, _iso(None), run_id),
            )

    def set_status_if(self, run_id: str, expected: set[str], status: str, **fields: Any) -> bool:
        """Compare-and-set run status (used for dead-worker detection)."""
        with self._tx() as c:
            r = c.execute("SELECT status FROM runs WHERE run_id=?", (run_id,)).fetchone()
            if not r or r["status"] not in expected:
                return False
            extra = "".join(f", {k}=?" for k in fields)
            c.execute(
                f"UPDATE runs SET status=?{extra}, updated=? WHERE run_id=?",
                (status, *fields.values(), _iso(None), run_id),
            )
            return True

    # ------------------------------------------------------------------ audit
    def add_audit(
        self,
        run_id: str,
        *,
        sim_time: datetime,
        actor: str,
        action: str,
        summary: str,
        inputs: dict[str, Any] | None = None,
        outputs: dict[str, Any] | None = None,
        cost_inr: float = 0.0,
        llm_tokens: int = 0,
        confidence: float | None = None,
        task_id: str | None = None,
        plan_version: int | None = None,
        dedupe_key: str | None = None,
    ) -> bool:
        """Append an audit entry. With ``dedupe_key`` a replayed write is ignored."""
        with self._tx() as c:
            cur = c.execute(
                "INSERT OR IGNORE INTO audit(run_id, dedupe_key, sim_time, wall_time, actor, action,"
                " summary, inputs, outputs, cost_inr, llm_tokens, confidence, task_id, plan_version)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    run_id,
                    dedupe_key,
                    sim_time.isoformat(),
                    _iso(None),
                    actor,
                    action,
                    summary,
                    _dump(inputs or {}),
                    _dump(outputs or {}),
                    cost_inr,
                    llm_tokens,
                    confidence,
                    task_id,
                    plan_version,
                ),
            )
            return cur.rowcount > 0

    def list_audit(self, run_id: str, limit: int | None = None) -> list[AuditEntry]:
        q = "SELECT * FROM audit WHERE run_id=? ORDER BY seq"
        params: tuple[Any, ...] = (run_id,)
        if limit is not None:
            q = (
                "SELECT * FROM (SELECT * FROM audit WHERE run_id=? ORDER BY seq DESC LIMIT ?)"
                " ORDER BY seq"
            )
            params = (run_id, limit)
        with self._conn() as c:
            rows = c.execute(q, params).fetchall()
        return [
            AuditEntry(
                seq=r["seq"],
                run_id=r["run_id"],
                sim_time=datetime.fromisoformat(r["sim_time"]),
                wall_time=datetime.fromisoformat(r["wall_time"]),
                actor=r["actor"],
                action=r["action"],
                summary=r["summary"],
                inputs=json.loads(r["inputs"]),
                outputs=json.loads(r["outputs"]),
                cost_inr=r["cost_inr"],
                llm_tokens=r["llm_tokens"],
                confidence=r["confidence"],
                task_id=r["task_id"],
                plan_version=r["plan_version"],
            )
            for r in rows
        ]

    def audit_cost(self, run_id: str) -> float:
        with self._conn() as c:
            r = c.execute(
                "SELECT COALESCE(SUM(cost_inr),0) AS s FROM audit WHERE run_id=?", (run_id,)
            ).fetchone()
        return float(r["s"])

    # ------------------------------------------------------------------ timeline
    def add_timeline(
        self, run_id: str, event: TimelineEvent, dedupe_key: str | None = None
    ) -> bool:
        with self._tx() as c:
            cur = c.execute(
                "INSERT OR IGNORE INTO timeline(run_id, dedupe_key, sim_time, lane, label, kind)"
                " VALUES (?,?,?,?,?,?)",
                (
                    run_id,
                    dedupe_key,
                    event.sim_time.isoformat(),
                    event.lane,
                    event.label,
                    event.kind,
                ),
            )
            return cur.rowcount > 0

    def list_timeline(self, run_id: str) -> list[TimelineEvent]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT * FROM timeline WHERE run_id=? ORDER BY id", (run_id,)
            ).fetchall()
        return [
            TimelineEvent(
                sim_time=datetime.fromisoformat(r["sim_time"]),
                lane=r["lane"],
                label=r["label"],
                kind=r["kind"],
            )
            for r in rows
        ]

    # ------------------------------------------------------------------ ledger
    def perform_once(
        self,
        key: str,
        kind: str,
        payload: dict[str, Any],
        fn: Callable[[], dict[str, Any]],
        *,
        run_id: str | None = None,
        sim_time: datetime | None = None,
        poll_s: float = 0.05,
    ) -> dict[str, Any]:
        """Execute ``fn`` at most once per ``key`` and return its (stored) result.

        * key already ``done``  -> bump ``executions`` and return the stored result.
        * key claimed by a live process -> wait for it to finish, then return its result.
        * key claimed by a dead process (killed mid-call) -> take over and execute.
        * otherwise claim it, run ``fn`` outside the write lock, store the result.
        """
        run_id = run_id or key.split(":", 1)[0]
        me = os.getpid()
        while True:
            claim = False
            with self._tx() as c:
                r = c.execute(
                    "SELECT status, owner_pid, result FROM ledger WHERE idempotency_key=?",
                    (key,),
                ).fetchone()
                if r is None:
                    seq = c.execute(
                        "SELECT COALESCE(MAX(seq),0)+1 FROM ledger WHERE run_id=?", (run_id,)
                    ).fetchone()[0]
                    c.execute(
                        "INSERT INTO ledger(idempotency_key, run_id, kind, status, owner_pid,"
                        " payload, sim_time, wall_time, executions, seq)"
                        " VALUES (?,?,?,?,?,?,?,?,1,?)",
                        (
                            key,
                            run_id,
                            kind,
                            "pending",
                            me,
                            _dump(payload),
                            _iso(sim_time),
                            _iso(None),
                            seq,
                        ),
                    )
                    claim = True
                elif r["status"] == "done":
                    c.execute(
                        "UPDATE ledger SET executions=executions+1 WHERE idempotency_key=?",
                        (key,),
                    )
                    return dict(json.loads(r["result"]))
                elif r["owner_pid"] == me or not pid_alive(r["owner_pid"]):
                    c.execute(
                        "UPDATE ledger SET owner_pid=?, executions=executions+1"
                        " WHERE idempotency_key=?",
                        (me, key),
                    )
                    claim = True
            if claim:
                try:
                    result = fn()
                except BaseException:
                    with self._tx() as c:
                        c.execute(
                            "DELETE FROM ledger WHERE idempotency_key=? AND status='pending'"
                            " AND owner_pid=?",
                            (key, me),
                        )
                    raise
                with self._tx() as c:
                    c.execute(
                        "UPDATE ledger SET status='done', result=?, wall_time=? "
                        "WHERE idempotency_key=?",
                        (_dump(result), _iso(None), key),
                    )
                return json.loads(_dump(result))
            time.sleep(poll_s)

    def get_ledger(self, key: str) -> LedgerEntry | None:
        with self._conn() as c:
            r = c.execute(
                "SELECT * FROM ledger WHERE idempotency_key=? AND status='done'", (key,)
            ).fetchone()
        return self._ledger_from_row(r) if r else None

    @staticmethod
    def _ledger_from_row(r: sqlite3.Row) -> LedgerEntry:
        return LedgerEntry(
            idempotency_key=r["idempotency_key"],
            run_id=r["run_id"],
            kind=r["kind"],
            payload=json.loads(r["payload"]),
            result=json.loads(r["result"]),
            sim_time=datetime.fromisoformat(r["sim_time"]),
            wall_time=datetime.fromisoformat(r["wall_time"]),
            executions=r["executions"],
        )

    def list_ledger(self, run_id: str, limit: int | None = None) -> list[LedgerEntry]:
        q = "SELECT * FROM ledger WHERE run_id=? AND status='done' ORDER BY seq"
        params: tuple[Any, ...] = (run_id,)
        if limit is not None:
            q += " LIMIT ?"
            params = (run_id, limit)
        with self._conn() as c:
            rows = c.execute(q, params).fetchall()
        return [self._ledger_from_row(r) for r in rows]

    def llm_stats(self, run_id: str) -> dict[str, Any]:
        """Aggregate LLM usage from the ledger (one row per *executed* call)."""
        stats: dict[str, Any] = {
            "calls": 0,
            "fallbacks": 0,
            "tokens": 0,
            "latency_ms": 0,
            "replayed": 0,
        }
        with self._conn() as c:
            rows = c.execute(
                "SELECT result, executions FROM ledger WHERE run_id=? AND kind='llm.call'"
                " AND status='done'",
                (run_id,),
            ).fetchall()
        for r in rows:
            res = json.loads(r["result"])
            stats["calls"] += 1
            stats["replayed"] += max(0, int(r["executions"]) - 1)
            if res.get("provider") == "fallback":
                stats["fallbacks"] += 1
            stats["tokens"] += int(res.get("tokens", 0))
            stats["latency_ms"] += int(res.get("latency_ms", 0))
        return stats

    # ------------------------------------------------------------------ approvals
    def upsert_approval(self, req: ApprovalRequest) -> None:
        with self._tx() as c:
            c.execute(
                "INSERT INTO approvals(id, run_id, status, data, created) VALUES (?,?,?,?,?)"
                " ON CONFLICT(id) DO UPDATE SET status=excluded.status, data=excluded.data",
                (req.id, req.run_id, req.status.value, req.model_dump_json(), _iso(None)),
            )

    def get_approval(self, approval_id: str) -> ApprovalRequest | None:
        with self._conn() as c:
            r = c.execute("SELECT data FROM approvals WHERE id=?", (approval_id,)).fetchone()
        return ApprovalRequest.model_validate_json(r["data"]) if r else None

    def list_approvals(self, run_id: str) -> list[ApprovalRequest]:
        with self._conn() as c:
            rows = c.execute(
                "SELECT data FROM approvals WHERE run_id=? ORDER BY created", (run_id,)
            ).fetchall()
        return [ApprovalRequest.model_validate_json(r["data"]) for r in rows]

    # ------------------------------------------------------------------ snapshot projection
    def save_projection(self, run_id: str, data: dict[str, Any]) -> None:
        with self._tx() as c:
            c.execute(
                "INSERT INTO snapshot(run_id, data, updated) VALUES (?,?,?)"
                " ON CONFLICT(run_id) DO UPDATE SET data=excluded.data, updated=excluded.updated",
                (run_id, _dump(data), _iso(None)),
            )

    def load_projection(self, run_id: str) -> dict[str, Any]:
        with self._conn() as c:
            r = c.execute("SELECT data FROM snapshot WHERE run_id=?", (run_id,)).fetchone()
        return dict(json.loads(r["data"])) if r else {}

    # ------------------------------------------------------------------ mock vendor outbox
    def outbox_send(
        self,
        run_id: str,
        *,
        channel: str,
        vendor_id: str,
        ref: str,
        idempotency_key: str,
        payload: dict[str, Any],
        sim_time: datetime,
    ) -> int:
        """Record a message actually 'delivered' to a vendor (RFQ, PO...)."""
        with self._tx() as c:
            cur = c.execute(
                "INSERT INTO outbox(run_id, channel, vendor_id, ref, idempotency_key, payload,"
                " sim_time, wall_time, sender_pid) VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    run_id,
                    channel,
                    vendor_id,
                    ref,
                    idempotency_key,
                    _dump(payload),
                    sim_time.isoformat(),
                    _iso(None),
                    os.getpid(),
                ),
            )
            return int(cur.lastrowid or 0)

    def list_outbox(self, run_id: str, channel: str | None = None) -> list[dict[str, Any]]:
        q = "SELECT * FROM outbox WHERE run_id=?"
        params: tuple[Any, ...] = (run_id,)
        if channel:
            q += " AND channel=?"
            params = (run_id, channel)
        with self._conn() as c:
            rows = c.execute(q + " ORDER BY id", params).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["payload"] = json.loads(d["payload"])
            out.append(d)
        return out
