from __future__ import annotations

import hashlib
import math
from typing import Sequence

from chromadb.api.types import EmbeddingFunction, Embeddings


class FastEmbeddingFunction(EmbeddingFunction[Sequence[str]]):
    """Lightweight embedding function that requires no model downloads.

    Uses a combination of word-level and character-level hash features
    to produce fixed-dimension embeddings. Suitable for development,
    testing, and resource-constrained environments.

    For production use, switch to ONNXMiniLM_L6_V2 or another
    full-text-embedding model via the ``embedding_function`` parameter
    of ``MemoryStore``.
    """

    def __init__(self, dimension: int = 384) -> None:
        self.dimension = dimension

    def get_config(self) -> dict:
        return {"dimension": self.dimension}

    def name(self) -> str:
        return "FastEmbeddingFunction"

    def __call__(self, input: Sequence[str]) -> Embeddings:
        return [self._embed(text) for text in input]

    def _embed(self, text: str) -> list[float]:
        vec = [0.0] * self.dimension

        tokens = text.lower().split()
        if not tokens:
            return vec

        # 1) word-level hash features
        for token in tokens:
            h = hashlib.md5(token.encode())  # noqa: S324
            pos = int(h.hexdigest()[:8], 16) % self.dimension
            vec[pos] += 1.0

        # 2) char-bigram features for subword signal
        for i in range(len(text) - 1):
            bigram = text[i : i + 2]
            h = hashlib.md5(bigram.encode())  # noqa: S324
            pos = int(h.hexdigest()[:8], 16) % self.dimension
            vec[pos] += 0.5

        # L2 normalise
        norm = math.sqrt(sum(v * v for v in vec))
        if norm > 1e-8:
            vec = [v / norm for v in vec]
        return vec
