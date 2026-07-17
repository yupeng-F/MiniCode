from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from uuid import uuid4

from minicode.schemas.base import ModelMixin


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(slots=True)
class Project(ModelMixin):
    project_id: str = field(default_factory=lambda: str(uuid4())[:8])
    workspace: str = "."
    title: str = ""
    created_at: str = field(default_factory=_timestamp)
    updated_at: str = field(default_factory=_timestamp)


@dataclass(slots=True)
class SessionSummary(ModelMixin):
    session_id: str
    project_id: str
    title: str
    status: str
    updated_at: str
