# Credits

SiteMind is MIT-licensed original work (see `LICENSE`). It stands on the open-source projects
below. Licences were checked on GitHub / Hugging Face on 2026-11-12. "Uses" means a runtime or
build dependency; "Inspired by" means we read the project and borrowed an idea, **no code copied**.

## Agent runtime

| Project | What it is | Licence | How SiteMind uses it |
|---|---|---|---|
| [LangGraph](https://github.com/langchain-ai/langgraph) (+ `langgraph-checkpoint-sqlite`) | "Build resilient agents" — stateful graph runtime for LLM agents with checkpointers and `interrupt()` for human-in-the-loop | MIT | **Uses.** The procurement run is a `StateGraph` compiled with `SqliteSaver`; one plan task per super-step, checkpoint after every task; `interrupt()` / `Command(resume=…)` for approvals; `thread_id = run_id` so a killed worker resumes from the last checkpoint. |
| [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk) (`mcp`) | Official Python SDK for Model Context Protocol servers and clients | MIT | **Uses.** `sitemind/mcp_server.py` (FastMCP) exposes every specialist as an MCP tool so Amber (or any MCP client) can call them directly — required by the challenge's "be callable by another agent". |
| [Pydantic AI](https://github.com/pydantic/pydantic-ai) (`pydantic-ai-slim[openai]`) | Typed agent framework / model abstraction from the Pydantic team | MIT | **Uses** for structured LLM output (plan rationale, risk wording, decision-memo prose) against Ollama's or any OpenAI-compatible endpoint. |
| [Pydantic](https://github.com/pydantic/pydantic) v2 | Data validation | MIT | **Uses.** `models.py` is the single contract for every data shape (JSON in/out). |
| [FastAPI](https://github.com/fastapi/fastapi) / [Uvicorn](https://github.com/encode/uvicorn) / [HTTPX](https://github.com/encode/httpx) | Web API, ASGI server, HTTP client | MIT / BSD-3-Clause / BSD-3-Clause | **Uses.** REST API + serving the built dashboard; HTTP to Ollama. |
| [pdfplumber](https://github.com/jsvine/pdfplumber) / [ReportLab](https://www.reportlab.com/opensource/) | PDF text/table extraction / PDF generation | MIT / BSD-3-Clause | **Uses.** Takeoff specialist reads the (self-authored, synthetic) switchgear spec PDF; ReportLab generates that sample PDF. |

## Local model serving

| Project | What it is | Licence | How SiteMind uses it |
|---|---|---|---|
| [Ollama](https://github.com/ollama/ollama) | Local runner for open-weight LLMs with an HTTP API | MIT | **Uses.** Default LLM provider (`OLLAMA_BASE_URL`, `ollama/ollama` image in `docker-compose.yml`) so the whole agent runs offline on a laptop CPU. |
| [Qwen2.5-3B-Instruct](https://huggingface.co/Qwen/Qwen2.5-3B-Instruct) (`qwen2.5:3b` in Ollama) | 3B-parameter instruction-tuned open-weight model by Alibaba Cloud's Qwen team | **Qwen Research License Agreement** (`qwen-research`, non-commercial; *not* Apache-2.0 — unlike most other Qwen2.5 sizes) | **Uses** as the default local model. Used only around deterministic logic (wording, summaries), never for arithmetic. For commercial deployment swap to an Apache-2.0 size, e.g. `SITEMIND_LLM_MODEL=qwen2.5:7b` or `qwen2.5:1.5b`. |

## Ideas borrowed (inspiration, no code copied)

| Project | What it is | Licence | What SiteMind borrowed |
|---|---|---|---|
| [bytedance/deer-flow](https://github.com/bytedance/deer-flow) | "An open-source long-horizon SuperAgent harness" that "orchestrates sub-agents, memory, and sandboxes … powered by extensible skills" (v2, LangGraph-based) | MIT | The **lead-agent + specialist sub-agent** pattern on LangGraph: a planner owns the long-horizon plan and delegates each step to a registered specialist with a declared input/output contract; plan re-generation when a step's result invalidates the plan. |
| [Kentucky-ai/opentakeoff](https://github.com/Kentucky-ai/opentakeoff) | Open-source PDF takeoff engine for construction with a browser canvas for people and an MCP server for agents; agent work "stays a dashed proposal until a person accepts it" | **AGPL-3.0** | The idea that a **takeoff is a tool an agent drives over MCP**, that every measured line records its **source** (sheet/page/method), and that agent output stays a proposal until a human accepts it. Because it is AGPL, **no OpenTakeoff code is included or linked**; our takeoff specialist is a small independent spec-table parser. |
| [datadrivenconstruction/DDC_Skills_for_AI_Agents_in_Construction](https://github.com/datadrivenconstruction/DDC_Skills_for_AI_Agents_in_Construction) | A collection of 200+ `SKILL.md` "skills" for automating construction processes (estimation, scheduling, document control, BIM) with AI coding assistants | MIT | Vocabulary and workflow decomposition for construction procurement tasks (estimation → scheduling/CPM → budget control → document generation) used when designing the specialist registry; the CPM forward/backward-pass schedule check follows standard practice described there. |

## Demo video tooling (not shipped in the app)

| Project | What it is | Licence | Use |
|---|---|---|---|
| [Piper](https://github.com/OHF-Voice/piper1-gpl) (`piper-tts` 1.8, OHF-Voice/piper1-gpl; original [rhasspy/piper](https://github.com/rhasspy/piper) is MIT) | Fast, local neural text-to-speech | GPL-3.0 (piper1-gpl) | Offline narration for the demo video (`demo/tts.py`), invoked as a separate tool; not linked into SiteMind. |
| [Piper voice `en_US-lessac-high`](https://huggingface.co/rhasspy/piper-voices) | Voice model trained on the Lessac / Blizzard Challenge 2013 dataset | Dataset under the [Blizzard 2013 Lessac research licence](https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html) (research / non-commercial) | Narration voice. Downloaded by `scripts/download_voices.sh`, not committed. |
| [espeak-ng](https://github.com/espeak-ng/espeak-ng) | Formant TTS | GPL-3.0 | Fallback narration only if Piper is unavailable. |
| [Playwright](https://github.com/microsoft/playwright) + Chromium | Browser automation / headless browser | Apache-2.0 / BSD-3-Clause | Drives the real dashboard and records the screen; renders title cards; e2e tests. |
| [FFmpeg](https://ffmpeg.org/) (libx264, AAC) | Audio/video toolkit | LGPL-2.1+/GPL-2.0+ (x264 GPL-2.0+) | Subtitles, audio mix, H.264 encode, frame extraction. |
| [PyYAML](https://github.com/yaml/pyyaml) | YAML parser | MIT | Reads `demo/script.yaml`. |

## Frontend

| Project | Licence | Use |
|---|---|---|
| [React](https://github.com/facebook/react) 18 / React DOM | MIT | Dashboard UI |
| [Vite](https://github.com/vitejs/vite) + `@vitejs/plugin-react` | MIT | Build tooling |
| [TypeScript](https://github.com/microsoft/TypeScript) | Apache-2.0 | Types |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) / PostCSS / Autoprefixer | MIT | Styling |
| [lucide-react](https://github.com/lucide-icons/lucide) | ISC | Icons |
| [react-markdown](https://github.com/remarkjs/react-markdown) / [remark-gfm](https://github.com/remarkjs/remark-gfm) | MIT | Rendering the PO package / decision memo Markdown |
| ESLint, typescript-eslint | MIT | Lint |

## Fonts

| Font | Licence | Use |
|---|---|---|
| [Inter](https://github.com/rsms/inter) by Rasmus Andersson (`@fontsource-variable/inter`) | SIL Open Font License 1.1 | UI and title cards |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) (`@fontsource-variable/jetbrains-mono`) | SIL Open Font License 1.1 | Numbers, IDs, logs |

## Data

All project, vendor and price data in `backend/sitemind/data/` is **synthetic and self-authored**
for the demo (Project Alpha, Chakan MIDC). The vendors *Voltaris Switchgear Pvt Ltd*, *Kestrel Power
Systems* and *Anvil Electric India* are **fictional mock vendors**; any resemblance to real companies
is unintended. Electrical ratings follow generic, publicly documented LV switchgear practice
(480 V / 4000 A class, 65 kA), not any manufacturer's catalogue.
