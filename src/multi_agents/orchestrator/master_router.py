from __future__ import annotations

from typing import Literal

from multi_agents.schemas.state import GraphState

# 硬上限：任何 Agent 最多返工 5 次
HARD_CEILING = 5


def route_master(state: GraphState) -> Literal[
    "explorer", "coder", "reviewer", "tester",
    "memory_writer", "finalize", "force_finalize",
]:
    """Master 调度路由：读取 next_agent，含硬上限保护。

    Master Agent 的 LLM 输出 next_agent 枚举值，
    此函数只做机械跳转，不做任何 LLM 级别的判断。
    """
    decision = state.get("last_decision", {})
    uf = decision.get("update_fields", {})
    dispatch = uf.get("master_dispatch", {})
    next_agent = dispatch.get("next_agent")

    # 任务完成
    if next_agent is None or dispatch.get("task_complete"):
        return "finalize"

    # 硬上限检测：路由层直接截断，不依赖 LLM
    retries = state.get("retry_count", {})
    if retries.get(next_agent, 0) >= HARD_CEILING:
        return "force_finalize"

    return next_agent


def route_after_specialist(
    state: GraphState,
) -> Literal["master_plan", "execute_tool", "execute_tool_approval"]:
    """Specialist 执行完毕后，路由到执行工具或走审批。

    规则：
    - 无待执行工具 → 回 Master
    - 有待执行工具且 risk_level=high → 走审批节点
    - 有待执行工具且 risk_level≠high → 直接执行
    """
    requests = state.get("tool_requests", [])
    results = state.get("tool_results", [])
    pending = len(requests) - len(results)
    if pending > 0 and state.get("current_agent") in ("repo_explorer", "coder", "tester"):
        # 检查待执行工具的 risk_level
        pending_request = requests[len(results)]
        if pending_request.risk_level == "high":
            return "execute_tool_approval"
        return "execute_tool"
    return "master_plan"
