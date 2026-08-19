from __future__ import annotations

import json

from minicode.context.context_manager import ContextManager
from minicode.engine.events import EventSink, null_sink
from minicode.engine.model_client import ModelClient
from minicode.engine.prompt_builder import describe_tools, tool_specs_for_model
from minicode.memory.memory_service import MemoryService
from minicode.runtime.approval_gate import ApprovalRequired
from minicode.runtime.harness import HarnessRuntime
from minicode.schemas.event import Event
from minicode.schemas.session import Message, SessionState
from minicode.schemas.tool import ToolCall, ToolCallRecord, ToolResult


class QueryLoop:
    INSPECTION_TOOLS = {"read_file", "list_directory", "glob_files", "grep", "git_status", "git_diff"}

    def __init__(
        self,
        model: ModelClient,
        runtime: HarnessRuntime,
        context_manager: ContextManager | None = None,
        memory_service: MemoryService | None = None,
        event_sink: EventSink = null_sink,
        max_steps: int = 20,
        max_identical_read_calls: int = 3,
        max_duplicate_recovery_warnings: int = 2,
        max_post_write_inspections: int = 4,
        role: str = "assistant",
    ) -> None:
        self.model = model
        self.runtime = runtime
        self.context_manager = context_manager or ContextManager()
        self.memory_service = memory_service
        self.event_sink = event_sink
        self.max_steps = max_steps
        self.max_identical_read_calls = max_identical_read_calls
        self.max_duplicate_recovery_warnings = max_duplicate_recovery_warnings
        self.max_post_write_inspections = max_post_write_inspections
        self.role = role

    def run(self, session: SessionState) -> SessionState:
        session.status = "running"
        if self.memory_service:
            for message in session.messages:
                if message.role == "user":
                    self.memory_service.capture_user_instruction(message.content)
        self.event_sink(Event(type="run_started", run_id=session.run_id, summary=session.task))

        for _ in range(self.max_steps):
            visible = self.runtime.registry.visible_tools(session.mode, self.role)
            use_native_history = self.model.supports_native_tool_history
            context = self.context_manager.build(
                session,
                describe_tools(visible),
                include_tool_results=not use_native_history,
            )
            response = self.model.complete(
                context,
                tool_specs_for_model(visible),
                tool_history=session.tool_calls if use_native_history else None,
            )

            if response.type == "final":
                session.final_answer = response.content
                session.messages.append(Message(role="assistant", content=response.content))
                session.status = "completed"
                self.event_sink(Event(type="run_completed", run_id=session.run_id, summary=response.content[:160]))
                return session

            if response.tool_call is None:
                session.status = "failed"
                return session

            call = response.tool_call
            call.mode = session.mode
            call.role = self.role
            if self._repeated_read_only_call(session, call.tool_name, call.arguments):
                warning_count = self._consecutive_duplicate_warnings(session, call.tool_name, call.arguments)
                if warning_count >= self.max_duplicate_recovery_warnings:
                    session.status = "failed"
                    session.final_answer = "Stopped after the model ignored duplicate-read recovery guidance twice."
                    self.event_sink(Event(type="run_failed", run_id=session.run_id, summary=session.final_answer))
                    return session
                self.event_sink(Event(
                    type="tool_call_created",
                    run_id=session.run_id,
                    summary=call.tool_name,
                    payload=call.model_dump(),
                ))
                duplicate_record = self._duplicate_read_warning(session, call)
                session.tool_calls.append(duplicate_record)
                self.event_sink(Event(
                    type="tool_call_finished",
                    run_id=session.run_id,
                    summary=duplicate_record.status,
                    payload=duplicate_record.model_dump(),
                ))
                continue
            self.event_sink(Event(type="tool_call_created", run_id=session.run_id, summary=call.tool_name, payload=call.model_dump()))
            try:
                record = self.runtime.execute(call, session.run_id)
            except ApprovalRequired as approval:
                return self._pause_for_approval(session, approval)

            session.tool_calls.append(record)
            if self.memory_service and record.result and record.result.success and record.tool_name == "run_tests":
                self.memory_service.capture_verified_test_command(str(record.request.arguments.get("command", "python -m pytest -q")))
            if record.result and record.result.modified_paths:
                session.active_files.extend(record.result.modified_paths)
            self.event_sink(Event(type="tool_call_finished", run_id=session.run_id, summary=record.status, payload=record.model_dump()))
            if call.tool_name == "propose_patch" and record.result and record.result.success and session.mode == "act":
                apply_call = ToolCall(
                    tool_name="apply_patch",
                    arguments={"path": call.arguments.get("path", ""), "content": call.arguments.get("content", "")},
                    intent=f"Apply the proposed patch for {call.arguments.get('path', '')}",
                    mode=session.mode,
                )
                self.event_sink(Event(
                    type="tool_call_created",
                    run_id=session.run_id,
                    summary=apply_call.tool_name,
                    payload=apply_call.model_dump(),
                ))
                try:
                    apply_record = self.runtime.execute(apply_call, session.run_id)
                except ApprovalRequired as approval:
                    return self._pause_for_approval(session, approval)
                session.tool_calls.append(apply_record)
                self.event_sink(Event(
                    type="tool_call_finished",
                    run_id=session.run_id,
                    summary=apply_record.status,
                    payload=apply_record.model_dump(),
                ))
            if self._excessive_post_write_inspection(session):
                return self._complete_after_write(session)

        if self._modified_paths(session):
            return self._complete_after_write(session)
        session.status = "failed"
        session.final_answer = "Stopped after max tool-use steps without reaching a final answer."
        self.event_sink(Event(type="run_failed", run_id=session.run_id, summary=session.final_answer))
        return session

    def resume_approved(self, session: SessionState) -> SessionState:
        call = session.pending_tool_call
        if call is None:
            raise ValueError("No tool call is waiting for approval")
        record = self.runtime.execute(call, session.run_id, approved=True)
        self._replace_call_record(session, record)
        if record.result and record.result.modified_paths:
            session.active_files.extend(record.result.modified_paths)
        session.pending_tool_call = None
        session.pending_approval_reason = ""
        self.event_sink(Event(type="tool_call_finished", run_id=session.run_id, summary=record.status, payload=record.model_dump()))
        return self.run(session)

    def reject_pending(self, session: SessionState) -> SessionState:
        call = session.pending_tool_call
        if call is None:
            raise ValueError("No tool call is waiting for approval")
        for record in session.tool_calls:
            if record.call_id == call.call_id:
                record.status = "rejected"
                break
        session.pending_tool_call = None
        session.pending_approval_reason = ""
        session.status = "cancelled"
        session.final_answer = "Tool call rejected by user."
        self.event_sink(Event(type="run_completed", run_id=session.run_id, summary=session.final_answer))
        return session

    @staticmethod
    def _replace_call_record(session: SessionState, replacement: ToolCallRecord) -> None:
        for index, record in enumerate(session.tool_calls):
            if record.call_id == replacement.call_id:
                session.tool_calls[index] = replacement
                return
        session.tool_calls.append(replacement)

    def _pause_for_approval(self, session: SessionState, approval: ApprovalRequired) -> SessionState:
        session.status = "waiting_approval"
        session.pending_tool_call = approval.call
        session.pending_approval_reason = approval.decision.reason
        session.tool_calls.append(ToolCallRecord(
            call_id=approval.call.call_id,
            tool_name=approval.call.tool_name,
            request=approval.call,
            status="approval_required",
        ))
        self.event_sink(Event(
            type="approval_required",
            run_id=session.run_id,
            summary=approval.decision.reason,
            payload={"tool_call": approval.call.model_dump(), "decision": approval.decision.model_dump()},
        ))
        return session

    def _repeated_read_only_call(self, session: SessionState, tool_name: str, arguments: dict) -> bool:
        spec = self.runtime.registry.get(tool_name)
        if spec is None or not spec.read_only:
            return False
        fingerprint = json.dumps(arguments, sort_keys=True, ensure_ascii=False)
        recent_records = session.tool_calls[-self.max_identical_read_calls:]
        return len(recent_records) == self.max_identical_read_calls and all(
            record.tool_name == tool_name
            and json.dumps(record.request.arguments, sort_keys=True, ensure_ascii=False) == fingerprint
            for record in recent_records
        )

    @staticmethod
    def _same_tool_request(record: ToolCallRecord, tool_name: str, fingerprint: str) -> bool:
        return (
            record.tool_name == tool_name
            and json.dumps(record.request.arguments, sort_keys=True, ensure_ascii=False) == fingerprint
        )

    def _consecutive_duplicate_warnings(self, session: SessionState, tool_name: str, arguments: dict) -> int:
        fingerprint = json.dumps(arguments, sort_keys=True, ensure_ascii=False)
        count = 0
        for record in reversed(session.tool_calls):
            if not self._same_tool_request(record, tool_name, fingerprint):
                break
            if record.result and record.result.metadata.get("duplicate_blocked"):
                count += 1
        return count

    def _duplicate_read_warning(self, session: SessionState, call: ToolCall) -> ToolCallRecord:
        fingerprint = json.dumps(call.arguments, sort_keys=True, ensure_ascii=False)
        previous_result = next(
            (
                record.result
                for record in reversed(session.tool_calls)
                if self._same_tool_request(record, call.tool_name, fingerprint)
                and record.result
                and not record.result.metadata.get("duplicate_blocked")
            ),
            None,
        )
        next_offset = previous_result.metadata.get("next_offset") if previous_result else None
        if call.tool_name == "read_file" and next_offset is not None:
            guidance = f"Duplicate read skipped because this window is already in context. Continue read_file with offset={next_offset}."
        elif call.tool_name == "read_file":
            guidance = "Duplicate read skipped because this file window is already in context and reached end of file. Continue to edit or answer."
        else:
            guidance = "Duplicate read-only call skipped because its result is already in context. Continue with a targeted read/search, an edit proposal, or a final answer."
        result = ToolResult(
            call_id=call.call_id,
            tool_name=call.tool_name,
            success=False,
            summary=guidance,
            metadata={"duplicate_blocked": True, "suggested_next_offset": next_offset},
        )
        return ToolCallRecord(
            call_id=call.call_id,
            tool_name=call.tool_name,
            request=call,
            status="failed",
            result=result,
        )

    def _excessive_post_write_inspection(self, session: SessionState) -> bool:
        last_write_index = -1
        for index, record in enumerate(session.tool_calls):
            if record.result and record.result.success and record.result.modified_paths:
                last_write_index = index
        if last_write_index < 0:
            return False
        inspections = session.tool_calls[last_write_index + 1:]
        return (
            len(inspections) >= self.max_post_write_inspections
            and all(record.tool_name in self.INSPECTION_TOOLS for record in inspections[-self.max_post_write_inspections:])
        )

    @staticmethod
    def _modified_paths(session: SessionState) -> list[str]:
        paths: list[str] = []
        for record in session.tool_calls:
            if not record.result or not record.result.success:
                continue
            for path in record.result.modified_paths:
                if path not in paths:
                    paths.append(path)
        return paths

    def _complete_after_write(self, session: SessionState) -> SessionState:
        paths = self._modified_paths(session)
        session.final_answer = f"Changes applied successfully: {', '.join(paths)}."
        session.messages.append(Message(role="assistant", content=session.final_answer))
        session.status = "completed"
        self.event_sink(Event(type="run_completed", run_id=session.run_id, summary=session.final_answer[:160]))
        return session
