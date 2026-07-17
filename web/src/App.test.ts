import { describe, expect, it } from "vitest";

import { toggleExpandedDirectory } from "./App";

describe("目录树状态", () => {
  it("关闭已展开目录时不修改原集合", () => {
    const current = new Set(["src"]);

    const next = toggleExpandedDirectory(current, "src");

    expect(next).toEqual(new Set());
    expect(current).toEqual(new Set(["src"]));
  });
});
