from __future__ import annotations

import json
import math
import re
from typing import Protocol


class Tokenizer(Protocol):
    def encode(self, text: str) -> list[int]: ...


_CJK_PATTERN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")


class TokenCounter:
    """使用 tokenizer 与混合语言启发式中的较大值进行保守计数。"""

    def __init__(self, tokenizer: Tokenizer | None = None) -> None:
        self._tokenizer = tokenizer or self._load_default_tokenizer()

    def count(self, value: object) -> int:
        text = self._serialize(value)
        if not text:
            return 0
        tokenizer_count = self._tokenizer_count(text)
        heuristic_count = self._mixed_language_estimate(text)
        base_count = max(tokenizer_count, heuristic_count)
        return math.ceil(base_count * 110 / 100)

    @staticmethod
    def _serialize(value: object) -> str:
        if isinstance(value, str):
            return value
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )

    def _tokenizer_count(self, text: str) -> int:
        if self._tokenizer is None:
            return 0
        return len(self._tokenizer.encode(text))

    @staticmethod
    def _mixed_language_estimate(text: str) -> int:
        cjk_count = len(_CJK_PATTERN.findall(text))
        non_cjk_count = len(text) - cjk_count
        return cjk_count + math.ceil(non_cjk_count / 4)

    @staticmethod
    def _load_default_tokenizer() -> Tokenizer | None:
        try:
            import tiktoken

            return tiktoken.get_encoding("cl100k_base")
        except (ImportError, LookupError, OSError):
            return None
