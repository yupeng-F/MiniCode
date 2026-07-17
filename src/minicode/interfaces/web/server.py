from __future__ import annotations

import asyncio
import json
import os
import queue
import threading
from pathlib import Path
from typing import cast

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

from minicode.application.project_service import ProjectService
from minicode.application.session_service import SessionService
from minicode.context.artifact_store import ArtifactStore
from minicode.context.context_manager import ContextManager
from minicode.engine.model_factory import ModelFactory
from minicode.engine.query_loop import QueryLoop
from minicode.memory.memory_service import MemoryService
from minicode.runtime.harness import HarnessRuntime
from minicode.runtime.policy_engine import PolicyEngine
from minicode.runtime.tool_executor import ToolExecutor
from minicode.runtime.workspace_manager import WorkspaceManager
from minicode.schemas.event import Event
from minicode.schemas.session import Mode, SessionState
from minicode.storage.sqlite_store import SQLiteStore
from minicode.storage.global_store import GlobalStore
from minicode.tools import build_default_registry

app = FastAPI(title="MiniCode")

_runs: dict[str, dict] = {}


class RunRequest(BaseModel):
    input: str = ""
    mode: Mode | None = None
    workspace: str = "."
    session_id: str | None = None


class ProjectRequest(BaseModel):
    workspace: str
    title: str | None = None


class SessionRequest(BaseModel):
    input: str
    mode: str = "act"


class ApprovalRequest(BaseModel):
    decision: str


def _global_store() -> GlobalStore:
    configured_path = getattr(app.state, "global_store_path", None)
    if configured_path is not None:
        return GlobalStore(configured_path)
    home = Path(os.getenv("MINICODE_HOME", Path.home() / ".minicode"))
    return GlobalStore(home / "minicode.db")


def _project_service() -> ProjectService:
    return ProjectService(_global_store())


def _session_service() -> SessionService:
    return SessionService(_global_store())


def _project_workspace(project_id: str) -> WorkspaceManager:
    project = _project_service().get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return WorkspaceManager(project.workspace)


def _is_sensitive_browser_entry(path: Path) -> bool:
    return path.name in {".ssh", ".gnupg"}


@app.get("/")
async def index() -> JSONResponse:
    return JSONResponse({
        "name": "MiniCode",
        "architecture": "Tool-Use Loop + Harness Runtime + Context Management + Markdown Memory",
    })


@app.get("/api/projects")
async def list_projects() -> JSONResponse:
    return JSONResponse([project.model_dump() for project in _project_service().list_projects()])


@app.post("/api/projects")
async def create_project(req: ProjectRequest) -> JSONResponse:
    try:
        project = _project_service().open_workspace(req.workspace, req.title)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return JSONResponse(project.model_dump())


@app.delete("/api/projects/{project_id}", status_code=204)
async def delete_project(project_id: str) -> Response:
    if any(
        run["project_id"] == project_id and run["session"].status in {"running", "waiting_approval"}
        for run in _runs.values()
    ):
        raise HTTPException(status_code=409, detail="Project has an active run")
    if not _project_service().remove(project_id):
        raise HTTPException(status_code=404, detail="Project not found")
    for run_id in [key for key, run in _runs.items() if run["project_id"] == project_id]:
        _runs.pop(run_id, None)
    return Response(status_code=204)


@app.get("/api/filesystem/browse")
async def browse_filesystem(path: str | None = None) -> JSONResponse:
    target = Path(path).expanduser().resolve() if path else Path.home()
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="Directory not found")
    try:
        entries = [
            {"name": child.name, "path": str(child), "is_dir": True}
            for child in sorted(target.iterdir(), key=lambda item: item.name.lower())
            if child.is_dir() and not _is_sensitive_browser_entry(child)
        ]
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="Directory cannot be read") from exc
    return JSONResponse({"path": str(target), "parent": str(target.parent), "entries": entries})


