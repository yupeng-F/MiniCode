"""Eval 评分器：对 GraphState 执行检查条件。"""

from __future__ import annotations

import logging
from typing import Any

from eval import EvalCheck, EvalResult, EvalTask

logger = logging.getLogger(__name__)


def _get_field(state: dict[str, Any], field_path: str) -> Any:
    """按点号路径取字段值，如 'status' → state['status']。"""
    parts = field_path.split(".")
    value: Any = state
    for part in parts:
        if isinstance(value, dict):
            value = value.get(part, "")
        else:
            return ""
    return value


def _check_single(check: EvalCheck, state: dict[str, Any]) -> dict:
    """执行一条检查，返回结果。"""
    value = _get_field(state, check.field)
    detail: dict = {
        "check_type": check.type,
        "field": check.field,
        "value_preview": str(value)[:100],
        "passed": False,
    }

    try:
        if check.type == "field_eq":
            detail["passed"] = value == check.value
            detail["expected"] = str(check.value)

        elif check.type == "field_neq":
            detail["passed"] = value != check.value
            detail["expected"] = f"!= {check.value}"

        elif check.type == "not_empty":
            detail["passed"] = bool(value) and (not isinstance(value, (list, str)) or len(value) > 0)

        elif check.type == "min_length":
            length = len(value) if isinstance(value, (list, str)) else 0
            detail["passed"] = length >= check.min_length
            detail["expected"] = f"min_length >= {check.min_length}"
            detail["actual_length"] = length

        elif check.type == "keyword":
            text = str(value).lower()
            matches = [kw for kw in check.keywords if kw.lower() in text]
            detail["matched"] = matches
            detail["missing"] = [kw for kw in check.keywords if kw.lower() not in text]
            detail["passed"] = len(matches) >= check.min_match
            detail["expected"] = f"keywords: {check.keywords}, min_match: {check.min_match}"

    except Exception as e:
        detail["error"] = str(e)
        detail["passed"] = False

    return detail


def score_task(task: EvalTask, final_state: dict[str, Any]) -> EvalResult:
    """对单个任务评分。"""
    if not task.checks:
        return EvalResult(
            task_id=task.id,
            description=task.description,
            passed=True,
            score=1.0,
            checks_total=0,
            checks_passed=0,
            details=[],
            final_state=final_state,
        )

    details = [_check_single(c, final_state) for c in task.checks]
    total = len(details)
    passed_count = sum(1 for d in details if d["passed"])
    score = passed_count / total if total > 0 else 1.0

    return EvalResult(
        task_id=task.id,
        description=task.description,
        passed=score >= task.min_score,
        score=score,
        checks_total=total,
        checks_passed=passed_count,
        details=details,
        final_state=final_state,
    )
