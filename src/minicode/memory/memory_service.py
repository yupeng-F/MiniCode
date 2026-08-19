from __future__ import annotations

import fnmatch
import hashlib
from dataclasses import dataclass
from pathlib import Path

from minicode.memory.markdown_memory import MarkdownMemory
from minicode.memory.sensitive_data_filter import SensitiveDataFilter


class MemoryService:
    """Project-local Markdown memory with bounded, path-aware retrieval."""

    def __init__(self, root: str | Path) -> None:
        self.store = MarkdownMemory(root)
        self.filter = SensitiveDataFilter()

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
        (self.store.root / record.category / f"{record.id}.md").unlink(missing_ok=True)
        self._rebuild_index()
        return True

    def _write(self, category: str, memory_id: str, metadata: dict[str, str], content: str) -> None:
        header = ["---", *[f"{key}: {value}" for key, value in metadata.items()], "---", "", content.strip(), ""]
        self.store.add(category, memory_id, "\n".join(header))

    def _rebuild_index(self) -> None:
        lines = ["# Memory Index", ""]
        for category in ("rules", "candidates"):
            directory = self.store.root / category
            if directory.exists():
                lines.extend(f"- [{category}/{path.stem}](./{category}/{path.name})" for path in sorted(directory.glob("*.md")))
        self.store.index_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def retrieve(self, task: str, active_files: list[str], max_chars: int = 3_000) -> str:
        selected: list[str] = []
        budget = max_chars
        for path in sorted((self.store.root / "rules").glob("*.md")) if (self.store.root / "rules").exists() else []:
            metadata, content = _parse_memory_file(path.read_text(encoding="utf-8"))
            if metadata.get("status", "enabled") != "enabled":
                continue
            if not _matches_paths(metadata.get("paths", ""), active_files):
                continue
            safe_content = self.filter.sanitize(content).strip()
            if not safe_content or len(safe_content) > budget:
                continue
            selected.append(f"- {safe_content}")
            budget -= len(safe_content)
        return "\n".join(selected)

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
        return self.store_rule(
            name=f"user-instruction-{suffix}",
            content=content,
            source="user_instruction",
        )


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
