"""Shared helper for agents to call LLM and get AgentDecision."""

from __future__ import annotations

import json
import logging

from multi_agents.llm.client import LLMClient
from multi_agents.llm.prompts import SYSTEM_PROMPTS
from multi_agents.schemas.agent import AgentDecision
from multi_agents.schemas.state import AgentInput
from multi_agents.schemas.tool import ToolRequest

logger = logging.getLogger(__name__)


def format_agent_input_for_prompt(input: AgentInput) -> str:
    """Format AgentInput into a readable text prompt."""
    parts = [f"## Task Goal\n{input.get('task_goal', '')}"]

    constraints = input.get("constraints", [])
    if constraints:
        parts.append("## Constraints\n" + "\n".join(f"- {c}" for c in constraints))

    criteria = input.get("success_criteria", [])
    if criteria:
        parts.append("## Success Criteria\n" + "\n".join(f"- {c}" for c in criteria))

    steps = input.get("relevant_plan_steps", [])
    if steps:
        parts.append("## Plan Steps\n" + "\n".join(f"- {s}" for s in steps))

    ctx = input.get("context_bundle", {})
    if ctx:
        parts.append(f"## Context Bundle\n{json.dumps(ctx, ensure_ascii=False, indent=2)}")

    mem = input.get("task_memory", [])
    if mem:
        parts.append("## Task Memory\n" + "\n".join(f"- {m}" for m in mem))

    results = input.get("recent_tool_results", [])
    if results:
        parts.append("## Recent Tool Results")
        for r in results:
            preview = ""
            if r.stdout_preview:
                preview = f", preview={r.stdout_preview[:200]}"
            parts.append(f"- {r.tool_name}: success={r.success}, summary={r.summary}{preview}")

    tools = input.get("available_tools", [])
    if tools:
        parts.append("## Available Tools\n" + "\n".join(f"- {t}" for t in tools))

    return "\n".join(parts)


_llm_client: LLMClient | None = None


def get_llm_client() -> LLMClient:
    global _llm_client
    if _llm_client is None:
        _llm_client = LLMClient()
    return _llm_client


# ── 输出校验 ────────────────────────────────────────

VALID_NEXT_ACTIONS = {
    "continue", "request_tool", "handoff", "retry", "finalize", "need_approval",
}

VALID_SPECIALISTS = {"explorer", "coder", "reviewer", "tester", "memory_writer", None}


def validate_decision(agent_name: str, data: dict) -> dict:
    """校验并补全 LLM 返回的 AgentDecision 数据。

    目标：不让 LLM 的格式问题导致整条输出被丢弃，
    而是尽可能补全和修正，仅在关键字段缺失时才走 fallback。
    """
    # 1. 补全必填字段
    data.setdefault("agent_name", agent_name)
    data.setdefault("summary", "")
    if "next_action" not in data:
        data["next_action"] = "handoff"

    # 2. 校验 next_action 合法性
    action = data["next_action"]
    if action not in VALID_NEXT_ACTIONS:
        logger.warning("Agent '%s': invalid next_action '%s', reset to 'handoff'", agent_name, action)
        data["next_action"] = "handoff"

    # 3. 校验 proposed_tool_request
    tr = data.get("proposed_tool_request")
    if isinstance(tr, dict):
        tr.setdefault("request_id", "")
        tr.setdefault("agent_name", agent_name)
        tr.setdefault("risk_level", "low")
        tr.setdefault("side_effect", False)
        tr.setdefault("requires_approval", False)
        if not tr.get("tool_name"):
            logger.warning("Agent '%s': tool_request missing tool_name, discarding request", agent_name)
            data["proposed_tool_request"] = None

    # 4. 校验 update_fields.master_dispatch
    uf = data.get("update_fields", {})
    if isinstance(uf, dict):
        dispatch = uf.get("master_dispatch", {})
        if isinstance(dispatch, dict):
            next_agent = dispatch.get("next_agent")
            if next_agent is not None and next_agent not in VALID_SPECIALISTS:
                logger.warning(
                    "Agent '%s': invalid master_dispatch.next_agent '%s', reset to None",
                    agent_name, next_agent,
                )
                dispatch["next_agent"] = None

    return data


def _llm_call_with_retry(messages: list[dict], agent_name: str) -> dict | None:
    """调用 LLM 并解析 JSON，失败时重试一次。返回 dict 或 None。"""
    client = get_llm_client()
    for attempt in range(2):
        try:
            data = client.chat_json(messages)
            if isinstance(data, dict):
                return data
        except Exception as e:
            logger.warning(
                "LLM call failed for '%s' (attempt %d/2): %s",
                agent_name, attempt + 1, e,
            )
    return None


def call_llm_decision(agent_name: str, input: AgentInput) -> AgentDecision:
    """Call the LLM with a role-specific system prompt and return an AgentDecision.

    Uses validate_decision() to fix common LLM output problems
    (missing fields, invalid values) before constructing the AgentDecision.
    Falls back to a placeholder decision if all attempts fail.
    """
    system_prompt = SYSTEM_PROMPTS.get(agent_name)
    if not system_prompt:
        return AgentDecision(
            agent_name=agent_name,
            summary=f"No system prompt for '{agent_name}'.",
            next_action="handoff",
        )

    try:
        user_content = format_agent_input_for_prompt(input)
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ]

        # 调用 LLM 并解析 JSON（带一次重试）
        data = _llm_call_with_retry(messages, agent_name)
        if data is None:
            raise ValueError("LLM returned invalid JSON after retry")

        data["agent_name"] = agent_name

        # 校验并补全输出
        data = validate_decision(agent_name, data)

        # 将 ToolRequest dict 转为 Pydantic 对象
        tr = data.get("proposed_tool_request")
        if isinstance(tr, dict):
            data["proposed_tool_request"] = ToolRequest(**tr)

        return AgentDecision(**data)

    except Exception as e:
        logger.warning("LLM call failed for '%s': %s. Using fallback decision.", agent_name, e)
        return AgentDecision(
            agent_name=agent_name,
            summary=f"[Fallback] LLM unavailable: {e}",
            next_action="handoff",
        )
