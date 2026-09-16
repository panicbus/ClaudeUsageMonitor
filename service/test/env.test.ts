import { describe, expect, it } from "vitest";
import { parseOptionalPositiveInt, parseRequiredPositiveInt } from "../src/env.js";

describe("parseOptionalPositiveInt", () => {
  it("returns null when unset", () => {
    expect(parseOptionalPositiveInt(undefined)).toBeNull();
  });

  it("parses a valid positive integer string", () => {
    expect(parseOptionalPositiveInt("500000")).toBe(500000);
  });

  it("returns null for non-numeric input", () => {
    expect(parseOptionalPositiveInt("not-a-number")).toBeNull();
  });

  it("returns null for zero or negative input", () => {
    expect(parseOptionalPositiveInt("0")).toBeNull();
    expect(parseOptionalPositiveInt("-5")).toBeNull();
  });
});

describe("parseRequiredPositiveInt", () => {
  it("returns the default when unset", () => {
    expect(parseRequiredPositiveInt("PORT", undefined, 4317)).toBe(4317);
  });

  it("parses a valid positive integer string", () => {
    expect(parseRequiredPositiveInt("PORT", "8080", 4317)).toBe(8080);
  });

  it("throws a descriptive error for non-numeric input", () => {
    expect(() => parseRequiredPositiveInt("PORT", "nope", 4317)).toThrow(
      /PORT/,
    );
  });

  it("throws a descriptive error for zero or negative input", () => {
    expect(() => parseRequiredPositiveInt("POLL_INTERVAL_MS", "0", 15000)).toThrow(
      /POLL_INTERVAL_MS/,
    );
    expect(() =>
      parseRequiredPositiveInt("POLL_INTERVAL_MS", "-1", 15000),
    ).toThrow(/POLL_INTERVAL_MS/);
  });

  it("throws for a blank/whitespace value", () => {
    expect(() => parseRequiredPositiveInt("PORT", "   ", 4317)).toThrow();
  });
});
