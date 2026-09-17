import { parseOptionalPositiveNumber } from "./env.js";

export interface TokenLimits {
  sessionTokenLimit: number | null;
  weeklyTokenLimit: number | null;
  // Dollar-cost limit for the session window - takes priority over
  // sessionTokenLimit when set (see compute.ts). No weekly equivalent yet:
  // the token-based weekly figure has held up accurately in practice,
  // unlike the session figure, so it isn't switched over speculatively.
  sessionCostLimit: number | null;
}

export function readTokenLimits(
  env: Record<string, string | undefined> = process.env,
): TokenLimits {
  return {
    sessionTokenLimit: parseOptionalPositiveNumber(env.CLAUDE_SESSION_TOKEN_LIMIT),
    weeklyTokenLimit: parseOptionalPositiveNumber(env.WEEKLY_TOKEN_LIMIT),
    sessionCostLimit: parseOptionalPositiveNumber(env.CLAUDE_SESSION_COST_LIMIT),
  };
}
