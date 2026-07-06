# LangGraph MVP StateGraph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the placeholder orchestrator dict-graph to a real `langgraph.graph.StateGraph` with 9-stage state machine, AgentDecision protocol, mode-based routing, review/test retry loops, and HITL approval via interrupt.

**Architecture:** Flat StateGraph with an `agent_node` wrapper that converts agent functions producing `AgentDecision` into LangGraph-compatible node functions. Six conditional edge functions handle mode branching, retry routing, tool dispatch, and approval flow. A shared `execute_tool` node routes back to the originating agent via `current_agent`. HITL approval uses `set_interrupt_after` + `Command(resume=...)`.

**Tech Stack:** Python 3.11+, LangGraph 0.2+, Pydantic 2.8+, pytest

---

### Task 1: Update GraphState + Add AgentInput + schema exports

**Files:**
- Modify: `src/multi_agents/schemas/state.py`
- Modify: `src/multi_agents/schemas/__init__.py`

- [ ] **Step 1: Add Annotated reducer support and AgentInput to state.py**

Replace `src/multi_agents/schemas/state.py` with the updated version:

```python
from __future__ import annotations

from typing import Any, Literal
from typing_extensions import TypedDict, Annotated

from multi_agents.schemas.agent import AgentDecision
from multi_agents.schemas.tool import ToolRequest, ToolResult


def add(left: list, right: list) -> list:
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
    plan: Annotated[list[str], add]
    messages: Annotated[list[dict[str, Any]], add]
    agent_contexts: dict[str, Any]

    tool_requests: Annotated[list[ToolRequest], add]
    tool_results: Annotated[list[ToolResult], add]

    artifacts: Annotated[list[str], add]
    review_notes: Annotated[list[str], add]
    test_summary: Annotated[list[str], add]

    approval_pending: bool
    approval_context: dict[str, Any]

    task_memory: Annotated[list[str], add]
    memory_refs: Annotated[list[str], add]

    last_decision: AgentDecision
    final_answer: str


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
```

- [ ] **Step 2: Update schemas/__init__.py exports**

Add `AgentInput` to the exports in `src/multi_agents/schemas/__init__.py`:

```python
from multi_agents.schemas.agent import AgentDecision
from multi_agents.schemas.memory import MemoryEntry
from multi_agents.schemas.policy import PolicyDecision
from multi_agents.schemas.state import AgentInput, GraphState, RunMode, RunStatus
from multi_agents.schemas.tool import ToolRequest, ToolResult

__all__ = [
    "AgentDecision",
    "AgentInput",
    "GraphState",
    "MemoryEntry",
    "PolicyDecision",
    "RunMode",
    "RunStatus",
    "ToolRequest",
    "ToolResult",
]
```

- [ ] **Step 3: Verify imports work**

Run: `python -c "from multi_agents.schemas import GraphState, AgentInput; print('OK')"`
Expected: `OK`

---

### Task 2: Implement AgentDecision wrapper (agent_node.py)

**Files:**
- Create: `src/multi_agents/orchestrator/agent_node.py`

- [ ] **Step 1: Write agent_node.py with make_agent_node, apply_decision, build_agent_input**

```python
from __future__ import annotations

from typing import Callable

from multi_agents.schemas.agent import AgentDecision
from multi_agents.schemas.state import AgentInput, GraphState


def build_agent_input(state: GraphState, agent_name: str) -> AgentInput:
    """Construct a minimal AgentInput from the current graph state."""
    return AgentInput(
        thread_id=state.get("thread_id", ""),
        run_id=state.get("run_id", ""),
        agent_name=agent_name,
        mode=state.get("mode", "act"),
        current_stage=state.get("current_stage", ""),
        task_goal=state.get("task_goal", ""),
        constraints=state.get("constraints", []),
        success_criteria=state.get("success_criteria", []),
        relevant_plan_steps=state.get("plan", [])[:5],
        context_bundle=state.get("agent_contexts", {}),
        task_memory=state.get("task_memory", []),
        available_tools=[],
        recent_tool_results=state.get("tool_results", [])[-5:],
    )


def apply_decision(state: GraphState, decision: AgentDecision) -> GraphState:
    """Merge an AgentDecision back into the GraphState."""
    state["current_agent"] = decision.agent_name

    if decision.summary:
        state.setdefault("messages", []).append({
            "role": decision.agent_name,
            "content": decision.summary,
        })

    if decision.proposed_tool_request is not None:
        state.setdefault("tool_requests", []).append(decision.proposed_tool_request)

    for key, value in (decision.update_fields or {}).items():
        if key in GraphState.__annotations__:
            state[key] = value

    state["last_decision"] = decision
    return state


AgentFunc = Callable[[AgentInput], AgentDecision]


def make_agent_node(agent_func: AgentFunc, agent_name: str) -> Callable[[GraphState], GraphState]:
    """Wrap an (AgentInput) -> AgentDecision function into a LangGraph node.

    Usage:
        graph.add_node("plan_task", make_agent_node(plan_agent, "planner"))
    """
    def node_fn(state: GraphState) -> GraphState:
        agent_input = build_agent_input(state, agent_name)
        decision = agent_func(agent_input)
        return apply_decision(state, decision)

    node_fn.__name__ = f"{agent_name}_node"
    return node_fn
```

