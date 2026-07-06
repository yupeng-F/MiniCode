# Phase 2 — Master-Specialist 架构改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有线性 StateGraph 工作流改造为 Master-Specialist 双层架构，同时实现 ChromaDB 记忆系统和 Web 交互界面

**Architecture:**
- Master Agent 作为唯一决策中枢，LLM 输出 `next_agent` 枚举值，路由函数做机械跳转
- Specialist Agent 专精执行，不持有全局上下文，各有独立工具权限
- ToolRegistry 在 Runtime 层按角色拦截非法工具调用
- 返工采用 3/5 软硬上限，路由层硬截断

**Tech Stack:** Python 3.11+, LangGraph, Pydantic, ChromaDB, FastAPI, Qwen3.6-plus

---

## Task 1: ToolRegistry — 工具注册与按角色权限绑定

**Files:**
- Create: `src/multi_agents/runtime/tool_registry.py`
- Modify: `src/multi_agents/tools/base.py` — 补充 `allowed_roles` 字段
- Modify: `src/multi_agents/runtime/tool_executor.py` — 接入权限校验
- Modify: `src/multi_agents/runtime/harness.py` — preflight 集成权限校验
- Test: `tests/test_tool_registry.py`

**设计说明:**
- `ToolRegistry` 管理所有工具的注册和权限查询
- 每个工具注册时绑定 `allowed_roles`（允许调用的 Agent 角色列表）
- `check_permission(agent_name, tool_name) → bool` 在 Runtime 层调用
- 拒绝时返回明确的 PolicyDecision，不抛异常

- [ ] **Step 1.1: 补充 ToolSpec 添加 allowed_roles 字段**

修改 `src/multi_agents/tools/base.py`，给 ToolSpec 添加 `allowed_roles` 和 `risk_level` 字段：

```python
from pydantic import BaseModel

class ToolSpec(BaseModel):
    """工具规格定义。"""
    name: str
    description: str
    parameters: dict
    allowed_roles: list[str] = []        # 允许调用的 Agent 角色，空=全部允许
    risk_level: str = "low"              # low / medium / high
    side_effect: bool = False            # 是否有副作用
```

- [ ] **Step 1.2: 编写 ToolRegistry 实现**

创建 `src/multi_agents/runtime/tool_registry.py`：

```python
from multi_agents.tools.base import ToolSpec


class ToolRegistry:
    """工具注册表，管理工具定义与角色权限。"""

    def __init__(self):
        self._tools: dict[str, ToolSpec] = {}

    def register(self, spec: ToolSpec) -> None:
        """注册一个工具。"""
        self._tools[spec.name] = spec

    def get_spec(self, tool_name: str) -> ToolSpec | None:
        return self._tools.get(tool_name)

    def get_tools_for_role(self, role: str) -> list[ToolSpec]:
        """查询某个角色可以使用的所有工具。"""
        return [t for t in self._tools.values()
                if not t.allowed_roles or role in t.allowed_roles]

    def check_permission(self, role: str, tool_name: str) -> bool:
        """检查角色是否有权限调用指定工具。"""
        spec = self._tools.get(tool_name)
        if spec is None:
            return False
        if not spec.allowed_roles:
            return True  # 空列表=允许所有
        return role in spec.allowed_roles

    def list_all_tools(self) -> list[ToolSpec]:
        return list(self._tools.values())

    @property
    def tool_names(self) -> list[str]:
        return list(self._tools.keys())
```

- [ ] **Step 1.3: 编写权限校验测试**

创建 `tests/test_tool_registry.py`：

