import { describe, expect, it } from "vitest";
import { buildUsageResponse } from "../src/usage.js";
import type { CcusageRunner } from "../src/ccusage.js";

const NOW = new Date("2026-09-13T07:41:00.000Z");

function fixedRunner(json: unknown): CcusageRunner {
  return async () => JSON.stringify(json);
}

const activeBlockJson = {
  blocks: [
    {
      startTime: "2026-09-13T06:00:00.000Z",
      endTime: "2026-09-13T11:00:00.000Z",
      isActive: true,
      totalTokens: 250000,
      costUSD: 6.48,
    },
  ],
};

const weeklyJson = {
  weekly: [{ period: "2026-09-07", totalTokens: 3500000 }],
};

const historicalBlocksJson = {
  blocks: [
    { isActive: false, totalTokens: 100000, costUSD: 4 },
    { isActive: false, totalTokens: 500000, costUSD: 36 },
    { isActive: true, totalTokens: 999999999, costUSD: 500 },
  ],
};

const historicalWeeklyJson = {
  weekly: [
    { period: "2026-08-31", totalTokens: 7000000 },
    { period: "2026-09-07", totalTokens: 3500000 },
  ],
};

const noHistory = fixedRunner({ blocks: [], weekly: [] });

const NO_LIMITS = {
  sessionTokenLimit: null,
  weeklyTokenLimit: null,
  sessionCostLimit: null,
};

