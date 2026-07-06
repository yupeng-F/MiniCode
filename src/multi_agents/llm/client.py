"""OpenAI-compatible LLM client for Alibaba Cloud Bailian (DashScope)."""

from __future__ import annotations

import json
import os
from typing import Any

from openai import OpenAI

from multi_agents.config import AppConfig

DEFAULT_MODEL = "qwen3.7-plus"
DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"


def _get_api_key() -> str:
    """Resolve API key: config > env var."""
    try:
        cfg = AppConfig()
        key = cfg.llm_api_key
        if key:
            return key
    except Exception:
        pass
    key = os.environ.get("DASHSCOPE_API_KEY") or os.environ.get("OPENAI_API_KEY", "")
    if not key:
        raise ValueError(
            "LLM API key not found. Set DASHSCOPE_API_KEY environment variable "
            "or configure llm_api_key in AppConfig."
        )
    return key


def _get_model() -> str:
    try:
        cfg = AppConfig()
        if cfg.llm_model_name:
            return cfg.llm_model_name
    except Exception:
        pass
    return os.environ.get("LLM_MODEL", DEFAULT_MODEL)


def _get_base_url() -> str:
    try:
        cfg = AppConfig()
        if cfg.llm_base_url:
            return cfg.llm_base_url
    except Exception:
        pass
    return os.environ.get("LLM_BASE_URL", DEFAULT_BASE_URL)


class LLMClient:
    """Lightweight LLM client for agent decision making.

    Uses OpenAI-compatible API (Alibaba Cloud Bailian DashScope by default).
    """

    def __init__(
        self,
        model: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
    ) -> None:
        self.model = model or _get_model()
        self.client = OpenAI(
            api_key=api_key or _get_api_key(),
            base_url=base_url or _get_base_url(),
            timeout=60.0,
        )

    def chat(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.1,
        max_tokens: int = 4096,
        response_format: dict | None = None,
    ) -> str:
        """Send a chat completion request and return the content string."""
        kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if response_format:
            kwargs["response_format"] = response_format

        resp = self.client.chat.completions.create(**kwargs)
        return resp.choices[0].message.content or ""

    def chat_json(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.1,
        max_tokens: int = 4096,
    ) -> dict[str, Any]:
        """Request JSON-mode response and parse into a dict."""
        content = self.chat(
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format={"type": "json_object"},
        )
        # Strip markdown code fences if present
        content = content.strip()
        if content.startswith("```"):
            content = content.split("\n", 1)[-1]
            content = content.rsplit("```", 1)[0].strip()
        return json.loads(content)
