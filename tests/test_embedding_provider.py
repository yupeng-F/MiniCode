from __future__ import annotations

import sys
from types import SimpleNamespace

import pytest

from minicode.memory import embedding as module


class FakeEmbeddings:
    def __init__(self, vectors: list[list[float]] | None = None, error: Exception | None = None) -> None:
        self.vectors = vectors or []
        self.error = error
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return SimpleNamespace(data=[SimpleNamespace(embedding=value) for value in self.vectors])


class FakeClient:
    def __init__(self, embeddings: FakeEmbeddings) -> None:
        self.embeddings = embeddings


class FakeProvider:
    def __init__(self, provider: str, vectors: list[list[float]], error: Exception | None = None) -> None:
        self.identity = module.EmbeddingIdentity(provider, f"{provider}-model", len(vectors[0]), provider == "aliyun")
        self.vectors = vectors
        self.error = error
        self.calls: list[list[str]] = []

    def embed_documents(self, texts):
        self.calls.append(list(texts))
        if self.error:
            raise self.error
        return self.vectors

    def embed_query(self, text):
        return self.embed_documents([text])[0]


def test_embedding_config_builds_workspace_compatible_url(monkeypatch):
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-key")
    monkeypatch.setenv("DASHSCOPE_WORKSPACE_ID", "ws-example")
    monkeypatch.setenv("DASHSCOPE_REGION", "cn-beijing")
    monkeypatch.delenv("DASHSCOPE_BASE_URL", raising=False)

    config = module.EmbeddingConfig.from_environment(load_dotenv_file=False)

    assert config.remote_base_url == "https://ws-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
    assert config.remote_model == "qwen3.7-text-embedding"
    assert config.remote_dimension == 1024


def test_embedding_config_uses_public_url_without_workspace(monkeypatch):
    monkeypatch.setenv("DASHSCOPE_API_KEY", "test-key")
    monkeypatch.delenv("DASHSCOPE_WORKSPACE_ID", raising=False)
    monkeypatch.delenv("DASHSCOPE_BASE_URL", raising=False)

    config = module.EmbeddingConfig.from_environment(load_dotenv_file=False)

    assert config.remote_base_url == "https://dashscope.aliyuncs.com/compatible-mode/v1"


def test_aliyun_provider_calls_expected_model_and_validates_dimension():
    embeddings = FakeEmbeddings([[0.1] * 1024])
    provider = module.AliyunEmbeddingProvider(
        api_key="test-key",
        base_url="https://workspace.example/compatible-mode/v1",
        client=FakeClient(embeddings),
    )

    result = provider.embed_query("Harness 工程底座")

    assert len(result) == 1024
    assert embeddings.calls == [{"model": "qwen3.7-text-embedding", "input": ["Harness 工程底座"]}]

    wrong = module.AliyunEmbeddingProvider(
        api_key="test-key",
        base_url="https://workspace.example/compatible-mode/v1",
        client=FakeClient(FakeEmbeddings([[0.1] * 8])),
    )
    with pytest.raises(module.EmbeddingDimensionError):
        wrong.embed_query("维度错误")


def test_aliyun_client_disables_sdk_retries(monkeypatch):
    created_kwargs = {}

    def create_client(**kwargs):
        created_kwargs.update(kwargs)
        return FakeClient(FakeEmbeddings())

    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=create_client))

    module.AliyunEmbeddingProvider("key", "https://example.test")

    assert created_kwargs["timeout"] == 8.0
    assert created_kwargs["max_retries"] == 0


def test_embedding_router_falls_back_to_local_after_remote_failure():
    remote = FakeProvider("aliyun", [[0.1] * 1024], error=TimeoutError("timeout"))
    local = FakeProvider("local", [[0.2] * 512])
    router = module.EmbeddingRouter(remote=remote, local=local)

    result = router.embed_query("检索项目记忆")

    assert result.identity.provider == "local"
    assert result.fallback_reason == "aliyun: timeout"
    assert result.external_transfer is True
    assert len(result.vector) == 512


def test_embedding_router_never_sends_sensitive_content_to_remote():
    remote = FakeProvider("aliyun", [[0.1] * 1024])
    local = FakeProvider("local", [[0.2] * 512])
    router = module.EmbeddingRouter(remote=remote, local=local)

    result = router.embed_query("DASHSCOPE_API_KEY=secret-value")

    assert remote.calls == []
    assert local.calls == [["DASHSCOPE_API_KEY=secret-value"]]
    assert result.fallback_reason == "检测到敏感内容，未发送到远程 embedding"


