from __future__ import annotations

import subprocess
import time

from minicode.context.artifact_store import ArtifactStore
from minicode.runtime.workspace_manager import WorkspaceManager
from minicode.schemas.tool import ToolCall, ToolResult


def run_tests_tool(call: ToolCall, workspace: WorkspaceManager, artifacts: ArtifactStore, run_id: str) -> ToolResult:
    command = str(call.arguments.get("command", "python -m pytest -q"))
    start = time.time()
    proc = subprocess.run(command, shell=True, cwd=workspace.root, capture_output=True, text=True, timeout=60)
    duration_ms = int((time.time() - start) * 1000)
    output = (proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else "")
    artifact_ref = artifacts.put(run_id, "test-output", output) if len(output) > 3000 else None
    return ToolResult(
        call_id=call.call_id,
        tool_name="run_tests",
        success=proc.returncode == 0,
        summary=f"Test command exited {proc.returncode}",
        preview=output[:3000],
        artifact_ref=artifact_ref,
        exit_code=proc.returncode,
        duration_ms=duration_ms,
    )
