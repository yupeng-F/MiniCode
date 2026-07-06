from __future__ import annotations

import argparse

from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command

from multi_agents.orchestrator.graph import compile_graph, initialize_state


def _get_interrupt_value(app: CompiledStateGraph, thread_config: dict) -> dict | None:
    """Extract the interrupt value from a paused graph state, if any."""
    try:
        state = app.get_state(thread_config)
    except Exception:
        return None
    if not state.tasks:
        return None
    for task in state.tasks:
        if task.interrupts:
            return task.interrupts[0].value
    return None


def _prompt_for_approval(ctx: dict) -> str:
    """Display approval info and return the user's decision."""
    print("\n=== APPROVAL REQUIRED ===")
    print(f"Tool:    {ctx.get('tool_name', '(approval)')}")
    print(f"Agent:   {ctx.get('agent_name', '')}")
    print(f"Intent:  {ctx.get('intent_summary', ctx.get('summary', ''))}")
    print(f"Risk:    {ctx.get('risk_level', 'unknown')}")
    print("=========================")

    choice = input("Approve? (y/n): ").strip().lower()
    return "approved" if choice in ("y", "yes") else "rejected"


def main() -> None:
    parser = argparse.ArgumentParser(description="Multi-Agent Coding Assistant")
    parser.add_argument("--mode", "-m", choices=["ask", "plan", "act", "review"],
                        default="act", help="Execution mode")
    parser.add_argument("prompt", nargs="*", help="Task description")
    args = parser.parse_args()

    user_input = " ".join(args.prompt) if args.prompt else "bootstrap multi-agent scaffold"
    mode = args.mode

    print(f"Mode: {mode}")
    print(f"Task: {user_input[:120]}")
    print()

    app = compile_graph()
    thread_config = {"configurable": {"thread_id": "cli-run"}}
    state = initialize_state(user_input, mode=mode)

    # Stream until completion or interrupt
    has_interrupted = False
    for event in app.stream(state, thread_config, stream_mode="values"):
        stage = event.get("current_stage", "")
        agent = event.get("current_agent", "")
        status = event.get("status", "")
        label = stage or "(start)"

        if agent:
            print(f"  [{label}] {agent}")

        if status == "completed":
            answer = event.get("final_answer", "")
            if answer:
                print(f"\nFinal: {answer[:300]}")
            return

    # Check for pending interrupt
    while True:
        ctx = _get_interrupt_value(app, thread_config)
        if ctx is None:
            break

        has_interrupted = True
        decision = _prompt_for_approval(ctx)

        for event in app.stream(Command(resume=decision), thread_config, stream_mode="values"):
            stage = event.get("current_stage", "")
            agent = event.get("current_agent", "")
            status = event.get("status", "")

            if agent:
                print(f"  [{stage or '(resume)'}] {agent}")
            if status == "completed":
                answer = event.get("final_answer", "")
                if answer:
                    print(f"\nFinal: {answer[:300]}")
                return

    if not has_interrupted:
        print("\nDone.")


if __name__ == "__main__":
    main()
