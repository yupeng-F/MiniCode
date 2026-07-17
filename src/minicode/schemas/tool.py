from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

from minicode.schemas.base import ModelMixin
from minicode.schemas.policy import RiskProfile


@dataclass(slots=True)
class ToolSpec(ModelMixin):
    name: str
    description: str
    input_schema: dict[str, Any] = field(default_factory=dict)
    read_only: bool = True
    side_effect: bool = False
    destructive: bool = False
    supports_parallel: bool = True
    requires_approval: bool = False
    allowed_modes: list[str] = field(default_factory=lambda: ["ask", "plan", "act", "review"])
    allowed_roles: list[str] = field(default_factory=list)
    risk: RiskProfile = field(default_factory=RiskProfile)
    timeout_seconds: int = 30


@dataclass(slots=True)
class ToolCall(ModelMixin):
    tool_name: str
    call_id: str = field(default_factory=lambda: str(uuid4())[:8])
    arguments: dict[str, Any] = field(default_factory=dict)
    intent: str = ""
    role: str = "assistant"
    mode: str = "act"


@dataclass(slots=True)
class ToolResult(ModelMixin):
    call_id: str
    tool_name: str
    success: bool
    summary: str
    preview: str = ""
    artifact_ref: str | None = None
    modified_paths: list[str] = field(default_factory=list)
    exit_code: int = 0
    duration_ms: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ToolCallRecord(ModelMixin):
    call_id: str
    tool_name: str
    request: ToolCall
    status: Literal[
        "pending",
        "approval_required",
        "approved",
        "running",
        "succeeded",
        "failed",
        "rejected",
    ] = "pending"
    result: ToolResult | None = None
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    completed_at: str | None = None
