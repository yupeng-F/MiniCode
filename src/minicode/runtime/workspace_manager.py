from __future__ import annotations

from pathlib import Path


class WorkspaceViolation(ValueError):
    pass


class SensitivePathViolation(WorkspaceViolation):
    pass


SENSITIVE_FILENAMES = {".env", "credentials.json", "id_rsa", "id_ed25519"}
SENSITIVE_SUFFIXES = (".pem", ".key", ".p12", ".pfx")
SENSITIVE_DIRECTORIES = {".ssh", ".gnupg"}


class WorkspaceManager:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).expanduser().resolve()
        if not self.root.exists() or not self.root.is_dir():
            raise WorkspaceViolation(f"Workspace does not exist or is not a directory: {self.root}")

    def resolve_path(self, path: str | Path) -> Path:
        candidate = Path(path).expanduser()
        if not candidate.is_absolute():
            candidate = self.root / candidate
        resolved = candidate.resolve()
        self.ensure_inside_workspace(resolved)
        return resolved

    def ensure_inside_workspace(self, path: str | Path) -> None:
        resolved = Path(path).resolve()
        try:
            resolved.relative_to(self.root)
        except ValueError as exc:
            raise WorkspaceViolation(f"Path escapes workspace: {resolved}") from exc

    def display_path(self, path: str | Path) -> str:
        resolved = self.resolve_path(path)
        return str(resolved.relative_to(self.root))

    def ensure_safe_to_read(self, path: str | Path) -> None:
        resolved = self.resolve_path(path)
        relative_parts = resolved.relative_to(self.root).parts
        if any(part in SENSITIVE_DIRECTORIES for part in relative_parts):
            raise SensitivePathViolation("Sensitive workspace path cannot be read by the agent")
        name = resolved.name.lower()
        if name in SENSITIVE_FILENAMES or name.startswith(".env.") or name.endswith(SENSITIVE_SUFFIXES):
            raise SensitivePathViolation("Sensitive workspace path cannot be read by the agent")

    def is_sensitive_path(self, path: str | Path) -> bool:
        try:
            self.ensure_safe_to_read(path)
        except SensitivePathViolation:
            return True
        return False
