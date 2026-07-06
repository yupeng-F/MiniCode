from __future__ import annotations

from multi_agents.runtime.policy_engine import PolicyEngine
from multi_agents.runtime.tool_executor import ToolExecutor
from multi_agents.schemas.policy import PolicyDecision
from multi_agents.schemas.tool import ToolRequest, ToolResult


class HarnessRuntime:
    """Single entrypoint for high-risk execution.

    Full flow: preflight (policy check) -> execute (tool dispatch) -> result.
    Preflight checks include:
    1. Role-based access control (via ToolRegistry)
    2. Risk-level policy decisions (via PolicyEngine)
    """

    def __init__(
        self,
        policy_engine: PolicyEngine | None = None,
        tool_executor: ToolExecutor | None = None,
    ) -> None:
        self.policy_engine = policy_engine or PolicyEngine()
        self.tool_executor = tool_executor or ToolExecutor()

    def preflight(self, request: ToolRequest) -> PolicyDecision:
        """Run policy checks before execution.

        Order:
        1. Role-based permission check (fast-fail if denied)
        2. Risk-level policy evaluation (allow / allow_with_approval / deny)
        """
        # 1. 角色权限检查
        if not self.tool_executor.registry.check_permission(
            request.agent_name, request.tool_name
        ):
            return PolicyDecision(
                decision="deny",
                requires_approval=False,
                reason=f"Role '{request.agent_name}' not allowed to use tool '{request.tool_name}'",
                risk_level=request.risk_level,
                matched_rule="role_based_access_control",
            )

        # 2. 策略引擎评估
        return self.policy_engine.evaluate(request)

    def execute(self, request: ToolRequest) -> ToolResult:
        """Full execution: check policy, then dispatch."""
        decision = self.preflight(request)

        # 如果被拒绝，不执行工具
        if decision.decision == "deny":
            return ToolResult(
                request_id=request.request_id,
                tool_name=request.tool_name,
                success=False,
                summary=decision.reason,
                exit_code=1,
            )

        result = self.tool_executor.execute(request)
        result.policy_trace = {
            "decision": decision.decision,
            "reason": decision.reason,
            "matched_rule": decision.matched_rule,
        }
        return result
