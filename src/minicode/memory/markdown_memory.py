from __future__ import annotations

from pathlib import Path


class MarkdownMemory:
    def __init__(self, root: str | Path = ".minicode/memory") -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    @property
    def index_path(self) -> Path:
        return self.root / "MEMORY.md"

    def ensure_index(self) -> None:
        if not self.index_path.exists():
            self.index_path.write_text("# Memory Index\n\n", encoding="utf-8")

    def read_index(self) -> str:
        self.ensure_index()
        return self.index_path.read_text(encoding="utf-8")

    def add(self, category: str, name: str, content: str) -> str:
        safe_category = "".join(ch if ch.isalnum() or ch in "_-" else "_" for ch in category)
        safe_name = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in name)
        directory = self.root / safe_category
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{safe_name}.md"
        path.write_text(content, encoding="utf-8")
        self.ensure_index()
        entry = f"- [{safe_category}/{safe_name}](./{safe_category}/{safe_name}.md)"
        index = self.index_path.read_text(encoding="utf-8")
        if entry not in index:
            with self.index_path.open("a", encoding="utf-8") as fh:
                fh.write(entry + "\n")
        return str(path.relative_to(self.root))
