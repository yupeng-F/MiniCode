from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class ToolRequest(BaseModel):
    """Standardized execution request produced by an agent."""

    request_id: str
    thread_id: str = ""
    run_id: str = ""
    agent_name: str
    mode: str = "act"
    current_stage: str = ""
    tool_name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    intent_summary: str = ""
    related_plan_step: str = ""
    risk_level: Literal["low", "medium", "high"] = "low"
    side_effect: bool = False
    requires_approval: bool = False
    target_paths: list[str] = Field(default_factory=list)
    target_command: str = ""
    network_scope: list[str] = Field(default_factory=list)


class ToolResult(BaseModel):
    """Standardized execution result returned by the runtime."""

    request_id: str
    tool_name: str
    success: bool
    summary: str
    stdout_preview: str = ""
    stderr_preview: str = ""
    artifact_refs: list[str] = Field(default_factory=list)
    modified_paths: list[str] = Field(default_factory=list)
    duration_ms: int = 0
    exit_code: int = 0
    policy_trace: dict[str, Any] = Field(default_factory=dict)
    execution_metadata: dict[str, Any] = Field(default_factory=dict)

