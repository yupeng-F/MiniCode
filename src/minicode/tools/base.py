from __future__ import annotations

from minicode.runtime.tool_registry import ToolRegistry
from minicode.schemas.policy import RiskProfile
from minicode.schemas.tool import ToolSpec


def build_default_registry() -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(ToolSpec(
        name="read_file",
        description="Read a workspace file in pages. Use metadata.next_offset as the next offset until it is null.",
        input_schema=_schema({"path": _string("Workspace-relative file path"), "offset": _integer("Zero-based line offset, default 0"), "limit": _integer("Maximum lines, default 400 and maximum 2000")}, ["path"]),
    ))
    registry.register(ToolSpec(
        name="list_directory",
        description="List a workspace directory.",
        input_schema=_schema({"path": _string("Workspace-relative directory path, defaulting to .")}),
    ))
    registry.register(ToolSpec(
        name="glob_files",
        description="Find files by glob pattern.",
        input_schema=_schema({"pattern": _string("Glob pattern, e.g. **/*.py"), "max_results": _integer("Maximum number of matches")}),
    ))
    registry.register(ToolSpec(
        name="grep",
        description="Search text in workspace files using ripgrep when available.",
        input_schema=_schema({"query": _string("Text or regex to search"), "path": _string("Workspace-relative path, defaulting to ."), "max_results": _integer("Maximum number of matches")}, ["query"]),
    ))
    registry.register(ToolSpec(name="git_status", description="Show git status."))
    registry.register(ToolSpec(name="git_diff", description="Show git diff."))
    registry.register(ToolSpec(name="run_tests", description="Run the project test command.", input_schema=_schema({"command": _string("Optional test command")}), side_effect=False, read_only=True))
    registry.register(ToolSpec(
        name="propose_patch",
        description="Create a unified diff proposal without applying it.",
        input_schema=_schema({"path": _string("Workspace-relative file path"), "content": _string("Complete proposed file content")}, ["path", "content"]),
        read_only=True,
    ))
    registry.register(ToolSpec(
        name="apply_patch",
        description="Apply a unified diff patch to the workspace.",
        input_schema=_schema({"patch": _string("Unified diff patch"), "path": _string("Alternative workspace-relative file path"), "content": _string("Alternative complete replacement content")}),
        read_only=False,
        side_effect=True,
        requires_approval=True,
        allowed_modes=["act"],
        risk=RiskProfile(reversibility="hard_to_reverse", blast_radius="workspace", approval="always"),
    ))
    registry.register(ToolSpec(
        name="bash",
        description="Run a fallback shell command in the workspace.",
        input_schema=_schema({"command": _string("Shell command to run inside the workspace")}, ["command"]),
        read_only=False,
        side_effect=True,
        requires_approval=True,
        allowed_modes=["act"],
        risk=RiskProfile(reversibility="hard_to_reverse", blast_radius="workspace", approval="always"),
    ))
    registry.register(ToolSpec(name="enter_plan_mode", description="Enter read-only planning mode."))
    registry.register(ToolSpec(name="exit_plan_mode", description="Exit planning mode after user approval.", requires_approval=True))
    return registry


def _schema(properties: dict, required: list[str] | None = None) -> dict:
    schema = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    return schema


def _string(description: str) -> dict:
    return {"type": "string", "description": description}


def _integer(description: str) -> dict:
    return {"type": "integer", "description": description}
