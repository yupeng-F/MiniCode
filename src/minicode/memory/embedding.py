from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, Sequence

from dotenv import load_dotenv

from minicode.memory.sensitive_data_filter import SensitiveDataFilter


REMOTE_MODEL = "qwen3.7-text-embedding"
REMOTE_DIMENSION = 1024
LOCAL_MODEL = "BAAI/bge-small-zh-v1.5"
LOCAL_DIMENSION = 512


class EmbeddingUnavailable(RuntimeError):
    pass


class SensitiveEmbeddingContent(EmbeddingUnavailable):
    pass


class EmbeddingDimensionError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class EmbeddingIdentity:
    provider: str
    model: str
    dimension: int
    external_transfer: bool


@dataclass(frozen=True, slots=True)
class EmbeddingQueryResult:
    vector: list[float]
    identity: EmbeddingIdentity
    fallback_reason: str = ""


@dataclass(frozen=True, slots=True)
class EmbeddingConfig:
    api_key: str = ""
    workspace_id: str = ""
    region: str = "cn-beijing"
    base_url_override: str = ""
    remote_model: str = REMOTE_MODEL
    remote_dimension: int = REMOTE_DIMENSION
    local_model: str = LOCAL_MODEL
    local_dimension: int = LOCAL_DIMENSION
    local_cache_dir: Path = Path(".minicode/models")

    @property
    def remote_base_url(self) -> str:
        if self.base_url_override:
            return self.base_url_override.rstrip("/")
        if self.workspace_id:
            return f"https://{self.workspace_id}.{self.region}.maas.aliyuncs.com/compatible-mode/v1"
        return "https://dashscope.aliyuncs.com/compatible-mode/v1"

    @classmethod
    def from_environment(cls, *, load_dotenv_file: bool = True) -> "EmbeddingConfig":
        if load_dotenv_file:
            load_dotenv(override=False)
        return cls(
            api_key=os.getenv("DASHSCOPE_API_KEY", "").strip(),
            workspace_id=os.getenv("DASHSCOPE_WORKSPACE_ID", "").strip(),
            region=os.getenv("DASHSCOPE_REGION", "cn-beijing").strip() or "cn-beijing",
            base_url_override=os.getenv("DASHSCOPE_BASE_URL", "").strip(),
            remote_model=os.getenv("MINICODE_EMBEDDING_MODEL", REMOTE_MODEL).strip() or REMOTE_MODEL,
            local_cache_dir=Path(os.getenv("MINICODE_EMBEDDING_CACHE", ".minicode/models")).expanduser(),
        )


class EmbeddingProvider(Protocol):
    identity: EmbeddingIdentity

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]: ...

    def embed_query(self, text: str) -> list[float]: ...


class AliyunEmbeddingProvider:
    """通过阿里云百炼 OpenAI 兼容接口生成文本向量。"""

    def __init__(
        self,
        api_key: str,
        base_url: str,
        *,
        model: str = REMOTE_MODEL,
        dimension: int = REMOTE_DIMENSION,
        timeout_seconds: float = 8.0,
        client: Any | None = None,
    ) -> None:
        self.identity = EmbeddingIdentity("aliyun", model, dimension, True)
        if client is None:
            from openai import OpenAI

            client = OpenAI(api_key=api_key, base_url=base_url.rstrip("/"), timeout=timeout_seconds)
        self.client = client

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        values = list(texts)
        if not values:
            return []
        response = self.client.embeddings.create(model=self.identity.model, input=values)
        vectors = [list(item.embedding) for item in response.data]
        if len(vectors) != len(values):
            raise EmbeddingDimensionError("Embedding 响应条数与请求不一致")
        for vector in vectors:
            if len(vector) != self.identity.dimension:
                raise EmbeddingDimensionError(
                    f"Embedding 维度错误：期望 {self.identity.dimension}，实际 {len(vector)}"
                )
        return vectors

    def embed_query(self, text: str) -> list[float]:
        return self.embed_documents([text])[0]


def local_embedding_marker(cache_dir: Path | str) -> Path:
    """返回本地模型已完成显式安装的标记文件。"""

    model_directory = LOCAL_MODEL.replace("/", "__")
    return Path(cache_dir) / model_directory / ".ready"


def local_embedding_size_bytes(cache_dir: Path | str) -> int:
    """统计本地模型缓存实际文件大小，跳过符号链接和不可读文件。"""

    selected_cache = Path(cache_dir)
    if not local_embedding_marker(selected_cache).is_file() or not selected_cache.is_dir():
        return 0
    total = 0
    for path in selected_cache.rglob("*"):
        try:
            if path.is_symlink() or not path.is_file():
                continue
            total += path.stat().st_size
        except OSError:
            continue
    return total


def _create_fastembed_model(**kwargs: Any) -> Any:
    """延迟导入可选依赖，避免仅使用远程服务时强制安装本地模型运行时。"""

    try:
        from fastembed import TextEmbedding
    except ImportError as exc:
        raise EmbeddingUnavailable(
            "本地 embedding 依赖尚未安装，请安装 MiniCode 的 embedding-local 可选依赖"
        ) from exc
    return TextEmbedding(**kwargs)


