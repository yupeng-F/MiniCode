from __future__ import annotations

from typing import Literal

from multi_agents.schemas.state import GraphState


def route_after_tool(state: GraphState) -> Literal["explorer", "coder", "reviewer", "tester"]:
    """Route back to the specialist that requested the tool."""
    agent = state.get("current_agent", "")
    if agent == "repo_explorer":
        return "explorer"
    if agent == "tester":
        return "tester"
    return "coder"  # coder 和 reviewer 都回 coder 节点


def route_after_tool_approval(
    state: GraphState,
) -> Literal["execute_tool", "master_plan"]:
    """审批中断恢复后路由。

    审批通过 → execute_tool（将工具真正执行）
    审批拒绝 → master_plan（让 Master 重新决策）
    """
    ctx = state.get("approval_context", {})
    if ctx.get("decision") == "approved":
        return "execute_tool"
    return "master_plan"
