import type { UsageResponse } from "@claude-usage-monitor/shared";
import type { UsageFetcher } from "./anthropic-usage.js";
import type { CcusageRunner } from "./ccusage.js";
import {
  getActiveSessionBlock,
  getHistoricalMaxBlockUsage,
  getHistoricalMaxWeeklyTokens,
  getRollingWeekTotal,
  getWeeklyTotal,
} from "./ccusage.js";
import { buildAuthoritativeWindow, buildUsageWindow } from "./compute.js";
import type { TokenLimits } from "./limits.js";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Resolves the real first-message time inside a block window, so the session
// countdown can track Anthropic's actual window rather than ccusage's
// hour-floored approximation of it. Only used on the estimate path - the
// authoritative path already has the real reset time from Anthropic.
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
  // window from this reset moment instead of a UTC calendar week. Only
  // matters on the estimate path.
  weeklyResetAnchor: Date | null;
  // When set, refines the active session window to its true start. Only
  // matters on the estimate path.
  refineSessionStart: SessionStartFinder | null;
  // When set, tried first for BOTH windows - Anthropic's own accounting,
  // exact rather than estimated. Null disables this tier entirely (e.g. in
  // tests that only want to exercise the estimate path). A per-window null
  // inside a successful result (fiveHour/sevenDay individually absent)
  // falls that one window back to the estimate while the other still uses
  // the authoritative value.
  getAuthoritativeUsage: UsageFetcher | null;
  now: () => Date;
}

// The full-history blocks dump can be needed twice in one pass (rolling
// week + session self-calibration); this keeps it to a single subprocess.
function memoizeRunner(runner: CcusageRunner): CcusageRunner {
  let cached: Promise<string> | null = null;
  return () => (cached ??= runner());
}

const NO_BLOCK_CALIBRATION = Promise.resolve({
  ok: true as const,
  maxTokens: null,
  maxCost: null,
});
const NO_WEEKLY_CALIBRATION = Promise.resolve({
  ok: true as const,
  maxTokens: null,
});
const NO_AUTHORITATIVE_USAGE = Promise.resolve({
  ok: false as const,
  error: "no authoritative source configured",
});

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
    getAuthoritativeUsage,
    now,
  } = input;
  const nowValue = now();
  const runAllBlocksOnce = memoizeRunner(runAllBlocks);

  // Self-calibration (off the account's own history) only runs when
  // neither an explicit token limit nor cost limit is configured for that
  // window - otherwise it's a wasted subprocess call every poll.
  const needsBlockCalibration =
    limits.sessionTokenLimit === null && limits.sessionCostLimit === null;

  const [sessionResult, weeklyResult, maxBlockResult, maxWeeklyResult, authoritative] =
    await Promise.all([
      getActiveSessionBlock(runActiveBlock),
      weeklyResetAnchor
        ? getRollingWeekTotal(runAllBlocksOnce, weeklyResetAnchor, nowValue)
        : getWeeklyTotal(runWeekly, nowValue),
      needsBlockCalibration
        ? getHistoricalMaxBlockUsage(runAllBlocksOnce)
        : NO_BLOCK_CALIBRATION,
      limits.weeklyTokenLimit === null
        ? getHistoricalMaxWeeklyTokens(runAllWeekly, nowValue)
        : NO_WEEKLY_CALIBRATION,
      getAuthoritativeUsage ? getAuthoritativeUsage() : NO_AUTHORITATIVE_USAGE,
    ]);

  const errors: string[] = [];
  if (!sessionResult.ok) errors.push(sessionResult.error);
  if (!weeklyResult.ok) errors.push(weeklyResult.error);

  const authoritativeFiveHour = authoritative.ok ? authoritative.usage.fiveHour : null;
  const authoritativeSevenDay = authoritative.ok ? authoritative.usage.sevenDay : null;

  const sessionTokenLimit =
    limits.sessionTokenLimit ??
    (maxBlockResult.ok ? maxBlockResult.maxTokens : null);
  const sessionCostLimit =
    limits.sessionCostLimit ?? (maxBlockResult.ok ? maxBlockResult.maxCost : null);
  const weeklyTokenLimit =
    limits.weeklyTokenLimit ??
    (maxWeeklyResult.ok ? maxWeeklyResult.maxTokens : null);

  const sessionTokensUsed = sessionResult.ok ? sessionResult.block?.tokensUsed ?? 0 : 0;

  let session = null;
  if (authoritativeFiveHour) {
    // Real ccusage tokensUsed for display, real Anthropic percentage/reset -
    // never blocked on ccusage's own session-block lookup succeeding.
    session = {
      active: true,
      ...buildAuthoritativeWindow({
        tokensUsed: sessionTokensUsed,
        utilization: authoritativeFiveHour.utilization,
        resetsAt: authoritativeFiveHour.resetsAt,
        windowDurationMs: FIVE_HOURS_MS,
        now: nowValue,
      }),
    };
  } else if (sessionResult.ok && sessionResult.block) {
    let sessionWindowStart = sessionResult.block.windowStart;
    let sessionWindowEnd = sessionResult.block.windowEnd;

    if (refineSessionStart && sessionResult.block.active) {
      const flooredStart = new Date(sessionWindowStart);
      const flooredEnd = new Date(sessionWindowEnd);
      const realStart = await refineSessionStart(flooredStart, flooredEnd);
      if (realStart) {
        // Preserve the block's own duration rather than assuming 5h, so a
        // non-default ccusage session length still lines up.
        const durationMs = flooredEnd.getTime() - flooredStart.getTime();
        sessionWindowStart = realStart.toISOString();
        sessionWindowEnd = new Date(realStart.getTime() + durationMs).toISOString();
      }
    }

    session = {
      active: sessionResult.block.active,
      ...buildUsageWindow({
        tokensUsed: sessionResult.block.tokensUsed,
        tokenLimit: sessionTokenLimit,
        costUsed: sessionResult.block.costUsed,
        costLimit: sessionCostLimit,
        windowStart: sessionWindowStart,
        windowEnd: sessionWindowEnd,
        now: nowValue,
      }),
    };
  }

  let week = null;
  if (authoritativeSevenDay) {
    const weekTokensUsed = weeklyResult.ok ? weeklyResult.week?.tokensUsed ?? 0 : 0;
    week = buildAuthoritativeWindow({
      tokensUsed: weekTokensUsed,
      utilization: authoritativeSevenDay.utilization,
      resetsAt: authoritativeSevenDay.resetsAt,
      windowDurationMs: SEVEN_DAYS_MS,
      now: nowValue,
    });
  } else if (weeklyResult.ok && weeklyResult.week) {
    week = buildUsageWindow({
      tokensUsed: weeklyResult.week.tokensUsed,
      tokenLimit: weeklyTokenLimit,
      costUsed: 0,
      costLimit: null,
      windowStart: weeklyResult.week.windowStart,
      windowEnd: weeklyResult.week.windowEnd,
      now: nowValue,
    });
  }

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
