from __future__ import annotations

from typing import List

from minicode.schemas.tool import ToolSpec


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolSpec] = {}

    def register(self, spec: ToolSpec) -> None:
        self._tools[spec.name] = spec

    def get(self, name: str) -> ToolSpec | None:
        return self._tools.get(name)

    def list(self) -> list[ToolSpec]:
        return list(self._tools.values())

    def visible_tools(self, mode: str = "act", role: str = "assistant") -> List[ToolSpec]:
        visible: list[ToolSpec] = []
        for spec in self._tools.values():
            if mode not in spec.allowed_modes:
                continue
            if spec.allowed_roles and role not in spec.allowed_roles:
                continue
            visible.append(spec)
        return visible
