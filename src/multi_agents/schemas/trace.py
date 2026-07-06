from __future__ import annotations

from typing_extensions import TypedDict


class TraceEvent(TypedDict):
    """统一 Trace 事件结构。

    event_type: 事件类型标识
    agent:      关联的 Agent 名称
    summary:    人类可读的事件描述
    timestamp:  事件发生时间（ISO 格式）
    duration_ms: 持续时间（毫秒），瞬时事件为 0
    """

    event_type: str
    agent: str
    summary: str
    timestamp: str
    duration_ms: int
