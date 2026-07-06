from __future__ import annotations

from multi_agents.llm import agent_helper
from multi_agents.schemas.agent import AgentDecision
from multi_agents.schemas.state import AgentInput


def review_result(input: AgentInput) -> AgentDecision:
    """Review implementation results via LLM."""
    return agent_helper.call_llm_decision("reviewer", input)
