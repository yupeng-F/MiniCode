from __future__ import annotations

import time
from pathlib import Path

from fastapi.testclient import TestClient

from minicode.engine.model_client import JsonScriptModel
from minicode.interfaces.web import server
from minicode.schemas.event import Event
from minicode.schemas.session import SessionState
from minicode.schemas.tool import ToolCall
from minicode.storage.global_store import GlobalStore


def _wait_for_status(client: TestClient, run_id: str, expected: str) -> dict:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        response = client.get(f"/api/runs/{run_id}")
        if response.status_code == 200 and response.json()["status"] == expected:
            return response.json()
        time.sleep(0.02)
    raise AssertionError(f"run {run_id} did not reach {expected}")


def test_global_store_persists_run_events_and_atomically_claims_approval(tmp_path: Path):
    store = GlobalStore(tmp_path / "minicode.db")
    session = SessionState(workspace=str(tmp_path), status="waiting_approval")
    store.save_run("project-1", session)
    event = Event(type="approval_required", run_id=session.run_id, summary="Confirm")
    event_id = store.append_event(event)

    loaded, project_id, status = store.load_run(session.run_id)  # type: ignore[misc]

    assert loaded.session_id == session.session_id
    assert project_id == "project-1"
    assert status == "waiting_approval"
    assert store.list_events(session.run_id) == [(event_id, event)]
    assert store.claim_approval(session.run_id) is True
    assert store.claim_approval(session.run_id) is False


def test_daemon_restart_restores_pending_approval_and_executes_it_once(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    server._runs.clear()
    server.app.state.global_store_path = tmp_path / "home" / "minicode.db"
    server.app.state.model_factory = lambda: JsonScriptModel([
        {
            "type": "tool_use",
            "tool_call": {
                "tool_name": "bash",
                "arguments": {"command": "printf x >> marker.txt"},
            },
        }
    ])
    client = TestClient(server.app)

    created = client.post("/api/runs", json={"workspace": str(workspace), "input": "write marker"}).json()
    run_id = created["run_id"]
    _wait_for_status(client, run_id, "waiting_approval")

    # Simulate loss of all process-local state, then restore through the API.
    server._runs.clear()
    restored = client.get(f"/api/runs/{run_id}")
    assert restored.status_code == 200
    assert restored.json()["pending_tool_call"]["tool_name"] == "bash"

    server.app.state.model_factory = lambda: JsonScriptModel([{"type": "final", "content": "done"}])
    first = client.post(f"/api/runs/{run_id}/approval", json={"decision": "approve"})
    second = client.post(f"/api/runs/{run_id}/approval", json={"decision": "approve"})

    assert first.status_code == 200
    assert second.status_code == 409
    _wait_for_status(client, run_id, "completed")
    assert (workspace / "marker.txt").read_text(encoding="utf-8") == "x"
    assert [event.type for _, event in GlobalStore(server.app.state.global_store_path).list_events(run_id)] == [
        "run_started",
        "tool_call_created",
        "approval_required",
        "tool_call_finished",
        "run_started",
        "run_completed",
    ]


def test_restart_never_retries_an_approval_claimed_before_the_crash(tmp_path: Path):
    db_path = tmp_path / "home" / "minicode.db"
    store = GlobalStore(db_path)
    session = SessionState(workspace=str(tmp_path), status="waiting_approval")
    session.pending_tool_call = ToolCall(tool_name="bash", arguments={"command": "touch should-not-exist"})
    store.save_run("project-1", session)
    assert store.claim_approval(session.run_id)
    server._runs.clear()
    server.app.state.global_store_path = db_path

    response = TestClient(server.app).get(f"/api/runs/{session.run_id}")

    assert response.status_code == 200
    assert response.json()["status"] == "failed"
    assert "not retried" in response.json()["final_answer"]
    assert not (tmp_path / "should-not-exist").exists()