```python
import pytest
from multi_agents.runtime.tool_registry import ToolRegistry
from multi_agents.tools.base import ToolSpec


@pytest.fixture
def registry():
    r = ToolRegistry()
    r.register(ToolSpec(
        name="read_file",
        description="读取文件",
        parameters={"path": {"type": "string"}},
        allowed_roles=["explorer", "coder", "reviewer", "tester"],
        risk_level="low",
        side_effect=False,
    ))
    r.register(ToolSpec(
        name="write_file",
        description="写入文件",
        parameters={"path": {"type": "string"}, "content": {"type": "string"}},
        allowed_roles=["coder"],
        risk_level="medium",
        side_effect=True,
    ))
    r.register(ToolSpec(
        name="run_shell",
        description="运行 shell 命令",
        parameters={"command": {"type": "string"}},
        allowed_roles=["coder", "tester"],
        risk_level="high",
        side_effect=True,
    ))
    return r


def test_check_permission_allows_correct_role(registry):
    assert registry.check_permission("coder", "write_file") is True


def test_check_permission_denies_wrong_role(registry):
    assert registry.check_permission("explorer", "write_file") is False


def test_get_tools_for_role_returns_allowed_only(registry):
    tools = registry.get_tools_for_role("explorer")
    names = [t.name for t in tools]
    assert "read_file" in names
    assert "write_file" not in names


def test_get_tools_for_role_coder(registry):
    tools = registry.get_tools_for_role("coder")
    names = [t.name for t in tools]
    assert "read_file" in names
    assert "write_file" in names
    assert "run_shell" in names
```

- [ ] **Step 1.4: 运行测试验证**

```bash
cd /d/Code/Python/Multi_Agents
python -m pytest tests/test_tool_registry.py -v
```

预期：4 passed

- [ ] **Step 1.5: 注册所有工具并接入现有 ToolExecutor**

修改 `src/multi_agents/runtime/tool_executor.py`，在 `__init__` 中使用 ToolRegistry 注册工具：

```python
from multi_agents.runtime.tool_registry import ToolRegistry
from multi_agents.tools.base import ToolSpec


class ToolExecutor:
    def __init__(self, registry: ToolRegistry | None = None):
        self.registry = registry or self._build_default_registry()
        self._handlers = {
            "read_file": self._read_file,
            "write_file": self._write_file,
            "list_directory": self._list_directory,
            "search_code": self._search_code,
            "run_shell": self._run_shell,
        }

    def _build_default_registry(self) -> ToolRegistry:
        reg = ToolRegistry()
        reg.register(ToolSpec(
            name="read_file",
            description="读取文件内容",
            parameters={"path": {"type": "string"}},
            allowed_roles=["explorer", "coder", "reviewer", "tester"],
            risk_level="low",
        ))
        reg.register(ToolSpec(
            name="write_file",
            description="写入文件",
            parameters={"path": {"type": "string"}, "content": {"type": "string"}},
            allowed_roles=["coder"],
            risk_level="medium",
            side_effect=True,
        ))
        reg.register(ToolSpec(
            name="list_directory",
            description="列出目录内容",
            parameters={"path": {"type": "string"}},
            allowed_roles=["explorer", "coder"],
            risk_level="low",
        ))
        reg.register(ToolSpec(
            name="search_code",
            description="搜索代码",
            parameters={"query": {"type": "string"}},
            allowed_roles=["explorer", "reviewer"],
            risk_level="low",
        ))
        reg.register(ToolSpec(
            name="run_shell",
            description="运行 shell 命令",
            parameters={"command": {"type": "string"}},
            allowed_roles=["coder", "tester"],
            risk_level="high",
            side_effect=True,
        ))
        return reg

    def execute(self, request: ToolRequest) -> ToolResult:
        # 1. 权限校验
        agent_role = request.agent_name
        if not self.registry.check_permission(agent_role, request.tool_name):
            return ToolResult(
                request_id=request.request_id,
                tool_name=request.tool_name,
                success=False,
                summary=f"Permission denied: '{agent_role}' cannot call '{request.tool_name}'",
                exit_code=1,
            )
        # 2. 分发执行
        handler = self._handlers.get(request.tool_name)
        if handler is None:
            return ToolResult(
                request_id=request.request_id,
                tool_name=request.tool_name,
                success=False,
                summary=f"Unknown tool: {request.tool_name}",
                exit_code=1,
            )
        return handler(request)
```

