from __future__ import annotations

import json
import argparse
import importlib
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable


@dataclass(frozen=True, slots=True)
class EvalCase:
    name: str
    input: dict[str, Any]
    expected: dict[str, Any]
    tags: tuple[str, ...] = ()


@dataclass(slots=True)
class EvalResult:
    name: str
    passed: bool
    actual: dict[str, Any]
    expected: dict[str, Any]
    error: str = ""
    tags: tuple[str, ...] = ()


@dataclass(slots=True)
class EvalReport:
    results: list[EvalResult] = field(default_factory=list)
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    @property
    def passed(self) -> bool:
        return all(result.passed for result in self.results)

    def to_dict(self) -> dict[str, Any]:
        return {"created_at": self.created_at, "passed": self.passed, "results": [asdict(item) for item in self.results]}


class EvalRunner:
    """Small deterministic regression runner; evaluator injection keeps it model-agnostic."""

    def __init__(self, evaluator: Callable[[dict[str, Any]], dict[str, Any]]) -> None:
        self.evaluator = evaluator

    def run(self, cases: Iterable[EvalCase], report_path: str | Path | None = None) -> EvalReport:
        report = EvalReport()
        for case in cases:
            try:
                actual = self.evaluator(case.input)
                report.results.append(EvalResult(case.name, actual == case.expected, actual, case.expected, tags=case.tags))
            except Exception as exc:  # evaluation failures belong in the report
                report.results.append(EvalResult(case.name, False, {}, case.expected, error=f"{type(exc).__name__}: {exc}", tags=case.tags))
        if report_path:
            path = Path(report_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(report.to_dict(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return report

    @staticmethod
    def load_cases(path: str | Path) -> list[EvalCase]:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return [EvalCase(item["name"], item["input"], item["expected"], tuple(item.get("tags", ()))) for item in data]


def main() -> int:
    parser = argparse.ArgumentParser(description="Run repeatable MiniCode JSON evaluation cases")
    parser.add_argument("cases", help="JSON file containing evaluation cases")
    parser.add_argument("--evaluator", required=True, help="Python callable as module:function")
    parser.add_argument("--report", default=".minicode/eval/latest.json")
    args = parser.parse_args()
    module_name, separator, attribute = args.evaluator.partition(":")
    if not separator:
        parser.error("--evaluator must use module:function syntax")
    evaluator = getattr(importlib.import_module(module_name), attribute)
    report = EvalRunner(evaluator).run(EvalRunner.load_cases(args.cases), args.report)
    print(json.dumps(report.to_dict(), ensure_ascii=False))
    return 0 if report.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
