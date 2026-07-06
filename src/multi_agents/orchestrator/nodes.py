from __future__ import annotations

from uuid import uuid4

from langgraph.types import interrupt

from multi_agents.observability.audit_logger import log_tool_execution
from multi_agents.observability.tracer import record_trace
from multi_agents.runtime.harness import HarnessRuntime
from multi_agents.schemas.state import GraphState
from multi_agents.schemas.tool import ToolRequest, ToolResult


def task_intake(state: GraphState) -> GraphState:
    """Initialize ephemeral run fields."""
    goal = (state.get("task_goal", "") or "")[:80]
    return {
        "thread_id": state.get("thread_id") or str(uuid4())[:8],
        "run_id": state.get("run_id") or str(uuid4())[:8],
        "status": "running",
        "current_stage": "task_intake",
        "current_agent": "",
        "retry_count": state.get("retry_count", {"review": 0, "testing": 0}),
        "trace_events": [record_trace("task_start", "system", f"Task: {goal}")],
    }


def execute_tool(state: GraphState) -> GraphState:
    """Execute the last unprocessed ToolRequest through HarnessRuntime.

    Reads the last tool_request, runs it, writes the ToolResult.
    """
    requests: list[ToolRequest] = state.get("tool_requests", [])
    results = state.get("tool_results", [])
    pending = len(requests) - len(results)  # # 待执行数

    if pending <= 0:  # 没待执行的就跳过
        return {"tool_results": [_stub_result("noop", "No pending tool request.")]}

    request = requests[len(results)]   # 用已消费数作为索引
    runtime = _get_runtime()
    result = runtime.execute(request)

    # 高风险操作审计日志
    log_tool_execution(request, result)

    return {
        "tool_results": [result],
        "trace_events": [record_trace(
            "tool_execution",
            request.agent_name,
            f"{request.tool_name}: {'ok' if result.success else 'fail'} ({result.duration_ms}ms)",
            duration_ms=result.duration_ms,
        )],
    }


def execute_tool_approval(state: GraphState) -> GraphState:
    """审批门：高风险工具执行前征求用户许可。

    - 第一遍：emit interrupt() 挂起，等待用户决策
    - 恢复后：审批通过→设置 approval_context；拒绝→注入驳回 ToolResult
      以便 tool_request 索引前进，让 Master 重新决策
    """
    requests: list[ToolRequest] = state.get("tool_requests", [])
    results = state.get("tool_results", [])
    pending = len(requests) - len(results)

    if pending <= 0:
        return {}

    request = requests[len(results)]
    ctx = {
        "request_id": request.request_id,
        "agent_name": request.agent_name,
        "tool_name": request.tool_name,
        "intent_summary": request.intent_summary,
        "risk_level": request.risk_level,
    }

    # interrupt() 挂起执行，返回用户恢复时的值
    decision = interrupt(ctx)
    approved = decision in ("y", "yes", "approved")

    changes: dict = {
        "approval_pending": False,
        "approval_context": {
            **ctx,
            "decision": "approved" if approved else "rejected",
        },
    }

    decision_text = "approved" if approved else "rejected"
    changes["trace_events"] = [record_trace(
        "approval",
        request.agent_name,
        f"{request.tool_name}: {decision_text} ({request.intent_summary})",
    )]

    if not approved:
        # 驳回：注入一条拒绝结果，让 tool_request 索引前进
        changes["tool_results"] = [
            ToolResult(
                request_id=request.request_id,
                tool_name=request.tool_name,
                success=False,
                summary=f"Rejected by user: {request.intent_summary}",
                exit_code=-1,
            )
        ]

    return changes  # type: ignore[return-value]


def approval_interrupt(state: GraphState) -> GraphState:
    """Interrupt point for test-discovered high-risk actions.

    Similar to execute_tool_approval but reached from the test stage.
    """
    last = state.get("last_decision", {})
    ctx = {
        "stage": "testing",
        "summary": last.get("summary", "") if last else "",
    }

    decision = interrupt(ctx)

    state["approval_pending"] = False
    state["approval_context"] = {
        **ctx,
        "decision": "approved" if decision in ("y", "yes", "approved") else "rejected",
    }
    return state


def finalize(state: GraphState) -> GraphState:
    """Assemble final answer and mark completion.

    Priority order:
    1. Master's final_answer from master_dispatch (best)
    2. Fallback: last message content + review/test notes
    """
    summary_parts = []

    # Try Master's explicit final_answer first
    last_dec = state.get("last_decision", {})
    uf = last_dec.get("update_fields", {}) if last_dec else {}
    dispatch = uf.get("master_dispatch", {}) if uf else {}
    master_final = (dispatch or {}).get("final_answer", "")

    if master_final:
        summary_parts.append(master_final)
    elif state.get("messages"):
        last_msg = state["messages"][-1]["content"]
        if isinstance(last_msg, str):
            summary_parts.append(last_msg)

    # Supplementary review/test notes
    if state.get("review_notes"):
        summary_parts.append("Review: " + "; ".join(state["review_notes"][-2:]))
    if state.get("test_summary"):
        summary_parts.append("Test: " + "; ".join(state["test_summary"][-2:]))

    result = "\n".join(summary_parts) if summary_parts else "Task completed."
    return {
        "final_answer": result,
        "status": "completed",
        "current_stage": "final_response",
        "trace_events": [record_trace("task_end", "system", f"Completed: {result[:60]}")],
    }


_runtime_instance: HarnessRuntime | None = None


def _get_runtime() -> HarnessRuntime:
    global _runtime_instance
    if _runtime_instance is None:
        from multi_agents.runtime.policy_engine import PolicyEngine
        from multi_agents.runtime.tool_executor import ToolExecutor
        _runtime_instance = HarnessRuntime(
            policy_engine=PolicyEngine(),
            tool_executor=ToolExecutor(),
        )
    return _runtime_instance


def _stub_result(tool_name: str, summary: str):
    from multi_agents.schemas.tool import ToolResult
    return ToolResult(
        request_id="stub",
        tool_name=tool_name,
        success=True,
        summary=summary,
    )
