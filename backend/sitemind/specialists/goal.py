"""Deterministic goal parser: plain-English procurement goal -> :class:`GoalParseResult`.

Reads the package (catalogue keywords), project ("Project X" / "X project"), the ordered-by
date (ISO, "15 March 2027", "March 15, 2027", "15/03/2027", "in 6 weeks") and the budget
(₹4.6 Cr, Rs 46,00,000, 4.6 crore, 460 lakh, INR 46000000, 46 million). Every value it returns
has its exact source span in ``evidence``; anything it cannot read is listed in ``missing`` with
a question for the human. It never invents a value: a month without a day, a bare number
without a currency or unit, or a package without a catalogue are asked about, not guessed.
"""

from __future__ import annotations

import calendar
import re
from datetime import date, timedelta

from sitemind.models import GoalParseResult
from sitemind.specialists.packages import get_package, list_packages, match_package

MONTHS: dict[str, int] = {}
for _i in range(1, 13):
    MONTHS[calendar.month_name[_i].lower()] = _i
    MONTHS[calendar.month_abbr[_i].lower()] = _i
MONTHS["sept"] = 9
_MON = r"(?P<mon>" + "|".join(sorted(MONTHS, key=len, reverse=True)) + r")\.?"

_DATE_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"\b(?P<y>20\d\d)-(?P<m>\d{1,2})-(?P<d>\d{1,2})\b"),
    re.compile(r"\b(?P<d>\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+" + _MON + r",?\s+(?P<y>20\d\d)\b",
               re.IGNORECASE),
    re.compile(r"\b" + _MON + r"\s+(?P<d>\d{1,2})(?:st|nd|rd|th)?,?\s+(?P<y>20\d\d)\b",
               re.IGNORECASE),
    re.compile(r"\b(?P<d>\d{1,2})[/.](?P<m>\d{1,2})[/.](?P<y>20\d\d)\b"),  # Indian dd/mm/yyyy
]
_MONTH_ONLY = re.compile(r"\b(?:end of\s+)?" + _MON + r",?\s+(?P<y>20\d\d)\b", re.IGNORECASE)
_RELATIVE = re.compile(
    r"\b(?:in|within)\s+(?P<n>\d{1,3})\s+(?P<u>days?|weeks?|months?)\b", re.IGNORECASE
)
_ORDER_CTX = re.compile(r"(order(?:ed)?|place[d]?|issue[d]?|award(?:ed)?|po)\b[^.]{0,25}$",
                        re.IGNORECASE)
_BY_CTX = re.compile(r"\b(by|before|no later than|on or before|until)\s*$", re.IGNORECASE)
_SITE_CTX = re.compile(r"(on site|delivered|delivery|energi[sz]|commission)[^.]{0,20}$",
                       re.IGNORECASE)

_MONEY = re.compile(
    r"(?P<cur>₹|\bRs\.?|\bINR)?\s*(?P<num>\d[\d,]*(?:\.\d+)?)\s*"
    r"(?P<unit>crores?\b|cr\b\.?|lakhs?\b|lacs?\b|lac\b|million\b|mn\b|m\b|k\b|thousand\b)?",
    re.IGNORECASE,
)
_UNIT_MULT = {"crore": 1e7, "cr": 1e7, "lakh": 1e5, "lac": 1e5, "million": 1e6, "mn": 1e6,
              "m": 1e6, "k": 1e3, "thousand": 1e3}
_BUDGET_CTX = re.compile(r"(budget|within|under|cap|ceiling|not exceed|max(?:imum)?|upto|up to"
                         r"|for|of)\s*[:=]?\s*$", re.IGNORECASE)

_PROJECT = [
    re.compile(r"\bProject\s+(?P<name>[A-Z0-9][\w-]*)"),
    re.compile(r"\b(?:the\s+)?(?P<name>[A-Z][\w-]*)\s+project\b"),
]
_PACKAGE_PHRASE = re.compile(
    r"\b(?:get|order|procure|buy|purchase|source|tender|place an order for|award)\s+"
    r"(?:the\s+|a\s+|an\s+|all\s+|our\s+)?(?:\d+\s*(?:x|×|nos?\.?)\s*)?"
    r"(?P<phrase>[\w\s./&+-]{2,60}?)\s*(?:package\s*)?"
    r"(?=\bfor\b|\bordered\b|\bby\b|\bwithin\b|\bbefore\b|\bunder\b|,|\.|$)",
    re.IGNORECASE,
)
_STOP_PHRASES = {"it", "this", "them", "everything", "stuff", "the package", "package"}


