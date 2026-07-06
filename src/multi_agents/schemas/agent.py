from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from multi_agents.schemas.tool import ToolRequest


class AgentDecision(BaseModel):
    """Structured output produced by an agent for the orchestrator."""

    agent_name: str
    summary: str
    next_action: Literal[
        "continue",
        "request_tool",
        "handoff",
        "retry",
        "finalize",
        "need_approval",
    ] = "continue"
    reasoning_notes: list[str] = Field(default_factory=list)
    proposed_tool_request: ToolRequest | None = None
    update_fields: dict[str, Any] = Field(default_factory=dict)
    risk_summary: str = ""

