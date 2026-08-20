from __future__ import annotations

import sqlite3

from minicode.memory.memory_index import MemoryIndex
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


def test_medium_memory_migrates_legacy_table_and_updates_only_explicit_fields(tmp_path):
    path = tmp_path / "memory_index.db"
    with sqlite3.connect(path) as conn:
        conn.execute(
            "CREATE TABLE medium_memory ("
            "memory_id TEXT NOT NULL, project_id TEXT NOT NULL, task TEXT NOT NULL, "
            "status TEXT NOT NULL, content TEXT NOT NULL, active_files TEXT NOT NULL, "
            "created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, use_count INTEGER NOT NULL DEFAULT 0, "
            "pinned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(memory_id, project_id))"
        )
        conn.execute(
            "INSERT INTO medium_memory VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("legacy", "project-a", "旧任务", "completed", "旧摘要", "src/old.py", "created", "used", 2, 0),
        )

    index = MemoryIndex(path, "project-a")

    assert index.update_medium("legacy", content="新摘要", enabled=False)
    reloaded = MemoryIndex(path, "project-a").list_medium()[0]
    assert reloaded.task == "旧任务"
    assert reloaded.content == "新摘要"
    assert reloaded.active_files == "src/old.py"
    assert reloaded.status == "completed"
    assert reloaded.enabled is False
