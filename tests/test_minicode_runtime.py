from __future__ import annotations

from pathlib import Path

import pytest

from minicode.context.artifact_store import ArtifactStore
from minicode.runtime.harness import HarnessRuntime
from minicode.runtime.policy_engine import PolicyEngine
from minicode.runtime.tool_executor import ToolExecutor
from minicode.runtime.workspace_manager import WorkspaceManager, WorkspaceViolation
from minicode.schemas.tool import ToolCall
from minicode.tools import build_default_registry


def test_workspace_manager_blocks_path_escape(tmp_path: Path):
    workspace = WorkspaceManager(tmp_path)
    with pytest.raises(WorkspaceViolation):
        workspace.resolve_path("../outside.txt")


def test_policy_denies_side_effect_in_plan_mode():
    registry = build_default_registry()
    call = ToolCall(tool_name="apply_patch", mode="plan", arguments={"patch": ""})
    decision = PolicyEngine().evaluate(call, registry.get("apply_patch"))
    assert decision.decision == "deny"
    assert decision.matched_rule == "mode"


def test_bash_requires_approval_by_default():
    registry = build_default_registry()
    call = ToolCall(tool_name="bash", arguments={"command": "ls"})
    decision = PolicyEngine().evaluate(call, registry.get("bash"))
    assert decision.decision == "allow_with_approval"
    assert decision.requires_approval is True


def test_read_file_tool_uses_workspace(tmp_path: Path):
    target = tmp_path / "hello.txt"
    target.write_text("hello\nworld\n", encoding="utf-8")
    workspace = WorkspaceManager(tmp_path)
    executor = ToolExecutor(workspace, ArtifactStore(tmp_path / ".minicode"))

    result = executor.execute(ToolCall(tool_name="read_file", arguments={"path": "hello.txt"}), "run1")

    assert result.success is True
    assert "hello" in result.preview
    assert result.metadata["path"] == "hello.txt"


def test_read_file_returns_a_large_window_with_pagination_metadata(tmp_path: Path):
    target = tmp_path / "long.md"
    target.write_text("\n".join(f"line-{index:03d} " + "x" * 90 for index in range(80)), encoding="utf-8")
    executor = ToolExecutor(WorkspaceManager(tmp_path), ArtifactStore(tmp_path / ".minicode"))

    result = executor.execute(
        ToolCall(tool_name="read_file", arguments={"path": "long.md", "offset": 10, "limit": 50}),
        "run1",
    )

    assert "line-059" in result.preview
    assert result.metadata == {
        "path": "long.md",
        "offset": 10,
        "returned_lines": 50,
        "total_lines": 80,
        "next_offset": 60,
        "truncated": True,
    }
    assert "next_offset=60" in result.summary


def test_read_file_tool_blocks_sensitive_environment_files(tmp_path: Path):
    (tmp_path / ".env").write_text("DEEPSEEK_API_KEY=secret", encoding="utf-8")
    workspace = WorkspaceManager(tmp_path)
    executor = ToolExecutor(workspace, ArtifactStore(tmp_path / ".minicode"))

    result = executor.execute(ToolCall(tool_name="read_file", arguments={"path": ".env"}), "run1")

    assert result.success is False
    assert "sensitive" in result.summary.lower()
    assert "secret" not in result.preview


def test_list_directory_hides_agent_runtime_directory(tmp_path: Path):
    (tmp_path / ".minicode").mkdir()
    (tmp_path / "game.html").write_text("<!doctype html>", encoding="utf-8")
    workspace = WorkspaceManager(tmp_path)
    executor = ToolExecutor(workspace, ArtifactStore(tmp_path / ".minicode"))

    result = executor.execute(ToolCall(tool_name="list_directory", arguments={"path": "."}), "run1")

    assert "game.html" in result.preview
    assert ".minicode" not in result.preview


def test_harness_returns_approval_record_for_apply_patch(tmp_path: Path):
    workspace = WorkspaceManager(tmp_path)
    registry = build_default_registry()
    runtime = HarnessRuntime(registry, PolicyEngine(), ToolExecutor(workspace, ArtifactStore(tmp_path / ".minicode")))

    with pytest.raises(Exception):
        runtime.execute(ToolCall(tool_name="apply_patch", arguments={"patch": "x"}), "run1")
