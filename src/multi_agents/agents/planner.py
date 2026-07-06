from __future__ import annotations

from multi_agents.llm import agent_helper
from multi_agents.schemas.agent import AgentDecision
from multi_agents.schemas.state import AgentInput


def plan_task(input: AgentInput) -> AgentDecision:
    """Analyze task and produce a structured plan via LLM."""
    return agent_helper.call_llm_decision("planner", input)
