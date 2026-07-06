from __future__ import annotations

from multi_agents.llm import agent_helper
from multi_agents.schemas.agent import AgentDecision
from multi_agents.schemas.state import AgentInput

# 惰性初始化 MemoryStore，避免模块导入时触发 ChromaDB 模型下载
_memory_store = None


def _get_memory_store():
    global _memory_store
    if _memory_store is None:
        from multi_agents.memory.memory_store import MemoryStore
        _memory_store = MemoryStore()
    return _memory_store


def plan_and_dispatch(input: AgentInput) -> AgentDecision:
    """Master Agent: 理解任务、跟踪进展、调度 Specialist。

    在调用 LLM 之前，先从长期记忆中检索与当前任务相关的经验，
    作为上下文注入到 prompt 中。
    """
    # 检索相关长期记忆
    task_goal = input.get("task_goal", "")
    try:
        store = _get_memory_store()
        memories = store.query_all_types(task_goal, n_per_type=2)
        if memories:
            memory_lines = []
            for m in memories:
                preview = m.content[:150].replace("\n", " ")
                memory_lines.append(f"[{m.memory_type}] {m.title}: {preview}")
            existing_bundle = input.get("context_bundle", {}) or {}
            existing_bundle["retrieved_memories"] = "\n".join(memory_lines)
            input["context_bundle"] = existing_bundle
    except Exception:
        pass  # 记忆检索失败不应阻塞任务

    return agent_helper.call_llm_decision("master", input)
