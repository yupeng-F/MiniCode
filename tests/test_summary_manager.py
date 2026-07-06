"""Tests for SummaryManager — LLM summarization + sliding window context compression."""

from __future__ import annotations

from multi_agents.memory.summary_manager import SummaryManager


def test_summarize_short_content_passthrough():
    sm = SummaryManager()
    text = "Short text"
    assert sm.summarize(text) == text


def test_summarize_truncates_when_no_llm():
    sm = SummaryManager(max_summary_length=20)
    long_text = "This is a very long text that should be truncated because there is no LLM available"
    result = sm.summarize(long_text)
    assert len(result) <= 21  # 20 + "…"
    assert result.endswith("…")


def test_compress_bundle_empty():
    sm = SummaryManager()
    assert sm.compress_bundle(None) == {}
    assert sm.compress_bundle({}) == {}


def test_compress_bundle_short_strings():
    sm = SummaryManager()
    bundle = {"key1": "short", "key2": "also short"}
    result = sm.compress_bundle(bundle, max_field_length=100)
    assert result == bundle


def test_compress_bundle_truncates_long_string():
    sm = SummaryManager(max_summary_length=20)
    bundle = {"long": "A" * 100 + " extra text"}
    result = sm.compress_bundle(bundle, max_field_length=20)
    assert len(result["long"]) <= 21


def test_slice_tool_results_empty():
    assert SummaryManager.slice_tool_results([]) == []


def test_slice_tool_results_keeps_all_when_under_limit():
    results = [make_result(f"ok-{i}", True) for i in range(3)]
    sliced = SummaryManager.slice_tool_results(results, max_items=5)
    assert len(sliced) == 3


def test_slice_tool_results_keeps_errors():
    ok = [make_result(f"ok-{i}", True) for i in range(5)]
    err = [make_result("err", False)]
    results = ok + err
    sliced = SummaryManager.slice_tool_results(results, max_items=5)
    # Should keep the error + 4 most recent ok results
    assert len(sliced) == 5
    assert any(not r.success for r in sliced)


def test_slice_tool_results_keeps_all_errors():
    """Errors are always preserved, even beyond max_items."""
    errors = [make_result(f"err-{i}", False) for i in range(7)]
    sliced = SummaryManager.slice_tool_results(errors, max_items=5)
    assert len(sliced) == 7  # all errors preserved
    assert all(not r.success for r in sliced)


def test_slice_plan():
    plan = [f"step-{i}" for i in range(10)]
    sliced = SummaryManager.slice_plan(plan, max_steps=3)
    assert sliced == ["step-0", "step-1", "step-2"]


def test_slice_plan_under_limit():
    plan = ["step-0", "step-1"]
    sliced = SummaryManager.slice_plan(plan, max_steps=5)
    assert sliced == plan


def test_slice_task_memory():
    memory = ["short"] * 20
    sliced = SummaryManager.slice_task_memory(memory, max_items=5)
    assert len(sliced) == 5


def test_slice_task_memory_truncates_long_items():
    memory = ["short", "A" * 500]
    sliced = SummaryManager.slice_task_memory(memory, max_items=5, max_item_length=10)
    assert len(sliced) == 2
    assert sliced[1].endswith("…")
    assert len(sliced[1]) <= 11


# ── helpers ────────────────────────────────────────────


def make_result(summary: str, success: bool) -> dict:
    from multi_agents.schemas.tool import ToolResult

    return ToolResult(
        request_id=f"req-{summary}",
        tool_name="test",
        summary=summary,
        success=success,
        result={},
        duration_ms=10,
    )
