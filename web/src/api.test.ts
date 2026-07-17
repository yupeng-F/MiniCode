import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./api";

describe("MiniCode API Client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("从项目列表接口解析成功响应", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([{ project_id: "p-1", workspace: "/tmp/demo", title: "Demo" }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(api.listProjects()).resolves.toEqual([
      { project_id: "p-1", workspace: "/tmp/demo", title: "Demo" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith("/api/projects", {
      headers: { "Content-Type": "application/json" },
    });
  });

  it("非成功响应抛出后端错误信息", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Project not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(api.listProjects()).rejects.toThrow("Project not found");
  });
});
