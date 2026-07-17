from __future__ import annotations

import re

from minicode.schemas.policy import PolicyDecision
from minicode.schemas.tool import ToolCall, ToolSpec


class PolicyEngine:
    dangerous_command_patterns = [
        re.compile(r"\bsudo\b"),
        re.compile(r"\brm\s+(-rf|-fr)\b"),
        re.compile(r"\bgit\s+push\b"),
        re.compile(r"\bchmod\s+-R\b"),
        re.compile(r"\bcurl\b|\bwget\b"),
    ]

    def evaluate(self, call: ToolCall, spec: ToolSpec | None) -> PolicyDecision:
        if spec is None:
            return PolicyDecision(decision="deny", reason=f"Unknown tool: {call.tool_name}", matched_rule="unknown_tool")

        if call.mode not in spec.allowed_modes:
            return PolicyDecision(decision="deny", reason=f"Tool not allowed in mode {call.mode}", matched_rule="mode")

        if spec.allowed_roles and call.role not in spec.allowed_roles:
            return PolicyDecision(decision="deny", reason=f"Role {call.role} cannot use {call.tool_name}", matched_rule="role")

        if call.mode == "plan" and spec.side_effect:
            return PolicyDecision(decision="deny", reason="Plan mode is read-only", matched_rule="plan_read_only")

        if call.tool_name == "bash":
            command = str(call.arguments.get("command", ""))
            for pattern in self.dangerous_command_patterns:
                if pattern.search(command):
                    return PolicyDecision(
                        decision="allow_with_approval",
                        reason="Bash command matches a high-risk pattern",
                        matched_rule="dangerous_command",
                        requires_approval=True,
                    )
            return PolicyDecision(
                decision="allow_with_approval",
                reason="Bash is a fallback tool and requires approval by default",
                matched_rule="bash_default_approval",
                requires_approval=True,
            )

        if spec.requires_approval or spec.risk.approval == "always" or spec.destructive:
            return PolicyDecision(
                decision="allow_with_approval",
                reason="Tool requires approval",
                matched_rule="tool_requires_approval",
                requires_approval=True,
            )

        return PolicyDecision(decision="allow", reason="Allowed by policy", matched_rule="default_allow")
