import { describe, expect, it } from "vitest";
import {
  parseFlag,
  parseOptionalPositiveNumber,
  parseRequiredPositiveInt,
} from "../src/env.js";

describe("parseOptionalPositiveNumber", () => {
  it("returns null when unset", () => {
    expect(parseOptionalPositiveNumber(undefined)).toBeNull();
  });

  it("parses a valid positive integer string", () => {
    expect(parseOptionalPositiveNumber("500000")).toBe(500000);
  });

  it("parses a valid positive decimal string (e.g. a dollar-cost limit)", () => {
    expect(parseOptionalPositiveNumber("36.42")).toBe(36.42);
  });

  it("returns null for non-numeric input", () => {
    expect(parseOptionalPositiveNumber("not-a-number")).toBeNull();
  });

  it("returns null for zero or negative input", () => {
    expect(parseOptionalPositiveNumber("0")).toBeNull();
    expect(parseOptionalPositiveNumber("-5")).toBeNull();
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
    expect(() => parseRequiredPositiveInt("PORT", "nope", 4317)).toThrow(/PORT/);
  });

  it("throws a descriptive error for zero or negative input", () => {
    expect(() => parseRequiredPositiveInt("POLL_INTERVAL_MS", "0", 15000)).toThrow(
      /POLL_INTERVAL_MS/,
    );
    expect(() => parseRequiredPositiveInt("POLL_INTERVAL_MS", "-1", 15000)).toThrow(
      /POLL_INTERVAL_MS/,
    );
  });

  it("throws for a blank/whitespace value", () => {
    expect(() => parseRequiredPositiveInt("PORT", "   ", 4317)).toThrow();
  });
});

describe("parseFlag", () => {
  it("is off when unset or blank", () => {
    expect(parseFlag("X", undefined)).toBe(false);
    expect(parseFlag("X", "")).toBe(false);
  });

  it("accepts 1/true and 0/false, case-insensitively", () => {
    expect(parseFlag("X", "1")).toBe(true);
    expect(parseFlag("X", "TRUE")).toBe(true);
    expect(parseFlag("X", "0")).toBe(false);
    expect(parseFlag("X", "false")).toBe(false);
  });

  it("throws on anything else rather than silently staying off", () => {
    expect(() => parseFlag("X", "ture")).toThrow(/X must be/);
    expect(() => parseFlag("X", "yes")).toThrow(/X must be/);
  });
});
