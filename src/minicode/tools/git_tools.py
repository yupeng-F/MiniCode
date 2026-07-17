from __future__ import annotations

import subprocess

from minicode.context.artifact_store import ArtifactStore
from minicode.runtime.workspace_manager import WorkspaceManager
from minicode.schemas.tool import ToolCall, ToolResult


def git_status_tool(call: ToolCall, workspace: WorkspaceManager, artifacts: ArtifactStore, run_id: str) -> ToolResult:
    proc = subprocess.run(["git", "status", "--short"], cwd=workspace.root, capture_output=True, text=True, timeout=10)
    return ToolResult(call_id=call.call_id, tool_name="git_status", success=proc.returncode == 0, summary="Git status", preview=proc.stdout[:3000], exit_code=proc.returncode)


def git_diff_tool(call: ToolCall, workspace: WorkspaceManager, artifacts: ArtifactStore, run_id: str) -> ToolResult:
    proc = subprocess.run(["git", "diff", "--", "."], cwd=workspace.root, capture_output=True, text=True, timeout=20)
    artifact_ref = artifacts.put(run_id, "git-diff", proc.stdout) if len(proc.stdout) > 3000 else None
    return ToolResult(call_id=call.call_id, tool_name="git_diff", success=proc.returncode == 0, summary="Git diff", preview=proc.stdout[:3000], artifact_ref=artifact_ref, exit_code=proc.returncode)