- [ ] **Step 1.6: 更新 HarnessRuntime.preflight 集成权限判断**

修改 `src/multi_agents/runtime/harness.py`，在 preflight 中追加权限判断：

```python
class HarnessRuntime:
    def __init__(self, policy_engine=None, tool_executor=None):
        self.policy_engine = policy_engine or PolicyEngine()
        self.tool_executor = tool_executor or ToolExecutor()

    def preflight(self, request: ToolRequest) -> PolicyDecision:
        # 1. 权限检查
        if not self.tool_executor.registry.check_permission(
            request.agent_name, request.tool_name
        ):
            return PolicyDecision(
                decision="deny",
                requires_approval=False,
                reason=f"Role '{request.agent_name}' not allowed to use '{request.tool_name}'",
                risk_level=request.risk_level,
                matched_rule="role_based_access_control",
            )
        # 2. 原有策略检查
        return self.policy_engine.evaluate(request)
```

- [ ] **Step 1.7: 运行完整测试确保无回归**

```bash
python -m pytest tests/ -v
```
预期：原有 17 + 新增 4 = 21 passed

---

## Task 2: Master Agent 调度框架

**Files:**
- Create: `src/multi_agents/agents/master.py`
- Create: `src/multi_agents/orchestrator/master_router.py`
- Modify: `src/multi_agents/llm/prompts.py` — 新增 Master 和 MasterDispatch 的 system prompt
- Modify: `src/multi_agents/schemas/agent.py` — 补充 MasterDispatch 相关字段

- [ ] **Step 2.1: 新增 MasterDispatch 决策结构**

在 `src/multi_agents/schemas/agent.py` 中新增：

```python
from typing import Literal, Optional

# Master Agent 调度决策字段（嵌入到 AgentDecision.update_fields）
# update_fields 中新增以下结构:
# {
#   "master_dispatch": {
#     "next_agent": "explorer" | "coder" | "reviewer" | "tester" | "memory_writer" | None,
#     "context_for_agent": {...},
#     "reasoning": "为什么调这个 Agent",
#     "stage": "planning" | "exploring" | "implementing" | "reviewing" | "testing" | "finalizing",
#     "task_complete": False,
#     "final_answer": ""
#   }
# }
```

- [ ] **Step 2.2: 编写 Master system prompt**

在 `src/multi_agents/llm/prompts.py` 新增：

```python
MASTER_SYSTEM_PROMPT = """You are the Master Agent in a multi-agent coding assistant system.

Your job is to understand the user's task, make a plan, dispatch specialists, and synthesize results.

Available specialists:
- explorer: searches codebase, reads files, gathers context
- coder: implements changes, writes files, runs commands
- reviewer: reviews code for issues, risks, and correctness
- tester: runs tests and verifies results
- memory_writer: persists task experience as long-term memory

You operate in a loop:
1. When you receive the task, first create a plan
2. Then dispatch ONE specialist at a time
3. When the specialist returns, decide the next step
4. Loop until the task is complete

Each specialist is stateless - they only see what you tell them.
You maintain the full picture across all steps.

Output JSON format:
{
    "summary": "Current status and what you decided",
    "next_action": "handoff",
    "update_fields": {
        "plan": ["Step 1", "Step 2", ...],
        "current_stage": "planning",
        "master_dispatch": {
            "next_agent": "explorer" | "coder" | "reviewer" | "tester" | "memory_writer" | null,
            "context_for_agent": {
                "task": "what this specialist needs to do",
                "context": "relevant info for this specialist"
                "plan_steps": ["relevant plan steps"]
            },
            "reasoning": "why you chose this specialist",
            "stage": "current_stage_label",
            "task_complete": false,
            "final_answer": ""
        }
    }
}

Rules:
- Always set next_action to "handoff"
- Set task_complete to true and next_agent to null when done, and provide final_answer
- Each specialist invocation should be focused and specific
- You MUST NOT call tools directly - only dispatch specialists
- Retry limit: 3 times per specialist normally, up to 5 if necessary
"""

# 追加到 SYSTEM_PROMPTS 字典
SYSTEM_PROMPTS = {
    "planner": PLANNER_SYSTEM_PROMPT,
    "repo_explorer": EXPLORER_SYSTEM_PROMPT,
    "coder": CODER_SYSTEM_PROMPT,
    "reviewer": REVIEWER_SYSTEM_PROMPT,
    "tester": TESTER_SYSTEM_PROMPT,
    "master": MASTER_SYSTEM_PROMPT,  # 新增
}
```

