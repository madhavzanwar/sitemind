"""Pluggable LLM used *around* deterministic logic (rationale, risk wording, memo prose).

Providers:
  * ``ollama`` (default) - local model via Ollama's OpenAI-compatible API, through pydantic-ai
    (``NativeOutput`` => grammar-constrained JSON matching the pydantic schema).
  * ``openai`` - any OpenAI-compatible endpoint (``OPENAI_API_KEY``/``OPENAI_BASE_URL``).
  * ``off`` - deterministic templates only.

Any error or timeout degrades to the caller-supplied deterministic fallback, recorded with
``provider="fallback"``. Every call is cached in the idempotent ledger under
``{run_id}:{task_id}:llm:{purpose}``, so a resumed run never re-calls the model.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Generic, TypeVar

import httpx
from pydantic import BaseModel

from .config import Settings, get_settings
from .store import Store

os.environ.setdefault("PYDANTIC_AI_NO_BANNER", "1")

T = TypeVar("T")
M = TypeVar("M", bound=BaseModel)

SYSTEM = (
    "You are SiteMind, a concise construction procurement agent for an Indian data-centre "
    "project. Be factual, specific and brief. Never invent numbers beyond those given."
)


@dataclass
class LLMResult(Generic[T]):
    value: T
    provider: str  # "ollama" | "openai" | "off" | "fallback"
    model: str
    tokens: int = 0
    latency_ms: int = 0
    cached: bool = False
    error: str | None = None
    key: str | None = None


@dataclass
class LLMStats:
    calls: int = 0
    fallbacks: int = 0
    cached: int = 0
    tokens: int = 0
    latency_ms: int = 0
    errors: list[str] = field(default_factory=list)


class LLM:
    """LLM facade with ledger caching and deterministic fallback."""

    def __init__(
        self,
        settings: Settings | None = None,
        store: Store | None = None,
        run_id: str | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.store = store
        self.run_id = run_id
        self.provider = self.settings.llm_provider
        if self.provider not in ("ollama", "openai", "off"):
            self.provider = "off"
        if self.provider == "openai" and not self.settings.openai_api_key:
            self.provider = "off"
        self.model = self.settings.llm_model if self.provider != "off" else "template"
        self.stats = LLMStats()

    # ---------------------------------------------------------------- info
    def describe(self) -> dict[str, Any]:
        return {"provider": self.provider, "model": self.model}

    def reachable(self, timeout: float = 2.0) -> bool:
        if self.provider == "off":
            return False
        try:
            if self.provider == "ollama":
                r = httpx.get(f"{self.settings.ollama_base_url}/api/tags", timeout=timeout)
                if r.status_code != 200:
                    return False
                names = {m.get("name") for m in r.json().get("models", [])}
                return self.model in names or f"{self.model}:latest" in names
            base = self.settings.openai_base_url or "https://api.openai.com/v1"
            r = httpx.get(
                f"{base.rstrip('/')}/models",
                headers={"Authorization": f"Bearer {self.settings.openai_api_key}"},
                timeout=timeout,
            )
            return r.status_code == 200
        except (httpx.HTTPError, ValueError):
            return False

    # ---------------------------------------------------------------- pydantic-ai plumbing
    def _model(self) -> Any:
        """Fresh pydantic-ai model per call (its async client is bound to one event loop).

        ``max_retries=0`` so a slow / dead endpoint fails fast into the deterministic fallback
        instead of silently retrying (the OpenAI SDK default is 2 retries).
        """
        from openai import AsyncOpenAI

        if self.provider == "ollama":
            from pydantic_ai.models.ollama import OllamaModel
            from pydantic_ai.providers.ollama import OllamaProvider

            client = AsyncOpenAI(
                base_url=f"{self.settings.ollama_base_url}/v1",
                api_key="ollama",
                max_retries=0,
                timeout=self.settings.llm_timeout_s,
            )
            return OllamaModel(self.model, provider=OllamaProvider(openai_client=client))
        from pydantic_ai.models.openai import OpenAIChatModel
        from pydantic_ai.providers.openai import OpenAIProvider

        client = AsyncOpenAI(
            base_url=self.settings.openai_base_url,
            api_key=self.settings.openai_api_key,
            max_retries=0,
            timeout=self.settings.llm_timeout_s,
        )
        return OpenAIChatModel(self.model, provider=OpenAIProvider(openai_client=client))

    def warmup(self, keep_alive: str = "2h") -> bool:
        """Load the local model into memory (Ollama) so the first real call is fast."""
        if self.provider != "ollama":
            return False
        try:
            r = httpx.post(
                f"{self.settings.ollama_base_url}/api/generate",
                json={"model": self.model, "prompt": "", "keep_alive": keep_alive},
                timeout=max(self.settings.llm_timeout_s, 120.0),
            )
            return r.status_code == 200
        except httpx.HTTPError:
            return False

    def _settings(self, max_tokens: int | None) -> dict[str, Any]:
        return {
            "temperature": 0.0,
            "max_tokens": max_tokens or self.settings.llm_max_tokens,
            "timeout": self.settings.llm_timeout_s,
            "seed": 7,
        }

    def _run_agent(self, prompt: str, output_type: Any, max_tokens: int | None) -> tuple[Any, int]:
        from pydantic_ai import Agent

        agent_cls: Any = Agent
        agent: Any = agent_cls(
            self._model(),
            output_type=output_type,
            system_prompt=SYSTEM,
            model_settings=self._settings(max_tokens),
            retries=1,
        )
        res = agent.run_sync(prompt)
        usage = res.usage
        if callable(usage) and not hasattr(usage, "input_tokens"):
            usage = usage()
        tokens = int(getattr(usage, "input_tokens", 0) or 0) + int(
            getattr(usage, "output_tokens", 0) or 0
        )
        return res.output, tokens

    # ---------------------------------------------------------------- core
    def _call(
        self,
        key: str,
        purpose_payload: dict[str, Any],
        live: Any,  # Callable[[], tuple[Any, int]] returning (jsonable value, tokens)
        fallback_value: Any,
        sim_time: datetime | None,
    ) -> dict[str, Any]:
        executed = {"flag": False}

        def fn() -> dict[str, Any]:
            executed["flag"] = True
            t0 = time.monotonic()
            if self.provider == "off":
                return {
                    "value": fallback_value,
                    "provider": "off",
                    "model": "template",
                    "tokens": 0,
                    "latency_ms": 0,
                    "error": None,
                }
            try:
                value, tokens = live()
                return {
                    "value": value,
                    "provider": self.provider,
                    "model": self.model,
                    "tokens": tokens,
                    "latency_ms": int((time.monotonic() - t0) * 1000),
                    "error": None,
                }
            except Exception as exc:  # any failure -> deterministic fallback
                return {
                    "value": fallback_value,
                    "provider": "fallback",
                    "model": self.model,
                    "tokens": 0,
                    "latency_ms": int((time.monotonic() - t0) * 1000),
                    "error": f"{type(exc).__name__}: {str(exc)[:200]}",
                }

        full_key = f"{self.run_id}:{key}" if self.run_id else key
        if self.store is not None and self.run_id:
            res = self.store.perform_once(
                full_key,
                "llm.call",
                {**purpose_payload, "provider": self.provider, "model": self.model},
                fn,
                run_id=self.run_id,
                sim_time=sim_time,
            )
        else:
            res = fn()
        res["cached"] = not executed["flag"]
        res["key"] = full_key
        self.stats.calls += 1
        if res["cached"]:
            self.stats.cached += 1
        else:
            self.stats.tokens += int(res.get("tokens", 0))
            self.stats.latency_ms += int(res.get("latency_ms", 0))
        if res.get("provider") == "fallback":
            self.stats.fallbacks += 1
            if res.get("error"):
                self.stats.errors.append(str(res["error"]))
        return res

    def complete_json(
        self,
        prompt: str,
        schema: type[M],
        key: str,
        *,
        fallback: M,
        max_tokens: int | None = None,
        sim_time: datetime | None = None,
    ) -> LLMResult[M]:
        """Structured completion validated against ``schema`` (falls back on any error)."""

        def live() -> tuple[Any, int]:
            from pydantic_ai import NativeOutput

            out, tokens = self._run_agent(prompt, NativeOutput(schema), max_tokens)
            return schema.model_validate(out).model_dump(mode="json"), tokens

        res = self._call(
            key,
            {"prompt": prompt[:500], "schema": schema.__name__},
            live,
            fallback.model_dump(mode="json"),
            sim_time,
        )
        try:
            value = schema.model_validate(res["value"])
        except Exception:
            value = fallback
        return LLMResult(
            value=value,
            provider=str(res["provider"]),
            model=str(res["model"]),
            tokens=int(res.get("tokens", 0)),
            latency_ms=int(res.get("latency_ms", 0)),
            cached=bool(res["cached"]),
            error=res.get("error"),
            key=res["key"],
        )

    def complete_text(
        self,
        prompt: str,
        key: str,
        *,
        fallback: str,
        max_tokens: int | None = None,
        sim_time: datetime | None = None,
    ) -> LLMResult[str]:
        def live() -> tuple[Any, int]:
            out, tokens = self._run_agent(prompt, str, max_tokens)
            text = " ".join(str(out).split()).strip()
            if not text:
                raise ValueError("empty completion")
            return text[:900], tokens

        res = self._call(key, {"prompt": prompt[:500]}, live, fallback, sim_time)
        return LLMResult(
            value=str(res["value"]),
            provider=str(res["provider"]),
            model=str(res["model"]),
            tokens=int(res.get("tokens", 0)),
            latency_ms=int(res.get("latency_ms", 0)),
            cached=bool(res["cached"]),
            error=res.get("error"),
            key=res["key"],
        )
