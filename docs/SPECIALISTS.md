# SiteMind specialists, vendor data & demo numbers

All specialist code lives in `backend/sitemind/specialists/` and is **pure and deterministic**:
no wall clock, no network, no LLM. Same inputs give the same outputs, so a run that is resumed
from a checkpoint reproduces identical quotes, schedules and memos. The LLM only *words* things
(for example the decision-memo prose through `build_decision_memo(..., prose=...)`). It never
does the arithmetic.

**Money basis.** All money is in INR **ex-GST**. GST at 18 % is recoverable as input tax credit,
so it is left out of the budget check and shown only on the PO. `Quote.total_inr` is the sum of
the line totals plus freight. The budget check adds 5 % contingency and any expedite fee to that.

## Specialists

| name | module · function | inputs | outputs | MCP tool | deterministic | side effects |
|---|---|---|---|---|---|---|
| planner | (core) `planner.py` | Goal, facts | Plan | `list_specialists` | no (LLM rationale) | no |
| takeoff | `takeoff.run_takeoff(pdf_path)` | spec PDF | `TakeoffResult` | `takeoff_from_pdf` | yes | no |
| quotes | `quotes.collect_quotes(network, vendors, lines, now, max_attempts=3, retry_interval=0)`, `quotes.refresh_quotes(network, quotes, now)` | takeoff lines, vendor ids, sim now, scenario | `QuotesResult` (quotes + `VendorAttempt`s) | `request_vendor_quotes` | yes | yes (RFQ = ledgered by core) |
| schedule | `schedule.schedule_for_quote(quote, po_issue_date, required_on_site)`, `critical_path(activities, deadline_offset=None)`, `schedule_for_lead_time(vendor_id, lead, po, ros)`, `latest_po_date(lead, ros)` | quote / lead time, PO date, ROS date | `ScheduleResult` | `compute_schedule` | yes | no |
| budget | `budget.check_budget(quote, budget_inr, contingency_pct=0.05, expedite_fee_inr=0.0)` | quote, budget | `BudgetCheck` | `check_budget` | yes | no |
| approvals | `approvals.rank_options(quotes, schedules, budgets, expedite_offers)`, `approvals.build_decision_memo(goal, options, situation, prose=None)` | quotes, schedules, budgets, expedite offers | `VendorOption[]`, `DecisionMemo` | `rank_vendor_options` | yes (prose is optional) | no |
| po | `po.draft_po(goal, option, quote, takeoff, po_number, issued, vendor=None)` | approved option, quote, takeoff | `PurchaseOrder` (+ `.markdown`) | `draft_purchase_order` | yes | yes (send = ledgered by core) |

The registry is `specialists.registry.REGISTRY` and `get_specialist(name)`. Everything is
re-exported from `sitemind.specialists`.

Helpers outside the contract:

- `VendorNetwork.vendor_ids()`, `.profile(id)`, `.response_hours(id)` (sim hours for a
  successful round trip, used to advance the clock), `.timeout_hours(id)` (24 h),
  `.will_timeout(id, attempt)`, `.expedite_offer(id)` and `.expedite_offers()`, which returns
  `dict[str, ExpediteOffer]`.
- `ExpediteOffer` (pydantic: `vendor_id, days_saved, fee_inr, description`) lives in
  `specialists/vendors.py`, not in `models.py`.
- `load_scenario("demo"|"happy")`, `load_vendors()`, `vendor_profile(id)`, `SPEC_PDF`, `DATA_DIR`.

### Behaviour notes for core

- **Clock.** `collect_quotes` never advances a clock. Attempt *k* is stamped
  `now + (k-1)*retry_interval`, and `retry_interval` defaults to 0. For per-step durability,
  core can instead call `network.request_quote(vid, lines, attempt, now)` itself, catch
  `VendorTimeout` (which has `.vendor_id`, `.attempt` and `.timeout_hours`), and advance the
  SimClock by `timeout_hours` or `response_hours`.
- **Timeouts.** A vendor that is still silent after `max_attempts` comes back as a placeholder
  quote with `status="timeout"`, no lines and a total of 0. `check_budget` gives it the
  verdict `breach` ("no priced quote"), and `rank_options` skips it.
- **Revisions.** `refresh_quote` revises a quote at most once, and only when the scenario says
  so. The revised quote has `revision=2`, `status="revised"` and quote id
  `Q-V2-<date>-R2`. `refresh_quotes` returns `(quotes, attempts)`, with
  `outcome="revised"` for the vendor that revised.
- **Ranking.**
  - `rank_options` adds one expedited variant `O-<vid>X` for each expedite offer. It uses the
    same PO and ROS dates as the base schedule and the same contingency rate.
  - Option ids are `O-V1`, `O-V2`, `O-V3` and `O-V3X`.
  - `VendorOption.total_inr` is the quote total plus the expedite fee. It excludes contingency
    and GST.
  - Exactly one feasible option has `recommended=True`. Infeasible options (budget breach or
    late delivery) are ranked last and are never recommended.
