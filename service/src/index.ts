import type { UsageResponse } from "@claude-usage-monitor/shared";
import {
  createActiveBlockRunner,
  createAllBlocksRunner,
  createAllWeeklyRunner,
  createWeeklyRunner,
} from "./ccusage.js";
import { parseOptionalDate, parseRequiredPositiveInt } from "./env.js";
import { readTokenLimits } from "./limits.js";
import { startPolling } from "./poller.js";
import { createUsageServer } from "./server.js";
import { createFirstEntryTimeCache } from "./transcripts.js";
import { buildUsageResponse } from "./usage.js";

const PORT = parseRequiredPositiveInt("PORT", process.env.PORT, 4317);
const POLL_INTERVAL_MS = parseRequiredPositiveInt(
  "POLL_INTERVAL_MS",
  process.env.POLL_INTERVAL_MS,
  15_000,
);

const limits = readTokenLimits(process.env);
const weeklyResetAnchor = parseOptionalDate(process.env.WEEKLY_RESET_ANCHOR);
const runActiveBlock = createActiveBlockRunner();
const runWeekly = createWeeklyRunner();
const runAllBlocks = createAllBlocksRunner();
const runAllWeekly = createAllWeeklyRunner();
const refineSessionStart = createFirstEntryTimeCache();

async function buildSnapshot(): Promise<UsageResponse> {
  return buildUsageResponse({
    runActiveBlock,
    runWeekly,
    runAllBlocks,
    runAllWeekly,
    limits,
    weeklyResetAnchor,
    refineSessionStart,
    now: () => new Date(),
  });
}

const pendingSnapshot: UsageResponse = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  service: { status: "degraded", source: "ccusage", error: "starting up" },
  session: null,
  week: null,
};

const poller = startPolling(buildSnapshot, POLL_INTERVAL_MS, pendingSnapshot);
const server = createUsageServer(() => poller.getSnapshot());

server.listen(PORT, "0.0.0.0", () => {
  console.log(`claude-usage-monitor service listening on 0.0.0.0:${PORT}`);
  console.log(`polling ccusage every ${POLL_INTERVAL_MS}ms`);
  if (limits.sessionTokenLimit === null) {
    console.log(
      "CLAUDE_SESSION_TOKEN_LIMIT not set — self-calibrating from historical max block",
    );
  }
  console.log(
    weeklyResetAnchor
      ? `weekly window: rolling 7 days anchored to ${weeklyResetAnchor.toISOString()}`
      : "WEEKLY_RESET_ANCHOR not set — weekly window falls back to the UTC calendar week",
  );
  if (limits.weeklyTokenLimit === null) {
    console.log(
      "WEEKLY_TOKEN_LIMIT not set — self-calibrating from historical max week",
    );
  }
});

process.on("SIGINT", () => {
  poller.stop();
  server.close(() => process.exit(0));
});