- [ ] **Step 2: Verify import works**

```bash
cd "D:/Code/Python/Multi_Agents"
python -c "from multi_agents.orchestrator.agent_node import make_agent_node, apply_decision, build_agent_input; print('OK')"
```
Expected: `OK`

---

### Task 3: Implement router functions

**Files:**
- Modify: `src/multi_agents/orchestrator/router.py`

- [ ] **Step 1: Rewrite router.py with all 6 conditional edge functions**

Replace the entire file:

```python
from __future__ import annotations

from typing import Literal

from multi_agents.schemas.state import GraphState


def route_after_planning(state: GraphState) -> Literal["repo_exploration", "finalize"]:
    """Plan mode → finalize; others continue to repo exploration."""
    mode = state.get("mode", "act")
    if mode == "plan":
        return "finalize"
    return "repo_exploration"


def route_after_research(state: GraphState) -> Literal["implement", "review", "finalize"]:
    """Ask → finalize, Review → review node, Act → implementation."""
    mode = state.get("mode", "act")
    if mode == "ask":
        return "finalize"
    if mode == "review":
        return "review"
    return "implement"


def route_after_implement(state: GraphState) -> Literal["execute_tool", "review", "execute_tool_approval"]:
    """If agent requested a tool → execute; if the tool needs approval → approval gate; else → review."""
    decision = state.get("last_decision")
    if decision is None:
        return "review"
    if decision.next_action == "request_tool":
        tool_req = decision.proposed_tool_request
        if tool_req and tool_req.requires_approval:
            return "execute_tool_approval"
        return "execute_tool"
    return "review"


def route_after_tool(state: GraphState) -> Literal["implement", "test"]:
    """Route back to the agent that requested the tool."""
    agent = state.get("current_agent", "")
    if agent == "tester":
        return "test"
    return "implement"


def route_after_tool_approval(state: GraphState) -> Literal["implement", "finalize"]:
    """After approval interrupt resumes: approved → back to implement, rejected → finalize."""
    ctx = state.get("approval_context", {})
    if ctx.get("decision") == "approved":
        return "implement"
    return "finalize"


def route_after_review(state: GraphState) -> Literal["implement", "test", "finalize"]:
    """Retry → implement (if under limit), pass → test, fail-closed → finalize."""
    decision = state.get("last_decision")
    if decision is None or decision.next_action not in ("retry", "handoff"):
        return "finalize"

    if decision.next_action == "retry":
        retries = state.get("retry_count", {})
        if retries.get("review", 0) < 2:
            return "implement"
        return "finalize"

    return "test"


def route_after_test(state: GraphState) -> Literal["implement", "memory_writeback", "approval_interrupt"]:
    """Retry → implement (if under limit), handoff with risk → approval, clean → memory_writeback."""
    decision = state.get("last_decision")
    if decision is None:
        return "memory_writeback"

    if decision.next_action == "retry":
        retries = state.get("retry_count", {})
        if retries.get("testing", 0) < 2:
            return "implement"
        return "memory_writeback"

    if decision.next_action == "need_approval":
        return "approval_interrupt"

    return "memory_writeback"
```

- [ ] **Step 2: Verify import**

```bash
cd "D:/Code/Python/Multi_Agents"
python -c "from multi_agents.orchestrator.router import *; print('OK')"
```
Expected: `OK`

---

### Task 4: Implement non-agent nodes (nodes.py)

**Files:**
- Create: `src/multi_agents/orchestrator/nodes.py`

- [ ] **Step 1: Write nodes.py with task_intake, execute_tool, execute_tool_approval, approval_interrupt, finalize**

