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
