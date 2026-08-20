from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from minicode.engine.model_client import JsonScriptModel
from minicode.interfaces.web.server import app
from minicode.memory.memory_service import MemoryService
from minicode.schemas.session import SessionState


class FixedTokenCounter:
    def __init__(self, token_count: int) -> None:
        self.token_count = token_count

    def count(self, value: object) -> int:
        return self.token_count


def test_web_index_reports_architecture():
    client = TestClient(app)
    response = client.get("/")
    assert response.status_code == 200
    assert response.json()["name"] == "MiniCode"


def test_web_capabilities_lists_selectable_models_and_token_limits(tmp_path, monkeypatch):
    cache = tmp_path / "models"
    marker = cache / "BAAI__bge-small-zh-v1.5" / ".ready"
    marker.parent.mkdir(parents=True)
    marker.write_text("ready", encoding="utf-8")
    model_file = cache / "models--Qdrant--bge-small-zh-v1.5" / "model.onnx"
    model_file.parent.mkdir(parents=True)
    model_file.write_bytes(b"x" * 2048)
    monkeypatch.setenv("MINICODE_EMBEDDING_CACHE", str(cache))

    response = TestClient(app).get("/api/capabilities")

    assert response.status_code == 200
    assert response.json()["default_model"] == "deepseek-v4-flash"
    assert [item["id"] for item in response.json()["models"]] == [
        "deepseek-v4-flash",
        "deepseek-v4-pro",
    ]
    assert response.json()["token_limits"] == {"input": 48_000, "output": 8_000, "user_message": 12_000}
    assert response.json()["embedding"]["remote_model"] == "qwen3.7-text-embedding"
    assert response.json()["embedding"]["local_model"] == "BAAI/bge-small-zh-v1.5"
    assert response.json()["embedding"]["local_installed"] is True
    assert response.json()["embedding"]["local_size_bytes"] >= 2048
    assert "api_key" not in str(response.json()["embedding"]).lower()


def test_web_session_accepts_selected_model_and_rejects_unknown_model(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    app.state.global_store_path = tmp_path / "home" / "minicode.db"
    client = TestClient(app)
    project = client.post("/api/projects", json={"workspace": str(workspace)}).json()

    selected = client.post(
        f"/api/projects/{project['project_id']}/sessions",
        json={"input": "检查项目", "mode": "ask", "model_id": "deepseek-v4-pro"},
    )
    rejected = client.post(
        f"/api/projects/{project['project_id']}/sessions",
        json={"input": "检查项目", "mode": "ask", "model_id": "unknown-model"},
    )

    assert selected.status_code == 200
    assert selected.json()["model_id"] == "deepseek-v4-pro"
    assert rejected.status_code == 422


def test_web_run_uses_pinned_model_and_blocks_switch_while_active(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    app.state.global_store_path = tmp_path / "home" / "minicode.db"
    selected_models: list[str] = []

    def model_factory(model_id: str):
        selected_models.append(model_id)
        return JsonScriptModel([{
            "type": "tool_use",
            "tool_call": {"tool_name": "bash", "arguments": {"command": "pwd"}},
        }])

    app.state.model_factory = model_factory
    client = TestClient(app)
    project = client.post("/api/projects", json={"workspace": str(workspace)}).json()
    session = client.post(
        f"/api/projects/{project['project_id']}/sessions",
        json={"input": "检查项目", "mode": "act", "model_id": "deepseek-v4-pro"},
    ).json()

    created = client.post(
        "/api/runs",
        json={"session_id": session["session_id"], "input": "执行检查"},
    ).json()

    import time

    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        state = client.get(f"/api/runs/{created['run_id']}").json()
        if state["status"] == "waiting_approval":
            break
        time.sleep(0.02)
    else:
        raise AssertionError("Run 未进入等待审批状态")

    blocked = client.patch(
        f"/api/sessions/{session['session_id']}/model",
        json={"model_id": "deepseek-v4-flash"},
    )
    run_state = client.get(f"/api/runs/{created['run_id']}").json()

    assert selected_models == ["deepseek-v4-pro"]
    assert run_state["run_model_id"] == "deepseek-v4-pro"
    assert blocked.status_code == 409


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


def test_web_rejects_oversized_input_before_creating_session_or_run(tmp_path: Path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    app.state.global_store_path = tmp_path / "home" / "minicode.db"
    monkeypatch.setattr(app.state, "token_counter", FixedTokenCounter(12_001), raising=False)
    client = TestClient(app)
    project = client.post("/api/projects", json={"workspace": str(workspace)}).json()

    session_response = client.post(
        f"/api/projects/{project['project_id']}/sessions",
        json={"input": "超长消息", "mode": "ask"},
    )
    run_response = client.post(
        "/api/runs",
        json={"workspace": str(workspace), "input": "超长消息", "mode": "ask"},
    )

    expected = {"code": "user_message_too_large", "limit": 12_000, "actual": 12_001}
    assert session_response.status_code == 422
    assert session_response.json()["detail"] == expected
    assert run_response.status_code == 422
    assert run_response.json()["detail"] == expected


def test_web_accepts_input_at_token_limit(tmp_path: Path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    app.state.global_store_path = tmp_path / "home" / "minicode.db"
    monkeypatch.setattr(app.state, "token_counter", FixedTokenCounter(12_000), raising=False)
    client = TestClient(app)
    project = client.post("/api/projects", json={"workspace": str(workspace)}).json()

    response = client.post(
        f"/api/projects/{project['project_id']}/sessions",
        json={"input": "边界消息", "mode": "ask"},
    )

    assert response.status_code == 200


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


def test_web_manages_project_memory(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    app.state.global_store_path = tmp_path / "home" / "minicode.db"
    client = TestClient(app)
    project = client.post("/api/projects", json={"workspace": str(workspace)}).json()
    memory = MemoryService(workspace / ".minicode" / "memory")
    assert memory.store_rule("tests", "Always run pytest.")
    memory_id = memory.list_memories()[0].id

    listed = client.get(f"/api/projects/{project['project_id']}/memories")
    disabled = client.patch(
        f"/api/projects/{project['project_id']}/memories/{memory_id}",
        json={"enabled": False},
    )
    deleted = client.delete(f"/api/projects/{project['project_id']}/memories/{memory_id}")

    assert listed.status_code == 200
    assert listed.json()[0]["content"] == "Always run pytest."
    assert disabled.json()["status"] == "disabled"
    assert deleted.status_code == 204


def test_web_reenables_summary_memory_and_persists_it(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    app.state.global_store_path = tmp_path / "home" / "minicode.db"
    client = TestClient(app)
    project = client.post("/api/projects", json={"workspace": str(workspace)}).json()
    memory = MemoryService(workspace / ".minicode" / "memory")
    session = SessionState(
        run_id="web-summary",
        task="恢复检索",
        status="completed",
        final_answer="恢复后的摘要",
    )
    assert memory.store_run_summary(session)
    assert client.patch(
        f"/api/projects/{project['project_id']}/memories/{session.run_id}",
        json={"enabled": False},
    ).json()["status"] == "disabled"

    enabled = client.patch(
        f"/api/projects/{project['project_id']}/memories/{session.run_id}",
        json={"enabled": True},
    )

    assert enabled.status_code == 200
    assert enabled.json()["status"] == "enabled"
    reloaded = MemoryService(workspace / ".minicode" / "memory")
    assert reloaded.get_memory(session.run_id).status == "enabled"
    assert "恢复后的摘要" in reloaded.retrieve("恢复后的摘要", [])
