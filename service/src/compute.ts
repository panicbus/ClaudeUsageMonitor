import type { UsageWindow } from "@claude-usage-monitor/shared";

export interface BuildUsageWindowInput {
  tokensUsed: number;
  tokenLimit: number | null;
  windowStart: string;
  windowEnd: string;
  now: Date;
}

export function buildUsageWindow(input: BuildUsageWindowInput): UsageWindow {
  const { tokensUsed, tokenLimit, windowStart, windowEnd, now } = input;

  const percentUsed =
    tokenLimit === null
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
  };
}
