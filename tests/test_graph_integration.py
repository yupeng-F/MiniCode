"""Integration tests for LangGraph StateGraph Master-Specialist routing.

Each test mocks call_llm_decision to return canned AgentDecision responses,
verifying that the graph routes correctly based on Master Agent dispatch decisions.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from langgraph.graph.state import CompiledStateGraph

from multi_agents.orchestrator.graph import compile_graph, initialize_state
from multi_agents.schemas.agent import AgentDecision

# ── Master Agent 调度决策 ────────────────────────────

MOCK_MASTER_PLAN = AgentDecision(
    agent_name="master",
    summary="Task received, planning",
    next_action="handoff",
    update_fields={
        "plan": ["Step 1: Explore", "Step 2: Implement", "Step 3: Review", "Step 4: Test"],
        "current_stage": "planning",
        "master_dispatch": {
            "next_agent": "explorer",
            "context_for_agent": {"task": "Explore the codebase", "context": "", "plan_steps": ["Step 1: Explore"]},
            "reasoning": "Need to explore first",
            "stage": "exploring",
            "task_complete": False,
            "final_answer": "",
        },
    },
)

MOCK_MASTER_AFTER_EXPLORER = AgentDecision(
    agent_name="master",
    summary="Context gathered, dispatching coder",
    next_action="handoff",
    update_fields={
        "current_stage": "implementing",
        "master_dispatch": {
            "next_agent": "coder",
            "context_for_agent": {"task": "Implement the feature", "context": "Code structure understood", "plan_steps": ["Step 2: Implement"]},
            "reasoning": "Context ready, proceed to implementation",
            "stage": "implementing",
            "task_complete": False,
            "final_answer": "",
        },
    },
)

MOCK_MASTER_AFTER_CODER = AgentDecision(
    agent_name="master",
    summary="Implementation done, dispatching reviewer",
    next_action="handoff",
    update_fields={
        "current_stage": "reviewing",
        "master_dispatch": {
            "next_agent": "reviewer",
            "context_for_agent": {"task": "Review the changes", "context": "Code has been modified", "plan_steps": ["Step 3: Review"]},
            "reasoning": "Implementation complete, needs review",
            "stage": "reviewing",
            "task_complete": False,
            "final_answer": "",
        },
    },
)

MOCK_MASTER_AFTER_REVIEWER = AgentDecision(
    agent_name="master",
    summary="Review passed, testing",
    next_action="handoff",
    update_fields={
        "current_stage": "testing",
        "master_dispatch": {
            "next_agent": "tester",
            "context_for_agent": {"task": "Run tests", "context": "Changes reviewed and approved", "plan_steps": ["Step 4: Test"]},
            "reasoning": "Review passed, now test",
            "stage": "testing",
            "task_complete": False,
            "final_answer": "",
        },
    },
)

MOCK_MASTER_AFTER_TESTER = AgentDecision(
    agent_name="master",
    summary="All done",
    next_action="handoff",
    update_fields={
        "current_stage": "finalizing",
        "master_dispatch": {
            "next_agent": "memory_writer",
            "context_for_agent": {"task": "Save task experience", "context": "Task completed successfully", "plan_steps": []},
            "reasoning": "Task complete, save memory",
            "stage": "finalizing",
            "task_complete": False,
            "final_answer": "",
        },
    },
)

MOCK_MASTER_DONE = AgentDecision(
    agent_name="master",
    summary="Task complete",
    next_action="handoff",
    update_fields={
        "current_stage": "completed",
        "master_dispatch": {
            "next_agent": None,
            "context_for_agent": {},
            "reasoning": "All steps completed",
            "stage": "completed",
            "task_complete": True,
            "final_answer": "Implementation completed successfully.",
        },
    },
)

# ── Specialist 响应 ──────────────────────────────────

MOCK_EXPLORER = AgentDecision(
    agent_name="repo_explorer", summary="Context gathered", next_action="handoff",
    update_fields={
        "agent_contexts": {"repo_explorer": {"summary": "Found relevant files", "candidate_files": ["main.py"]}},
        "current_stage": "repository_exploration",
    },
)
MOCK_CODER = AgentDecision(
    agent_name="coder", summary="Implementation complete", next_action="handoff",
    update_fields={"current_stage": "implementation"},
)
MOCK_REVIEWER_PASS = AgentDecision(
    agent_name="reviewer", summary="Review OK", next_action="handoff",
    update_fields={"current_stage": "review", "review_notes": ["All OK."]},
)
MOCK_REVIEWER_RETRY = AgentDecision(
    agent_name="reviewer", summary="Issues found", next_action="retry",
    update_fields={"current_stage": "review", "review_notes": ["Fix needed."]},
)
MOCK_TESTER_PASS = AgentDecision(
    agent_name="tester", summary="Tests OK", next_action="handoff",
    update_fields={"current_stage": "testing", "test_summary": ["Passed."]},
)
MOCK_MEMORY = AgentDecision(
    agent_name="memory_manager", summary="Memory saved", next_action="handoff",
    update_fields={"current_stage": "memory_writeback", "memory_refs": ["mem-1"]},
)


def _make_mock_decision(master_sequence: list[AgentDecision] | None = None):
    """Create a stateful mock that returns canned decisions based on agent name.

    Master Agent returns decisions from master_sequence in order.
    Other agents return fixed responses by name.
    """
    if master_sequence is None:
        master_sequence = [
            MOCK_MASTER_PLAN,
            MOCK_MASTER_AFTER_EXPLORER,
            MOCK_MASTER_AFTER_CODER,
            MOCK_MASTER_AFTER_REVIEWER,
            MOCK_MASTER_AFTER_TESTER,
            MOCK_MASTER_DONE,
        ]
    master_index = [0]  # mutable index for closure

    def _mock_decision(agent_name: str, _input) -> AgentDecision:
        if agent_name == "master":
            idx = master_index[0]
            if idx < len(master_sequence):
                master_index[0] += 1
                return master_sequence[idx]
            return MOCK_MASTER_DONE

        mapping = {
            "repo_explorer": MOCK_EXPLORER,
            "coder": MOCK_CODER,
            "reviewer": MOCK_REVIEWER_PASS,
            "tester": MOCK_TESTER_PASS,
            "memory_manager": MOCK_MEMORY,
        }
        return mapping.get(
            agent_name,
            AgentDecision(agent_name=agent_name, summary="", next_action="handoff"),
        )

    return _mock_decision


@pytest.fixture
def app() -> CompiledStateGraph:
    return compile_graph()


def _run_to_completion(app, state, config=None):
    """Run graph to completion with mocked LLM and collect final state."""
    if config is None:
        config = {"configurable": {"thread_id": "test"}}
    mock_fn = _make_mock_decision()
    with patch("multi_agents.llm.agent_helper.call_llm_decision", side_effect=mock_fn):
        for _ in app.stream(state, config, stream_mode="values"):
            pass
    return app.get_state(config).values


# ── Tests ────────────────────────────────────────────


class TestMasterSpecialistGraph:
    """Tests for Master-Specialist routing."""

    def test_act_mode_completes_all_steps(self, app):
        """Act mode: master dispatches all specialists in sequence and completes."""
        state = initialize_state("Implement feature X", mode="act")
        final = _run_to_completion(app, state)
        assert final["status"] == "completed"
        assert final["current_stage"] == "final_response"
        assert len(final.get("plan", [])) > 0

    def test_master_agent_dispatch_set_in_state(self, app):
        """Master dispatch decisions are reflected in the graph state."""
        state = initialize_state("Build feature", mode="act")
        final = _run_to_completion(app, state)
        assert final.get("plan") is not None

    def test_specialist_context_passes_through_master(self, app):
        """Explorer context is available to Master for subsequent dispatch."""
        state = initialize_state("Implement feature", mode="act")
        final = _run_to_completion(app, state)
        ctx = final.get("agent_contexts", {})
        assert "repo_explorer" in ctx

    def test_retry_loop_via_master(self, app):
        """When reviewer requests retry, Master dispatches coder again."""
        config = {"configurable": {"thread_id": "retry-test"}}
        state = initialize_state("Implement feature", mode="act")

        # Master sequence with retry: after first coder run, reviewer says retry,
        # so Master dispatches coder again
        master_with_retry = [
            MOCK_MASTER_PLAN,  # 1: → explorer
            MOCK_MASTER_AFTER_EXPLORER,  # 2: → coder
            MOCK_MASTER_AFTER_CODER,  # 3: → reviewer
            # Reviewer returns retry at this point (see mock)
            AgentDecision(  # 4: master decides to retry coder
                agent_name="master", summary="Issues found, retrying",
                next_action="handoff",
                update_fields={
                    "current_stage": "implementing",
                    "master_dispatch": {
                        "next_agent": "coder",
                        "context_for_agent": {"task": "Fix review issues", "context": "Reviewer found issues", "plan_steps": ["Step 2: Implement"]},
                        "reasoning": "Need to fix review findings",
                        "stage": "implementing",
                        "task_complete": False,
                    },
                },
            ),
            MOCK_MASTER_AFTER_CODER,  # 5: → reviewer again
            MOCK_MASTER_AFTER_REVIEWER,  # 6: → tester
            MOCK_MASTER_AFTER_TESTER,  # 7: → memory_writer
            MOCK_MASTER_DONE,  # 8: done
        ]

        mock_fn = _make_mock_decision(master_with_retry)

        # Override reviewer to always retry on first call
        retry_tracker = {"count": 0}

        def side_effect(name, inp):
            if name == "reviewer" and retry_tracker["count"] < 1:
                retry_tracker["count"] += 1
                return MOCK_REVIEWER_RETRY
            return mock_fn(name, inp)

        with patch("multi_agents.llm.agent_helper.call_llm_decision", side_effect=side_effect):
            for _ in app.stream(state, config, stream_mode="values"):
                pass

        final = app.get_state(config).values
        assert final["status"] == "completed"

    def test_ask_mode_goes_direct_to_finalize(self, app):
        """Ask mode: master dispatches explorer then finalizes."""
        config = {"configurable": {"thread_id": "ask-test"}}
        state = initialize_state("What does this do?", mode="ask")

        mock_fn = _make_mock_decision([
            MOCK_MASTER_PLAN,  # → explorer
            MOCK_MASTER_DONE,  # → done (next_agent = null)
        ])

        with patch("multi_agents.llm.agent_helper.call_llm_decision", side_effect=mock_fn):
            for _ in app.stream(state, config, stream_mode="values"):
                pass

        final = app.get_state(config).values
        assert final["status"] == "completed"
