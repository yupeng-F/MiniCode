from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from minicode.schemas.base import ModelMixin


@dataclass(slots=True)
class Event(ModelMixin):
    type: str
    summary: str = ""
    run_id: str = ""
    payload: dict[str, Any] = field(default_factory=dict)
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
