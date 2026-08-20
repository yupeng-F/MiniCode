from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path


_SEGMENT_PATTERN = re.compile(r"[A-Za-z0-9_./]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+")
_CJK_PATTERN = re.compile(r"^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+$")


@dataclass(frozen=True, slots=True)
class KeywordMemory:
    memory_id: str
    document: str


@dataclass(frozen=True, slots=True)
class MediumMemory:
    memory_id: str
    task: str
    status: str
    content: str
    active_files: str
    created_at: str
    last_used_at: str
    use_count: int = 0
    pinned: bool = False


class MemoryIndex:
    """项目本地、可由 Markdown 完整重建的 FTS5 关键词索引。"""

    def __init__(self, path: str | Path, project_id: str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.project_id = project_id
        self._init()

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path)

    def _init(self) -> None:
        with self._connect() as conn:
            conn.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5("
                "memory_id UNINDEXED, project_id UNINDEXED, document, tokenize='unicode61')"
            )
            conn.execute(
                "CREATE TABLE IF NOT EXISTS medium_memory ("
                "memory_id TEXT NOT NULL, project_id TEXT NOT NULL, task TEXT NOT NULL, "
                "status TEXT NOT NULL, content TEXT NOT NULL, active_files TEXT NOT NULL, "
                "created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, use_count INTEGER NOT NULL DEFAULT 0, "
                "pinned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(memory_id, project_id))"
            )

    def rebuild(self, records: list[KeywordMemory]) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM memory_fts WHERE project_id = ?", (self.project_id,))
            conn.executemany(
                "INSERT INTO memory_fts(memory_id, project_id, document) VALUES (?, ?, ?)",
                (
                    (record.memory_id, self.project_id, tokenize_for_fts(record.document))
                    for record in records
                ),
            )

    def search(self, query: str, limit: int = 30) -> list[str]:
        terms = tokenize_terms(query)
        if not terms:
            return []
        expression = " OR ".join(f'"{term.replace(chr(34), chr(34) * 2)}"' for term in terms)
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT memory_id FROM memory_fts "
                "WHERE memory_fts MATCH ? AND project_id = ? "
                "ORDER BY bm25(memory_fts), rowid LIMIT ?",
                (expression, self.project_id, limit),
            ).fetchall()
        return [str(row[0]) for row in rows]

    def upsert_medium(self, record: MediumMemory) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO medium_memory(memory_id, project_id, task, status, content, active_files, "
                "created_at, last_used_at, use_count, pinned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(memory_id, project_id) DO UPDATE SET "
                "task=excluded.task, status=excluded.status, content=excluded.content, "
                "active_files=excluded.active_files, last_used_at=excluded.last_used_at, "
                "use_count=excluded.use_count, pinned=excluded.pinned",
                (
                    record.memory_id,
                    self.project_id,
                    record.task,
                    record.status,
                    record.content,
                    record.active_files,
                    record.created_at,
                    record.last_used_at,
                    record.use_count,
                    int(record.pinned),
                ),
            )

    def list_medium(self) -> list[MediumMemory]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT memory_id, task, status, content, active_files, created_at, last_used_at, "
                "use_count, pinned FROM medium_memory WHERE project_id = ? ORDER BY created_at DESC",
                (self.project_id,),
            ).fetchall()
        return [
            MediumMemory(
                memory_id=str(row[0]),
                task=str(row[1]),
                status=str(row[2]),
                content=str(row[3]),
                active_files=str(row[4]),
                created_at=str(row[5]),
                last_used_at=str(row[6]),
                use_count=int(row[7]),
                pinned=bool(row[8]),
            )
            for row in rows
        ]

    def delete_medium(self, memory_ids: list[str]) -> None:
        if not memory_ids:
            return
        placeholders = ",".join("?" for _ in memory_ids)
        with self._connect() as conn:
            conn.execute(
                f"DELETE FROM medium_memory WHERE project_id = ? AND memory_id IN ({placeholders})",
                (self.project_id, *memory_ids),
            )

    def touch_medium(self, memory_ids: list[str], used_at: str) -> None:
        if not memory_ids:
            return
        placeholders = ",".join("?" for _ in memory_ids)
        with self._connect() as conn:
            conn.execute(
                f"UPDATE medium_memory SET last_used_at = ?, use_count = use_count + 1 "
                f"WHERE project_id = ? AND memory_id IN ({placeholders})",
                (used_at, self.project_id, *memory_ids),
            )


def tokenize_terms(text: str) -> list[str]:
    terms: list[str] = []
    for segment in _SEGMENT_PATTERN.findall(text.casefold()):
        if _CJK_PATTERN.match(segment):
            if len(segment) == 1:
                terms.append(segment)
            else:
                for size in (2, 3):
                    terms.extend(segment[index:index + size] for index in range(len(segment) - size + 1))
        else:
            for value in re.split(r"[./]+", segment):
                if not value:
                    continue
                terms.append(value)
                if value.endswith("s") and len(value) > 3:
                    terms.append(value[:-1])
    return list(dict.fromkeys(terms))


def tokenize_for_fts(text: str) -> str:
    return " ".join(tokenize_terms(text))
