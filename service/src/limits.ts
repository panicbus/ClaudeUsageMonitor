import { parseOptionalPositiveInt } from "./env.js";

export interface TokenLimits {
  sessionTokenLimit: number | null;
  weeklyTokenLimit: number | null;
}

export function readTokenLimits(
  env: Record<string, string | undefined> = process.env,
): TokenLimits {
  return {
    sessionTokenLimit: parseOptionalPositiveInt(env.CLAUDE_SESSION_TOKEN_LIMIT),
    weeklyTokenLimit: parseOptionalPositiveInt(env.WEEKLY_TOKEN_LIMIT),
  };
}
