from __future__ import annotations

from multi_agents.tools.base import ToolSpec


class ToolRegistry:
    """工具注册表，管理工具定义与角色权限。

    职责：
    - 注册所有可用工具及其元信息
    - 按角色查询可用工具列表
    - 校验某个角色是否有权限调用指定工具
    """

    def __init__(self) -> None:
        self._tools: dict[str, ToolSpec] = {}

    def register(self, spec: ToolSpec) -> None:
        """注册一个工具。"""
        self._tools[spec.name] = spec

    def get_spec(self, tool_name: str) -> ToolSpec | None:
        """获取工具规格定义。"""
        return self._tools.get(tool_name)

    def get_tools_for_role(self, role: str) -> list[ToolSpec]:
        """查询某个角色可以使用的所有工具。

        过滤逻辑：
        - allowed_roles 为空 → 全部允许
        - allowed_roles 非空 → 角色必须在列表中
        """
        return [
            t for t in self._tools.values()
            if not t.allowed_roles or role in t.allowed_roles
        ]

    def check_permission(self, role: str, tool_name: str) -> bool:
        """检查角色是否有权限调用指定工具。"""
        spec = self._tools.get(tool_name)
        if spec is None:
            return False
        if not spec.allowed_roles:
            return True
        return role in spec.allowed_roles

    def list_all(self) -> list[ToolSpec]:
        """列出所有已注册的工具。"""
        return list(self._tools.values())

    @property
    def tool_names(self) -> list[str]:
        return list(self._tools.keys())
