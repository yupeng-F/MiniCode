from __future__ import annotations

import argparse

from minicode.application.run_service import RunService
from minicode.engine.model_factory import ModelConfigurationError, ModelFactory
from minicode.engine.model_client import JsonScriptModel


def main() -> None:
    parser = argparse.ArgumentParser(description="MiniCode local coding agent")
    parser.add_argument("prompt", nargs="*", help="Task prompt")
    parser.add_argument("--workspace", "-w", default=".", help="Workspace root")
    parser.add_argument("--mode", "-m", choices=["ask", "plan", "act", "review"], default="act")
    parser.add_argument("--model", help="Override MINICODE_MODEL for this run")
    parser.add_argument("--mock", action="store_true", help="Use the offline scripted model")
    args = parser.parse_args()

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


if __name__ == "__main__":
    main()
