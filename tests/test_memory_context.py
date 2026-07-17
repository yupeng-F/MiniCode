from __future__ import annotations

from minicode.context.context_manager import ContextManager
from minicode.memory.memory_service import MemoryService
from minicode.schemas.session import Message, SessionState
from minicode.schemas.tool import ToolCall, ToolCallRecord, ToolResult


def test_context_compacts_old_messages_and_redacts_sensitive_values(tmp_path):
    session = SessionState(task="Inspect backend")
    session.messages = [
        Message(role="user", content=f"turn {index} DEEPSEEK_API_KEY=top-secret")
        for index in range(14)
    ]

    context = ContextManager(memory_service=MemoryService(tmp_path / "project-a" / ".minicode" / "memory")).build(session)

    assert "top-secret" not in context
    assert "Sensitive value redacted" in context
    assert session.compact_summary
    assert len(session.messages) == 14


def test_memory_is_project_isolated_and_path_matched(tmp_path):
    project_a = MemoryService(tmp_path / "project-a" / ".minicode" / "memory")
    project_b = MemoryService(tmp_path / "project-b" / ".minicode" / "memory")
    project_a.store_rule(
        name="python-test-rule",
        content="Run pytest before finalizing Python changes.",
        paths=["**/*.py"],
        source="verified_tool",
    )

    a_memory = project_a.retrieve(task="Change a Python test", active_files=["tests/test_app.py"])
    b_memory = project_b.retrieve(task="Change a Python test", active_files=["tests/test_app.py"])

    assert "Run pytest" in a_memory
    assert b_memory == ""


def test_memory_rejects_sensitive_rule_content(tmp_path):
    memory = MemoryService(tmp_path / ".minicode" / "memory")

    stored = memory.store_rule(
        name="unsafe",
        content="Use DEEPSEEK_API_KEY=top-secret for local runs.",
        source="user_instruction",
    )

    assert stored is False
    assert "top-secret" not in memory.index()


def test_memory_captures_verified_test_command(tmp_path):
    memory = MemoryService(tmp_path / ".minicode" / "memory")

    memory.capture_verified_test_command("conda run -n LLM python -m pytest -q")

    assert "conda run -n LLM python -m pytest -q" in memory.retrieve("Run tests", [])


def test_context_keeps_recent_read_content_and_pagination_metadata():
    preview = "start\n" + "x" * 2_000 + "\nEND-OF-READ-WINDOW"
    call = ToolCall(tool_name="read_file", arguments={"path": "README.md", "offset": 0, "limit": 100})
    result = ToolResult(
        call_id=call.call_id,
        tool_name="read_file",
        success=True,
        summary="Read lines 1-100 of 500 from README.md; next_offset=100",
        preview=preview,
        metadata={"path": "README.md", "offset": 0, "returned_lines": 100, "total_lines": 500, "next_offset": 100, "truncated": True},
    )
    session = SessionState(task="Understand README")
    session.tool_calls.append(ToolCallRecord(
        call_id=call.call_id,
        tool_name=call.tool_name,
        request=call,
        status="succeeded",
        result=result,
    ))

    context = ContextManager().build(session)

    assert "END-OF-READ-WINDOW" in context
    assert '"next_offset": 100' in context


def test_duplicate_warning_does_not_shrink_the_latest_read_window():
    preview = "x" * 5_000 + "END-OF-SUBSTANTIVE-READ"
    read_call = ToolCall(tool_name="read_file", arguments={"path": "README.md"})
    warning_call = ToolCall(tool_name="read_file", arguments={"path": "README.md"})
    session = SessionState(task="Understand README")
    session.tool_calls = [
        ToolCallRecord(
            call_id=read_call.call_id,
            tool_name=read_call.tool_name,
            request=read_call,
            status="succeeded",
            result=ToolResult(
                call_id=read_call.call_id,
                tool_name="read_file",
                success=True,
                summary="Read README.md",
                preview=preview,
            ),
        ),
        ToolCallRecord(
            call_id=warning_call.call_id,
            tool_name=warning_call.tool_name,
            request=warning_call,
            status="failed",
            result=ToolResult(
                call_id=warning_call.call_id,
                tool_name="read_file",
                success=False,
                summary="Duplicate read skipped",
                metadata={"duplicate_blocked": True},
            ),
        ),
    ]

    context = ContextManager().build(session)

    assert "END-OF-SUBSTANTIVE-READ" in context
