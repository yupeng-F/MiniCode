from __future__ import annotations

from datetime import datetime, timezone

from minicode.runtime.approval_gate import ApprovalRequired
from minicode.runtime.policy_engine import PolicyEngine
from minicode.runtime.tool_executor import ToolExecutor
from minicode.runtime.tool_registry import ToolRegistry
from minicode.schemas.tool import ToolCall, ToolCallRecord


class HarnessRuntime:
    """Single controlled gateway for all tool execution."""

    def __init__(self, registry: ToolRegistry, policy: PolicyEngine, executor: ToolExecutor) -> None:
        self.registry = registry
        self.policy = policy
        self.executor = executor

    def execute(self, call: ToolCall, run_id: str, approved: bool = False) -> ToolCallRecord:
        spec = self.registry.get(call.tool_name)
        decision = self.policy.evaluate(call, spec)
        record = ToolCallRecord(call_id=call.call_id, tool_name=call.tool_name, request=call)

        if decision.decision == "deny":
            record.status = "failed"
            record.completed_at = datetime.now(timezone.utc).isoformat()
            return record

        if decision.requires_approval and not approved:
            record.status = "approval_required"
            raise ApprovalRequired(call, decision)

        record.status = "running"
        result = self.executor.execute(call, run_id)
        record.result = result
        record.status = "succeeded" if result.success else "failed"
        record.completed_at = datetime.now(timezone.utc).isoformat()
        return record