- [ ] **Step 2.3: 编写 Master Agent 节点函数**

创建 `src/multi_agents/agents/master.py`：

```python
from multi_agents.llm import agent_helper
from multi_agents.schemas.agent import AgentDecision
from multi_agents.schemas.state import AgentInput


def plan_and_dispatch(input: AgentInput) -> AgentDecision:
    """Master Agent: understand task, track progress, dispatch specialists."""
    return agent_helper.call_llm_decision("master", input)
```

- [ ] **Step 2.4: 编写 Master 路由函数（含硬上限保护）**

创建 `src/multi_agents/orchestrator/master_router.py`：

```python
from multi_agents.schemas.state import GraphState

HARD_CEILING = 5


def route_master(state: GraphState) -> str:
    """Master 调度路由：读取 next_agent，硬上限保护。"""
    decision = state.get("last_decision", {})
    uf = decision.get("update_fields", {})
    dispatch = uf.get("master_dispatch", {})
    next_agent = dispatch.get("next_agent")

    # 任务完成
    if next_agent is None or dispatch.get("task_complete"):
        return "finalize"

    # 硬上限检测
    retries = state.get("retry_count", {})
    if retries.get(next_agent, 0) >= HARD_CEILING:
        return "force_finalize"

    return next_agent


def route_after_specialist(state: GraphState) -> str:
    """Specialist 执行完毕后回到 Master。"""
    return "master_plan"
```

---

## Task 3: 重构图结构 — Master → Specialist 循环

**Files:**
- Modify: `src/multi_agents/orchestrator/graph.py` — 重构 StateGraph
- Modify: `src/multi_agents/agents/__init__.py` — 导出 master
- Modify: `src/multi_agents/orchestrator/nodes.py` — 调整节点
- Modify: `src/multi_agents/orchestrator/router.py` — 精简旧路由

- [ ] **Step 3.1: 重构 StateGraph**

