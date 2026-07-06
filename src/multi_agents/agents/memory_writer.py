from __future__ import annotations

from datetime import datetime, timezone

from multi_agents.schemas.agent import AgentDecision
from multi_agents.schemas.state import AgentInput

# 惰性初始化 MemoryStore，避免模块导入时触发 ChromaDB 模型下载
_memory_store = None


def _get_store():
    global _memory_store
    if _memory_store is None:
        from multi_agents.memory.memory_store import MemoryStore
        _memory_store = MemoryStore()
    return _memory_store


def write_memory(input: AgentInput) -> AgentDecision:
    """Persist task experience as a structured memory entry in ChromaDB.

    Creates a task_experience type MemoryEntry summarizing the task goal,
    plan, and completion status, then stores it via MemoryStore.
    """
    task_goal = input.get("task_goal", "")
    plan = input.get("relevant_plan_steps", [])

    content_parts = [f"Goal: {task_goal}"]
    if plan:
        content_parts.append("Plan:\n" + "\n".join(f"  - {s}" for s in plan))
    content_parts.append(f"Completed: {datetime.now(timezone.utc).isoformat()}")

    store = _get_store()
    entry = store.make_entry(
        memory_type="task_experience",
        title=f"Task: {task_goal[:60]}",
        content="\n".join(content_parts),
        scope="repo",
        source_run_id=input.get("run_id", ""),
        tags=["task"],
    )

    try:
        memory_id = store.add(entry)
        summary = f"Memory written: {memory_id} ({entry.memory_type})"
    except Exception as e:
        memory_id = "error"
        summary = f"Memory write failed: {e}"

    return AgentDecision(
        agent_name="memory_manager",
        summary=summary,
        next_action="handoff",
        update_fields={
            "current_stage": "memory_writeback",
            "memory_refs": [memory_id] if memory_id != "error" else [],
        },
    )
