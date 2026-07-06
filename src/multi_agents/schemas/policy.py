from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class PolicyDecision(BaseModel):
    """Policy evaluation result for a tool request."""

    decision: Literal["allow", "allow_with_approval", "deny"]
    reason: str
    risk_level: Literal["low", "medium", "high"] = "low"
    matched_rule: str = ""
    requires_approval: bool = False
    safe_alternative: str = ""

