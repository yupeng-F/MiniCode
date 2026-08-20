from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from minicode.memory.embedding import EmbeddingIdentity


class VectorDimensionMismatch(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class VectorMemory:
    memory_id: str
    project_id: str
    content_hash: str
    vector: list[float]


@dataclass(frozen=True, slots=True)
class VectorHit:
    memory_id: str
    distance: float


class VectorStore:
    """按 provider、模型和维度隔离的可重建 Chroma 向量索引。"""

    def __init__(self, path: Path | str, *, client: Any | None = None) -> None:
        self.path = Path(path)
        if client is None:
            import chromadb

            self.path.mkdir(parents=True, exist_ok=True)
            client = chromadb.PersistentClient(path=str(self.path))
        self.client = client

    @staticmethod
    def collection_name(identity: EmbeddingIdentity) -> str:
        raw = f"memory_{identity.provider}_{identity.model}_d{identity.dimension}".casefold()
        safe = re.sub(r"[^a-z0-9_-]+", "_", raw).strip("_-")
        if len(safe) > 63:
            digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:10]
            safe = f"{safe[:52].rstrip('_-')}_{digest}"
        return safe

    def upsert(self, identity: EmbeddingIdentity, records: Sequence[VectorMemory]) -> None:
        values = list(records)
        if not values:
            return
        for record in values:
            if len(record.vector) != identity.dimension:
                raise VectorDimensionMismatch(
                    f"向量维度错误：集合要求 {identity.dimension}，实际 {len(record.vector)}"
                )
        collection = self._collection(identity)
        collection.upsert(
            ids=[record.memory_id for record in values],
            embeddings=[record.vector for record in values],
            metadatas=[
                {
                    "project_id": record.project_id,
                    "content_hash": record.content_hash,
                    "provider": identity.provider,
                    "model": identity.model,
                    "dimension": identity.dimension,
                }
                for record in values
            ],
        )

    def query(
        self,
        identity: EmbeddingIdentity,
        project_id: str,
        vector: list[float],
        *,
        limit: int = 30,
    ) -> list[VectorHit]:
        if len(vector) != identity.dimension:
            raise VectorDimensionMismatch(
                f"查询向量维度错误：集合要求 {identity.dimension}，实际 {len(vector)}"
            )
        collection = self._collection(identity)
        response = collection.query(
            query_embeddings=[vector],
            n_results=min(limit, 30),
            where={"project_id": project_id},
            include=["distances"],
        )
        ids = (response.get("ids") or [[]])[0]
        distances = (response.get("distances") or [[]])[0]
        return [VectorHit(str(memory_id), float(distance)) for memory_id, distance in zip(ids, distances)]

    def content_hashes(self, identity: EmbeddingIdentity, project_id: str) -> dict[str, str]:
        """读取当前项目已索引正文哈希，供幂等增量重建使用。"""

        collection = self._collection(identity)
        response = collection.get(where={"project_id": project_id}, include=["metadatas"])
        ids = response.get("ids") or []
        metadatas = response.get("metadatas") or []
        return {
            str(memory_id): str(metadata.get("content_hash", ""))
            for memory_id, metadata in zip(ids, metadatas)
            if metadata
        }

    def delete(self, identity: EmbeddingIdentity, memory_ids: Sequence[str]) -> None:
        values = list(memory_ids)
        if values:
            self._collection(identity).delete(ids=values)

    def _collection(self, identity: EmbeddingIdentity) -> Any:
        metadata = {
            "hnsw:space": "cosine",
            "provider": identity.provider,
            "model": identity.model,
            "dimension": identity.dimension,
        }
        collection = self.client.get_or_create_collection(
            name=self.collection_name(identity),
            metadata=metadata,
        )
        actual_dimension = (collection.metadata or {}).get("dimension")
        if actual_dimension is not None and int(actual_dimension) != identity.dimension:
            raise VectorDimensionMismatch(
                f"Chroma 集合维度冲突：期望 {identity.dimension}，实际 {actual_dimension}"
            )
        return collection
