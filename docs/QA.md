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
| Dashboard e2e (real backend) | `cd e2e && npx playwright test --trace off sitemind.spec.ts` | **1 passed** (launch → SIGKILL → resume → 2 approvals → PO sent, ~42 s) |
| Dashboard e2e (mock mode + screenshots) | `E2E_MOCK=1 npx playwright test --trace off` | **13 passed** (same flow in mock mode + 12 screenshot captures) |
| MCP server | `tests/test_mcp.py` (in-memory + real stdio subprocess) | **passed** |
| Docker | `docker compose config -q` | config **valid**; image **built**; stack **up** (app + ollama containers) and a full goal run completed inside it — see below |
| Demo video | `demo/run_demo.sh` → `submission/sitemind_demo.mp4` | **2:47**, H.264 1920×1080 + AAC, Piper narration, burned-in subtitles; 10 scene frames inspected (`submission/frames/`) |

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
............................................................             [100%]
60 passed, 1 deselected in 20.53s
```

### real model
```
[worker 1266] run run-20261113-005021-8166 start (dict)
[worker 1266] run run-20261113-005021-8166 -> waiting_human
[worker 1266] run run-20261113-005021-8166 start (Command)
[worker 1266] run run-20261113-005021-8166 -> waiting_human
[worker 1266] run run-20261113-005021-8166 start (Command)
[worker 1266] run run-20261113-005021-8166 -> completed

real-LLM run: wall 75.6s, llm={'calls': 3, 'fallbacks': 0, 'tokens': 865, 'latency_ms': 74490, 'replayed': 0}
.
1 passed in 143.39s (0:02:23)
```

### ruff / mypy
```
All checks passed!
39 files already formatted
Success: no issues found in 22 source files
```

### Playwright e2e
```
[WebServer] INFO:     Application startup complete.
[WebServer] INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)

Running 1 test using 1 worker

  ✓  1 [chromium] › sitemind.spec.ts:25:1 › launch, survive SIGKILL, approve twice, PO sent (41.7s)

  1 passed (50.2s)

# mock mode
✓  10 [chromium] › screenshots.spec.ts:29:3 › screenshot audit (2.3s)
  ✓  11 [chromium] › screenshots.spec.ts:29:3 › screenshot po (2.3s)
  ✓  12 [chromium] › screenshots.spec.ts:37:1 › screenshot ledger (1.6s)
  ✓  13 [chromium] › sitemind.spec.ts:25:1 › launch, survive SIGKILL, approve twice, PO sent (11.9s)

  13 passed (41.8s)
```

### Docker stack (`docker compose up`)

Built and run in this sandbox. Two sandbox-only adjustments, **not** part of the shipped files:
Docker Hub was rate-limited (HTTP 429) so base images came from `mirror.gcr.io`, and the build
used the sandbox's TLS-intercepting proxy CA with host networking. The ollama container reused the
already-downloaded model. A full goal was then driven through the containerised API with a SIGKILL
mid-run:

```
run run-20261113-013101-f9ba
killed at execute:T2-rfq:pacing ckpt 5
status killed
resumed
approved vendor_selection
approved po_release
final completed plan v 2 PO PO-ALPHA-20270207-V3-01 sent
llm {'provider': 'ollama', 'model': 'qwen2.5:3b', 'calls': 3, 'fallbacks': 0, 'tokens': 865, 'latency_ms': 35386, 'replayed': 0}
dedup [('T2-rfq:rfq:V1:a1', 2), ('T2-rfq:rfq:V1:a2', 2), ('T2-rfq:rfq:V1:a3', 2), ('T2-rfq:rfq:V2:a1', 2), ('T2-rfq:rfq:V3:a1', 2), ('T11-approve-vendor:approval:requested', 2), ('T13-approve-po:approval:requested', 2)]
wall 58.5 s
```

### Demo video

`demo/run_demo.sh` regenerated narration, title cards, the 1920×1080 recording against a fresh
backend using the real local model, and the render. The recorder's `kill_when` action fired
inside `T18-escalate:pacing`; after resume the ledger shows `T18-escalate:notify:pm` as
"×2 requested · executed once" (frame `submission/frames/scene_07.png`). During the recording the
CPU is shared with Chromium's screen encoder, so one of the three model calls (decision-memo
prose) hit its timeout and used the deterministic template — the ledger records it as
`provider: "fallback"`. Without the recorder running, the same run makes 3 live calls with 0
fallbacks (real-model test above and the Docker run).

## Known limitations found during QA

- On a 4-core CPU without GPU each qwen2.5:3b call takes ~10–30 s; under heavy load a call can
  time out and fall back to a template (numbers are unaffected — the model writes prose only).
- An action interrupted between its external effect and the ledger write is retried on resume
  (documented in README → Limitations).
