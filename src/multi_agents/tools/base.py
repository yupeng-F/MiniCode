from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(slots=True)
class ToolSpec:
    """Standardized tool metadata."""

    name: str
    description: str
    allowed_roles: list[str] = field(default_factory=list)  # 空列表 = 全部允许
    risk_level: str = "low"
    side_effect: bool = False
    timeout_seconds: int = 30
    requires_approval: bool = False
    tags: list[str] = field(default_factory=list)
