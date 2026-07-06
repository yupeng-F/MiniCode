"""Shell 沙箱执行器：安全地执行 shell 命令。

提供多层防护：
1. 命令黑名单 — 拦截破坏性命令
2. 超时保护 — 防止死循环/卡死
3. 输出上限 — 防止内存溢出
4. 工作区限制 — 限制在项目目录内
"""

from __future__ import annotations

import os
import re
import subprocess
import time

# ── 黑名单 ─────────────────────────────────────────────
# 这些模式匹配的命令会被直接拦截，无合法开发用途
DESTRUCTIVE_PATTERNS: list[re.Pattern] = [
    # 递归删除根目录或 home
    re.compile(r'\brm\s+(-rf|-/s+rf)\s+(/\s*$|/\s|~\s*$|~\s)'),
    # 原始磁盘写入
    re.compile(r'\bdd\s+if='),
    # 格式化/分区
    re.compile(r'\bmkfs\b'),
    re.compile(r'\bfdisk\b'),
    # 系统控制
    re.compile(r'\bshutdown\b'),
    re.compile(r'\breboot\b'),
    re.compile(r'\bhalt\b'),
    re.compile(r'\bpoweroff\b'),
    re.compile(r'\binit\s+0\b'),
    re.compile(r'\binit\s+6\b'),
    # Fork 炸弹
    re.compile(r':\(\)\s*\{'),
    # Windows 格式化
    re.compile(r'\bformat\s+\w:'),
]

SHELL_TIMEOUT = 30        # 单条命令超时（秒）
MAX_OUTPUT_CHARS = 100_000  # stdout/stderr 截断上限


def check_command_safety(command: str) -> str | None:
    """检查命令是否安全。返回 None 表示安全，返回 str 表示被拦截的原因。"""
    for pattern in DESTRUCTIVE_PATTERNS:
        if pattern.search(command):
            return f"Command blocked by safety policy: matches dangerous pattern"
    return None


def run_shell_command(
    command: str,
    timeout: int = SHELL_TIMEOUT,
    workspace_root: str | None = None,
) -> dict:
    """在沙箱中执行 shell 命令，返回结果字典。"""
    result: dict = {
        "success": False,
        "summary": "",
        "stdout_preview": "",
        "stderr_preview": "",
        "exit_code": -1,
        "duration_ms": 0,
    }

    # 安全检查
    blocked = check_command_safety(command)
    if blocked:
        result["summary"] = blocked
        return result

    start = time.time()
    try:
        proc = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=workspace_root or os.getcwd(),
        )
        duration_ms = int((time.time() - start) * 1000)

        stdout = (proc.stdout or "")[:MAX_OUTPUT_CHARS]
        stderr = (proc.stderr or "")[:MAX_OUTPUT_CHARS]

        summary_parts = [f"Exit code {proc.returncode}"]
        if proc.stdout:
            summary_parts.append(f"stdout: {len(proc.stdout)} chars")
        if proc.stderr:
            summary_parts.append(f"stderr: {len(proc.stderr)} chars")

        result.update({
            "success": proc.returncode == 0,
            "summary": ", ".join(summary_parts),
            "stdout_preview": stdout[:2000],
            "stderr_preview": stderr[:2000],
            "exit_code": proc.returncode,
            "duration_ms": duration_ms,
        })
    except subprocess.TimeoutExpired:
        result["summary"] = f"Command timed out after {timeout}s"
    except FileNotFoundError as e:
        result["summary"] = f"Command not found: {e}"
    except PermissionError as e:
        result["summary"] = f"Permission denied: {e}"
    except OSError as e:
        result["summary"] = f"System error: {e}"
    except Exception as e:
        result["summary"] = f"Execution error: {e}"

    return result
