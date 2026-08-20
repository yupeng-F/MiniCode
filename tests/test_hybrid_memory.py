from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from minicode.memory.embedding import EmbeddingIdentity
from minicode.memory.embedding import EmbeddingQueryResult, EmbeddingUnavailable
from minicode.memory.hybrid_retriever import HybridRetriever, RankedMemory
from minicode.memory.memory_service import MemoryService
from minicode.memory.vector_store import VectorDimensionMismatch, VectorMemory, VectorStore
from minicode.memory.vector_store import VectorHit


class FakeCollection:
    def __init__(self, metadata=None):
        self.metadata = metadata or {}
        self.upserts = []
        self.query_calls = []

    def upsert(self, **kwargs):
        self.upserts.append(kwargs)

    def query(self, **kwargs):
        self.query_calls.append(kwargs)
        return {"ids": [["m2", "m1"]], "distances": [[0.1, 0.3]]}


class FakeClient:
    def __init__(self, metadata=None):
        self.collection = FakeCollection(metadata)
        self.names = []

    def get_or_create_collection(self, name, metadata):
        self.names.append((name, metadata))
        if not self.collection.metadata:
            self.collection.metadata = metadata
        return self.collection


def test_vector_collection_is_separated_by_provider_model_and_dimension(tmp_path):
    client = FakeClient()
    store = VectorStore(tmp_path / "chroma", client=client)
    remote = EmbeddingIdentity("aliyun", "qwen3.7-text-embedding", 1024, True)
    local = EmbeddingIdentity("local", "BAAI/bge-small-zh-v1.5", 512, False)

    remote_name = store.collection_name(remote)
    local_name = store.collection_name(local)

    assert remote_name != local_name
    assert "aliyun" in remote_name and "1024" in remote_name
    assert "local" in local_name and "512" in local_name


def test_vector_store_rejects_collection_dimension_mismatch(tmp_path):
    identity = EmbeddingIdentity("aliyun", "qwen3.7-text-embedding", 1024, True)
    store = VectorStore(tmp_path / "chroma", client=FakeClient({"dimension": 512, "hnsw:space": "cosine"}))

    with pytest.raises(VectorDimensionMismatch):
        store.upsert(identity, [VectorMemory("m1", "project-a", "hash", [0.1] * 1024)])


def test_vector_store_limits_query_to_top_thirty_and_project(tmp_path):
    identity = EmbeddingIdentity("local", "BAAI/bge-small-zh-v1.5", 512, False)
    client = FakeClient()
    store = VectorStore(tmp_path / "chroma", client=client)

    hits = store.query(identity, "project-a", [0.2] * 512, limit=99)

    assert [hit.memory_id for hit in hits] == ["m2", "m1"]
    assert client.collection.query_calls == [{
        "query_embeddings": [[0.2] * 512],
        "n_results": 30,
        "where": {"project_id": "project-a"},
        "include": ["distances"],
    }]


class CharacterCounter:
    def count(self, value):
        return len(str(value))


def test_rrf_combines_vector_keyword_path_recency_and_usefulness():
    now = datetime(2026, 8, 20, tzinfo=UTC)
    records = [
        RankedMemory("vector", "project-a", "向量命中", "long", (), now, now, 0),
        RankedMemory("keyword", "project-a", "关键词命中", "long", ("src/*.py",), now, now, 20),
        RankedMemory("old", "project-a", "旧中期记忆", "medium", (), now - timedelta(days=60), now - timedelta(days=60), 0),
    ]
    retriever = HybridRetriever(token_counter=CharacterCounter())

    result = retriever.retrieve(
        records,
        keyword_ids=["keyword", "vector", "old"],
        vector_ids=["vector", "keyword", "old"],
        active_files=["src/app.py"],
        provider="aliyun",
        external_transfer=True,
        now=now,
    )

    assert [item.memory_id for item in result.items[:2]] == ["keyword", "vector"]
    first = result.items[0]
    assert first.vector_score == pytest.approx(61 / 62)
    assert first.keyword_score == 1
    assert first.path_score == 1
    assert first.recency_score == 1
    assert first.usefulness_score == pytest.approx(0.8)
    assert first.final_score == pytest.approx(
        0.45 * (61 / 62) + 0.30 + 0.10 + 0.10 + 0.05 * 0.8
    )


