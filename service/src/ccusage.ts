import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 10_000;

function resolveCcusageBinPath(): string {
  const pkgJsonPath = fileURLToPath(import.meta.resolve("ccusage/package.json"));
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as {
    bin: Record<string, string>;
  };
  return join(dirname(pkgJsonPath), pkg.bin.ccusage);
}

export interface RawCcusageBlock {
  startTime: string;
  endTime: string;
  isActive: boolean;
  totalTokens: number;
  costUSD: number;
}

export interface SessionBlock {
  active: boolean;
  tokensUsed: number;
  // ccusage's cost-in-USD figure, computed from Anthropic's real published
  // per-token-type pricing (cache reads priced far below fresh input, cache
  // writes above it). Tracks the account's real usage-limit consumption far
  // more consistently than raw token count does - verified empirically: two
  // token-based calibration points from the same session implied limits
  // 17% apart, while the matching cost-based points were only ~7% apart.
  costUsed: number;
  windowStart: string;
  windowEnd: string;
}

export type SessionBlockResult =
  { ok: true; block: SessionBlock | null } | { ok: false; error: string };

export interface WeeklyTotal {
  tokensUsed: number;
  windowStart: string;
  windowEnd: string;
}

export type WeeklyTotalResult =
  { ok: true; week: WeeklyTotal | null } | { ok: false; error: string };

export type CcusageRunner = () => Promise<string>;

function createRunner(scriptPath: string, args: string[]): CcusageRunner {
  return async () => {
    const { stdout } = await execFileAsync(process.execPath, [scriptPath, ...args], {
      timeout: EXEC_TIMEOUT_MS,
    });
    return stdout;
  };
}

export function createActiveBlockRunner(
  scriptPath = resolveCcusageBinPath(),
): CcusageRunner {
  return createRunner(scriptPath, ["blocks", "--active", "--json", "--offline"]);
}

export function createWeeklyRunner(scriptPath = resolveCcusageBinPath()): CcusageRunner {
  return createRunner(scriptPath, [
    "weekly",
    "--json",
    "--last",
    "1",
    "--offline",
    "--timezone",
    "UTC",
  ]);
}

export function createAllBlocksRunner(
  scriptPath = resolveCcusageBinPath(),
): CcusageRunner {
  return createRunner(scriptPath, ["blocks", "--json", "--offline"]);
}

export function createAllWeeklyRunner(
  scriptPath = resolveCcusageBinPath(),
): CcusageRunner {
  return createRunner(scriptPath, ["weekly", "--json", "--offline", "--timezone", "UTC"]);
}

type JsonResult = { ok: true; data: unknown } | { ok: false; error: string };

async function runAndParseJson(runCcusage: CcusageRunner): Promise<JsonResult> {
  let stdout: string;
  try {
    stdout = await runCcusage();
  } catch (err) {
    console.error("ccusage exec failed:", err);
    return { ok: false, error: "ccusage exec failed" };
  }

  try {
    return { ok: true, data: JSON.parse(stdout) };
  } catch {
    return { ok: false, error: "ccusage returned malformed JSON" };
  }
}