def _date_candidates(text: str, today: date) -> list[tuple[int, int, date | None, str]]:
    """(start, end, date or None if invalid, span) for every date-like span."""
    out: list[tuple[int, int, date | None, str]] = []
    taken: list[tuple[int, int]] = []
    for rx in _DATE_PATTERNS:
        for m in rx.finditer(text):
            if any(a < m.end() and m.start() < b for a, b in taken):
                continue
            gd = m.groupdict()
            month = MONTHS[gd["mon"].lower().rstrip(".")] if gd.get("mon") else int(gd["m"])
            try:
                d: date | None = date(int(gd["y"]), month, int(gd["d"]))
            except ValueError:
                d = None
            out.append((m.start(), m.end(), d, m.group(0)))
            taken.append((m.start(), m.end()))
    for m in _RELATIVE.finditer(text):
        n, unit = int(m.group("n")), m.group("u").lower()
        if unit.startswith("day"):
            d = today + timedelta(days=n)
        elif unit.startswith("week"):
            d = today + timedelta(weeks=n)
        else:
            mo = today.month - 1 + n
            y, mo = today.year + mo // 12, mo % 12 + 1
            d = date(y, mo, min(today.day, calendar.monthrange(y, mo)[1]))
        out.append((m.start(), m.end(), d, m.group(0)))
    return sorted(out)


def _pick_need_by(
    text: str, cands: list[tuple[int, int, date | None, str]]
) -> tuple[int, int, date | None, str] | None:
    def score(c: tuple[int, int, date | None, str]) -> int:
        before = text[max(0, c[0] - 40) : c[0]]
        s = 0
        if _BY_CTX.search(before):
            s += 2
        if _ORDER_CTX.search(before):
            s += 3
        if _SITE_CTX.search(before):
            s -= 4
        return s

    if not cands:
        return None
    ranked = sorted(cands, key=lambda c: (-score(c), c[0]))
    best = ranked[0]
    if score(best) < 0:  # only delivery / on-site dates: not an order-by date
        return None
    return best


def _money_candidates(text: str) -> list[tuple[int, int, float, str, int]]:
    out: list[tuple[int, int, float, str, int]] = []
    for m in _MONEY.finditer(text):
        cur, unit = m.group("cur"), (m.group("unit") or "").lower().rstrip(".")
        if not cur and not unit:
            continue
        num_txt = m.group("num")
        if re.fullmatch(r"20\d\d", num_txt) and not cur:
            continue
        unit_key = unit.rstrip("s") if unit not in ("m", "mn") else unit
        if unit == "m" and not cur:
            continue  # "30 m" is metres, not millions
        mult = _UNIT_MULT.get(unit_key, 1.0)
        value = float(num_txt.replace(",", "")) * mult
        if value < 1000:
            continue
        start = m.start("cur") if cur else m.start("num")
        span = text[start : m.end()].rstrip(" .,")
        before = text[max(0, start - 30) : start]
        ctx = 3 if _BUDGET_CTX.search(before) else 0
        ctx += 2 if "budget" in text[max(0, start - 30) : start].lower() else 0
        out.append((start, start + len(span), round(value, 2), span, ctx))
    return out