def test_remote_document_embedding_rejects_sensitive_text():
    remote = FakeProvider("aliyun", [[0.1] * 1024])
    local = FakeProvider("local", [[0.2] * 512])
    router = module.EmbeddingRouter(remote=remote, local=local)

    with pytest.raises(module.SensitiveEmbeddingContent):
        router.embed_documents(remote.identity, ["DASHSCOPE_API_KEY=secret"])

    assert remote.calls == []


def test_embedding_router_reports_unavailable_when_no_provider_can_run():
    router = module.EmbeddingRouter(remote=None, local=None)

    with pytest.raises(module.EmbeddingUnavailable):
        router.embed_query("普通查询")


class FakeLocalModel:
    def embed(self, texts):
        return [[0.25] * 512 for _ in texts]


def test_local_provider_refuses_to_download_during_normal_run(tmp_path):
    factory_calls = []

    def factory(**kwargs):
        factory_calls.append(kwargs)
        return FakeLocalModel()

    with pytest.raises(module.EmbeddingUnavailable, match="尚未安装"):
        module.LocalEmbeddingProvider(tmp_path / "models", model_factory=factory)

    assert factory_calls == []


def test_local_provider_loads_only_after_install_marker_exists(tmp_path):
    cache_dir = tmp_path / "models"
    marker = module.local_embedding_marker(cache_dir)
    marker.parent.mkdir(parents=True)
    marker.write_text("ready", encoding="utf-8")
    factory_calls = []

    def factory(**kwargs):
        factory_calls.append(kwargs)
        return FakeLocalModel()

    provider = module.LocalEmbeddingProvider(cache_dir, model_factory=factory)
    vector = provider.embed_query("本地检索")

    assert len(vector) == 512
    assert factory_calls == [{
        "model_name": "BAAI/bge-small-zh-v1.5",
        "cache_dir": str(cache_dir),
        "local_files_only": True,
    }]


def test_explicit_local_install_writes_marker_after_model_load(tmp_path):
    cache_dir = tmp_path / "models"
    factory_calls = []

    def factory(**kwargs):
        factory_calls.append(kwargs)
        return FakeLocalModel()

    marker = module.install_local_embedding(cache_dir, model_factory=factory)

    assert marker.is_file()
    assert factory_calls == [{
        "model_name": "BAAI/bge-small-zh-v1.5",
        "cache_dir": str(cache_dir),
        "local_files_only": False,
    }]


def test_cli_explicitly_installs_local_embedding(monkeypatch, tmp_path, capsys):
    from minicode.interfaces import cli

    calls = []

    def install(cache_dir):
        calls.append(cache_dir)
        marker = cache_dir / "BAAI__bge-small-zh-v1.5" / ".ready"
        marker.parent.mkdir(parents=True)
        marker.write_text("ready", encoding="utf-8")
        return marker

    monkeypatch.setattr(cli, "install_local_embedding", install)

    cli.main(["memory", "setup-local-embedding", "--cache-dir", str(tmp_path / "models")])

    assert calls == [tmp_path / "models"]
    assert "本地 embedding 已安装" in capsys.readouterr().out


def test_router_construction_failure_degrades_instead_of_breaking_run(monkeypatch, tmp_path):
    def fail_remote(**kwargs):
        raise ImportError("SOCKS 代理依赖缺失")

    monkeypatch.setattr(module, "AliyunEmbeddingProvider", fail_remote)
    config = module.EmbeddingConfig(
        api_key="configured-key",
        local_cache_dir=tmp_path / "models",
    )

    router = module.build_embedding_router(config)

    with pytest.raises(module.EmbeddingUnavailable, match="SOCKS 代理依赖缺失"):
        router.embed_query("普通查询仍应退回 FTS")


def test_router_construction_captures_unexpected_local_initialization_failure(monkeypatch, tmp_path):
    def fail_local(**kwargs):
        raise RuntimeError("损坏的本地模型缓存")

    monkeypatch.setattr(module, "LocalEmbeddingProvider", fail_local)

    router = module.build_embedding_router(
        module.EmbeddingConfig(local_cache_dir=tmp_path / "models")
    )

    with pytest.raises(module.EmbeddingUnavailable, match="损坏的本地模型缓存"):
        router.embed_query("普通查询仍应退回 FTS")
