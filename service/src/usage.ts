import type { UsageResponse } from "@claude-usage-monitor/shared";
import type { CcusageRunner } from "./ccusage.js";
import {
  getActiveSessionBlock,
  getHistoricalMaxBlockTokens,
  getHistoricalMaxWeeklyTokens,
  getRollingWeekTotal,
  getWeeklyTotal,
} from "./ccusage.js";
import { buildUsageWindow } from "./compute.js";
import type { TokenLimits } from "./limits.js";

// Resolves the real first-message time inside a block window, so the session
// countdown can track Anthropic's actual window rather than ccusage's
// hour-floored approximation of it.
export type SessionStartFinder = (
  windowStart: Date,
  windowEnd: Date,
) => Promise<Date | null>;

export interface BuildUsageResponseInput {
  runActiveBlock: CcusageRunner;
  runWeekly: CcusageRunner;
  runAllBlocks: CcusageRunner;
  runAllWeekly: CcusageRunner;
  limits: TokenLimits;
  // When set, the weekly figure tracks Anthropic's real rolling 7-day
  // window from this reset moment instead of a UTC calendar week.
  weeklyResetAnchor: Date | null;
  // When set, refines the active session window to its true start.
  refineSessionStart: SessionStartFinder | null;
  now: () => Date;
}

// The full-history blocks dump can be needed twice in one pass (rolling
// week + session self-calibration); this keeps it to a single subprocess.
function memoizeRunner(runner: CcusageRunner): CcusageRunner {
  let cached: Promise<string> | null = null;
  return () => (cached ??= runner());
}

export async function buildUsageResponse(
  input: BuildUsageResponseInput,
): Promise<UsageResponse> {
  const {
    runActiveBlock,
    runWeekly,
    runAllBlocks,
    runAllWeekly,
    limits,
    weeklyResetAnchor,
    refineSessionStart,
    now,
  } = input;
  const nowValue = now();
  const runAllBlocksOnce = memoizeRunner(runAllBlocks);

  const noCalibration = Promise.resolve({
    ok: true as const,
    maxTokens: null,
  });

  const [sessionResult, weeklyResult, maxBlockResult, maxWeeklyResult] =
    await Promise.all([
      getActiveSessionBlock(runActiveBlock),
      weeklyResetAnchor
        ? getRollingWeekTotal(runAllBlocksOnce, weeklyResetAnchor, nowValue)
        : getWeeklyTotal(runWeekly, nowValue),
      // Anthropic publishes no real plan quota, so with no explicit limit we
      // self-calibrate off the account's own history. Skipped entirely when a
      // limit is configured - otherwise it's a wasted subprocess every poll.
      limits.sessionTokenLimit === null
        ? getHistoricalMaxBlockTokens(runAllBlocksOnce)
        : noCalibration,
      limits.weeklyTokenLimit === null
        ? getHistoricalMaxWeeklyTokens(runAllWeekly, nowValue)
        : noCalibration,
    ]);

  const errors: string[] = [];
  if (!sessionResult.ok) errors.push(sessionResult.error);
  if (!weeklyResult.ok) errors.push(weeklyResult.error);

  const sessionTokenLimit =
    limits.sessionTokenLimit ??
    (maxBlockResult.ok ? maxBlockResult.maxTokens : null);
  const weeklyTokenLimit =
    limits.weeklyTokenLimit ??
    (maxWeeklyResult.ok ? maxWeeklyResult.maxTokens : null);

  let sessionWindowStart = sessionResult.ok && sessionResult.block
    ? sessionResult.block.windowStart
    : null;
  let sessionWindowEnd = sessionResult.ok && sessionResult.block
    ? sessionResult.block.windowEnd
    : null;

  if (
    refineSessionStart &&
    sessionResult.ok &&
    sessionResult.block?.active &&
    sessionWindowStart &&
    sessionWindowEnd
  ) {
    const flooredStart = new Date(sessionWindowStart);
    const flooredEnd = new Date(sessionWindowEnd);
    const realStart = await refineSessionStart(flooredStart, flooredEnd);
    if (realStart) {
      // Preserve the block's own duration rather than assuming 5h, so a
      // non-default ccusage session length still lines up.
      const durationMs = flooredEnd.getTime() - flooredStart.getTime();
      sessionWindowStart = realStart.toISOString();
      sessionWindowEnd = new Date(
        realStart.getTime() + durationMs,
      ).toISOString();
    }
  }

  const session =
    sessionResult.ok && sessionResult.block && sessionWindowStart && sessionWindowEnd
      ? {
          active: sessionResult.block.active,
          ...buildUsageWindow({
            tokensUsed: sessionResult.block.tokensUsed,
            tokenLimit: sessionTokenLimit,
            windowStart: sessionWindowStart,
            windowEnd: sessionWindowEnd,
            now: nowValue,
          }),
        }
      : null;

  const week =
    weeklyResult.ok && weeklyResult.week
      ? buildUsageWindow({
          tokensUsed: weeklyResult.week.tokensUsed,
          tokenLimit: weeklyTokenLimit,
          windowStart: weeklyResult.week.windowStart,
          windowEnd: weeklyResult.week.windowEnd,
          now: nowValue,
        })
      : null;

  return {
    schemaVersion: 1,
    generatedAt: nowValue.toISOString(),
    service:
      errors.length === 0
        ? { status: "ok", source: "ccusage" }
        : { status: "degraded", source: "ccusage", error: errors.join("; ") },
    session,
    week,
  };
}
