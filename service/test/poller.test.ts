import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPolling } from "../src/poller.js";
import type { UsageResponse } from "@claude-usage-monitor/shared";

function makeResponse(tokensUsed: number): UsageResponse {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-13T07:41:00.000Z",
    service: { status: "ok", source: "ccusage" },
    session: {
      active: true,
      tokensUsed,
      tokenLimit: null,
      percentUsed: null,
      windowStart: "2026-09-13T06:00:00.000Z",
      windowEnd: "2026-09-13T11:00:00.000Z",
      minutesRemaining: 199,
    },
    week: null,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("startPolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes the initial snapshot immediately, even though it also kicks off an immediate poll", () => {
    const buildSnapshot = vi.fn(async () => makeResponse(999));
    const poller = startPolling(buildSnapshot, 15_000, makeResponse(0));

    expect(poller.getSnapshot().session?.tokensUsed).toBe(0);
    expect(buildSnapshot).toHaveBeenCalledTimes(1);

    poller.stop();
  });

  it("performs an immediate poll on start, then refreshes every interval", async () => {
    let call = 0;
    const buildSnapshot = vi.fn(async () => makeResponse(++call * 100));
    const poller = startPolling(buildSnapshot, 15_000, makeResponse(0));

    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getSnapshot().session?.tokensUsed).toBe(100);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(poller.getSnapshot().session?.tokensUsed).toBe(200);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(poller.getSnapshot().session?.tokensUsed).toBe(300);

    poller.stop();
  });

  it("keeps serving the last good snapshot if a poll unexpectedly rejects", async () => {
    const buildSnapshot = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(100))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(makeResponse(300));

    const poller = startPolling(buildSnapshot, 15_000, makeResponse(0));

    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getSnapshot().session?.tokensUsed).toBe(100);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(poller.getSnapshot().session?.tokensUsed).toBe(100);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(poller.getSnapshot().session?.tokensUsed).toBe(300);

    poller.stop();
  });

  it("stop() discards even an already-in-flight poll's result, and blocks further ticks", async () => {
    const buildSnapshot = vi.fn(async () => makeResponse(100));
    const poller = startPolling(buildSnapshot, 15_000, makeResponse(0));

    poller.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(poller.getSnapshot().session?.tokensUsed).toBe(0);
    expect(buildSnapshot).toHaveBeenCalledTimes(1);
  });

  it("never starts a new poll while one is still in flight, and never applies a stale result out of order", async () => {
    const first = createDeferred<UsageResponse>();
    const second = createDeferred<UsageResponse>();
    const responses = [first.promise, second.promise];
    let callIndex = 0;
    const buildSnapshot = vi.fn(() => responses[callIndex++]!);

    const poller = startPolling(buildSnapshot, 15_000, makeResponse(0));
    expect(buildSnapshot).toHaveBeenCalledTimes(1);

    // Two interval ticks pass while the first call is still pending.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(buildSnapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(buildSnapshot).toHaveBeenCalledTimes(1);

    // The slow first call finally resolves.
    first.resolve(makeResponse(111));
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getSnapshot().session?.tokensUsed).toBe(111);

    // Only now does the next tick start a second call.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(buildSnapshot).toHaveBeenCalledTimes(2);

    second.resolve(makeResponse(222));
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getSnapshot().session?.tokensUsed).toBe(222);

    poller.stop();
  });
});
