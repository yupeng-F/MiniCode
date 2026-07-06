"""Trace 工具函数：创建标准 Trace 事件。

每个 instrumented 点调用 record_trace() 生成事件 dict，
然后作为增量添加到 GraphState.trace_events 中。
"""

from __future__ import annotations

from datetime import datetime, timezone

from multi_agents.schemas.trace import TraceEvent


def record_trace(
    event_type: str,
    agent: str,
    summary: str,
    duration_ms: int = 0,
) -> TraceEvent:
    """创建一条统一格式的 Trace 事件。

    Args:
        event_type: 事件类型（task_start/task_end/agent_start/agent_end/
                     tool_execution/master_dispatch/approval）
        agent: 关联的 Agent 名称
        summary: 人类可读的描述
        duration_ms: 耗时（毫秒），瞬时事件为 0
    """
    return TraceEvent(
        event_type=event_type,
        agent=agent,
        summary=summary,
        timestamp=datetime.now(timezone.utc).isoformat(),
        duration_ms=duration_ms,
    )
