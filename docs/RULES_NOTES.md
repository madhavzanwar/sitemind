# Rules notes — Kaya AI Grand Challenge, Edition 2

Source pages (fetched 2026-11-12; quotes below are verbatim from them):

- Overview: <https://kaya-ai-grand-challenge.devpost.com/>
- Rules: <https://kaya-ai-grand-challenge.devpost.com/rules>
- Resources: <https://kaya-ai-grand-challenge.devpost.com/resources>
- Schedule: <https://kaya-ai-grand-challenge.devpost.com/details/dates>

Official title: **"The Dawn of Superintelligence | Kaya AI Grand Challenge"** — "Our India
Hackathon is back for Edition 2". Host: Kaya AI. Prize pool $3,000 cash.

## Key dates (IST)

| Date | Event |
|---|---|
| Nov 9, 2026 | "Registrations open and Round 1 starts. Problem statements released" (rules page) |
| Nov 30, 2026 06:00 IST | Devpost submission period opens (schedule page) |
| **Dec 6, 2026 23:45 IST** | **Submissions close** — "Round 1 (Build) closes" |
| Dec 12, 2026 | Top 10 teams announced; Round 2 (Finals) starts |
| Dec 17, 2026 | Live finale in Mumbai; winners announced (09:00 IST per schedule page) |
| Dec 18, 2026 | Winners go to The Chainsmokers concert in Mumbai |

## Eligibility — Students division

- "Open to students from IITs and colleges across India, and to working professionals."
  Devpost lists the eligible country as **India** only; "Above legal age of majority in country of residence".
- "Two divisions, Students and Professionals, with the same tracks and challenges, ranked separately."
  "Your division depends on who is on your team, not on the challenge you pick."
- **"Teams of 2 to 4 members; solo submissions will not be accepted."** Each participant can be on one team only.
- "Mixed teams: if a team has both students and working professionals, it enters the Professionals division."
- Edition 1 top-10 finalists cannot enter.
- Prize: Students Division Winner **$1,500 cash** + The Chainsmokers live in Mumbai on Dec 18, 2026.

## Tracks

1. **Track 01: Amber General Intelligence (AGI)** — breadth: "one general agent that can take any job and carry it through to the end".
2. **Track 02: Contextual Intelligence** — awareness of the physical site (no fixed problem statement).
3. **Track 03: Vertical Agents (Amber sub-agents)** — depth: specialists Amber calls on.

"Your team picks one challenge." / "One entry per team, in one challenge."

### Track 01 — challenge statements (verbatim headings)

Your challenge: "build Amber Computer, a general-purpose agent for construction. Think Devin, but for
construction. Give it a job in plain English … It plans the steps, pulls context from any source, uses
whatever tools the job needs, and carries the work through to the end, over many steps and many days."

Directions: handling the unexpected job; finding the right context; planning and adapting; working
with specialists; **"Staying with the job. How does it keep track over days, recover from failures, and
pick up after a restart without repeating itself?"**; knowing when to ask.

"What we're looking for: an agent that handles more than one kind of job, grounded in real construction
work, with good judgment and a clear trail a project manager can follow."

**Extra rules for Track 01** ("the agent takes actions, not just answers"):
- "Asks a human before anything that can't be undone"
- "Logs every action it takes and every specialist it calls"
- "Keeps its own record of where each job stands, so it can pick up again after a restart"

