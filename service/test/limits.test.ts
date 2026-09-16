import { describe, expect, it } from "vitest";
import { readTokenLimits } from "../src/limits.js";

describe("readTokenLimits", () => {
  it("returns null for both limits when neither env var is set", () => {
    expect(readTokenLimits({})).toEqual({
      sessionTokenLimit: null,
      weeklyTokenLimit: null,
    });
  });

  it("parses valid numeric env vars", () => {
    expect(
      readTokenLimits({
        CLAUDE_SESSION_TOKEN_LIMIT: "500000",
        WEEKLY_TOKEN_LIMIT: "7000000",
      }),
    ).toEqual({
      sessionTokenLimit: 500000,
      weeklyTokenLimit: 7000000,
    });
  });

  it("treats a non-numeric value as unconfigured rather than throwing", () => {
    expect(
      readTokenLimits({
        CLAUDE_SESSION_TOKEN_LIMIT: "not-a-number",
      }),
    ).toEqual({
      sessionTokenLimit: null,
      weeklyTokenLimit: null,
    });
  });

  it("treats a negative or zero value as unconfigured", () => {
    expect(
      readTokenLimits({
        CLAUDE_SESSION_TOKEN_LIMIT: "0",
        WEEKLY_TOKEN_LIMIT: "-100",
      }),
    ).toEqual({
      sessionTokenLimit: null,
      weeklyTokenLimit: null,
    });
  });
});
