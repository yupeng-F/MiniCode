from __future__ import annotations

import fnmatch
import math
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol, Sequence

class Counter(Protocol):
    def count(self, value: object) -> int: ...


@dataclass(frozen=True, slots=True)
class RankedMemory:
    memory_id: str
    project_id: str
    content: str
    tier: str
    paths: tuple[str, ...]
    created_at: datetime
    last_used_at: datetime | None
    use_count: int
    pinned: bool = False


@dataclass(frozen=True, slots=True)
class MemoryRetrievalItem:
    memory_id: str
    project_id: str
    content: str
    tier: str
    vector_score: float
    keyword_score: float
    path_score: float
    recency_score: float
    usefulness_score: float
    final_score: float


@dataclass(frozen=True, slots=True)
class MemoryRetrievalResult:
    items: tuple[MemoryRetrievalItem, ...]
    provider: str
    fallback_reason: str
    external_transfer: bool
    token_count: int

    @property
    def rendered(self) -> str:
        return "\n".join(f"- {item.content}" for item in self.items)


class HybridRetriever:
    """融合向量、关键词、路径、时间和使用频率的项目记忆排序器。"""

    def __init__(self, *, token_counter: Counter | None = None, rrf_constant: int = 60) -> None:
        if token_counter is None:
            from minicode.context.token_counter import TokenCounter

            token_counter = TokenCounter()
        self.token_counter = token_counter
        self.rrf_constant = rrf_constant

    def retrieve(
        self,
        records: Sequence[RankedMemory],
        *,
        keyword_ids: Sequence[str],
        vector_ids: Sequence[str],
        active_files: Sequence[str],
        provider: str,
        fallback_reason: str = "",
        external_transfer: bool = False,
        now: datetime | None = None,
        max_tokens: int = 4_000,
        max_item_tokens: int = 1_000,
        limit: int = 8,
    ) -> MemoryRetrievalResult:
        selected_now = now or datetime.now(UTC)
        keyword_ranks = {memory_id: rank for rank, memory_id in enumerate(keyword_ids[:30], start=1)}
        vector_ranks = {memory_id: rank for rank, memory_id in enumerate(vector_ids[:30], start=1)}
        ranked: list[MemoryRetrievalItem] = []
        for record in records:
            vector_score = self._reciprocal_rank(vector_ranks.get(record.memory_id))
            keyword_score = self._reciprocal_rank(keyword_ranks.get(record.memory_id))
            if not vector_score and not keyword_score:
                continue
            path_score = self._path_score(record.paths, active_files)
            recency_score = self._recency_score(record, selected_now)
            usefulness_score = max(0.0, record.use_count / (record.use_count + 5))
            final_score = (
                0.45 * vector_score
                + 0.30 * keyword_score
                + 0.10 * path_score
                + 0.10 * recency_score
                + 0.05 * usefulness_score
            )
            ranked.append(
                MemoryRetrievalItem(
                    memory_id=record.memory_id,
                    project_id=record.project_id,
                    content=record.content,
                    tier=record.tier,
                    vector_score=vector_score,
                    keyword_score=keyword_score,
                    path_score=path_score,
                    recency_score=recency_score,
                    usefulness_score=usefulness_score,
                    final_score=final_score,
                )
            )
        ranked.sort(key=lambda item: (-item.final_score, item.memory_id))

        included: list[MemoryRetrievalItem] = []
        token_count = 0
        for item in ranked:
            if len(included) >= limit or token_count >= max_tokens:
                break
            available = min(max_item_tokens, max_tokens - token_count)
            content = self._fit_content(item.content, available)
            content_tokens = self.token_counter.count(content)
            if not content or content_tokens <= 0:
                continue
            included.append(
                MemoryRetrievalItem(
                    memory_id=item.memory_id,
                    project_id=item.project_id,
                    content=content,
                    tier=item.tier,
                    vector_score=item.vector_score,
                    keyword_score=item.keyword_score,
                    path_score=item.path_score,
                    recency_score=item.recency_score,
                    usefulness_score=item.usefulness_score,
                    final_score=item.final_score,
                )
            )
            token_count += content_tokens
        return MemoryRetrievalResult(
            items=tuple(included),
            provider=provider,
            fallback_reason=fallback_reason,
            external_transfer=external_transfer,
            token_count=token_count,
        )

    def _reciprocal_rank(self, rank: int | None) -> float:
        if rank is None:
            return 0.0
        return (self.rrf_constant + 1) / (self.rrf_constant + rank)

    @staticmethod
    def _path_score(patterns: Sequence[str], active_files: Sequence[str]) -> float:
        if not patterns:
            return 0.5
        if any(fnmatch.fnmatch(path, pattern) for path in active_files for pattern in patterns):
            return 1.0
        return 0.0

    @staticmethod
    def _recency_score(record: RankedMemory, now: datetime) -> float:
        if record.tier == "long" or record.pinned:
            return 1.0
        reference = record.last_used_at or record.created_at
        if reference.tzinfo is None:
            reference = reference.replace(tzinfo=UTC)
        age_days = max(0.0, (now - reference).total_seconds() / 86_400)
        return math.exp(-age_days / 30)

    def _fit_content(self, content: str, max_tokens: int) -> str:
        if self.token_counter.count(content) <= max_tokens:
            return content
        low, high = 0, len(content)
        while low < high:
            middle = (low + high + 1) // 2
            if self.token_counter.count(content[:middle]) <= max_tokens:
                low = middle
            else:
                high = middle - 1
        return content[:low]