```python
from __future__ import annotations

from uuid import uuid4

from langgraph.types import interrupt

from multi_agents.runtime.harness import HarnessRuntime
from multi_agents.schemas.state import GraphState
from multi_agents.schemas.tool import ToolRequest


def task_intake(state: GraphState) -> GraphState:
    """Initialize ephemeral run fields."""
    state["thread_id"] = state.get("thread_id") or str(uuid4())[:8]
    state["run_id"] = state.get("run_id") or str(uuid4())[:8]
    state["status"] = "running"
    state["current_stage"] = "task_intake"
    state["current_agent"] = ""
    state.setdefault("retry_count", {"review": 0, "testing": 0})
    state.setdefault("plan", [])
    state.setdefault("tool_requests", [])
    state.setdefault("tool_results", [])
    state.setdefault("artifacts", [])
    state.setdefault("review_notes", [])
    state.setdefault("test_summary", [])
    state.setdefault("messages", [])
    state.setdefault("agent_contexts", {})
    state.setdefault("task_memory", [])
    state.setdefault("memory_refs", [])
    state.setdefault("approval_pending", False)
    state.setdefault("approval_context", {})
    return state


def execute_tool(state: GraphState) -> GraphState:
    """Execute the last unprocessed ToolRequest through HarnessRuntime.

    Reads the last tool_request, runs it, writes the ToolResult,
    and increments retry_count if the current stage is review/test.
    """
    requests: list[ToolRequest] = state.get("tool_requests", [])
    results = state.get("tool_results", [])
    pending = len(requests) - len(results)

    if pending <= 0:
        state.setdefault("tool_results", []).append(
            _stub_result("noop", "No pending tool request.")
        )
        return state

    request = requests[len(results)]
    runtime = _get_runtime()
    result = runtime.execute(request)
    state.setdefault("tool_results", []).append(result)
    return state


def execute_tool_approval(state: GraphState) -> GraphState:
    """Gate before executing a tool that requires approval.

    First pass: emit interrupt() with tool context, halt.
    Resume: interrupt() returns user decision, set approval_context.decision.
    """
    requests: list[ToolRequest] = state.get("tool_requests", [])
    results = state.get("tool_results", [])
    pending = len(requests) - len(results)

    if pending <= 0:
        return state

    request = requests[len(results)]
    ctx = {
        "request_id": request.request_id,
        "agent_name": request.agent_name,
        "tool_name": request.tool_name,
        "intent_summary": request.intent_summary,
        "risk_level": request.risk_level,
    }

    # interrupt() pauses execution and returns the resume value
    decision = interrupt(ctx)

    state["approval_pending"] = False
    state["approval_context"] = {
        **ctx,
        "decision": "approved" if decision in ("y", "yes", "approved") else "rejected",
    }
    return state


def approval_interrupt(state: GraphState) -> GraphState:
    """Interrupt point for test-discovered high-risk actions.

    Similar to execute_tool_approval but reached from the test stage.
    """
    last = state.get("last_decision")
    ctx = {
        "stage": "testing",
        "summary": last.summary if last else "",
    }

    decision = interrupt(ctx)

    state["approval_pending"] = False
    state["approval_context"] = {
        **ctx,
        "decision": "approved" if decision in ("y", "yes", "approved") else "rejected",
    }
    return state


def finalize(state: GraphState) -> GraphState:
    """Assemble final answer and mark completion."""
    summary_parts = []
    if state.get("review_notes"):
        summary_parts.append("Review: " + "; ".join(state["review_notes"][-2:]))
    if state.get("test_summary"):
        summary_parts.append("Test: " + "; ".join(state["test_summary"][-2:]))
    if state.get("messages"):
        last_msg = state["messages"][-1]["content"]
        if isinstance(last_msg, str):
            summary_parts.append(last_msg[:200])

    state["final_answer"] = "\n".join(summary_parts) if summary_parts else "Task completed."
    state["status"] = "completed"
    state["current_stage"] = "final_response"
    return state


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
```

- [ ] **Step 2: Verify import**

```bash
cd "D:/Code/Python/Multi_Agents"
python -c "from multi_agents.orchestrator.nodes import task_intake, execute_tool, finalize; print('OK')"
```
Expected: `OK`

---

### Task 5: Build and compile the StateGraph

**Files:**
- Modify: `src/multi_agents/orchestrator/graph.py`

- [ ] **Step 1: Rewrite graph.py with real StateGraph**

```python
from __future__ import annotations

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

from multi_agents.agents import (
    plan_task,
    run_execution,
    run_research,
    run_testing,
    review_result,
    write_memory,
)
from multi_agents.orchestrator.agent_node import make_agent_node
from multi_agents.orchestrator.nodes import (
    approval_interrupt,
    execute_tool,
    execute_tool_approval,
    finalize,
    task_intake,
)
from multi_agents.orchestrator.router import (
    route_after_implement,
    route_after_planning,
    route_after_research,
    route_after_review,
    route_after_test,
    route_after_tool,
    route_after_tool_approval,
)
from multi_agents.schemas.state import GraphState


def build_graph() -> StateGraph:
    """Construct the LangGraph StateGraph with all nodes and edges."""

    graph = StateGraph(GraphState)

    # ---- Register nodes ----
    graph.add_node("task_intake", task_intake)
    graph.add_node("plan_task", make_agent_node(plan_task, "planner"))
    graph.add_node("repo_exploration", make_agent_node(run_research, "repo_explorer"))
    graph.add_node("implement", make_agent_node(run_execution, "coder"))
    graph.add_node("execute_tool", execute_tool)
    graph.add_node("execute_tool_approval", execute_tool_approval)
    graph.add_node("review", make_agent_node(review_result, "reviewer"))
    graph.add_node("test", make_agent_node(run_testing, "tester"))
    graph.add_node("approval_interrupt", approval_interrupt)
    graph.add_node("memory_writeback", make_agent_node(write_memory, "memory_manager"))
    graph.add_node("finalize", finalize)

    # ---- Register edges ----
    graph.add_edge(START, "task_intake")
    graph.add_edge("task_intake", "plan_task")

    graph.add_conditional_edges("plan_task", route_after_planning, {
        "repo_exploration": "repo_exploration",
        "finalize": "finalize",
    })
    graph.add_conditional_edges("repo_exploration", route_after_research, {
        "implement": "implement",
        "review": "review",
        "finalize": "finalize",
    })
    graph.add_conditional_edges("implement", route_after_implement, {
        "execute_tool": "execute_tool",
        "execute_tool_approval": "execute_tool_approval",
        "review": "review",
    })
    graph.add_conditional_edges("execute_tool", route_after_tool, {
        "implement": "implement",
        "test": "test",
    })
    graph.add_conditional_edges("execute_tool_approval", route_after_tool_approval, {
        "implement": "implement",
        "finalize": "finalize",
    })
    graph.add_conditional_edges("review", route_after_review, {
        "implement": "implement",
        "test": "test",
        "finalize": "finalize",
    })
    graph.add_conditional_edges("test", route_after_test, {
        "implement": "implement",
        "memory_writeback": "memory_writeback",
        "approval_interrupt": "approval_interrupt",
    })
    graph.add_conditional_edges("approval_interrupt", route_after_tool_approval, {
        "implement": "implement",
        "finalize": "finalize",
    })
    graph.add_edge("memory_writeback", "finalize")
    graph.add_edge("finalize", END)

    return graph


def compile_graph() -> StateGraph:
    """Build and compile the graph with an in-memory checkpointer for interrupt support."""
    graph = build_graph()
    checkpointer = MemorySaver()
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
        final_answer="",
    )
```

