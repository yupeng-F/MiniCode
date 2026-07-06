"""Eval 运行器：加载评测任务 → 运行图 → 评分 → 输出报告。

用法:
    python -m eval.runner                     # 运行所有离线任务
    python -m eval.runner --task 01_basic     # 只跑指定任务
    python -m eval.runner --report            # 只输出上次结果报告
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from typing import Any

# 确保项目根目录在 sys.path 中
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from eval import EvalCheck, EvalResult, EvalTask
from eval.scorer import score_task
from multi_agents.orchestrator.graph import compile_graph, initialize_state

logger = logging.getLogger(__name__)

TASKS_DIR = os.path.join(os.path.dirname(__file__), "tasks")
RESULTS_DIR = os.path.join(os.path.dirname(__file__), "results")


def _clear_api_keys():
    """清除环境变量中的 API key，确保走 fallback 路径（离线评测）。"""
    os.environ.pop("DASHSCOPE_API_KEY", None)
    os.environ.pop("OPENAI_API_KEY", None)


# ── 任务加载 ──────────────────────────────────────────


def load_tasks(task_filter: str | None = None) -> list[EvalTask]:
    """从 eval/tasks/ 加载评测任务 JSON 文件。"""
    os.makedirs(TASKS_DIR, exist_ok=True)
    tasks: list[EvalTask] = []
    for fname in sorted(os.listdir(TASKS_DIR)):
        if not fname.endswith(".json"):
            continue
        if task_filter and task_filter not in fname:
            continue
        fpath = os.path.join(TASKS_DIR, fname)
        with open(fpath, encoding="utf-8") as f:
            data = json.load(f)
        task = _parse_task(data)
        task.id = fname.replace(".json", "")
        tasks.append(task)
    return tasks


def _parse_task(data: dict) -> EvalTask:
    """将 JSON dict 解析为 EvalTask。"""
    checks = []
    for c in data.get("checks", []):
        checks.append(EvalCheck(
            type=c["type"],
            field=c.get("field", ""),
            value=c.get("value"),
            keywords=c.get("keywords", []),
            min_match=c.get("min_match", 1),
            min_length=c.get("min_length", 1),
        ))
    return EvalTask(
        id="",
        description=data.get("description", ""),
        mode=data.get("mode", "act"),
        input=data.get("input", ""),
        checks=checks,
        min_score=data.get("min_score", 1.0),
    )


# ── 任务运行 ──────────────────────────────────────────


def run_task(task: EvalTask) -> EvalResult:
    """运行一个评测任务：初始化 state → 跑图 → 评分。"""
    start = time.time()
    try:
        # 离线模式：清除 API key 确保走 fallback 路径
        _clear_api_keys()

        app_graph = compile_graph()
        thread_config = {"configurable": {"thread_id": f"eval_{task.id}"}}
        state = initialize_state(task.input, mode=task.mode)
        state["status"] = "running"

        final_state: dict[str, Any] = {}
        for event in app_graph.stream(state, thread_config, stream_mode="values"):
            final_state = dict(event)

        duration = time.time() - start
        logger.info("Task '%s' completed in %.1fs", task.id, duration)

        result = score_task(task, final_state)
        result.final_state = final_state
        return result

    except Exception as e:
        logger.error("Task '%s' failed: %s", task.id, e)
        return EvalResult(
            task_id=task.id,
            description=task.description,
            passed=False,
            score=0.0,
            checks_total=0,
            checks_passed=0,
            details=[],
            final_state={},
            error=str(e),
        )


def run_all(tasks: list[EvalTask]) -> list[EvalResult]:
    """运行所有评测任务。"""
    results: list[EvalResult] = []
    for task in tasks:
        print(f"  Running {task.id}... ", end="", flush=True)
        result = run_task(task)
        status = "PASS" if result.passed else "FAIL"
        print(f"{status} ({result.checks_passed}/{result.checks_total} checks, score={result.score:.2f})")
        results.append(result)
    return results


# ── 报告输出 ──────────────────────────────────────────


def generate_report(results: list[EvalResult]) -> dict:
    """聚合结果生成报告。"""
    total = len(results)
    passed = sum(1 for r in results if r.passed)
    avg_score = sum(r.score for r in results) / total if total > 0 else 0.0

    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "summary": {
            "total": total,
            "passed": passed,
            "failed": total - passed,
            "pass_rate": passed / total if total > 0 else 0.0,
            "avg_score": round(avg_score, 4),
        },
        "results": [
            {
                "task_id": r.task_id,
                "description": r.description,
                "passed": r.passed,
                "score": r.score,
                "checks_total": r.checks_total,
                "checks_passed": r.checks_passed,
                "error": r.error,
                "details": r.details,
            }
            for r in results
        ],
    }
    return report


def save_report(report: dict):
    """保存报告到 eval/results/。"""
    os.makedirs(RESULTS_DIR, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    fpath = os.path.join(RESULTS_DIR, f"report_{ts}.json")
    with open(fpath, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    # 同时写入 latest.json
    latest = os.path.join(RESULTS_DIR, "latest.json")
    with open(latest, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    return fpath


def print_report(report: dict):
    """终端输出报告摘要。"""
    s = report["summary"]
    print()
    print("=" * 50)
    print(f"  Eval Report — {report['timestamp'][:19]}")
    print("=" * 50)
    print(f"  Total:   {s['total']}")
    print(f"  Passed:  {s['passed']}")
    print(f"  Failed:  {s['failed']}")
    print(f"  Rate:    {s['pass_rate']*100:.1f}%")
    print(f"  AvgScore:{s['avg_score']:.2f}")
    print("-" * 50)
    for r in report["results"]:
        status = "PASS" if r["passed"] else "FAIL"
        print(f"  [{status}] {r['task_id']}: {r['description']}")
        if not r["passed"] and r["details"]:
            for d in r["details"]:
                if not d["passed"]:
                    print(f"         ✗ {d['check_type']} on '{d['field']}' (got: {d.get('value_preview','')})")
    print("=" * 50)


# ── 入口 ──────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Multi-Agent Eval Runner")
    parser.add_argument("--task", "-t", default=None, help="Run only tasks whose filename contains this string")
    parser.add_argument("--report", "-r", action="store_true", help="Print the latest report without re-running")
    args = parser.parse_args()

    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")

    if args.report:
        latest = os.path.join(RESULTS_DIR, "latest.json")
        if os.path.exists(latest):
            with open(latest, encoding="utf-8") as f:
                report = json.load(f)
            print_report(report)
        else:
            print("No report found. Run eval first.")
        return

    print(f"Loading tasks from {TASKS_DIR} ...")
    tasks = load_tasks(args.task)
    if not tasks:
        print("No tasks found! Place .json files in eval/tasks/")
        return

    print(f"Running {len(tasks)} tasks (offline mode)...\n")
    results = run_all(tasks)
    report = generate_report(results)
    fpath = save_report(report)
    print(f"\nReport saved to: {fpath}")
    print_report(report)

    # Exit code
    failed = sum(1 for r in results if not r.passed)
    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    main()