def test_hybrid_result_is_limited_to_eight_items_and_token_budgets():
    now = datetime(2026, 8, 20, tzinfo=UTC)
    records = [
        RankedMemory(str(index), "project-a", "x" * 1_500, "long", (), now, now, 0)
        for index in range(12)
    ]
    retriever = HybridRetriever(token_counter=CharacterCounter())

    result = retriever.retrieve(
        records,
        keyword_ids=[record.memory_id for record in records],
        vector_ids=[],
        active_files=[],
        provider="fts5",
        fallback_reason="embedding 不可用",
        external_transfer=False,
        max_tokens=4_000,
    )

    assert len(result.items) == 4
    assert result.token_count == 4_000
    assert all(len(item.content) == 1_000 for item in result.items)
    assert result.provider == "fts5"
    assert result.fallback_reason == "embedding 不可用"


class FakeEmbeddingRouter:
    def __init__(self, *, unavailable=False):
        self.identity = EmbeddingIdentity("aliyun", "qwen3.7-text-embedding", 4, True)
        self.unavailable = unavailable
        self.document_calls = []

    def embed_query(self, text):
        if self.unavailable:
            raise EmbeddingUnavailable("远程与本地 embedding 均不可用")
        return EmbeddingQueryResult([0.1] * 4, self.identity)

    def embed_documents(self, identity, texts):
        assert identity == self.identity
        self.document_calls.append(list(texts))
        return [[0.2] * 4 for _ in texts]


class FakeVectorStore:
    def __init__(self):
        self.upserts = []
        self.query_calls = []

    def content_hashes(self, identity, project_id):
        return {}

    def upsert(self, identity, records):
        self.upserts.extend(records)

    def query(self, identity, project_id, vector, limit=30):
        self.query_calls.append((identity, project_id, vector, limit))
        return [VectorHit("semantic", 0.05), VectorHit("keyword", 0.2)]


def test_memory_service_returns_observable_hybrid_result(tmp_path):
    router = FakeEmbeddingRouter()
    vectors = FakeVectorStore()
    memory = MemoryService(tmp_path / ".minicode" / "memory", embedding_router=router, vector_store=vectors)
    memory.store_rule("keyword", "运行 Python 测试时使用 pytest。")
    memory.store_rule("semantic", "发布前必须执行质量门禁。")

    result = memory.retrieve_result("如何验证 Python 改动", ["src/app.py"], mode="act")

    assert result.provider == "aliyun"
    assert result.external_transfer is True
    assert result.items[0].memory_id in {"keyword", "semantic"}
    assert {record.memory_id for record in vectors.upserts} == {"keyword", "semantic"}
    assert vectors.query_calls[0][3] == 30
    assert memory.retrieve("如何验证 Python 改动", ["src/app.py"]) == result.rendered


def test_lazy_remote_index_skips_sensitive_markdown(tmp_path):
    memory_root = tmp_path / ".minicode" / "memory"
    rules = memory_root / "rules"
    rules.mkdir(parents=True)
    (rules / "legacy-sensitive.md").write_text(
        "---\nname: legacy-sensitive\nstatus: enabled\n---\n\nDASHSCOPE_API_KEY=secret\n",
        encoding="utf-8",
    )
    (rules / "ordinary.md").write_text(
        "---\nname: ordinary\nstatus: enabled\n---\n\n普通规则\n",
        encoding="utf-8",
    )
    remote = FakeEmbeddingRouter()
    memory = MemoryService(memory_root, embedding_router=remote, vector_store=FakeVectorStore())

    result = memory.retrieve_result("普通查询", [])

    assert remote.document_calls == [["普通规则"]]
    assert result.provider == "aliyun"


def test_memory_service_reports_complete_retrieval_elapsed_time(tmp_path, monkeypatch):
    router = FakeEmbeddingRouter()
    memory = MemoryService(
        tmp_path / ".minicode" / "memory",
        embedding_router=router,
        vector_store=FakeVectorStore(),
    )
    memory.store_rule("python", "Python 改动完成后运行 pytest。")
    clock = iter([100.0, 100.1234])
    monkeypatch.setattr("minicode.memory.memory_service.perf_counter", lambda: next(clock))

    result = memory.retrieve_result("如何验证 Python 改动", ["src/app.py"])

    assert result.elapsed_ms == pytest.approx(123.4)


def test_memory_service_falls_back_to_fts_without_blocking(tmp_path):
    memory = MemoryService(
        tmp_path / ".minicode" / "memory",
        embedding_router=FakeEmbeddingRouter(unavailable=True),
        vector_store=FakeVectorStore(),
    )
    memory.store_rule("harness", "Harness 工程底座包含安全执行和质量门禁。")

    result = memory.retrieve_result("Harness 工程底座", [], mode="ask")

    assert result.provider == "fts5"
    assert "embedding 均不可用" in result.fallback_reason
    assert result.rendered == "- Harness 工程底座包含安全执行和质量门禁。"
