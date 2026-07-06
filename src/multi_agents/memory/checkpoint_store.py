from __future__ import annotations

from multi_agents.schemas.state import GraphState


class CheckpointStore:
    """Persist graph state snapshots."""

    def save(self, state: GraphState) -> None:
        """Placeholder save implementation."""
        _ = state

    def load(self, thread_id: str) -> GraphState | None:
        """Placeholder load implementation."""

        _ = thread_id
        return None