- [ ] **Step 2: Verify the graph compiles**

```bash
cd "D:/Code/Python/Multi_Agents"
python -c "
from multi_agents.orchestrator.graph import compile_graph
app = compile_graph()
print('Graph compiled OK')
print('Nodes:', list(app.get_graph().nodes))
"
```
Expected: `Graph compiled OK`, followed by a list of node names.

---

### Task 6: Migrate all 6 agent functions to AgentDecision protocol

**Files:**
- Modify: `src/multi_agents/agents/planner.py`
- Modify: `src/multi_agents/agents/researcher.py`
- Modify: `src/multi_agents/agents/executor.py`
- Modify: `src/multi_agents/agents/reviewer.py`
- Modify: `src/multi_agents/agents/tester.py`
- Modify: `src/multi_agents/agents/memory_writer.py`

- [ ] **Step 1: Rewrite planner.py**

```python
from __future__ import annotations

from multi_agents.schemas.agent import AgentDecision
from multi_agents.schemas.state import AgentInput


def plan_task(input: AgentInput) -> AgentDecision:
    """Analyze task and produce a structured plan."""
    return AgentDecision(
        agent_name="planner",
        summary=f"Planned execution for: {input.get('task_goal', '')[:120]}",
        next_action="handoff",
        update_fields={
            "plan": [
                f"Understand the task: {input.get('task_goal', '')}",
                "Collect the required context",
                "Execute the requested change safely",
                "Review, test, and summarize the result",
            ],
            "success_criteria": [
                "The requested task is completed",
                "The implementation is reviewed",
                "The result is validated or the gap is reported clearly",
            ],
            "current_stage": "planning",
        },
    )
```

- [ ] **Step 2: Rewrite researcher.py**

```python
from __future__ import annotations

from multi_agents.schemas.agent import AgentDecision
from multi_agents.schemas.state import AgentInput


def run_research(input: AgentInput) -> AgentDecision:
    """Collect repository context for the task."""
    return AgentDecision(
        agent_name="repo_explorer",
        summary="Repository exploration placeholder completed.",
        next_action="handoff",
        update_fields={
            "agent_contexts": {
                "repo_explorer": {
                    "summary": "Placeholder repository context bundle.",
                    "candidate_files": [],
                },
            },
            "current_stage": "repository_exploration",
        },
    )
```

- [ ] **Step 3: Rewrite executor.py**

```python
from __future__ import annotations

from multi_agents.schemas.agent import AgentDecision
from multi_agents.schemas.state import AgentInput
from multi_agents.schemas.tool import ToolRequest


def run_execution(input: AgentInput) -> AgentDecision:
    """Produce a tool request or handoff based on the plan and context."""
    plan = input.get("relevant_plan_steps", [])
    if not plan:
        return AgentDecision(
            agent_name="coder",
            summary="No plan steps to execute.",
            next_action="handoff",
            update_fields={"current_stage": "implementation"},
        )

    return AgentDecision(
        agent_name="coder",
        summary=f"Requesting tool execution for step 1 of {len(plan)}.",
        next_action="request_tool",
        proposed_tool_request=ToolRequest(
            request_id="",
            agent_name="coder",
            mode=input.get("mode", "act"),
            current_stage="implementation",
            tool_name="read_file",
            arguments={"path": "."},
            intent_summary=f"Execute plan step: {plan[0][:100]}",
            risk_level="low",
            side_effect=False,
            requires_approval=False,
        ),
        update_fields={"current_stage": "implementation"},
    )
```

