from __future__ import annotations

from pathlib import Path

from minicode.application.project_service import ProjectService
from minicode.application.session_service import SessionService
from minicode.storage.global_store import GlobalStore


def test_project_service_opens_workspace_once_and_lists_it(tmp_path: Path):
    service = ProjectService(GlobalStore(tmp_path / "minicode.db"))
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    first = service.open_workspace(workspace, title="Demo")
    second = service.open_workspace(workspace)

    assert first.project_id == second.project_id
    assert first.workspace == str((tmp_path / "workspace").resolve())
    assert [project.title for project in service.list_projects()] == ["Demo"]


def test_session_service_persists_and_lists_sessions_for_one_project(tmp_path: Path):
    store = GlobalStore(tmp_path / "minicode.db")
    projects = ProjectService(store)
    sessions = SessionService(store)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    project = projects.open_workspace(workspace, title="Demo")

    session = sessions.create(project, "Inspect the repository", mode="plan")
    sessions.append_user_message(session.session_id, "Focus on tests")

    items = sessions.list_sessions(project.project_id)
    restored = sessions.get_session(session.session_id)

    assert len(items) == 1
    assert items[0].session_id == session.session_id
    assert items[0].title == "Inspect the repository"
    assert restored is not None
    assert restored.mode == "plan"
    assert [message.content for message in restored.messages] == ["Inspect the repository", "Focus on tests"]


def test_project_service_rejects_missing_workspace(tmp_path: Path):
    service = ProjectService(GlobalStore(tmp_path / "minicode.db"))

    try:
        service.open_workspace(tmp_path / "missing")
    except ValueError as exc:
        assert "Workspace" in str(exc)
    else:
        raise AssertionError("Missing workspace should be rejected")


def test_start_run_uses_a_new_run_id_and_keeps_sessions_isolated(tmp_path: Path):
    store = GlobalStore(tmp_path / "minicode.db")
    projects = ProjectService(store)
    sessions = SessionService(store)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    project = projects.open_workspace(workspace)
    first = sessions.create(project, "First conversation")
    second = sessions.create(project, "Second conversation")
    previous_run_id = first.run_id

    started = sessions.start_run(first.session_id, "Continue first", "act")
    untouched = sessions.get_session(second.session_id)

    assert started.run_id != previous_run_id
    assert [message.content for message in started.messages] == ["First conversation", "Continue first"]
    assert untouched is not None
    assert [message.content for message in untouched.messages] == ["Second conversation"]


def test_deleting_session_only_removes_that_conversation(tmp_path: Path):
    store = GlobalStore(tmp_path / "minicode.db")
    projects = ProjectService(store)
    sessions = SessionService(store)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    project = projects.open_workspace(workspace)
    first = sessions.create(project, "First conversation")
    second = sessions.create(project, "Second conversation")

    assert sessions.delete(first.session_id) is True

    assert sessions.get_session(first.session_id) is None
    assert sessions.get_session(second.session_id) is not None
    assert [item.session_id for item in sessions.list_sessions(project.project_id)] == [second.session_id]


def test_removing_project_history_keeps_workspace_files(tmp_path: Path):
    store = GlobalStore(tmp_path / "minicode.db")
    projects = ProjectService(store)
    sessions = SessionService(store)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = workspace / "keep.txt"
    source.write_text("keep", encoding="utf-8")
    project = projects.open_workspace(workspace)
    session = sessions.create(project, "Temporary conversation")

    assert projects.remove(project.project_id) is True

    assert projects.get_project(project.project_id) is None
    assert sessions.get_session(session.session_id) is None
    assert source.read_text(encoding="utf-8") == "keep"
