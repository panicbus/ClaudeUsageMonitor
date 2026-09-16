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
    },
  ],
};

const weeklyJson = {
  weekly: [{ period: "2026-09-07", totalTokens: 3500000 }],
};

const historicalBlocksJson = {
  blocks: [
    { isActive: false, totalTokens: 100000 },
    { isActive: false, totalTokens: 500000 },
    { isActive: true, totalTokens: 999999999 },
  ],
};

const historicalWeeklyJson = {
  weekly: [
    { period: "2026-08-31", totalTokens: 7000000 },
    { period: "2026-09-07", totalTokens: 3500000 },
  ],
};

const noHistory = fixedRunner({ blocks: [], weekly: [] });

describe("buildUsageResponse", () => {
  it("assembles a healthy response with both limits explicitly configured (skips self-calibration)", async () => {
    const response = await buildUsageResponse({
      runActiveBlock: fixedRunner(activeBlockJson),
      runWeekly: fixedRunner(weeklyJson),
      runAllBlocks: fixedRunner({ blocks: [{ isActive: false, totalTokens: 999999999 }] }),
      runAllWeekly: fixedRunner({ weekly: [{ period: "2026-01-01", totalTokens: 999999999 }] }),
      weeklyResetAnchor: null,
      refineSessionStart: null,
      limits: { sessionTokenLimit: 500000, weeklyTokenLimit: 7000000 },
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
      },
      week: {
        tokensUsed: 3500000,
        tokenLimit: 7000000,
        percentUsed: 50,
        windowStart: "2026-09-07T00:00:00.000Z",
        windowEnd: "2026-09-14T00:00:00.000Z",
        minutesRemaining: 979,
      },
    });
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
      limits: { sessionTokenLimit: 500000, weeklyTokenLimit: 7000000 },
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
      limits: { sessionTokenLimit: 500000, weeklyTokenLimit: 7000000 },
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
      limits: { sessionTokenLimit: null, weeklyTokenLimit: 7000 },
      now: () => NOW,
    });

    expect(response.week).toEqual({
      tokensUsed: 3500,
      tokenLimit: 7000,
      percentUsed: 50,
      windowStart: "2026-09-06T12:00:00.000Z",
      windowEnd: "2026-09-13T12:00:00.000Z",
      minutesRemaining: 259,
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
      limits: { sessionTokenLimit: null, weeklyTokenLimit: null },
      now: () => NOW,
    });

    // session: 250000 / 500000 (historical max, excluding the active block) = 50%
    expect(response.session?.tokenLimit).toBe(500000);
    expect(response.session?.percentUsed).toBe(50);
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
      limits: { sessionTokenLimit: null, weeklyTokenLimit: null },
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
      limits: { sessionTokenLimit: null, weeklyTokenLimit: null },
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
      limits: { sessionTokenLimit: null, weeklyTokenLimit: null },
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
      limits: { sessionTokenLimit: null, weeklyTokenLimit: null },
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
      limits: { sessionTokenLimit: null, weeklyTokenLimit: null },
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
      limits: { sessionTokenLimit: null, weeklyTokenLimit: null },
      now: () => NOW,
    });

    expect(response.service.status).toBe("degraded");
    expect(response.service.error).toMatch(/malformed json/i);
    expect(response.week).toBeNull();
    expect(response.session).not.toBeNull();
  });

  it("combines both errors when both calls fail", async () => {
    const response = await buildUsageResponse({
      runActiveBlock: async () => "not json",
      runWeekly: async () => "also not json",
      runAllBlocks: noHistory,
      runAllWeekly: noHistory,
      weeklyResetAnchor: null,
      refineSessionStart: null,
      limits: { sessionTokenLimit: null, weeklyTokenLimit: null },
      now: () => NOW,
    });

    expect(response.service.status).toBe("degraded");
    expect(response.session).toBeNull();
    expect(response.week).toBeNull();
  });
});
