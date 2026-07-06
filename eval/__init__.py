"""Eval 评测框架 — 数据模型。

评测任务由 JSON 文件定义，每个任务包含：
- 输入（input + mode）
- 一组检查条件（checks）
- 期望的评分阈值（min_score）
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


CheckType = Literal[
    "field_eq",       # 字段等于某值
    "keyword",        # 字符串字段包含关键词
    "not_empty",      # 字段不为空
    "min_length",     # 列表/字符串最小长度
    "field_neq",      # 字段不等于某值
]


@dataclass
class EvalCheck:
    """一条检查条件。"""

    type: CheckType
    field: str                     # GraphState 中的字段名（支持点号路径，如 "status"）
    value: Any = None              # 期望值（field_eq/field_neq 用）
    keywords: list[str] = field(default_factory=list)   # keyword 用
    min_match: int = 1             # keyword 最少命中数
    min_length: int = 1            # min_length 用


@dataclass
class EvalTask:
    """一个评测任务。"""

    id: str
    description: str
    mode: str = "act"
    input: str = ""
    checks: list[EvalCheck] = field(default_factory=list)
    min_score: float = 1.0          # 通过阈值（0.0 ~ 1.0）


@dataclass
class EvalResult:
    """一次评测的运行结果。"""

    task_id: str
    description: str
    passed: bool
    score: float                    # 通过比率（0.0 ~ 1.0）
    checks_total: int
    checks_passed: int
    details: list[dict[str, Any]]   # 每条检查的结果
    final_state: dict[str, Any]     # 任务结束后的 GraphState 快照
    error: str = ""                 # 运行出错时的错误信息
