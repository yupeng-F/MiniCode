from __future__ import annotations

import difflib
import subprocess
from pathlib import Path

from minicode.context.artifact_store import ArtifactStore
from minicode.runtime.workspace_manager import WorkspaceManager
from minicode.schemas.tool import ToolCall, ToolResult


def propose_patch_tool(call: ToolCall, workspace: WorkspaceManager, artifacts: ArtifactStore, run_id: str) -> ToolResult:
    path = workspace.resolve_path(str(call.arguments.get("path", "")))
    new_content = str(call.arguments.get("content", ""))
    old_content = path.read_text(encoding="utf-8", errors="ignore") if path.exists() else ""
    diff = "".join(difflib.unified_diff(
        old_content.splitlines(keepends=True),
        new_content.splitlines(keepends=True),
        fromfile=workspace.display_path(path),
        tofile=workspace.display_path(path),
    ))
    artifact_ref = artifacts.put(run_id, f"patch-{path.name}", diff)
    return ToolResult(
        call_id=call.call_id,
        tool_name="propose_patch",
        success=True,
        summary=f"Proposed patch for {workspace.display_path(path)}",
        preview=diff[:3000],
        artifact_ref=artifact_ref,
    )


def apply_patch_tool(call: ToolCall, workspace: WorkspaceManager, artifacts: ArtifactStore, run_id: str) -> ToolResult:
    patch_text = str(call.arguments.get("patch", ""))
    if not patch_text:
        requested_path = str(call.arguments.get("path", ""))
        if not requested_path:
            return ToolResult(call_id=call.call_id, tool_name="apply_patch", success=False, summary="No path provided", exit_code=1)
        path = workspace.resolve_path(requested_path)
        content = str(call.arguments.get("content", ""))
        old = path.read_text(encoding="utf-8", errors="ignore") if path.exists() else ""
        patch_text = "".join(difflib.unified_diff(
            old.splitlines(keepends=True),
            content.splitlines(keepends=True),
            fromfile=workspace.display_path(path),
            tofile=workspace.display_path(path),
        ))
        if path.exists() and old == content:
            return ToolResult(call_id=call.call_id, tool_name="apply_patch", success=True, summary="File already matches proposed content")
        artifact_ref = artifacts.put(run_id, "apply.patch", patch_text)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        except OSError as exc:
            return ToolResult(
                call_id=call.call_id,
                tool_name="apply_patch",
                success=False,
                summary=f"Could not write {workspace.display_path(path)}",
                preview=str(exc),
                artifact_ref=artifact_ref,
                exit_code=1,
            )
        return ToolResult(
            call_id=call.call_id,
            tool_name="apply_patch",
            success=True,
            summary=f"Updated {workspace.display_path(path)}",
            preview=patch_text[:3000],
            artifact_ref=artifact_ref,
            modified_paths=[workspace.display_path(path)],
        )
    if not patch_text:
        return ToolResult(call_id=call.call_id, tool_name="apply_patch", success=False, summary="No patch provided", exit_code=1)

    patch_file = Path(artifacts.root) / artifacts.put(run_id, "apply.patch", patch_text)
    proc = subprocess.run(["patch", "-p0", "-i", str(patch_file)], cwd=workspace.root, capture_output=True, text=True, timeout=20)
    output = (proc.stdout or "") + (proc.stderr or "")
    return ToolResult(
        call_id=call.call_id,
        tool_name="apply_patch",
        success=proc.returncode == 0,
        summary=f"Patch exit code {proc.returncode}",
        preview=output[:3000],
        artifact_ref=str(patch_file.relative_to(artifacts.root)),
        exit_code=proc.returncode,
    )
