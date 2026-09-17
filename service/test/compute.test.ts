import { describe, expect, it } from "vitest";
import { buildUsageWindow, buildAuthoritativeWindow } from "../src/compute.js";

const NOW = new Date("2026-09-13T07:41:00.000Z");

describe("buildUsageWindow", () => {
  it("computes percentUsed and minutesRemaining from tokens when no cost limit is set", () => {
    const window = buildUsageWindow({
      tokensUsed: 250000,
      tokenLimit: 500000,
      costUsed: 0,
      costLimit: null,
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
      source: "estimated",
    });
  });

  it("returns percentUsed null when no limit of either kind is configured", () => {
    const window = buildUsageWindow({
      tokensUsed: 250000,
      tokenLimit: null,
      costUsed: 0,
      costLimit: null,
      windowStart: "2026-09-13T06:00:00.000Z",
      windowEnd: "2026-09-13T11:00:00.000Z",
      now: NOW,
    });

    expect(window.percentUsed).toBeNull();
  });

  it("clamps percentUsed at 100 when token-based usage exceeds the configured limit", () => {
    const window = buildUsageWindow({
      tokensUsed: 999999,
      tokenLimit: 500000,
      costUsed: 0,
      costLimit: null,
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
      costUsed: 0,
      costLimit: null,
      windowStart: "2026-09-13T01:00:00.000Z",
      windowEnd: "2026-09-13T06:00:00.000Z",
      now: NOW,
    });

    expect(window.minutesRemaining).toBe(0);
  });

  it("prefers cost-based percent over token-based when a cost limit is configured", () => {
    // 250000/500000 tokens would be 50%, but the cost basis (which
    // Anthropic's real accounting tracks far more consistently, since it
    // correctly discounts cheap cache-read tokens) says 18% - cost wins.
    const window = buildUsageWindow({
      tokensUsed: 250000,
      tokenLimit: 500000,
      costUsed: 6.48,
      costLimit: 36.0,
      windowStart: "2026-09-13T06:00:00.000Z",
      windowEnd: "2026-09-13T11:00:00.000Z",
      now: NOW,
    });

    expect(window.percentUsed).toBe(18);
    // tokensUsed/tokenLimit are still reported as real values - cost-basis
    // only changes what percentUsed is computed FROM, not what's displayed.
    expect(window.tokensUsed).toBe(250000);
    expect(window.tokenLimit).toBe(500000);
  });

  it("clamps cost-based percentUsed at 100 too", () => {
    const window = buildUsageWindow({
      tokensUsed: 100,
      tokenLimit: null,
      costUsed: 50,
      costLimit: 36.0,
      windowStart: "2026-09-13T06:00:00.000Z",
      windowEnd: "2026-09-13T11:00:00.000Z",
      now: NOW,
    });

    expect(window.percentUsed).toBe(100);
  });
});

describe("buildAuthoritativeWindow", () => {
  const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

  it("uses Anthropic's own utilization/resetsAt directly, deriving windowStart from the known window length", () => {
    const window = buildAuthoritativeWindow({
      tokensUsed: 46_481_082, // real ccusage figure, kept for display
      utilization: 30,
      resetsAt: "2026-09-17T03:21:12.955Z",
      windowDurationMs: FIVE_HOURS_MS,
      now: new Date("2026-09-16T23:07:47.217Z"),
    });

    expect(window).toEqual({
      tokensUsed: 46_481_082,
      tokenLimit: null, // no meaningful token-based limit when using the real %
      percentUsed: 30,
      windowStart: "2026-09-16T22:21:12.955Z",
      windowEnd: "2026-09-17T03:21:12.955Z",
      minutesRemaining: 253,
      source: "anthropic",
    });
  });

  it("floors a fractional utilization, matching Claude Code's own Math.floor (not round)", () => {
    const window = buildAuthoritativeWindow({
      tokensUsed: 0,
      utilization: 29.9,
      resetsAt: "2026-09-17T03:21:12.955Z",
      windowDurationMs: FIVE_HOURS_MS,
      now: new Date("2026-09-16T23:07:47.217Z"),
    });

    expect(window.percentUsed).toBe(29);
  });

  it("clamps an out-of-range utilization into 0-100 defensively", () => {
    const over = buildAuthoritativeWindow({
      tokensUsed: 0,
      utilization: 142,
      resetsAt: "2026-09-17T03:21:12.955Z",
      windowDurationMs: FIVE_HOURS_MS,
      now: new Date("2026-09-16T23:07:47.217Z"),
    });
    const under = buildAuthoritativeWindow({
      tokensUsed: 0,
      utilization: -5,
      resetsAt: "2026-09-17T03:21:12.955Z",
      windowDurationMs: FIVE_HOURS_MS,
      now: new Date("2026-09-16T23:07:47.217Z"),
    });

    expect(over.percentUsed).toBe(100);
    expect(under.percentUsed).toBe(0);
  });

  it("clamps minutesRemaining at 0 once the reset moment has passed", () => {
    const window = buildAuthoritativeWindow({
      tokensUsed: 0,
      utilization: 30,
      resetsAt: "2026-09-16T20:00:00.000Z",
      windowDurationMs: FIVE_HOURS_MS,
      now: new Date("2026-09-16T23:07:47.217Z"),
    });

    expect(window.minutesRemaining).toBe(0);
  });
});
