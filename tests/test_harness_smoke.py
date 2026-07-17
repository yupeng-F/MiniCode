from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from fastapi.testclient import TestClient

from minicode.interfaces.web.server import app


def test_cli_mock_mode_completes_in_temporary_workspace(tmp_path: Path) -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "minicode.interfaces.cli",
            "--mock",
            "--workspace",
            str(tmp_path),
            "检查工作区",
        ],
        check=False,
        capture_output=True,
        text=True,
        env={**os.environ, "MINICODE_HOME": str(tmp_path / ".home")},
    )
    assert result.returncode == 0, result.stderr
    assert "MiniCode mock query loop completed." in result.stdout


def test_web_index_uses_temporary_global_store(tmp_path: Path) -> None:
    app.state.global_store_path = tmp_path / "home" / "minicode.db"
    response = TestClient(app).get("/")
    assert response.status_code == 200
    assert response.json() == {
        "name": "MiniCode",
        "architecture": "Tool-Use Loop + Harness Runtime + Context Management + Markdown Memory",
    }
