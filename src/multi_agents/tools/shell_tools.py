from __future__ import annotations

from multi_agents.schemas.tool import ToolResult
from multi_agents.tools.base import ToolSpec


RUN_SHELL_TOOL = ToolSpec(
    name="run_shell",
    description="Execute a shell command in the controlled workspace.",
    risk_level="high",
    side_effect=True,
    requires_approval=True,
    tags=["shell", "execution"],
)


def run_shell_stub(command: str) -> ToolResult:
    """Placeholder shell execution implementation."""

    return ToolResult(
        request_id="stub-run-shell",
        tool_name="run_shell",
        success=True,
        summary=f"Stub shell execution: {command}",
    )
