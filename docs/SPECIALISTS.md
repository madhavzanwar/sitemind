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

`backend/scripts/make_spec_pdf.py` (default `--package swgr-480v`) generates
`sitemind/data/packages/swgr-480v/project_alpha_480V_switchgear_spec.pdf`.
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
"SPD-T1-200KA: p3 shows 3 ea … schedule lists 4 ea; schedule quantity used - raise an
RFI". Each line's `source` points to its row, for example
`project_alpha_480V_switchgear_spec.pdf p4 table 1 row 1`.

## Vendors (`data/packages/swgr-480v/vendors.json`, synthetic)

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

## Demo scenario (`swgr-480v/scenario_demo.json`): what actually happens

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

## v2: packages, goal parsing, any-PDF takeoff, live events

### Package layout

Each package is a folder `backend/sitemind/data/packages/<package_id>/`. Adding a package means
adding a folder; no code changes are needed. A folder holds:

- `package.json`: a `PackageSpec`, plus three extra keys:
  - `categories`: item classification rules (catalogue item codes and keywords)
  - `cross_checks`: drawing and datasheet checks for the takeoff
  - `po_terms`: package-specific PO terms
- `vendors.json`: vendor profiles, unit prices and a `rate_card` per category. Each vendor also
  has a `rate_card_factor`.
- `scenario_demo.json` and `scenario_happy.json`
- the sample spec PDF

Two packages ship today:

| id | title | vendors | need-by | budget | required on site |
|---|---|---|---|---|---|
| `swgr-480v` | 480 V switchgear | V1 V2 V3 | 2027-03-15 | ₹4.6 Cr | 2027-07-30 |
| `dg-2mw` | 2 MW DG sets | D1 D2 D3 | 2027-04-30 | ₹38 Cr | 2027-11-15 |

`SPEC_PDF`, `load_vendors()` and `load_scenario(name)` still work. They are aliases for the
default package `swgr-480v`, and the switchgear numbers are unchanged. `vendor_profile(id)`
searches every package. Vendor ids are unique across packages.

### New functions (`sitemind.specialists`)

**Packages**

```python
list_packages() -> list[PackageSpec]
package_ids() -> list[str]
get_package(package_id) -> PackageSpec            # KeyError if unknown
package_spec_pdf(package_id) -> Path
load_package_catalog(package_id) -> dict
load_package_scenario(package_id, scenario) -> dict
load_package_raw(package_id) -> dict
package_for_vendor(vendor_id) -> str
package_po_terms(package_id) -> list[str]
match_package(text) -> tuple[str | None, float, str | None]
classify_line(line, package_id=None) -> tuple[str, str] | None   # (package_id, category)
```

**Goal parsing**

```python
parse_goal(text, today) -> GoalParseResult
```

**Takeoff**

```python
run_takeoff(pdf_path, package_id=None) -> TakeoffResult          # package auto-detected if None
```

`takeoff.header_role`, `takeoff.map_columns` and `takeoff.parse_qty` are also available.

**Vendor network**

```python
VendorNetwork(scenario, catalog=None, overrides=None)
```

- `.package_id` comes from the catalogue or scenario.
- `.overrides` returns a JSON-serialisable copy of the live state.
- `.apply_event(kind, vendor_id, params) -> str`
- `.missing_documents(vid)`, `.reply_delay_days(vid)` and `.price_factor_override(vid)`
- `.response_hours(vid)` now includes any injected reply delay.
- `.refresh_quote(vid, quote, now, lines=None)`

`EVENT_KINDS` and `EVENT_ALIASES` are exported with it.

**Approvals**

```python
approvals.missing_documents_from_notes(notes) -> list[str]
```

### `parse_goal`

The parser is deterministic and never invents a value. It reads four fields:

- **Package**: matched on catalogue keywords.
- **Project**: "Project X" or "X project".
- **Need-by date**:
  - Formats: ISO `2027-03-15`, `15 March 2027`, `15th March 2027`, `March 15, 2027`,
    `Mar 1 2027`, `30/04/2027` (Indian dd/mm/yyyy), and relative forms such as `in 10 weeks`
    or `within 90 days`.
  - A date that follows "ordered by", "PO by", "by" or "before" is preferred.
  - A date that follows "on site", "delivered" or "commissioning" is not used as the order-by
    date.
