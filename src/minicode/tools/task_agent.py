from __future__ import annotations

import json

from minicode.context.artifact_store import ArtifactStore
from minicode.context.context_manager import ContextManager
from minicode.engine.model_client import ModelClient
from minicode.engine.query_loop import QueryLoop
from minicode.runtime.harness import HarnessRuntime
from minicode.runtime.policy_engine import PolicyEngine
from minicode.runtime.tool_executor import ToolExecutor
from minicode.runtime.tool_registry import ToolRegistry
from minicode.runtime.workspace_manager import WorkspaceManager
from minicode.schemas.session import Message, SessionState
from minicode.schemas.tool import ToolCall, ToolResult
from minicode.tools.base import build_default_registry

ROLE_TOOLS = {
    "explorer": {"read_file", "list_directory", "glob_files", "grep", "git_status"},
    "reviewer": {"read_file", "list_directory", "glob_files", "grep", "git_status", "git_diff"},
}


class _BudgetRuntime(HarnessRuntime):
    def __init__(self, *args, max_tool_calls: int, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.max_tool_calls = max_tool_calls
        self.executed_calls = 0

    def execute(self, call: ToolCall, run_id: str, approved: bool = False):
        if self.executed_calls >= self.max_tool_calls:
            from minicode.schemas.tool import ToolCallRecord

            result = ToolResult(
                call_id=call.call_id,
                tool_name=call.tool_name,
                success=False,
                summary="Sub-agent tool budget exhausted",
                exit_code=1,
                metadata={"budget_exhausted": True},
            )
            return ToolCallRecord(call_id=call.call_id, tool_name=call.tool_name, request=call, status="failed", result=result)
        self.executed_calls += 1
        return super().execute(call, run_id, approved)


def _restricted_registry(role: str) -> ToolRegistry:
    registry = ToolRegistry()
    defaults = build_default_registry()
    for name in ROLE_TOOLS[role]:
        spec = defaults.get(name)
        if spec is not None and spec.read_only and not spec.side_effect:
            spec.allowed_roles = [role]
            registry.register(spec)
    return registry


def run_task_agent(
    call: ToolCall,
    workspace: WorkspaceManager,
    artifacts: ArtifactStore,
    parent_run_id: str,
    model: ModelClient,
) -> ToolResult:
    task = str(call.arguments.get("task", "")).strip()
    role = str(call.arguments.get("role", "")).strip().lower()
    if not task:
        return ToolResult(call_id=call.call_id, tool_name="task_agent", success=False, summary="Task is required", exit_code=1)
    if role not in ROLE_TOOLS:
        return ToolResult(call_id=call.call_id, tool_name="task_agent", success=False, summary="Role must be explorer or reviewer", exit_code=1)

    try:
        max_steps = max(1, min(int(call.arguments.get("max_steps", 8)), 12))
        max_tool_calls = max(1, min(int(call.arguments.get("max_tool_calls", 6)), 10))
    except (TypeError, ValueError):
        return ToolResult(call_id=call.call_id, tool_name="task_agent", success=False, summary="Budgets must be integers", exit_code=1)
    child_run_id = f"{parent_run_id}-task-{call.call_id}"
    registry = _restricted_registry(role)
    nested_executor = ToolExecutor(workspace, artifacts, task_agent_model=None)
    runtime = _BudgetRuntime(registry, PolicyEngine(), nested_executor, max_tool_calls=max_tool_calls)
    session = SessionState(run_id=child_run_id, workspace=str(workspace.root), mode="review", task=task)
    session.messages.append(Message(
        role="user",
        content=(
            f"Act as a read-only {role}. Answer only the focused task below using repository evidence. "
            "Do not propose or perform writes, shell commands, tests, or delegation.\n\n"
            f"Task: {task}"
        ),
    ))
    loop = QueryLoop(model, runtime, ContextManager(), max_steps=max_steps, role=role)
    outcome = loop.run(session)
    calls = outcome.tool_calls
    payload = {
        "role": role,
        "task": task,
        "status": outcome.status,
        "answer": outcome.final_answer,
        "tool_calls": runtime.executed_calls,
        "tool_attempts": len(calls),
        "inspected_files": sorted({
            str(record.result.metadata["path"])
            for record in calls
            if record.result and "path" in record.result.metadata
        }),
    }
    rendered = json.dumps(payload, ensure_ascii=False, indent=2)
    artifact_ref = artifacts.put(parent_run_id, f"task-agent-{role}", rendered) if len(rendered) > 4000 else None
    return ToolResult(
        call_id=call.call_id,
        tool_name="task_agent",
        success=outcome.status == "completed",
        summary=f"{role} task {outcome.status} after {runtime.executed_calls} tool calls",
        preview=rendered[:4000],
        artifact_ref=artifact_ref,
        metadata={"child_run_id": child_run_id, "role": role, "tool_calls": runtime.executed_calls},
        exit_code=0 if outcome.status == "completed" else 1,
    )
