"""Shared fixtures: every test gets its own SITEMIND_DATA dir and the deterministic LLM."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def sitemind_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    data = tmp_path / "data"
    monkeypatch.setenv("SITEMIND_DATA", str(data))
    monkeypatch.setenv("SITEMIND_LLM_PROVIDER", "off")
    monkeypatch.setenv("SITEMIND_STEP_DELAY", "0")
    yield data
