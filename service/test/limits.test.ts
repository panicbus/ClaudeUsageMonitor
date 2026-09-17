import { describe, expect, it } from "vitest";
import { readTokenLimits } from "../src/limits.js";

describe("readTokenLimits", () => {
  it("returns null for all limits when no env var is set", () => {
    expect(readTokenLimits({})).toEqual({
      sessionTokenLimit: null,
      weeklyTokenLimit: null,
      sessionCostLimit: null,
    });
  });

  it("parses valid numeric env vars", () => {
    expect(
      readTokenLimits({
        CLAUDE_SESSION_TOKEN_LIMIT: "500000",
        WEEKLY_TOKEN_LIMIT: "7000000",
        CLAUDE_SESSION_COST_LIMIT: "36.42",
      }),
    ).toEqual({
      sessionTokenLimit: 500000,
      weeklyTokenLimit: 7000000,
      sessionCostLimit: 36.42,
    });
  });

  it("treats a non-numeric value as unconfigured rather than throwing", () => {
    expect(
      readTokenLimits({
        CLAUDE_SESSION_TOKEN_LIMIT: "not-a-number",
        CLAUDE_SESSION_COST_LIMIT: "also-not-a-number",
      }),
    ).toEqual({
      sessionTokenLimit: null,
      weeklyTokenLimit: null,
      sessionCostLimit: null,
    });
  });

  it("treats a negative or zero value as unconfigured", () => {
    expect(
      readTokenLimits({
        CLAUDE_SESSION_TOKEN_LIMIT: "0",
        WEEKLY_TOKEN_LIMIT: "-100",
        CLAUDE_SESSION_COST_LIMIT: "-1.5",
      }),
    ).toEqual({
      sessionTokenLimit: null,
      weeklyTokenLimit: null,
      sessionCostLimit: null,
    });
  });
});
