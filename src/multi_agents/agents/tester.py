from __future__ import annotations

from multi_agents.llm import agent_helper
from multi_agents.schemas.agent import AgentDecision
from multi_agents.schemas.state import AgentInput


def run_testing(input: AgentInput) -> AgentDecision:
    """Verify implementation via LLM."""
    return agent_helper.call_llm_decision("tester", input)
