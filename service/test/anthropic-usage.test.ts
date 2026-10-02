import { describe, expect, it, vi } from "vitest";
import {
  readOAuthToken,
  fetchAuthoritativeUsage,
  createAuthoritativeUsageFetcher,
  readCachedUsage,
  createUsageSource,
} from "../src/anthropic-usage.js";
import type { AuthoritativeUsageResult } from "../src/anthropic-usage.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("readOAuthToken", () => {
  const validCreds = JSON.stringify({
    claudeAiOauth: { accessToken: "tok-from-keychain", expiresAt: 9999999999999 },
  });

  it("prefers the keychain when it succeeds", async () => {
    const token = await readOAuthToken({
      readKeychain: async () => validCreds,
      readCredentialsFile: async () => {
        throw new Error("should not be called");
      },
      readEnv: () => {
        throw new Error("should not be called");
      },
    });

    expect(token).toEqual({ accessToken: "tok-from-keychain", expiresAt: 9999999999999 });
  });

  it("falls back to the credentials file when the keychain read fails", async () => {
    const fileCreds = JSON.stringify({
      claudeAiOauth: { accessToken: "tok-from-file", expiresAt: 1234567890000 },
    });

    const token = await readOAuthToken({
      readKeychain: async () => {
        throw new Error("security: item not found");
      },
      readCredentialsFile: async () => fileCreds,
      readEnv: () => {
        throw new Error("should not be called");
      },
    });

    expect(token).toEqual({ accessToken: "tok-from-file", expiresAt: 1234567890000 });
  });

  it("falls back to the env var when both keychain and file fail, with null expiresAt", async () => {
    const token = await readOAuthToken({
      readKeychain: async () => {
        throw new Error("no keychain");
      },
      readCredentialsFile: async () => {
        throw new Error("no file");
      },
      readEnv: () => "tok-from-env",
    });

    expect(token).toEqual({ accessToken: "tok-from-env", expiresAt: null });
  });

  it("returns null when nothing works", async () => {
    const token = await readOAuthToken({
      readKeychain: async () => {
        throw new Error("no keychain");
      },
      readCredentialsFile: async () => {
        throw new Error("no file");
      },
      readEnv: () => undefined,
    });

    expect(token).toBeNull();
  });

  it("falls through when a source returns unparseable or malformed JSON, rather than throwing", async () => {
    const token = await readOAuthToken({
      readKeychain: async () => "not json at all",
      readCredentialsFile: async () => JSON.stringify({ notClaudeAiOauth: true }),
      readEnv: () => "tok-from-env",
    });

    expect(token).toEqual({ accessToken: "tok-from-env", expiresAt: null });
  });
});

describe("fetchAuthoritativeUsage", () => {
  it("parses both windows from a healthy response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        five_hour: { utilization: 30, resets_at: "2026-09-17T03:21:00.000Z" },
        seven_day: { utilization: 45, resets_at: "2026-09-19T18:00:00.000Z" },
      }),
    );

    const result = await fetchAuthoritativeUsage("test-token", fetchImpl);

    expect(result).toEqual({
      ok: true,
      usage: {
        fiveHour: { utilization: 30, resetsAt: "2026-09-17T03:21:00.000Z" },
        sevenDay: { utilization: 45, resetsAt: "2026-09-19T18:00:00.000Z" },
      },
    });
  });

  it("sends the required headers, including the critical User-Agent", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { five_hour: null, seven_day: null }),
    );

    await fetchAuthoritativeUsage("test-token", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.anthropic.com/api/oauth/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": expect.stringMatching(/^claude-code\//),
        }),
      }),
    );
  });

  it("treats a null window (e.g. seven_day_opus-style absence) as null, not an error", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        five_hour: { utilization: 12, resets_at: "2026-09-17T03:21:00.000Z" },
        seven_day: null,
      }),
    );

    const result = await fetchAuthoritativeUsage("test-token", fetchImpl);

    expect(result).toEqual({
      ok: true,
      usage: {
        fiveHour: { utilization: 12, resetsAt: "2026-09-17T03:21:00.000Z" },
        sevenDay: null,
      },
    });
  });

  it("fails gracefully on 401 (rejected token)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: "unauthorized" }));

    const result = await fetchAuthoritativeUsage("bad-token", fetchImpl);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/401/);
  });

  it("fails gracefully on 429 (rate limited), distinguishably from other errors", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, { error: "rate_limit_error" }));

    const result = await fetchAuthoritativeUsage("test-token", fetchImpl);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/429/);
  });

  it("fails gracefully on a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.anthropic.com");
    });

    const result = await fetchAuthoritativeUsage("test-token", fetchImpl);

    expect(result.ok).toBe(false);
  });

  it("fails gracefully on malformed JSON", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
    );

    const result = await fetchAuthoritativeUsage("test-token", fetchImpl);

    expect(result.ok).toBe(false);
  });

  it("fails gracefully when a window is present but semantically invalid", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        five_hour: { utilization: "not-a-number", resets_at: "2026-09-17T03:21:00.000Z" },
        seven_day: null,
      }),
    );

    const result = await fetchAuthoritativeUsage("test-token", fetchImpl);

    // Doesn't crash; the malformed window is just treated as absent.
    expect(result).toEqual({ ok: true, usage: { fiveHour: null, sevenDay: null } });
  });
});

