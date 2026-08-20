import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import * as AppModule from "./App";

const { isActiveRunStatus, shouldRenderFinalAnswer } = AppModule;

describe("Embedding 检索状态", () => {
  const embeddingStatusLabel = (AppModule as unknown as {
    embeddingStatusLabel?: (status?: { provider: string; external_transfer: boolean; fallback_reason: string }) => string;
  }).embeddingStatusLabel;

  it("提示阿里云外部传输", () => {
    expect(embeddingStatusLabel?.({ provider: "aliyun", external_transfer: true, fallback_reason: "" }))
      .toContain("内容已发送到阿里云");
  });

  it("显示本地模型和关键词降级原因", () => {
    expect(embeddingStatusLabel?.({ provider: "local", external_transfer: false, fallback_reason: "阿里云超时" }))
      .toBe("本地 embedding（阿里云超时）");
    expect(embeddingStatusLabel?.({ provider: "fts5", external_transfer: false, fallback_reason: "未安装本地模型" }))
      .toBe("关键词检索（未安装本地模型）");
  });
});

describe("记忆可观测卡片", () => {
  it("显示远程配置、本地安装状态和占用空间", () => {
    const Card = (AppModule as unknown as { EmbeddingCapabilitiesCard: React.ComponentType<Record<string, unknown>> }).EmbeddingCapabilitiesCard;
    const html = renderToStaticMarkup(createElement(Card, {
      capabilities: {
        remote_provider: "aliyun",
        remote_model: "qwen3.7-text-embedding",
        remote_configured: true,
        external_transfer: true,
        local_provider: "fastembed",
        local_model: "BAAI/bge-small-zh-v1.5",
        local_installed: true,
        local_size_bytes: 95_252_480,
        fallback: "fts5",
      },
    }));

    expect(html).toContain("Embedding 能力");
    expect(html).toContain("已配置");
    expect(html).toContain("已安装");
    expect(html).toContain("90.8 MB");
    expect(html).not.toContain("API Key");
  });

  it("显示本次检索耗时、命中摘要和三项得分", () => {
    const Card = (AppModule as unknown as { MemoryRetrievalCard: React.ComponentType<Record<string, unknown>> }).MemoryRetrievalCard;
    const html = renderToStaticMarkup(createElement(Card, {
      status: {
        provider: "aliyun",
        fallback_reason: "",
        external_transfer: true,
        token_count: 32,
        item_count: 1,
        elapsed_ms: 18.6,
        hits: [{
          memory_id: "readme-goal",
          tier: "long",
          preview: "项目目标是构建本地优先的编码 Agent。",
          keyword_score: 0.72,
          vector_score: 0.81,
          rrf_score: 0.79,
        }],
      },
    }));

    expect(html).toContain("本次检索");
    expect(html).toContain("18.6 ms");
    expect(html).toContain("项目目标是构建本地优先的编码 Agent。");
    expect(html).toContain("关键词");
    expect(html).toContain("向量");
    expect(html).toContain("RRF");
    expect(html).toContain("0.720");
    expect(html).toContain("0.810");
    expect(html).toContain("0.790");
  });

  it("旧 Run 缺少明细时不伪造零耗时或未命中状态", () => {
    const Card = (AppModule as unknown as { MemoryRetrievalCard: React.ComponentType<Record<string, unknown>> }).MemoryRetrievalCard;
    const html = renderToStaticMarkup(createElement(Card, {
      status: {
        provider: "fts5",
        fallback_reason: "旧检索记录",
        external_transfer: false,
        token_count: 20,
        item_count: 3,
      },
    }));

    expect(html).toContain("历史 Run 未记录命中明细");
    expect(html).not.toContain("0.0 ms");
    expect(html).not.toContain("本次检索未命中项目记忆");
  });
});

describe("final answer presentation", () => {
  it("does not render a final answer twice when it is already the last assistant message", () => {
    expect(shouldRenderFinalAnswer([
      { role: "user", content: "Run the smoke test" },
      { role: "assistant", content: "Done." },
    ], "Done.")).toBe(false);
  });

  it("keeps the final answer fallback when no matching assistant message exists", () => {
    expect(shouldRenderFinalAnswer([
      { role: "user", content: "Run the smoke test" },
    ], "Run failed.")).toBe(true);
  });
});

describe("run status tracking", () => {
  it("keeps tracking a newly created pending run", () => {
    expect(isActiveRunStatus("pending")).toBe(true);
  });

  it("stops tracking a completed run", () => {
    expect(isActiveRunStatus("completed")).toBe(false);
  });
});

describe("编辑器键盘行为", () => {
  const shouldSubmitComposer = (AppModule as unknown as {
    shouldSubmitComposer?: (event: { key: string; shiftKey: boolean; isComposing: boolean }) => boolean;
  }).shouldSubmitComposer;

  it("按 Enter 直接发送", () => {
    expect(typeof shouldSubmitComposer).toBe("function");
    expect(shouldSubmitComposer?.({ key: "Enter", shiftKey: false, isComposing: false })).toBe(true);
  });

  it("按 Shift+Enter 保留换行", () => {
    expect(shouldSubmitComposer?.({ key: "Enter", shiftKey: true, isComposing: false })).toBe(false);
  });

  it("中文输入法确认候选时不发送", () => {
    expect(shouldSubmitComposer?.({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
  });
});

describe("输入 Token 提示", () => {
  const estimateComposerTokens = (AppModule as unknown as {
    estimateComposerTokens?: (content: string) => number;
  }).estimateComposerTokens;

  it("对中文字符采用逐字估算并增加安全余量", () => {
    expect(typeof estimateComposerTokens).toBe("function");
    expect(estimateComposerTokens?.("你好")).toBe(3);
  });

  it("对英文字符按四字符估算并增加安全余量", () => {
    expect(estimateComposerTokens?.("abcdefgh")).toBe(3);
  });
});

describe("项目切换状态", () => {
  const shouldResetConversation = (AppModule as unknown as {
    shouldResetConversation?: (currentWorkspace: string | undefined, nextWorkspace: string) => boolean;
  }).shouldResetConversation;

  it("切换到不同工作区时清空旧会话", () => {
    expect(typeof shouldResetConversation).toBe("function");
    expect(shouldResetConversation?.("/project-a", "/project-b")).toBe(true);
  });

  it("重新选择同一工作区时保留会话", () => {
    expect(shouldResetConversation?.("/project-a", "/project-a")).toBe(false);
  });
});