- **Budget**: `₹4.6 Cr`, `Rs 46,00,000`, `4.6 crore`, `460 lakh`, `INR 46000000`, `46 million`
  or `₹3,80,00,000`. The amount needs a currency or a unit; "30 m" is read as metres.

For every value it returns, `evidence[field]` holds the exact span of the input it came from.

Cases where it asks instead of guessing:

| Input | What happens |
|---|---|
| Month without a day ("end of April 2027") | Left missing; the question suggests 2027-04-30 |
| Bare budget ("budget 38") | Left missing; asks "rupees, lakh or crore?" |
| Invalid date (2027-02-30) | Left missing; asks for the date |
| Only a site date | Left missing; asks for the order-by date |
| Date in the past | Kept, with a question |
| Unknown package ("chillers") | `supported=False`, `package_id=None`, `package="chillers"`, and a hand-off question naming the supported packages |
| No package at all | `missing=["package"]` with a question |

Confidence is the mean of the four fields' confidences: 1 for a field read cleanly, 0 for a
missing one, and the match score for the package.

### Generalised `run_takeoff`

The takeoff works on any spec PDF.

**Finding the table**

1. pdfplumber ruled tables are tried first. A table qualifies when its header (first three
   rows) has a quantity column plus a code or description column.
2. Pages without a qualifying table fall back to a word-position parser. It finds a header line,
   takes the column x-positions, and slices the following lines into those columns. This adds a
   warning and uses a base confidence of 0.85.

**Header synonyms**

| Role | Accepted headers |
|---|---|
| Code | item code / code / tag / tag no / mark / ref |
| Description | description / equipment / item description / particulars |
| Quantity | qty / quantity / nos / no. off / number / count |
| Unit | unit / uom |
| Rating | rating / capacity / specification / size / duty / capacity |

A bare "Item" or "Sl. No." column is treated as a serial number and ignored.

**Quantities and units**

- Quantities such as `1,200` and `4 Nos` parse.
- Units are normalised: nos → ea, mtr → m.
- A missing code becomes a slug of the description.
- A row with an unreadable quantity becomes a warning. Rows are never dropped silently.

**Sources**

- Ruled-table rows: `"<file> p<page> table <t> row <r>"`.
- Text-fallback rows: `"<file> p<page> text row <r>"`.

**Classification**

Each line is classified to a category of the detected package. An unclassified line is kept,
gets a warning, and costs 0.05 confidence, up to 0.40 in total. If no line classifies at all,
the result is capped at 0.5 confidence and gets a "hand to a human buyer" warning.

**Cross-checks**

Cross-checks are declared in `package.json`:

- `count_unique`: count distinct tags
- `sum`: add up run lengths
- `value`: read one value from a datasheet

Each one runs on pages that contain its `page_marker`. A mismatch costs 0.06. A missing marker
page costs 0.15.

**Results on the three test PDFs**

| PDF | Layout | Result |
|---|---|---|
| swgr-480v spec | 4 sheets, ruled schedule, single-line diagram | 8 lines, 0.92, 1 warning (SPD 3 vs 4), unchanged |
| dg-2mw spec | 4 sheets: banner cover, landscape equipment list with **two** ruled tables (Tag / Equipment / Specification / Quantity / UoM / Notes), datasheet (Parameter/Value table, correctly ignored), scope page | 7 lines, 0.92, 1 warning |
| `tests/fixtures/chiller_schedule_thirdparty.pdf` | Foreign one-page HVAC schedule; unruled Times text; headers Mark / Equipment / Duty / Capacity / No. Off / Location | 5 lines via text fallback (CH-1 ×4, CHWP-1 ×6, CT-1 ×4, AHU-1 ×12, EXP-1 ×2); all flagged unclassified; confidence 0.50; hand-to-human warning |

The DG warning is "CBL-11KV-3C300: p3 shows 1350 m (datasheet cable route length) but the
schedule lists 1200 m".