describe("createAuthoritativeUsageFetcher", () => {
  it("caches a successful result for the TTL window instead of re-fetching every call", async () => {
    let clock = 0;
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        five_hour: { utilization: 30, resets_at: "2026-09-17T03:21:00.000Z" },
        seven_day: null,
      }),
    );

    const getUsage = createAuthoritativeUsageFetcher({
      readToken: async () => ({ accessToken: "tok", expiresAt: null }),
      fetchImpl,
      now: () => clock,
      ttlMs: 180_000,
    });

    await getUsage();
    clock += 60_000; // still within TTL
    await getUsage();
    clock += 60_000; // still within TTL (120s elapsed)
    await getUsage();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the TTL has elapsed", async () => {
    let clock = 0;
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { five_hour: null, seven_day: null }),
    );

    const getUsage = createAuthoritativeUsageFetcher({
      readToken: async () => ({ accessToken: "tok", expiresAt: null }),
      fetchImpl,
      now: () => clock,
      ttlMs: 180_000,
    });

    await getUsage();
    clock += 181_000; // just past TTL
    await getUsage();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("backs off further than the normal TTL after a 429, so it never hammers a rate-limited endpoint", async () => {
    let clock = 0;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(jsonResponse(200, { five_hour: null, seven_day: null }));

    const getUsage = createAuthoritativeUsageFetcher({
      readToken: async () => ({ accessToken: "tok", expiresAt: null }),
      fetchImpl,
      now: () => clock,
      ttlMs: 180_000,
    });

    await getUsage(); // 429
    clock += 181_000; // one normal TTL past - a 429 must back off FURTHER than this
    await getUsage();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not throw and returns an error result when no token is available at all", async () => {
    const getUsage = createAuthoritativeUsageFetcher({
      readToken: async () => null,
      fetchImpl: vi.fn(),
    });

    const result = await getUsage();

    expect(result.ok).toBe(false);
  });
});

describe("readCachedUsage", () => {
  const NOW_MS = 1_800_000_000_000;
  // Reset times relative to the test clock, so these model windows that are
  // still open (the cache only trusts a window that hasn't ended yet).
  const FIVE_HOUR_RESET = new Date(NOW_MS + 2 * 3_600_000).toISOString();
  const SEVEN_DAY_RESET = new Date(NOW_MS + 3 * 86_400_000).toISOString();
  const cacheFile = (utilization: unknown) =>
    JSON.stringify({
      oauthAccount: { accountUuid: "acct-123" },
      cachedUsageUtilization: {
        fetchedAtMs: NOW_MS - 60_000, // 1 minute old
        accountUuid: "acct-123",
        utilization,
      },
    });
  const freshFile = cacheFile({
    five_hour: { utilization: 30, resets_at: FIVE_HOUR_RESET },
    seven_day: { utilization: 42, resets_at: SEVEN_DAY_RESET },
  });

  it("reads a fresh, matching-account cache and parses both windows", async () => {
    const result = await readCachedUsage({
      readFile: async () => freshFile,
      now: () => NOW_MS,
    });

    expect(result).toEqual({
      ok: true,
      usage: {
        fiveHour: { utilization: 30, resetsAt: FIVE_HOUR_RESET },
        sevenDay: { utilization: 42, resetsAt: SEVEN_DAY_RESET },
      },
    });
  });

  it("drops a window whose reset time has already passed, even from a fresh cache", async () => {
    // Written 1 minute ago while the session was open, but it ended since.
    const file = cacheFile({
      five_hour: { utilization: 96, resets_at: new Date(NOW_MS - 1_000).toISOString() },
      seven_day: { utilization: 42, resets_at: SEVEN_DAY_RESET },
    });

    const result = await readCachedUsage({ readFile: async () => file, now: () => NOW_MS });

    expect(result).toEqual({
      ok: true,
      usage: { fiveHour: null, sevenDay: { utilization: 42, resetsAt: SEVEN_DAY_RESET } },
    });
  });

  it("treats Anthropic's 'no active window' shape (resets_at null) as an absent window", async () => {
    const file = cacheFile({
      five_hour: { utilization: 0, resets_at: null },
      seven_day: { utilization: 42, resets_at: SEVEN_DAY_RESET },
    });

    const result = await readCachedUsage({ readFile: async () => file, now: () => NOW_MS });

    expect(result).toEqual({
      ok: true,
      usage: { fiveHour: null, sevenDay: { utilization: 42, resetsAt: SEVEN_DAY_RESET } },
    });
  });

  it("rejects a cache older than the 1-hour staleness window Claude Code itself uses", async () => {
    const staleFile = JSON.stringify({
      oauthAccount: { accountUuid: "acct-123" },
      cachedUsageUtilization: {
        fetchedAtMs: NOW_MS - 61 * 60_000, // 61 minutes old
        accountUuid: "acct-123",
        utilization: {
          five_hour: { utilization: 30, resets_at: "2026-09-17T03:20:00.000Z" },
          seven_day: null,
        },
      },
    });

    const result = await readCachedUsage({ readFile: async () => staleFile, now: () => NOW_MS });

    expect(result.ok).toBe(false);
  });

  it("rejects a cache written for a different logged-in account", async () => {
    const wrongAccountFile = JSON.stringify({
      oauthAccount: { accountUuid: "acct-CURRENT" },
      cachedUsageUtilization: {
        fetchedAtMs: NOW_MS - 60_000,
        accountUuid: "acct-STALE-FROM-OLD-LOGIN",
        utilization: {
          five_hour: { utilization: 30, resets_at: "2026-09-17T03:20:00.000Z" },
          seven_day: null,
        },
      },
    });

    const result = await readCachedUsage({
      readFile: async () => wrongAccountFile,
      now: () => NOW_MS,
    });

    expect(result.ok).toBe(false);
  });

  it("fails gracefully when the file doesn't exist", async () => {
    const result = await readCachedUsage({
      readFile: async () => {
        throw new Error("ENOENT");
      },
      now: () => NOW_MS,
    });

    expect(result.ok).toBe(false);
  });

  it("fails gracefully when the file has no cachedUsageUtilization key yet", async () => {
    const result = await readCachedUsage({
      readFile: async () => JSON.stringify({ oauthAccount: { accountUuid: "acct-123" } }),
      now: () => NOW_MS,
    });

    expect(result.ok).toBe(false);
  });

  it("treats a null window in the cache the same as the network response would", async () => {
    const fiveHourOnlyFile = cacheFile({
      five_hour: { utilization: 5, resets_at: FIVE_HOUR_RESET },
      seven_day: null,
    });

    const result = await readCachedUsage({
      readFile: async () => fiveHourOnlyFile,
      now: () => NOW_MS,
    });

    expect(result).toEqual({
      ok: true,
      usage: {
        fiveHour: { utilization: 5, resetsAt: FIVE_HOUR_RESET },
        sevenDay: null,
      },
    });
  });
});

