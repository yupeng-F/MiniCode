from __future__ import annotations

from minicode.schemas.tool import ToolSpec


def describe_tools(tools: list[ToolSpec]) -> list[str]:
    return [f"- {tool.name}: {tool.description}" for tool in tools]


def tool_specs_for_model(tools: list[ToolSpec]) -> list[dict]:
    return [tool.model_dump() for tool in tools]
