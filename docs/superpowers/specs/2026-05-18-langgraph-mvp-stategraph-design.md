# LangGraph MVP StateGraph 实现设计

## 来源

本文档基于项目现有 6 份设计文档（`docs/00~06`）与 2026-05-18 brainstorming 确认的决策编写。

## 1. 已确认的顶层决策

| 决策项 | 结论 |
|---|---|
| Agent 输出契约 | Agent 返回 `AgentDecision`，而非直接修改 GraphState |
| Graph 阶段粒度 | 完整九阶段（task_intake → planning → repo_exploration → implementation → review → testing → approval → memory_writeback → final_response） |
| 返工回路 | review_failed → implementation, test_failed → implementation, 上限各 2 次 |
| 审批机制 | LangGraph 原生 `interrupt` 机制 |
| HITL 恢复 | 通过 `Command(resume=...)` 恢复执行 |
| Mode 分流 | Ask/Plan/Act/Review 四种模式走不同路径 |
| Graph 架构模式 | 平层 AgentDecision Wrapper（方案 A） |

## 2. 架构模式：AgentDecision Wrapper

```
┌──────────────────────────────────────────────────────────────┐
│                   StateGraph(GraphState)                      │
│                                                               │
│  task_intake ──→ plan_task ──→ repo_exploration ──→ implement │
│       ↑                                      │                │
│       │                                ┌─────┘                │
│       │                           execute_tool                │
│       │                                │                      │
│       │                           Coder/Tester (back)         │
│       │                                │                      │
│  implement ←──── review ──── test ─────┘                      │
│       ↑              │         │                              │
│       └── 返工 ───────┘─────────┘                              │
│                                                               │
│  approval (interrupt) ──→ memory_writeback ──→ finalize       │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 核心机制

每个 Agent node 内部统一包装：

```python
def agent_node(agent_func, state: GraphState) -> GraphState:
    # 1. Orchestrator 裁剪输入（只给最小上下文）
    agent_input = build_agent_input(state)
    # 2. Agent 产生结构化决策
    decision: AgentDecision = agent_func(agent_input)
    # 3. 合并回 state（update_fields + tool_request + stage/agent）
    return apply_decision(state, decision)
```

`apply_decision()` 负责：
- 将 `decision.update_fields` 写入 state
- 将 `decision.proposed_tool_request` 追加到 `state.tool_requests`
- 更新 `current_agent`
- 将 `next_action` 留在 state 的决策追踪字段中供 router 消费（或直接在 router 中通过 `Command` 返回）

### 2.2 `execute_tool` 共享节点

execute_tool node 从 `state.tool_requests` 取最后一个未执行的 ToolRequest，调用 `HarnessRuntime.execute()`，将 ToolResult 写回 `state.tool_results`，然后路由回发起 agent 继续。

## 3. 节点定义

### task_intake

- 输入：`user_input`, `mode`
- 行为：初始化状态字段，设定 `current_stage = "task_intake"`
- 产出：填充后的 GraphState
- 入边：START
- 出边：→ plan_task（无条件）

### plan_task

- 角色：Planner
- 输入：`user_input`, `mode`
- 行为：分析任务，输出 plan / goal / constraints / success_criteria
- 产出：AgentDecision { next_action: "handoff", update_fields: { plan, task_goal, ... } }
- 出边：→ repo_exploration（默认）/ → finalize（Plan mode / Ask mode without exploration）

### repo_exploration

- 角色：Repo Explorer
- 输入：`plan`, `task_goal`
- 行为：搜索文件、定位入口、收集上下文
- 产出：AgentDecision { next_action: "handoff", update_fields: { agent_contexts } }
- 出边：→ implement（默认）/ → review（Review mode）/ → finalize（Ask mode）

### implement

- 角色：Coder
- 输入：`plan`, `context_bundle`, `task_goal`
- 行为：制定修改方案，发出 ToolRequest
- 产出：AgentDecision { next_action: "request_tool" | "handoff", proposed_tool_request }
- 出边：→ execute_tool（request_tool）/ → review（handoff）

### execute_tool

- 归属：Runtime（非 Agent）
- 行为：调用 HarnessRuntime.execute(ToolRequest) → ToolResult
- 产出：写入 ToolResult 到 state.tool_results
- 出边：→ implement（继续 Coder）/ → test（Coder 完成后的 Tester）

> **注：** execute_tool 的路由依据当前 `current_agent` 决定回到哪个 agent。Coder 发起的回到 implement，Tester 发起的回到 test。

### review

- 角色：Reviewer
- 输入：`tool_results`, `plan`, `constraints`
- 行为：审查变更，输出 findings / severity / retry_needed
- 产出：AgentDecision { next_action: "retry" | "handoff", ... }
- 出边：→ implement（retry，返工计数+1）/ → test（handoff，通过）/ → finalize（严重风险）

### test

- 角色：Tester
- 输入：`change_plan`, `tool_results`
- 行为：选择并执行最小测试，发出 ToolRequest（可选）
- 产出：AgentDecision { next_action: "request_tool" | "retry" | "handoff", ... }
- 出边：→ execute_tool（request_tool）/ → implement（retry，返工计数+1）/ → approval（handoff，需要审批）/ → memory_writeback（handoff，无需审批）

### approval

- 行为：LangGraph `interrupt` 节点，等待用户审批
- 产出：收到 resume 后更新 approval_context，继续执行
- 入边：→ test（requires_approval）/ → implement（tool requires_approval）
- 出边：→ implement（approved，恢复执行）/ → finalize（rejected）

### memory_writeback

- 角色：Memory Manager
- 行为：沉淀 task_memory → MemoryEntry，写入 Long-term Memory
- 产出：更新 memory_refs
- 出边：→ finalize（无条件）
### finalize

- 行为：从 state 组装 final_answer，设置 status = "completed"
- 产出：final_answer
- 出边：END

## 4. 路由与条件边

### 4.1 Mode 分流

在 plan_task 出边处做首次分流（由 `router.should_finalize_early(state)` 决定）：

```python
def route_after_planning(state) -> Literal["repo_exploration", "finalize"]:
    if state.mode in ("plan",):
        return "finalize"           # Plan mode: 只输出计划
    return "repo_exploration"       # Act / Review / Ask 继续
