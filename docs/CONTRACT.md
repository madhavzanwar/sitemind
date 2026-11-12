# SiteMind — engineering contract (shared by all workstreams)

SiteMind is a durable, long-horizon procurement agent for construction (Track 01 – AGI,
Kaya AI Grand Challenge Ed. 2, Students division). Demo job: **Project Alpha**, a 24 MW
Tier-III data centre at Chakan MIDC, Pune. Goal: *"Get the 480 V switchgear package for
Project Alpha ordered by 2027-03-15 within budget ₹4.6 Cr"* (₹46,000,000).

Source of truth for data shapes: `backend/sitemind/models.py` (pydantic v2). The frontend
mirrors them in `frontend/src/types.ts`. Do not rename fields.

## Repository layout & ownership

```
backend/                    Python 3.11+ package `sitemind` (pyproject.toml, ruff, mypy)
  sitemind/models.py        CONTRACT (owner: lead)
  sitemind/clock.py         SimClock (owner: core)
  sitemind/store.py         SQLite: runs, audit, ledger (idempotency), approvals, events (core)
  sitemind/llm.py           pluggable LLM: Ollama default, optional hosted via env (core)
  sitemind/planner.py       goal -> Plan (task DAG, deadlines, budget, risks); replan() (core)
  sitemind/graph.py         LangGraph StateGraph + SqliteSaver checkpointer (core)
  sitemind/runner.py        worker process: `python -m sitemind.runner <run_id>` (core)
  sitemind/api.py           FastAPI app `sitemind.api:app` (core)
  sitemind/specialists/     pure specialist logic + registry (owner: specialists)
     registry.py takeoff.py quotes.py schedule.py budget.py approvals.py po.py vendors.py
  sitemind/data/            vendors.json, scenario_demo.json, spec PDF (specialists)
  sitemind/mcp_server.py    MCP server (official `mcp` SDK, FastMCP) exposing specialists
  tests/                    pytest
frontend/                   React 18 + Vite + TS + Tailwind dashboard (owner: frontend)
e2e/                        Playwright test of dashboard (owner: frontend)
demo/                       Automated video pipeline (owner: video)
docker-compose.yml, Dockerfiles, Makefile/scripts (owner: ops)
docs/  submission/          docs (lead)
```

Do NOT run `git commit` — the lead commits. Stay inside your owned paths.

## Specialist function signatures (pure, deterministic; `sitemind.specialists`)

```python
# takeoff.py
def run_takeoff(pdf_path: str | Path) -> TakeoffResult
# vendors.py  (mock vendor "network": deterministic given scenario + attempt + sim time)
class VendorNetwork:
    def __init__(self, scenario: dict): ...
    def request_quote(self, vendor_id: str, lines: list[TakeoffLine], attempt: int, now: datetime) -> Quote
        # raises VendorTimeout(vendor_id) when scenario says so for that attempt
    def refresh_quote(self, vendor_id: str, quote: Quote, now: datetime) -> Quote  # may return revised price/lead time
# quotes.py
def collect_quotes(network, vendors: list[str], lines, now, max_attempts=3) -> QuotesResult  # retries, records attempts
# schedule.py  (CPM forward/backward pass)
def critical_path(activities: list[ScheduleActivity]) -> list[ScheduleActivity]
def schedule_for_quote(quote: Quote, po_issue_date: date, required_on_site: date) -> ScheduleResult
    # activities: PO issue -> submittal/shop drawings -> approval -> manufacture(lead time) -> FAT -> shipping -> delivery
# budget.py
def check_budget(quote: Quote, budget_inr: float, contingency_pct=0.05, expedite_fee_inr=0.0) -> BudgetCheck
# approvals.py
def build_decision_memo(goal: Goal, options: list[VendorOption], situation: str) -> DecisionMemo
def rank_options(quotes, schedules, budgets, expedite_offers) -> list[VendorOption]  # weighted score
# po.py
def draft_po(goal: Goal, option: VendorOption, quote: Quote, takeoff: TakeoffResult, po_number: str, issued: date) -> PurchaseOrder
# registry.py
REGISTRY: list[SpecialistSpec]   # takeoff, quotes, schedule, budget, approvals, po (+ planner)
```

LLM is used *around* deterministic logic (plan rationale, risk wording, decision-memo prose,
reasoning summaries), never for arithmetic. Every LLM call is cached in the ledger under an
idempotency key so resume never re-calls it. If the model is unreachable the call falls back to
a deterministic template and the audit entry records `provider: "fallback"`.

