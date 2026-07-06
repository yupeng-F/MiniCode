"""Tests for ToolRegistry — role-based tool permission management."""

from __future__ import annotations

import pytest

from multi_agents.runtime.tool_registry import ToolRegistry
from multi_agents.tools.base import ToolSpec


@pytest.fixture
def registry() -> ToolRegistry:
    r = ToolRegistry()
    r.register(ToolSpec(
        name="read_file",
        description="Read file content",
        allowed_roles=["explorer", "coder", "reviewer", "tester"],
        risk_level="low",
    ))
    r.register(ToolSpec(
        name="write_file",
        description="Write file content",
        allowed_roles=["coder"],
        risk_level="medium",
        side_effect=True,
    ))
    r.register(ToolSpec(
        name="search_code",
        description="Search code in repository",
        allowed_roles=["explorer", "reviewer"],
        risk_level="low",
    ))
    r.register(ToolSpec(
        name="run_shell",
        description="Run a shell command",
        allowed_roles=["coder", "tester"],
        risk_level="high",
        side_effect=True,
    ))
    r.register(ToolSpec(
        name="list_directory",
        description="List directory contents",
        allowed_roles=[],
        risk_level="low",
    ))
    return r


class TestToolRegistry:
    """ToolRegistry permission tests."""

    def test_register_and_get_spec(self, registry: ToolRegistry):
        spec = registry.get_spec("read_file")
        assert spec is not None
        assert spec.name == "read_file"
        assert "explorer" in spec.allowed_roles

    def test_get_spec_unknown_tool(self, registry: ToolRegistry):
        assert registry.get_spec("nonexistent") is None

    def test_check_permission_allows_correct_role(self, registry: ToolRegistry):
        assert registry.check_permission("coder", "write_file") is True

    def test_check_permission_denies_wrong_role(self, registry: ToolRegistry):
        assert registry.check_permission("explorer", "write_file") is False

    def test_check_permission_allows_empty_roles(self, registry: ToolRegistry):
        """工具 allowed_roles 为空时，任何角色都能调用。"""
        assert registry.check_permission("any_role", "list_directory") is True

    def test_check_permission_unknown_tool(self, registry: ToolRegistry):
        assert registry.check_permission("coder", "unknown_tool") is False

    def test_get_tools_for_role_explorer(self, registry: ToolRegistry):
        tools = registry.get_tools_for_role("explorer")
        names = {t.name for t in tools}
        assert "read_file" in names
        assert "write_file" not in names  # explorer 不能写文件
        assert "search_code" in names
        assert "run_shell" not in names
        assert "list_directory" in names  # 空角色列表 = 全部允许

    def test_get_tools_for_role_coder(self, registry: ToolRegistry):
        tools = registry.get_tools_for_role("coder")
        names = {t.name for t in tools}
        assert "read_file" in names
        assert "write_file" in names
        assert "run_shell" in names
        assert "search_code" not in names  # coder 不能搜索代码

    def test_get_tools_for_role_reviewer(self, registry: ToolRegistry):
        tools = registry.get_tools_for_role("reviewer")
        names = {t.name for t in tools}
        assert "read_file" in names
        assert "search_code" in names
        assert "write_file" not in names
        assert "run_shell" not in names

    def test_get_tools_for_role_tester(self, registry: ToolRegistry):
        tools = registry.get_tools_for_role("tester")
        names = {t.name for t in tools}
        assert "read_file" in names
        assert "run_shell" in names
        assert "write_file" not in names
        assert "search_code" not in names

    def test_list_all(self, registry: ToolRegistry):
        tools = registry.list_all()
        assert len(tools) == 5

    def test_check_permission_with_master_role(self, registry: ToolRegistry):
        """Master 角色不应被允许调用任何工具。"""
        for tool in registry.list_all():
            if tool.allowed_roles:  # 只检查有角色限制的工具
                assert registry.check_permission("master", tool.name) is False
