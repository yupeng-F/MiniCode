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
});
