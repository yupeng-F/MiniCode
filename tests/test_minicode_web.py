from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from minicode.engine.model_client import JsonScriptModel
from minicode.interfaces.web.server import app


def test_web_index_reports_architecture():
    client = TestClient(app)
    response = client.get("/")
    assert response.status_code == 200
    assert response.json()["name"] == "MiniCode"


def test_web_creates_project_and_persistent_session(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    app.state.global_store_path = tmp_path / "home" / "minicode.db"
    app.state.model_factory = lambda: JsonScriptModel([{"type": "final", "content": "Done."}])
    client = TestClient(app)

    project_response = client.post("/api/projects", json={"workspace": str(workspace), "title": "Demo"})
    project = project_response.json()
    session_response = client.post(
        f"/api/projects/{project['project_id']}/sessions",
        json={"input": "Inspect tests", "mode": "plan"},
    )
    sessions_response = client.get(f"/api/projects/{project['project_id']}/sessions")

    assert project_response.status_code == 200
    assert session_response.status_code == 200
    assert sessions_response.status_code == 200
    assert sessions_response.json()[0]["title"] == "Inspect tests"


def test_web_reuses_existing_session_when_starting_a_run(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    app.state.global_store_path = tmp_path / "home" / "minicode.db"
    app.state.model_factory = lambda: JsonScriptModel([{"type": "final", "content": "Done."}])
    client = TestClient(app)
    project = client.post("/api/projects", json={"workspace": str(workspace)}).json()
    session = client.post(
        f"/api/projects/{project['project_id']}/sessions",
        json={"input": "Initial task", "mode": "plan"},
    ).json()

    response = client.post("/api/runs", json={"session_id": session["session_id"], "input": "Continue the task"})

    assert response.status_code == 200
    assert response.json()["session_id"] == session["session_id"]
    assert response.json()["run_id"] != session["run_id"]


def test_web_rejects_an_unsupported_run_mode(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    app.state.global_store_path = tmp_path / "home" / "minicode.db"
    client = TestClient(app)

    response = client.post(
        "/api/runs",
        json={"workspace": str(workspace), "input": "Inspect tests", "mode": "invalid"},
    )

    assert response.status_code == 422


def test_web_deletes_session_and_removes_project_history(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = workspace / "keep.txt"
    source.write_text("keep", encoding="utf-8")
    app.state.global_store_path = tmp_path / "home" / "minicode.db"
    client = TestClient(app)
    project = client.post("/api/projects", json={"workspace": str(workspace)}).json()
    session = client.post(
        f"/api/projects/{project['project_id']}/sessions",
        json={"input": "Temporary", "mode": "act"},
    ).json()

    session_response = client.delete(f"/api/sessions/{session['session_id']}")
    project_response = client.delete(f"/api/projects/{project['project_id']}")

    assert session_response.status_code == 204
    assert client.get(f"/api/sessions/{session['session_id']}").status_code == 404
    assert project_response.status_code == 204
    assert client.get("/api/projects").json() == []
    assert source.read_text(encoding="utf-8") == "keep"


def test_web_browses_directories_and_reads_project_files_in_pages(tmp_path: Path):
    workspace = tmp_path / "workspace"
    source = workspace / "src"
    source.mkdir(parents=True)
    (source / "demo.py").write_text("one\ntwo\nthree\n", encoding="utf-8")
    app.state.global_store_path = tmp_path / "home" / "minicode.db"
    client = TestClient(app)

    browse = client.get("/api/filesystem/browse", params={"path": str(tmp_path)})
    project = client.post("/api/projects", json={"workspace": str(workspace)}).json()
    tree = client.get(f"/api/projects/{project['project_id']}/files", params={"path": "."})
    first_page = client.get(
        f"/api/projects/{project['project_id']}/files/content",
        params={"path": "src/demo.py", "limit": 2},
    )
    second_page = client.get(
        f"/api/projects/{project['project_id']}/files/content",
        params={"path": "src/demo.py", "offset": 2, "limit": 2},
    )

    assert browse.status_code == 200
    assert any(item["name"] == "workspace" for item in browse.json()["entries"])
    assert tree.status_code == 200
    assert tree.json()["entries"] == [{"name": "src", "path": "src", "is_dir": True}]
    assert first_page.json()["content"] == "one\ntwo"
    assert first_page.json()["next_offset"] == 2
    assert second_page.json()["content"] == "three"
    assert second_page.json()["next_offset"] is None