- **Scoring** (from 0 to 1):
  `0.40·clamp((1−util)/0.25) + 0.35·clamp(float/30) + 0.25·clamp((rel−0.70)/0.30)`.
- **Budget verdict.** `ok` below 90 %, `warn` from 90 % to 100 % inclusive, `breach` above 100 %.
- **CPM network.**
  - The main chain is PO(0) → SUB 14 → APR 10 → MFG (lead time), followed by FAT 5 → SHP 7 →
    DEL(0).
  - MFG runs in parallel with ITP (21 days, also after APR). FAT depends on both MFG and ITP.
  - The chain is 36 days + lead time. `float_days` is the ROS date minus the delivery date.

## Sample document & takeoff

`backend/scripts/make_spec_pdf.py` generates `sitemind/data/project_alpha_480V_switchgear_spec.pdf`.
The output is deterministic: the same build always produces the same bytes. The PDF has 4 sheets:

1. Cover
2. General requirements (IEC 61439, 65 kA, FAT, LDs 0.5 %/wk capped at 10 %, 24-month warranty)
3. Single-line diagram
4. Equipment schedule

The takeoff reads the schedule table and cross-checks it against the labels on the drawing:

| item_code | description | rating | qty | unit | drawing check |
|---|---|---|---:|---|---|
| SWGR-MAIN-4000A | Main LV switchgear lineup, draw-out ACB incomer | 4000 A, 65 kA | 4 | ea | 4 SWGR tags ✓ |
| BKR-TIE-4000A | Bus-tie ACB | 4000 A, 65 kA | 2 | ea | 2 ✓ |
| BKR-FDR-1600A | Feeder ACB LSIG | 1600 A, 65 kA | 8 | ea | 8 ✓ |
| BKR-FDR-800A | Feeder MCCB LSI | 800 A, 65 kA | 16 | ea | 16 ✓ |
| ATS-1200A-4P | ATS 4-pole | 1200 A | 4 | ea | 4 ✓ |
| MTR-PQ-02S | PQ meter | Class 0.2S | 10 | ea | 10 PQM tags ✓ |
| SPD-T1-200KA | SPD Type 1+2 | 200 kA | 4 | ea | **3 on drawing → warning** |
| BUSWAY-4000A-CU | Cu busway | 4000 A | 120 | m | 4 × 30 m runs (linear) ✓ |

The result has `confidence = 0.92` (0.98 minus 0.06 for one mismatch) and 1 warning:
"SPD-T1-200KA: drawing p3 shows 3 ea … schedule lists 4 ea; schedule quantity used - raise an
RFI". Each line's `source` points to its row, for example
`project_alpha_480V_switchgear_spec.pdf p4 table 1 row 1`.

## Vendors (`data/vendors.json`, synthetic)

| | V1 Voltaris Switchgear Pvt Ltd | V2 Kestrel Power Systems | V3 Anvil Electric India |
|---|---|---|---|
| City | Nashik | Vadodara | Chennai |
| Reliability (on-time) | 0.82 | 0.93 | 0.90 |
| Lead time (from approval) | 140 d | 112 d | 168 d |
| Freight | ₹3,60,000 | ₹4,80,000 | ₹7,80,000 |
| Quote validity | 30 d | 14 d (3 % early-order discount) | 45 d |
| Response time (sim) | 30 h | 20 h | 44 h |
| Expedite | – | – | −42 d for ₹26,00,000 |
| Payment | 10/80/10 (ABG) | 20/70/10 (ABG, PBG) | 0/90/10 retention |
| Incoterms | DAP site | CPT site | DAP site |

Unit prices per item code are in `vendors.json` (`unit_prices_inr`). V2's prices are list
prices. Its first quote applies the 3 % discount, rounded to the nearest ₹100.

## Demo scenario (`scenario_demo.json`): what actually happens

These dates assume a sim start of 2027-01-11 09:00 IST, a budget of ₹4,60,00,000, an ROS date
of 2027-07-30 and a reference PO issue date of **2027-01-20**. That gives 191 days from PO to
ROS.

### 1. RFQ

- V1 times out on attempt 1 and on attempt 2 (24 h each). It answers on attempt 3.
- V2 and V3 answer on their first attempt.

| Quote | Lines | Freight | **Total (ex-GST)** | Lead |
|---|---:|---:|---:|---:|
| Q-V1-…-R1 | 3,51,15,400 | 3,60,000 | **₹3,54,75,400** | 140 d |
| Q-V2-…-R1 | 3,81,71,400 | 4,80,000 | **₹3,86,51,400** | 112 d |
| Q-V3-…-R1 | 3,64,78,400 | 7,80,000 | **₹3,72,58,400** | 168 d |

### 2. Evaluation of the initial quotes

