from __future__ import annotations

import json
from pathlib import Path

from minicode.context.artifact_store import ArtifactStore
from minicode.engine.model_client import JsonScriptModel, ModelClient, ModelResponse
from minicode.runtime.tool_executor import ToolExecutor
from minicode.runtime.workspace_manager import WorkspaceManager
from minicode.schemas.tool import ToolCall
from minicode.tools import build_default_registry


class CapturingModel(ModelClient):
    def __init__(self, responses: list[ModelResponse]) -> None:
        self.responses = responses
        self.contexts: list[str] = []
        self.tools: list[list[dict]] = []

    def complete(self, context: str, tools: list[dict], tool_history=None) -> ModelResponse:
        self.contexts.append(context)
        self.tools.append(tools)
        return self.responses.pop(0)


def test_task_agent_is_isolated_and_explorer_has_read_only_allowlist(tmp_path: Path):
    (tmp_path / "notes.txt").write_text("repository evidence", encoding="utf-8")
    model = CapturingModel([
        ModelResponse(type="tool_use", tool_call=ToolCall(tool_name="read_file", arguments={"path": "notes.txt"})),
        ModelResponse(type="final", content="Found repository evidence."),
    ])
    executor = ToolExecutor(WorkspaceManager(tmp_path), ArtifactStore(tmp_path / ".minicode"), task_agent_model=model)

    result = executor.execute(ToolCall(
        tool_name="task_agent",
        arguments={"task": "What is in notes?", "role": "explorer"},
    ), "parent")

    assert result.success is True
    payload = json.loads(result.preview)
    assert payload["answer"] == "Found repository evidence."
    assert payload["inspected_files"] == ["notes.txt"]
    assert "What is in notes?" in model.contexts[0]
    tool_names = {tool["name"] for tool in model.tools[0]}
    assert tool_names == {"read_file", "list_directory", "glob_files", "grep", "git_status"}
    assert not ({"apply_patch", "bash", "run_tests", "task_agent"} & tool_names)


def test_task_agent_cannot_execute_tool_outside_role_allowlist(tmp_path: Path):
    model = JsonScriptModel([
        {"type": "tool_use", "tool_call": {"tool_name": "apply_patch", "arguments": {"path": "owned.txt", "content": "bad"}}},
        {"type": "final", "content": "Could not write."},
    ])
    executor = ToolExecutor(WorkspaceManager(tmp_path), ArtifactStore(tmp_path / ".minicode"), task_agent_model=model)

    result = executor.execute(ToolCall(
        tool_name="task_agent",
        arguments={"task": "Write a file", "role": "reviewer"},
    ), "parent")

    assert result.success is True
    assert not (tmp_path / "owned.txt").exists()


def test_task_agent_enforces_tool_budget_and_workspace_boundary(tmp_path: Path):
    outside = tmp_path.parent / "task-agent-secret.txt"
    outside.write_text("secret", encoding="utf-8")
    model = JsonScriptModel([
        {"type": "tool_use", "tool_call": {"tool_name": "read_file", "arguments": {"path": "../task-agent-secret.txt"}}},
        {"type": "tool_use", "tool_call": {"tool_name": "list_directory", "arguments": {"path": "."}}},
        {"type": "final", "content": "Done."},
    ])
    executor = ToolExecutor(WorkspaceManager(tmp_path), ArtifactStore(tmp_path / ".minicode"), task_agent_model=model)

    result = executor.execute(ToolCall(
        tool_name="task_agent",
        arguments={"task": "Inspect", "role": "explorer", "max_tool_calls": 1, "max_steps": 3},
    ), "parent")

    payload = json.loads(result.preview)
    assert payload["tool_calls"] == 1
    assert payload["tool_attempts"] == 2
    assert "secret" not in result.preview
    assert payload["status"] == "completed"


def test_default_registry_only_exposes_task_agent_to_parent_assistant():
    registry = build_default_registry()

    assert registry.get("task_agent") is not None
    assert "task_agent" in {tool.name for tool in registry.visible_tools("act", "assistant")}
    assert "task_agent" not in {tool.name for tool in registry.visible_tools("review", "reviewer")}
