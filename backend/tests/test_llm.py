from __future__ import annotations

from datetime import date

import pytest
from pydantic import BaseModel

from sitemind.config import SIM_START, get_settings
from sitemind.llm import LLM
from sitemind.models import Goal
from sitemind.store import Store


class Out(BaseModel):
    text: str


def test_off_provider_uses_template_and_caches() -> None:
    st = Store(get_settings().db_path)
    st.create_run("r", Goal(text="g", need_by=date(2027, 3, 15), budget_inr=1e6), "demo",
                  SIM_START)
    llm = LLM(store=st, run_id="r")
    a = llm.complete_json("p", Out, "T1:llm:x", fallback=Out(text="tmpl"))
    b = llm.complete_json("p", Out, "T1:llm:x", fallback=Out(text="other"))
    assert a.value.text == "tmpl" and a.provider == "off" and not a.cached
    assert b.value.text == "tmpl" and b.cached
    led = st.get_ledger("r:T1:llm:x")
    assert led is not None and led.executions == 2


def test_unreachable_model_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SITEMIND_LLM_PROVIDER", "ollama")
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("SITEMIND_LLM_TIMEOUT", "3")
    llm = LLM()
    assert not llm.reachable()
    r = llm.complete_text("hello", "T:llm:y", fallback="fallback text")
    assert r.provider == "fallback" and r.value == "fallback text" and r.error
