export interface UsageWindow {
  tokensUsed: number;
  tokenLimit: number | null;
  percentUsed: number | null;
  windowStart: string;
  windowEnd: string;
  minutesRemaining: number;
  // "anthropic": percentUsed/windowEnd/minutesRemaining came straight from
  // Anthropic's own usage accounting (exact, matches Claude Code's own
  // panel). "estimated": reconstructed locally from ccusage - real data on
  // tokensUsed always still reflects genuine ccusage/transcript counts
  // either way, but the percentage itself is only a best-effort guess when
  // this is "estimated" (see service/.env for why: neither raw token count
  // nor cost tracks Anthropic's real percentage reliably on its own).
  source: "anthropic" | "estimated";
}

export interface UsageResponse {
  schemaVersion: 1;
  generatedAt: string;

  service: {
    status: "ok" | "degraded";
    source: "ccusage" | "jsonl-fallback";
    error?: string;
  };

  session: (UsageWindow & { active: boolean }) | null;

  week: UsageWindow | null;
}
