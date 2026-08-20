from __future__ import annotations

import fnmatch
import hashlib
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from time import perf_counter
from typing import Any

from minicode.memory.embedding import EmbeddingRouter
from minicode.memory.hybrid_retriever import HybridRetriever, MemoryRetrievalResult, RankedMemory
from minicode.memory.markdown_memory import MarkdownMemory
from minicode.memory.memory_index import KeywordMemory, MediumMemory, MemoryIndex
from minicode.memory.sensitive_data_filter import SensitiveDataFilter
from minicode.memory.vector_store import VectorMemory, VectorStore


class MemoryService:
    """项目本地 Markdown 记忆，以及有界、路径感知的检索。"""

    def __init__(
        self,
        root: str | Path,
        *,
        embedding_router: EmbeddingRouter | Any | None = None,
        vector_store: VectorStore | Any | None = None,
        hybrid_retriever: HybridRetriever | None = None,
    ) -> None:
        self.store = MarkdownMemory(root)
        self.filter = SensitiveDataFilter()
        project_source = str(self.store.root.parent.resolve())
        self.project_id = hashlib.sha256(project_source.encode("utf-8")).hexdigest()[:16]
        self.keyword_index = MemoryIndex(self.store.root / "memory_index.db", self.project_id)
        self.embedding_router = embedding_router
        self.vector_store = vector_store
        self.hybrid_retriever = hybrid_retriever or HybridRetriever()
        self._rebuild_keyword_index()

    def index(self) -> str:
        return self.filter.sanitize(self.store.read_index())

    def store_rule(
        self,
        name: str,
        content: str,
        paths: list[str] | None = None,
        source: str = "verified_tool",
    ) -> bool:
        if self.filter.contains_sensitive(content):
            return False
        frontmatter = ["---", f"name: {name}", "status: enabled", f"source: {source}"]
        if paths:
            frontmatter.append("paths: " + ", ".join(paths))
        frontmatter.extend(["---", "", content.strip(), ""])
        self.store.add("rules", name, "\n".join(frontmatter))
        self._rebuild_keyword_index()
        return True

    def propose_candidate(self, name: str, content: str, paths: list[str] | None = None, source: str = "agent") -> str | None:
        """Persist a reviewable candidate, returning its stable id.

        Content hashes make repeated automatic capture idempotent.
        """
        if self.filter.contains_sensitive(content) or not content.strip():
            return None
        candidate_id = hashlib.sha256(content.strip().encode("utf-8")).hexdigest()[:16]
        existing = next((item for item in self.list_memories("enabled") if _normalize(item.content) == _normalize(content)), None)
        if existing:
            return existing.id
        path = self.store.root / "candidates" / f"{candidate_id}.md"
        if path.exists():
            return candidate_id
        metadata = {"id": candidate_id, "name": name, "status": "candidate", "source": source}
        if paths:
            metadata["paths"] = ", ".join(paths)
        self._write("candidates", candidate_id, metadata, content)
        return candidate_id

    def list_memories(self, status: str | None = None) -> list["MemoryRecord"]:
        records: list[MemoryRecord] = []
        for category in ("rules", "candidates"):
            directory = self.store.root / category
            for path in sorted(directory.glob("*.md")) if directory.exists() else []:
                metadata, content = _parse_memory_file(path.read_text(encoding="utf-8"))
                record = MemoryRecord(path.stem, metadata.get("name", path.stem), metadata.get("status", "enabled"), content.strip(), category, metadata)
                if status is None or record.status == status:
                    records.append(record)
        for item in self.keyword_index.list_medium():
            metadata = {
                "name": item.task,
                "status": "enabled",
                "run_status": item.status,
                "tier": "medium",
                "kind": "summary",
                "paths": item.active_files,
                "created_at": item.created_at,
                "last_used_at": item.last_used_at,
                "use_count": str(item.use_count),
                "pinned": str(item.pinned).lower(),
                "source": "run_summary",
            }
            record = MemoryRecord(item.memory_id, item.task, "enabled", item.content, "summaries", metadata)
            if status is None or record.status == status:
                records.append(record)
        return records

    def get_memory(self, memory_id: str) -> "MemoryRecord | None":
        return next((item for item in self.list_memories() if item.id == memory_id), None)

    def promote_candidate(self, candidate_id: str, *, replace_conflicts: bool = False) -> str:
        candidate = self.get_memory(candidate_id)
        if candidate is None or candidate.category != "candidates":
            raise KeyError(candidate_id)
        normalized = _normalize(candidate.content)
        enabled = self.list_memories("enabled")
        duplicate = next((item for item in enabled if _normalize(item.content) == normalized), None)
        if duplicate:
            (self.store.root / "candidates" / f"{candidate_id}.md").unlink(missing_ok=True)
            self._rebuild_index()
            return duplicate.id
        conflicts = [item for item in enabled if item.name == candidate.name and _normalize(item.content) != normalized]
        if conflicts and not replace_conflicts:
            raise MemoryConflictError(candidate_id, [item.id for item in conflicts])
        rule_id = candidate.id
        for conflict in conflicts:
            self.disable_memory(conflict.id, superseded_by=rule_id)
        metadata = dict(candidate.metadata)
        metadata["status"] = "enabled"
        metadata["promoted_from"] = candidate_id
        self._write("rules", rule_id, metadata, candidate.content)
        (self.store.root / "candidates" / f"{candidate_id}.md").unlink(missing_ok=True)
        self._rebuild_index()
        return rule_id

    def update_memory(self, memory_id: str, *, content: str | None = None, name: str | None = None, paths: list[str] | None = None) -> bool:
        record = self.get_memory(memory_id)
        if record is None:
            return False
        new_content = content if content is not None else record.content
        if self.filter.contains_sensitive(new_content) or not new_content.strip():
            return False
        metadata = dict(record.metadata)
        if name is not None:
            metadata["name"] = name
        if paths is not None:
            metadata["paths"] = ", ".join(paths)
        self._write(record.category, record.id, metadata, new_content)
        return True

    def disable_memory(self, memory_id: str, *, superseded_by: str | None = None) -> bool:
        record = self.get_memory(memory_id)
        if record is None:
            return False
        metadata = dict(record.metadata)
        metadata["status"] = "disabled"
        if superseded_by:
            metadata["superseded_by"] = superseded_by
        self._write(record.category, record.id, metadata, record.content)
        return True

    def delete_memory(self, memory_id: str) -> bool:
        record = self.get_memory(memory_id)
        if record is None:
            return False
        if record.category == "summaries":
            self.keyword_index.delete_medium([record.id])
        else:
            (self.store.root / record.category / f"{record.id}.md").unlink(missing_ok=True)
        self._rebuild_index()
        return True

    def store_run_summary(
        self,
        session: Any,
        *,
        created_at: datetime | None = None,
        pinned: bool = False,
    ) -> bool:
        """把终态 Run 压缩为项目内中期记忆，不保存大段原始工具输出。"""

        if session.status not in {"completed", "failed", "cancelled"}:
            return False
        timestamp = created_at or datetime.now(UTC)
        active_files = list(dict.fromkeys(session.active_files))[:50]
        tool_conclusions: list[str] = []
        for record in session.tool_calls[-20:]:
            if record.result is None:
                continue
            summary = self.filter.sanitize(record.result.summary).strip()[:300]
            if summary:
                tool_conclusions.append(f"- {record.tool_name}: {summary}")
        final_answer = self.filter.sanitize(session.final_answer).strip()[:1_000]
        task = self.filter.sanitize(session.task).strip()[:500]
        lines = [
            f"任务：{task}",
            f"状态：{session.status}",
            f"结果：{final_answer or '未生成最终答复'}",
            f"重要文件：{', '.join(active_files) if active_files else '无'}",
        ]
        if tool_conclusions:
            lines.extend(["工具结论：", *tool_conclusions])
        content = "\n".join(lines)
        self.keyword_index.upsert_medium(
            MediumMemory(
                memory_id=session.run_id,
                task=task or session.run_id,
                status=session.status,
                content=content,
                active_files=", ".join(active_files),
                created_at=timestamp.isoformat(),
                last_used_at=timestamp.isoformat(),
                pinned=pinned,
            )
        )
        self._rebuild_keyword_index()
        return True

    def enforce_retention(
        self,
        *,
        now: datetime | None = None,
        max_items: int = 200,
        max_age_days: int = 30,
    ) -> list[str]:
        """淘汰过期或低价值中期记忆，用户固定的记录不参与自动删除。"""

        selected_now = now or datetime.now(UTC)
        records = self.keyword_index.list_medium()
        removed: set[str] = set()
        eligible: list[tuple[float, MediumMemory]] = []
        for record in records:
            if record.pinned:
                continue
            created_at = _parse_datetime(record.created_at) or selected_now
            age_days = max(0.0, (selected_now - created_at).total_seconds() / 86_400)
            if age_days > max_age_days:
                removed.add(record.memory_id)
                continue
            last_used = _parse_datetime(record.last_used_at) or created_at
            recency = max(0.0, 1 - (selected_now - last_used).total_seconds() / (max_age_days * 86_400))
            usefulness = record.use_count / (record.use_count + 5)
            eligible.append((0.7 * recency + 0.3 * usefulness, record))
        eligible.sort(key=lambda value: (-value[0], value[1].memory_id))
        removed.update(record.memory_id for _, record in eligible[max_items:])
        removed_ids = sorted(removed)
        self.keyword_index.delete_medium(removed_ids)
        if removed_ids:
            self._rebuild_keyword_index()
        return removed_ids

    def _write(self, category: str, memory_id: str, metadata: dict[str, str], content: str) -> None:
        header = ["---", *[f"{key}: {value}" for key, value in metadata.items()], "---", "", content.strip(), ""]
        self.store.add(category, memory_id, "\n".join(header))
        self._rebuild_keyword_index()

    def _rebuild_index(self) -> None:
        lines = ["# Memory Index", ""]
        for category in ("rules", "candidates"):
            directory = self.store.root / category
            if directory.exists():
                lines.extend(f"- [{category}/{path.stem}](./{category}/{path.name})" for path in sorted(directory.glob("*.md")))
        self.store.index_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        self._rebuild_keyword_index()

    def _rebuild_keyword_index(self) -> None:
        records = [
            KeywordMemory(
                memory_id=item.id,
                document=" ".join([
                    item.name,
                    item.content,
                    item.metadata.get("paths", ""),
                    item.metadata.get("source", ""),
                ]),
            )
            for item in self.list_memories("enabled")
            if item.category in {"rules", "summaries"}
            and not self.filter.contains_sensitive(item.content)
        ]
        self.keyword_index.rebuild(records)

    def retrieve(
        self,
        task: str,
        active_files: list[str],
        mode: str = "act",
        max_chars: int = 3_000,
    ) -> str:
        rendered = self.retrieve_result(task, active_files, mode=mode).rendered
        if len(rendered) <= max_chars:
            return rendered
        lines: list[str] = []
        used = 0
        for line in rendered.splitlines():
            if used + len(line) > max_chars:
                break
            lines.append(line)
            used += len(line)
        return "\n".join(lines)

    def retrieve_result(
        self,
        task: str,
        active_files: list[str],
        mode: str = "act",
        max_tokens: int = 4_000,
    ) -> MemoryRetrievalResult:
        """返回带 Provider、降级原因和分项得分的混合检索结果。"""

        started_at = perf_counter()
        query = " ".join([task, mode, *active_files])
        records = {
            item.id: item
            for item in self.list_memories("enabled")
            if item.category in {"rules", "summaries"}
            and _matches_paths(item.metadata.get("paths", ""), active_files)
            and not self.filter.contains_sensitive(item.content)
        }
        keyword_ids = [
            memory_id
            for memory_id in self.keyword_index.search(query, limit=30)
            if memory_id in records
        ]
        vector_ids: list[str] = []
        provider = "fts5"
        fallback_reason = ""
        external_transfer = False
        if self.embedding_router is not None and records:
            try:
                embedding = self.embedding_router.embed_query(query)
                provider = embedding.identity.provider
                external_transfer = embedding.identity.external_transfer
                fallback_reason = embedding.fallback_reason
                vector_ids = self._retrieve_vector_ids(embedding, records)
            except Exception as exc:
                safe_error = self.filter.sanitize(str(exc))
                fallback_reason = safe_error or "embedding 检索不可用"
                provider = "fts5"

        ranked_records = [self._as_ranked_memory(record) for record in records.values()]
        result = self.hybrid_retriever.retrieve(
            ranked_records,
            keyword_ids=keyword_ids,
            vector_ids=vector_ids,
            active_files=active_files,
            provider=provider,
            fallback_reason=fallback_reason,
            external_transfer=external_transfer,
            max_tokens=max_tokens,
        )
        medium_ids = [item.memory_id for item in result.items if item.tier == "medium"]
        self.keyword_index.touch_medium(medium_ids, datetime.now(UTC).isoformat())
        return replace(result, elapsed_ms=round((perf_counter() - started_at) * 1_000, 3))

    def _retrieve_vector_ids(self, embedding: Any, records: dict[str, "MemoryRecord"]) -> list[str]:
        if self.vector_store is None:
            self.vector_store = VectorStore(self.store.root / "chroma")
        hashes = self.vector_store.content_hashes(embedding.identity, self.project_id)
        pending: list[tuple[MemoryRecord, str]] = []
        for record in records.values():
            content_hash = hashlib.sha256(record.content.encode("utf-8")).hexdigest()
            if hashes.get(record.id) != content_hash:
                pending.append((record, content_hash))
        if embedding.identity.external_transfer:
            pending = [
                (record, content_hash)
                for record, content_hash in pending
                if not self.filter.contains_sensitive(record.content)
            ]
        if pending:
            vectors = self.embedding_router.embed_documents(
                embedding.identity,
                [record.content for record, _ in pending],
            )
            self.vector_store.upsert(
                embedding.identity,
                [
                    VectorMemory(record.id, self.project_id, content_hash, vector)
                    for (record, content_hash), vector in zip(pending, vectors)
                ],
            )
        return [
            hit.memory_id
            for hit in self.vector_store.query(
                embedding.identity,
                self.project_id,
                embedding.vector,
                limit=30,
            )
            if hit.memory_id in records
        ]

    def _as_ranked_memory(self, record: "MemoryRecord") -> RankedMemory:
        created_at = _parse_datetime(record.metadata.get("created_at")) or datetime.now(UTC)
        last_used_at = _parse_datetime(
            record.metadata.get("last_used_at") or record.metadata.get("last_accessed_at")
        )
        paths = tuple(value.strip() for value in record.metadata.get("paths", "").split(",") if value.strip())
        return RankedMemory(
            memory_id=record.id,
            project_id=self.project_id,
            content=self.filter.sanitize(record.content).strip(),
            tier=record.metadata.get("tier", "long"),
            paths=paths,
            created_at=created_at,
            last_used_at=last_used_at,
            use_count=int(record.metadata.get("use_count", record.metadata.get("access_count", "0")) or 0),
            pinned=record.metadata.get("pinned", "false").casefold() == "true",
        )

    def capture_verified_test_command(self, command: str) -> bool:
        command = command.strip()
        if not command:
            return False
        suffix = hashlib.sha256(command.encode("utf-8")).hexdigest()[:10]
        return self.store_rule(
            name=f"verified-test-command-{suffix}",
            content=f"Verified project test command: `{command}`",
            source="verified_tool",
        )

    def capture_user_instruction(self, content: str) -> bool:
        markers = ("must", "always", "never", "禁止", "必须", "始终")
        if not any(marker in content.lower() for marker in markers):
            return False
        suffix = hashlib.sha256(content.encode("utf-8")).hexdigest()[:10]
        return self.propose_candidate(
            name=f"user-instruction-{suffix}",
            content=content,
            source="user_instruction",
        ) is not None


def _parse_memory_file(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---\n"):
        return {}, text
    _, header, content = text.split("---\n", 2)
    metadata: dict[str, str] = {}
    for line in header.splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            metadata[key.strip()] = value.strip()
    return metadata, content


def _matches_paths(raw_paths: str, active_files: list[str]) -> bool:
    patterns = [value.strip() for value in raw_paths.split(",") if value.strip()]
    if not patterns:
        return True
    return any(fnmatch.fnmatch(path, pattern) for path in active_files for pattern in patterns)


def _normalize(content: str) -> str:
    return " ".join(content.casefold().split())


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


@dataclass(frozen=True, slots=True)
class MemoryRecord:
    id: str
    name: str
    status: str
    content: str
    category: str
    metadata: dict[str, str]


class MemoryConflictError(ValueError):
    def __init__(self, candidate_id: str, conflicts: list[str]) -> None:
        self.candidate_id = candidate_id
        self.conflicts = conflicts
        super().__init__(f"candidate {candidate_id} conflicts with: {', '.join(conflicts)}")
