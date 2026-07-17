from __future__ import annotations

import fnmatch
import subprocess

from minicode.context.artifact_store import ArtifactStore
from minicode.runtime.workspace_manager import WorkspaceManager
from minicode.schemas.tool import ToolCall, ToolResult

EXCLUDED_DIRS = {".git", ".minicode", "__pycache__", "node_modules", ".venv", "venv", "dist", "build"}


def glob_files_tool(call: ToolCall, workspace: WorkspaceManager, artifacts: ArtifactStore, run_id: str) -> ToolResult:
    pattern = str(call.arguments.get("pattern", "**/*"))
    max_results = int(call.arguments.get("max_results", 100))
    matches: list[str] = []
    for path in workspace.root.rglob("*"):
        if any(part in EXCLUDED_DIRS for part in path.parts):
            continue
        if workspace.is_sensitive_path(path):
            continue
        rel = str(path.relative_to(workspace.root))
        if fnmatch.fnmatch(rel, pattern):
            matches.append(rel)
            if len(matches) >= max_results:
                break
    preview = "\n".join(matches)
    return ToolResult(call_id=call.call_id, tool_name="glob_files", success=True, summary=f"Found {len(matches)} files", preview=preview)


def grep_tool(call: ToolCall, workspace: WorkspaceManager, artifacts: ArtifactStore, run_id: str) -> ToolResult:
    query = str(call.arguments.get("query", ""))
    path = workspace.resolve_path(str(call.arguments.get("path", ".")))
    max_results = int(call.arguments.get("max_results", 80))
    if not query:
        return ToolResult(call_id=call.call_id, tool_name="grep", success=False, summary="No query provided", exit_code=1)

    try:
        proc = subprocess.run(
            [
                "rg", "--line-number", "--no-heading", "--max-count", str(max_results),
                "--glob", "!.env", "--glob", "!.env.*", "--glob", "!*.pem", "--glob", "!*.key",
                query, str(path),
            ],
            cwd=workspace.root,
            capture_output=True,
            text=True,
            timeout=20,
        )
        output = proc.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        output = _python_grep(query, path, workspace, max_results)

    artifact_ref = artifacts.put(run_id, "grep-output", output) if len(output) > 8000 else None
    count = len([line for line in output.splitlines() if line.strip()])
    return ToolResult(call_id=call.call_id, tool_name="grep", success=True, summary=f"Found {count} matches", preview=output[:3000], artifact_ref=artifact_ref)


def _python_grep(query: str, path, workspace: WorkspaceManager, max_results: int) -> str:
    root = path if path.is_dir() else path.parent
    matches: list[str] = []
    for file_path in root.rglob("*"):
        if len(matches) >= max_results:
            break
        if not file_path.is_file() or any(part in EXCLUDED_DIRS for part in file_path.parts):
            continue
        if workspace.is_sensitive_path(file_path):
            continue
        try:
            for lineno, line in enumerate(file_path.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
                if query.lower() in line.lower():
                    matches.append(f"{file_path.relative_to(workspace.root)}:{lineno}: {line[:160]}")
                    if len(matches) >= max_results:
                        break
        except OSError:
            continue
    return "\n".join(matches)
