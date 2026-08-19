from __future__ import annotations

from minicode.context.artifact_store import ArtifactStore
from minicode.context.context_manager import ContextManager
from minicode.engine.model_client import JsonScriptModel, ModelClient
from minicode.engine.query_loop import QueryLoop
from minicode.memory.memory_service import MemoryService
from minicode.runtime.harness import HarnessRuntime
from minicode.runtime.policy_engine import PolicyEngine
from minicode.runtime.tool_executor import ToolExecutor
from minicode.runtime.workspace_manager import WorkspaceManager
from minicode.schemas.session import Message, SessionState
from minicode.storage.sqlite_store import SQLiteStore
from minicode.tools import build_default_registry


class RunService:
    def __init__(self, workspace: str = ".", model: ModelClient | None = None) -> None:
        self.workspace = WorkspaceManager(workspace)
        self.store = SQLiteStore(self.workspace.root / ".minicode" / "state.db")
        registry = build_default_registry()
        artifacts = ArtifactStore(self.workspace.root / ".minicode")
        memory = MemoryService(self.workspace.root / ".minicode" / "memory")
        selected_model = model or JsonScriptModel()
        executor = ToolExecutor(self.workspace, artifacts, task_agent_model=selected_model)
        runtime = HarnessRuntime(registry, PolicyEngine(), executor)
        self.loop = QueryLoop(selected_model, runtime, ContextManager(memory_service=memory), memory)

    def run(self, prompt: str, mode: str = "act") -> SessionState:
        session = SessionState(workspace=str(self.workspace.root), mode=mode, task=prompt)
        session.messages.append(Message(role="user", content=prompt))
        result = self.loop.run(session)
        self.store.save_session(result)
        return result