describe("createUsageSource", () => {
  const okResult: AuthoritativeUsageResult = {
    ok: true,
    usage: {
      fiveHour: { utilization: 1, resetsAt: "2026-09-17T00:00:00.000Z" },
      sevenDay: null,
    },
  };
  const failResult: AuthoritativeUsageResult = { ok: false, error: "nope" };

  it("uses the cache when it succeeds, without touching the network tier at all", async () => {
    const fetchNetwork = vi.fn(async () => okResult);
    const getUsage = createUsageSource({
      readCache: async () => okResult,
      fetchNetwork,
    });

    const result = await getUsage();

    expect(result).toEqual(okResult);
    expect(fetchNetwork).not.toHaveBeenCalled();
  });

  it("falls through to the network tier when the cache fails", async () => {
    const fetchNetwork = vi.fn(async () => okResult);
    const getUsage = createUsageSource({
      readCache: async () => failResult,
      fetchNetwork,
    });

    const result = await getUsage();

    expect(result).toEqual(okResult);
    expect(fetchNetwork).toHaveBeenCalledTimes(1);
  });

  it("returns the network tier's failure when both fail, without throwing", async () => {
    const getUsage = createUsageSource({
      readCache: async () => failResult,
      fetchNetwork: async () => failResult,
    });

    const result = await getUsage();

    expect(result.ok).toBe(false);
  });

  describe("when the cache has no live session window", () => {
    // A cache that parsed fine but has no open five_hour window: none was
    // active when it was written, or it has ended since.
    const weekOnlyCache: AuthoritativeUsageResult = {
      ok: true,
      usage: {
        fiveHour: null,
        sevenDay: { utilization: 42, resetsAt: "2026-09-19T18:00:00.000Z" },
      },
    };
    const liveResult: AuthoritativeUsageResult = {
      ok: true,
      usage: {
        fiveHour: { utilization: 3, resetsAt: "2026-09-17T05:00:00.000Z" },
        sevenDay: { utilization: 43, resetsAt: "2026-09-19T18:00:00.000Z" },
      },
    };

    it("asks the live API rather than leaving the session to the local estimate", async () => {
      const fetchNetwork = vi.fn(async () => liveResult);
      const getUsage = createUsageSource({
        readCache: async () => weekOnlyCache,
        fetchNetwork,
      });

      const result = await getUsage();

      expect(result).toEqual(liveResult);
      expect(fetchNetwork).toHaveBeenCalledTimes(1);
    });

    it("falls back to the cache's live weekly window when the API is unreachable", async () => {
      const getUsage = createUsageSource({
        readCache: async () => weekOnlyCache,
        fetchNetwork: async () => failResult,
      });

      const result = await getUsage();

      expect(result).toEqual(weekOnlyCache);
    });
  });
});
