import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("api client", () => {
  it("loads a persisted run by id", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ run_id: "run-1", status: "waiting_approval" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);

    await expect(api.getRun("run-1")).resolves.toMatchObject({ status: "waiting_approval" });
    expect(fetch).toHaveBeenCalledWith("/api/runs/run-1", expect.objectContaining({ headers: { "Content-Type": "application/json" } }));
  });

  it("surfaces API error details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "Run not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(api.getRun("missing")).rejects.toThrow("Run not found");
  });

  it("submits an approval decision", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "running" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);

    await api.decide("run-1", "approve");
    expect(fetch).toHaveBeenCalledWith("/api/runs/run-1/approval", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
    }));
  });

  it("读取模型能力并在创建会话时提交选择的模型", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        default_model: "deepseek-v4-flash",
        models: [{ id: "deepseek-v4-flash", label: "Flash" }, { id: "deepseek-v4-pro", label: "Pro" }],
        token_limits: { input: 48_000, output: 8_000, user_message: 12_000 },
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ session_id: "session-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetch);

    await api.capabilities();
    await api.createSession("project-1", "检查项目", "ask", "deepseek-v4-pro");

    expect(fetch).toHaveBeenNthCalledWith(1, "/api/capabilities", expect.any(Object));
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/projects/project-1/sessions", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ input: "检查项目", mode: "ask", model_id: "deepseek-v4-pro" }),
    }));
  });

  it("更新会话的下一次默认模型", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session_id: "session-1",
      model_id: "deepseek-v4-pro",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    await api.selectModel("session-1", "deepseek-v4-pro");

    expect(fetch).toHaveBeenCalledWith("/api/sessions/session-1/model", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ model_id: "deepseek-v4-pro" }),
    }));
  });
});
