from __future__ import annotations

from typing import Callable

from multi_agents.memory.summary_manager import SummaryManager
from multi_agents.observability.tracer import record_trace
from multi_agents.runtime.tool_executor import ToolExecutor
from multi_agents.schemas.agent import AgentDecision
from multi_agents.schemas.state import AgentInput, GraphState

# 全局缓存
_executor: ToolExecutor | None = None
_summarizer: SummaryManager | None = None


def _get_executor() -> ToolExecutor:
    global _executor
    if _executor is None:
        _executor = ToolExecutor()
    return _executor


def _get_summarizer() -> SummaryManager:
    global _summarizer
    if _summarizer is None:
        _summarizer = SummaryManager()
    return _summarizer


def build_agent_input(state: GraphState, agent_name: str) -> AgentInput:
    """Construct a minimal AgentInput from the current graph state.

    Applies sliding-window context compression:
    - tool_results: keep last N, preserve errors
    - plan: keep first N steps
    - task_memory: keep last N, truncate long items
    """
    # 查询该角色的可用工具
    executor = _get_executor()
    tool_specs = executor.registry.get_tools_for_role(agent_name)
    tool_list = [f"{t.name}: {t.description}" for t in tool_specs]

    sm = _get_summarizer()
    plan = state.get("plan", [])
    tool_results = state.get("tool_results", [])
    task_memory = state.get("task_memory", [])

    # 压缩 context_bundle 防止无限增长（每 3 轮压缩一次）
    agent_ctx = state.get("agent_contexts", {})
    cycle_count = len(state.get("messages", [])) // 2  # approx cycles
    if cycle_count > 0 and cycle_count % 3 == 0 and agent_ctx:
        context_bundle = sm.compress_bundle(agent_ctx)
    else:
        context_bundle = agent_ctx

    return AgentInput(
        thread_id=state.get("thread_id", ""),
        run_id=state.get("run_id", ""),
        agent_name=agent_name,
        mode=state.get("mode", "act"),
        current_stage=state.get("current_stage", ""),
        task_goal=state.get("task_goal", ""),
        constraints=state.get("constraints", []),
        success_criteria=state.get("success_criteria", []),
        relevant_plan_steps=sm.slice_plan(plan),
        context_bundle=context_bundle,
        task_memory=sm.slice_task_memory(task_memory),
        available_tools=tool_list,
        recent_tool_results=sm.slice_tool_results(tool_results),
    )


def apply_decision(state: GraphState, decision: AgentDecision) -> GraphState:
    """Merge an AgentDecision back into the GraphState.

    ⚠️ 返回增量而不是全量 state，避免 LangGraph merge_lists reducer
    将已有列表与返回列表拼接导致指数增长。
    """
    changes: dict = {}
    changes["current_agent"] = decision.agent_name

    # messages: 只返回新消息（reducer 会拼接到已有列表）
    if decision.summary:
        changes["messages"] = [{"role": decision.agent_name, "content": decision.summary}]

    # tool_requests: 只返回新请求
    if decision.proposed_tool_request is not None:
        changes["tool_requests"] = [decision.proposed_tool_request]

    # update_fields: 逐字段处理，list 字段只返回增量
    for key, value in (decision.update_fields or {}).items():
        if key not in GraphState.__annotations__:
            continue
        # 如果是 merge_lists 字段，只返回增量（新的元素）
        if _is_merge_list_field(key):
            if isinstance(value, list) and value:
                # plan 去重：如果 plan 内容无变化，跳过追加
                if key == "plan":
                    existing = state.get("plan", [])
                    if existing == value:
                        continue
                changes[key] = value
        else:
            changes[key] = value

    # Increment retry counter when an agent requests a retry
    if decision.next_action == "retry":
        retries = dict(state.get("retry_count", {}))
        stage_map = {"reviewer": "review", "tester": "testing"}
        stage = stage_map.get(decision.agent_name, "review")
        retries[stage] = retries.get(stage, 0) + 1
        changes["retry_count"] = retries

    changes["last_decision"] = decision.model_dump()

    # Master 调度决策 trace
    if decision.agent_name == "master":
        dispatch = (decision.update_fields or {}).get("master_dispatch", {})
        if dispatch and dispatch.get("next_agent"):
            next_agt = dispatch["next_agent"]
            reasoning = dispatch.get("reasoning", "")[:80]
            stage = dispatch.get("stage", "")
            events = changes.get("trace_events", [])
            events.append(record_trace(
                "master_dispatch", "master",
                f"{stage} → {next_agt}: {reasoning}",
            ))
            changes["trace_events"] = events

    return changes  # type: ignore[return-value]


# 缓存需要做 merge 的字段名，避免每轮都检查 annotations
_MERGE_LIST_FIELDS: set[str] = set()


def _is_merge_list_field(key: str) -> bool:
    if not _MERGE_LIST_FIELDS:
        for field_name, field_type in GraphState.__annotations__.items():
            origin = getattr(field_type, "__origin__", None)
            if origin is not None:
                args = getattr(field_type, "__args__", ())
                if len(args) >= 2:
                    reducer = args[-1]
                    if hasattr(reducer, "__name__") and reducer.__name__ == "merge_lists":
                        _MERGE_LIST_FIELDS.add(field_name)
    return key in _MERGE_LIST_FIELDS


AgentFunc = Callable[[AgentInput], AgentDecision]


def make_agent_node(agent_func: AgentFunc, agent_name: str) -> Callable[[GraphState], GraphState]:
    """Wrap an (AgentInput) -> AgentDecision function into a LangGraph node.

    Usage:
        graph.add_node("plan_task", make_agent_node(plan_agent, "planner"))
    """
    def node_fn(state: GraphState) -> GraphState:
        agent_input = build_agent_input(state, agent_name)
        stage = state.get("current_stage", "")
        start_event = record_trace("agent_start", agent_name, f"Entering ({stage})")

        decision = agent_func(agent_input)
        changes = apply_decision(state, decision)

        # Agent end event
        action = decision.next_action
        request = decision.proposed_tool_request
        if request:
            end_summary = f"Tool: {request.tool_name}"
        elif action == "handoff":
            end_summary = "Handoff"
        else:
            end_summary = action
        end_event = record_trace("agent_end", agent_name, end_summary)

        # 合并 trace 事件（先 start 后 end）
        existing = changes.get("trace_events", [])
        changes["trace_events"] = [start_event, end_event] + existing

        return changes

    node_fn.__name__ = f"{agent_name}_node"
    return node_fn