```

在 repo_exploration 出边处做二次分流：

```python
def route_after_research(state) -> Literal["implement", "review", "finalize"]:
    if state.mode == "ask":
        return "finalize"           # Ask mode: 回答即可
    if state.mode == "review":
        return "review"             # Review mode: 直接审查
    return "implement"              # Act mode: 进入实现
```

### 4.2 返工回路

返工决策由 Reviewer/Tester 的 AgentDecision.next_action 驱动：

```python
def route_after_review(state) -> Literal["implement", "test", "finalize"]:
    decision = state.last_decision  # AgentDecision
    if decision.next_action == "retry":
        if state.retry_count.get("review", 0) < 2:
            return "implement"      # 返工
        return "finalize"           # 超过上限，终止
    if decision.next_action == "handoff":
        return "test"               # 审查通过
    return "finalize"
```

### 4.3 execute_tool 回路由

```python
def route_after_tool(state) -> str:
    agent = state.current_agent
    if agent == "coder":
        return "implement"
    if agent == "tester":
        return "test"
    return "review"  # fallback
```

### 4.4 审批路由

```python
def route_after_approval(state) -> Literal["implement", "finalize"]:
    if state.approval_context.get("decision") == "approved":
        return "implement"  # 恢复执行
    return "finalize"       # 拒绝或取消
```

## 5. StateGraph 实现结构

```python
from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import MemorySaver

graph = StateGraph(GraphState)

# 注册节点
graph.add_node("task_intake", task_intake)
graph.add_node("plan_task", plan_task)
graph.add_node("repo_exploration", repo_exploration)
graph.add_node("implement", implement)
graph.add_node("execute_tool", execute_tool)
graph.add_node("review", review)
graph.add_node("test", test)
graph.add_node("approval", approval)
graph.add_node("memory_writeback", memory_writeback)
graph.add_node("finalize", finalize)

# 注册边
graph.add_edge(START, "task_intake")
graph.add_edge("task_intake", "plan_task")

graph.add_conditional_edges("plan_task", route_after_planning, ...)
graph.add_conditional_edges("repo_exploration", route_after_research, ...)

graph.add_conditional_edges("implement", route_after_implement, ...)

graph.add_conditional_edges("execute_tool", route_after_tool, ...)

graph.add_conditional_edges("review", route_after_review, ...)
graph.add_conditional_edges("test", route_after_test, ...)

graph.add_conditional_edges("approval", route_after_approval, ...)

graph.add_edge("memory_writeback", "finalize")
graph.add_edge("finalize", END)

# 中断配置（HITL）
graph.set_interrupt_after(["approval"])

