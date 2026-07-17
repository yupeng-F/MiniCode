from __future__ import annotations

from minicode.schemas.session import Message
from minicode.memory.sensitive_data_filter import SensitiveDataFilter


class CompactManager:
    def __init__(self, sensitive_filter: SensitiveDataFilter | None = None) -> None:
        self.sensitive_filter = sensitive_filter or SensitiveDataFilter()

    def compact_messages(self, messages: list[Message], keep_last: int = 12) -> tuple[str, list[Message]]:
        if len(messages) <= keep_last:
            return "", messages
        old = messages[:-keep_last]
        summary = "\n".join(f"{m.role}: {self.sensitive_filter.sanitize(m.content)[:160]}" for m in old)
        return f"Earlier conversation summary:\n{summary[:4000]}", messages[-keep_last:]
