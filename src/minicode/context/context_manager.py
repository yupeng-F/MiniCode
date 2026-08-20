from __future__ import annotations

import json
from dataclasses import dataclass, field

from minicode.context.compact_manager import CompactManager
from minicode.context.token_budget import TokenBudget
from minicode.context.token_counter import TokenCounter
from minicode.memory.memory_service import MemoryService
from minicode.schemas.session import SessionState


@dataclass(slots=True)
class ContextProjection:
    """按固定预算构建、可审计并可渲染的模型上下文。"""

    system_and_tools: str = ""
    current_task: str = ""
    recent_messages: str = ""
    tool_history: str = ""
    memory: str = ""
    compact_summary: str = ""
    plan_files_meta: str = ""
    usage: dict[str, int] = field(default_factory=dict)
    dropped: list[str] = field(default_factory=list)

    @property
    def total_tokens(self) -> int:
        return sum(self.usage.values())

    def render(self) -> str:
        sections = [
            self.system_and_tools,
            f"## 当前任务\n{self.current_task}" if self.current_task else "",
            f"## 对话摘要\n{self.compact_summary}" if self.compact_summary else "",
            self.plan_files_meta,
            f"## 项目记忆\n{self.memory}" if self.memory else "",
            f"## 最近消息\n{self.recent_messages}" if self.recent_messages else "",
            f"## 最近工具结果\n{self.tool_history}" if self.tool_history else "",
        ]
        return "\n\n".join(section for section in sections if section)

    def __str__(self) -> str:
        return self.render()

    def __contains__(self, value: str) -> bool:
        return value in self.render()


class ContextManager:
    MAX_TOOL_CONTEXT_CHARS = 24_000
    MAX_LATEST_TOOL_PREVIEW_CHARS = 12_000
    MAX_OLDER_TOOL_PREVIEW_CHARS = 3_000

    def __init__(
        self,
        compactor: CompactManager | None = None,
        memory_service: MemoryService | None = None,
        token_counter: TokenCounter | None = None,
        token_budget: TokenBudget | None = None,
    ) -> None:
        self.compactor = compactor or CompactManager()
        self.memory_service = memory_service
        self.token_counter = token_counter or TokenCounter()
        self.token_budget = token_budget or TokenBudget()

    def build(
        self,
        session: SessionState,
        tool_descriptions: list[str] | None = None,
        include_tool_results: bool = True,
    ) -> ContextProjection:
        self.token_budget.validate_user_message(session.task, counter=self.token_counter)
        compact, messages = self.compactor.compact_messages(session.messages)
        if compact:
            session.compact_summary = compact
        projection = ContextProjection(current_task=session.task)
        system_and_tools = "你是 MiniCode，一个本地优先的编码 Agent。"
        if tool_descriptions:
            system_and_tools += "\n\n## 可用工具\n" + "\n".join(tool_descriptions)
        projection.system_and_tools = self._fit_section("system_and_tools", system_and_tools, projection)
        projection.compact_summary = self._fit_section(
            "compact_summary",
            session.compact_summary or compact,
            projection,
        )
        meta_parts = [f"模式：{session.mode}", f"工作区：{session.workspace}"]
        if session.plan:
            meta_parts.append("## 计划\n" + "\n".join(f"- {step}" for step in session.plan[:8]))
        if session.active_files:
            meta_parts.append("## 活动文件\n" + "\n".join(session.active_files[-12:]))
        projection.plan_files_meta = self._fit_section(
            "plan_files_meta",
            "\n\n".join(meta_parts),
            projection,
        )
        if self.memory_service:
            memory = self.memory_service.retrieve(session.task, session.active_files)
            if memory:
                projection.memory = self._fit_section("memory", memory, projection)
        recent_messages = self._without_current_task(messages, session.task)
        if recent_messages:
            recent = "\n\n".join(
                f"{message.role}: {self.compactor.sensitive_filter.sanitize(message.content)}"
                for message in recent_messages
            )
            projection.recent_messages = self._fit_section("recent_messages", recent, projection)
        if include_tool_results and session.tool_calls:
            tool_history = "\n\n".join(self._tool_result_context(session))
            projection.tool_history = self._fit_section("tool_history", tool_history, projection)
        projection.usage["current_task"] = self.token_counter.count(session.task)
        projection.usage.setdefault("system_and_tools", 0)
        projection.usage.setdefault("recent_messages", 0)
        projection.usage.setdefault("tool_history", 0)
        projection.usage.setdefault("memory", 0)
        projection.usage.setdefault("compact_summary", 0)
        projection.usage.setdefault("plan_files_meta", 0)
        projection.usage["margin"] = 0
        return projection

    @staticmethod
    def _without_current_task(messages: list, current_task: str) -> list:
        result = list(messages)
        for index in range(len(result) - 1, -1, -1):
            message = result[index]
            if message.role == "user" and message.content == current_task:
                del result[index]
                break
        return result

    def _fit_section(self, name: str, text: str, projection: ContextProjection) -> str:
        if not text:
            projection.usage[name] = 0
            return ""
        limit = self.token_budget.partitions[name]
        actual = self.token_counter.count(text)
        if actual <= limit:
            projection.usage[name] = actual
            return text
        fitted = self._fit_prefix(text, limit)
        projection.usage[name] = self.token_counter.count(fitted)
        projection.dropped.append(f"{name}: {actual - projection.usage[name]} tokens")
        return fitted

    def _fit_prefix(self, text: str, limit: int) -> str:
        low = 0
        high = len(text)
        while low < high:
            middle = (low + high + 1) // 2
            if self.token_counter.count(text[:middle]) <= limit:
                low = middle
            else:
                high = middle - 1
        return text[:low]

    def _tool_result_context(self, session: SessionState) -> list[str]:
        entries: list[str] = []
        remaining = self.MAX_TOOL_CONTEXT_CHARS
        recent = [record for record in session.tool_calls[-8:] if record.result]
        latest_preview_assigned = False
        for record in reversed(recent):
            result = record.result
            if result is None:
                continue
            metadata = json.dumps(result.metadata, ensure_ascii=False, sort_keys=True)
            header = f"### {result.tool_name}\n{result.summary}\nMetadata: {metadata}"
            if result.artifact_ref:
                header += f"\nArtifact: {result.artifact_ref}"
            is_latest_substantive_result = bool(result.preview) and not latest_preview_assigned
            preview_limit = self.MAX_LATEST_TOOL_PREVIEW_CHARS if is_latest_substantive_result else self.MAX_OLDER_TOOL_PREVIEW_CHARS
            if result.preview:
                latest_preview_assigned = True
            available = max(remaining - len(header) - 10, 0)
            preview = self.compactor.sensitive_filter.sanitize(result.preview)
            preview = preview[:min(preview_limit, available)]
            entry = header + (f"\nOutput:\n{preview}" if preview else "")
            entries.append(entry)
            remaining = max(remaining - len(entry), 0)
        return list(reversed(entries))
