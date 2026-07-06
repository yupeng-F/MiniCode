from __future__ import annotations

import pickle

from langgraph.checkpoint.memory import MemorySaver
from langgraph.checkpoint.serde.base import SerializerCompat
from langgraph.graph import END, START, StateGraph

from multi_agents.agents import (
    plan_and_dispatch,
    run_execution,
    run_research,
    run_testing,
    review_result,
    write_memory,
)
from multi_agents.orchestrator.agent_node import make_agent_node
from multi_agents.orchestrator.master_router import route_after_specialist, route_master
from multi_agents.orchestrator.nodes import (
    execute_tool,
    execute_tool_approval,
    finalize,
    task_intake,
)
from multi_agents.orchestrator.router import route_after_tool, route_after_tool_approval
from multi_agents.schemas.state import GraphState


def build_graph() -> StateGraph:
    """构建 Master-Specialist 架构的 StateGraph。

    核心流程:
    task_intake → master_plan
      → (Master 调度) → explorer / coder / reviewer / tester / memory_writer
      → 每个 Specialist 完成后再回到 master_plan
      → 直到 Master 判定 task_complete → finalize
    """
    graph = StateGraph(GraphState)

    # ── 注册节点 ──────────────────────────────────
    graph.add_node("task_intake", task_intake)
    graph.add_node("master_plan", make_agent_node(plan_and_dispatch, "master"))

    # Specialist 节点
    graph.add_node("explorer", make_agent_node(run_research, "repo_explorer"))
    graph.add_node("coder", make_agent_node(run_execution, "coder"))
    graph.add_node("execute_tool", execute_tool)
    graph.add_node("execute_tool_approval", execute_tool_approval)
    graph.add_node("reviewer", make_agent_node(review_result, "reviewer"))
    graph.add_node("tester", make_agent_node(run_testing, "tester"))
    graph.add_node("memory_writer", make_agent_node(write_memory, "memory_manager"))

    # 结束节点
    graph.add_node("finalize", finalize)
    graph.add_node("force_finalize", finalize)  # 硬上限强制结束

    # ── 流程边 ────────────────────────────────────
    graph.add_edge(START, "task_intake")
    graph.add_edge("task_intake", "master_plan")

    # Master 动态调度（条件边，纯查表跳转）
    graph.add_conditional_edges(
        "master_plan",
        route_master,
        {
            "explorer": "explorer",
            "coder": "coder",
            "reviewer": "reviewer",
            "tester": "tester",
            "memory_writer": "memory_writer",
            "finalize": "finalize",
            "force_finalize": "force_finalize",
        },
    )

    # Specialist → 执行工具、走审批或回 Master
    for specialist in ("explorer", "coder", "reviewer", "tester", "memory_writer"):
        graph.add_conditional_edges(specialist, route_after_specialist, {
            "master_plan": "master_plan",
            "execute_tool": "execute_tool",
            "execute_tool_approval": "execute_tool_approval",
        })

    # 工具执行 → 回请求工具的 Specialist
    graph.add_conditional_edges("execute_tool", route_after_tool, {
        "explorer": "explorer",
        "coder": "coder",
        "tester": "tester",
    })
    graph.add_conditional_edges("execute_tool_approval", route_after_tool_approval, {
        "execute_tool": "execute_tool",
        "master_plan": "master_plan",
    })

    graph.add_edge("finalize", END)
    graph.add_edge("force_finalize", END)

    return graph


def compile_graph() -> StateGraph:
    """Build and compile the graph with an in-memory checkpointer for interrupt support."""
    graph = build_graph()
    checkpointer = MemorySaver(serde=SerializerCompat(pickle))
    app = graph.compile(checkpointer=checkpointer)
    return app


def initialize_state(user_input: str, mode: str = "act") -> GraphState:
    """Create the initial graph state with minimal required fields."""
    return GraphState(
        thread_id="",
        run_id="",
        mode=mode,
        status="pending",
        current_stage="",
        current_agent="",
        retry_count={"review": 0, "testing": 0},
        user_input=user_input,
        task_goal=user_input,
        constraints=[],
        success_criteria=[],
        plan=[],
        messages=[{"role": "user", "content": user_input}],
        agent_contexts={},
        tool_requests=[],
        tool_results=[],
        artifacts=[],
        review_notes=[],
        test_summary=[],
        approval_pending=False,
        approval_context={},
        task_memory=[],
        memory_refs=[],
        trace_events=[],
        final_answer="",
    )
