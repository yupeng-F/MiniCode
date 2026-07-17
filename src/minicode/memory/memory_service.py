from __future__ import annotations

import fnmatch
import hashlib
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