| Option | Committed (quote + 5 % cont. + fee) | Utilisation | Verdict | Delivery | Float | Score |
|---|---:|---:|---|---|---:|---:|
| **O-V2** (recommended) | 4,05,83,970 | 88.2 % | ok | 2027-06-17 | +43 | 0.730 |
| O-V3X | 4,17,21,320 | 90.7 % | warn | 2027-07-01 | +29 | 0.654 |
| O-V1 | 3,72,49,170 | 81.0 % | ok | 2027-07-15 | +15 | 0.579 |
| O-V3 | 3,91,21,320 | 85.0 % | ok | 2027-08-12 | **−13** (late) | 0.406 |

### 3. Refresh before award: V2 revises its quote

V2 issues revision R2. It adds a +11 % raw-copper surcharge and withdraws the 3 % early-order
discount because the 14-day validity has lapsed.

- New unit price = list price × 1.11.
- The quote rises from ₹3,86,51,400 to **₹4,41,66,800**, which is +14.3 % on the quote.
- Committed becomes ₹4,63,75,140, or **100.8 % of budget: breach**, ₹3,75,140 over the ceiling.

### 4. Re-plan v2: ranking after the revision

| Option | Committed | Util. | Verdict | Delivery | Float | Reliability | Score | |
|---|---:|---:|---|---|---:|---:|---:|---|
| **O-V3X** Anvil expedited | 4,17,21,320 | 90.7 % | warn | 2027-07-01 | **+29** | 0.90 | 0.654 | **recommended** |
| O-V1 Voltaris | 3,72,49,170 | 81.0 % | ok | 2027-07-15 | +15 | 0.82 | 0.579 | feasible |
| O-V2 Kestrel rev 2 | 4,63,75,140 | 100.8 % | **breach** | 2027-06-17 | +43 | 0.93 | 0.542 | infeasible |
| O-V3 Anvil standard | 3,91,21,320 | 85.0 % | ok | 2027-08-12 | **−13** | 0.90 | 0.406 | infeasible |

What the decision memo weighs:

- O-V1 is ₹43.8 L cheaper than O-V3X. It has 14 fewer days of float (+15 against +29) and an
  82 % on-time record against 90 %.
- O-V3X pays ₹26 L to buy schedule certainty ahead of the energisation window. The memo
  recommends tying that fee to the delivery milestone and to LDs.
- Risks listed in the memo:
  - O-V3X sits above the 90 % budget warning line.
  - O-V3X's expedite fee must be tied to the milestone.
  - O-V1's on-time record is 82 %.
  - When the PO is issued on 2027-01-22 or later, O-V1 also has less than 14 days of float.

The human approves the vendor selection. They can choose O-V3X or O-V1.

### 5. Draft PO totals

Both POs below are dated 2027-01-20.

| | O-V3X (Anvil) | O-V1 (Voltaris) |
|---|---:|---:|
| Subtotal (equipment) | 3,64,78,400 | 3,51,15,400 |
| Freight | 7,80,000 | 3,60,000 |
| Expedite fee | 26,00,000 | 0 |
| GST 18 % | 71,74,512 | 63,85,572 |
| **Total payable** | **₹4,70,32,912** | **₹4,18,60,972** |

### PO-date sensitivity

The float for each option is `(ROS − PO date) − (36 + lead)`. The latest PO date that still
gives zero float is:

| Option | Latest zero-float PO date |
|---|---|
| V2 | **2027-03-04** (earlier than the 2027-03-15 need-by date) |
| V3X | 2027-02-18 |
| V1 | 2027-02-04 |
| V3 standard | 2027-01-07 (before the sim starts, so V3 needs the expedite) |

With a PO on 2027-02-01, the floats become V1 +3, V3X +17, V2 +31 and V3 −25. The
recommendation is still O-V3X.

## Happy scenario (`scenario_happy.json`)

- Every vendor answers on its first attempt.
- Refreshing a quote does not change it.
- O-V2 is recommended (88.2 %, +43 d).
- V3's expedite offer is still listed as O-V3X.

## MCP server

`python -m sitemind.mcp_server` serves over stdio. `python -m sitemind.mcp_server --http
--port 8765` serves streamable HTTP at `/mcp`. It uses the official MCP Python SDK: `MCPServer`
on SDK v2 and `FastMCP` on v1, which have the same decorator API.

The tools are:

- `takeoff_from_pdf(pdf_path?)`
- `request_vendor_quotes(vendor_ids?, scenario, now, max_attempts, refresh)`
- `compute_schedule(lead_time_days, po_issue_date, required_on_site, vendor_id)`
- `check_budget(quote, budget_inr, contingency_pct, expedite_fee_inr)`
- `rank_vendor_options(scenario, po_issue_date, required_on_site, budget_inr, refreshed)`, which
  returns the options, the memo, the attempts, the schedules and the budgets
- `draft_purchase_order(option_id?, scenario, po_number, po_issue_date, ...)`
- `list_specialists()`

The tools are stateless. Any tool that needs quotes re-derives them from the scenario, which is
deterministic.
