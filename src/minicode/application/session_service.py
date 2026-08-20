from __future__ import annotations

from uuid import uuid4

from minicode.engine.model_catalog import DEFAULT_MODEL_ID, get_model_profile
from minicode.schemas.project import Project, SessionSummary
from minicode.schemas.session import Message, SessionState
from minicode.storage.global_store import GlobalStore


class ActiveRunModelSwitchError(ValueError):
    pass


class SessionService:
    def __init__(self, store: GlobalStore) -> None:
        self.store = store

    def create(
        self,
        project: Project,
        task: str,
        mode: str = "act",
        model_id: str = DEFAULT_MODEL_ID,
    ) -> SessionState:
        profile = get_model_profile(model_id)
        session = SessionState(
            workspace=project.workspace,
            mode=mode,
            model_id=profile.id,
            run_model_id=profile.id,
            task=task,
        )
        session.messages.append(Message(role="user", content=task))
        self.save(project.project_id, session)
        return session

    def append_user_message(self, session_id: str, content: str) -> SessionState:
        session = self.get_session(session_id)
        if session is None:
            raise ValueError(f"Session not found: {session_id}")
        project = self.store.get_project_by_workspace(session.workspace)
        if project is None:
            raise ValueError(f"Project not found for session: {session_id}")
        session.messages.append(Message(role="user", content=content))
        session.task = content
        self.save(project.project_id, session)
        return session

    def save(self, project_id: str, session: SessionState) -> None:
        self.store.save_session(project_id, session)

    def get_session(self, session_id: str) -> SessionState | None:
        return self.store.load_session(session_id)

    def list_sessions(self, project_id: str) -> list[SessionSummary]:
        return self.store.list_sessions(project_id)

    def start_run(self, session_id: str, content: str, mode: str | None = None) -> SessionState:
        session = self.get_session(session_id)
        if session is None:
            raise ValueError(f"Session not found: {session_id}")
        project = self.store.get_project_by_workspace(session.workspace)
        if project is None:
            raise ValueError(f"Project not found for session: {session_id}")
        if content:
            session.messages.append(Message(role="user", content=content))
            session.task = content
        if mode is not None:
            session.mode = mode
        session.run_id = str(uuid4())
        session.run_model_id = session.model_id
        session.status = "pending"
        session.tool_calls = []
        session.final_answer = ""
        session.pending_tool_call = None
        session.pending_approval_reason = ""
        self.save(project.project_id, session)
        return session

    def select_model(self, session_id: str, model_id: str) -> SessionState:
        session = self.get_session(session_id)
        if session is None:
            raise ValueError(f"找不到会话：{session_id}")
        if self.store.active_run_for_session(session_id):
            raise ActiveRunModelSwitchError("Run 结束前不能切换模型")
        profile = get_model_profile(model_id)
        project = self.store.get_project_by_workspace(session.workspace)
        if project is None:
            raise ValueError(f"找不到会话所属项目：{session_id}")
        session.model_id = profile.id
        self.save(project.project_id, session)
        return session

    def delete(self, session_id: str) -> bool:
        return self.store.delete_session(session_id)
