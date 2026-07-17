from __future__ import annotations

from types import SimpleNamespace

import pytest

from minicode.engine.model_factory import ModelConfigurationError, ModelFactory
from minicode.engine.providers.deepseek import DeepSeekModelClient, ProviderResponseError, build_openai_tools
from minicode.schemas.tool import ToolCall, ToolCallRecord, ToolResult, ToolSpec


class _Function:
    name = "read_file"
    arguments = '{"path":"README.md","limit":10}'


class _ToolCall:
    id = "call-123"
    function = _Function()


class _Message:
    content = ""
    tool_calls = [_ToolCall()]


class _Choice:
    message = _Message()


class _Response:
    choices = [_Choice()]


class _Completions:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return _Response()


class _Client:
    def __init__(self) -> None:
        self.chat = type("Chat", (), {"completions": _Completions()})()


def test_build_openai_tools_converts_tool_spec_schema():
    tools = build_openai_tools([
        ToolSpec(
            name="read_file",
            description="Read one workspace file.",
            input_schema={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        )
    ])

    assert tools == [{
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read one workspace file.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    }]


def test_deepseek_client_converts_first_tool_call_to_model_response():
    client = _Client()
    model = DeepSeekModelClient(api_key="test-key", client=client)

    result = model.complete("Inspect README", [
        {
            "name": "read_file",
            "description": "Read a file",
            "input_schema": {"type": "object", "properties": {}},
        }
    ])

    assert result.type == "tool_use"
    assert result.tool_call is not None
    assert result.tool_call.tool_name == "read_file"
    assert result.tool_call.call_id == "call-123"
    assert result.tool_call.arguments == {"path": "README.md", "limit": 10}
    request = client.chat.completions.calls[0]
    assert request["model"] == "deepseek-v4-flash"
    assert request["tools"][0]["function"]["name"] == "read_file"


def test_deepseek_client_converts_text_response_to_final_answer():
    response = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content="Repository inspected.", tool_calls=[]))]
    )

    result = DeepSeekModelClient._to_model_response(response)

    assert result.type == "final"
    assert result.content == "Repository inspected."


def test_deepseek_client_sends_native_assistant_and_tool_history():
    client = _Client()
    model = DeepSeekModelClient(api_key="test-key", client=client)
    call = ToolCall(tool_name="read_file", call_id="call-history", arguments={"path": "README.md"})
    record = ToolCallRecord(
        call_id=call.call_id,
        tool_name=call.tool_name,
        request=call,
        status="succeeded",
        result=ToolResult(
            call_id=call.call_id,
            tool_name=call.tool_name,
            success=True,
            summary="Read README.md",
            preview="# MiniCode",
            metadata={"next_offset": None},
        ),
    )

    model.complete("Inspect README", [], tool_history=[record])

    messages = client.chat.completions.calls[0]["messages"]
    assert [message["role"] for message in messages] == ["system", "user", "assistant", "tool"]
    assert messages[2]["tool_calls"][0]["id"] == "call-history"
    assert messages[2]["tool_calls"][0]["function"]["name"] == "read_file"
    assert messages[3]["tool_call_id"] == "call-history"
    assert "Read README.md" in messages[3]["content"]
    assert "# MiniCode" in messages[3]["content"]


def test_deepseek_client_rejects_invalid_tool_arguments():
    response = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(
            content="",
            tool_calls=[SimpleNamespace(
                id="call-123",
                function=SimpleNamespace(name="read_file", arguments="not-json"),
            )],
        ))]
    )

    with pytest.raises(ProviderResponseError, match="invalid tool-call arguments"):
        DeepSeekModelClient._to_model_response(response)


def test_model_factory_requires_deepseek_key(monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.setenv("MINICODE_MODEL_PROVIDER", "deepseek")

    with pytest.raises(ModelConfigurationError, match="DEEPSEEK_API_KEY"):
        ModelFactory.from_environment(load_dotenv_file=False)


def test_model_factory_builds_deepseek_client_from_environment(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setenv("MINICODE_MODEL_PROVIDER", "deepseek")
    monkeypatch.setenv("MINICODE_MODEL", "deepseek-v4-flash")
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")

    model = ModelFactory.from_environment(load_dotenv_file=False)

    assert isinstance(model, DeepSeekModelClient)
    assert model.model == "deepseek-v4-flash"
    assert model.base_url == "https://api.deepseek.com"
