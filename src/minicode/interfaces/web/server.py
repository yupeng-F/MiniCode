from __future__ import annotations

import asyncio
import inspect
import json
import os
import queue
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

from minicode.application.project_service import ProjectService
from minicode.application.session_service import ActiveRunModelSwitchError, SessionService
from minicode.context.artifact_store import ArtifactStore
from minicode.context.context_manager import ContextManager
from minicode.context.token_budget import TokenBudget, UserMessageTooLarge
from minicode.context.token_counter import TokenCounter
from minicode.engine.model_catalog import DEFAULT_MODEL_ID, MODEL_PROFILES
from minicode.engine.model_factory import ModelFactory
from minicode.engine.query_loop import QueryLoop
from minicode.memory.memory_service import MemoryService
from minicode.memory.embedding import (
    EmbeddingConfig,
    build_embedding_router,
    local_embedding_marker,
    local_embedding_size_bytes,
)
from minicode.runtime.harness import HarnessRuntime
from minicode.runtime.policy_engine import PolicyEngine
from minicode.runtime.tool_executor import ToolExecutor
from minicode.runtime.workspace_manager import WorkspaceManager
from minicode.schemas.event import Event
from minicode.schemas.session import SessionState
from minicode.storage.sqlite_store import SQLiteStore
from minicode.storage.global_store import GlobalStore
from minicode.tools import build_default_registry

app = FastAPI(title="MiniCode")

_runs: dict[str, dict] = {}


class RunRequest(BaseModel):
    input: str = ""
    mode: str | None = None
    workspace: str = "."
    session_id: str | None = None
    model_id: str | None = None


class ProjectRequest(BaseModel):
    workspace: str
    title: str | None = None


class SessionRequest(BaseModel):
    input: str
    mode: str = "act"
    model_id: str = DEFAULT_MODEL_ID


class ModelUpdateRequest(BaseModel):
    model_id: str


class ApprovalRequest(BaseModel):
    decision: str


class MemoryUpdateRequest(BaseModel):
    name: str | None = None
    content: str | None = None
    paths: list[str] | None = None
    enabled: bool | None = None


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


def _validate_user_input(content: str) -> int:
    counter = getattr(app.state, "token_counter", None) or TokenCounter()
    try:
        return TokenBudget().validate_user_message(content, counter=counter)
    except UserMessageTooLarge as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "user_message_too_large",
                "limit": exc.limit,
                "actual": exc.actual,
            },
        ) from exc


def _model_for_run(model_id: str):
    model_factory = getattr(app.state, "model_factory", ModelFactory.from_environment)
    if not inspect.signature(model_factory).parameters:
        return model_factory()
    return model_factory(model_id)


def _restore_run(run_id: str) -> dict | None:
    """Lazily reconstruct a persisted run after a daemon restart."""
    store = _global_store()
    persisted = store.load_run(run_id)
    if persisted is None:
        return None
    session, project_id, status = persisted
    workspace = WorkspaceManager(session.workspace)
    if status == "approval_executing":
        # The daemon may have stopped after the side effect but before recording
        # its result. Never retry this claim automatically: that is the durable
        # at-most-once boundary.
        session.status = "failed"
        session.final_answer = "Daemon restarted while an approved tool call was executing; it was not retried."
        status = "failed"
        store.save_run(project_id, session)
        store.save_session(project_id, session)
        store.append_event(Event(type="run_failed", run_id=run_id, summary=session.final_answer))
    run = {
        "session": session,
        "events": queue.Queue(),
        "status": status,
        "workspace": workspace,
        "project_id": project_id,
    }
    _runs[run_id] = run
    return run


def _get_run(run_id: str) -> dict | None:
    return _runs.get(run_id) or _restore_run(run_id)


def _persist_run(project_id: str, session: SessionState, status: str | None = None) -> None:
    store = _global_store()
    store.save_run(project_id, session, status)
    store.save_session(project_id, session)


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