```python
from langgraph.graph import END, START, StateGraph
from langgraph.checkpoint.memory import MemorySaver
from langgraph.checkpoint.serde.base import SerializerCompat
import pickle

from multi_agents.agents import (
    plan_task, run_research, run_execution,
    run_testing, review_result, write_memory,
    plan_and_dispatch,  # 新增 Master
)
from multi_agents.orchestrator.agent_node import make_agent_node
from multi_agents.orchestrator.nodes import (
    execute_tool, execute_tool_approval,
    approval_interrupt, finalize, task_intake,
)
from multi_agents.orchestrator.master_router import route_master, route_after_specialist
from multi_agents.schemas.state import GraphState


def build_graph() -> StateGraph:
    graph = StateGraph(GraphState)

    # ---- 注册节点 ----
    graph.add_node("task_intake", task_intake)
    graph.add_node("master_plan", make_agent_node(plan_and_dispatch, "master"))

    # Specialist 节点
    graph.add_node("explorer", make_agent_node(run_research, "repo_explorer"))
    graph.add_node("coder", make_agent_node(run_execution, "coder"))
    graph.add_node("execute_tool", execute_tool)
    graph.add_node("execute_tool_approval", execute_tool_approval)
    graph.add_node("reviewer", make_agent_node(review_result, "reviewer"))
    graph.add_node("tester", make_agent_node(run_testing, "tester"))
    graph.add_node("approval_interrupt", approval_interrupt)
    graph.add_node("memory_writer", make_agent_node(write_memory, "memory_manager"))
    graph.add_node("finalize", finalize)
    graph.add_node("force_finalize", finalize)  # 硬上限强制结束

    # ---- 主流程边 ----
    graph.add_edge(START, "task_intake")
    graph.add_edge("task_intake", "master_plan")

    # Master 动态调度（条件边）
    graph.add_conditional_edges("master_plan", route_master, {
        "explorer": "explorer",
        "coder": "coder",
        "reviewer": "reviewer",
        "tester": "tester",
        "memory_writer": "memory_writer",
        "finalize": "finalize",
        "force_finalize": "force_finalize",
    })

    # Specialist -> Master（执行完后都回 Master）
    graph.add_conditional_edges("explorer", route_after_specialist, {"master_plan": "master_plan"})
    graph.add_conditional_edges("coder", route_after_specialist, {"master_plan": "master_plan"})
    graph.add_conditional_edges("reviewer", route_after_specialist, {"master_plan": "master_plan"})
    graph.add_conditional_edges("tester", route_after_specialist, {"master_plan": "master_plan"})
    graph.add_conditional_edges("memory_writer", route_after_specialist, {"master_plan": "master_plan"})

    # 工具执行节点回到对应的 Specialist
    graph.add_edge("execute_tool", "coder")
    graph.add_edge("execute_tool_approval", "coder")
    graph.add_edge("approval_interrupt", "tester")

    graph.add_edge("finalize", END)
    graph.add_edge("force_finalize", END)

    return graph


def compile_graph():
    graph = build_graph()
    checkpointer = MemorySaver(serde=SerializerCompat(pickle))
    return graph.compile(checkpointer=checkpointer)
```

- [ ] **Step 3.2: 更新 agents/__init__.py**

```python
from multi_agents.agents.executor import run_execution
from multi_agents.agents.master import plan_and_dispatch  # 新增
from multi_agents.agents.memory_writer import write_memory
from multi_agents.agents.planner import plan_task
from multi_agents.agents.researcher import run_research
from multi_agents.agents.reviewer import review_result
from multi_agents.agents.tester import run_testing

__all__ = [
    "plan_and_dispatch",  # 新增
    "plan_task",
    "run_research",
    "run_execution",
    "review_result",
    "run_testing",
    "write_memory",
]
```

- [ ] **Step 3.3: 精简旧 router.py**

保留旧 router 函数供参考，但主流程不再使用。移除不再被引用的 `route_after_planning`、`route_after_research` 等，或用注释标记已废弃。

- [ ] **Step 3.4: 运行测试验证**

```bash
python -m pytest tests/ -v
```

预期：测试可能需要更新以适配新图结构，此时先确认编译不报错

---

## Task 4: Specialist Agent 工具权限接入

**Files:**
- Modify: `src/multi_agents/agents/executor.py` — Coder tools
- Modify: `src/multi_agents/agents/researcher.py` — Explorer tools
- Modify: `src/multi_agents/agents/reviewer.py` — Reviewer tools
- Modify: `src/multi_agents/agents/tester.py` — Tester tools
- Modify: `src/multi_agents/llm/agent_helper.py` — 传入 available_tools

- [ ] **Step 4.1: 在 agent_helper 中集成 ToolRegistry 查询可用工具**

修改 `src/multi_agents/llm/agent_helper.py` 的 `format_agent_input_for_prompt`，接收 `available_tools` 参数并格式化：

```python
def format_agent_input_for_prompt(input: AgentInput) -> str:
    parts = [f"## Task Goal\n{input.get('task_goal', '')}"]
    # ... 原有代码 ...
    tools = input.get("available_tools", [])
    if tools:
        parts.append("## Available Tools")
        for t in tools:
            if isinstance(t, dict):
                parts.append(f"- {t.get('name')}: {t.get('description', '')}")
            else:
                parts.append(f"- {t}")
    return "\n".join(parts)
```

