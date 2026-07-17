from __future__ import annotations

from minicode.context.artifact_store import ArtifactStore
from minicode.runtime.workspace_manager import WorkspaceManager
from minicode.schemas.tool import ToolCall, ToolResult


HIDDEN_WORKSPACE_ENTRIES = {".minicode", "__pycache__", ".pytest_cache"}
DEFAULT_READ_LIMIT = 400
MAX_READ_LIMIT = 2_000
MAX_READ_PREVIEW_CHARS = 12_000


def read_file_tool(call: ToolCall, workspace: WorkspaceManager, artifacts: ArtifactStore, run_id: str) -> ToolResult:
    path = workspace.resolve_path(str(call.arguments.get("path", "")))
    offset = max(int(call.arguments.get("offset", 0)), 0)
    limit = min(max(int(call.arguments.get("limit", DEFAULT_READ_LIMIT)), 1), MAX_READ_LIMIT)
    lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    selected = _fit_preview(lines[offset: offset + limit])
    content = "\n".join(selected)
    next_offset = offset + len(selected)
    if next_offset >= len(lines):
        next_offset = None
    truncated = next_offset is not None
    artifact_ref = artifacts.put(run_id, f"read-{path.name}", "\n".join(lines)) if truncated else None
    if selected:
        line_range = f"lines {offset + 1}-{offset + len(selected)}"
    else:
        line_range = "0 lines"
    continuation = f"; next_offset={next_offset}" if next_offset is not None else "; end_of_file=true"
    return ToolResult(
        call_id=call.call_id,
        tool_name="read_file",
        success=True,
        summary=f"Read {line_range} of {len(lines)} from {workspace.display_path(path)}{continuation}",
        preview=content,
        artifact_ref=artifact_ref,
        metadata={
            "path": workspace.display_path(path),
            "offset": offset,
            "returned_lines": len(selected),
            "total_lines": len(lines),
            "next_offset": next_offset,
            "truncated": truncated,
        },
    )


def _fit_preview(lines: list[str]) -> list[str]:
    selected: list[str] = []
    size = 0
    for line in lines:
        separator_size = 1 if selected else 0
        if selected and size + separator_size + len(line) > MAX_READ_PREVIEW_CHARS:
            break
        if not selected and len(line) > MAX_READ_PREVIEW_CHARS:
            selected.append(line[:MAX_READ_PREVIEW_CHARS])
            break
        selected.append(line)
        size += separator_size + len(line)
    return selected


def list_directory_tool(call: ToolCall, workspace: WorkspaceManager, artifacts: ArtifactStore, run_id: str) -> ToolResult:
    path = workspace.resolve_path(str(call.arguments.get("path", ".")))
    entries = []
    for child in sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        if child.name in HIDDEN_WORKSPACE_ENTRIES:
            continue
        if workspace.is_sensitive_path(child):
            continue
        marker = "D" if child.is_dir() else "F"
        entries.append(f"[{marker}] {child.name}")
    preview = "\n".join(entries)
    return ToolResult(
        call_id=call.call_id,
        tool_name="list_directory",
        success=True,
        summary=f"Listed {len(entries)} entries in {workspace.display_path(path)}",
        preview=preview[:3000],
    )
