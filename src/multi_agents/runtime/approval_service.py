from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class ApprovalRequest:
    tool_name: str
    reason: str


class ApprovalService:
    """Approval gate placeholder."""

    def request(self, approval: ApprovalRequest) -> bool:
        """Return False until a real human-in-the-loop flow is added."""

        return False

