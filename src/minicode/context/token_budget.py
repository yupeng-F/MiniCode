from __future__ import annotations


class TokenBudget:
    """Approximate token budget manager.

    Qwen/OpenAI tokenizers differ; character-based estimation keeps this dependency-light.
    """

    def __init__(self, max_tokens: int = 24_000) -> None:
        self.max_tokens = max_tokens

    @staticmethod
    def estimate(text: str) -> int:
        return max(1, len(text) // 4)

    def fits(self, text: str) -> bool:
        return self.estimate(text) <= self.max_tokens