def parse_goal(text: str, today: date) -> GoalParseResult:
    """Parse a plain-English procurement goal deterministically (see module docstring)."""
    evidence: dict[str, str] = {}
    missing: list[str] = []
    questions: list[str] = []
    conf: dict[str, float] = {}
    supported = True

    # package
    package_id, pconf, kw = match_package(text)
    package: str | None = None
    if package_id and kw:
        package = get_package(package_id).title
        m = re.search(re.escape(kw), text, re.IGNORECASE)
        evidence["package"] = m.group(0) if m else kw
        conf["package"] = pconf
        if pconf < 0.5:
            questions.append(
                f"The goal mentions more than one package; did you mean {package}?"
            )
    else:
        pm = _PACKAGE_PHRASE.search(text)
        phrase = pm.group("phrase").strip() if pm else ""
        names = ", ".join(f"{p.title} ({p.package_id})" for p in list_packages())
        if phrase and phrase.lower() not in _STOP_PHRASES:
            supported = False
            package = phrase
            evidence["package"] = phrase
            conf["package"] = 0.3
            questions.append(
                f"SiteMind has no catalogue or vendor panel for '{phrase}'. Hand this to a human "
                f"buyer, or pick a supported package: {names}."
            )
        else:
            missing.append("package")
            conf["package"] = 0.0
            questions.append(f"Which package should be procured? Supported: {names}.")

    # project
    project = None
    for rx in _PROJECT:
        pm2 = rx.search(text)
        if pm2 and pm2.group("name").lower() not in {"the", "this", "a", "our"}:
            project = f"Project {pm2.group('name')}"
            evidence["project"] = pm2.group(0)
            conf["project"] = 1.0
            break
    if project is None:
        missing.append("project")
        conf["project"] = 0.0
        questions.append("Which project is this for (e.g. 'Project Alpha')?")

    # need-by date
    need_by: date | None = None
    cands = _date_candidates(text, today)
    pick = _pick_need_by(text, cands)
    if pick is not None and pick[2] is None:
        questions.append(f"'{pick[3]}' is not a valid date; what is the order-by date?")
        pick = None
        missing.append("need_by")
        conf["need_by"] = 0.0
    elif pick is not None:
        need_by = pick[2]
        evidence["need_by"] = pick[3]
        conf["need_by"] = 1.0 if re.search(r"\d", pick[3][:4]) or len(cands) == 1 else 0.9
        if need_by is not None and need_by < today:
            questions.append(
                f"The order-by date {need_by.isoformat()} is in the past (today is "
                f"{today.isoformat()}); is that right?"
            )
            conf["need_by"] = 0.5
    else:
        missing.append("need_by")
        conf["need_by"] = 0.0
        mo = _MONTH_ONLY.search(text)
        if mo:
            y = int(mo.group("y"))
            mnum = MONTHS[mo.group("mon").lower().rstrip(".")]
            last = date(y, mnum, calendar.monthrange(y, mnum)[1])
            questions.append(
                f"'{mo.group(0)}' has no day: order by {last.isoformat()} (end of month), or "
                "another date?"
            )
        elif cands:
            questions.append(
                "The only date given looks like a delivery/site date; by when must the PO be "
                "placed?"
            )
        else:
            questions.append("By what date must the order be placed?")

    # budget
    budget: float | None = None
    money = _money_candidates(text)
    if money:
        best = sorted(money, key=lambda c: (-c[4], c[0]))[0]
        budget = best[2]
        evidence["budget_inr"] = best[3]
        conf["budget_inr"] = 1.0 if best[4] or len(money) == 1 else 0.7
        if len(money) > 1 and not best[4]:
            questions.append(
                f"Several amounts are mentioned; is the budget ceiling INR {budget:,.0f}?"
            )
    else:
        missing.append("budget_inr")
        conf["budget_inr"] = 0.0
        bare = re.search(r"\bbudget\b[^\d]{0,15}(\d[\d,.]*)", text, re.IGNORECASE)
        if bare:
            questions.append(
                f"Budget '{bare.group(1)}' has no currency or unit - is that rupees, lakh or "
                "crore?"
            )
        else:
            questions.append("What is the budget ceiling for this package (INR, ex-GST)?")

    confidence = round(sum(conf.values()) / 4.0, 2)
    return GoalParseResult(
        package_id=package_id if supported else None,
        package=package,
        project=project,
        need_by=need_by,
        budget_inr=budget,
        confidence=max(0.0, min(1.0, confidence)),
        evidence=evidence,
        missing=missing,
        questions=questions,
        supported=supported,
    )