- [ ] **Step 4.2: 修改 agent_helper.call_llm_decision 传入角色工具列表**

```python
def call_llm_decision(agent_name: str, input: AgentInput) -> AgentDecision:
    system_prompt = SYSTEM_PROMPTS.get(agent_name)
    if system_prompt is None:
        return AgentDecision(agent_name=agent_name, summary="...", next_action="handoff")

    try:
        # 注入可用工具列表
        from multi_agents.runtime.tool_executor import ToolExecutor
        executor = ToolExecutor()
        tools = executor.registry.get_tools_for_role(agent_name)
        input["available_tools"] = tools  # 注入到 AgentInput

        user_content = format_agent_input_for_prompt(input)
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ]
        # ... 原有 LLM 调用逻辑 ...
```

---

## Task 5: ChromaDB 长期记忆存储与检索

**Files:**
- Create: `src/multi_agents/memory/memory_store.py` — ChromaDB 封装（重写）
- Create: `src/multi_agents/memory/context_manager.py` — 上下文组装
- Install: `chromadb` 依赖
- Modify: `src/multi_agents/agents/memory_writer.py` — 接入真实写入
- Modify: `src/multi_agents/agents/master.py` — 接入检索

- [ ] **Step 5.1: 安装 chromadb**

```bash
pip install chromadb
```

- [ ] **Step 5.2: 重写 MemoryStore（ChromaDB 封装）**

```python
import chromadb
from chromadb.config import Settings
from multi_agents.schemas.memory import MemoryEntry

MEMORY_TYPES = ["task_experience", "repo_convention", "user_profile", "failure_case"]


class MemoryStore:
    """ChromaDB-backed long-term memory store.

    4 collections by memory_type, each collection stores:
    - documents: the memory content (auto-vectorized)
    - metadatas: {memory_id, title, scope, source_run_id, tags, created_at, memory_type}
    - ids: unique memory_id
    """

    def __init__(self, persist_dir: str = ".claude/memory/chromadb"):
        self.client = chromadb.PersistentClient(
            path=persist_dir,
            settings=Settings(anonymized_telemetry=False),
        )
        self._collections = {}  # lazy init

    def _get_collection(self, memory_type: str):
        if memory_type not in MEMORY_TYPES:
            raise ValueError(f"Invalid memory_type: {memory_type}")
        if memory_type not in self._collections:
            self._collections[memory_type] = self.client.get_or_create_collection(
                name=memory_type,
                metadata={"hnsw:space": "cosine"},
            )
        return self._collections[memory_type]

    def add(self, entry: MemoryEntry) -> str:
        """写入一条记忆。"""
        collection = self._get_collection(entry.memory_type)
        collection.add(
            documents=[entry.content],
            metadatas=[{
                "memory_id": entry.memory_id,
                "title": entry.title,
                "scope": entry.scope,
                "source_run_id": entry.source_run_id,
                "tags": ",".join(entry.tags or []),
                "created_at": entry.created_at,
            }],
            ids=[entry.memory_id],
        )
        return entry.memory_id

    def query(self, query_text: str, memory_type: str, n_results: int = 5) -> list[MemoryEntry]:
        """检索最相关的记忆条目。"""
        collection = self._get_collection(memory_type)
        results = collection.query(
            query_texts=[query_text],
            n_results=n_results,
        )
        entries = []
        for i in range(len(results["ids"][0])):
            entry = MemoryEntry(
                memory_id=results["ids"][0][i],
                memory_type=memory_type,
                title=results["metadatas"][0][i].get("title", ""),
                content=results["documents"][0][i],
                scope=results["metadatas"][0][i].get("scope", "repo"),
                source_run_id=results["metadatas"][0][i].get("source_run_id", ""),
                tags=results["metadatas"][0][i].get("tags", "").split(",") if results["metadatas"][0][i].get("tags") else [],
                created_at=results["metadatas"][0][i].get("created_at", ""),
            )
            entries.append(entry)
        return entries

    def query_all_types(self, query_text: str, n_per_type: int = 3) -> list[MemoryEntry]:
        """跨所有类型检索。"""
        all_entries = []
        for mtype in MEMORY_TYPES:
            try:
                entries = self.query(query_text, mtype, n_results=n_per_type)
                all_entries.extend(entries)
            except Exception:
                continue
        return all_entries

    def delete(self, memory_id: str, memory_type: str) -> None:
        collection = self._get_collection(memory_type)
        collection.delete(ids=[memory_id])
```

