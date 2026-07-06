from __future__ import annotations


class ArtifactStore:
    """Store large tool outputs outside the graph state."""

    def put(self, content: str) -> str:
        _ = content
        return "artifact-placeholder"