**1.1 Amber Computer: any job, end to end** — Input: a plain-English job (e.g. "Chase every submittal
more than a week late…") plus access to mailbox, files, schedule, tools. Output: "the job done: emails
sent (with approval where needed), records updated, and a short report back, plus a log of every step."

**1.2 The conductor: orchestrating specialist agents** — Input: "a big goal, such as 'Get the 480 V
switchgear package for Project Alpha ordered by 2027-03-15 within budget X', and a set of specialist
agents it can call … each described by what it takes in and what it returns." Output: "the plan, which
specialist handled each step, how their outputs were checked and combined, and the final result."
Good looks like: "disagreements between specialists are caught instead of passed on, and a person can
follow how the final result was reached."

**1.3 Work that takes days, not minutes** — "A vendor replies three days later, an approver is on leave,
a price changes after the quote, a tool fails halfway through." Input: "a multi-step job and a stream of
events over simulated days: replies arriving late, dates slipping, documents missing, tool calls
failing, and the agent being stopped and restarted." Output: "the updated plan and the actions taken at
each point, plus the agent's saved state." Good looks like: "it recovers from setbacks on its own where
it can, **never does the same thing twice (two emails to the same vendor, two orders)**, picks up
correctly after a restart, and leaves a trail a project manager can follow."

## What every entry must do (all tracks)

- "Return structured output (for example JSON), not only free text, so another agent can use it"
- **"Be callable by another agent: run as an MCP server, so Amber can connect to it directly"**
- "Show its sources for every answer: the document, page, row, photo, recording or website it came from"
- **"Give a confidence score with each answer, and hand off to a human when it isn't sure instead of guessing"**
- "Never make things up. Invented vendors, products, model numbers or sources are heavily penalized"
- "Be easy to run, with a README and simple setup steps"
- **"Name the AI models used, with a rough cost and response time per run"**

"Go deeper than an API call": long-running plans and memory, tool use with every step logged, document
understanding, forecasting ("honest ranges, not single guesses, for lead times"), linking records.

## Judging (Round 1, from Resources page)

| Criterion | Weight | What judges look for |
|---|---|---|
| Accuracy | **40%** | Does it get the job right on realistic examples? |
| Customer value | **30%** | Would a procurement manager or superintendent use it tomorrow, as a product? |
| Trustworthiness | **20%** | Sources cited, sensible confidence scores, nothing made up |
| Build quality | **10%** | Easy to run, cost and speed per run, code quality |

"An agent that says 'not sure, check with a human' scores better than one that confidently gives a wrong
answer." Round 1: "The Kaya team, together with Edition 1's winning teams, **tries each agent on
realistic examples for its challenge**." Round 2 adds weight on improvement during Round 2.

## Submission requirements ("What to Submit", by Sunday, December 6, 2026)

1. Your track and challenge, and your division (Student or Professional)
2. Code repository link, with a README explaining setup and how to run the agent
3. **Demo video of up to 5 minutes** "showing the agent solving a realistic example from start to finish"
   (our video targets ≤ 3:00 — well inside the limit)
4. **Pitch deck of 8 to 10 slides**
5. Names and affiliations (college or company) of all team members

"Round 1 submissions without a working repo and a demo video will be considered ineligible."

## Open source / third-party code / data

- "All submissions must be original work created during the hackathon period."
- "Any AI model, framework or language is allowed, as long as you name the models and report cost per run."
- "Build with your own tools and data. Use public sources, or sample data you prepare yourselves, and explain how you got it."
- "Public data is allowed and must be cited. Don't use confidential client data."
- "A fabricated source, vendor, product or model number is heavily penalized."
- "IP terms for entries will be shared before launch" — no IP terms were published on the pages at fetch time; re-check before submitting.

Implications for SiteMind: third-party OSS libraries are fine (frameworks allowed) but must be credited
(see `CREDITS.md`); our own code must be written in the hackathon window. Synthetic vendors
(Voltaris, Kestrel, Anvil) must be **clearly labelled as synthetic/mock** in README, UI and video so they
are not read as "invented vendors" passed off as real. Name the model (Qwen2.5-3B-Instruct via Ollama,
local CPU ⇒ ~$0 per run) and state measured response time per run.

## Recommendation — which Track 01 challenge

**Enter Track 01, challenge "1.3 Work that takes days, not minutes".**

Why: SiteMind's headline capability — a durable LangGraph agent checkpointed after every task, a
simulated multi-day event stream (late replies / vendor timeouts, a post-quote price revision, deadline
slip), SIGKILL of the worker mid-run and resume from checkpoint, and an idempotency ledger that proves no
action ran twice — maps one-to-one onto 1.3's input ("tool calls failing, and the agent being stopped and
restarted") and its "good looks like" ("never does the same thing twice … picks up correctly after a
restart"). Its required output ("the updated plan and the actions taken at each point, plus the agent's
saved state") is exactly plan v1→v2, the timeline/audit log, and the checkpoint/ledger we show.

Strong secondary fit: **"1.2 The conductor: orchestrating specialist agents"** — our demo goal is the
literal example input of 1.2 and we orchestrate takeoff / quotes / schedule / budget / approvals / PO
specialists. In the Devpost write-up, state "Track 01 – 1.3 Work that takes days, not minutes" and
mention that the same run also demonstrates the 1.2 conductor pattern (plan, specialist per step,
cross-checks such as budget-vs-quote disagreement → re-plan). If the team prefers to be judged on the
specialist orchestration rather than durability, choose 1.2; do not choose 1.1 (needs mailbox/any-job breadth).

## Checklist gaps to watch

- Team must have **2–4 members, all students**, for the Students division.
- MCP server must be runnable and documented (`sitemind/mcp_server.py`).
- Confidence score on outputs + human hand-off when unsure.
- Pitch deck (8–10 slides) is a separate deliverable from the video.
- README: models used, cost per run, response time per run, one-command setup (`docker compose up` / `scripts/dev.sh`).