@app.get("/api/projects/{project_id}/files")
async def list_project_files(project_id: str, path: str = ".") -> JSONResponse:
    workspace = _project_workspace(project_id)
    try:
        target = workspace.resolve_path(path)
        workspace.ensure_safe_to_read(target)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")
    try:
        entries = [
            {"name": child.name, "path": workspace.display_path(child), "is_dir": child.is_dir()}
            for child in sorted(target.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower()))
            if not workspace.is_sensitive_path(child)
        ]
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="Directory cannot be read") from exc
    return JSONResponse({"path": workspace.display_path(target), "entries": entries})


@app.get("/api/projects/{project_id}/files/content")
async def read_project_file(project_id: str, path: str, offset: int = 0, limit: int = 400) -> JSONResponse:
    workspace = _project_workspace(project_id)
    try:
        target = workspace.resolve_path(path)
        workspace.ensure_safe_to_read(target)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not target.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file")
    safe_offset = max(offset, 0)
    safe_limit = min(max(limit, 1), 2_000)
    try:
        lines = target.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError as exc:
        raise HTTPException(status_code=400, detail="File cannot be read") from exc
    selected = lines[safe_offset: safe_offset + safe_limit]
    next_offset = safe_offset + len(selected)
    return JSONResponse({
        "path": workspace.display_path(target),
        "content": "\n".join(selected),
        "offset": safe_offset,
        "total_lines": len(lines),
        "next_offset": next_offset if next_offset < len(lines) else None,
    })


@app.get("/api/projects/{project_id}/sessions")
async def list_sessions(project_id: str) -> JSONResponse:
    if _project_service().get_project(project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return JSONResponse([session.model_dump() for session in _session_service().list_sessions(project_id)])


@app.post("/api/projects/{project_id}/sessions")
async def create_session(project_id: str, req: SessionRequest) -> JSONResponse:
    project = _project_service().get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if req.mode not in {"ask", "plan", "act", "review"}:
        raise HTTPException(status_code=400, detail="Unsupported session mode")
    session = _session_service().create(project, req.input, cast(Mode, req.mode))
    return JSONResponse(session.model_dump())


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str) -> JSONResponse:
    session = _session_service().get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return JSONResponse(session.model_dump())


@app.delete("/api/sessions/{session_id}", status_code=204)
async def delete_session(session_id: str) -> Response:
    if any(
        run["session"].session_id == session_id and run["session"].status in {"running", "waiting_approval"}
        for run in _runs.values()
    ):
        raise HTTPException(status_code=409, detail="Session has an active run")
    if not _session_service().delete(session_id):
        raise HTTPException(status_code=404, detail="Session not found")
    for run_id in [key for key, run in _runs.items() if run["session"].session_id == session_id]:
        _runs.pop(run_id, None)
    return Response(status_code=204)


