from __future__ import annotations

from multi_agents.llm import agent_helper
from multi_agents.schemas.agent import AgentDecision
from multi_agents.schemas.state import AgentInput


def run_execution(input: AgentInput) -> AgentDecision:
    """Implement changes via LLM-driven tool requests."""
    return agent_helper.call_llm_decision("coder", input)