Regenerate the PDFs with `python scripts/make_spec_pdf.py --package {swgr-480v|dg-2mw|chiller-fixture|all}`.
The output is byte-deterministic.

### Live events: `VendorNetwork.overrides` and `apply_event`

`overrides` has the shape `{"vendors": {vid: {...}}, "log": [...]}`. It is plain JSON. The
graph stores it in its facts and passes it back to `VendorNetwork(..., overrides=...)` after a
restart. The network deep-copies it on the way in and on the way out.

| kind (alias) | params | effect |
|---|---|---|
| `delay_reply` (`vendor_late_reply`) | `days` | `response_hours` += 24·days for every later reply |
| `price_change` | `pct` | Prices × (1 + pct/100), compounding. Applies to new quotes; the next refresh returns a new revision. |
| `lead_slip` (`date_slip`) | `days` (± allowed) | Lead time + days. Applies to new quotes; the next refresh returns a new revision. |
| `missing_document` (`document_missing`) | `document` | Added to `missing_documents(vid)`. Quotes note "Missing document: …". |
| `document_received` | `document` | Removed from `missing_documents(vid)` |
| `timeout` | `count`, `from_attempt=1` | Those attempt numbers raise `VendorTimeout` |

An unknown kind raises `ValueError`. An unknown vendor for the package raises `KeyError`.

**Refresh is state-based.** `refresh_quote` rebuilds the quote the vendor would issue now, from
the scenario revision plus all overrides. It returns `revision + 1` only if the prices or lead
time differ from the quote passed in. Otherwise it returns the quote unchanged. This makes it
idempotent and safe to replay: refreshing the same quote twice, or after a restart, gives
identical results.

**Missing documents** come from the scenario's `missing_documents` plus injected ones, minus
received ones. `rank_options` reads them from the quote notes. It adds "submittal incomplete …
PO cannot be released until received" to the option rationale and a matching risk to the memo.

**Rate-card pricing**

- An item missing from the vendor's price table is priced from `rate_card[category]` if it
  classifies to a category: the flat rate, or a per-rating rate (e.g. ₹390/A for breakers,
  ₹24,800/kVA for gensets), times the vendor's `rate_card_factor`.
- The quote notes say `Rate-card estimate: <code> (<category>, base INR <n>/<unit>)`. On
  refresh the estimate is re-derived from that recorded base, so the takeoff lines are not
  needed.
- An item that does not classify is excluded and listed under "Not quoted …".

## DG package (`dg-2mw`): vendors and demo numbers

Takeoff for 4 × 2 MW sets:

| Item code | Description | Qty |
|---|---|---:|
| DG-2000-11KV | 2000 kWe / 2500 kVA DG set, 11 kV | 4 |
| ENCL-AC-75DBA | Acoustic enclosure | 4 |
| TANK-DAY-990L | Day tank | 4 |
| SYNC-PNL-11KV | Synchronising panel | 1 set |
| EXH-STACK-30M | Exhaust stack | 4 sets |
| NGR-11KV-200A | Neutral grounding resistor | 4 |
| CBL-11KV-3C300 | 11 kV XLPE cable | 1,200 m |

The list-price total is ₹30.62 Cr.

| | D1 Tarangini Gensets Pvt Ltd | D2 Corvane Diesel Systems | D3 Halvik Engines & Alternators |
|---|---|---|---|
| City | Pune | Hosur | Rajkot |
| Reliability | 0.84 | 0.92 | 0.88 |
| Lead time | 245 d | 180 d | 240 d |
| Freight | ₹18,00,000 | ₹22,00,000 | ₹35,00,000 |
| Validity / response | 30 d / 28 h | 15 d / 22 h | 45 d / 40 h |
| **Quote total (ex-GST)** | **₹29,25,71,200** | **₹32,06,12,000** | **₹30,35,48,000** |
| Demo failure | CPCB IV+ emissions type-approval certificate missing | +15 % on refresh (USD/INR + steel) | Lead time +45 d on refresh (alternator line re-allocated) |
| Latest zero-float PO | 2027-02-07 | 2027-04-13 | 2027-02-12 (2026-12-29 after the slip) |

