"""FastAPI app ``sitemind.api:app`` - REST API for the dashboard (see docs/CONTRACT.md)."""

from __future__ import annotations

import re
import secrets
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, Response

from . import __version__
from .config import get_settings
from .graph import EVENT_TYPES
from .llm import LLM
from .models import (
    ApprovalDecision,
    CreateRunRequest,
    EventTypeSpec,
    GoalParseRequest,
    GoalParseResult,
    InjectEventRequest,
    PackageSpec,
    RunSnapshot,
    SpecialistSpec,
    SpecUpload,
)
from .runner import (
    RunError,
    create_run,
    decide_approval,
    get_store,
    inject_event,
    kill_run,
    list_snapshots,
    resume_run,
    snapshot,
)
from .specialists.packages import get_package, list_packages, match_package
from .specialists.registry import REGISTRY
from .specialists.takeoff import run_takeoff


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

MAX_UPLOAD_BYTES = 10 * 1024 * 1024


def demo_defaults_for(package_id: str = "swgr-480v") -> CreateRunRequest:
    """The demo goal for a package, straight from its ``package.json``."""
    try:
        pkg = get_package(package_id)
    except KeyError as exc:
        raise HTTPException(404, f"unknown package {package_id!r}") from exc
    return CreateRunRequest(
        goal_text=pkg.default_goal_text,
        project=pkg.default_project,
        package=pkg.title,
        need_by=pkg.default_need_by,
        budget_inr=pkg.default_budget_inr,
        scenario="demo",
        package_id=pkg.package_id,
    )


DEMO_DEFAULTS = demo_defaults_for("swgr-480v")


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
def demo_defaults(package_id: str = "swgr-480v") -> CreateRunRequest:
    return demo_defaults_for(package_id)


# --------------------------------------------------------------------------- v2: packages,
# goal parsing, spec upload, live events


@app.get("/api/packages", response_model=list[PackageSpec])
def packages() -> list[PackageSpec]:
    return list_packages()


def _parse_goal_fn() -> Any:
    import importlib

    for mod in ("sitemind.specialists", "sitemind.specialists.goal", "sitemind.specialists.goals"):
        try:
            f = getattr(importlib.import_module(mod), "parse_goal", None)
        except ImportError:
            f = None
        if f is not None:
            return f
    raise HTTPException(503, "goal parser not available")


@app.post("/api/goal/parse", response_model=GoalParseResult)
def goal_parse(req: GoalParseRequest) -> GoalParseResult:
    res: GoalParseResult = _parse_goal_fn()(req.text, date.today())
    return res


@app.post("/api/specs", response_model=SpecUpload)
async def upload_spec(file: UploadFile = File(...)) -> SpecUpload:
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "spec PDF larger than 10 MB")
    if not data.startswith(b"%PDF"):
        raise HTTPException(415, "not a PDF file")
    settings = get_settings()
    updir = settings.data_dir / "uploads"
    updir.mkdir(parents=True, exist_ok=True)
    upload_id = f"up-{secrets.token_hex(6)}"
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(file.filename or "spec.pdf").name)[:80]
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    (updir / upload_id).mkdir(parents=True, exist_ok=True)
    path = updir / upload_id / name  # keep the user's filename for page citations
    path.write_bytes(data)
    try:
        import pdfplumber

        with pdfplumber.open(path) as pdf:
            pages = len(pdf.pages)
            text = "\n".join((pg.extract_text() or "") for pg in pdf.pages[:6])
    except Exception as exc:
        path.unlink(missing_ok=True)
        raise HTTPException(422, f"unreadable PDF: {type(exc).__name__}") from exc
    package_id = match_package(text)[0]
    takeoff = None
    try:
        takeoff = run_takeoff(path, package_id)
    except Exception:  # preview is best effort; the run's takeoff task reports problems
        takeoff = None
    up = SpecUpload(
        upload_id=upload_id,
        filename=name,
        pages=pages,
        size_bytes=len(data),
        package_id=package_id,
        takeoff=takeoff,
    )
    get_store().save_upload(up, str(path))
    return up


@app.get("/api/event-types", response_model=list[EventTypeSpec])
def event_types() -> list[EventTypeSpec]:
    return list(EVENT_TYPES)


@app.post("/api/runs/{run_id}/events", response_model=RunSnapshot)
def post_event(run_id: str, req: InjectEventRequest) -> RunSnapshot:
    snap: RunSnapshot = _call(inject_event, run_id, req)
    return snap


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
