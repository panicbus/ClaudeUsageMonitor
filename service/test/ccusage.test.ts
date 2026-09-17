import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  getActiveSessionBlock,
  getHistoricalMaxBlockUsage,
  getHistoricalMaxWeeklyTokens,
  getWeeklyTotal,
} from "../src/ccusage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): string {
  return readFileSync(join(__dirname, "fixtures", name), "utf-8");
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getActiveSessionBlock", () => {
  it("extracts the active block's token count and window from ccusage output", async () => {
    const result = await getActiveSessionBlock(async () =>
      loadFixture("blocks-active.json"),
    );

    expect(result).toEqual({
      ok: true,
      block: {
        active: true,
        tokensUsed: 1562839,
        costUsed: 0.8164070000000001,
        windowStart: "2026-09-13T06:00:00.000Z",
        windowEnd: "2026-09-13T11:00:00.000Z",
      },
    });
  });

  it("returns a null block when ccusage reports no active session", async () => {
    const result = await getActiveSessionBlock(async () =>
      loadFixture("blocks-empty.json"),
    );

    expect(result).toEqual({ ok: true, block: null });
  });

  it("fails gracefully when ccusage's stdout isn't valid JSON", async () => {
    const result = await getActiveSessionBlock(async () => "not json at all");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/malformed json/i);
    }
  });

  it("fails gracefully when the JSON has no 'blocks' array", async () => {
    const result = await getActiveSessionBlock(async () =>
      loadFixture("blocks-no-array.json"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/blocks/i);
    }
  });

  it("fails gracefully when a block is missing expected fields", async () => {
    const result = await getActiveSessionBlock(async () =>
      loadFixture("blocks-missing-fields.json"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/missing expected fields/i);
    }
  });

  it("fails gracefully when a block's timestamps are syntactically stringy but not real dates", async () => {
    const result = await getActiveSessionBlock(async () =>
      loadFixture("blocks-bad-dates.json"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/missing expected fields/i);
    }
  });

  it("fails gracefully when a block is missing costUSD", async () => {
    const result = await getActiveSessionBlock(async () =>
      loadFixture("blocks-missing-cost.json"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/missing expected fields/i);
    }
  });

  it("fails gracefully when the ccusage binary itself can't be run, without leaking the raw error detail", async () => {
    const result = await getActiveSessionBlock(async () => {
      throw new Error(
        "spawn /Users/someone/project/node_modules/ccusage/src/cli.js ENOENT",
      );
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("ccusage exec failed");
      expect(result.error).not.toMatch(/node_modules/);
    }
  });
});

describe("getWeeklyTotal", () => {
  const NOW_MID_WEEK = new Date("2026-09-10T12:00:00.000Z");

  it("extracts the current week's token total and a 7-day UTC window from the period", async () => {
    const result = await getWeeklyTotal(
      async () => loadFixture("weekly-current.json"),
      NOW_MID_WEEK,
    );

    expect(result).toEqual({
      ok: true,
      week: {
        tokensUsed: 1385484328,
        windowStart: "2026-09-07T00:00:00.000Z",
        windowEnd: "2026-09-14T00:00:00.000Z",
      },
    });
  });

  it("returns a null week when ccusage reports no weekly data", async () => {
    const result = await getWeeklyTotal(
      async () => loadFixture("weekly-empty.json"),
      NOW_MID_WEEK,
    );

    expect(result).toEqual({ ok: true, week: null });
  });

  it("returns a null week when the returned period has already fully elapsed", async () => {
    const farFuture = new Date("2026-12-01T00:00:00.000Z");

    const result = await getWeeklyTotal(
      async () => loadFixture("weekly-current.json"),
      farFuture,
    );

    expect(result).toEqual({ ok: true, week: null });
  });

  it("fails gracefully when the weekly entry is missing expected fields", async () => {
    const result = await getWeeklyTotal(
      async () => loadFixture("weekly-missing-fields.json"),
      NOW_MID_WEEK,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/missing expected fields/i);
    }
  });

  it("fails gracefully when the period is shaped like a date but isn't a real calendar date", async () => {
    const result = await getWeeklyTotal(
      async () => loadFixture("weekly-bad-date.json"),
      NOW_MID_WEEK,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/missing expected fields/i);
    }
  });

  it("fails gracefully when ccusage's stdout isn't valid JSON", async () => {
    const result = await getWeeklyTotal(async () => "not json at all", NOW_MID_WEEK);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/malformed json/i);
    }
  });

  it("fails gracefully when the ccusage binary itself can't be run, without leaking the raw error detail", async () => {
    const result = await getWeeklyTotal(async () => {
      throw new Error(
        "spawn /Users/someone/project/node_modules/ccusage/src/cli.js ENOENT",
      );
    }, NOW_MID_WEEK);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("ccusage exec failed");
      expect(result.error).not.toMatch(/node_modules/);
    }
  });
});

describe("getHistoricalMaxBlockUsage", () => {
  it("returns the highest totalTokens AND highest costUSD among completed blocks - independently, since they need not be the same block", async () => {
    const result = await getHistoricalMaxBlockUsage(async () =>
      loadFixture("blocks-history.json"),
    );

    // maxTokens comes from the 45,938,431-token block; maxCost comes from
    // the 3,360,556-token block ($22.70) - a smaller, cheaper-per-token
    // block can still be the priciest one, which is exactly why cost and
    // token maxima are tracked separately rather than assumed to coincide.
    expect(result).toEqual({ ok: true, maxTokens: 45938431, maxCost: 22.7 });
  });

  it("returns nulls when there are no completed blocks at all", async () => {
    const result = await getHistoricalMaxBlockUsage(async () =>
      loadFixture("blocks-empty.json"),
    );

    expect(result).toEqual({ ok: true, maxTokens: null, maxCost: null });
  });

  it("fails gracefully when ccusage's stdout isn't valid JSON", async () => {
    const result = await getHistoricalMaxBlockUsage(async () => "not json");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/malformed json/i);
    }
  });
});

describe("getHistoricalMaxWeeklyTokens", () => {
  const NOW_IN_LATEST_WEEK = new Date("2026-09-16T12:00:00.000Z");

  it("returns the highest totalTokens among fully-elapsed weeks, excluding the current in-progress week", async () => {
    const result = await getHistoricalMaxWeeklyTokens(
      async () => loadFixture("weekly-history.json"),
      NOW_IN_LATEST_WEEK,
    );

    expect(result).toEqual({ ok: true, maxTokens: 1385484328 });
  });

  it("returns null when there are no fully-elapsed weeks at all", async () => {
    const result = await getHistoricalMaxWeeklyTokens(
      async () => loadFixture("weekly-empty.json"),
      NOW_IN_LATEST_WEEK,
    );

    expect(result).toEqual({ ok: true, maxTokens: null });
  });

  it("fails gracefully when ccusage's stdout isn't valid JSON", async () => {
    const result = await getHistoricalMaxWeeklyTokens(
      async () => "not json",
      NOW_IN_LATEST_WEEK,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/malformed json/i);
    }
  });
});