describe("buildUsageResponse", () => {
  it("assembles a healthy response with token limits explicitly configured (skips self-calibration)", async () => {
    const response = await buildUsageResponse({
      runActiveBlock: fixedRunner(activeBlockJson),
      runWeekly: fixedRunner(weeklyJson),
      runAllBlocks: fixedRunner({
        blocks: [{ isActive: false, totalTokens: 999999999, costUSD: 500 }],
      }),
      runAllWeekly: fixedRunner({ weekly: [{ period: "2026-01-01", totalTokens: 999999999 }] }),
      weeklyResetAnchor: null,
      refineSessionStart: null,
      getAuthoritativeUsage: null,
      limits: { sessionTokenLimit: 500000, weeklyTokenLimit: 7000000, sessionCostLimit: null },
      now: () => NOW,
    });

    expect(response).toEqual({
      schemaVersion: 1,
      generatedAt: NOW.toISOString(),
      service: { status: "ok", source: "ccusage" },
      session: {
        active: true,
        tokensUsed: 250000,
        tokenLimit: 500000,
        percentUsed: 50,
        windowStart: "2026-09-13T06:00:00.000Z",
        windowEnd: "2026-09-13T11:00:00.000Z",
        minutesRemaining: 199,
        source: "estimated",
      },
      week: {
        tokensUsed: 3500000,
        tokenLimit: 7000000,
        percentUsed: 50,
        windowStart: "2026-09-07T00:00:00.000Z",
        windowEnd: "2026-09-14T00:00:00.000Z",
        minutesRemaining: 979,
        source: "estimated",
      },
    });
  });

  it("prefers a configured cost limit over a token limit for the session percentage", async () => {
    // costUSD is 6.48; token math (250000/500000) would say 50%, but cost
    // math (6.48/36.00) says 18% - cost must win since it tracks Anthropic's
    // real accounting more consistently (see compute.ts).
    const response = await buildUsageResponse({
      runActiveBlock: fixedRunner(activeBlockJson),
      runWeekly: fixedRunner(weeklyJson),
      runAllBlocks: noHistory,
      runAllWeekly: noHistory,
      weeklyResetAnchor: null,
      refineSessionStart: null,
      getAuthoritativeUsage: null,
      limits: { sessionTokenLimit: 500000, weeklyTokenLimit: 7000000, sessionCostLimit: 36.0 },
      now: () => NOW,
    });

    expect(response.session?.percentUsed).toBe(18);
    expect(response.session?.tokensUsed).toBe(250000);
    expect(response.session?.tokenLimit).toBe(500000);
  });

  it("self-calibrates the session cost limit from the historical max cost, independent of the max-tokens block", async () => {
    const response = await buildUsageResponse({
      runActiveBlock: fixedRunner(activeBlockJson),
      runWeekly: fixedRunner(weeklyJson),
      runAllBlocks: fixedRunner(historicalBlocksJson),
      runAllWeekly: noHistory,
      weeklyResetAnchor: null,
      refineSessionStart: null,
      getAuthoritativeUsage: null,
      limits: NO_LIMITS,
      now: () => NOW,
    });

    // historicalBlocksJson's completed blocks: (100000 tok, $4) and
    // (500000 tok, $36) - both maxTokens (500000) and maxCost (36) happen
    // to come from the same block here, but the response should be
    // computed from cost (6.48/36 = 18%), not tokens (250000/500000 = 50%).
    expect(response.session?.percentUsed).toBe(18);
  });

  it("shifts the session window to the real first-message time instead of ccusage's hour-floored start", async () => {
    // ccusage reports the block as 06:00 -> 11:00, but the session really
    // began at 06:41, so the reset is 41 minutes later than ccusage implies.
    const response = await buildUsageResponse({
      runActiveBlock: fixedRunner(activeBlockJson),
      runWeekly: fixedRunner(weeklyJson),
      runAllBlocks: noHistory,
      runAllWeekly: noHistory,
      weeklyResetAnchor: null,
      refineSessionStart: async () => new Date("2026-09-13T06:41:00.000Z"),
      getAuthoritativeUsage: null,
      limits: { sessionTokenLimit: 500000, weeklyTokenLimit: 7000000, sessionCostLimit: null },
      now: () => NOW,
    });

    expect(response.session?.windowStart).toBe("2026-09-13T06:41:00.000Z");
    expect(response.session?.windowEnd).toBe("2026-09-13T11:41:00.000Z");
    // 07:41 -> 11:41 rather than the 199 minutes ccusage's floored start gives.
    expect(response.session?.minutesRemaining).toBe(240);
  });

  it("falls back to ccusage's window when the real start can't be found", async () => {
    const response = await buildUsageResponse({
      runActiveBlock: fixedRunner(activeBlockJson),
      runWeekly: fixedRunner(weeklyJson),
      runAllBlocks: noHistory,
      runAllWeekly: noHistory,
      weeklyResetAnchor: null,
      refineSessionStart: async () => null,
      getAuthoritativeUsage: null,
      limits: { sessionTokenLimit: 500000, weeklyTokenLimit: 7000000, sessionCostLimit: null },
      now: () => NOW,
    });

    expect(response.session?.windowEnd).toBe("2026-09-13T11:00:00.000Z");
    expect(response.session?.minutesRemaining).toBe(199);
  });

  it("uses the rolling 7-day window from the reset anchor instead of the calendar week", async () => {
    const response = await buildUsageResponse({
      runActiveBlock: fixedRunner(activeBlockJson),
      // Must be ignored entirely when an anchor is set.
      runWeekly: async () => {
        throw new Error("calendar-week path should not run when anchored");
      },
      runAllBlocks: fixedRunner({
        blocks: [
          // Before the window (09-06 -> 09-13), must be excluded.
          { isGap: false, startTime: "2026-09-05T10:00:00.000Z", totalTokens: 111 },
          { isGap: false, startTime: "2026-09-09T10:00:00.000Z", totalTokens: 2000 },
          { isGap: false, startTime: "2026-09-12T10:00:00.000Z", totalTokens: 1500 },
        ],
      }),
      runAllWeekly: noHistory,
      weeklyResetAnchor: new Date("2026-09-13T12:00:00.000Z"),
      refineSessionStart: null,
      getAuthoritativeUsage: null,
      limits: { sessionTokenLimit: null, weeklyTokenLimit: 7000, sessionCostLimit: null },
      now: () => NOW,
    });

    expect(response.week).toEqual({
      tokensUsed: 3500,
      tokenLimit: 7000,
      percentUsed: 50,
      windowStart: "2026-09-06T12:00:00.000Z",
      windowEnd: "2026-09-13T12:00:00.000Z",
      minutesRemaining: 259,
      source: "estimated",
    });
  });

  it("self-calibrates from historical max blocks/weeks when no limit is configured", async () => {
    const response = await buildUsageResponse({
      runActiveBlock: fixedRunner(activeBlockJson),
      runWeekly: fixedRunner(weeklyJson),
      runAllBlocks: fixedRunner(historicalBlocksJson),
      runAllWeekly: fixedRunner(historicalWeeklyJson),
      weeklyResetAnchor: null,
      refineSessionStart: null,
      getAuthoritativeUsage: null,
      limits: NO_LIMITS,
      now: () => NOW,
    });

    // week: 3500000 / 7000000 (historical max, excluding the current week) = 50%
    expect(response.week?.tokenLimit).toBe(7000000);
    expect(response.week?.percentUsed).toBe(50);
  });

  it("leaves percentUsed null when self-calibration has no history to draw from", async () => {
    const response = await buildUsageResponse({
      runActiveBlock: fixedRunner(activeBlockJson),
      runWeekly: fixedRunner(weeklyJson),
      runAllBlocks: noHistory,
      runAllWeekly: noHistory,
      weeklyResetAnchor: null,
      refineSessionStart: null,
      getAuthoritativeUsage: null,
      limits: NO_LIMITS,
      now: () => NOW,
    });

    expect(response.session?.tokenLimit).toBeNull();
    expect(response.session?.percentUsed).toBeNull();
    expect(response.week?.tokenLimit).toBeNull();
    expect(response.week?.percentUsed).toBeNull();
  });

  it("does not let a self-calibration fetch failure degrade the overall response", async () => {
    const response = await buildUsageResponse({
      runActiveBlock: fixedRunner(activeBlockJson),
      runWeekly: fixedRunner(weeklyJson),
      runAllBlocks: async () => "not json",
      runAllWeekly: async () => "not json",
      weeklyResetAnchor: null,
      refineSessionStart: null,
      getAuthoritativeUsage: null,
      limits: NO_LIMITS,
      now: () => NOW,
    });

    expect(response.service.status).toBe("ok");
    expect(response.session?.tokenLimit).toBeNull();
    expect(response.session?.percentUsed).toBeNull();
    expect(response.session?.tokensUsed).toBe(250000);
  });

  it("returns session: null when there is no active block", async () => {
    const response = await buildUsageResponse({
      runActiveBlock: fixedRunner({ blocks: [] }),
      runWeekly: fixedRunner(weeklyJson),
      runAllBlocks: noHistory,
      runAllWeekly: noHistory,
      weeklyResetAnchor: null,
      refineSessionStart: null,
      getAuthoritativeUsage: null,
      limits: NO_LIMITS,
      now: () => NOW,
    });

    expect(response.session).toBeNull();
    expect(response.service.status).toBe("ok");
  });

  it("returns week: null when there is no weekly data", async () => {
    const response = await buildUsageResponse({
      runActiveBlock: fixedRunner(activeBlockJson),
      runWeekly: fixedRunner({ weekly: [] }),
      runAllBlocks: noHistory,
      runAllWeekly: noHistory,
      weeklyResetAnchor: null,
      refineSessionStart: null,
      getAuthoritativeUsage: null,
      limits: NO_LIMITS,
      now: () => NOW,
    });

    expect(response.week).toBeNull();
    expect(response.service.status).toBe("ok");
  });

  it("marks the response degraded (but still returns week data) when the session block call fails", async () => {
    const response = await buildUsageResponse({
      runActiveBlock: async () => "not json",
      runWeekly: fixedRunner(weeklyJson),
      runAllBlocks: noHistory,
      runAllWeekly: noHistory,
      weeklyResetAnchor: null,
      refineSessionStart: null,
      getAuthoritativeUsage: null,
      limits: NO_LIMITS,
      now: () => NOW,
    });

    expect(response.service.status).toBe("degraded");
    expect(response.service.error).toMatch(/malformed json/i);
    expect(response.session).toBeNull();
    expect(response.week).not.toBeNull();
  });

  it("marks the response degraded (but still returns session data) when the weekly call fails", async () => {
    const response = await buildUsageResponse({
      runActiveBlock: fixedRunner(activeBlockJson),
      runWeekly: async () => "not json",
      runAllBlocks: noHistory,
      runAllWeekly: noHistory,
      weeklyResetAnchor: null,
      refineSessionStart: null,
      getAuthoritativeUsage: null,
      limits: NO_LIMITS,
      now: () => NOW,
    });

    expect(response.service.status).toBe("degraded");
    expect(response.service.error).toMatch(/malformed json/i);
    expect(response.week).toBeNull();
    expect(response.session).not.toBeNull();
  });

  it("prefers authoritative data over the estimate for both windows when available", async () => {
    const response = await buildUsageResponse({
      runActiveBlock: fixedRunner(activeBlockJson),
      runWeekly: fixedRunner(weeklyJson),
      runAllBlocks: noHistory,
      runAllWeekly: noHistory,
      weeklyResetAnchor: null,
      refineSessionStart: async () => {
        throw new Error("estimate path should not run when authoritative succeeds");
      },
      getAuthoritativeUsage: async () => ({
        ok: true,
        usage: {
          fiveHour: { utilization: 30, resetsAt: "2026-09-13T11:41:00.000Z" },
          sevenDay: { utilization: 42, resetsAt: "2026-09-19T18:00:00.000Z" },
        },
      }),
      limits: { sessionTokenLimit: 500000, weeklyTokenLimit: 7000000, sessionCostLimit: null },
      now: () => NOW,
    });

    // percentUsed/windowEnd/source come from the authoritative call, but
    // tokensUsed is still the real ccusage figure for both windows.
    expect(response.session).toEqual({
      active: true,
      tokensUsed: 250000,
      tokenLimit: null,
      percentUsed: 30,
      windowStart: "2026-09-13T06:41:00.000Z",
      windowEnd: "2026-09-13T11:41:00.000Z",
      minutesRemaining: 240,
      source: "anthropic",
    });
    expect(response.week).toEqual({
      tokensUsed: 3500000,
      tokenLimit: null,
      percentUsed: 42,
      windowStart: "2026-09-12T18:00:00.000Z",
      windowEnd: "2026-09-19T18:00:00.000Z",
      minutesRemaining: 9259,
      source: "anthropic",
    });
  });

  it("falls back to the estimate per-window when authoritative data is only present for one window", async () => {
    const response = await buildUsageResponse({
      runActiveBlock: fixedRunner(activeBlockJson),
      runWeekly: fixedRunner(weeklyJson),
      runAllBlocks: noHistory,
      runAllWeekly: noHistory,
      weeklyResetAnchor: null,
      refineSessionStart: null,
      getAuthoritativeUsage: async () => ({
        ok: true,
        usage: {
          fiveHour: { utilization: 30, resetsAt: "2026-09-13T11:41:00.000Z" },
          sevenDay: null, // e.g. cache had this window but not the other
        },
      }),
      limits: { sessionTokenLimit: 500000, weeklyTokenLimit: 7000000, sessionCostLimit: null },
      now: () => NOW,
    });

    expect(response.session?.source).toBe("anthropic");
    expect(response.session?.percentUsed).toBe(30);
    expect(response.week?.source).toBe("estimated");
    expect(response.week?.percentUsed).toBe(50); // the usual token-based estimate
  });

  it("falls back entirely to the estimate when the authoritative source fails outright", async () => {
    const response = await buildUsageResponse({
      runActiveBlock: fixedRunner(activeBlockJson),
      runWeekly: fixedRunner(weeklyJson),
      runAllBlocks: noHistory,
      runAllWeekly: noHistory,
      weeklyResetAnchor: null,
      refineSessionStart: null,
      getAuthoritativeUsage: async () => ({ ok: false, error: "no oauth token available" }),
      limits: { sessionTokenLimit: 500000, weeklyTokenLimit: 7000000, sessionCostLimit: null },
      now: () => NOW,
    });

    expect(response.session?.source).toBe("estimated");
    expect(response.week?.source).toBe("estimated");
    // A failed authoritative lookup is not itself a service error - the
    // estimate is a legitimate, working fallback, not a degraded state.
    expect(response.service.status).toBe("ok");
  });

  it("shows an authoritative session even when ccusage's own session block lookup fails entirely", async () => {
    // The whole point of tokensUsed defaulting to 0 here: a real percentage
    // should never be held hostage by ccusage's own local block parsing.
    const response = await buildUsageResponse({
      runActiveBlock: async () => "not json",
      runWeekly: fixedRunner(weeklyJson),
      runAllBlocks: noHistory,
      runAllWeekly: noHistory,
      weeklyResetAnchor: null,
      refineSessionStart: null,
      getAuthoritativeUsage: async () => ({
        ok: true,
        usage: {
          fiveHour: { utilization: 30, resetsAt: "2026-09-13T11:41:00.000Z" },
          sevenDay: null,
        },
      }),
      limits: { sessionTokenLimit: 500000, weeklyTokenLimit: 7000000, sessionCostLimit: null },
      now: () => NOW,
    });

    expect(response.session).not.toBeNull();
    expect(response.session?.source).toBe("anthropic");
    expect(response.session?.percentUsed).toBe(30);
    expect(response.session?.tokensUsed).toBe(0);
    // ccusage's own failure is still reported for visibility.
    expect(response.service.status).toBe("degraded");
  });

  it("combines both errors when both calls fail", async () => {
    const response = await buildUsageResponse({
      runActiveBlock: async () => "not json",
      runWeekly: async () => "also not json",
      runAllBlocks: noHistory,
      runAllWeekly: noHistory,
      weeklyResetAnchor: null,
      refineSessionStart: null,
      getAuthoritativeUsage: null,
      limits: NO_LIMITS,
      now: () => NOW,
    });

    expect(response.service.status).toBe("degraded");
    expect(response.session).toBeNull();
    expect(response.week).toBeNull();
  });
});