## Demo scenario (`scenario_demo.json`) — deterministic chaos

Vendors (synthetic, realistic Indian/MNC-style names, NOT real companies' trademarks):
- `V1` **Voltaris Switchgear Pvt Ltd** (Nashik) — cheapest, reliability 0.82, lead 140 d.
  **Times out** on attempts 1 and 2, answers on attempt 3.
- `V2` **Kestrel Power Systems** (Vadodara) — reliability 0.93, lead 112 d; after initial quote
  it **revises price +11 %** (raw copper surcharge) when refreshed → budget breach.
- `V3` **Anvil Electric India** (Chennai) — reliability 0.90, lead 168 d → **breaks deadline**;
  offers expedite (−42 d) for a fee.
Expected path: plan v1 → takeoff → RFQ to 3 vendors (V1 times out twice, retries) → evaluate →
V2 price revision detected on refresh → budget breach → **re-plan v2** (re-negotiate/alt vendor,
consider V3 expedite) → decision memo → **human approval (vendor selection)** → draft PO →
**human approval (PO release)** → send PO (side effect, idempotent) → done.
`happy` scenario: no failures.

Required on site: 2027-07-30 (energisation window). Need-by (PO issue): 2027-03-15.
Sim start: 2027-01-11 09:00 IST. Each vendor round trip advances the sim clock (e.g. 1–2 days).

## Durability & idempotency

- LangGraph `StateGraph` compiled with `SqliteSaver` (`langgraph-checkpoint-sqlite`),
  `thread_id = run_id`, DB at `$SITEMIND_DATA/checkpoints.sqlite`.
- App DB at `$SITEMIND_DATA/sitemind.sqlite` (WAL): runs, audit, ledger, approvals, timeline.
- Each graph super-step executes ONE plan task → checkpoint after every task.
- Every side effect goes through `store.perform_once(key, kind, fn)`: `INSERT` into `ledger`
  with UNIQUE key; if present return the stored result and bump `executions`. Key format:
  `{run_id}:{task_id}:{action}:{discriminator}`.
- HITL uses LangGraph `interrupt()`; the approval row is created via `perform_once` before
  interrupting; API approval -> stores decision and spawns a worker that resumes with
  `Command(resume=decision)`.
- Worker = separate OS process (`python -m sitemind.runner <run_id>`), pid stored in runs table.
  `POST /kill` sends SIGKILL. `POST /resume` (or auto) spawns a new worker that calls
  `graph.invoke(None, config)` / resume from the latest checkpoint.
- SimClock persisted per run in app DB; pacing `SITEMIND_STEP_DELAY` (default 0; demo 1.5 s).

## REST API (FastAPI, prefix `/api`, port 8000)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/health | – | `{status, llm:{provider,model,reachable}}` |
| GET | /api/registry | – | `SpecialistSpec[]` |
| GET | /api/runs | – | `RunSnapshot[]` (light: audit/ledger may be truncated) |
| POST | /api/runs | `CreateRunRequest` | `RunSnapshot` |
| GET | /api/runs/{id} | – | `RunSnapshot` |
| POST | /api/runs/{id}/kill | – | `RunSnapshot` (worker SIGKILLed, status `killed`) |
| POST | /api/runs/{id}/resume | – | `RunSnapshot` |
| POST | /api/runs/{id}/approvals/{approval_id} | `ApprovalDecision` | `RunSnapshot` |
| GET | /api/runs/{id}/po.md | – | text/markdown PO package |
| GET | /api/demo/defaults | – | `CreateRunRequest` prefilled with the Project Alpha goal |

The frontend polls `GET /api/runs/{id}` every 1 s. Vite dev server proxies `/api` to :8000;
production build is served by FastAPI from `frontend/dist` at `/`.

## LLM

Default `SITEMIND_LLM_PROVIDER=ollama`, `OLLAMA_BASE_URL=http://localhost:11434`,
`SITEMIND_LLM_MODEL=qwen2.5:3b` (small instruction model that runs on laptop CPU).
Optional hosted: `SITEMIND_LLM_PROVIDER=openai` + `OPENAI_API_KEY` + `OPENAI_BASE_URL`
(any OpenAI-compatible endpoint). `SITEMIND_LLM_PROVIDER=off` = deterministic templates only
(used by fast unit tests). Implemented with pydantic-ai where structured output helps.
