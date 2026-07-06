"""FastAPI 服务器：提供 Web UI 后端，支持 SSE 流式输出。"""

from __future__ import annotations

import asyncio
import json
import os
import queue as _queue
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from langgraph.types import Command
from pydantic import BaseModel

from multi_agents.orchestrator.graph import compile_graph, initialize_state
from multi_agents.runtime.tool_executor import ToolExecutor

app = FastAPI(title="Multi-Agent System")

# ── 静态文件 ──────────────────────────────────────────

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# ── 工作空间管理 ──────────────────────────────────────

_current_workspace: str = os.getcwd()

# ── 历史记录持久化 ────────────────────────────────────

HISTORY_DIR = os.path.join(os.path.dirname(__file__), "data")
HISTORY_FILE = os.path.join(HISTORY_DIR, "run_history.json")


def _ensure_history_dir():
    os.makedirs(HISTORY_DIR, exist_ok=True)


def _load_persisted_history() -> list[dict]:
    _ensure_history_dir()
    try:
        with open(HISTORY_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _append_persisted_history(entry: dict):
    history = _load_persisted_history()
    history.append(entry)
    history = history[-100:]  # keep last 100
    _ensure_history_dir()
    try:
        with open(HISTORY_FILE, "w", encoding="utf-8") as f:
            json.dump(history, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


# ── 运行管理 ──────────────────────────────────────────
_runs: dict[str, dict[str, Any]] = {}


class RunRequest(BaseModel):
    input: str
    mode: str = "act"


class ApproveRequest(BaseModel):
    decision: str


class WorkspaceRequest(BaseModel):
    path: str


@app.get("/", response_class=HTMLResponse)
async def index():
    path = os.path.join(STATIC_DIR, "index.html")
    with open(path, encoding="utf-8") as f:
        return f.read()


# ── 工作空间 API ──────────────────────────────────────


@app.get("/api/workspace")
async def get_workspace():
    """返回当前工作空间路径和基本信息。"""
    ws = _current_workspace
    entries = []
    try:
        for e in sorted(os.listdir(ws)):
            full = os.path.join(ws, e)
            entries.append({
                "name": e,
                "is_dir": os.path.isdir(full),
            })
    except PermissionError:
        entries = []
    return JSONResponse({
        "path": ws,
        "parent": str(Path(ws).parent),
        "entries": entries,
    })


@app.post("/api/workspace")
async def set_workspace(req: WorkspaceRequest):
    """切换工作空间。"""
    path = os.path.abspath(req.path)
    if not os.path.isdir(path):
        raise HTTPException(status_code=400, detail=f"Directory not found: {path}")
    if not os.access(path, os.R_OK):
        raise HTTPException(status_code=403, detail=f"No read permission: {path}")
    global _current_workspace
    _current_workspace = path
    ToolExecutor.set_workspace(path)
    return JSONResponse({"path": path})


@app.get("/api/workspace/browse")
async def browse_workspace(path: str = ""):
    """浏览指定路径的目录内容（用于文件选择器）。"""
    target = os.path.abspath(path) if path else _current_workspace
    if not os.path.isdir(target):
        raise HTTPException(status_code=400, detail=f"Not a directory: {target}")
    entries = []
    try:
        for e in sorted(os.listdir(target)):
            full = os.path.join(target, e)
            try:
                is_dir = os.path.isdir(full)
                entries.append({
                    "name": e,
                    "is_dir": is_dir,
                    "size": os.path.getsize(full) if not is_dir else 0,
                })
            except OSError:
                pass
    except PermissionError:
        pass
    return JSONResponse({
        "path": target,
        "parent": str(Path(target).parent) if target != Path(target).anchor else target,
        "entries": entries,
    })


# ── 后台图执行 ────────────────────────────────────────


def _run_graph(
    input_str: str,
    mode: str,
    event_queue: _queue.Queue,
    thread_id: str,
    run_id: str,
):
    """Phase 1：在后台线程中执行图直到中断或完成。

    如果遇到 interrupt，保存图引用和配置，
    等待 /api/resume/ 恢复执行。
    """
    try:
        app_graph = compile_graph()
        thread_config = {"configurable": {"thread_id": thread_id}}

        # 保存图引用和配置，供 resume 使用
        _runs[thread_id]["graph"] = app_graph
        _runs[thread_id]["config"] = thread_config

        state = initialize_state(input_str, mode=mode)
        state["run_id"] = run_id
        state["thread_id"] = thread_id

        for event in app_graph.stream(state, thread_config, stream_mode="values"):
            _runs[thread_id]["state"] = dict(event)
            try:
                serialized = _serialize_event(event)
            except Exception as se:
                serialized = {"stage": "serialize_error", "error": str(se)}
            event_queue.put({"type": "state", "data": serialized})
            if event.get("status") == "completed":
                break

        # 检查是否被 interrupt 暂停
        try:
            gstate = app_graph.get_state(thread_config)
            if gstate.tasks:
                for task in gstate.tasks:
                    if task.interrupts:
                        ctx = task.interrupts[0].value
                        _runs[thread_id]["interrupt_ctx"] = ctx
                        _runs[thread_id]["status"] = "waiting_approval"
                        event_queue.put({"type": "interrupt", "data": ctx})
                        return  # 等待 resume，不标记完成
        except Exception:
            pass

        # 正常完成（无 interrupt）
        _runs[thread_id]["status"] = "completed"
        event_queue.put({"type": "done"})
        _save_history(thread_id)

    except Exception as exc:
        _runs[thread_id]["status"] = "failed"
        event_queue.put({"type": "error", "data": str(exc)})
        _save_history_failed(thread_id, input_str)


def _run_graph_from_state(
    state: dict,
    event_queue: _queue.Queue,
    thread_id: str,
    run_id: str,
):
    """从已有状态继续新一轮图执行（多轮对话用）。"""
    try:
        app_graph = compile_graph()
        thread_config = {"configurable": {"thread_id": thread_id}}

        _runs[thread_id]["graph"] = app_graph
        _runs[thread_id]["config"] = thread_config

        for event in app_graph.stream(state, thread_config, stream_mode="values"):
            _runs[thread_id]["state"] = dict(event)
            try:
                serialized = _serialize_event(event)
            except Exception as se:
                serialized = {"stage": "serialize_error", "error": str(se)}
            event_queue.put({"type": "state", "data": serialized})
            if event.get("status") == "completed":
                break

        # 检查 interrupt
        try:
            gstate = app_graph.get_state(thread_config)
            if gstate.tasks:
                for task in gstate.tasks:
                    if task.interrupts:
                        ctx = task.interrupts[0].value
                        _runs[thread_id]["interrupt_ctx"] = ctx
                        _runs[thread_id]["status"] = "waiting_approval"
                        event_queue.put({"type": "interrupt", "data": ctx})
                        return
        except Exception:
            pass

        _runs[thread_id]["status"] = "completed"
        event_queue.put({"type": "done"})
        _save_history(thread_id)

    except Exception as exc:
        _runs[thread_id]["status"] = "failed"
        event_queue.put({"type": "error", "data": str(exc)})
        _save_history_failed(thread_id, str(exc))


def _resume_graph(
    app_graph,
    thread_config: dict,
    decision: str,
    event_queue: _queue.Queue,
    thread_id: str,
):
    """Phase 2：从 interrupt 处恢复图执行。"""
    try:
        _runs[thread_id]["status"] = "running"

        for event in app_graph.stream(
            Command(resume=decision),
            thread_config,
            stream_mode="values",
        ):
            _runs[thread_id]["state"] = dict(event)
            try:
                serialized = _serialize_event(event)
            except Exception as se:
                serialized = {"stage": "serialize_error", "error": str(se)}
            event_queue.put({"type": "state", "data": serialized})
            if event.get("status") == "completed":
                break

        _runs[thread_id]["status"] = "completed"
        event_queue.put({"type": "done"})
        _save_history(thread_id)

    except Exception as exc:
        _runs[thread_id]["status"] = "failed"
        event_queue.put({"type": "error", "data": str(exc)})
        _save_history_failed(thread_id, str(exc))


@app.post("/api/run")
async def start_run(req: RunRequest) -> JSONResponse:
    thread_id = str(uuid.uuid4())[:8]
    run_id = str(uuid.uuid4())[:8]

    event_queue: _queue.Queue = _queue.Queue()
    _runs[thread_id] = {
        "events": event_queue,
        "state": {},
        "status": "running",
        "interrupt_ctx": None,
    }

    threading.Thread(
        target=_run_graph,
        args=(req.input, req.mode, event_queue, thread_id, run_id),
        daemon=True,
    ).start()

    return JSONResponse({"thread_id": thread_id, "run_id": run_id})


@app.post("/api/chat/{thread_id}")
async def continue_chat(thread_id: str, req: RunRequest) -> JSONResponse:
    """延续已有会话：携带上下文继续新一轮对话。"""
    prev = _runs.get(thread_id)
    if not prev:
        raise HTTPException(status_code=404, detail="No previous run found")

    prev_state = prev.get("state", {})
    if not prev_state:
        raise HTTPException(status_code=400, detail="No state to continue from")

    new_run_id = str(uuid.uuid4())[:8]
    event_queue: _queue.Queue = _queue.Queue()

    # 从上一轮继承上下文，重置执行相关字段
    continued_state = {
        "thread_id": thread_id,
        "run_id": new_run_id,
        "mode": req.mode,
        "status": "running",
        "current_stage": "task_intake",
        "current_agent": "",
        "retry_count": prev_state.get("retry_count", {"review": 0, "testing": 0}),
        "user_input": req.input,
        "task_goal": req.input,
        "constraints": prev_state.get("constraints", []),
        "success_criteria": prev_state.get("success_criteria", []),
        "plan": prev_state.get("plan", []),
        "messages": (prev_state.get("messages", []) or [])
                    + [{"role": "user", "content": req.input}],
        "agent_contexts": prev_state.get("agent_contexts", {}),
        "tool_requests": [],
        "tool_results": [],
        "artifacts": prev_state.get("artifacts", []),
        "review_notes": prev_state.get("review_notes", []),
        "test_summary": prev_state.get("test_summary", []),
        "approval_pending": False,
        "approval_context": {},
        "task_memory": prev_state.get("task_memory", []),
        "memory_refs": prev_state.get("memory_refs", []),
        "trace_events": [],
        "final_answer": "",
    }

    _runs[thread_id] = {
        "events": event_queue,
        "state": continued_state,
        "status": "running",
        "interrupt_ctx": None,
    }

    threading.Thread(
        target=_run_graph_from_state,
        args=(continued_state, event_queue, thread_id, new_run_id),
        daemon=True,
    ).start()

    return JSONResponse({"thread_id": thread_id, "run_id": new_run_id})


# ── SSE 流 ────────────────────────────────────────────


@app.get("/api/stream/{thread_id}")
async def stream_events(request: Request, thread_id: str):
    run = _runs.get(thread_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    queue: _queue.Queue = run["events"]

    async def event_generator():
        while True:
            if await request.is_disconnected():
                break
            try:
                event = await asyncio.get_event_loop().run_in_executor(
                    None, lambda: queue.get(timeout=60)
                )
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                if event["type"] in ("done", "error"):
                    break
            except _queue.Empty:
                yield f"data: {json.dumps({'type': 'ping'})}\n\n"

    from fastapi.responses import StreamingResponse

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.get("/api/state/{thread_id}")
async def get_state(thread_id: str) -> JSONResponse:
    run = _runs.get(thread_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    try:
        return JSONResponse({
            "status": run.get("status", "unknown"),
            "state": _serialize_event(run.get("state", {})),
        })
    except Exception as e:
        return JSONResponse({
            "status": run.get("status", "error"),
            "state": {"error": str(e)},
        })


@app.post("/api/approve/{thread_id}")
async def approve_interrupt(thread_id: str, req: ApproveRequest) -> JSONResponse:
    """Legacy approve endpoint — 记录决策。"""
    _runs[thread_id]["approval"] = req.decision
    return JSONResponse({"status": "recorded", "decision": req.decision})


@app.post("/api/resume/{thread_id}")
async def resume_run(thread_id: str, req: ApproveRequest) -> JSONResponse:
    """恢复被 interrupt 暂停的图执行。"""
    run = _runs.get(thread_id)
    if not run or run.get("status") != "waiting_approval":
        raise HTTPException(status_code=400, detail="No pending approval for this thread")

    decision = "approved" if req.decision in ("y", "yes", "approved") else "rejected"
    app_graph = run["graph"]
    thread_config = run["config"]
    event_queue = run["events"]

    threading.Thread(
        target=_resume_graph,
        args=(app_graph, thread_config, decision, event_queue, thread_id),
        daemon=True,
    ).start()

    return JSONResponse({"status": "resumed", "decision": decision})


@app.post("/api/cancel/{thread_id}")
async def cancel_run(thread_id: str) -> JSONResponse:
    """取消正在运行的任务。"""
    run = _runs.get(thread_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run.get("status") not in ("running", "waiting_approval"):
        raise HTTPException(status_code=400, detail="Run is not active")

    run["status"] = "cancelled"
    run["state"] = {**run.get("state", {}), "status": "cancelled"}
    event_queue = run.get("events")
    if event_queue:
        event_queue.put({"type": "done"})

    return JSONResponse({"status": "cancelled"})


# ── 历史记录辅助 ──────────────────────────────────────


def _save_history(thread_id: str):
    """持久化已完成任务的历史记录。"""
    s = _runs.get(thread_id, {}).get("state", {})
    _append_persisted_history({
        "thread_id": thread_id,
        "status": "completed",
        "task": (s.get("task_goal", "") or "")[:80],
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "final_answer": s.get("final_answer", "")[:200],
    })


def _save_history_failed(thread_id: str, error: str):
    """持久化失败任务的历史记录。"""
    _append_persisted_history({
        "thread_id": thread_id,
        "status": "failed",
        "task": "",
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "final_answer": str(error)[:200],
    })


# ── 历史记录 API ──────────────────────────────────────


@app.get("/api/history")
async def list_runs() -> JSONResponse:
    """返回当前会话的运行时记录 + 持久化历史。"""
    summary = []
    for tid, run in _runs.items():
        s = run.get("state", {})
        summary.append({
            "thread_id": tid,
            "status": run.get("status", "unknown"),
            "task": (s.get("task_goal", "") or "")[:80],
            "agents": s.get("current_agent", ""),
        })
    history = _load_persisted_history()
    return JSONResponse({
        "session": summary[::-1][:20],
        "persisted": history[::-1][:50],
    })


@app.post("/api/history/clear")
async def clear_history() -> JSONResponse:
    """清除持久化历史记录。"""
    _ensure_history_dir()
    try:
        with open(HISTORY_FILE, "w", encoding="utf-8") as f:
            json.dump([], f)
    except Exception:
        pass
    return JSONResponse({"status": "cleared"})


# ── 序列化辅助 ─────────────────────────────────────────


def _serialize_event(state: dict) -> dict:
    return {
        "stage": state.get("current_stage", ""),
        "agent": state.get("current_agent", ""),
        "status": state.get("status", ""),
        "messages": state.get("messages", [])[-6:],
        "plan": (state.get("plan", []) or [])[:5],
        "tool_results": _serialize_tool_results(state.get("tool_results", [])),
        "trace_events": _serialize_trace_events(state.get("trace_events", [])),
        "memory_refs": state.get("memory_refs", []),
        "retry_count": state.get("retry_count", {}),
        "final_answer": state.get("final_answer", ""),
    }


def _serialize_tool_results(results: list) -> list[dict]:
    out = []
    for r in (results or [])[-6:]:
        try:
            if isinstance(r, dict):
                out.append({
                    "tool": r.get("tool_name", ""),
                    "summary": (r.get("summary", "") or "")[:120],
                    "success": r.get("success", False),
                    "duration_ms": r.get("duration_ms", 0),
                })
            else:
                out.append({
                    "tool": getattr(r, "tool_name", ""),
                    "summary": (getattr(r, "summary", "") or "")[:120],
                    "success": getattr(r, "success", False),
                    "duration_ms": getattr(r, "duration_ms", 0),
                })
        except Exception:
            out.append({"tool": "?", "summary": "serialize error", "success": False, "duration_ms": 0})
    return out


def _serialize_trace_events(events: list) -> list[dict]:
    """将 TraceEvent 列表序列化为前端可用格式。"""
    out = []
    for e in (events or [])[-50:]:
        try:
            if isinstance(e, dict):
                out.append({
                    "type": e.get("event_type", "?"),
                    "agent": e.get("agent", ""),
                    "summary": (e.get("summary", "") or "")[:120],
                    "ts": (e.get("timestamp", "") or "")[11:23],
                    "ms": e.get("duration_ms", 0),
                })
            else:
                out.append({
                    "type": getattr(e, "event_type", "?"),
                    "agent": getattr(e, "agent", ""),
                    "summary": (getattr(e, "summary", "") or "")[:120],
                    "ts": (getattr(e, "timestamp", "") or "")[11:23],
                    "ms": getattr(e, "duration_ms", 0),
                })
        except Exception:
            out.append({"type": "?", "agent": "", "summary": "serialize error", "ts": "", "ms": 0})
    return out


# ── 入口 ──────────────────────────────────────────────


def main() -> None:
    import argparse
    parser = argparse.ArgumentParser(description="Multi-Agent System Web UI")
    parser.add_argument(
        "--workspace", "-w",
        default=".",
        help="Working directory for command execution (default: current dir)",
    )
    parser.add_argument("--port", "-p", type=int, default=8080, help="Port (default: 8080)")
    args = parser.parse_args()

    ws = os.path.abspath(args.workspace)
    os.chdir(ws)
    global _current_workspace
    _current_workspace = ws
    ToolExecutor.set_workspace(ws)
    import uvicorn
    print(f"Workspace: {ws}")
    print(f"URL: http://127.0.0.1:{args.port}")
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")


if __name__ == "__main__":
    main()
