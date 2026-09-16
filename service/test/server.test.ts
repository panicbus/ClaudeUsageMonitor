import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createUsageServer } from "../src/server.js";
import type { UsageResponse } from "@claude-usage-monitor/shared";

const SAMPLE_RESPONSE: UsageResponse = {
  schemaVersion: 1,
  generatedAt: "2026-09-13T07:41:00.000Z",
  service: { status: "ok", source: "ccusage" },
  session: {
    active: true,
    tokensUsed: 250000,
    tokenLimit: 500000,
    percentUsed: 50,
    windowStart: "2026-09-13T06:00:00.000Z",
    windowEnd: "2026-09-13T11:00:00.000Z",
    minutesRemaining: 199,
  },
  week: null,
};

describe("createUsageServer", () => {
  let server: Server;
  let baseUrl: string;
  let snapshot: UsageResponse;

  beforeEach(async () => {
    snapshot = SAMPLE_RESPONSE;
    server = createUsageServer(() => snapshot);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves the current snapshot as JSON on GET /usage", async () => {
    const res = await fetch(`${baseUrl}/usage`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual(SAMPLE_RESPONSE);
  });

  it("reflects a degraded snapshot as-is, still with a 200 status", async () => {
    snapshot = {
      ...SAMPLE_RESPONSE,
      service: { status: "degraded", source: "ccusage", error: "boom" },
      session: null,
    };

    const res = await fetch(`${baseUrl}/usage`);
    const body = (await res.json()) as UsageResponse;

    expect(res.status).toBe(200);
    expect(body.service.status).toBe("degraded");
    expect(body.session).toBeNull();
  });

  it("returns a JSON 404 for unknown paths", async () => {
    const res = await fetch(`${baseUrl}/nope`);

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("returns a JSON 404 for non-GET requests to /usage", async () => {
    const res = await fetch(`${baseUrl}/usage`, { method: "POST" });

    expect(res.status).toBe(404);
  });
});
