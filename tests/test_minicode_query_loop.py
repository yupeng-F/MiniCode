from __future__ import annotations

from pathlib import Path

from minicode.application.run_service import RunService
from minicode.engine.model_client import JsonScriptModel
from minicode.storage.sqlite_store import SQLiteStore


def test_query_loop_runs_tool_and_finalizes(tmp_path: Path):
    (tmp_path / "README.md").write_text("# Demo\n", encoding="utf-8")
    model = JsonScriptModel([
        {"type": "tool_use", "tool_call": {"tool_name": "read_file", "arguments": {"path": "README.md"}}},
        {"type": "final", "content": "Read the README."},
    ])

    service = RunService(workspace=str(tmp_path), model=model)
    session = service.run("Read README", mode="act")

    assert session.status == "completed"
    assert session.final_answer == "Read the README."
    assert len(session.tool_calls) == 1
    assert session.tool_calls[0].result is not None
    assert session.tool_calls[0].result.success is True


def test_run_service_persists_session(tmp_path: Path):
    model = JsonScriptModel([{"type": "final", "content": "Done."}])
    service = RunService(workspace=str(tmp_path), model=model)
    session = service.run("noop", mode="ask")

    store = SQLiteStore(tmp_path / ".minicode" / "state.db")
    loaded = store.load_session(session.session_id)

    assert loaded is not None
    assert loaded.final_answer == "Done."


def test_query_loop_recovers_from_a_repeated_read_only_tool_call(tmp_path: Path):
    model = JsonScriptModel([
        {"type": "tool_use", "tool_call": {"tool_name": "list_directory", "arguments": {"path": "."}}},
        {"type": "tool_use", "tool_call": {"tool_name": "list_directory", "arguments": {"path": "."}}},
        {"type": "tool_use", "tool_call": {"tool_name": "list_directory", "arguments": {"path": "."}}},
        {"type": "tool_use", "tool_call": {"tool_name": "list_directory", "arguments": {"path": "."}}},
        {"type": "final", "content": "Recovered after the duplicate read."},
    ])
    service = RunService(workspace=str(tmp_path), model=model)

    session = service.run("Inspect workspace", mode="act")

    assert session.status == "completed"
    assert session.final_answer == "Recovered after the duplicate read."
    assert len(session.tool_calls) == 4
    assert session.tool_calls[-1].status == "failed"
    assert session.tool_calls[-1].result is not None
    assert session.tool_calls[-1].result.metadata["duplicate_blocked"] is True


def test_query_loop_stops_only_after_duplicate_recovery_is_ignored(tmp_path: Path):
    repeated = {"type": "tool_use", "tool_call": {"tool_name": "list_directory", "arguments": {"path": "."}}}
    model = JsonScriptModel([repeated, repeated, repeated, repeated, repeated, repeated])
    service = RunService(workspace=str(tmp_path), model=model)

    session = service.run("Inspect workspace", mode="act")

    assert session.status == "failed"
    assert "ignored duplicate-read recovery" in session.final_answer.lower()
    assert len(session.tool_calls) == 5


def test_query_loop_can_propose_a_patch_after_duplicate_file_reads(tmp_path: Path):
    (tmp_path / "index.html").write_text("old", encoding="utf-8")
    repeated_read = {"type": "tool_use", "tool_call": {"tool_name": "read_file", "arguments": {"path": "index.html"}}}
    model = JsonScriptModel([
        repeated_read,
        repeated_read,
        repeated_read,
        repeated_read,
        {"type": "tool_use", "tool_call": {"tool_name": "propose_patch", "arguments": {"path": "index.html", "content": "<canvas></canvas>\n"}}},
        {"type": "final", "content": "Created the game."},
    ])
    service = RunService(workspace=str(tmp_path), model=model)

    paused = service.run("Create a browser snake game", mode="act")

    assert paused.status == "waiting_approval"
    assert paused.pending_tool_call is not None
    assert paused.pending_tool_call.tool_name == "apply_patch"


def test_query_loop_allows_a_read_only_call_after_other_progress(tmp_path: Path):
    model = JsonScriptModel([
        {"type": "tool_use", "tool_call": {"tool_name": "list_directory", "arguments": {"path": "."}}},
        {"type": "tool_use", "tool_call": {"tool_name": "git_status", "arguments": {}}},
        {"type": "tool_use", "tool_call": {"tool_name": "list_directory", "arguments": {"path": "."}}},
        {"type": "tool_use", "tool_call": {"tool_name": "git_diff", "arguments": {}}},
        {"type": "tool_use", "tool_call": {"tool_name": "list_directory", "arguments": {"path": "."}}},
        {"type": "final", "content": "Exploration completed."},
    ])
    service = RunService(workspace=str(tmp_path), model=model)

    session = service.run("Inspect workspace", mode="act")

    assert session.status == "completed"
    assert len(session.tool_calls) == 5
