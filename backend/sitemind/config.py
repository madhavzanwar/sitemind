"""Environment-driven settings (read fresh on every call so tests can override env)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
BACKEND_DIR = PACKAGE_DIR.parent
REPO_DIR = BACKEND_DIR.parent
IST = timezone(timedelta(hours=5, minutes=30), name="IST")
SIM_START = datetime(2027, 1, 11, 9, 0, tzinfo=IST)


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    llm_provider: str  # "ollama" | "openai" | "off"
    llm_model: str
    ollama_base_url: str
    openai_base_url: str | None
    openai_api_key: str | None
    llm_timeout_s: float
    llm_max_tokens: int
    step_delay_s: float
    scenario_dir: Path
    frontend_dist: Path

    @property
    def db_path(self) -> Path:
        return self.data_dir / "sitemind.sqlite"

    @property
    def checkpoint_path(self) -> Path:
        return self.data_dir / "checkpoints.sqlite"

    @property
    def logs_dir(self) -> Path:
        return self.data_dir / "logs"

    @property
    def locks_dir(self) -> Path:
        return self.data_dir / "locks"

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.logs_dir, self.locks_dir):
            d.mkdir(parents=True, exist_ok=True)


def get_settings() -> Settings:
    provider = os.environ.get("SITEMIND_LLM_PROVIDER", "ollama").strip().lower()
    default_model = "qwen2.5:3b" if provider != "openai" else "gpt-4o-mini"
    s = Settings(
        data_dir=Path(os.environ.get("SITEMIND_DATA", str(BACKEND_DIR / ".data"))).resolve(),
        llm_provider=provider,
        llm_model=os.environ.get("SITEMIND_LLM_MODEL", default_model),
        ollama_base_url=os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434").rstrip("/"),
        openai_base_url=os.environ.get("OPENAI_BASE_URL") or None,
        openai_api_key=os.environ.get("OPENAI_API_KEY") or None,
        llm_timeout_s=_float("SITEMIND_LLM_TIMEOUT", 60.0),
        llm_max_tokens=int(_float("SITEMIND_LLM_MAX_TOKENS", 140)),
        step_delay_s=_float("SITEMIND_STEP_DELAY", 0.0),
        scenario_dir=Path(
            os.environ.get("SITEMIND_SCENARIO_DIR", str(PACKAGE_DIR / "data"))
        ).resolve(),
        frontend_dist=Path(
            os.environ.get("SITEMIND_FRONTEND_DIST", str(REPO_DIR / "frontend" / "dist"))
        ).resolve(),
    )
    s.ensure_dirs()
    return s
