"""Audit 日志：高风险操作持久化记录。

将 write_file / run_shell 等高危操作以 JSONL 格式写入磁盘，
每条记录包含时间、操作者、工具、参数、结果、耗时等可审计字段。

存储位置: .claude/audit/audit.log (按日期轮转)
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any

from multi_agents.schemas.tool import ToolRequest, ToolResult

# 被审计的高风险工具列表
HIGH_RISK_TOOLS = {"write_file", "run_shell"}

# 审计日志目录
AUDIT_DIR = os.path.join(".claude", "audit")
AUDIT_FILE = os.path.join(AUDIT_DIR, "audit.log")


def _ensure_dir():
    os.makedirs(AUDIT_DIR, exist_ok=True)


def _entry(request: ToolRequest, result: ToolResult) -> dict[str, Any]:
    """构建一条审计日志条目。"""
    args = dict(request.arguments)
    # 截断过长的 content 避免日志膨胀
    if "content" in args and len(args["content"]) > 200:
        args["content"] = args["content"][:200] + "..."
    if "command" in args and len(args["command"]) > 200:
        args["command"] = args["command"][:200] + "..."

    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "thread_id": request.thread_id,
        "run_id": request.run_id,
        "agent_name": request.agent_name,
        "tool_name": request.tool_name,
        "arguments": args,
        "intent_summary": request.intent_summary,
        "risk_level": request.risk_level,
        "success": result.success,
        "duration_ms": result.duration_ms,
        "exit_code": result.exit_code,
        "summary": result.summary,
        "modified_paths": result.modified_paths,
    }


def log_tool_execution(request: ToolRequest, result: ToolResult) -> None:
    """如果工具属于高风险列表，写入审计日志。

    可安全地在任何地方调用：非高风险工具直接跳过。
    """
    if request.tool_name not in HIGH_RISK_TOOLS:
        return

    try:
        _ensure_dir()
        entry = _entry(request, result)
        line = json.dumps(entry, ensure_ascii=False)
        with open(AUDIT_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass  # 审计日志写入失败不应影响主流程