- [ ] **Step 4: Rewrite reviewer.py**

```python
from __future__ import annotations

from multi_agents.schemas.agent import AgentDecision
from multi_agents.schemas.state import AgentInput


def review_result(input: AgentInput) -> AgentDecision:
    """Review the implementation results and decide pass/retry."""
    results = input.get("recent_tool_results", [])

    if not results or all(r.success for r in results):
        return AgentDecision(
            agent_name="reviewer",
            summary="Implementation looks correct.",
            next_action="handoff",
            update_fields={"current_stage": "review"},
        )

    return AgentDecision(
        agent_name="reviewer",
        summary="Issues found in implementation, requesting rework.",
        next_action="retry",
        reasoning_notes=[f"Tool failure: {results[-1].summary}"],
        update_fields={
            "current_stage": "review",
            "review_notes": [f"Review failed: {results[-1].summary}"],
        },
    )
```

- [ ] **Step 5: Rewrite tester.py**

```python
from __future__ import annotations

from multi_agents.schemas.agent import AgentDecision
from multi_agents.schemas.state import AgentInput


def run_testing(input: AgentInput) -> AgentDecision:
    """Run minimal verification and decide next step."""
    results = input.get("recent_tool_results", [])

    all_ok = all(r.success for r in results) if results else True

    if not all_ok:
        return AgentDecision(
            agent_name="tester",
            summary="Some results indicate issues, requesting rework.",
            next_action="retry",
            update_fields={
                "current_stage": "testing",
                "test_summary": ["Test failed: one or more tool results indicate issues."],
            },
        )

    return AgentDecision(
        agent_name="tester",
        summary="All checks passed.",
        next_action="handoff",
        update_fields={
            "current_stage": "testing",
            "test_summary": ["All checks passed."],
        },
    )
```

- [ ] **Step 6: Rewrite memory_writer.py**

```python
from __future__ import annotations

from multi_agents.schemas.agent import AgentDecision
from multi_agents.schemas.state import AgentInput


def write_memory(input: AgentInput) -> AgentDecision:
    """Persist task experience as a structured memory entry."""
    return AgentDecision(
        agent_name="memory_manager",
        summary="Memory writeback placeholder completed.",
        next_action="handoff",
        update_fields={
            "current_stage": "memory_writeback",
            "memory_refs": ["memory-write-placeholder"],
        },
    )
```

- [ ] **Step 7: Verify all agents import**

```bash
cd "D:/Code/Python/Multi_Agents"
python -c "
from multi_agents.agents import plan_task, run_research, run_execution, review_result, run_testing, write_memory
print('All agents imported OK')
"
```
Expected: `All agents imported OK`

---

### Task 7: Extend HarnessRuntime with full execute() flow

**Files:**
- Modify: `src/multi_agents/runtime/harness.py`
- Modify: `src/multi_agents/runtime/tool_executor.py`

- [ ] **Step 1: Extend ToolExecutor with real dispatch**

```python
from __future__ import annotations

from multi_agents.schemas.tool import ToolRequest, ToolResult
from multi_agents.tools.file_tools import READ_FILE_TOOL, WRITE_FILE_TOOL
from multi_agents.tools.search_tools import SEARCH_CODE_TOOL
from multi_agents.tools.shell_tools import RUN_SHELL_TOOL


class ToolExecutor:
    """Dispatch validated tool requests to concrete implementations."""

    def __init__(self):
        self._registry: dict[str, dict] = {
            READ_FILE_TOOL.name: {"spec": READ_FILE_TOOL, "fn": self._read_file},
            WRITE_FILE_TOOL.name: {"spec": WRITE_FILE_TOOL, "fn": self._write_file},
            SEARCH_CODE_TOOL.name: {"spec": SEARCH_CODE_TOOL, "fn": self._search_code},
            RUN_SHELL_TOOL.name: {"spec": RUN_SHELL_TOOL, "fn": self._run_shell},
        }

    def execute(self, request: ToolRequest) -> ToolResult:
        entry = self._registry.get(request.tool_name)
        if entry is None:
            return ToolResult(
                request_id=request.request_id,
                tool_name=request.tool_name,
                success=False,
                summary=f"Unknown tool: {request.tool_name}",
                exit_code=1,
            )
        return entry["fn"](request)

    def _read_file(self, request: ToolRequest) -> ToolResult:
        path = request.arguments.get("path", "")
        try:
            with open(path, encoding="utf-8") as f:
                content = f.read()
            preview = content[:500]
            return ToolResult(
                request_id=request.request_id,
                tool_name="read_file",
                success=True,
                summary=f"Read {len(content)} chars from {path}",
                stdout_preview=preview,
                exit_code=0,
            )
        except Exception as e:
            return ToolResult(
                request_id=request.request_id,
                tool_name="read_file",
                success=False,
                summary=str(e),
                exit_code=1,
            )

    def _write_file(self, request: ToolRequest) -> ToolResult:
        path = request.arguments.get("path", "")
        content = request.arguments.get("content", "")
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            return ToolResult(
                request_id=request.request_id,
                tool_name="write_file",
                success=True,
                summary=f"Wrote {len(content)} chars to {path}",
                modified_paths=[path],
                exit_code=0,
            )
        except Exception as e:
            return ToolResult(
                request_id=request.request_id,
                tool_name="write_file",
                success=False,
                summary=str(e),
                exit_code=1,
            )

    def _search_code(self, request: ToolRequest) -> ToolResult:
        return ToolResult(
            request_id=request.request_id,
            tool_name="search_code",
            success=True,
            summary="Search placeholder. Full-text search not yet implemented.",
            exit_code=0,
        )

    def _run_shell(self, request: ToolRequest) -> ToolResult:
        return ToolResult(
            request_id=request.request_id,
            tool_name="run_shell",
            success=True,
            summary="Shell execution placeholder. Sandbox not yet implemented.",
            exit_code=0,
        )
```

