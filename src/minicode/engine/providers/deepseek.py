from __future__ import annotations

import json
from typing import Any

from minicode.context.token_budget import Counter, TokenBudget
from minicode.context.token_counter import TokenCounter
from minicode.engine.model_client import ModelClient, ModelResponse
from minicode.memory.sensitive_data_filter import SensitiveDataFilter
from minicode.schemas.tool import ToolCall, ToolCallRecord


class ProviderResponseError(ValueError):
    pass


def build_openai_tools(tools: list[Any]) -> list[dict[str, Any]]:
    """Convert MiniCode's serializable tool specs to OpenAI-compatible tools."""
    return [
        {
            "type": "function",
            "function": {
                "name": str(_tool_value(tool, "name")),
                "description": str(_tool_value(tool, "description", "")),
                "parameters": _tool_value(tool, "input_schema", None) or {"type": "object", "properties": {}},
            },
        }
        for tool in tools
    ]


def _tool_value(tool: Any, key: str, default: Any = None) -> Any:
    if isinstance(tool, dict):
        return tool.get(key, default)
    return getattr(tool, key, default)


class DeepSeekModelClient(ModelClient):
    """DeepSeek adapter using its OpenAI-compatible chat-completions API."""

    supports_native_tool_history = True

    def __init__(
        self,
        api_key: str,
        model: str = "deepseek-v4-flash",
        base_url: str = "https://api.deepseek.com",
        client: Any | None = None,
        token_counter: Counter | None = None,
        token_budget: TokenBudget | None = None,
    ) -> None:
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.token_counter = token_counter or TokenCounter()
        self.token_budget = token_budget or TokenBudget()
        if client is None:
            from openai import OpenAI

            client = OpenAI(api_key=api_key, base_url=self.base_url)
        self.client = client
        self.sensitive_filter = SensitiveDataFilter()

    def complete(
        self,
        context: str,
        tools: list[dict],
        tool_history: list[ToolCallRecord] | None = None,
    ) -> ModelResponse:
        request = {
            "model": self.model,
            "messages": self._build_messages(context, tool_history or []),
            "tools": build_openai_tools(tools),
            "max_tokens": self.token_budget.max_output_tokens,
        }
        self.token_budget.validate_input(request, counter=self.token_counter)
        response = self.client.chat.completions.create(**request)
        return self._to_model_response(response)

    def _build_messages(self, context: str, tool_history: list[ToolCallRecord]) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = [
            {
                "role": "system",
                "content": "You are MiniCode. Use a tool whenever repository evidence is needed. "
                "Never claim a tool action succeeded unless its result is present in the conversation. "
                "Do not repeat the same read-only tool call with identical arguments. "
                "For long files, continue with read_file metadata.next_offset instead of repeating the same offset. "
                "When a duplicate call is skipped, follow its recovery guidance and continue the task. "
                "If a requested project is empty, create a patch proposal instead of repeatedly listing its directory. "
                "After a successful code change and reasonable verification, return a final answer instead of continuing to inspect files.",
            },
            {"role": "user", "content": context},
        ]
        history = [record for record in tool_history[-8:] if record.result is not None]
        substantive = [record for record in history if record.result and record.result.preview]
        latest_substantive_id = substantive[-1].call_id if substantive else None
        for record in history:
            result = record.result
            if result is None:
                continue
            preview_limit = 12_000 if record.call_id == latest_substantive_id else 3_000
            preview = self.sensitive_filter.sanitize(result.preview)[:preview_limit]
            content = json.dumps(
                {
                    "success": result.success,
                    "summary": result.summary,
                    "preview": preview,
                    "metadata": result.metadata,
                    "modified_paths": result.modified_paths,
                    "artifact_ref": result.artifact_ref,
                },
                ensure_ascii=False,
            )
            assistant_message: dict[str, Any] = {
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "id": record.call_id,
                    "type": "function",
                    "function": {
                        "name": record.tool_name,
                        "arguments": json.dumps(record.request.arguments, ensure_ascii=False),
                    },
                }],
            }
            if record.request.reasoning_content:
                assistant_message["reasoning_content"] = record.request.reasoning_content
            messages.append(assistant_message)
            messages.append({"role": "tool", "tool_call_id": record.call_id, "content": content})
        return messages

    @staticmethod
    def _to_model_response(response: Any) -> ModelResponse:
        choices = getattr(response, "choices", None)
        if not choices:
            raise ProviderResponseError("DeepSeek returned no choices")
        message = choices[0].message
        tool_calls = getattr(message, "tool_calls", None) or []
        if tool_calls:
            call = tool_calls[0]
            try:
                arguments = json.loads(call.function.arguments or "{}")
            except json.JSONDecodeError as exc:
                raise ProviderResponseError("DeepSeek returned invalid tool-call arguments") from exc
            if not isinstance(arguments, dict):
                raise ProviderResponseError("DeepSeek tool-call arguments must be a JSON object")
            return ModelResponse(
                type="tool_use",
                tool_call=ToolCall(
                    call_id=str(call.id),
                    tool_name=str(call.function.name),
                    arguments=arguments,
                    reasoning_content=str(getattr(message, "reasoning_content", "") or ""),
                ),
            )
        return ModelResponse(type="final", content=str(getattr(message, "content", "") or ""))