All names are fictional. D1 to D3 have no expedite offer.

These figures assume a budget of ₹38 Cr (₹380,000,000), required on site 2027-11-15, a PO
date of 2027-01-20 (299 days to site) and 5 % contingency.

**Initial quotes**

| Option | Committed | Util. | Verdict | Delivery | Float | Score |
|---|---:|---:|---|---|---:|---:|
| **O-D2** (recommended) | 33,66,42,600 | 88.6 % | ok | 2027-08-24 | +83 | 0.716 |
| O-D3 | 31,87,25,400 | 83.9 % | ok | 2027-10-23 | +23 | 0.676 |
| O-D1 | 30,71,99,760 | 80.8 % | ok | 2027-10-28 | +18 | 0.633 |

**Refresh before award, which forces a re-plan**

- D2 issues revision R2. The quote rises from ₹32,06,12,000 to ₹36,83,73,600. Committed becomes
  ₹38,67,92,280, which is **101.8 %: breach**.
- D3 issues revision R2. The price is unchanged, but the lead time moves from 240 to 285 days.
  Delivery becomes 2027-12-07, at **−22 d float: late**.
- D1 is unchanged. Its CPCB IV+ certificate is still missing.

**Re-plan ranking**

| Option | Committed | Util. | Verdict | Float | Score | |
|---|---:|---:|---|---:|---:|---|
| **O-D1** Tarangini | 30,71,99,760 | 80.8 % | ok | +18 | 0.633 | **recommended**; memo risks list the 84 % on-time record and the incomplete submittal |
| O-D2 Corvane rev 2 | 38,67,92,280 | 101.8 % | **breach** | +83 | 0.533 | infeasible |
| O-D3 Halvik rev 2 | 31,87,25,400 | 83.9 % | ok | **−22** | 0.408 | infeasible |

Expected path:

1. Plan v1, takeoff (7 lines, 1 warning) and RFQ to D1, D2 and D3. No timeouts.
2. Evaluation recommends D2.
3. Refresh: D2's revision breaches the budget and D3's slip misses the date.
4. **Re-plan v2.**
5. The memo recommends D1.
6. **Chase the CPCB IV+ certificate.** PO release to D1 is blocked until it is received or
   waived (the graph's docs task applies `document_received`).
7. Vendor approval, then PO, then PO-release approval, then send.

**Draft PO for O-D1** (lines 29,07,71,200 + freight 18,00,000 + GST 18 % 5,26,62,816):
**₹34,52,34,016**. It uses the DG terms: ISO 8528-6 witnessed load-test FAT, CPCB IV+
certificate before release, and a 24-month or 5,000-hour warranty.

**Happy scenario**: no failures and no missing document. O-D2 is recommended, and the PO total
is ₹37,83,22,160.

## MCP server

`python -m sitemind.mcp_server` serves over stdio. `python -m sitemind.mcp_server --http
--port 8765` serves streamable HTTP at `/mcp`. It uses the official MCP Python SDK: `MCPServer`
on SDK v2 and `FastMCP` on v1, which have the same decorator API.

The tools are:

- `list_packages()` (v2)
- `parse_goal(text, today?)` (v2)
- `takeoff_from_pdf(pdf_path?, package_id?)`
- `request_vendor_quotes(vendor_ids?, scenario, now, max_attempts, refresh, package_id, overrides?)`,
  which also returns expedite offers and missing documents
- `compute_schedule(lead_time_days, po_issue_date, required_on_site, vendor_id)`
- `check_budget(quote, budget_inr, contingency_pct, expedite_fee_inr)`
- `rank_vendor_options(scenario, po_issue_date, required_on_site?, budget_inr?, refreshed,
  package_id)`, which returns the options, the memo, the attempts, the schedules, the budgets
  and the missing documents
- `draft_purchase_order(option_id?, scenario, po_number, po_issue_date, ..., package_id)`
- `list_specialists()`

Where a tool takes `package_id`, it defaults to `swgr-480v`. Dates and budget default to the
package's own values.

The tools are stateless. Any tool that needs quotes re-derives them from the scenario, which is
deterministic.