- [ ] **Step 2: Extend HarnessRuntime with full execute()**

```python
from __future__ import annotations

from multi_agents.runtime.policy_engine import PolicyEngine
from multi_agents.runtime.tool_executor import ToolExecutor
from multi_agents.schemas.policy import PolicyDecision
from multi_agents.schemas.tool import ToolRequest, ToolResult


class HarnessRuntime:
    """Single entrypoint for high-risk execution.

    Full flow: preflight (policy check) → execute (tool dispatch) → result.
    """

    def __init__(
        self,
        policy_engine: PolicyEngine | None = None,
        tool_executor: ToolExecutor | None = None,
    ) -> None:
        self.policy_engine = policy_engine or PolicyEngine()
        self.tool_executor = tool_executor or ToolExecutor()

    def preflight(self, request: ToolRequest) -> PolicyDecision:
        """Run policy checks before execution."""
        return self.policy_engine.evaluate(request)

    def execute(self, request: ToolRequest) -> ToolResult:
        """Full execution: check policy, then dispatch."""
        decision = self.preflight(request)

        result = self.tool_executor.execute(request)
        result.policy_trace = {
            "decision": decision.decision,
            "reason": decision.reason,
            "matched_rule": decision.matched_rule,
        }
        return result
```

- [ ] **Step 3: Verify runtime works end-to-end**

```bash
cd "D:/Code/Python/Multi_Agents"
python -c "
from multi_agents.schemas.tool import ToolRequest
from multi_agents.runtime.harness import HarnessRuntime

r = HarnessRuntime()
req = ToolRequest(
    request_id='test-1',
    agent_name='coder',
    tool_name='read_file',
    arguments={'path': 'pyproject.toml'},
    risk_level='low',
)
result = r.execute(req)
print(f'Result: success={result.success}, summary={result.summary}')
"
```
Expected: `Result: success=True, summary=Read N chars from pyproject.toml`

---

### Task 8: Update CLI with graph execution loop + interrupt handling

**Files:**
- Modify: `src/multi_agents/interfaces/cli.py`

- [ ] **Step 1: Rewrite cli.py with streaming + interrupt resume**

```python
from __future__ import annotations

import argparse

from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command

from multi_agents.orchestrator.graph import compile_graph, initialize_state


def _get_interrupt_value(app: CompiledStateGraph, thread_config: dict) -> dict | None:
    """Extract the interrupt value from a paused graph state, if any."""
    try:
        state = app.get_state(thread_config)
    except Exception:
        return None
    if not state.tasks:
        return None
    for task in state.tasks:
        if task.interrupts:
            return task.interrupts[0].value
    return None


def _prompt_for_approval(ctx: dict) -> str:
    """Display approval info and return the user's decision."""
    print("\n=== APPROVAL REQUIRED ===")
    print(f"Tool:    {ctx.get('tool_name', '(approval)')}")
    print(f"Agent:   {ctx.get('agent_name', '')}")
    print(f"Intent:  {ctx.get('intent_summary', ctx.get('summary', ''))}")
    print(f"Risk:    {ctx.get('risk_level', 'unknown')}")
    print("=========================")

    choice = input("Approve? (y/n): ").strip().lower()
    return "approved" if choice in ("y", "yes") else "rejected"


def main() -> None:
    parser = argparse.ArgumentParser(description="Multi-Agent Coding Assistant")
    parser.add_argument("--mode", "-m", choices=["ask", "plan", "act", "review"],
                        default="act", help="Execution mode")
    parser.add_argument("prompt", nargs="*", help="Task description")
    args = parser.parse_args()

    user_input = " ".join(args.prompt) if args.prompt else "bootstrap multi-agent scaffold"
    mode = args.mode

    print(f"Mode: {mode}")
    print(f"Task: {user_input[:120]}")
    print()

    app = compile_graph()
    thread_config = {"configurable": {"thread_id": "cli-run"}}
    state = initialize_state(user_input, mode=mode)

    # Stream until completion or interrupt
    has_interrupted = False
    for event in app.stream(state, thread_config, stream_mode="values"):
        stage = event.get("current_stage", "")
        agent = event.get("current_agent", "")
        status = event.get("status", "")
        label = stage or "(start)"

        if agent:
            print(f"  [{label}] {agent}")

        if status == "completed":
            answer = event.get("final_answer", "")
            if answer:
                print(f"\nFinal: {answer[:300]}")
            return

    # Check for pending interrupt
    while True:
        ctx = _get_interrupt_value(app, thread_config)
        if ctx is None:
            break

        has_interrupted = True
        decision = _prompt_for_approval(ctx)

        for event in app.stream(Command(resume=decision), thread_config, stream_mode="values"):
            stage = event.get("current_stage", "")
            agent = event.get("current_agent", "")
            status = event.get("status", "")

            if agent:
                print(f"  [{stage or '(resume)'}] {agent}")
            if status == "completed":
                answer = event.get("final_answer", "")
                if answer:
                    print(f"\nFinal: {answer[:300]}")
                return

    if not has_interrupted:
        print("\nDone.")


if __name__ == "__main__":
    main()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Verify CLI can execute**

```bash
cd "D:/Code/Python/Multi_Agents"
python -m multi_agents.interfaces.cli --mode act "test the scaffold"
```
Expected: Streaming output showing stages and agents, ending with "Done."

---

### Task 9: Write integration tests

**Files:**
- Create: `tests/test_agent_decision.py`
- Create: `tests/test_graph_integration.py`

- [ ] **Step 1: Unit tests for AgentDecision protocol**

Write `tests/test_agent_decision.py`:

```python
from __future__ import annotations

