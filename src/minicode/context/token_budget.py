from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


from minicode.context.token_counter import TokenCounter


class Counter(Protocol):
    def count(self, value: object) -> int: ...


class TokenLimitExceeded(ValueError):
    """Token 数超过已配置的硬限制。"""

    def __init__(self, *, limit: int, actual: int, message: str) -> None:
        super().__init__(message)
        self.limit = limit
        self.actual = actual


class UserMessageTooLarge(TokenLimitExceeded):
    def __init__(self, *, limit: int, actual: int) -> None:
        super().__init__(
            limit=limit,
            actual=actual,
            message=f"用户消息超过 Token 上限：实际 {actual}，上限 {limit}",
        )


class ContextBudgetExceeded(TokenLimitExceeded):
    def __init__(self, *, limit: int, actual: int) -> None:
        super().__init__(
            limit=limit,
            actual=actual,
            message=f"模型输入超过 Token 上限：实际 {actual}，上限 {limit}",
        )


@dataclass(frozen=True)
class TokenBudget:
    """MiniCode 模型调用的统一硬限制与分区预算。"""

    max_input_tokens: int = 48_000
    max_output_tokens: int = 8_000
    safety_reserve_tokens: int = 8_000
    max_user_message_tokens: int = 12_000

    @property
    def max_tokens(self) -> int:
        """保留旧调用方读取 `max_tokens` 的兼容入口。"""

        return self.max_input_tokens

    @property
    def partitions(self) -> dict[str, int]:
        return {
            "system_and_tools": 8_000,
            "current_task": 12_000,
            "recent_messages": 8_000,
            "tool_history": 10_000,
            "memory": 4_000,
            "compact_summary": 3_000,
            "plan_files_meta": 2_000,
            "margin": 1_000,
        }

    @staticmethod
    def estimate(text: str) -> int:
        return TokenCounter().count(text)

    def fits(self, text: str) -> bool:
        return self.estimate(text) <= self.max_input_tokens

    def validate_user_message(self, message: str, *, counter: Counter | None = None) -> int:
        actual = (counter or TokenCounter()).count(message)
        if actual > self.max_user_message_tokens:
            raise UserMessageTooLarge(limit=self.max_user_message_tokens, actual=actual)
        return actual

    def validate_input(self, payload: object, *, counter: Counter | None = None) -> int:
        actual = (counter or TokenCounter()).count(payload)
        if actual > self.max_input_tokens:
            raise ContextBudgetExceeded(limit=self.max_input_tokens, actual=actual)
        return actual
