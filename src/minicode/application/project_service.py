from __future__ import annotations

from pathlib import Path

from minicode.schemas.project import Project
from minicode.storage.global_store import GlobalStore


class ProjectService:
    def __init__(self, store: GlobalStore) -> None:
        self.store = store

    def open_workspace(self, workspace: str | Path, title: str | None = None) -> Project:
        path = Path(workspace).expanduser().resolve()
        if not path.is_dir():
            raise ValueError(f"Workspace does not exist or is not a directory: {path}")
        return self.store.upsert_project(Project(workspace=str(path), title=title or path.name))

    def list_projects(self) -> list[Project]:
        return self.store.list_projects()

    def get_project(self, project_id: str) -> Project | None:
        return self.store.get_project(project_id)

    def get_project_by_workspace(self, workspace: str) -> Project | None:
        return self.store.get_project_by_workspace(workspace)

    def remove(self, project_id: str) -> bool:
        return self.store.delete_project(project_id)
