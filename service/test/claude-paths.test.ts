import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeConfigDir, claudeJsonPath } from "../src/claude-paths.js";

describe("claude paths", () => {
  it("defaults to ~/.claude and ~/.claude.json", () => {
    expect(claudeConfigDir({})).toBe(join(homedir(), ".claude"));
    expect(claudeJsonPath({})).toBe(join(homedir(), ".claude.json"));
  });

  it("moves both inside CLAUDE_CONFIG_DIR when it's set", () => {
    const env = { CLAUDE_CONFIG_DIR: "/tmp/cc" };
    expect(claudeConfigDir(env)).toBe("/tmp/cc");
    expect(claudeJsonPath(env)).toBe(join("/tmp/cc", ".claude.json"));
  });
});
