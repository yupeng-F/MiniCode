from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from minicode.memory.sensitive_data_filter import SensitiveDataFilter


class TraceStore:
    """Append-only JSONL event store.

    A record is flushed and fsynced before ``append`` returns.  Corrupt/incomplete
    trailing records are ignored when reading so a killed daemon cannot make the
    preceding trace unavailable.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def append(self, event_type: str, payload: dict[str, Any], *, run_id: str = "") -> dict[str, Any]:
        record = {
            "id": str(uuid.uuid4()),
            "type": event_type,
            "run_id": run_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "payload": payload,
        }
        encoded = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
        with self._lock, self.path.open("a", encoding="utf-8") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        return record

    def iter_records(self, *, run_id: str | None = None, event_type: str | None = None) -> Iterable[dict[str, Any]]:
        if not self.path.exists():
            return
        with self.path.open(encoding="utf-8") as stream:
            for line in stream:
                try:
                    record = json.loads(line)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue
                if run_id is not None and record.get("run_id") != run_id:
                    continue
                if event_type is not None and record.get("type") != event_type:
                    continue
                yield record

    def read(self, **filters: str) -> list[dict[str, Any]]:
        return list(self.iter_records(**filters))


class AuditStore(TraceStore):
    """Security audit log that redacts secrets before durable storage."""

    def __init__(self, path: str | Path) -> None:
        super().__init__(path)
        self.filter = SensitiveDataFilter()

    def append_action(
        self,
        action: str,
        *,
        actor: str,
        outcome: str,
        details: dict[str, Any] | None = None,
        run_id: str = "",
    ) -> dict[str, Any]:
        safe_details = self._sanitize_value(details or {})
        return self.append(
            "audit",
            {"action": action, "actor": actor, "outcome": outcome, "details": safe_details},
            run_id=run_id,
        )

    def _sanitize_value(self, value: Any, key: str = "") -> Any:
        if isinstance(value, dict):
            return {item_key: self._sanitize_value(item_value, item_key) for item_key, item_value in value.items()}
        if isinstance(value, list):
            return [self._sanitize_value(item, key) for item in value]
        if isinstance(value, str):
            keyed = f"{key}={value}" if key else value
            if self.filter.contains_sensitive(keyed):
                return "Sensitive value redacted"
            return self.filter.sanitize(value)
        return value
