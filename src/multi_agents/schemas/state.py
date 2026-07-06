from __future__ import annotations

from typing import Any, Literal
from typing_extensions import TypedDict, Annotated

from multi_agents.schemas.tool import ToolRequest, ToolResult
from multi_agents.schemas.trace import TraceEvent


def merge_lists(left: list, right: list) -> list:
    """Reducer: merge two lists by concatenation."""
    return left + right


RunMode = Literal["ask", "plan", "act", "review"]
RunStatus = Literal["pending", "running", "needs_approval", "failed", "completed"]


class GraphState(TypedDict, total=False):
    thread_id: str
    run_id: str
    mode: RunMode
    status: RunStatus
    current_stage: str
    current_agent: str
    retry_count: dict[str, int]

    user_input: str
    task_goal: str
    constraints: list[str]
    success_criteria: list[str]
    plan: Annotated[list[str], merge_lists]
    messages: Annotated[list[dict[str, Any]], merge_lists]
    agent_contexts: dict[str, Any]

    tool_requests: Annotated[list[ToolRequest], merge_lists]
    tool_results: Annotated[list[ToolResult], merge_lists]

    artifacts: Annotated[list[str], merge_lists]
    review_notes: Annotated[list[str], merge_lists]
    test_summary: Annotated[list[str], merge_lists]

    approval_pending: bool
    approval_context: dict[str, Any]

    task_memory: Annotated[list[str], merge_lists]
    memory_refs: Annotated[list[str], merge_lists]

    last_decision: dict[str, Any]
    final_answer: str

    trace_events: Annotated[list[TraceEvent], merge_lists]


class AgentInput(TypedDict, total=False):
    """Minimal context bundle for a single agent invocation."""
    thread_id: str
    run_id: str
    agent_name: str
    mode: RunMode
    current_stage: str
    task_goal: str
    constraints: list[str]
    success_criteria: list[str]
    relevant_plan_steps: list[str]
    context_bundle: dict[str, Any]
    task_memory: list[str]
    available_tools: list[str]
    recent_tool_results: list[ToolResult]
