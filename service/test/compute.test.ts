import { describe, expect, it } from "vitest";
import { buildUsageWindow } from "../src/compute.js";

const NOW = new Date("2026-09-13T07:41:00.000Z");

describe("buildUsageWindow", () => {
  it("computes percentUsed and minutesRemaining when a limit is configured", () => {
    const window = buildUsageWindow({
      tokensUsed: 250000,
      tokenLimit: 500000,
      windowStart: "2026-09-13T06:00:00.000Z",
      windowEnd: "2026-09-13T11:00:00.000Z",
      now: NOW,
    });

    expect(window).toEqual({
      tokensUsed: 250000,
      tokenLimit: 500000,
      percentUsed: 50,
      windowStart: "2026-09-13T06:00:00.000Z",
      windowEnd: "2026-09-13T11:00:00.000Z",
      minutesRemaining: 199,
    });
  });

  it("returns percentUsed null when no limit is configured", () => {
    const window = buildUsageWindow({
      tokensUsed: 250000,
      tokenLimit: null,
      windowStart: "2026-09-13T06:00:00.000Z",
      windowEnd: "2026-09-13T11:00:00.000Z",
      now: NOW,
    });

    expect(window.percentUsed).toBeNull();
  });

  it("clamps percentUsed at 100 when usage exceeds the configured limit", () => {
    const window = buildUsageWindow({
      tokensUsed: 999999,
      tokenLimit: 500000,
      windowStart: "2026-09-13T06:00:00.000Z",
      windowEnd: "2026-09-13T11:00:00.000Z",
      now: NOW,
    });

    expect(window.percentUsed).toBe(100);
  });

  it("clamps minutesRemaining at 0 when the window has already ended", () => {
    const window = buildUsageWindow({
      tokensUsed: 100,
      tokenLimit: null,
      windowStart: "2026-09-13T01:00:00.000Z",
      windowEnd: "2026-09-13T06:00:00.000Z",
      now: NOW,
    });

    expect(window.minutesRemaining).toBe(0);
  });
});
