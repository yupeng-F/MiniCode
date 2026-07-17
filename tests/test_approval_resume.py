from __future__ import annotations

from minicode.context.artifact_store import ArtifactStore
from minicode.engine.model_client import JsonScriptModel
from minicode.engine.query_loop import QueryLoop
from minicode.runtime.harness import HarnessRuntime
from minicode.runtime.policy_engine import PolicyEngine
from minicode.runtime.tool_executor import ToolExecutor
from minicode.runtime.workspace_manager import WorkspaceManager
from minicode.schemas.session import Message, SessionState
from minicode.tools import build_default_registry


def test_query_loop_can_resume_an_approved_tool_call(tmp_path):
    model = JsonScriptModel([
        {"type": "tool_use", "tool_call": {"tool_name": "apply_patch", "arguments": {"patch": "invalid patch"}}},
        {"type": "final", "content": "Approval handled."},
    ])
    workspace = WorkspaceManager(tmp_path)
    runtime = HarnessRuntime(
        build_default_registry(),
        PolicyEngine(),
        ToolExecutor(workspace, ArtifactStore(tmp_path / ".minicode")),
    )
    loop = QueryLoop(model, runtime)
    session = SessionState(workspace=str(tmp_path), task="Apply a patch")
    session.messages.append(Message(role="user", content="Apply a patch"))

    paused = loop.run(session)
    assert paused.status == "waiting_approval"
    assert paused.pending_tool_call is not None
    resumed = loop.resume_approved(paused)

    assert resumed.status == "completed"
    assert resumed.pending_tool_call is None
    assert resumed.final_answer == "Approval handled."


def test_query_loop_can_reject_a_pending_tool_call(tmp_path):
    model = JsonScriptModel([
        {"type": "tool_use", "tool_call": {"tool_name": "bash", "arguments": {"command": "pwd"}}},
    ])
    workspace = WorkspaceManager(tmp_path)
    runtime = HarnessRuntime(build_default_registry(), PolicyEngine(), ToolExecutor(workspace))
    loop = QueryLoop(model, runtime)
    session = SessionState(workspace=str(tmp_path), task="Run command")

    paused = loop.run(session)
    rejected = loop.reject_pending(paused)

    assert rejected.status == "cancelled"
    assert rejected.pending_tool_call is None


def test_patch_proposal_transitions_directly_to_apply_approval(tmp_path):
    model = JsonScriptModel([
        {
            "type": "tool_use",
            "tool_call": {
                "tool_name": "propose_patch",
                "arguments": {"path": "index.html", "content": "<h1>Snake</h1>\n"},
            },
        },
        {"type": "final", "content": "Created the game page."},
    ])
    workspace = WorkspaceManager(tmp_path)
    runtime = HarnessRuntime(
        build_default_registry(),
        PolicyEngine(),
        ToolExecutor(workspace, ArtifactStore(tmp_path / ".minicode")),
    )
    loop = QueryLoop(model, runtime)
    session = SessionState(workspace=str(tmp_path), task="Create a game")

    paused = loop.run(session)

    assert paused.status == "waiting_approval"
    assert paused.pending_tool_call is not None
    assert paused.pending_tool_call.tool_name == "apply_patch"
    assert paused.pending_tool_call.arguments == {"path": "index.html", "content": "<h1>Snake</h1>\n"}
    assert not (tmp_path / "index.html").exists()

    resumed = loop.resume_approved(paused)

    assert resumed.status == "completed"
    assert (tmp_path / "index.html").read_text(encoding="utf-8") == "<h1>Snake</h1>\n"
    assert resumed.active_files == ["index.html"]


def test_approved_patch_can_create_an_empty_file(tmp_path):
    model = JsonScriptModel([
        {
            "type": "tool_use",
            "tool_call": {
                "tool_name": "propose_patch",
                "arguments": {"path": "empty.txt", "content": ""},
            },
        },
        {"type": "final", "content": "Created empty file."},
    ])
    workspace = WorkspaceManager(tmp_path)
    runtime = HarnessRuntime(
        build_default_registry(),
        PolicyEngine(),
        ToolExecutor(workspace, ArtifactStore(tmp_path / ".minicode")),
    )
    loop = QueryLoop(model, runtime)

    paused = loop.run(SessionState(workspace=str(tmp_path), task="Create empty file"))
    resumed = loop.resume_approved(paused)

    assert resumed.status == "completed"
    assert (tmp_path / "empty.txt").exists()


def test_successful_write_finishes_after_excessive_post_write_inspection(tmp_path):
    model = JsonScriptModel([
        {
            "type": "tool_use",
            "tool_call": {
                "tool_name": "propose_patch",
                "arguments": {"path": "index.html", "content": "<canvas></canvas>\n"},
            },
        },
        {"type": "tool_use", "tool_call": {"tool_name": "read_file", "arguments": {"path": "index.html"}}},
        {"type": "tool_use", "tool_call": {"tool_name": "list_directory", "arguments": {"path": "."}}},
        {"type": "tool_use", "tool_call": {"tool_name": "read_file", "arguments": {"path": "index.html", "offset": 0}}},
        {"type": "tool_use", "tool_call": {"tool_name": "list_directory", "arguments": {}}},
    ])
    workspace = WorkspaceManager(tmp_path)
    runtime = HarnessRuntime(
        build_default_registry(),
        PolicyEngine(),
        ToolExecutor(workspace, ArtifactStore(tmp_path / ".minicode")),
    )
    loop = QueryLoop(model, runtime)

    paused = loop.run(SessionState(workspace=str(tmp_path), task="Create a snake game"))
    resumed = loop.resume_approved(paused)

    assert resumed.status == "completed"
    assert "index.html" in resumed.final_answer
    assert "applied successfully" in resumed.final_answer.lower()
    assert (tmp_path / "index.html").read_text(encoding="utf-8") == "<canvas></canvas>\n"
