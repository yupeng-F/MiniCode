from __future__ import annotations

import hashlib
from pathlib import Path


class ArtifactStore:
    """Stores large tool outputs outside prompts and state."""

    def __init__(self, root: str | Path = ".minicode") -> None:
        self.root = Path(root)

    def put(self, run_id: str, name: str, content: str) -> str:
        digest = hashlib.sha256(content.encode("utf-8", errors="ignore")).hexdigest()[:12]
        safe_name = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in name)[:80]
        rel = Path("runs") / run_id / "artifacts" / f"{safe_name}-{digest}.txt"
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return str(rel)

    def read(self, artifact_ref: str) -> str:
        return (self.root / artifact_ref).read_text(encoding="utf-8")
