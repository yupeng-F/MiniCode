import { describe, expect, it } from "vitest";

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
