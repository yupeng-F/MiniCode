from __future__ import annotations

import subprocess
import time
from collections.abc import Callable

from minicode.context.artifact_store import ArtifactStore
from minicode.runtime.workspace_manager import WorkspaceManager
from minicode.schemas.tool import ToolCall, ToolResult
from minicode.tools.edit_tools import apply_patch_tool, propose_patch_tool
from minicode.tools.file_tools import list_directory_tool, read_file_tool
from minicode.tools.git_tools import git_diff_tool, git_status_tool
from minicode.tools.search_tools import glob_files_tool, grep_tool
from minicode.tools.test_tools import run_tests_tool

ToolHandler = Callable[[ToolCall, WorkspaceManager, ArtifactStore, str], ToolResult]


class ToolExecutor:
    def __init__(self, workspace: WorkspaceManager, artifacts: ArtifactStore | None = None) -> None:
        self.workspace = workspace
        self.artifacts = artifacts or ArtifactStore(workspace.root / ".minicode")
        self.handlers: dict[str, ToolHandler] = {
            "read_file": read_file_tool,
            "list_directory": list_directory_tool,
            "glob_files": glob_files_tool,
            "grep": grep_tool,
            "propose_patch": propose_patch_tool,
            "apply_patch": apply_patch_tool,
            "run_tests": run_tests_tool,
            "git_status": git_status_tool,
            "git_diff": git_diff_tool,
            "bash": self._bash,
        }

    def execute(self, call: ToolCall, run_id: str) -> ToolResult:
        handler = self.handlers.get(call.tool_name)
        if handler is None:
            return ToolResult(call_id=call.call_id, tool_name=call.tool_name, success=False, summary="Unknown tool", exit_code=1)
        try:
            if call.tool_name in {"read_file", "grep", "list_directory"}:
                self.workspace.ensure_safe_to_read(str(call.arguments.get("path", ".")))
            return handler(call, self.workspace, self.artifacts, run_id)
        except Exception as exc:
            return ToolResult(call_id=call.call_id, tool_name=call.tool_name, success=False, summary=str(exc), exit_code=1)

    def _bash(self, call: ToolCall, workspace: WorkspaceManager, artifacts: ArtifactStore, run_id: str) -> ToolResult:
        command = str(call.arguments.get("command", "")).strip()
        if not command:
            return ToolResult(call_id=call.call_id, tool_name="bash", success=False, summary="No command provided", exit_code=1)
        start = time.time()
        proc = subprocess.run(command, shell=True, cwd=workspace.root, capture_output=True, text=True, timeout=30)
        duration_ms = int((time.time() - start) * 1000)
        output = (proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else "")
        artifact_ref = artifacts.put(run_id, "bash-output", output) if len(output) > 4000 else None
        return ToolResult(
            call_id=call.call_id,
            tool_name="bash",
            success=proc.returncode == 0,
            summary=f"Exit code {proc.returncode}",
            preview=output[:2000],
            artifact_ref=artifact_ref,
            exit_code=proc.returncode,
            duration_ms=duration_ms,
        )
