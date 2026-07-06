from __future__ import annotations

import json
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from multi_agents.llm.client import LLMClient
    from multi_agents.schemas.tool import ToolResult


class SummaryManager:
    """LLM 驱动的上下文压缩与 sliding window 管理。

    职责：
    - 对长文本进行 LLM 摘要压缩（降级到截断）
    - 对 AgentInput 字段执行 sliding window 裁剪
    - 压缩 context_bundle 以减小 token 消耗
    """

    def __init__(self, llm: LLMClient | None = None, max_summary_length: int = 500) -> None:
        self.llm = llm
        self.max_summary_length = max_summary_length

    # ── 摘要压缩 ──────────────────────────────────────

    def summarize(self, content: str, max_length: int | None = None) -> str:
        """压缩长文本为摘要。超过阈值时使用 LLM，否则原文返回。"""
        threshold = max_length or self.max_summary_length
        if len(content) <= threshold:
            return content
        if self.llm is None:
            return content[:threshold] + "…"
        return self._llm_summarize(content, threshold)

    def _llm_summarize(self, content: str, max_length: int) -> str:
        prompt = (
            "Summarize the following execution context concisely. "
            "Keep all technically important details (errors, decisions, file paths, key values). "
            f"Output within {max_length} characters.\n\n{content}"
        )
        try:
            return self.llm.chat(
                messages=[{"role": "user", "content": prompt}],
                temperature=0.1,
                max_tokens=max_length,
            )
        except Exception:
            return content[: max_length - 1] + "…"

    # ── context_bundle 压缩 ───────────────────────────

    def compress_bundle(
        self,
        bundle: dict | None,
        max_field_length: int = 800,
    ) -> dict:
        """对 context_bundle 中的每个字符串/列表字段做摘要压缩。"""
        if not bundle:
            return {}
        compressed: dict = {}
        for key, value in bundle.items():
            if isinstance(value, str):
                compressed[key] = self.summarize(value, max_field_length)
            elif isinstance(value, list):
                items = [str(i) for i in value]
                total = sum(len(i) for i in items)
                if total > max_field_length:
                    joined = "\n".join(items)
                    compressed[key] = self.summarize(joined, max_field_length)
                else:
                    compressed[key] = value
            else:
                compressed[key] = value
        return compressed

    # ── Sliding Window ────────────────────────────────

    @staticmethod
    def slice_tool_results(
        results: list[ToolResult],
        max_items: int = 5,
    ) -> list[ToolResult]:
        """滑动窗口裁剪 tool_results。

        规则：
        - 保留最近的 max_items 条
        - 其中如果包含错误结果（success=False），始终保留
        - 非错误结果超出 max_items 的部分丢弃
        """
        if not results:
            return []

        # 分离错误结果
        errors = [r for r in results if not r.success]
        ok_recent = [r for r in results if r.success][-max_items:]

        merged = errors + ok_recent
        # 如果合并后超过 max_items，裁剪非错误部分
        if len(merged) > max_items:
            overflow = len(merged) - max_items
            # 优先保留错误，裁剪 ok_recent
            ok_recent = ok_recent[overflow:]
            merged = errors + ok_recent
        return merged

    @staticmethod
    def slice_plan(plan: list[str], max_steps: int = 5) -> list[str]:
        """滑动窗口裁剪 plan 步骤。

        当前简化策略：取前 max_steps 条。
        后续可扩展为根据 execution progress 动态选取未完成步骤。
        """
        return plan[:max_steps]

    @staticmethod
    def slice_task_memory(
        memory: list[str],
        max_items: int = 8,
        max_item_length: int = 300,
    ) -> list[str]:
        """裁剪 task_memory：保留最近 max_items 条，单条超长截断。"""
        trimmed = []
        for item in memory[-max_items:]:
            if len(item) > max_item_length:
                item = item[:max_item_length] + "…"
            trimmed.append(item)
        return trimmed
