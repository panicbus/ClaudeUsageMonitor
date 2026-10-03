import { execFile } from "node:child_process";
import { readFile as readFileAsync } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeConfigDir, claudeJsonPath } from "./claude-paths.js";

const execFileAsync = promisify(execFile);

// Authoritative Claude usage data, straight from Claude Code's own accounting
// rather than an estimate reconstructed from local transcripts. Three tiers,
// tried in order by createUsageSource(): a local cache file (no credentials,
// no network), the OAuth API Claude Code itself calls (needs the same
// credentials Claude Code already has on this machine), and finally the
// caller falls back to the ccusage-based estimate in usage.ts.

export interface WindowUsage {
  utilization: number;
  resetsAt: string;
}

export interface AuthoritativeUsage {
  fiveHour: WindowUsage | null;
  sevenDay: WindowUsage | null;
}

export type AuthoritativeUsageResult =
  { ok: true; usage: AuthoritativeUsage } | { ok: false; error: string };

export type UsageFetcher = () => Promise<AuthoritativeUsageResult>;

// A null `resets_at` is deliberately not valid: Anthropic reports
// `{ utilization: 0, resets_at: null }` (and `is_active: false` in the
// `limits` list) while no window is open - observed in ~/.claude.json - so
// there is no window to describe, and the reading is treated as absent.
function isValidWindowUsage(
  value: unknown,
): value is { utilization: number; resets_at: string } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.utilization === "number" &&
    typeof v.resets_at === "string" &&
    !Number.isNaN(Date.parse(v.resets_at))
  );
}

// `liveAt` (epoch ms), when given, also drops a window that had already ended
// by then: its percentage describes a finished window, not the current one.
function parseWindow(raw: unknown, liveAt?: number): WindowUsage | null {
  if (!isValidWindowUsage(raw)) return null;
  if (liveAt !== undefined && Date.parse(raw.resets_at) <= liveAt) return null;
  return { utilization: raw.utilization, resetsAt: raw.resets_at };
}

function parseWindows(
  utilization: Record<string, unknown>,
  liveAt?: number,
): AuthoritativeUsage {
  return {
    fiveHour: parseWindow(utilization.five_hour, liveAt),
    sevenDay: parseWindow(utilization.seven_day, liveAt),
  };
}

// ---------------------------------------------------------------------------
// Tier 1: the local cache file Claude Code itself writes and reads from.
// ---------------------------------------------------------------------------

// Matches Claude Code's own invalidation threshold for this cache (found in
// its bundle) - if Claude Code itself wouldn't trust this data anymore,
// neither should we.
const CACHE_STALE_MS = 60 * 60 * 1000;

function defaultReadClaudeJson(): Promise<string> {
  return readFileAsync(claudeJsonPath(), "utf-8");
}

export interface ReadCachedUsageDeps {
  readFile?: () => Promise<string>;
  now?: () => number;
}

export async function readCachedUsage(
  deps: ReadCachedUsageDeps = {},
): Promise<AuthoritativeUsageResult> {
  const { readFile = defaultReadClaudeJson, now = () => Date.now() } = deps;

  let raw: string;
  try {
    raw = await readFile();
  } catch {
    return { ok: false, error: "no local usage cache available" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "local usage cache is malformed JSON" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: "local usage cache has an unexpected shape" };
  }
  const root = parsed as Record<string, unknown>;

  const cached = root.cachedUsageUtilization;
  if (typeof cached !== "object" || cached === null) {
    return { ok: false, error: "local usage cache has no cachedUsageUtilization" };
  }
  const cachedRecord = cached as Record<string, unknown>;

  if (typeof cachedRecord.fetchedAtMs !== "number") {
    return { ok: false, error: "local usage cache is missing fetchedAtMs" };
  }
  if (now() - cachedRecord.fetchedAtMs > CACHE_STALE_MS) {
    return { ok: false, error: "local usage cache is stale" };
  }

  // Guards against a cache left over from a previously logged-in account -
  // Claude Code applies the same check before trusting this file.
  const oauthAccount = root.oauthAccount;
  const activeAccountUuid =
    typeof oauthAccount === "object" && oauthAccount !== null
      ? (oauthAccount as Record<string, unknown>).accountUuid
      : undefined;
  if (
    typeof cachedRecord.accountUuid === "string" &&
    typeof activeAccountUuid === "string" &&
    cachedRecord.accountUuid !== activeAccountUuid
  ) {
    return { ok: false, error: "local usage cache is for a different account" };
  }

  const utilization = cachedRecord.utilization;
  if (typeof utilization !== "object" || utilization === null) {
    return { ok: false, error: "local usage cache is missing utilization data" };
  }

  // The cache can be up to CACHE_STALE_MS old, so a window it recorded as open
  // may have ended since - only windows still open now are trusted.
  return {
    ok: true,
    usage: parseWindows(utilization as Record<string, unknown>, now()),
  };
}

// ---------------------------------------------------------------------------
// Tier 2: the OAuth API endpoint Claude Code itself calls to refresh that
// cache. Needs the same credentials Claude Code already stores locally.
// ---------------------------------------------------------------------------

export interface OAuthToken {
  accessToken: string;
  expiresAt: number | null;
}

function parseClaudeAiOauthJson(raw: string): OAuthToken | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
  if (typeof oauth !== "object" || oauth === null) return null;
  const oauthRecord = oauth as Record<string, unknown>;
  if (typeof oauthRecord.accessToken !== "string") return null;
  return {
    accessToken: oauthRecord.accessToken,
    expiresAt: typeof oauthRecord.expiresAt === "number" ? oauthRecord.expiresAt : null,
  };
}

