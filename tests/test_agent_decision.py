"""Tests for agent decision functions with mocked LLM calls."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from multi_agents.schemas.agent import AgentDecision
from multi_agents.schemas.state import AgentInput
from multi_agents.schemas.tool import ToolRequest, ToolResult

# Default mock return: handoff with plan
MOCK_PLANNER_RETURN = AgentDecision(
    agent_name="planner",
    summary="Planned: test feature",
    next_action="handoff",
    update_fields={
        "plan": ["Step 1", "Step 2"],
        "success_criteria": ["Tests pass"],
        "current_stage": "planning",
    },
)

MOCK_EXPLORER_RETURN = AgentDecision(
    agent_name="repo_explorer",
    summary="Explored repository",
    next_action="handoff",
    update_fields={
        "agent_contexts": {
            "repo_explorer": {"summary": "Context gathered", "candidate_files": ["src/main.py"]},
        },
        "current_stage": "repository_exploration",
    },
)

MOCK_CODER_TOOL_RETURN = AgentDecision(
    agent_name="coder",
    summary="Requesting tool execution",
    next_action="request_tool",
    proposed_tool_request=ToolRequest(
        request_id="",
        agent_name="coder",
        mode="act",
        current_stage="implementation",
        tool_name="read_file",
        arguments={"path": "pyproject.toml"},
        intent_summary="Read project config",
        risk_level="low",
        side_effect=False,
        requires_approval=False,
    ),
    update_fields={"current_stage": "implementation"},
)

MOCK_CODER_HANDOFF_RETURN = AgentDecision(
    agent_name="coder",
    summary="Implementation complete",
    next_action="handoff",
    update_fields={"current_stage": "implementation"},
)

MOCK_REVIEWER_PASS_RETURN = AgentDecision(
    agent_name="reviewer",
    summary="Review passed",
    next_action="handoff",
    update_fields={
        "current_stage": "review",
        "review_notes": ["Review passed: all checks OK."],
    },
)

MOCK_REVIEWER_RETRY_RETURN = AgentDecision(
    agent_name="reviewer",
    summary="Review failed",
    next_action="retry",
    reasoning_notes=["Issue found"],
    update_fields={
        "current_stage": "review",
        "review_notes": ["Review failed: Error"],
    },
)

MOCK_TESTER_PASS_RETURN = AgentDecision(
    agent_name="tester",
    summary="Tests passed",
    next_action="handoff",
    update_fields={
        "current_stage": "testing",
        "test_summary": ["All checks passed."],
    },
)

MOCK_TESTER_RETRY_RETURN = AgentDecision(
    agent_name="tester",
    summary="Tests failed",
    next_action="retry",
    update_fields={
        "current_stage": "testing",
        "test_summary": ["Test failed."],
    },
)

MOCK_MEMORY_RETURN = AgentDecision(
    agent_name="memory_manager",
    summary="Memory written",
    next_action="handoff",
    update_fields={
        "current_stage": "memory_writeback",
        "memory_refs": ["memory-write-placeholder"],
    },
)


@pytest.fixture
def agent_input() -> AgentInput:
    return AgentInput(
        thread_id="test-thread",
        run_id="test-run",
        agent_name="planner",
        mode="act",
        current_stage="planning",
        task_goal="Implement a test feature",
        constraints=["Only edit files in src/"],
        success_criteria=["Tests pass"],
        relevant_plan_steps=["Step 1", "Step 2"],
        context_bundle={},
        task_memory=[],
        available_tools=[],
        recent_tool_results=[],
    )


# --- Planner tests ---

@patch("multi_agents.llm.agent_helper.call_llm_decision", return_value=MOCK_PLANNER_RETURN)
def test_planner_returns_agent_decision(mock_call, agent_input):
    from multi_agents.agents.planner import plan_task
    decision = plan_task(agent_input)
    assert decision.agent_name == "planner"
    assert decision.next_action == "handoff"
    assert "plan" in decision.update_fields
    assert "current_stage" in decision.update_fields


# --- Researcher tests ---

@patch("multi_agents.llm.agent_helper.call_llm_decision", return_value=MOCK_EXPLORER_RETURN)
def test_researcher_returns_agent_decision(mock_call, agent_input):
    from multi_agents.agents.researcher import run_research
    decision = run_research(agent_input)
    assert decision.agent_name == "repo_explorer"
    assert decision.next_action == "handoff"
    assert "agent_contexts" in decision.update_fields


# --- Executor tests ---

@patch("multi_agents.llm.agent_helper.call_llm_decision", return_value=MOCK_CODER_TOOL_RETURN)
def test_executor_returns_tool_request(mock_call, agent_input):
    from multi_agents.agents.executor import run_execution
    decision = run_execution(agent_input)
    assert decision.agent_name == "coder"
    assert decision.next_action == "request_tool"
    assert decision.proposed_tool_request is not None
    assert decision.proposed_tool_request.tool_name == "read_file"


@patch("multi_agents.llm.agent_helper.call_llm_decision", return_value=MOCK_CODER_HANDOFF_RETURN)
def test_executor_handoff(mock_call, agent_input):
    from multi_agents.agents.executor import run_execution
    decision = run_execution(agent_input)
    assert decision.next_action == "handoff"


# --- Reviewer tests ---

@patch("multi_agents.llm.agent_helper.call_llm_decision", return_value=MOCK_REVIEWER_PASS_RETURN)
def test_reviewer_passes_good_results(mock_call, agent_input):
    from multi_agents.agents.reviewer import review_result
    agent_input["recent_tool_results"] = [
        ToolResult(request_id="r1", tool_name="read_file", success=True, summary="OK"),
    ]
    decision = review_result(agent_input)
    assert decision.next_action == "handoff"


@patch("multi_agents.llm.agent_helper.call_llm_decision", return_value=MOCK_REVIEWER_RETRY_RETURN)
def test_reviewer_retries_failed_results(mock_call, agent_input):
    from multi_agents.agents.reviewer import review_result
    agent_input["recent_tool_results"] = [
        ToolResult(request_id="r1", tool_name="read_file", success=False, summary="Error"),
    ]
    decision = review_result(agent_input)
    assert decision.next_action == "retry"


# --- Tester tests ---

@patch("multi_agents.llm.agent_helper.call_llm_decision", return_value=MOCK_TESTER_PASS_RETURN)
def test_tester_passes(mock_call, agent_input):
    from multi_agents.agents.tester import run_testing
    agent_input["recent_tool_results"] = [
        ToolResult(request_id="r1", tool_name="read_file", success=True, summary="OK"),
    ]
    decision = run_testing(agent_input)
    assert decision.next_action == "handoff"


@patch("multi_agents.llm.agent_helper.call_llm_decision", return_value=MOCK_TESTER_RETRY_RETURN)
def test_tester_retries_on_failure(mock_call, agent_input):
    from multi_agents.agents.tester import run_testing
    agent_input["recent_tool_results"] = [
        ToolResult(request_id="r1", tool_name="read_file", success=False, summary="Error"),
    ]
    decision = run_testing(agent_input)
    assert decision.next_action == "retry"


# --- Memory writer test (no LLM needed, tests the actual function) ---

def test_memory_writer_returns_agent_decision(agent_input):
    from multi_agents.agents.memory_writer import write_memory
    decision = write_memory(agent_input)
    assert decision.agent_name == "memory_manager"
    assert decision.next_action == "handoff"
    assert "memory_refs" in decision.update_fields


# --- Agent node wrapper tests ---

def test_make_agent_node_wrapper():
    from multi_agents.agents.planner import plan_task
    from multi_agents.orchestrator.agent_node import make_agent_node
    from multi_agents.schemas.state import GraphState

    state = GraphState(
        thread_id="t1", run_id="r1", mode="act", status="running",
        current_stage="planning", current_agent="", retry_count={},
        user_input="test", task_goal="test", plan=[],
        messages=[], agent_contexts={},
        tool_requests=[], tool_results=[], artifacts=[],
        review_notes=[], test_summary=[],
        approval_pending=False, approval_context={},
        task_memory=[], memory_refs=[], final_answer="",
    )

    node_fn = make_agent_node(plan_task, "planner")
    with patch("multi_agents.llm.agent_helper.call_llm_decision", return_value=MOCK_PLANNER_RETURN):
        result = node_fn(state)

    assert result["current_agent"] == "planner"
    assert "last_decision" in result
    assert result["last_decision"]["next_action"] == "handoff"
    assert "plan" in result


# --- LLM fallback test ---

def test_fallback_when_llm_unavailable():
    """When LLM is unavailable, call_llm_decision should return a handoff decision."""
    from multi_agents.llm.agent_helper import call_llm_decision
    from multi_agents.schemas.state import AgentInput

    inp = AgentInput(task_goal="test")
    # No API key set, so LLM will fail -> fallback
    with patch.dict("os.environ", {}, clear=True):
        decision = call_llm_decision("planner", inp)

    assert decision.agent_name == "planner"
    assert decision.next_action == "handoff"
    assert "No system prompt" in decision.summary or "[Fallback]" in decision.summary


def test_fallback_when_llm_unavailable_with_prompt():
    """When LLM is unavailable but prompt exists, should still fallback with [Fallback]."""
    from multi_agents.llm.agent_helper import call_llm_decision
    from multi_agents.schemas.state import AgentInput

    inp = AgentInput(task_goal="test")
    with patch.dict("os.environ", {}, clear=True):
        decision = call_llm_decision("master", inp)

    assert decision.agent_name == "master"
    assert decision.next_action == "handoff"
    assert "[Fallback]" in decision.summary


# ── validate_decision tests ──────────────────────────


def test_validate_decision_passes_valid_data():
    """Valid data should pass through unchanged."""
    from multi_agents.llm.agent_helper import validate_decision

    data = {
        "agent_name": "coder",
        "summary": "Reading file",
        "next_action": "request_tool",
        "proposed_tool_request": {
            "tool_name": "read_file",
            "arguments": {"path": "foo.py"},
        },
    }
    result = validate_decision("coder", data)

    assert result["next_action"] == "request_tool"
    assert result["proposed_tool_request"]["tool_name"] == "read_file"


def test_validate_decision_fills_missing_agent_name():
    """Missing agent_name should be filled."""
    from multi_agents.llm.agent_helper import validate_decision

    result = validate_decision("explorer", {"summary": "hi"})
    assert result["agent_name"] == "explorer"


def test_validate_decision_fills_missing_next_action():
    """Missing next_action should default to 'handoff'."""
    from multi_agents.llm.agent_helper import validate_decision

    result = validate_decision("master", {"agent_name": "master"})
    assert result["next_action"] == "handoff"


def test_validate_decision_fixes_invalid_next_action():
    """Invalid next_action should be reset to 'handoff'."""
    from multi_agents.llm.agent_helper import validate_decision

    result = validate_decision("coder", {"next_action": "fly_to_moon"})
    assert result["next_action"] == "handoff"


def test_validate_decision_discards_tool_request_without_name():
    """Tool request missing tool_name should be discarded."""
    from multi_agents.llm.agent_helper import validate_decision

    data = {
        "next_action": "request_tool",
        "proposed_tool_request": {"arguments": {"path": "foo.py"}},
    }
    result = validate_decision("coder", data)
    assert result["proposed_tool_request"] is None


def test_validate_decision_fills_tool_request_defaults():
    """Tool request should get default values for optional fields."""
    from multi_agents.llm.agent_helper import validate_decision

    data = {
        "next_action": "request_tool",
        "proposed_tool_request": {"tool_name": "read_file"},
    }
    result = validate_decision("coder", data)
    tr = result["proposed_tool_request"]
    assert tr["risk_level"] == "low"
    assert tr["side_effect"] is False
    assert tr["requires_approval"] is False


def test_validate_decision_fixes_invalid_master_dispatch():
    """Invalid master_dispatch.next_agent should be reset to None."""
    from multi_agents.llm.agent_helper import validate_decision

    data = {
        "agent_name": "master",
        "update_fields": {
            "master_dispatch": {"next_agent": "hacker"},
        },
    }
    result = validate_decision("master", data)
    dispatch = result["update_fields"]["master_dispatch"]
    assert dispatch["next_agent"] is None


def test_validate_decision_passes_valid_master_dispatch():
    """Valid master_dispatch.next_agent should pass through."""
    from multi_agents.llm.agent_helper import validate_decision

    data = {
        "agent_name": "master",
        "update_fields": {
            "master_dispatch": {"next_agent": "coder"},
        },
    }
    result = validate_decision("master", data)
    assert result["update_fields"]["master_dispatch"]["next_agent"] == "coder"
