from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class WorkspaceContext:
    root: str
    mode: str = "workspace-write"


class WorkspaceManager:
    """Workspace and isolation manager placeholder."""

    def current(self) -> WorkspaceContext:
        return WorkspaceContext(root=".")

