from __future__ import annotations

from multi_agents.memory.memory_store import MemoryStore
from multi_agents.schemas.state import AgentInput


class ContextManager:
    """上下文管理器：为 Agent 组装最小上下文包。

    职责：
    - 构建 AgentInput 时自动添加相关长期记忆
    - 检索长期记忆中与当前任务相关的经验
    - 将记忆以文本形式注入上下文包
    """

    def __init__(self, memory_store: MemoryStore | None = None) -> None:
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
        """构建 AgentInput，附带相关长期记忆作为 context_bundle。"""
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
            memory_lines = []
            for m in memories:
                preview = m.content[:200].replace("\n", " ")
                memory_lines.append(f"[{m.memory_type}] {m.title}: {preview}")
            ctx["context_bundle"] = {
                "retrieved_memories": "\n".join(memory_lines),
                **(context or {}),
            }
        elif context:
            ctx["context_bundle"] = context

        return ctx
