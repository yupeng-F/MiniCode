from __future__ import annotations

import argparse
import sys
from pathlib import Path

from minicode.application.run_service import RunService
from minicode.engine.model_factory import ModelConfigurationError, ModelFactory
from minicode.engine.model_client import JsonScriptModel
from minicode.memory.embedding import EmbeddingConfig, install_local_embedding


def main(argv: list[str] | None = None) -> None:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments[:2] in (["memory", "setup-local-embedding"], ["embedding", "install-local"]):
        _setup_local_embedding(arguments[2:])
        return

    parser = argparse.ArgumentParser(description="MiniCode local coding agent")
    parser.add_argument("prompt", nargs="*", help="Task prompt")
    parser.add_argument("--workspace", "-w", default=".", help="Workspace root")
    parser.add_argument("--mode", "-m", choices=["ask", "plan", "act", "review"], default="act")
    parser.add_argument("--model", help="Override MINICODE_MODEL for this run")
    parser.add_argument("--mock", action="store_true", help="Use the offline scripted model")
    args = parser.parse_args(arguments)

    prompt = " ".join(args.prompt) or "List project files"
    if args.mock:
        model = JsonScriptModel([
            {"type": "tool_use", "tool_call": {"tool_name": "list_directory", "arguments": {"path": "."}, "intent": "Inspect workspace"}},
            {"type": "final", "content": "MiniCode mock query loop completed."},
        ])
    else:
        try:
            model = ModelFactory.from_environment(model=args.model)
        except ModelConfigurationError as exc:
            parser.error(str(exc))
    service = RunService(workspace=args.workspace, model=model)
    session = service.run(prompt, mode=args.mode)
    print(session.final_answer)
    for record in session.tool_calls:
        if record.result:
            print(f"\n[{record.tool_name}] {record.result.summary}")
            if record.result.preview:
                print(record.result.preview[:1000])


def _setup_local_embedding(arguments: list[str]) -> None:
    config = EmbeddingConfig.from_environment()
    parser = argparse.ArgumentParser(description="显式下载并安装 MiniCode 本地 embedding 模型")
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=config.local_cache_dir,
        help="本地模型缓存目录，默认读取 MINICODE_EMBEDDING_CACHE",
    )
    args = parser.parse_args(arguments)
    marker = install_local_embedding(args.cache_dir)
    print(f"本地 embedding 已安装：{marker}")


if __name__ == "__main__":
    main()
