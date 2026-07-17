from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from minicode.schemas.tool import ToolCall, ToolCallRecord


@dataclass(slots=True)
class ModelResponse:
    type: Literal["final", "tool_use"]
    content: str = ""
    tool_call: ToolCall | None = None


class ModelClient:
    supports_native_tool_history = False

    def complete(
        self,
        context: str,
        tools: list[dict],
        tool_history: list[ToolCallRecord] | None = None,
    ) -> ModelResponse:
        raise NotImplementedError


class JsonScriptModel(ModelClient):
    """Deterministic model for tests and offline demos.

    Each script item is either {"type": "final", "content": "..."} or a ToolCall dict.
    """

    def __init__(self, script: list[dict] | None = None) -> None:
        self.script = script or [{"type": "final", "content": "Done."}]
        self.index = 0

    def complete(
        self,
        context: str,
        tools: list[dict],
        tool_history: list[ToolCallRecord] | None = None,
    ) -> ModelResponse:
        item = self.script[min(self.index, len(self.script) - 1)]
        self.index += 1
        if item.get("type") == "tool_use":
            return ModelResponse(type="tool_use", tool_call=ToolCall(**item["tool_call"]))
        return ModelResponse(type="final", content=item.get("content", "Done."))
