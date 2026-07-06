from __future__ import annotations

import difflib
import os
import re
import time

from multi_agents.runtime.shell_sandbox import run_shell_command
from multi_agents.runtime.tool_registry import ToolRegistry
from multi_agents.schemas.tool import ToolRequest, ToolResult
from multi_agents.tools.base import ToolSpec


class ToolExecutor:
    """Dispatch validated tool requests to concrete implementations.

    Integrates with ToolRegistry for role-based permission checking.
    """

    _workspace_root: str | None = None

    def __init__(self, registry: ToolRegistry | None = None) -> None:
        self.registry = registry or self._build_default_registry()
        self._handlers: dict[str, callable] = {
            "read_file": self._read_file,
            "write_file": self._write_file,
            "list_directory": self._list_directory,
            "search_code": self._search_code,
            "run_shell": self._run_shell,
        }

    @classmethod
    def set_workspace(cls, path: str):
        """Set workspace root for shell command execution."""
        cls._workspace_root = path

    @classmethod
    def get_workspace(cls) -> str | None:
        return cls._workspace_root

    def _build_default_registry(self) -> ToolRegistry:
        """创建默认的工具注册表，包含所有内置工具及其角色权限。"""
        reg = ToolRegistry()
        reg.register(ToolSpec(
            name="read_file",
            description="Read file content from the workspace.",
            allowed_roles=["repo_explorer", "coder", "reviewer", "tester"],
            risk_level="low",
        ))
        reg.register(ToolSpec(
            name="write_file",
            description="Write file content to the workspace.",
            allowed_roles=["coder"],
            risk_level="medium",
            side_effect=True,
        ))
        reg.register(ToolSpec(
            name="list_directory",
            description="List files and subdirectories in a given directory path.",
            allowed_roles=["repo_explorer", "coder"],
            risk_level="low",
        ))
        reg.register(ToolSpec(
            name="search_code",
            description="Search code in the repository.",
            allowed_roles=["repo_explorer", "reviewer"],
            risk_level="low",
        ))
        reg.register(ToolSpec(
            name="run_shell",
            description="Run a shell command in the workspace.",
            allowed_roles=["coder", "tester"],
            risk_level="high",
            side_effect=True,
        ))
        return reg

    def execute(self, request: ToolRequest) -> ToolResult:
        """执行工具请求：先校验权限，再分发。

        如果角色无权限调用该工具，直接返回拒绝结果。
        """
        # 1. 权限校验
        agent_role = request.agent_name
        if not self.registry.check_permission(agent_role, request.tool_name):
            return ToolResult(
                request_id=request.request_id,
                tool_name=request.tool_name,
                success=False,
                summary=f"Permission denied: role '{agent_role}' cannot use tool '{request.tool_name}'",
                exit_code=1,
            )

        # 2. 查找处理器
        handler = self._handlers.get(request.tool_name)
        if handler is None:
            return ToolResult(
                request_id=request.request_id,
                tool_name=request.tool_name,
                success=False,
                summary=f"Unknown tool: {request.tool_name}",
                exit_code=1,
            )

        # 3. 执行
        return handler(request)

    # ── 工具实现 ──────────────────────────────────────────────

    def _read_file(self, request: ToolRequest) -> ToolResult:
        path = request.arguments.get("path", "")
        try:
            with open(path, encoding="utf-8") as f:
                content = f.read()
            preview = content[:500]
            return ToolResult(
                request_id=request.request_id,
                tool_name="read_file",
                success=True,
                summary=f"Read {len(content)} chars from {path}",
                stdout_preview=preview,
                exit_code=0,
            )
        except Exception as e:
            return ToolResult(
                request_id=request.request_id,
                tool_name="read_file",
                success=False,
                summary=str(e),
                exit_code=1,
            )

    def _write_file(self, request: ToolRequest) -> ToolResult:
        path = request.arguments.get("path", "")
        content = request.arguments.get("content", "")
        diff_preview = ""
        try:
            # 先读旧内容（如果存在），用于生成 diff
            old_content = ""
            if os.path.exists(path):
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        old_content = f.read()
                except Exception:
                    pass

            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)

            # 生成 unified diff
            if old_content:
                diff_lines = list(difflib.unified_diff(
                    old_content.splitlines(keepends=True),
                    content.splitlines(keepends=True),
                    fromfile=path,
                    tofile=path,
                    n=3,
                ))
                diff_text = "".join(diff_lines)
                if len(diff_text) > 2000:
                    diff_text = diff_text[:2000] + "\n... (truncated)"
                diff_preview = diff_text

            return ToolResult(
                request_id=request.request_id,
                tool_name="write_file",
                success=True,
                summary=f"Wrote {len(content)} chars to {path}",
                stdout_preview=diff_preview[:1500],
                modified_paths=[path],
                exit_code=0,
            )
        except Exception as e:
            return ToolResult(
                request_id=request.request_id,
                tool_name="write_file",
                success=False,
                summary=str(e),
                exit_code=1,
            )

    def _list_directory(self, request: ToolRequest) -> ToolResult:
        path = request.arguments.get("path", ".")
        try:
            entries = os.listdir(path)
            lines = []
            for e in sorted(entries):
                full = os.path.join(path, e)
                kind = "D" if os.path.isdir(full) else "F"
                lines.append(f"[{kind}] {e}")
            preview = "\n".join(lines)
            return ToolResult(
                request_id=request.request_id,
                tool_name="list_directory",
                success=True,
                summary=f"Listed {len(lines)} entries in {path}",
                stdout_preview=preview[:1000],
                exit_code=0,
            )
        except Exception as e:
            return ToolResult(
                request_id=request.request_id,
                tool_name="list_directory",
                success=False,
                summary=str(e),
                exit_code=1,
            )

    EXCLUDE_DIRS = {"node_modules", ".git", "__pycache__", ".venv", "venv", "env",
                    ".idea", ".vscode", ".claude", "build", "dist", ".pytest_cache",
                    ".mypy_cache", ".ruff_cache", "__pycache__", "egg-info"}

    def _search_code(self, request: ToolRequest) -> ToolResult:
        """Real implementation: recursive text search in workspace files."""
        query = request.arguments.get("query", "")
        search_path = request.arguments.get("path", ".")
        max_results = int(request.arguments.get("max_results", 30))
        # 默认只搜 .py/.js/.ts/.jsx/.tsx/.md/.json/.yaml/.yml/.toml/.cfg/.ini/.txt
        extensions = request.arguments.get("extensions", "")

        if not query:
            return ToolResult(
                request_id=request.request_id,
                tool_name="search_code",
                success=False,
                summary="No search query provided.",
                exit_code=1,
            )

        # 解析扩展名过滤
        ext_set: set[str] | None = None
        if extensions:
            ext_set = {e if e.startswith(".") else f".{e}" for e in extensions.split(",")}

        def _should_skip(dir_name: str) -> bool:
            return dir_name in self.EXCLUDE_DIRS or dir_name.startswith(".")

        matches: list[str] = []
        try:
            root = os.path.abspath(search_path)
            for dirpath, dirnames, filenames in os.walk(root):
                # 跳过排除目录和隐藏目录
                dirnames[:] = [d for d in dirnames if not _should_skip(d)]
                for fname in filenames:
                    # 扩展名过滤
                    if ext_set is not None:
                        ext = os.path.splitext(fname)[1].lower()
                        if ext not in ext_set:
                            continue
                    fpath = os.path.join(dirpath, fname)
                    try:
                        with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                            for lineno, line in enumerate(f, 1):
                                if query.lower() in line.lower():
                                    preview = line.strip()[:120]
                                    matches.append(
                                        f"{os.path.relpath(fpath, root)}:{lineno}: {preview}"
                                    )
                                    if len(matches) >= max_results:
                                        break
                    except (OSError, PermissionError):
                        continue
                    if len(matches) >= max_results:
                        break

            preview = "\n".join(matches) if matches else "(no matches)"
            return ToolResult(
                request_id=request.request_id,
                tool_name="search_code",
                success=True,
                summary=f"Found {len(matches)} matches for '{query}' in {root}",
                stdout_preview=preview[:2000],
                exit_code=0,
            )
        except Exception as e:
            return ToolResult(
                request_id=request.request_id,
                tool_name="search_code",
                success=False,
                summary=str(e),
                exit_code=1,
            )

    def _run_shell(self, request: ToolRequest) -> ToolResult:
        command = request.arguments.get("command", "").strip()
        if not command:
            return ToolResult(
                request_id=request.request_id,
                tool_name="run_shell",
                success=False,
                summary="No command provided.",
                exit_code=1,
            )

        start = time.time()
        shell_result = run_shell_command(command, workspace_root=self.get_workspace())
        duration_ms = int((time.time() - start) * 1000)

        return ToolResult(
            request_id=request.request_id,
            tool_name="run_shell",
            success=shell_result["success"],
            summary=shell_result["summary"],
            stdout_preview=shell_result.get("stdout_preview", ""),
            stderr_preview=shell_result.get("stderr_preview", ""),
            exit_code=shell_result.get("exit_code", -1),
            duration_ms=duration_ms,
        )
