import { homedir } from "node:os";
import { join } from "node:path";

// Where Claude Code keeps its local state. By default that's ~/.claude.json
// plus the ~/.claude/ directory; when CLAUDE_CONFIG_DIR is set, Claude Code
// moves both inside that directory instead, so follow it the same way.
export function claudeConfigDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function claudeJsonPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.CLAUDE_CONFIG_DIR
    ? join(env.CLAUDE_CONFIG_DIR, ".claude.json")
    : join(homedir(), ".claude.json");
}
