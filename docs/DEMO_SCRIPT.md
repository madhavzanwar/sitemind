# SiteMind demo video script

| | |
|---|---|
| Target length | 2:51 (hard cap 2:58; Devpost allows up to 5:00) |
| Spoken words | 386, at about 150 words per minute plus pauses |
| Job shown | Project Alpha, 24 MW Tier-III data centre, Chakan MIDC, Pune |
| Goal typed | "Get the 480 V switchgear package for Project Alpha ordered by 2027-03-15 within budget ₹4.6 Cr" |
| Scenario | `demo` (deterministic failures), real backend, local model |
| Machine source | [`demo/script.yaml`](../demo/script.yaml), rendered by `demo/run_demo.sh` (`make demo`) |

The ten scenes, their titles and their on-screen actions match `demo/script.yaml`. The
voiceover below extends that file's narration from 314 to 386 words; the added or changed
sentences are listed in [Differences from `demo/script.yaml`](#differences-from-demoscriptyaml)
so the two can be brought in line.

On-screen label for the whole video: **"Vendors, prices and project data are synthetic."**
Long agent waits are time-lapsed and labelled with the speed factor.

## Scene table

| # | Time | On-screen action | Voiceover | Subtitle |
|---|---|---|---|---|
| 1 | 0:00–0:23 | Title card: SiteMind logo, "Durable procurement agent for construction", Project Alpha facts (24 MW, Tier-III, Chakan MIDC Pune). | This is SiteMind: a durable procurement agent for construction. On a twenty-four megawatt data-centre job, long-lead four-eighty volt switchgear is the number-one schedule risk. Today, procurement coordinators juggle quotes, lead times and budgets in email and Excel, for weeks. Project Alpha is a Tier-three build at Chakan, Pune, and one missed date slips energisation. | The problem: 480 V switchgear, 4–6 month lead time, tracked in email and Excel. |
| 2 | 0:23–0:37 | Dashboard home. The goal is typed into the goal box; highlight the budget field, then **Launch agent**, click it. | We hand SiteMind one goal, in plain English. Get the four-eighty volt switchgear for Project Alpha ordered by the fifteenth of March, twenty twenty-seven, within four point six crore rupees. | Goal: order the 480 V switchgear by 15 Mar 2027, within ₹4.6 Cr. |
| 3 | 0:37–0:53 | Overview tab. Task graph appears (plan v1). Highlight the task graph, then the simulated clock (11 Jan 2027, 09:00 IST). | A local model on this laptop drafts the plan: a task graph with deadlines, budget and risks. Fourteen tasks, five risks. Each step is assigned to a specialist agent, and the simulated clock starts on day one. | Plan v1: 14 tasks, 5 risks, one specialist per task. |
| 4 | 0:53–1:15 | Timeline shows the takeoff result. Vendor table fills as RFQs go out to V1, V2, V3. | The takeoff specialist reads the switchgear spec PDF and extracts every line item, with its source. It finds eight items, and flags one mismatch against the drawing for an RFI. Then requests for quotation go out to three mock vendors, each sent exactly once. The vendors and prices are synthetic. | Takeoff: 8 lines, confidence 0.92, 1 RFI. RFQs to 3 mock vendors. |
| 5 | 1:15–1:33 | Vendor table: V1 shows two timeouts, then a quote on attempt 3. V2 row changes to revision 2. Budget gauge turns red at 100.8 %. Task graph redraws as plan v2 with 4 new tasks. | Real vendors are messy. Voltaris times out twice; the agent backs off and retries. Kestrel then revises its price by eleven percent, a copper surcharge, which breaks the budget. SiteMind notices, and re-plans to version two instead of blindly continuing. | V1 timed out ×2. V2 +11 % copper surcharge → 100.8 % of budget. Re-plan v2. |
| 6 | 1:33–1:43 | Highlight worker status (pid, alive). Click **Kill worker (SIGKILL)**. Status flips to killed; the killed banner appears. | Now the hard part. We kill the worker process, mid-run, with SIGKILL. No graceful shutdown. The agent is simply gone. | kill -9 on the worker, mid-run. |
| 7 | 1:43–1:59 | Click **Resume**. Worker status shows a new pid and 1 restart. Open the Audit tab, switch to the ledger view; highlight the de-duplication summary (requested ×2, executed once). | A fresh worker resumes from the last LangGraph checkpoint, saved after every task. The action ledger shows it: every action appears once, and anything requested twice was still executed only once. No duplicate emails. No duplicate orders. | Resumed from checkpoint. Ledger: requested ×2, executed once. |
| 8 | 1:59–2:21 | Approvals tab. Decision memo: four options with cost, float, reliability; O-V3X marked recommended. Scroll to the risks. Click **Approve**. | Before anything that can't be undone, SiteMind stops and asks a person. The decision memo ranks every option on cost, delivery float and reliability, and recommends one: Anvil's expedited slot, twenty-six lakh extra, on site before the deadline. Voltaris is cheaper, but would arrive late. The project manager approves it. | Memo recommends O-V3X Anvil expedited (+₹26 L). O-V1 Voltaris is cheaper but late. |
| 9 | 2:21–2:38 | PO release approval appears; approve. PO tab: PO package with line items, GST, terms, and the "sent" stamp. Highlight run status: completed. | It drafts the purchase order, asks once more before release, then sends it exactly once: four point seven crore with GST, thirty-three days ahead of the order-by date. Every decision, specialist call and rupee is in the audit trail. | PO to Anvil: ₹4,70,32,912 incl. GST. Sent 10 Feb 2027, 33 days early. |
| 10 | 2:38–2:51 | Closing card: "Weeks → minutes · crash-safe · exactly-once · human sign-off · open source", repo URL. | Weeks of chasing, down to minutes. Every decision audited. It survives crashes without repeating itself, and it is open source, running on a laptop with a local model. SiteMind. | Open source (MIT). Runs on a laptop with a local model. |

## Numbers quoted on screen or in voiceover, and where they come from

| Claim | Value | Source |
|---|---|---|
| Plan v1 size | 14 tasks, 5 risks | `planner.make_plan` |
| Takeoff | 8 lines, confidence 0.92, 1 warning (SPD: 4 in schedule, 3 on drawing) | `docs/SPECIALISTS.md` |
| V1 behaviour | timeout on attempts 1 and 2, quote on attempt 3 | `scenario_demo.json` |
| V2 revision | +11 % copper surcharge and loss of the 3 % discount: ₹3,86,51,400 → ₹4,41,66,800; committed ₹4,63,75,140 = 100.8 % | `docs/SPECIALISTS.md` |
| Plan v2 | +4 tasks (negotiate V2, expedite V3, rank, escalate), 1 superseded | live run |
| Recommendation | O-V3X Anvil expedited, fee ₹26,00,000, delivery 2027-07-24, +6 d float at memo time | live run |
| Voltaris | cheaper (₹3,54,75,400 quote) but −8 d float at memo time | live run |
| PO | ₹4,70,32,912 incl. GST; sent sim 2027-02-10; need-by 2027-03-15 | live run |

"Live run" means `python -m sitemind.cli demo --provider off --kill-after 12` (run from
`backend/`). Simulated dates do not depend on wall-clock pacing.

## Recording notes

- Record at 1920×1080. Keep the "synthetic data" label visible in every dashboard scene.
- Scene 6: kill while the worker status reads alive and the run is `running`, not while it
  waits for a human.
- Scene 7: the ledger's de-duplication summary (`ledger-dedup`) must be on screen when the ledger line is spoken. The recorder's `kill_when` action
  parks the cursor on Kill and fires the instant `current_node` matches a side-effect task's
  pacing window (negotiate / expedite / escalate). In the rendered video the kill lands in
  `T18-escalate:pacing`, so after resume the ledger shows `T18-escalate:notify:pm` as
  "×2 requested · executed once" (verified on frame `submission/frames/scene_07.png`).
- Scene 8: the reviewer in the video is the project manager (`project.manager@alpha`).
- Name the model in the description under the video: Qwen2.5-3B-Instruct via Ollama, local CPU.

## Differences from `demo/script.yaml`

Sentences in this script that are not yet in `demo/script.yaml`:

| Scene | Change |
|---|---|
| 1 | Added: "Project Alpha is a Tier-three build at Chakan, Pune, and one missed date slips energisation." |
| 3 | Added: "Fourteen tasks, five risks." |
| 4 | Added: "It finds eight items, and flags one mismatch against the drawing for an RFI." and "The vendors and prices are synthetic." |
| 5 | Added the words "a copper surcharge" to the Kestrel sentence. |
| 7 | Changed "the interrupted step was requested twice, but executed only once" to "every action appears once, and anything requested twice was still executed only once" (true for any kill timing). |
| 8 | Added: "Anvil's expedited slot, twenty-six lakh extra, on site before the deadline. Voltaris is cheaper, but would arrive late." |
| 9 | Added: "four point seven crore with GST, thirty-three days ahead of the order-by date." |

These sentences are in `demo/script.yaml`; the rendered video is 2:47 (167 s), under the 178 s cap.
