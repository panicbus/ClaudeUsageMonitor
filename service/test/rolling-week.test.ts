import { describe, expect, it } from "vitest";
import { getRollingWeekTotal } from "../src/ccusage.js";
import { parseOptionalDate } from "../src/env.js";

// Blocks spread across three weeks so window selection is actually exercised.
const blocksJson = {
  blocks: [
    { isGap: false, startTime: "2026-09-01T10:00:00.000Z", totalTokens: 1000 },
    { isGap: false, startTime: "2026-09-10T10:00:00.000Z", totalTokens: 2000 },
    { isGap: false, startTime: "2026-09-15T10:00:00.000Z", totalTokens: 4000 },
    { isGap: false, startTime: "2026-09-17T10:00:00.000Z", totalTokens: 8000 },
    { isGap: true, startTime: "2026-09-17T20:00:00.000Z", totalTokens: 999999 },
  ],
};

const runner = async () => JSON.stringify(blocksJson);

describe("getRollingWeekTotal", () => {
  it("anchors the window to a future reset moment and sums only blocks inside it", async () => {
    // Reset at 2026-09-19T12:00Z means the live window is 09-12 -> 09-19.
    const anchor = new Date("2026-09-19T12:00:00.000Z");
    const now = new Date("2026-09-16T12:00:00.000Z");

    const result = await getRollingWeekTotal(runner, anchor, now);

    expect(result).toEqual({
      ok: true,
      week: {
        tokensUsed: 12000, // 09-15 (4000) + 09-17 (8000); gap block excluded
        windowStart: "2026-09-12T12:00:00.000Z",
        windowEnd: "2026-09-19T12:00:00.000Z",
      },
    });
  });

  it("works identically when the anchor is a past reset moment", async () => {
    // Same effective window, expressed as an anchor one period earlier.
    const anchor = new Date("2026-09-12T12:00:00.000Z");
    const now = new Date("2026-09-16T12:00:00.000Z");

    const result = await getRollingWeekTotal(runner, anchor, now);

    expect(result.ok).toBe(true);
    if (result.ok && result.week) {
      expect(result.week.windowStart).toBe("2026-09-12T12:00:00.000Z");
      expect(result.week.windowEnd).toBe("2026-09-19T12:00:00.000Z");
      expect(result.week.tokensUsed).toBe(12000);
    }
  });

  it("rolls forward to the correct window many periods after the anchor", async () => {
    const anchor = new Date("2026-01-02T12:00:00.000Z");
    const now = new Date("2026-09-16T12:00:00.000Z");

    const result = await getRollingWeekTotal(runner, anchor, now);

    expect(result.ok).toBe(true);
    if (result.ok && result.week) {
      const start = new Date(result.week.windowStart).getTime();
      const end = new Date(result.week.windowEnd).getTime();
      expect(start).toBeLessThanOrEqual(now.getTime());
      expect(end).toBeGreaterThan(now.getTime());
      expect(end - start).toBe(7 * 24 * 60 * 60 * 1000);
      // Anchored to a Friday 12:00Z, so the live window is 09-11 -> 09-18.
      expect(result.week.tokensUsed).toBe(12000);
    }
  });

  it("returns a zero total (not an error) when no blocks fall in the window", async () => {
    const anchor = new Date("2026-12-04T12:00:00.000Z");
    const now = new Date("2026-12-01T12:00:00.000Z");

    const result = await getRollingWeekTotal(runner, anchor, now);

    expect(result.ok).toBe(true);
    if (result.ok && result.week) {
      expect(result.week.tokensUsed).toBe(0);
    }
  });

  it("fails gracefully on malformed ccusage output", async () => {
    const result = await getRollingWeekTotal(
      async () => "not json",
      new Date("2026-09-19T12:00:00.000Z"),
      new Date("2026-09-16T12:00:00.000Z"),
    );

    expect(result.ok).toBe(false);
  });
});

describe("parseOptionalDate", () => {
  it("parses a valid ISO timestamp", () => {
    expect(parseOptionalDate("2026-09-19T12:00:00.000Z")?.toISOString()).toBe(
      "2026-09-19T12:00:00.000Z",
    );
  });

  it("returns null when unset", () => {
    expect(parseOptionalDate(undefined)).toBeNull();
  });

  it("returns null for an unparseable value rather than throwing", () => {
    expect(parseOptionalDate("next tuesday-ish")).toBeNull();
  });
});
