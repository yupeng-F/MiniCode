from __future__ import annotations

from multi_agents.schemas.policy import PolicyDecision
from multi_agents.schemas.tool import ToolRequest


class PolicyEngine:
    """Simple policy engine placeholder."""

    def evaluate(self, request: ToolRequest) -> PolicyDecision:
        """Evaluate whether a tool request can proceed."""

        risk_level = request.risk_level
        if risk_level == "high":
            return PolicyDecision(
                decision="allow_with_approval",
                requires_approval=True,
                reason="High-risk tool requires approval.",
                risk_level="high",
                matched_rule="risk_level_high",
                safe_alternative="Use a lower-risk tool or request explicit approval.",
            )
        return PolicyDecision(
            decision="allow",
            requires_approval=False,
            reason="Low-risk tool may proceed.",
            risk_level="low",
            matched_rule="risk_level_low",
        )
