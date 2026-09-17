import type { UsageWindow } from "@claude-usage-monitor/shared";

export interface BuildUsageWindowInput {
  tokensUsed: number;
  tokenLimit: number | null;
  // Cost-basis takes priority over token-basis when costLimit is set: it
  // tracks Anthropic's real usage-limit consumption far more consistently
  // than raw token count, since real pricing discounts cheap cache-read
  // tokens (verified empirically - see the comment on SessionBlock in
  // ccusage.ts). tokensUsed/tokenLimit are still returned as real values
  // either way; cost-basis only changes what percentUsed is computed from.
  costUsed: number;
  costLimit: number | null;
  windowStart: string;
  windowEnd: string;
  now: Date;
}

export function buildUsageWindow(input: BuildUsageWindowInput): UsageWindow {
  const { tokensUsed, tokenLimit, costUsed, costLimit, windowStart, windowEnd, now } =
    input;

  const percentUsed =
    costLimit !== null
      ? Math.min(100, Math.round((costUsed / costLimit) * 100))
      : tokenLimit === null
        ? null
        : Math.min(100, Math.round((tokensUsed / tokenLimit) * 100));

  const rawMinutesRemaining = Math.floor(
    (new Date(windowEnd).getTime() - now.getTime()) / 60_000,
  );
  const minutesRemaining = Math.max(0, rawMinutesRemaining);

  return {
    tokensUsed,
    tokenLimit,
    percentUsed,
    windowStart,
    windowEnd,
    minutesRemaining,
    source: "estimated",
  };
}

export interface BuildAuthoritativeWindowInput {
  // Real ccusage token count, kept purely for display - the percentage
  // itself comes entirely from utilization/resetsAt below, not from this.
  tokensUsed: number;
  utilization: number; // 0-100 from Anthropic's own accounting
  resetsAt: string; // ISO, from Anthropic's own accounting
  windowDurationMs: number; // known window length, to derive windowStart
  now: Date;
}

// Anthropic's own panel truncates (Math.floor), not rounds, when displaying
// this percentage - matching that exactly is the whole point of this path
// (vs. buildUsageWindow's estimate, which only approximates).
export function buildAuthoritativeWindow(
  input: BuildAuthoritativeWindowInput,
): UsageWindow {
  const { tokensUsed, utilization, resetsAt, windowDurationMs, now } = input;

  const percentUsed = Math.min(100, Math.max(0, Math.floor(utilization)));
  const windowEnd = resetsAt;
  const windowStart = new Date(
    new Date(resetsAt).getTime() - windowDurationMs,
  ).toISOString();
  const rawMinutesRemaining = Math.floor(
    (new Date(windowEnd).getTime() - now.getTime()) / 60_000,
  );
  const minutesRemaining = Math.max(0, rawMinutesRemaining);

  return {
    tokensUsed,
    tokenLimit: null,
    percentUsed,
    windowStart,
    windowEnd,
    minutesRemaining,
    source: "anthropic",
  };
}
