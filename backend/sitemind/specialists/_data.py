"""Backward-compatible access to bundled data (aliases for the default ``swgr-480v`` package).

New code should use :mod:`sitemind.specialists.packages`.
"""

from __future__ import annotations

from typing import Any

from sitemind.specialists.packages import (
    DATA_DIR,
    DEFAULT_PACKAGE,
    SCENARIOS,
    load_package_catalog,
    load_package_scenario,
    package_for_vendor,
    package_spec_pdf,
)

SPEC_PDF = package_spec_pdf(DEFAULT_PACKAGE)

__all__ = [
    "DATA_DIR",
    "SCENARIOS",
    "SPEC_PDF",
    "load_scenario",
    "load_vendors",
    "vendor_profile",
]


def load_vendors(package_id: str = DEFAULT_PACKAGE) -> dict[str, Any]:
    """Fresh copy of a package's ``vendors.json`` (default: switchgear)."""
    return load_package_catalog(package_id)


def vendor_profile(vendor_id: str) -> dict[str, Any]:
    """One vendor's catalogue entry, searched across all packages; ``KeyError`` if unknown."""
    profile: dict[str, Any] = load_package_catalog(package_for_vendor(vendor_id))["vendors"][
        vendor_id
    ]
    return profile


def load_scenario(name: str = "demo", package_id: str = DEFAULT_PACKAGE) -> dict[str, Any]:
    """Load a package's ``scenario_<name>.json`` (demo = injected failures, happy = none)."""
    return load_package_scenario(package_id, name)
