import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFirstEntryTimeCache, findFirstEntryTime } from "../src/transcripts.js";

const WINDOW_START = new Date("2026-09-16T00:00:00.000Z");
const WINDOW_END = new Date("2026-09-16T05:00:00.000Z");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "transcripts-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeTranscript(
  relPath: string,
  lines: string[],
  mtime = new Date("2026-09-16T04:00:00.000Z"),
) {
  const full = join(dir, relPath);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, lines.join("\n") + "\n", "utf-8");
  await utimes(full, mtime, mtime);
}

describe("findFirstEntryTime", () => {
  it("finds the earliest entry timestamp inside the window, across nested dirs", async () => {
    await writeTranscript("proj-a/one.jsonl", [
      JSON.stringify({ timestamp: "2026-09-16T02:15:00.000Z" }),
      JSON.stringify({ timestamp: "2026-09-16T03:30:00.000Z" }),
    ]);
    await writeTranscript("proj-b/two.jsonl", [
      JSON.stringify({ timestamp: "2026-09-16T00:41:12.000Z" }),
      JSON.stringify({ timestamp: "2026-09-16T04:00:00.000Z" }),
    ]);

    const found = await findFirstEntryTime(WINDOW_START, WINDOW_END, dir);

    expect(found?.toISOString()).toBe("2026-09-16T00:41:12.000Z");
  });

  it("ignores entries outside the window on both ends", async () => {
    await writeTranscript("proj/x.jsonl", [
      JSON.stringify({ timestamp: "2026-09-15T23:59:59.000Z" }), // before
      JSON.stringify({ timestamp: "2026-09-16T05:00:00.000Z" }), // at end (exclusive)
      JSON.stringify({ timestamp: "2026-09-16T03:00:00.000Z" }), // inside
    ]);

    const found = await findFirstEntryTime(WINDOW_START, WINDOW_END, dir);

    expect(found?.toISOString()).toBe("2026-09-16T03:00:00.000Z");
  });

  it("skips files whose mtime predates the window (the cheap-scan optimization)", async () => {
    // Contains an in-window timestamp, but the file was last written before
    // the window opened, so it must not be read.
    await writeTranscript(
      "stale/old.jsonl",
      [JSON.stringify({ timestamp: "2026-09-16T00:05:00.000Z" })],
      new Date("2026-09-15T10:00:00.000Z"),
    );
    await writeTranscript("fresh/new.jsonl", [
      JSON.stringify({ timestamp: "2026-09-16T02:00:00.000Z" }),
    ]);

    const found = await findFirstEntryTime(WINDOW_START, WINDOW_END, dir);

    expect(found?.toISOString()).toBe("2026-09-16T02:00:00.000Z");
  });

  it("tolerates malformed lines, entries without timestamps, and non-jsonl files", async () => {
    await writeTranscript("proj/y.jsonl", [
      "{ this is not valid json",
      JSON.stringify({ type: "summary", noTimestamp: true }),
      JSON.stringify({ timestamp: "not-a-date" }),
      JSON.stringify({ timestamp: "2026-09-16T01:00:00.000Z" }),
    ]);
    await writeTranscript("proj/ignored.txt", ["garbage"]);

    const found = await findFirstEntryTime(WINDOW_START, WINDOW_END, dir);

    expect(found?.toISOString()).toBe("2026-09-16T01:00:00.000Z");
  });

  it("returns null when nothing matches", async () => {
    await writeTranscript("proj/z.jsonl", [
      JSON.stringify({ timestamp: "2026-09-10T01:00:00.000Z" }),
    ]);

    expect(await findFirstEntryTime(WINDOW_START, WINDOW_END, dir)).toBeNull();
  });

  it("returns null for a missing projects directory rather than throwing", async () => {
    const found = await findFirstEntryTime(
      WINDOW_START,
      WINDOW_END,
      join(dir, "does-not-exist"),
    );

    expect(found).toBeNull();
  });
});

describe("createFirstEntryTimeCache", () => {
  it("scans once per block, then serves the cached value", async () => {
    const find = vi.fn(async () => new Date("2026-09-16T00:41:00.000Z"));
    const getFirstEntryTime = createFirstEntryTimeCache(find);

    await getFirstEntryTime(WINDOW_START, WINDOW_END);
    await getFirstEntryTime(WINDOW_START, WINDOW_END);
    await getFirstEntryTime(WINDOW_START, WINDOW_END);

    expect(find).toHaveBeenCalledTimes(1);
  });

  it("rescans when the block rolls over to a new window", async () => {
    const find = vi.fn(async () => new Date("2026-09-16T00:41:00.000Z"));
    const getFirstEntryTime = createFirstEntryTimeCache(find);

    await getFirstEntryTime(WINDOW_START, WINDOW_END);
    await getFirstEntryTime(
      new Date("2026-09-16T05:00:00.000Z"),
      new Date("2026-09-16T10:00:00.000Z"),
    );

    expect(find).toHaveBeenCalledTimes(2);
  });

  it("does not cache a miss, so a block with no entries yet is retried", async () => {
    const find = vi.fn(async () => null);
    const getFirstEntryTime = createFirstEntryTimeCache(find);

    await getFirstEntryTime(WINDOW_START, WINDOW_END);
    await getFirstEntryTime(WINDOW_START, WINDOW_END);

    expect(find).toHaveBeenCalledTimes(2);
  });
});