@app.post("/api/runs")
async def create_run(req: RunRequest) -> JSONResponse:
    projects = _project_service()
    sessions = _session_service()
    if req.session_id:
        existing = sessions.get_session(req.session_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Session not found")
        project = projects.get_project_by_workspace(existing.workspace)
        if project is None:
            raise HTTPException(status_code=404, detail="Project not found for session")
        if any(
            run["session"].session_id == req.session_id and run["session"].status in {"running", "waiting_approval"}
            for run in _runs.values()
        ):
            raise HTTPException(status_code=409, detail="Session already has an active run")
        session = sessions.start_run(req.session_id, req.input, req.mode)
        workspace = WorkspaceManager(session.workspace)
    else:
        try:
            project = projects.open_workspace(req.workspace)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        mode = req.mode or "act"
        session = sessions.create(project, req.input, mode)
        workspace = WorkspaceManager(project.workspace)
    events: queue.Queue = queue.Queue()

    _runs[session.run_id] = {
        "session": session,
        "events": events,
        "status": "running",
        "workspace": workspace,
        "project_id": project.project_id,
    }

    threading.Thread(
        target=_run_background,
        args=(session, workspace, events, project.project_id),
        daemon=True,
    ).start()

    return JSONResponse({"run_id": session.run_id, "session_id": session.session_id})


@app.post("/api/runs/{run_id}/approval")
async def resolve_approval(run_id: str, req: ApprovalRequest) -> JSONResponse:
    run = _runs.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run["session"].status != "waiting_approval":
        raise HTTPException(status_code=409, detail="Run is not waiting for approval")
    if req.decision not in {"approve", "reject"}:
        raise HTTPException(status_code=400, detail="Decision must be approve or reject")
    run["status"] = "running"
    threading.Thread(
        target=_resolve_approval_background,
        args=(run_id, req.decision == "approve"),
        daemon=True,
    ).start()
    return JSONResponse({"run_id": run_id, "status": "running"})


@app.get("/api/runs/{run_id}")
async def get_run(run_id: str) -> JSONResponse:
    run = _runs.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    session: SessionState = run["session"]
    return JSONResponse(session.model_dump())


@app.get("/api/runs/{run_id}/stream")
async def stream_run(run_id: str) -> StreamingResponse:
    run = _runs.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    events: queue.Queue = run["events"]

    async def event_generator():
        while True:
            try:
                event = await asyncio.get_event_loop().run_in_executor(None, lambda: events.get(timeout=30))
            except queue.Empty:
                yield "data: {\"type\":\"ping\"}\n\n"
                continue
            yield f"data: {json.dumps(event.model_dump(), ensure_ascii=False)}\n\n"
            if event.type in {"run_completed", "run_failed", "approval_required"}:
                break

    return StreamingResponse(event_generator(), media_type="text/event-stream")


def _run_background(session: SessionState, workspace: WorkspaceManager, events: queue.Queue, project_id: str) -> None:
    def sink(event: Event) -> None:
        events.put(event)

    try:
        model_factory = getattr(app.state, "model_factory", ModelFactory.from_environment)
        model = model_factory()
        _runs[session.run_id]["model"] = model
        registry = build_default_registry()
        artifacts = ArtifactStore(workspace.root / ".minicode")
        memory = MemoryService(workspace.root / ".minicode" / "memory")
        runtime = HarnessRuntime(registry, PolicyEngine(), ToolExecutor(workspace, artifacts))
        loop = QueryLoop(model, runtime, ContextManager(memory_service=memory), memory, sink)
        result = loop.run(session)
        SQLiteStore(workspace.root / ".minicode" / "state.db").save_session(result)
        _session_service().save(project_id, result)
        _runs[session.run_id]["session"] = result
        _runs[session.run_id]["status"] = result.status
    except Exception as exc:
        session.status = "failed"
        session.final_answer = str(exc)
        _session_service().save(project_id, session)
        _runs[session.run_id]["session"] = session
        _runs[session.run_id]["status"] = "failed"
        events.put(Event(type="run_failed", run_id=session.run_id, summary=str(exc)))


def _resolve_approval_background(run_id: str, approved: bool) -> None:
    run = _runs[run_id]
    session: SessionState = run["session"]
    workspace: WorkspaceManager = run["workspace"]
    events: queue.Queue = run["events"]
    project_id: str = run["project_id"]

    def sink(event: Event) -> None:
        events.put(event)

    try:
        model = run["model"]
        registry = build_default_registry()
        artifacts = ArtifactStore(workspace.root / ".minicode")
        memory = MemoryService(workspace.root / ".minicode" / "memory")
        runtime = HarnessRuntime(registry, PolicyEngine(), ToolExecutor(workspace, artifacts))
        loop = QueryLoop(model, runtime, ContextManager(memory_service=memory), memory, sink)
        result = loop.resume_approved(session) if approved else loop.reject_pending(session)
        SQLiteStore(workspace.root / ".minicode" / "state.db").save_session(result)
        _session_service().save(project_id, result)
        run["session"] = result
        run["status"] = result.status
    except Exception as exc:
        session.status = "failed"
        session.final_answer = str(exc)
        _session_service().save(project_id, session)
        run["session"] = session
        run["status"] = "failed"
        events.put(Event(type="run_failed", run_id=run_id, summary=str(exc)))


def main() -> None:
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="MiniCode local daemon")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()

    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