@app.get("/api/capabilities")
async def capabilities() -> JSONResponse:
    budget = TokenBudget()
    embedding = EmbeddingConfig.from_environment()
    return JSONResponse({
        "default_model": DEFAULT_MODEL_ID,
        "models": [profile.model_dump() for profile in MODEL_PROFILES],
        "token_limits": {
            "input": budget.max_input_tokens,
            "output": budget.max_output_tokens,
            "user_message": budget.max_user_message_tokens,
        },
        "embedding": {
            "remote_provider": "aliyun",
            "remote_model": embedding.remote_model,
            "remote_configured": bool(embedding.api_key),
            "external_transfer": True,
            "local_provider": "fastembed",
            "local_model": embedding.local_model,
            "local_installed": local_embedding_marker(embedding.local_cache_dir).is_file(),
            "local_size_bytes": local_embedding_size_bytes(embedding.local_cache_dir),
            "fallback": "fts5",
        },
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


def _project_memory(project_id: str) -> MemoryService:
    workspace = _project_workspace(project_id)
    return MemoryService(workspace.root / ".minicode" / "memory")


def _run_memory(workspace: WorkspaceManager) -> MemoryService:
    factory = getattr(app.state, "embedding_router_factory", build_embedding_router)
    return MemoryService(
        workspace.root / ".minicode" / "memory",
        embedding_router=factory(),
    )


@app.get("/api/projects/{project_id}/memories")
async def list_project_memories(project_id: str) -> JSONResponse:
    return JSONResponse([
        {"id": item.id, "name": item.name, "status": item.status, "content": item.content,
         "category": item.category, "metadata": item.metadata}
        for item in _project_memory(project_id).list_memories()
    ])


@app.patch("/api/projects/{project_id}/memories/{memory_id}")
async def update_project_memory(project_id: str, memory_id: str, req: MemoryUpdateRequest) -> JSONResponse:
    memory = _project_memory(project_id)
    if req.enabled is None:
        changed = memory.update_memory(memory_id, content=req.content, name=req.name, paths=req.paths)
    else:
        has_edits = any(value is not None for value in (req.content, req.name, req.paths))
        changed = memory.update_memory(
            memory_id,
            content=req.content,
            name=req.name,
            paths=req.paths,
        ) if has_edits else True
        if changed:
            changed = memory.enable_memory(memory_id) if req.enabled else memory.disable_memory(memory_id)
    if not changed:
        raise HTTPException(status_code=404, detail="Memory not found or update rejected")
    item = memory.get_memory(memory_id)
    return JSONResponse({"id": item.id, "name": item.name, "status": item.status, "content": item.content,
                         "category": item.category, "metadata": item.metadata})


@app.delete("/api/projects/{project_id}/memories/{memory_id}", status_code=204)
async def delete_project_memory(project_id: str, memory_id: str) -> Response:
    if not _project_memory(project_id).delete_memory(memory_id):
        raise HTTPException(status_code=404, detail="Memory not found")
    return Response(status_code=204)


@app.get("/api/projects/{project_id}/sessions")
async def list_sessions(project_id: str) -> JSONResponse:
    if _project_service().get_project(project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return JSONResponse([session.model_dump() for session in _session_service().list_sessions(project_id)])


@app.post("/api/projects/{project_id}/sessions")
async def create_session(project_id: str, req: SessionRequest) -> JSONResponse:
    _validate_user_input(req.input)
    project = _project_service().get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if req.mode not in {"ask", "plan", "act", "review"}:
        raise HTTPException(status_code=400, detail="Unsupported session mode")
    try:
        session = _session_service().create(project, req.input, req.mode, req.model_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return JSONResponse(session.model_dump())


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str) -> JSONResponse:
    session = _session_service().get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return JSONResponse(session.model_dump())


@app.patch("/api/sessions/{session_id}/model")
async def update_session_model(session_id: str, req: ModelUpdateRequest) -> JSONResponse:
    try:
        session = _session_service().select_model(session_id, req.model_id)
    except ActiveRunModelSwitchError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return JSONResponse(session.model_dump())


@app.delete("/api/sessions/{session_id}", status_code=204)
async def delete_session(session_id: str) -> Response:
    if _global_store().active_run_for_session(session_id):
        raise HTTPException(status_code=409, detail="Session has an active run")
    if not _session_service().delete(session_id):
        raise HTTPException(status_code=404, detail="Session not found")
    for run_id in [key for key, run in _runs.items() if run["session"].session_id == session_id]:
        _runs.pop(run_id, None)
    return Response(status_code=204)


@app.post("/api/runs")
async def create_run(req: RunRequest) -> JSONResponse:
    _validate_user_input(req.input)
    projects = _project_service()
    sessions = _session_service()
    if req.session_id:
        existing = sessions.get_session(req.session_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Session not found")
        project = projects.get_project_by_workspace(existing.workspace)
        if project is None:
            raise HTTPException(status_code=404, detail="Project not found for session")
        if sessions.store.active_run_for_session(req.session_id):
            raise HTTPException(status_code=409, detail="Session already has an active run")
        if req.model_id:
            try:
                sessions.select_model(req.session_id, req.model_id)
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
        session = sessions.start_run(req.session_id, req.input, req.mode)
        workspace = WorkspaceManager(session.workspace)
    else:
        try:
            project = projects.open_workspace(req.workspace)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        mode = req.mode or "act"
        try:
            session = sessions.create(project, req.input, mode, req.model_id or DEFAULT_MODEL_ID)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        workspace = WorkspaceManager(project.workspace)
    events: queue.Queue = queue.Queue()

    _runs[session.run_id] = {
        "session": session,
        "events": events,
        "status": "running",
        "workspace": workspace,
        "project_id": project.project_id,
    }
    _persist_run(project.project_id, session, "running")

    threading.Thread(
        target=_run_background,
        args=(session, workspace, events, project.project_id),
        daemon=True,
    ).start()

    return JSONResponse({"run_id": session.run_id, "session_id": session.session_id})


@app.post("/api/runs/{run_id}/approval")
async def resolve_approval(run_id: str, req: ApprovalRequest) -> JSONResponse:
    run = _get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run["session"].status != "waiting_approval":
        raise HTTPException(status_code=409, detail="Run is not waiting for approval")
    if req.decision not in {"approve", "reject"}:
        raise HTTPException(status_code=400, detail="Decision must be approve or reject")
    if not _global_store().claim_approval(run_id):
        raise HTTPException(status_code=409, detail="Approval was already claimed")
    run["status"] = "approval_executing"
    threading.Thread(
        target=_resolve_approval_background,
        args=(run_id, req.decision == "approve"),
        daemon=True,
    ).start()
    return JSONResponse({"run_id": run_id, "status": "running"})


@app.get("/api/runs/{run_id}")
async def get_run(run_id: str) -> JSONResponse:
    run = _get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    session: SessionState = run["session"]
    return JSONResponse(session.model_dump())


@app.get("/api/runs/{run_id}/stream")
async def stream_run(run_id: str) -> StreamingResponse:
    run = _get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    events: queue.Queue = run["events"]

    async def event_generator():
        last_event_id = 0
        while True:
            persisted = _global_store().list_events(run_id, last_event_id)
            if persisted:
                for event_id, event in persisted:
                    last_event_id = event_id
                    yield f"data: {json.dumps(event.model_dump(), ensure_ascii=False)}\n\n"
                if persisted[-1][1].type in {"run_completed", "run_failed", "approval_required"}:
                    break
                continue
            try:
                await asyncio.get_event_loop().run_in_executor(None, lambda: events.get(timeout=1))
            except queue.Empty:
                yield "data: {\"type\":\"ping\"}\n\n"
                continue

    return StreamingResponse(event_generator(), media_type="text/event-stream")


def _run_background(session: SessionState, workspace: WorkspaceManager, events: queue.Queue, project_id: str) -> None:
    def sink(event: Event) -> None:
        # Event and run checkpoints are committed before they are exposed to SSE.
        _persist_run(project_id, session)
        _global_store().append_event(event)
        events.put(event)

    try:
        model = _model_for_run(session.run_model_id or session.model_id)
        _runs[session.run_id]["model"] = model
        registry = build_default_registry()
        artifacts = ArtifactStore(workspace.root / ".minicode")
        memory = _run_memory(workspace)
        runtime = HarnessRuntime(registry, PolicyEngine(), ToolExecutor(workspace, artifacts, task_agent_model=model))
        loop = QueryLoop(model, runtime, ContextManager(memory_service=memory), memory, sink)
        result = loop.run(session)
        SQLiteStore(workspace.root / ".minicode" / "state.db").save_session(result)
        _persist_run(project_id, result)
        _runs[session.run_id]["session"] = result
        _runs[session.run_id]["status"] = result.status
    except Exception as exc:
        session.status = "failed"
        session.final_answer = str(exc)
        _persist_run(project_id, session)
        _runs[session.run_id]["session"] = session
        _runs[session.run_id]["status"] = "failed"
        sink(Event(type="run_failed", run_id=session.run_id, summary=str(exc)))


def _resolve_approval_background(run_id: str, approved: bool) -> None:
    run = _runs[run_id]
    session: SessionState = run["session"]
    workspace: WorkspaceManager = run["workspace"]
    events: queue.Queue = run["events"]
    project_id: str = run["project_id"]

    def sink(event: Event) -> None:
        # Keep the durable claim while the approved side effect is in flight.
        # Persisting the still-waiting SessionState as the run status here would
        # reopen the approval race before resume_approved clears the pending call.
        _persist_run(project_id, session, "approval_executing")
        _global_store().append_event(event)
        events.put(event)

    try:
        model = run.get("model")
        if model is None:
            model = _model_for_run(session.run_model_id or session.model_id)
        registry = build_default_registry()
        artifacts = ArtifactStore(workspace.root / ".minicode")
        memory = _run_memory(workspace)
        runtime = HarnessRuntime(registry, PolicyEngine(), ToolExecutor(workspace, artifacts, task_agent_model=model))
        loop = QueryLoop(model, runtime, ContextManager(memory_service=memory), memory, sink)
        result = loop.resume_approved(session) if approved else loop.reject_pending(session)
        SQLiteStore(workspace.root / ".minicode" / "state.db").save_session(result)
        _persist_run(project_id, result)
        run["session"] = result
        run["status"] = result.status
    except Exception as exc:
        session.status = "failed"
        session.final_answer = str(exc)
        _persist_run(project_id, session)
        run["session"] = session
        run["status"] = "failed"
        event = Event(type="run_failed", run_id=run_id, summary=str(exc))
        _global_store().append_event(event)
        events.put(event)


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
