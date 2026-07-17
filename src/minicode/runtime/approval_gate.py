from __future__ import annotations

from minicode.schemas.policy import PolicyDecision
from minicode.schemas.tool import ToolCall


class ApprovalRequired(RuntimeError):
    def __init__(self, call: ToolCall, decision: PolicyDecision) -> None:
        super().__init__(decision.reason)
        self.call = call
        self.decision = decision
