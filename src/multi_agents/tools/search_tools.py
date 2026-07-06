from __future__ import annotations

from multi_agents.schemas.tool import ToolResult
from multi_agents.tools.base import ToolSpec


SEARCH_CODE_TOOL = ToolSpec(
    name="search_code",
    description="Search source code within the workspace.",
    risk_level="low",
    side_effect=False,
    tags=["search", "code"],
)


def search_code_stub(query: str) -> ToolResult:
    """Placeholder search implementation."""

    return ToolResult(
        request_id="stub-search-code",
        tool_name="search_code",
        success=True,
        summary=f"Stub search for query: {query}",
    )
