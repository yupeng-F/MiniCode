from __future__ import annotations

import hashlib
import os
from datetime import datetime, timezone
from uuid import uuid4
from typing import cast

import chromadb
from chromadb.api.types import EmbeddingFunction
from chromadb.config import Settings

from multi_agents.memory.embedding import FastEmbeddingFunction
from multi_agents.schemas.memory import MemoryEntry

# 支持的记忆类型，每种对应 ChromaDB 中的一个独立 Collection
MEMORY_TYPES = ["task_experience", "repo_convention", "user_profile", "failure_case"]

# 每个 Collection 的最大条目数，超过时淘汰最旧的
MAX_ENTRIES_PER_TYPE = 200

# 默认持久化路径
DEFAULT_PERSIST_DIR = os.path.join(".claude", "memory", "chromadb")


class MemoryStore:
    """ChromaDB 持久化的长期记忆存储。

    按 memory_type 拆分为 4 个独立 Collection：
    - task_experience: 任务经验总结
    - repo_convention: 仓库约定规范
    - user_profile: 用户偏好
    - failure_case: 失败案例

    每个 Collection 的 document = MemoryEntry.content（自动向量化）
    metadata 存储 memory_id, title, scope, source_run_id, tags, created_at
    """

    def __init__(
        self,
        persist_dir: str = DEFAULT_PERSIST_DIR,
        embedding_function: EmbeddingFunction | None = None,
    ) -> None:
        os.makedirs(persist_dir, exist_ok=True)
        self.client = chromadb.PersistentClient(
            path=persist_dir,
            settings=Settings(anonymized_telemetry=False),
        )
        self._collections: dict[str, chromadb.Collection] = {}
        self._embedding_function = embedding_function or cast(
            EmbeddingFunction, FastEmbeddingFunction()
        )

    def _get_collection(self, memory_type: str) -> chromadb.Collection:
        if memory_type not in MEMORY_TYPES:
            raise ValueError(f"Invalid memory_type: {memory_type}. Must be one of {MEMORY_TYPES}")
        if memory_type not in self._collections:
            self._collections[memory_type] = self.client.get_or_create_collection(
                name=memory_type,
                metadata={"hnsw:space": "cosine"},
                embedding_function=self._embedding_function,
            )
        return self._collections[memory_type]

    def add(self, entry: MemoryEntry) -> str:
        """写入一条记忆到对应的 Collection。自动去重。"""
        collection = self._get_collection(entry.memory_type)

        # 去重：计算 content hash 并检查是否已存在
        content_hash = hashlib.md5(entry.content.encode()).hexdigest()[:16]
        existing = collection.get(where={"content_hash": content_hash})
        if existing and existing["ids"]:
            # 已存在相同内容的记忆，跳过写入但返回已有 memory_id
            return existing["ids"][0]

        metadata = {
            "memory_id": entry.memory_id,
            "title": entry.title,
            "scope": entry.scope,
            "source_run_id": entry.source_run_id,
            "created_at": entry.created_at or datetime.now(timezone.utc).isoformat(),
            "tags": ",".join(entry.tags or []),
            "content_hash": content_hash,
        }
        collection.add(
            documents=[entry.content],
            metadatas=[metadata],
            ids=[entry.memory_id],
        )

        # 写入后清理：超出上限时淘汰最旧的
        self._cleanup_if_needed(entry.memory_type)

        return entry.memory_id

    def query(
        self,
        query_text: str,
        memory_type: str,
        n_results: int = 5,
    ) -> list[MemoryEntry]:
        """检索某个类型中最相关的记忆条目。"""
        collection = self._get_collection(memory_type)
        results = collection.query(
            query_texts=[query_text],
            n_results=min(n_results, 50),
        )

        entries: list[MemoryEntry] = []
        if not results["ids"] or not results["ids"][0]:
            return entries

        for i in range(len(results["ids"][0])):
            meta = results["metadatas"][0][i] if results["metadatas"] else {}
            entries.append(MemoryEntry(
                memory_id=results["ids"][0][i],
                memory_type=memory_type,
                title=meta.get("title", ""),
                content=results["documents"][0][i] if results["documents"] else "",
                scope=meta.get("scope", "repo"),
                source_run_id=meta.get("source_run_id", ""),
                tags=meta.get("tags", "").split(",") if meta.get("tags") else [],
                created_at=meta.get("created_at", ""),
            ))
        return entries

    def query_all_types(self, query_text: str, n_per_type: int = 3) -> list[MemoryEntry]:
        """跨所有类型检索，各类型返回 Top-K 后合并。"""
        all_entries: list[MemoryEntry] = []
        for mtype in MEMORY_TYPES:
            try:
                entries = self.query(query_text, mtype, n_results=n_per_type)
                all_entries.extend(entries)
            except Exception:
                continue
        return all_entries

    def delete(self, memory_id: str, memory_type: str) -> None:
        """删除一条记忆。"""
        collection = self._get_collection(memory_type)
        collection.delete(ids=[memory_id])

    def count(self, memory_type: str) -> int:
        """统计某个类型中的记忆条目数。"""
        collection = self._get_collection(memory_type)
        return collection.count()

    def _cleanup_if_needed(self, memory_type: str) -> None:
        """超出上限时淘汰最旧的记忆条目。"""
        collection = self._get_collection(memory_type)
        current = collection.count()
        if current <= MAX_ENTRIES_PER_TYPE:
            return

        # 获取所有条目按创建时间排序
        all_data = collection.get(include=["metadatas"])
        if not all_data["ids"]:
            return

        # 按 created_at 排序，保留最新的 MAX_ENTRIES_PER_TYPE 条
        indexed = list(zip(all_data["ids"], all_data["metadatas"]))
        indexed.sort(key=lambda x: x[1].get("created_at", "") if x[1] else "")
        to_delete = [item[0] for item in indexed[:-MAX_ENTRIES_PER_TYPE]]
        if to_delete:
            collection.delete(ids=to_delete)

    def cleanup(self, memory_type: str | None = None) -> dict[str, int]:
        """主动清理：对指定类型（或全部）执行淘汰。返回{类型: 删除数}。"""
        result: dict[str, int] = {}
        types = [memory_type] if memory_type else MEMORY_TYPES
        for mtype in types:
            before = self.count(mtype)
            self._cleanup_if_needed(mtype)
            after = self.count(mtype)
            result[mtype] = before - after
        return result

    @staticmethod
    def make_entry(
        memory_type: str,
        content: str,
        title: str = "",
        scope: str = "repo",
        source_run_id: str = "",
        tags: list[str] | None = None,
    ) -> MemoryEntry:
        """便捷方法：创建一条带默认值的 MemoryEntry。"""
        return MemoryEntry(
            memory_id=str(uuid4())[:8],
            memory_type=memory_type,
            title=title,
            content=content,
            scope=scope,
            confidence=0.7,
            source_run_id=source_run_id,
            tags=tags or [],
            created_at=datetime.now(timezone.utc).isoformat(),
        )
