from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4

from minicode.schemas.base import ModelMixin
from minicode.schemas.tool import ToolCall, ToolCallRecord


DEFAULT_MODEL_ID = "deepseek-v4-flash"


@dataclass(slots=True)
class Message(ModelMixin):
    role: str
    content: str
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


@dataclass(slots=True)
class SessionState(ModelMixin):
    session_id: str = field(default_factory=lambda: str(uuid4()))
    run_id: str = field(default_factory=lambda: str(uuid4()))
    workspace: str = "."
    mode: Literal["ask", "plan", "act", "review"] = "act"
    model_id: str = DEFAULT_MODEL_ID
    run_model_id: str = ""
    status: Literal["pending", "running", "waiting_approval", "completed", "failed", "cancelled"] = "pending"
    task: str = ""
    messages: list[Message] = field(default_factory=list)
    tool_calls: list[ToolCallRecord] = field(default_factory=list)
    active_files: list[str] = field(default_factory=list)
    plan: list[str] = field(default_factory=list)
    memory_refs: list[str] = field(default_factory=list)
    memory_retrieval: dict[str, object] = field(default_factory=dict)
    compact_summary: str = ""
    context_usage: dict[str, int] = field(default_factory=dict)
    context_dropped: list[str] = field(default_factory=list)
    final_answer: str = ""
    pending_tool_call: ToolCall | None = None
    pending_approval_reason: str = ""