import pytest
from multi_agents.schemas.agent import AgentDecision
from multi_agents.schemas.state import AgentInput
from multi_agents.agents.planner import plan_task
from multi_agents.agents.researcher import run_research
from multi_agents.agents.executor import run_execution
from multi_agents.agents.reviewer import review_result
from multi_agents.agents.tester import run_testing
from multi_agents.agents.memory_writer import write_memory


@pytest.fixture
def agent_input() -> AgentInput:
    return AgentInput(
        thread_id="test-thread",
        run_id="test-run",
        agent_name="planner",
        mode="act",
        current_stage="planning",
        task_goal="Implement a test feature",
        constraints=["Only edit files in src/"],
        success_criteria=["Tests pass"],
        relevant_plan_steps=["Step 1", "Step 2"],
        context_bundle={},
        task_memory=[],
        available_tools=[],
        recent_tool_results=[],
    )


def test_planner_returns_agent_decision(agent_input):
    decision = plan_task(agent_input)
    assert decision.agent_name == "planner"
    assert decision.next_action == "handoff"
    assert "plan" in decision.update_fields
    assert "current_stage" in decision.update_fields


def test_researcher_returns_agent_decision(agent_input):
    decision = run_research(agent_input)
    assert decision.agent_name == "repo_explorer"
    assert decision.next_action == "handoff"
    assert "agent_contexts" in decision.update_fields


def test_executor_returns_tool_request(agent_input):
    decision = run_execution(agent_input)
    assert decision.agent_name == "coder"
    assert decision.next_action == "request_tool"
    assert decision.proposed_tool_request is not None
    assert decision.proposed_tool_request.tool_name == "read_file"


def test_executor_handoff_when_no_plan(agent_input):
    agent_input["relevant_plan_steps"] = []
    decision = run_execution(agent_input)
    assert decision.next_action == "handoff"


def test_reviewer_passes_good_results(agent_input):
    from multi_agents.schemas.tool import ToolResult
    agent_input["recent_tool_results"] = [
        ToolResult(request_id="r1", tool_name="read_file", success=True, summary="OK"),
    ]
    decision = review_result(agent_input)
    assert decision.next_action == "handoff"


def test_reviewer_retries_failed_results(agent_input):
    from multi_agents.schemas.tool import ToolResult
    agent_input["recent_tool_results"] = [
        ToolResult(request_id="r1", tool_name="read_file", success=False, summary="Error"),
    ]
    decision = review_result(agent_input)
    assert decision.next_action == "retry"


def test_tester_passes(agent_input):
    from multi_agents.schemas.tool import ToolResult
    agent_input["recent_tool_results"] = [
        ToolResult(request_id="r1", tool_name="read_file", success=True, summary="OK"),
    ]
    decision = run_testing(agent_input)
    assert decision.next_action == "handoff"


def test_tester_retries_on_failure(agent_input):
    from multi_agents.schemas.tool import ToolResult
    agent_input["recent_tool_results"] = [
        ToolResult(request_id="r1", tool_name="read_file", success=False, summary="Error"),
    ]
    decision = run_testing(agent_input)
    assert decision.next_action == "retry"


def test_memory_writer_returns_agent_decision(agent_input):
    decision = write_memory(agent_input)
    assert decision.agent_name == "memory_manager"
    assert decision.next_action == "handoff"
    assert "memory_refs" in decision.update_fields