async function defaultReadKeychain(): Promise<string> {
  // The Keychain only exists on macOS; elsewhere go straight to the file.
  if (process.platform !== "darwin") throw new Error("no keychain on this platform");
  const { stdout } = await execFileAsync("security", [
    "find-generic-password",
    "-s",
    "Claude Code-credentials",
    "-w",
  ]);
  return stdout;
}

function defaultReadCredentialsFile(): Promise<string> {
  return readFileAsync(join(claudeConfigDir(), ".credentials.json"), "utf-8");
}

export interface ReadOAuthTokenDeps {
  readKeychain?: () => Promise<string>;
  readCredentialsFile?: () => Promise<string>;
  readEnv?: () => string | undefined;
}

// Tries the keychain, then the cross-platform credentials file, then the env
// var - the same order and sources Claude Code itself supports. We never
// refresh an expired token ourselves: Claude Code refreshes its own token as
// part of normal use, and re-reading here on every attempt picks that up for
// free rather than duplicating an OAuth refresh flow.
export async function readOAuthToken(
  deps: ReadOAuthTokenDeps = {},
): Promise<OAuthToken | null> {
  const {
    readKeychain = defaultReadKeychain,
    readCredentialsFile = defaultReadCredentialsFile,
    readEnv = () => process.env.CLAUDE_CODE_OAUTH_TOKEN,
  } = deps;

  try {
    const token = parseClaudeAiOauthJson(await readKeychain());
    if (token) return token;
  } catch {
    // fall through to the next source
  }

  try {
    const token = parseClaudeAiOauthJson(await readCredentialsFile());
    if (token) return token;
  } catch {
    // fall through to the next source
  }

  const envToken = readEnv();
  if (envToken) return { accessToken: envToken, expiresAt: null };

  return null;
}

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
// The real request (traced from Claude Code's own bundle) only sends
// Authorization + Content-Type. anthropic-beta and User-Agent are added
// defensively anyway: multiple real users have reported hours-long 429
// lockouts on this exact endpoint without a claude-code/* User-Agent, and a
// harmless extra header costs nothing if it turns out to be unnecessary.
const CLAUDE_CODE_USER_AGENT = "claude-code/2.1.270";

export async function fetchAuthoritativeUsage(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthoritativeUsageResult> {
  let response: Response;
  try {
    response = await fetchImpl(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": CLAUDE_CODE_USER_AGENT,
        "Content-Type": "application/json",
      },
    });
  } catch {
    return { ok: false, error: "network request to the usage API failed" };
  }

  if (response.status === 401) {
    return { ok: false, error: "usage API rejected the oauth token (401)" };
  }
  if (response.status === 429) {
    return { ok: false, error: "usage API rate limited the request (429)" };
  }
  if (!response.ok) {
    return { ok: false, error: `usage API returned status ${response.status}` };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { ok: false, error: "usage API returned malformed JSON" };
  }

  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "usage API returned an unexpected response shape" };
  }

  return { ok: true, usage: parseWindows(data as Record<string, unknown>) };
}

export interface CreateAuthoritativeUsageFetcherOptions {
  readToken?: () => Promise<OAuthToken | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
}

// Wraps the network call in a TTL cache (default 180s, the safe polling
// interval reported for this endpoint) with basic exponential backoff on
// 429 - this shares a rate-limit bucket with Claude Code's own token, so
// getting this wrong risks breaking the user's own `/usage` panel, not just
// ours.
export function createAuthoritativeUsageFetcher(
  options: CreateAuthoritativeUsageFetcherOptions = {},
): UsageFetcher {
  const {
    readToken = () => readOAuthToken(),
    fetchImpl = fetch,
    now = () => Date.now(),
    ttlMs = 180_000,
  } = options;

  let cached: AuthoritativeUsageResult | null = null;
  let cachedAt = 0;
  let backoffMultiplier = 1;

  return async () => {
    if (cached && now() - cachedAt < ttlMs * backoffMultiplier) {
      return cached;
    }

    const token = await readToken();
    const result: AuthoritativeUsageResult = token
      ? await fetchAuthoritativeUsage(token.accessToken, fetchImpl)
      : { ok: false, error: "no oauth token available" };

    backoffMultiplier =
      !result.ok && result.error.includes("429")
        ? Math.min(backoffMultiplier * 2, 16)
        : 1;

    cached = result;
    cachedAt = now();
    return result;
  };
}

// ---------------------------------------------------------------------------
// Combined source: cache first (cheap, no credentials), network second.
// ---------------------------------------------------------------------------

export interface CreateUsageSourceOptions {
  readCache?: () => Promise<AuthoritativeUsageResult>;
  // null disables the network tier entirely, so only the local cache is
  // consulted. Off unless USE_OAUTH_USAGE_API is set (see index.ts):
  // Anthropic's terms restrict using Claude Code's OAuth token outside
  // Claude Code itself, so each user has to opt in to it knowingly.
  fetchNetwork?: UsageFetcher | null;
}

export function createUsageSource(options: CreateUsageSourceOptions = {}): UsageFetcher {
  const {
    readCache = () => readCachedUsage(),
    fetchNetwork = createAuthoritativeUsageFetcher(),
  } = options;

  return async () => {
    const cached = await readCache();
    // The session window is the one that moves minute to minute, and the
    // cache can be up to an hour old: with no live session window in it
    // (none was open when it was written, or that one has since ended) it
    // can't say what's true now, so ask the live API instead of dropping
    // straight to the local estimate.
    if (cached.ok && cached.usage.fiveHour) return cached;
    if (fetchNetwork === null) return cached;

    const live = await fetchNetwork();
    // If the API is unreachable too, a cache that still has a live weekly
    // window is better than nothing.
    return live.ok || !cached.ok ? live : cached;
  };
}