class LocalEmbeddingProvider:
    """只加载已显式下载到本机的轻量中文 embedding 模型。"""

    def __init__(
        self,
        cache_dir: Path | str,
        *,
        model: str = LOCAL_MODEL,
        dimension: int = LOCAL_DIMENSION,
        model_factory: Any | None = None,
    ) -> None:
        self.cache_dir = Path(cache_dir)
        self.identity = EmbeddingIdentity("local", model, dimension, False)
        if not local_embedding_marker(self.cache_dir).is_file():
            raise EmbeddingUnavailable(
                "本地 embedding 模型尚未安装；请先执行显式安装命令，正常运行不会自动下载"
            )
        factory = model_factory or _create_fastembed_model
        self.model = factory(
            model_name=model,
            cache_dir=str(self.cache_dir),
            local_files_only=True,
        )

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        values = list(texts)
        if not values:
            return []
        vectors = []
        for raw_vector in self.model.embed(values):
            if hasattr(raw_vector, "tolist"):
                raw_vector = raw_vector.tolist()
            vector = list(raw_vector)
            if len(vector) != self.identity.dimension:
                raise EmbeddingDimensionError(
                    f"Embedding 维度错误：期望 {self.identity.dimension}，实际 {len(vector)}"
                )
            vectors.append(vector)
        if len(vectors) != len(values):
            raise EmbeddingDimensionError("Embedding 响应条数与请求不一致")
        return vectors

    def embed_query(self, text: str) -> list[float]:
        return self.embed_documents([text])[0]


def install_local_embedding(
    cache_dir: Path | str,
    *,
    model_factory: Any | None = None,
) -> Path:
    """显式下载本地模型；模型成功加载后才写入可用标记。"""

    selected_cache = Path(cache_dir)
    selected_cache.mkdir(parents=True, exist_ok=True)
    factory = model_factory or _create_fastembed_model
    factory(
        model_name=LOCAL_MODEL,
        cache_dir=str(selected_cache),
        local_files_only=False,
    )
    marker = local_embedding_marker(selected_cache)
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(f"model={LOCAL_MODEL}\ndimension={LOCAL_DIMENSION}\n", encoding="utf-8")
    return marker


class EmbeddingRouter:
    """优先使用远程 embedding，失败或敏感内容时降级到已安装本地模型。"""

    def __init__(
        self,
        *,
        remote: EmbeddingProvider | None,
        local: EmbeddingProvider | None,
        sensitive_filter: SensitiveDataFilter | None = None,
        initialization_fallback_reason: str = "",
    ) -> None:
        self.remote = remote
        self.local = local
        self.sensitive_filter = sensitive_filter or SensitiveDataFilter()
        self.initialization_fallback_reason = initialization_fallback_reason

    def embed_query(self, text: str) -> EmbeddingQueryResult:
        fallback_reason = "" if self.remote is not None else self.initialization_fallback_reason
        is_sensitive = self.sensitive_filter.contains_sensitive(text)
        if self.remote is not None and not is_sensitive:
            try:
                return EmbeddingQueryResult(self.remote.embed_query(text), self.remote.identity)
            except Exception as exc:
                safe_error = self.sensitive_filter.sanitize(str(exc))
                fallback_reason = f"{self.remote.identity.provider}: {safe_error}"
        elif is_sensitive:
            fallback_reason = "检测到敏感内容，未发送到远程 embedding"

        if self.local is not None:
            try:
                return EmbeddingQueryResult(
                    self.local.embed_query(text),
                    self.local.identity,
                    fallback_reason=fallback_reason,
                )
            except Exception as exc:
                local_error = self.sensitive_filter.sanitize(str(exc))
                fallback_reason = "; ".join(value for value in (fallback_reason, f"local: {local_error}") if value)
        unavailable_reason = "; ".join(
            value
            for value in (fallback_reason, self.initialization_fallback_reason)
            if value and value not in fallback_reason
        )
        raise EmbeddingUnavailable(unavailable_reason or fallback_reason or "没有可用的 embedding provider")

    def embed_documents(
        self,
        identity: EmbeddingIdentity,
        texts: Sequence[str],
    ) -> list[list[float]]:
        """使用查询阶段已选定的同一 Provider 生成文档向量，禁止跨维度混用。"""

        if self.remote is not None and identity == self.remote.identity:
            if any(self.sensitive_filter.contains_sensitive(text) for text in texts):
                raise SensitiveEmbeddingContent("检测到敏感内容，未发送到远程 embedding")
        for provider in (self.remote, self.local):
            if provider is not None and provider.identity == identity:
                return provider.embed_documents(texts)
        raise EmbeddingUnavailable(
            f"找不到匹配的 embedding provider：{identity.provider}/{identity.model}/{identity.dimension}"
        )


def build_embedding_router(config: EmbeddingConfig | None = None) -> EmbeddingRouter:
    selected = config or EmbeddingConfig.from_environment()
    remote: EmbeddingProvider | None = None
    initialization_errors: list[str] = []
    if selected.api_key:
        try:
            remote = AliyunEmbeddingProvider(
                api_key=selected.api_key,
                base_url=selected.remote_base_url,
                model=selected.remote_model,
                dimension=selected.remote_dimension,
            )
        except Exception as exc:
            initialization_errors.append(f"aliyun 初始化失败: {exc}")
    local: EmbeddingProvider | None = None
    try:
        local = LocalEmbeddingProvider(
            cache_dir=selected.local_cache_dir,
            model=selected.local_model,
            dimension=selected.local_dimension,
        )
    except EmbeddingUnavailable as exc:
        initialization_errors.append(f"local: {exc}")
    return EmbeddingRouter(
        remote=remote,
        local=local,
        initialization_fallback_reason="; ".join(initialization_errors),
    )
