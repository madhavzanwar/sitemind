# SiteMind — QA report

All results below were produced in the build sandbox (Linux, 4 vCPU, 15 GB RAM, **no GPU**,
Python 3.13, Node 22, Ollama 0.40.16 with `qwen2.5:3b`). Raw logs: [`docs/qa_logs/`](qa_logs/).

## Summary

| Gate | Command | Result |
|---|---|---|
| Backend unit + integration tests | `make test` | **60 passed, 1 deselected** (~21 s) |
| Kill -9 & resume integration test | `pytest tests/test_durability.py` (part of the above) | **passed** (also 3/3 repeated runs) |
| Real local model end to end | `pytest -m llm -s tests/test_llm_real.py` | **1 passed** — 3 qwen2.5:3b calls, 0 fallbacks, 865 tokens, 75.6 s run wall time |
| Lint | `ruff check . && ruff format --check .` | **clean** (39 files) |
| Typecheck (backend) | `python3 -m mypy sitemind` | **no issues** (22 source files) |
| Frontend typecheck + build | `npm run build` (`tsc -b && vite build`) | **clean** |
| Frontend lint | `npm run lint` (eslint) | **clean** |
| Dashboard e2e (real backend) | `cd e2e && npx playwright test --trace off sitemind.spec.ts` | E2E_REAL |
| Dashboard e2e (mock mode + screenshots) | `E2E_MOCK=1 npx playwright test --trace off` | E2E_MOCK |
| MCP server | `tests/test_mcp.py` (in-memory + real stdio subprocess) | **passed** |
| Docker | `docker compose config -q` | config **valid**; DOCKER_NOTE |
| Demo video | `demo/run_demo.sh` → `submission/sitemind_demo.mp4` | VIDEO_NOTE |

## What the durability test proves (`backend/tests/test_durability.py`)

1. Starts a real worker **subprocess** (`python -m sitemind.runner <run_id>`), driven over the REST API.
2. Waits until `current_node == "execute:T3-levelling:pacing"` — the quote-refresh side effects
   are done but the LangGraph checkpoint for that task is not yet written — and sends **SIGKILL**.
3. Asserts status `killed`, then resumes via `POST /resume` (new pid, `restarts >= 1`).
4. Approves vendor selection and PO release through the REST endpoints (a second kill after the first
   approval if the worker is still alive).
5. Asserts on completion:
   - exactly **one** PO in the mock vendor outbox, exactly one RFQ per (vendor, attempt);
   - no duplicate refresh / negotiation / expedite / PM e-mail messages; ledger keys unique;
   - every `T3-levelling:refresh:*` ledger row has `executions >= 2` (requested twice, executed once);
   - `plan_version >= 2` (re-plan happened); audit has `replan`, `escalation`, `worker.killed`,
     `worker.resumed`; no duplicate audit entries; `po.md` is served.

## Unit-test coverage map

| Area | File | What is asserted |
|---|---|---|
| Planner | `test_planner.py` | plan is a DAG, deps exist, deadlines back-scheduled before need-by, re-plan keeps done tasks, supersedes the rest, rejection clones downstream tasks |
| Budget guard | `test_budget.py` | ok < 90 % ≤ warn ≤ 100 % < breach, boundaries, expedite fee and contingency |
| Schedule math | `test_schedule.py` | CPM forward/backward pass on a hand-checked network, slack, critical path, negative float |
| Idempotency | `test_store.py` | `perform_once` executes once under repeats **and under a race between 2 real processes**; failure releases the claim; audit/timeline dedupe |
| LLM layer | `test_llm.py` | cache by idempotency key, fallback when the model is unreachable |
| Graph | `test_graph.py` | demo, happy and rejection paths in-process |
| API | `test_api.py` | health, registry, defaults, 404/409/422 errors, SPA fallback |
| Specialists | `test_specialists_*.py` | takeoff quantities + drawing/schedule mismatch warning, vendor determinism (timeouts, revision), ranking + memo, PO totals |
| MCP | `test_mcp.py` | tools listed and called in-memory and over stdio |

## Raw output

### pytest
```
PYTEST
```

### real model
```
LLMREAL
```

### ruff / mypy
```
RUFF
MYPY
```

### Playwright e2e
```
E2ELOG
```
