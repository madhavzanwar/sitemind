"""Deterministic simulated clock, persisted per run in the app DB.

The procurement story spans weeks of *simulated* time while the demo runs in about a
minute of wall time. The graph derives every new sim time from the checkpointed state
(``set``), so replaying a node after a crash lands on exactly the same instant.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from .store import Store


class SimClock:
    def __init__(self, store: Store, run_id: str) -> None:
        self.store = store
        self.run_id = run_id

    def now(self) -> datetime:
        run = self.store.get_run(self.run_id)
        if run is None:
            raise KeyError(f"unknown run {self.run_id}")
        return run.sim_now

    def set(self, when: datetime) -> datetime:
        if when.tzinfo is None:
            raise ValueError("SimClock requires timezone-aware datetimes")
        self.store.update_run(self.run_id, sim_now=when)
        return when

    def advance(self, *, days: float = 0.0, hours: float = 0.0) -> datetime:
        if days < 0 or hours < 0:
            raise ValueError("SimClock only moves forward")
        return self.set(self.now() + timedelta(days=days, hours=hours))


def plus(when: datetime, *, days: float = 0.0, hours: float = 0.0) -> datetime:
    """Pure helper: ``when`` advanced by a duration (no persistence)."""
    return when + timedelta(days=days, hours=hours)
