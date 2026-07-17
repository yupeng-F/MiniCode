from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from minicode.schemas.project import Project, SessionSummary
from minicode.schemas.session import SessionState
from minicode.storage.sqlite_store import _session_from_dict


class GlobalStore:
    """Persistent index for local projects and their conversation sessions."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS projects (
                    project_id TEXT PRIMARY KEY,
                    workspace TEXT UNIQUE NOT NULL,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    run_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    status TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    FOREIGN KEY(project_id) REFERENCES projects(project_id)
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_project_updated ON sessions(project_id, updated_at DESC)")

    def upsert_project(self, project: Project) -> Project:
        existing = self.get_project_by_workspace(project.workspace)
        if existing:
            return existing
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO projects(project_id, workspace, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                (project.project_id, project.workspace, project.title, project.created_at, project.updated_at),
            )
        return project

    def get_project_by_workspace(self, workspace: str) -> Project | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM projects WHERE workspace = ?", (workspace,)).fetchone()
        return _project_from_row(row) if row else None

    def get_project(self, project_id: str) -> Project | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM projects WHERE project_id = ?", (project_id,)).fetchone()
        return _project_from_row(row) if row else None

    def list_projects(self) -> list[Project]:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM projects ORDER BY updated_at DESC, title COLLATE NOCASE").fetchall()
        return [_project_from_row(row) for row in rows]

    def save_session(self, project_id: str, session: SessionState, title: str | None = None) -> None:
        payload = session.model_dump_json()
        session_title = title or session.task[:120] or "Untitled session"
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO sessions(session_id, project_id, run_id, title, status, updated_at, payload)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    run_id=excluded.run_id,
                    title=sessions.title,
                    status=excluded.status,
                    updated_at=excluded.updated_at,
                    payload=excluded.payload
                """,
                (session.session_id, project_id, session.run_id, session_title, session.status, _now(), payload),
            )
            conn.execute("UPDATE projects SET updated_at = ? WHERE project_id = ?", (_now(), project_id))

    def load_session(self, session_id: str) -> SessionState | None:
        with self._connect() as conn:
            row = conn.execute("SELECT payload FROM sessions WHERE session_id = ?", (session_id,)).fetchone()
        return _session_from_dict(json.loads(row["payload"])) if row else None

    def list_sessions(self, project_id: str) -> list[SessionSummary]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT session_id, project_id, title, status, updated_at FROM sessions WHERE project_id = ? ORDER BY updated_at DESC",
                (project_id,),
            ).fetchall()
        return [SessionSummary(**dict(row)) for row in rows]

    def delete_session(self, session_id: str) -> bool:
        with self._connect() as conn:
            cursor = conn.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))
        return cursor.rowcount > 0

    def delete_project(self, project_id: str) -> bool:
        with self._connect() as conn:
            conn.execute("DELETE FROM sessions WHERE project_id = ?", (project_id,))
            cursor = conn.execute("DELETE FROM projects WHERE project_id = ?", (project_id,))
        return cursor.rowcount > 0


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _project_from_row(row: sqlite3.Row) -> Project:
    return Project(**dict(row))