- [ ] **Step 5.3: 编写 Context Manager**

```python
from multi_agents.memory.memory_store import MemoryStore
from multi_agents.schemas.state import AgentInput


class ContextManager:
    """为 Agent 组装最小上下文包，集成长期记忆检索。"""

    def __init__(self, memory_store: MemoryStore | None = None):
        self.memory_store = memory_store or MemoryStore()

    def build_agent_input(
        self,
        agent_name: str,
        task_goal: str,
        context: dict | None = None,
        plan_steps: list[str] | None = None,
        task_memory: list[str] | None = None,
        recent_results: list | None = None,
    ) -> AgentInput:
        """组装 AgentInput，附带相关长期记忆。"""
        ctx = AgentInput(
            agent_name=agent_name,
            task_goal=task_goal,
            relevant_plan_steps=plan_steps or [],
            task_memory=task_memory or [],
            recent_tool_results=recent_results or [],
        )

        # 检索相关长期记忆
        memories = self.memory_store.query_all_types(task_goal, n_per_type=2)
        if memories:
            memory_context = "\n".join(
                f"[{m.memory_type}] {m.title}: {m.content[:200]}"
                for m in memories
            )
            ctx["context_bundle"] = {
                "retrieved_memories": memory_context,
                **(context or {}),
            }
        elif context:
            ctx["context_bundle"] = context

        return ctx
```

- [ ] **Step 5.4: 更新 Memory Writer Agent**

```python
from multi_agents.schemas.agent import AgentDecision
from multi_agents.schemas.state import AgentInput
from multi_agents.schemas.memory import MemoryEntry
from multi_agents.memory.memory_store import MemoryStore
from uuid import uuid4
from datetime import datetime


_store = MemoryStore()


def write_memory(input: AgentInput) -> AgentDecision:
    """Persist task experience as a structured memory entry."""
    task_goal = input.get("task_goal", "")
    plan = input.get("relevant_plan_steps", [])

    entry = MemoryEntry(
        memory_id=str(uuid4())[:8],
        memory_type="task_experience",
        title=f"Task: {task_goal[:60]}",
        content=f"Goal: {task_goal}\nPlan: {'; '.join(plan)}\nCompleted: {datetime.now().isoformat()}",
        scope="repo",
        source_run_id=input.get("run_id", ""),
        tags=["task"],
        created_at=datetime.now().isoformat(),
        confidence=0.7,
    )
    memory_id = _store.add(entry)

    return AgentDecision(
        agent_name="memory_manager",
        summary=f"Memory written: {memory_id}",
        next_action="handoff",
        update_fields={
            "current_stage": "memory_writeback",
            "memory_refs": [memory_id],
        },
    )
```

---

## Task 6: 滑动窗口 + LLM 摘要上下文压缩

**Files:**
- Create: `src/multi_agents/memory/sliding_window.py`
- Modify: `src/multi_agents/orchestrator/nodes.py` — 集成压缩到 finalize 或专门的压缩节点

- [ ] **Step 6.1: 实现滑动窗口**

