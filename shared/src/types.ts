export interface UsageWindow {
  tokensUsed: number;
  tokenLimit: number | null;
  percentUsed: number | null;
  windowStart: string;
  windowEnd: string;
  minutesRemaining: number;
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
