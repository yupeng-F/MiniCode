from __future__ import annotations

import json

from minicode.context.compact_manager import CompactManager
from minicode.memory.memory_service import MemoryService
from minicode.schemas.session import SessionState


class ContextManager:
    MAX_TOOL_CONTEXT_CHARS = 24_000
    MAX_LATEST_TOOL_PREVIEW_CHARS = 12_000
    MAX_OLDER_TOOL_PREVIEW_CHARS = 3_000

    def __init__(self, compactor: CompactManager | None = None, memory_service: MemoryService | None = None) -> None:
        self.compactor = compactor or CompactManager()
        self.memory_service = memory_service

    def build(
        self,
        session: SessionState,
        tool_descriptions: list[str] | None = None,
        include_tool_results: bool = True,
    ) -> str:
        compact, messages = self.compactor.compact_messages(session.messages)
        if compact:
            session.compact_summary = compact
        parts = [
            "You are MiniCode, a local-first coding agent.",
            f"Mode: {session.mode}",
            f"Workspace: {session.workspace}",
            f"Task: {session.task}",
        ]
        if compact or session.compact_summary:
            parts.append("## Compact Summary\n" + (session.compact_summary or compact))
        if session.plan:
            parts.append("## Plan\n" + "\n".join(f"- {step}" for step in session.plan[:8]))
        if session.active_files:
            parts.append("## Active Files\n" + "\n".join(session.active_files[-12:]))
        if self.memory_service:
            memory = self.memory_service.retrieve(session.task, session.active_files)
            if memory:
                parts.append("## Project Memory\n" + memory)
        if tool_descriptions:
            parts.append("## Available Tools\n" + "\n".join(tool_descriptions))
        if messages:
            parts.append("## Recent Messages")
            parts.extend(f"{m.role}: {self.compactor.sensitive_filter.sanitize(m.content)}" for m in messages)
        if include_tool_results and session.tool_calls:
            parts.append("## Recent Tool Results")
            parts.extend(self._tool_result_context(session))
        return "\n\n".join(parts)

    def _tool_result_context(self, session: SessionState) -> list[str]:
        entries: list[str] = []
        remaining = self.MAX_TOOL_CONTEXT_CHARS
        recent = [record for record in session.tool_calls[-8:] if record.result]
        latest_preview_assigned = False
        for record in reversed(recent):
            result = record.result
            if result is None:
                continue
            metadata = json.dumps(result.metadata, ensure_ascii=False, sort_keys=True)
            header = f"### {result.tool_name}\n{result.summary}\nMetadata: {metadata}"
            if result.artifact_ref:
                header += f"\nArtifact: {result.artifact_ref}"
            is_latest_substantive_result = bool(result.preview) and not latest_preview_assigned
            preview_limit = self.MAX_LATEST_TOOL_PREVIEW_CHARS if is_latest_substantive_result else self.MAX_OLDER_TOOL_PREVIEW_CHARS
            if result.preview:
                latest_preview_assigned = True
            available = max(remaining - len(header) - 10, 0)
            preview = self.compactor.sensitive_filter.sanitize(result.preview)
            preview = preview[:min(preview_limit, available)]
            entry = header + (f"\nOutput:\n{preview}" if preview else "")
            entries.append(entry)
            remaining = max(remaining - len(entry), 0)
        return list(reversed(entries))
