from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from minicode.schemas.session import Message, SessionState
from minicode.schemas.tool import ToolCall, ToolCallRecord, ToolResult


class SQLiteStore:
    def __init__(self, path: str | Path = ".minicode/state.db") -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init()

    def _connect(self):
        return sqlite3.connect(self.path)

    def _init(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    payload TEXT NOT NULL
                )
                """
            )

    def save_session(self, session: SessionState) -> None:
        payload = session.model_dump_json()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO sessions(session_id, run_id, status, payload)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    run_id=excluded.run_id,
                    status=excluded.status,
                    payload=excluded.payload
                """,
                (session.session_id, session.run_id, session.status, payload),
            )

    def load_session(self, session_id: str) -> SessionState | None:
        with self._connect() as conn:
            row = conn.execute("SELECT payload FROM sessions WHERE session_id = ?", (session_id,)).fetchone()
        if not row:
            return None
        return _session_from_dict(json.loads(row[0]))


def _session_from_dict(data: dict) -> SessionState:
    data = dict(data)
    data["messages"] = [Message(**m) for m in data.get("messages", [])]
    records = []
    for record in data.get("tool_calls", []):
        request = ToolCall(**record["request"])
        result = ToolResult(**record["result"]) if record.get("result") else None
        records.append(ToolCallRecord(
            call_id=record["call_id"],
            tool_name=record["tool_name"],
            request=request,
            status=record.get("status", "pending"),
            result=result,
            created_at=record.get("created_at", ""),
            completed_at=record.get("completed_at"),
        ))
    data["tool_calls"] = records
    if data.get("pending_tool_call"):
        data["pending_tool_call"] = ToolCall(**data["pending_tool_call"])
    return SessionState(**data)