# 编译
checkpointer = MemorySaver()
app = graph.compile(checkpointer=checkpointer)
```

## 6. 状态 reducer 策略

LangGraph 通过 reducer 合并多处对同一字段的写入。关键 reducer：

```python
class GraphState(TypedDict, total=False):
    # 追加模式
    plan: Annotated[list[str], add]
    messages: Annotated[list[dict], add]
    tool_requests: Annotated[list[ToolRequest], add]
    tool_results: Annotated[list[ToolResult], add]
    artifacts: Annotated[list[str], add]
    review_notes: Annotated[list[str], add]
    test_summary: Annotated[list[str], add]
    task_memory: Annotated[list[str], add]
    memory_refs: Annotated[list[str], add]

    # 覆盖模式（默认）
    current_stage: str
    current_agent: str
    status: str
    approval_pending: bool
    final_answer: str
```

list 字段统一使用 `operator.add` 作为 reducer，确保多轮写入不会丢失数据。标量字段使用 LangGraph 默认的覆盖行为（新值替换旧值）。

## 7. AgentDecision 合并逻辑 (`apply_decision`)

```python
def apply_decision(state: GraphState, decision: AgentDecision) -> GraphState:
    # 1. 更新 current_agent
    state["current_agent"] = decision.agent_name

    # 2. 追加 reasoning（可选审计追踪）
    if decision.reasoning_notes:
        state.setdefault("messages", []).append({
            "role": decision.agent_name,
            "content": decision.summary,
        })

    # 3. 追加 ToolRequest（如果有）
    if decision.proposed_tool_request:
        state["tool_requests"].append(decision.proposed_tool_request)

    # 4. 写入 update_fields
    for key, value in decision.update_fields.items():
        if key in state:  # 只允许更新已定义字段
            state[key] = value

    # 5. 保存 last_decision 供 router 消费
    state["last_decision"] = decision  # 新增字段

    return state
```

## 8. 与现有代码的对接

### 现有占位 Agent 的迁移

现有 agents（`planner.py`, `researcher.py` 等）的签名从 `(state) → state` 改为 `(AgentInput) → AgentDecision`：

```python
# 旧签名
def plan_task(state: GraphState) -> GraphState:
    state["plan"] = [...]

# 新签名
def plan_task(input: AgentInput) -> AgentDecision:
    return AgentDecision(
        agent_name="planner",
        summary="...",
        next_action="handoff",
        update_fields={"plan": [...], "task_goal": ..., ...}
    )
```

### build_agent_input

```python
def build_agent_input(state: GraphState) -> AgentInput:
    return AgentInput(
        thread_id=state["thread_id"],
        run_id=state["run_id"],
        agent_name=...,       # 当前角色
        mode=state["mode"],
        current_stage=state["current_stage"],
        task_goal=state.get("task_goal", ""),
        constraints=state.get("constraints", []),
        success_criteria=state.get("success_criteria", []),
        relevant_plan_steps=...,
        context_bundle=state.get("agent_contexts", {}),
        task_memory=state.get("task_memory", []),
        available_tools=[],   # 后续通过 ToolRegistry 填充
    )
```

执行过程中如果需要环境配置不可用（如 LangGraph 依赖未安装），封装代码应提供明确的错误提示，引导开发者安装所需依赖。

## 9. 实现步骤（建议顺序）

1. **更新 GraphState**：为 list 字段添加 `Annotated[str, add]` reducer，新增 `last_decision` 字段
2. **实现 `apply_decision`** 和 `build_agent_input`
3. **迁移现有 Agent 函数**：将 6 个 agent 改为 `AgentInput → AgentDecision` 签名
4. **实现 router 函数**：`route_after_planning`, `route_after_research`, `route_after_review` 等
5. **构建 StateGraph**：注册节点、边、编译为 app
6. **接入 execute_tool + Runtime**
7. **接入 HITL interrupt**：approval 节点 + CLI 恢复循环
8. **更新 CLI**：`cli.py` 改为 `app.invoke()` / `app.stream()` 循环
9. **测试**：各模式路径 + 返工上限 + 审批中断/恢复

## 10. 测试策略

- 单元测试：每个 agent 函数单独测（mock AgentInput → assert AgentDecision）
- 集成测试：用 `app.invoke()` / `app.stream()` 跑完整 graph 路径
- 场景测试：
  - Act 模式全链路
  - Ask 模式（planning → exploration → finalize）
  - Plan 模式（planning → finalize）
  - Review 模式（planning → exploration → review → finalize）
  - Review 返工回路（审查不通过 → 重新实现 → 再审查）
  - Test 返工回路（测试失败 → 重新实现 → 再测试）
  - 返工超限终止
  - Approval 中断→批准
  - Approval 中断→拒绝
