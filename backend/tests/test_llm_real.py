"""One end-to-end run against the REAL local model (Ollama qwen2.5:3b). Skipped if absent."""

from __future__ import annotations

import time

import httpx
import pytest
from helpers import demo_request
from test_graph import drive

from sitemind.runner import create_run, get_store, snapshot

pytestmark = pytest.mark.llm


def _ollama_up() -> bool:
    try:
        r = httpx.get("http://localhost:11434/api/tags", timeout=2)
        return r.status_code == 200 and any(
            m.get("name") == "qwen2.5:3b" for m in r.json().get("models", [])
        )
    except httpx.HTTPError:
        return False


@pytest.mark.skipif(not _ollama_up(), reason="ollama / qwen2.5:3b not reachable")
def test_real_llm_end_to_end(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SITEMIND_LLM_PROVIDER", "ollama")
    monkeypatch.setenv("SITEMIND_LLM_MODEL", "qwen2.5:3b")
    from sitemind.llm import LLM

    LLM().warmup()  # model load is not part of the measured agent run
    t0 = time.monotonic()
    rid = create_run(demo_request(), spawn=False).run_id
    drive(rid)
    wall = time.monotonic() - t0
    snap = snapshot(rid)
    assert snap.status.value == "completed"
    stats = get_store().llm_stats(rid)
    print(f"\nreal-LLM run: wall {wall:.1f}s, llm={stats}")
    assert stats["calls"] >= 3
    assert stats["calls"] - stats["fallbacks"] >= 1, "at least one live model answer"
    assert snap.plan is not None and snap.plan.rationale
