from __future__ import annotations

from multi_agents.schemas.tool import ToolResult
from multi_agents.tools.base import ToolSpec


READ_FILE_TOOL = ToolSpec(
    name="read_file",
    description="Read file content from the workspace.",
    risk_level="low",
    side_effect=False,
    tags=["filesystem", "read"],
)


WRITE_FILE_TOOL = ToolSpec(
    name="write_file",
    description="Write file content to the workspace.",
    risk_level="high",
    side_effect=True,
    requires_approval=True,
    tags=["filesystem", "write"],
)


LIST_DIRECTORY_TOOL = ToolSpec(
    name="list_directory",
    description="List files and subdirectories in a given directory path.",
    risk_level="low",
    side_effect=False,
    tags=["filesystem", "read"],
)


def read_file_stub(path: str) -> ToolResult:
    """Placeholder file read implementation."""

    return ToolResult(
        request_id="stub-read-file",
        tool_name="read_file",
        success=True,
        summary=f"Stub read for {path}",
    )