function isValidDateString(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function isRawCcusageBlock(value: unknown): value is RawCcusageBlock {
  if (typeof value !== "object" || value === null) return false;
  const block = value as Record<string, unknown>;
  return (
    typeof block.startTime === "string" &&
    isValidDateString(block.startTime) &&
    typeof block.endTime === "string" &&
    isValidDateString(block.endTime) &&
    typeof block.isActive === "boolean" &&
    typeof block.totalTokens === "number" &&
    typeof block.costUSD === "number"
  );
}

export async function getActiveSessionBlock(
  runCcusage: CcusageRunner,
): Promise<SessionBlockResult> {
  const parsed = await runAndParseJson(runCcusage);
  if (!parsed.ok) return parsed;

  const { data } = parsed;

  if (
    typeof data !== "object" ||
    data === null ||
    !Array.isArray((data as Record<string, unknown>).blocks)
  ) {
    return { ok: false, error: "ccusage JSON is missing a 'blocks' array" };
  }

  const blocks = (data as { blocks: unknown[] }).blocks;

  if (blocks.length === 0) {
    return { ok: true, block: null };
  }

  const raw = blocks[blocks.length - 1];

  if (!isRawCcusageBlock(raw)) {
    return {
      ok: false,
      error: "ccusage block is missing expected fields",
    };
  }

  return {
    ok: true,
    block: {
      active: raw.isActive,
      tokensUsed: raw.totalTokens,
      costUsed: raw.costUSD,
      windowStart: raw.startTime,
      windowEnd: raw.endTime,
    },
  };
}

const PERIOD_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function isValidCalendarDateString(value: string): boolean {
  if (!PERIOD_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isRawWeeklyEntry(
  value: unknown,
): value is { period: string; totalTokens: number } {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.period === "string" &&
    isValidCalendarDateString(entry.period) &&
    typeof entry.totalTokens === "number"
  );
}

export async function getWeeklyTotal(
  runCcusage: CcusageRunner,
  now: Date,
): Promise<WeeklyTotalResult> {
  const parsed = await runAndParseJson(runCcusage);
  if (!parsed.ok) return parsed;

  const { data } = parsed;

  if (
    typeof data !== "object" ||
    data === null ||
    !Array.isArray((data as Record<string, unknown>).weekly)
  ) {
    return { ok: false, error: "ccusage JSON is missing a 'weekly' array" };
  }

  const weekly = (data as { weekly: unknown[] }).weekly;

  if (weekly.length === 0) {
    return { ok: true, week: null };
  }

  const raw = weekly[0];

  if (!isRawWeeklyEntry(raw)) {
    return {
      ok: false,
      error: "ccusage weekly entry is missing expected fields",
    };
  }

  const windowStart = new Date(`${raw.period}T00:00:00.000Z`);
  const windowEnd = new Date(windowStart.getTime() + WEEK_MS);

  if (windowEnd.getTime() <= now.getTime()) {
    return { ok: true, week: null };
  }

  return {
    ok: true,
    week: {
      tokensUsed: raw.totalTokens,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
    },
  };
}

// Anthropic's weekly limit is a rolling 7-day window anchored to a fixed
// reset moment on the account - NOT the calendar week that `ccusage weekly`
// buckets by. Given an anchor, this sums the 5-hour blocks that fall inside
// the current rolling window, which tracks the real reset instead of drifting
// up to several days away from it.
export async function getRollingWeekTotal(
  runCcusage: CcusageRunner,
  anchor: Date,
  now: Date,
): Promise<WeeklyTotalResult> {
  const parsed = await runAndParseJson(runCcusage);
  if (!parsed.ok) return parsed;

  const { data } = parsed;

  if (
    typeof data !== "object" ||
    data === null ||
    !Array.isArray((data as Record<string, unknown>).blocks)
  ) {
    return { ok: false, error: "ccusage JSON is missing a 'blocks' array" };
  }

  const elapsed = now.getTime() - anchor.getTime();
  const windowStart = new Date(
    anchor.getTime() + Math.floor(elapsed / WEEK_MS) * WEEK_MS,
  );
  const windowEnd = new Date(windowStart.getTime() + WEEK_MS);

  let tokensUsed = 0;
  for (const raw of (data as { blocks: unknown[] }).blocks) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw as Record<string, unknown>;
    if (block.isGap === true) continue;
    if (typeof block.startTime !== "string") continue;
    if (typeof block.totalTokens !== "number") continue;

    const startedAt = Date.parse(block.startTime);
    if (Number.isNaN(startedAt)) continue;
    if (startedAt < windowStart.getTime() || startedAt >= windowEnd.getTime()) {
      continue;
    }
    tokensUsed += block.totalTokens;
  }

  return {
    ok: true,
    week: {
      tokensUsed,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
    },
  };
}

export type HistoricalMaxBlockResult =
  | { ok: true; maxTokens: number | null; maxCost: number | null }
  | { ok: false; error: string };

export type HistoricalMaxResult =
  { ok: true; maxTokens: number | null } | { ok: false; error: string };

// The self-calibrating fallback baseline when no explicit limit is
// configured (Anthropic doesn't publish real plan quotas): the highest
// totalTokens AND highest costUSD among *completed* blocks, tracked
// independently - the priciest block need not be the one with the most raw
// tokens (see the cost-vs-tokens comment on SessionBlock). The currently-
// active block is excluded from both - including it would make the block
// its own baseline, so percentUsed would just track "how much of this
// block have I used so far" rather than "how does this compare to my
// biggest session ever."
export async function getHistoricalMaxBlockUsage(
  runCcusage: CcusageRunner,
): Promise<HistoricalMaxBlockResult> {
  const parsed = await runAndParseJson(runCcusage);
  if (!parsed.ok) return parsed;

  const { data } = parsed;

  if (
    typeof data !== "object" ||
    data === null ||
    !Array.isArray((data as Record<string, unknown>).blocks)
  ) {
    return { ok: false, error: "ccusage JSON is missing a 'blocks' array" };
  }

  const blocks = (data as { blocks: unknown[] }).blocks;

  let maxTokens = 0;
  let maxCost = 0;
  for (const raw of blocks) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw as Record<string, unknown>;
    if (block.isActive === true) continue;
    if (typeof block.totalTokens === "number" && block.totalTokens > maxTokens) {
      maxTokens = block.totalTokens;
    }
    if (typeof block.costUSD === "number" && block.costUSD > maxCost) {
      maxCost = block.costUSD;
    }
  }

  return {
    ok: true,
    maxTokens: maxTokens > 0 ? maxTokens : null,
    maxCost: maxCost > 0 ? maxCost : null,
  };
}

// Same self-calibrating idea as getHistoricalMaxBlockTokens, but for the
// weekly figure: highest totalTokens among fully-elapsed weeks, excluding
// the current in-progress week (same reasoning - excludes self-reference).
export async function getHistoricalMaxWeeklyTokens(
  runCcusage: CcusageRunner,
  now: Date,
): Promise<HistoricalMaxResult> {
  const parsed = await runAndParseJson(runCcusage);
  if (!parsed.ok) return parsed;

  const { data } = parsed;

  if (
    typeof data !== "object" ||
    data === null ||
    !Array.isArray((data as Record<string, unknown>).weekly)
  ) {
    return { ok: false, error: "ccusage JSON is missing a 'weekly' array" };
  }

  const weekly = (data as { weekly: unknown[] }).weekly;

  let maxTokens = 0;
  for (const raw of weekly) {
    if (!isRawWeeklyEntry(raw)) continue;
    const windowStart = new Date(`${raw.period}T00:00:00.000Z`);
    const windowEnd = new Date(windowStart.getTime() + WEEK_MS);
    if (windowEnd.getTime() > now.getTime()) continue; // still in progress
    if (raw.totalTokens > maxTokens) {
      maxTokens = raw.totalTokens;
    }
  }

  return { ok: true, maxTokens: maxTokens > 0 ? maxTokens : null };
}
