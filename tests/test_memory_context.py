from __future__ import annotations

import pytest

from minicode.context.context_manager import ContextManager
from minicode.context.token_budget import UserMessageTooLarge
from minicode.memory.memory_service import MemoryService
from minicode.memory.hybrid_retriever import MemoryRetrievalResult
from minicode.schemas.session import Message, SessionState
from minicode.schemas.tool import ToolCall, ToolCallRecord, ToolResult


def test_context_projection_reports_partition_usage_without_repeating_current_task():
    session = SessionState(task="当前项目的 README 说明项目的目标是什么")
    session.messages = [
        Message(role="assistant", content="上一轮回答"),
        Message(role="user", content=session.task),
    ]

    projection = ContextManager().build(session, tool_descriptions=["- read_file: 读取文件"])

    assert projection.current_task == session.task
    assert session.task not in projection.recent_messages
    assert "上一轮回答" in projection.recent_messages
    assert projection.usage["current_task"] > 0
    assert projection.usage["system_and_tools"] > 0
    assert projection.total_tokens <= 48_000
    assert session.task in projection.render()


def test_current_task_is_rendered_after_conversation_history():
    session = SessionState(task="现在回答 README 的项目目标")
    session.messages = [
        Message(role="user", content="旧任务：继续修改 probe 文件"),
        Message(role="assistant", content="旧任务已经完成"),
        Message(role="user", content=session.task),
    ]

    rendered = ContextManager().build(session).render()

    assert rendered.rfind(session.task) > rendered.rfind("旧任务已经完成")


def test_context_passes_task_files_and_mode_and_records_retrieval_status(tmp_path):
    memory = MemoryService(tmp_path / ".minicode" / "memory")
    calls = []

    def retrieve_result(task, active_files, mode="act", max_tokens=4_000):
        calls.append((task, active_files, mode, max_tokens))
        return MemoryRetrievalResult((), "local", "阿里云超时", False, 0)

    memory.retrieve_result = retrieve_result  # type: ignore[method-assign]
    session = SessionState(task="检查 README", mode="review", active_files=["README.md"])

    ContextManager(memory_service=memory).build(session)

    assert calls == [("检查 README", ["README.md"], "review", 4_000)]
    assert session.memory_retrieval == {
        "provider": "local",
        "fallback_reason": "阿里云超时",
        "external_transfer": False,
        "token_count": 0,
        "item_count": 0,
    }


def test_context_projection_rejects_oversized_current_task_before_model_call():
    session = SessionState(task="x")
    manager = ContextManager()

    class OversizedCounter:
        def count(self, value: object) -> int:
            return 12_001

    manager.token_counter = OversizedCounter()

    with pytest.raises(UserMessageTooLarge):
        manager.build(session)


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


def test_user_instruction_is_reviewable_candidate_until_promoted(tmp_path):
    memory = MemoryService(tmp_path / ".minicode" / "memory")

    captured = memory.capture_user_instruction("必须只修改 eval/results/browser_e2e_probe.md")

    assert captured is True
    records = memory.list_memories()
    assert len(records) == 1
    assert records[0].status == "candidate"
    assert records[0].metadata["source"] == "user_instruction"
    assert memory.retrieve("Read README", []) == ""


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
