from __future__ import annotations

from multi_agents.llm import agent_helper
from multi_agents.schemas.agent import AgentDecision
from multi_agents.schemas.state import AgentInput


def run_research(input: AgentInput) -> AgentDecision:
    """Collect repository context via LLM-driven tool requests."""
    return agent_helper.call_llm_decision("repo_explorer", input)
