from __future__ import annotations

from minicode.memory.memory_service import MemoryService


def test_memory_retrieval_uses_chinese_task_relevance(tmp_path):
    memory = MemoryService(tmp_path / ".minicode" / "memory")
    memory.store_rule("a-python", "运行 Python 测试时使用 pytest。")
    memory.store_rule("z-harness", "Harness 工程底座培训资料介绍了受控工具执行与质量门禁。")

    result = memory.retrieve("Harness 工程底座主要讲了什么", [], mode="ask")

    assert "受控工具执行与质量门禁" in result
    assert "pytest" not in result


def test_memory_retrieval_combines_task_and_active_file_terms(tmp_path):
    memory = MemoryService(tmp_path / ".minicode" / "memory")
    memory.store_rule("frontend", "修改 App.tsx 后运行前端 Vitest。", paths=["web/src/*.tsx"])
    memory.store_rule("backend", "修改 server.py 后运行 Python pytest。", paths=["src/**/*.py"])

    result = memory.retrieve("修改组件测试", ["web/src/App.tsx"], mode="act")

    assert "前端 Vitest" in result
    assert "Python pytest" not in result


def test_disabled_memory_is_removed_from_keyword_results(tmp_path):
    memory = MemoryService(tmp_path / ".minicode" / "memory")
    memory.store_rule("harness", "Harness 任务必须先检查安全策略。")
    assert memory.disable_memory("harness")

    assert memory.retrieve("Harness 安全策略", [], mode="review") == ""
