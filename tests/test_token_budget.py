from __future__ import annotations

import pytest

from minicode.context.token_budget import (
    ContextBudgetExceeded,
    TokenBudget,
    UserMessageTooLarge,
)
from minicode.context.token_counter import TokenCounter


class FixedTokenizer:
    def __init__(self, token_count: int) -> None:
        self.token_count = token_count

    def encode(self, text: str) -> list[int]:
        return list(range(self.token_count))


class FixedCounter:
    def __init__(self, token_count: int) -> None:
        self.token_count = token_count

    def count(self, value: object) -> int:
        return self.token_count


def test_token_counter_chooses_larger_estimate_and_adds_safety_margin() -> None:
    counter = TokenCounter(tokenizer=FixedTokenizer(100))

    assert counter.count("混合中文 and code") == 110


def test_token_counter_serializes_structured_model_input() -> None:
    counter = TokenCounter(tokenizer=FixedTokenizer(4))

    counted = counter.count({"messages": [{"role": "user", "content": "读取 README"}]})

    assert counted > 4


def test_token_budget_rejects_user_message_above_hard_limit() -> None:
    budget = TokenBudget()

    with pytest.raises(UserMessageTooLarge) as error:
        budget.validate_user_message("很长的消息", counter=FixedCounter(12_001))

    assert error.value.limit == 12_000
    assert error.value.actual == 12_001


def test_token_budget_accepts_user_message_at_hard_limit() -> None:
    budget = TokenBudget()

    assert budget.validate_user_message("边界消息", counter=FixedCounter(12_000)) == 12_000


def test_token_budget_partitions_cover_complete_input_budget() -> None:
    budget = TokenBudget()

    assert budget.partitions == {
        "system_and_tools": 8_000,
        "current_task": 12_000,
        "recent_messages": 8_000,
        "tool_history": 10_000,
        "memory": 4_000,
        "compact_summary": 3_000,
        "plan_files_meta": 2_000,
        "margin": 1_000,
    }
    assert sum(budget.partitions.values()) == budget.max_input_tokens == 48_000


def test_token_budget_checks_complete_request_size() -> None:
    budget = TokenBudget()

    assert budget.validate_input({"messages": []}, counter=FixedCounter(48_000)) == 48_000

    with pytest.raises(ContextBudgetExceeded):
        budget.validate_input({"messages": []}, counter=FixedCounter(48_001))
