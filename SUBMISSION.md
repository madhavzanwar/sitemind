# SiteMind — Devpost submission

Copy each section into the matching Devpost field.

## Project title

SiteMind

## Tagline

A procurement agent for construction that plans a multi-week job, survives kill -9, never repeats an RFQ or a PO, and asks a human before anything irreversible.

(160 characters; the limit is 200.)

## Track, challenge, division

| Field | Value |
|---|---|
| Hackathon | The Dawn of Superintelligence \| Kaya AI Grand Challenge, Edition 2 |
| Track | Track 01: Amber General Intelligence (AGI) |
| Challenge | 1.3 "Work that takes days, not minutes" |
| Also demonstrates | 1.2 "The conductor: orchestrating specialist agents" (the demo goal is that challenge's example input) |
| Division | Students |
| Team | _to be filled in on Devpost (2–4 student members)_ |

## Links

| Item | URL |
|---|---|
| Repository | `https://github.com/<your-username>/sitemind` |
| Demo video | `<YouTube URL>` (file: `submission/sitemind_demo.mp4`) |
| Pitch deck (10 slides) | `submission/SiteMind_pitch.pdf` (upload to Devpost) |

---

## Devpost story

### Inspiration

On a data-centre build, the electrical long-lead items set the date. A 480 V switchgear
package takes 4 to 6 months to manufacture, and the hall cannot be energised without it.
The procurement work behind that one package runs for weeks: a takeoff from the spec, RFQs to
several vendors, chasing the ones who go quiet, catching a price that moved after the quote,
checking each lead time against the on-site date, two sign-offs, and a purchase order. Most
of it lives in email threads and an Excel tracker.

None of those steps is difficult. What goes wrong is continuity: a follow-up that nobody
sends, a revised quote that nobody re-checks against the budget, an RFQ that goes out twice
after someone picks the thread back up. Challenge 1.3 asks for an agent that can "keep track
over days, recover from failures, and pick up after a restart without repeating itself".
That is a description of the job a procurement coordinator already does by hand, so we built
the agent around that requirement first and added intelligence second.

### What it does

You give SiteMind one goal in plain English:

> Get the 480 V switchgear package for Project Alpha ordered by 2027-03-15 within budget ₹4.6 Cr.

Project Alpha is our demo job: a 24 MW Tier-III data centre at Chakan MIDC, Pune. All vendor,
price and project data is synthetic and labelled as such.

SiteMind then:

1. **Plans.** It builds a 14-task dependency graph with deadlines, cost allowances and 5 risks.
2. **Calls specialists.** Takeoff reads the spec PDF (8 line items, each with page, table and
   row; confidence 0.92; one schedule-versus-drawing mismatch flagged for an RFI). Quotes
   sends RFQs to three mock vendors. Schedule runs a critical-path check per vendor. Budget
   checks quote plus 5 % contingency against the ceiling.
3. **Handles what goes wrong over simulated days.** Vendor V1 times out twice and answers on
   the third attempt. Vendor V2 revises its price with an 11 % copper surcharge, which takes
   the commitment to 100.8 % of budget. A monitor step catches the breach and the thin
   schedule float, and the planner issues plan v2: negotiate with V2, evaluate V3's expedite
   offer, re-rank, escalate.
4. **Survives being killed.** The worker process can be SIGKILLed at any point. A new worker
   resumes from the last checkpoint. The action ledger shows each RFQ, message and PO executed
   once, with a count of how many times each was requested.
5. **Asks a human before anything irreversible.** It writes a decision memo that ranks four
   options on cost, delivery float and vendor reliability, recommends one, lists the risks of
   its own recommendation, and waits. The PO release is a second approval.
6. **Issues the PO.** In the demo run the PO goes to the expedited option at ₹4,70,32,912
   including GST, 33 days ahead of the order-by date, with delivery 8 days before the
   required-on-site date.

Every step is logged with actor, action, a short reasoning summary, inputs, outputs, cost and
confidence. Every specialist is also exposed as an MCP tool, so another agent can call it.

### How we built it

- **Durable graph.** LangGraph `StateGraph` with five nodes (plan, execute, monitor, replan,
  finish), compiled with `SqliteSaver`. Each super-step runs exactly one plan task, so there
  is a checkpoint after every task. The demo run writes 39 checkpoints.
- **Idempotency ledger.** Every side effect (RFQ, quote refresh, negotiation, PM notice,
  approval request, PO transmission, LLM call) goes through `perform_once(key, …)`. The key
  `{run_id}:{task_id}:{action}:{discriminator}` is the primary key of a SQLite table. A
  repeated request returns the stored result and increments a counter.
- **Worker as a separate process.** The API spawns `python -m sitemind.runner <run_id>` and
  stores its pid. Kill is a real SIGKILL. Resume starts a new process on the same checkpoint
  thread.
- **Human in the loop.** LangGraph `interrupt()`; the worker exits while waiting, and the
  approval decision resumes the graph with `Command(resume=…)`.
- **Specialists.** Six pure Python modules (takeoff, quotes, schedule, budget, approvals, po)
  behind a registry that declares what each takes and returns. No clock, network or model
  inside them, so a replay produces identical output.
- **Planner.** Deterministic DAG construction and re-plan rules for four triggers (budget
  breach, deadline break, unresponsive vendor, rejected approval). Plans are versioned and
  superseded tasks are kept as `skipped`.
- **Local model.** Qwen2.5-3B-Instruct through Ollama, temperature 0, via pydantic-ai. It
  writes the plan rationale, the re-plan explanation and the memo prose: 3 calls per run,
  ₹0 in API fees. It never produces a number. If it is unreachable, a template is used and
  the audit trail says so.
- **Simulated clock.** Thirty simulated days run in seconds; simulated time is part of the
  checkpointed state.
- **Interfaces.** FastAPI REST, a React 18 + Vite + Tailwind dashboard (task graph, vendor
  table, budget, timeline, approvals inbox, audit and ledger, PO package), and an MCP server
  built on the official Python SDK (stdio and streamable HTTP).
- **Packaging.** One `docker compose up --build`, or `scripts/dev.sh` without Docker.

### Challenges we ran into

- **Replay safety is more than checkpointing.** Resuming from a checkpoint re-runs the task
  that was in flight. Without the ledger, that re-sends whatever the task had already sent.
  We had to route every effect, including model calls and audit rows, through a keyed write.
- **Killed mid-action.** A ledger row can be claimed by a process that then dies. We store
  the owner pid so the next worker can tell a live claim from a dead one and take it over.
- **`interrupt()` re-enters the node.** On resume LangGraph runs the approval node again from
  the top, so the approval request itself had to be idempotent. It shows in the ledger as
  requested twice, created once.
- **Time.** Using the wall clock made replays produce different timestamps and different
  quote validity. Moving simulated time into the checkpointed state fixed that.
- **A 3B model cannot be trusted with structure.** Early plans from the model had cycles and
  missing dependencies. We moved plan structure and all arithmetic into code and kept the
  model for wording.
- **When to re-plan.** Re-planning on the first bad number produced churn. The monitor now
  waits until all schedule and budget checks for the current plan are in.

### Accomplishments that we're proud of

- A run that is killed with SIGKILL and resumed ends with the same PO and exactly 5 RFQs and
  1 PO in the vendor outbox.
- The agent's recommendation changes for a stated reason. Before the price revision the
  ranking favours V2; after it, V2 is over budget and the memo recommends the expedited V3
  option, with the cheaper V1 shown as late.
- The memo lists the weaknesses of its own recommendation: 6 days of float, 90.7 % of budget,
  and an expedite fee that should be paid only against a delivery milestone.
- The whole thing runs offline on a laptop CPU, and with the model switched off every number
  is unchanged.
- A deterministic test suite that needs no model, including kill-and-resume durability tests. 60 deterministic tests, a real-model run and a Playwright e2e all pass.

### What we learned

- For long-running agents, exactly-once behaviour is a storage design question. The model has
  very little to do with it.
- Pure specialists make durability cheap: if a step can be recomputed identically, only its
  side effects need protecting.
- A plan stored as data, with versions, gives a project manager something to follow. A chain
  of model turns does not.
- A small local model is enough when it is asked to explain decisions that code has already
  made.
- "Ask a human" works best when the agent brings a ranked memo with its own risks listed.

### What's next for SiteMind

1. Email (IMAP/SMTP) and ERP adapters behind the same ledger, passing the idempotency key to
   the receiving system.
2. More job types on the same harness: submittal chasing, RFI follow-up, delivery tracking.
3. Lead-time ranges from vendor history in place of single values.
4. Takeoff from real drawing sets, with a review screen where a person accepts each line.
5. Postgres for checkpoints and the store, authentication, approver roles and delegation.
6. A kill-at-every-step benchmark that asserts zero duplicate actions across the whole run.

---

## Built with

`python` · `langgraph` · `langgraph-checkpoint-sqlite` · `sqlite` · `fastapi` · `uvicorn` ·
`pydantic` · `pydantic-ai` · `mcp` (Model Context Protocol Python SDK) · `ollama` ·
`qwen2.5` · `pdfplumber` · `reportlab` · `react` · `typescript` · `vite` · `tailwindcss` ·
`docker` · `playwright` · `ffmpeg` · `piper-tts`

## Models, cost, response time

| | |
|---|---|
| Model | Qwen2.5-3B-Instruct (`qwen2.5:3b`) on Ollama, local CPU |
| Calls per run | 3 |
| Cost per run | ₹0 in API fees |
| Response time | Full run 5.4 s with the model off. With `qwen2.5:3b` on a 4-core CPU: ~25 s per call, 75.6 s per full run, 0 fallbacks. |

## Testing instructions for judges

Docker (3 commands, first start downloads a 1.9 GB model):

```bash
git clone https://github.com/<your-username>/sitemind
cd sitemind
docker compose up --build
```

Without Docker (needs Python 3.11+, Node 22, Ollama):

```bash
git clone https://github.com/<your-username>/sitemind
cd sitemind
scripts/dev.sh
```

Then open <http://localhost:8000> and:

1. Press **Launch agent**. The Project Alpha goal, need-by date and budget are prefilled.
2. On **Overview**, watch plan v1 appear, V1 time out twice, V2's revision turn the budget red,
   and the plan change to v2.
3. Press **Kill worker**, wait for the killed banner, then press **Resume**.
4. Open **Audit**. Check the ledger: one row per RFQ attempt and message; entries requested
   more than once are marked `×2`.
5. Open **Approvals**. Read the decision memo and approve (or pick another option, or reject
   to see a re-plan). Approve the PO release.
6. Open **PO** to see the purchase order package and its "sent" stamp.

Terminal-only check, including a SIGKILL and resume (from `backend/`, after
`pip install -e .`):

```bash
python -m sitemind.cli demo --provider off --kill-after 12
```

Call the specialists from another agent over MCP:

```bash
python -m sitemind.mcp_server                      # stdio
python -m sitemind.mcp_server --http --port 8765   # http://127.0.0.1:8765/mcp
```

Unit tests: `make test`.

## How the entry meets the Track 01 rules

| Rule | Where |
|---|---|
| Asks a human before anything that can't be undone | two `interrupt()` approvals: vendor selection, PO release |
| Logs every action and every specialist call | `audit` table, Audit tab |
| Keeps its own record of where each job stands | LangGraph checkpoints + `runs`, `ledger`, `approvals` tables |
| Never does the same thing twice | `perform_once` ledger; `outbox` shows 5 RFQs and 1 PO after a kill and resume |
| Structured output | pydantic models end to end; `GET /api/runs/{id}` returns a `RunSnapshot` |
| Callable by another agent | MCP server with 7 tools |
| Sources | each takeoff line cites document, page, table and row |
| Confidence and hand-off | takeoff confidence 0.92 with an RFI warning; audit entries carry confidence; decisions go to a human |
| Nothing made up | vendors are synthetic and labelled so in the README, UI and video; the model writes prose only |
| Models, cost, time | table above |

## Data statement

All project, vendor and price data is synthetic and written by the team for this demo.
Voltaris Switchgear Pvt Ltd, Kestrel Power Systems and Anvil Electric India are fictional.
The sample spec PDF is generated by `backend/scripts/make_spec_pdf.py`. No client data is used.

## Open-source credits

Original work under the MIT licence. Full table with licences in [`CREDITS.md`](CREDITS.md).

- **Runtime:** LangGraph and `langgraph-checkpoint-sqlite` (MIT), MCP Python SDK (MIT),
  Pydantic and Pydantic AI (MIT), FastAPI (MIT), Uvicorn and HTTPX (BSD-3-Clause),
  pdfplumber (MIT), ReportLab (BSD-3-Clause).
- **Model serving:** Ollama (MIT); Qwen2.5-3B-Instruct (Qwen Research License, non-commercial).
- **Frontend:** React, Vite, Tailwind CSS (MIT), TypeScript (Apache-2.0), lucide-react (ISC),
  react-markdown (MIT), Inter and JetBrains Mono (OFL 1.1).
- **Demo video tooling, not shipped in the app:** Playwright (Apache-2.0), FFmpeg, Piper TTS.
- **Ideas, no code copied:** bytedance/deer-flow (planner and sub-agent harness on LangGraph),
  Kentucky-ai/opentakeoff (takeoff as an MCP tool with a source per line; AGPL, so no code
  used), DDC Skills for AI Agents in Construction (procurement task decomposition).
