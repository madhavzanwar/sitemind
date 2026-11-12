"""Access to the bundled synthetic data (vendor catalogue, scenarios, sample spec PDF)."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SPEC_PDF = DATA_DIR / "project_alpha_480V_switchgear_spec.pdf"
SCENARIOS = ("demo", "happy")


@lru_cache(maxsize=1)
def _vendors_raw() -> str:
    return (DATA_DIR / "vendors.json").read_text(encoding="utf-8")


def load_vendors() -> dict[str, Any]:
    """Return a fresh copy of ``data/vendors.json`` (catalogue, price tables, terms)."""
    data: dict[str, Any] = json.loads(_vendors_raw())
    return data


def vendor_profile(vendor_id: str) -> dict[str, Any]:
    """Return one vendor's catalogue entry; raises ``KeyError`` for unknown vendors."""
    profile: dict[str, Any] = load_vendors()["vendors"][vendor_id]
    return profile


def load_scenario(name: str = "demo") -> dict[str, Any]:
    """Load ``data/scenario_<name>.json`` (``demo`` = injected failures, ``happy`` = none)."""
    if name not in SCENARIOS:
        raise ValueError(f"unknown scenario {name!r}; expected one of {SCENARIOS}")
    data: dict[str, Any] = json.loads(
        (DATA_DIR / f"scenario_{name}.json").read_text(encoding="utf-8")
    )
    return data
