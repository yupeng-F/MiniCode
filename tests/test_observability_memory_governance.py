from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest

from minicode.memory import MemoryConflictError, MemoryService
from minicode.observability import AuditStore, EvalCase, EvalRunner, TraceStore
from minicode.schemas.session import SessionState


def test_trace_store_is_append_only_filterable_and_tolerates_partial_tail(tmp_path):
    store = TraceStore(tmp_path / "trace.jsonl")
    first = store.append("model.started", {"turn": 1}, run_id="run-a")
    store.append("tool.finished", {"ok": True}, run_id="run-b")
    with store.path.open("a", encoding="utf-8") as stream:
        stream.write('{"incomplete":')

    records = store.read(run_id="run-a")

    assert [record["id"] for record in records] == [first["id"]]
    assert records[0]["payload"] == {"turn": 1}


def test_audit_store_redacts_details_before_persisting(tmp_path):
    store = AuditStore(tmp_path / "audit.jsonl")
    store.append_action(
        "tool.approved",
        actor="user",
        outcome="allowed",
        details={"DEEPSEEK_API_KEY": "top-secret"},
        run_id="run-a",
    )

    raw = store.path.read_text(encoding="utf-8")
    assert "top-secret" not in raw
    assert "Sensitive value redacted" in raw


def test_eval_runner_produces_repeatable_machine_readable_report(tmp_path):
    cases = [
        EvalCase("sum", {"values": [1, 2]}, {"total": 3}, ("regression",)),
        EvalCase("wrong", {"values": [2]}, {"total": 3}),
    ]
    runner = EvalRunner(lambda value: {"total": sum(value["values"])})

    report = runner.run(cases, tmp_path / "report.json")

    assert report.passed is False
    assert [result.passed for result in report.results] == [True, False]
    persisted = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    assert persisted["results"][0]["tags"] == ["regression"]


def test_memory_candidate_dedup_promotion_and_crud(tmp_path):
    memory = MemoryService(tmp_path / "memory")
    candidate_id = memory.propose_candidate("test-rule", "Always run pytest.", ["**/*.py"])
    assert candidate_id
    assert memory.propose_candidate("again", "Always run pytest.") == candidate_id

    rule_id = memory.promote_candidate(candidate_id)

    assert rule_id == candidate_id
    assert memory.get_memory(rule_id).status == "enabled"
    assert memory.retrieve("test", ["src/app.py"]) == "- Always run pytest."
    assert memory.update_memory(rule_id, content="Always run pytest -q.")
    assert "pytest -q" in memory.get_memory(rule_id).content
    assert memory.disable_memory(rule_id)
    assert memory.retrieve("test", ["src/app.py"]) == ""
    assert memory.delete_memory(rule_id)
    assert memory.get_memory(rule_id) is None


def test_memory_promotion_requires_explicit_conflict_replacement(tmp_path):
    memory = MemoryService(tmp_path / "memory")
    assert memory.store_rule("formatting", "Use black.")
    candidate_id = memory.propose_candidate("formatting", "Never use black.")

    with pytest.raises(MemoryConflictError) as error:
        memory.promote_candidate(candidate_id)
    assert error.value.conflicts == ["formatting"]

    promoted = memory.promote_candidate(candidate_id, replace_conflicts=True)
    assert memory.get_memory("formatting").status == "disabled"
    assert memory.get_memory("formatting").metadata["superseded_by"] == promoted
    assert memory.get_memory(promoted).status == "enabled"


def test_memory_candidate_rejects_sensitive_content(tmp_path):
    memory = MemoryService(tmp_path / "memory")
    assert memory.propose_candidate("secret", "TOKEN=top-secret-value") is None


def test_run_summary_is_idempotent_and_contains_only_bounded_conclusions(tmp_path):
    memory = MemoryService(tmp_path / "memory")
    session = SessionState(
        run_id="run-summary",
        task="修复 README 检索",
        status="completed",
        final_answer="已完成修复。" + "x" * 2_000,
        active_files=["README.md"],
    )

    assert memory.store_run_summary(session)
    assert memory.store_run_summary(session)

    summaries = [item for item in memory.list_memories() if item.category == "summaries"]
    assert len(summaries) == 1
    assert summaries[0].metadata["tier"] == "medium"
    assert "修复 README 检索" in summaries[0].content
    assert "README.md" in summaries[0].content
    assert len(summaries[0].content) < 1_500


def test_medium_memory_retention_expires_old_items_caps_count_and_protects_pinned(tmp_path):
    memory = MemoryService(tmp_path / "memory")
    now = datetime(2026, 8, 20, tzinfo=UTC)
    old = SessionState(run_id="old", task="过期任务", status="failed", final_answer="失败")
    pinned = SessionState(run_id="pinned", task="固定任务", status="completed", final_answer="保留")
    memory.store_run_summary(old, created_at=now - timedelta(days=31))
    memory.store_run_summary(pinned, created_at=now - timedelta(days=90), pinned=True)
    for index in range(202):
        session = SessionState(
            run_id=f"recent-{index}",
            task=f"近期任务 {index}",
            status="completed",
            final_answer="完成",
        )
        memory.store_run_summary(session, created_at=now - timedelta(minutes=index))

    removed = memory.enforce_retention(now=now, max_items=200, max_age_days=30)
    summaries = [item for item in memory.list_memories() if item.category == "summaries"]

    assert "old" in removed
    assert "pinned" not in removed
    assert memory.get_memory("pinned") is not None
    assert len([item for item in summaries if item.metadata.get("pinned") != "true"]) == 200