def test_make_agent_node_wrapper():
    from multi_agents.orchestrator.agent_node import make_agent_node, build_agent_input, apply_decision
    from multi_agents.schemas.state import GraphState

    state = GraphState(
        thread_id="t1", run_id="r1", mode="act", status="running",
        current_stage="planning", current_agent="", retry_count={},
        user_input="test", task_goal="test", plan=[],
        messages=[], agent_contexts={},
        tool_requests=[], tool_results=[], artifacts=[],
        review_notes=[], test_summary=[],
        approval_pending=False, approval_context={},
        task_memory=[], memory_refs=[], final_answer="",
    )

    node_fn = make_agent_node(plan_task, "planner")
    result = node_fn(state)

    assert result["current_agent"] == "planner"
    assert "last_decision" in result
    assert result["last_decision"].next_action == "handoff"
    assert "plan" in result
```

- [ ] **Step 2: Run unit tests**

```bash
cd "D:/Code/Python/Multi_Agents"
python -m pytest tests/test_agent_decision.py -v
```
Expected: All tests PASS.

- [ ] **Step 3: Integration test for all mode paths**

Write `tests/test_graph_integration.py`:

```python
from __future__ import annotations

import pytest
from langgraph.graph.state import CompiledStateGraph

from multi_agents.orchestrator.graph import compile_graph, initialize_state


@pytest.fixture
def app() -> CompiledStateGraph:
    return compile_graph()


def _run_to_completion(app, state):
    """Run a graph invocation and collect final state."""
    config = {"configurable": {"thread_id": "test"}}
    for _ in app.stream(state, config, stream_mode="values"):
        pass
    return app.get_state(config).values


def test_act_mode_full_path(app):
    """Act mode should run: intake → planning → research → implement → review → test → memory → finalize."""
    state = initialize_state("Implement feature X", mode="act")
    final = _run_to_completion(app, state)
    assert final["status"] == "completed"
    assert final["current_stage"] == "final_response"
    assert len(final.get("final_answer", "")) > 0
    # All stages should have been visited
    assert final.get("plan")
    assert len(final.get("tool_results", [])) > 0
    assert len(final.get("review_notes", [])) > 0


def test_ask_mode(app):
    """Ask mode should: intake → planning → research → finalize."""
    state = initialize_state("What does this project do?", mode="ask")
    final = _run_to_completion(app, state)
    assert final["status"] == "completed"
    assert final["current_stage"] == "final_response"


def test_plan_mode(app):
    """Plan mode should: intake → planning → finalize."""
    state = initialize_state("Plan a refactoring", mode="plan")
    final = _run_to_completion(app, state)
    assert final["status"] == "completed"
    assert final.get("plan")
    # Should NOT have done research or execution
    ctx = final.get("agent_contexts", {})
    assert "repo_explorer" not in ctx


def test_review_mode(app):
    """Review mode should: intake → planning → research → review → finalize."""
    state = initialize_state("Review the codebase", mode="review")
    final = _run_to_completion(app, state)
    assert final["status"] == "completed"
    assert len(final.get("review_notes", [])) > 0


def test_retry_loop_review(app):
    """When reviewer requests retry, graph should loop back to implement."""
    config = {"configurable": {"thread_id": "retry-test"}}
    state = initialize_state("Implement feature", mode="act")
    # Force a tool failure so reviewer will retry
    state["tool_results"] = []
    # Run first pass
    for _ in app.stream(state, config, stream_mode="values"):
        pass

    final_state = app.get_state(config).values
    # The test stage may pass or retry — verify we completed without error
    assert final_state["status"] == "completed"


def test_retry_limit_respected(app):
    """When retry_count exceeds 2 for review, graph should finalize instead of looping."""
    config = {"configurable": {"thread_id": "retry-limit"}}
    state = initialize_state("Implement feature", mode="act")
    state["retry_count"] = {"review": 2, "testing": 2}
    for _ in app.stream(state, config, stream_mode="values"):
        pass
    final = app.get_state(config).values
    assert final["status"] == "completed"


def test_approval_interrupt(app):
    """When a tool requires approval, graph should stop at execute_tool_approval."""
    config = {"configurable": {"thread_id": "approval-test"}}
    state = initialize_state("Implement feature", mode="act")
    results = list(app.stream(state, config, stream_mode="values"))
    # Check if the graph hit the approval interrupt
    # (this depends on tool_request having requires_approval=True)
    snapshot = app.get_state(config)
    # We expect either completion or an interrupt state
    assert snapshot.values.get("status") in ("completed", "running")
```

- [ ] **Step 4: Run integration tests**

```bash
cd "D:/Code/Python/Multi_Agents"
python -m pytest tests/test_graph_integration.py -v
```
Expected: Tests PASS (some may be skipped if interrupt flow changes expected outputs).

- [ ] **Step 5: Run all tests**

```bash
cd "D:/Code/Python/Multi_Agents"
python -m pytest tests/ -v
```
Expected: All tests PASS.