```python
from multi_agents.llm.client import LLMClient


class SlidingWindow:
    """滑动窗口上下文压缩。

    当消息队列超过阈值时，触发 LLM 摘要，用摘要替换旧消息。
    """

    def __init__(self, keep_latest: int = 10, trigger_at: int = 20):
        self.keep_latest = keep_latest
        self.trigger_at = trigger_at

    def should_compress(self, messages: list) -> bool:
        return len(messages) > self.trigger_at

    def compress(self, messages: list, task_goal: str = "") -> list:
        """压缩旧消息，保留最近 N 轮完整消息 + 前置摘要。"""
        if not self.should_compress(messages):
            return messages

        # 标记待压缩区域（保留最新 keep_latest 轮）
        compress_count = len(messages) - self.keep_latest
        to_compress = messages[:compress_count]
        to_keep = messages[compress_count:]

        # LLM 生成摘要
        summary = self._summarize(to_compress, task_goal)

        # 用摘要替换
        compressed = [
            {"role": "system", "content": f"[Context Summary] {summary}"}
        ] + to_keep

        return compressed

    def _summarize(self, messages: list, task_goal: str) -> str:
        """调用 LLM 生成旧消息摘要。"""
        prompt = f"""Summarize the following conversation about the task below.
Keep key decisions, code changes, tool results, and current progress.
Output a concise paragraph.

Task: {task_goal}

Conversation to summarize:
{self._format_messages(messages)}
"""
        try:
            client = LLMClient()
            summary = client.chat(
                messages=[{"role": "user", "content": prompt}],
                max_tokens=512,
                temperature=0.1,
            )
            return summary.strip()
        except Exception as e:
            # LLM 不可用时截断
            return f"[Compressed {len(messages)} messages. LLM unavailable: {e}]"

    def _format_messages(self, messages: list) -> str:
        lines = []
        for m in messages[-50:]:  # 限制输入长度
            role = m.get("role", "unknown")
            content = m.get("content", "")
            if isinstance(content, str):
                lines.append(f"[{role}]: {content[:200]}")
        return "\n".join(lines)
```

- [ ] **Step 6.2: 集成到图节点**

在 `nodes.py` 中新增一个 `compress_context` 节点，或集成到 `task_intake` 节点中。建议作为独立的图节点在每次 Master 调度前调用：

```python
from multi_agents.memory.sliding_window import SlidingWindow

_window = SlidingWindow()

def compress_context(state: GraphState) -> GraphState:
    """在 Master 调度前压缩过长的消息队列。"""
    messages = state.get("messages", [])
    if _window.should_compress(messages):
        task_goal = state.get("task_goal", "")
        state["messages"] = _window.compress(messages, task_goal)
        state["task_memory"] = state.get("task_memory", []) + [
            f"[Context compressed: {len(messages)} → {len(state['messages'])} messages]"
        ]
    return state
```

然后在 `graph.py` 中注册此节点，并在 `master_plan` 之前执行：

```python
graph.add_node("compress_context", compress_context)
graph.add_edge("task_intake", "compress_context")
graph.add_edge("compress_context", "master_plan")
```

---

## Task 7: Web UI

**Files:**
- Create: `src/multi_agents/interfaces/web/__init__.py`
- Create: `src/multi_agents/interfaces/web/app.py`
- Create: `src/multi_agents/interfaces/web/templates/index.html`
- Create: `src/multi_agents/interfaces/web/static/style.css`
- Create: `src/multi_agents/interfaces/web/static/script.js`
- Modify: `pyproject.toml` — 添加 fastapi + uvicorn 依赖

（Web UI 的详细代码较多，可以安排在核心架构改造完成后展开）

---

## 计划执行顺序

```
Task 1: ToolRegistry ───────────────── 基础组件，零依赖
Task 2: Master Agent ───────────────── 依赖 Task 1
Task 3: 重构图结构 ─────────────────── 依赖 Task 2
Task 4: 工具权限接入 ───────────────── 依赖 Task 1
Task 5: ChromaDB 记忆系统 ──────────── 可独立开发
Task 6: 滑动窗口 ───────────────────── 可独立开发
Task 7: Web UI ─────────────────────── 依赖 Task 3（后端接口）
```
