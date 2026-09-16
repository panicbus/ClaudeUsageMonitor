import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

async function collectJsonlFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // missing/unreadable dir is not an error - just no data
  }

  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsonlFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(full);
    }
  }
  return files;
}

// ccusage floors each 5-hour block's start to the top of the hour, but
// Anthropic's real session window starts at the first message. Reading that
// timestamp back out of the transcripts is what keeps the reset countdown
// from running up to an hour early.
export async function findFirstEntryTime(
  windowStart: Date,
  windowEnd: Date,
  projectsDir = defaultProjectsDir(),
): Promise<Date | null> {
  const files = await collectJsonlFiles(projectsDir);
  let earliest: number | null = null;

  for (const file of files) {
    // A file untouched since the window opened cannot hold an entry inside
    // it, so skip the read entirely - this is what keeps the scan cheap.
    try {
      const info = await stat(file);
      if (info.mtimeMs < windowStart.getTime()) continue;
    } catch {
      continue;
    }

    let contents: string;
    try {
      contents = await readFile(file, "utf-8");
    } catch {
      continue;
    }

    for (const line of contents.split("\n")) {
      if (line.length === 0) continue;

      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // partially-written trailing line, etc.
      }

      if (typeof entry !== "object" || entry === null) continue;
      const timestamp = (entry as Record<string, unknown>).timestamp;
      if (typeof timestamp !== "string") continue;

      const at = Date.parse(timestamp);
      if (Number.isNaN(at)) continue;
      if (at < windowStart.getTime() || at >= windowEnd.getTime()) continue;

      if (earliest === null || at < earliest) earliest = at;
    }
  }

  return earliest === null ? null : new Date(earliest);
}

// The first-entry time for a given block never changes once found, so this
// keeps the transcript scan to once per block rather than once per poll.
export function createFirstEntryTimeCache(
  find: typeof findFirstEntryTime = findFirstEntryTime,
) {
  let cachedKey: string | null = null;
  let cachedValue: Date | null = null;

  return async function getFirstEntryTime(
    windowStart: Date,
    windowEnd: Date,
    projectsDir?: string,
  ): Promise<Date | null> {
    const key = windowStart.toISOString();
    if (key === cachedKey) return cachedValue;

    const found = await find(windowStart, windowEnd, projectsDir);
    // Only cache a hit; a miss may just mean the block has no entries
    // written yet, and the next poll should look again.
    if (found !== null) {
      cachedKey = key;
      cachedValue = found;
    }
    return found;
  };
}
