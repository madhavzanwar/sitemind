"""Procurement packages: catalogue, scenarios, sample spec and item categories per package.

Layout: ``sitemind/data/packages/<package_id>/`` holding

* ``package.json``  - a :class:`~sitemind.models.PackageSpec` plus extra keys used here:
  ``categories`` (item classification rules), ``cross_checks`` (spec-vs-drawing/datasheet
  checks for the takeoff) and ``po_terms`` (package-specific PO terms);
* ``vendors.json``  - vendor profiles, unit prices per item code and a ``rate_card`` per
  item category for items that are not in the catalogue;
* ``scenario_demo.json`` / ``scenario_happy.json`` and the sample spec PDF.

Adding a package = adding a folder; no code changes.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from sitemind.models import PackageSpec, TakeoffLine

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
PACKAGES_DIR = DATA_DIR / "packages"
DEFAULT_PACKAGE = "swgr-480v"
SCENARIOS = ("demo", "happy")


@lru_cache(maxsize=64)
def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _json(path: Path) -> dict[str, Any]:
    data: dict[str, Any] = json.loads(_read(path))
    return data


def package_ids() -> list[str]:
    """Ids of every package folder that has a ``package.json`` (sorted, default first)."""
    ids = sorted(p.name for p in PACKAGES_DIR.iterdir() if (p / "package.json").is_file())
    return sorted(ids, key=lambda i: (i != DEFAULT_PACKAGE, i))


def package_dir(package_id: str) -> Path:
    d = PACKAGES_DIR / package_id
    if not (d / "package.json").is_file():
        raise KeyError(f"unknown package {package_id!r}; known: {package_ids()}")
    return d


def load_package_raw(package_id: str) -> dict[str, Any]:
    """Full ``package.json`` including ``categories``, ``cross_checks`` and ``po_terms``."""
    return _json(package_dir(package_id) / "package.json")


def get_package(package_id: str) -> PackageSpec:
    """The :class:`PackageSpec` for ``package_id``; raises ``KeyError`` if unknown."""
    return PackageSpec.model_validate(load_package_raw(package_id))


def list_packages() -> list[PackageSpec]:
    return [get_package(i) for i in package_ids()]


def package_spec_pdf(package_id: str) -> Path:
    return package_dir(package_id) / get_package(package_id).spec_document


def load_package_catalog(package_id: str) -> dict[str, Any]:
    """Fresh copy of the package's ``vendors.json``."""
    return _json(package_dir(package_id) / "vendors.json")


def load_package_scenario(package_id: str, scenario: str) -> dict[str, Any]:
    if scenario not in SCENARIOS:
        raise ValueError(f"unknown scenario {scenario!r}; expected one of {SCENARIOS}")
    data = _json(package_dir(package_id) / f"scenario_{scenario}.json")
    data.setdefault("package_id", package_id)
    return data


def package_for_vendor(vendor_id: str) -> str:
    """Package whose catalogue contains ``vendor_id`` (vendor ids are unique across packages)."""
    for pid in package_ids():
        if vendor_id in load_package_catalog(pid)["vendors"]:
            return pid
    raise KeyError(f"unknown vendor {vendor_id!r}")


def package_categories(package_id: str) -> list[dict[str, Any]]:
    cats: list[dict[str, Any]] = load_package_raw(package_id).get("categories", [])
    return cats


def package_po_terms(package_id: str) -> list[str]:
    terms: list[str] = load_package_raw(package_id).get("po_terms", [])
    return list(terms)


# ------------------------------------------------------------------ matching / classification


def _kw_regex(kw: str) -> re.Pattern[str]:
    return re.compile(r"(?<![\w-])" + re.escape(kw.lower()) + r"(?![\w-])")


def _keyword_hits(text: str, keywords: list[str]) -> list[str]:
    low = text.lower()
    return [kw for kw in keywords if _kw_regex(kw).search(low)]


def match_package(text: str) -> tuple[str | None, float, str | None]:
    """Best package for free text: ``(package_id, confidence, matched keyword)``.

    Score = number of distinct keywords hit (multi-word keywords count double). Confidence is
    0.6 + 0.1 per extra point (max 0.97), halved when two packages tie. No hit -> (None, 0, None).
    """
    scored: list[tuple[int, int, str, str]] = []
    for pid in package_ids():
        hits = _keyword_hits(text, get_package(pid).keywords)
        if not hits:
            continue
        score = sum(2 if " " in h else 1 for h in hits)
        best = max(hits, key=lambda h: (len(h), h))
        scored.append((score, len(best), pid, best))
    if not scored:
        return None, 0.0, None
    scored.sort(key=lambda s: (-s[0], -s[1], s[2]))
    top = scored[0]
    conf = min(0.97, 0.6 + 0.1 * (top[0] - 1))
    if len(scored) > 1 and scored[1][0] == top[0]:
        conf /= 2
    return top[2], round(conf, 2), top[3]


def classify_line(line: TakeoffLine, package_id: str | None = None) -> tuple[str, str] | None:
    """Classify a takeoff line to ``(package_id, category_id)``; ``None`` if nothing matches.

    Exact catalogue item codes win; otherwise category keywords are matched against the
    description and item code. With ``package_id=None`` every package is tried (default first).
    """
    pids = [package_id] if package_id else package_ids()
    for pid in pids:
        for cat in package_categories(pid):
            if line.item_code in cat.get("item_codes", []):
                return pid, str(cat["id"])
    text = f"{line.description} {line.item_code.replace('-', ' ')}"
    for pid in pids:
        for cat in package_categories(pid):
            if _keyword_hits(text, list(cat.get("keywords", []))):
                return pid, str(cat["id"])
    return None
