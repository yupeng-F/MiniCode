import { describe, expect, it } from "vitest";

import * as AppModule from "./App";

const { isActiveRunStatus, shouldRenderFinalAnswer } = AppModule;

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
