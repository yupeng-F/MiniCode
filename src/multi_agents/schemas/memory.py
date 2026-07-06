from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class MemoryEntry(BaseModel):
    """Structured long-term memory entry."""

    memory_id: str
    memory_type: Literal[
        "user_profile",
        "repo_convention",
        "task_experience",
        "failure_case",
    ]
    title: str = ""
    content: str
    scope: Literal["user", "repo", "task-pattern"]
    confidence: float = 0.5
    source_run_id: str
    source_artifact_refs: list[str] = Field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""
    expiry_policy: str = ""
    tags: list[str] = Field(default_factory=list)

