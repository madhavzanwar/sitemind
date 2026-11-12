"""FastAPI app ``sitemind.api:app`` - REST API for the dashboard (see docs/CONTRACT.md)."""

from __future__ import annotations

import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, Response

from . import __version__
from .config import get_settings
from .llm import LLM
from .models import ApprovalDecision, CreateRunRequest, RunSnapshot, SpecialistSpec
from .runner import (
    RunError,
    create_run,
    decide_approval,
    get_store,
    kill_run,
    list_snapshots,
    resume_run,
    snapshot,
)
from .specialists.registry import REGISTRY


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Load the local model in the background so the first plan call is not a cold start."""
    threading.Thread(target=lambda: LLM(get_settings()).warmup(), daemon=True).start()
    yield


app = FastAPI(title="SiteMind", version=__version__, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DEMO_DEFAULTS = CreateRunRequest(
    goal_text=(
        "Get the 480 V switchgear package for Project Alpha ordered by 2027-03-15 "
        "within budget ₹4.6 Cr"
    ),
    project="Project Alpha",
    package="480 V switchgear",
    need_by=date(2027, 3, 15),
    budget_inr=46_000_000,
    scenario="demo",
)


def _call(fn: Any, *args: Any, **kw: Any) -> Any:
    try:
        return fn(*args, **kw)
    except RunError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@app.get("/api/health")
def health() -> dict[str, Any]:
    llm = LLM(get_settings())
    return {
        "status": "ok",
        "version": __version__,
        "llm": {**llm.describe(), "reachable": llm.reachable()},
    }


@app.get("/api/registry", response_model=list[SpecialistSpec])
def registry() -> list[SpecialistSpec]:
    return list(REGISTRY)


@app.get("/api/runs", response_model=list[RunSnapshot])
def runs() -> list[RunSnapshot]:
    return list_snapshots()


@app.post("/api/runs", response_model=RunSnapshot)
def post_run(req: CreateRunRequest) -> RunSnapshot:
    snap: RunSnapshot = _call(create_run, req)
    return snap


@app.get("/api/runs/{run_id}", response_model=RunSnapshot)
def get_run(run_id: str) -> RunSnapshot:
    snap: RunSnapshot = _call(snapshot, run_id)
    return snap


@app.post("/api/runs/{run_id}/kill", response_model=RunSnapshot)
def kill(run_id: str) -> RunSnapshot:
    snap: RunSnapshot = _call(kill_run, run_id)
    return snap


@app.post("/api/runs/{run_id}/resume", response_model=RunSnapshot)
def resume(run_id: str) -> RunSnapshot:
    snap: RunSnapshot = _call(resume_run, run_id)
    return snap


@app.post("/api/runs/{run_id}/approvals/{approval_id}", response_model=RunSnapshot)
def approve(run_id: str, approval_id: str, decision: ApprovalDecision) -> RunSnapshot:
    snap: RunSnapshot = _call(decide_approval, run_id, approval_id, decision)
    return snap


@app.get("/api/runs/{run_id}/po.md", response_class=PlainTextResponse)
def po_markdown(run_id: str) -> Response:
    if get_store().get_run(run_id) is None:
        raise HTTPException(404, "run not found")
    snap = snapshot(run_id, light=True)
    if snap.po is None:
        raise HTTPException(404, "no purchase order yet")
    return PlainTextResponse(
        snap.po.markdown or f"# {snap.po.po_number}\n", media_type="text/markdown"
    )


@app.get("/api/demo/defaults", response_model=CreateRunRequest)
def demo_defaults() -> CreateRunRequest:
    return DEMO_DEFAULTS


# --------------------------------------------------------------------------- SPA


@app.get("/{path:path}", include_in_schema=False)
def spa(path: str) -> Response:
    dist: Path = get_settings().frontend_dist
    if path.startswith("api/"):
        raise HTTPException(404, "not found")
    index = dist / "index.html"
    if not index.exists():
        return PlainTextResponse(
            "SiteMind API is running. Build the dashboard (frontend/dist) or use /docs.",
            status_code=200,
        )
    target = (dist / path).resolve()
    if path and target.is_file() and dist.resolve() in target.parents:
        return FileResponse(target)
    return FileResponse(index)
