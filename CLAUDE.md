# claude-usage-monitor

A desk device that shows near-real-time Claude Code token usage (current 5-hour session + weekly) on a small AMOLED screen. Read this whole file before making changes - several details here (hardware revision, toolchain, why certain things are the way they are) came from real debugging, not guesses.

## What it does, in one paragraph

A Node/TypeScript service (`service/`) runs continuously on the dev Mac. It shells out to the `ccusage` npm CLI (which parses Claude Code's own local JSONL transcripts under `~/.claude/projects/`) to compute current-session and weekly token usage, refines the numbers in ways `ccusage` alone can't (see below), and serves a JSON snapshot over plain HTTP on the LAN. A physical ESP32-S3 desk device (`firmware/`) polls that endpoint over WiFi every 15 seconds and renders the numbers via LVGL: percentage, a color-coded bar, a reset countdown, and a status line.

## Repo

- GitHub: `https://github.com/panicbus/claude-usage-monitor` (private)
- npm workspaces monorepo: `service/`, `firmware/`, `shared/`

## Why this exists, and the core honest constraint

Anthropic publishes no *documented* API for "how much of my usage limit is left," and no real numeric token quota for any plan - two of their own support articles were checked directly and both deliberately avoid printing numbers. **However, Claude Code itself already knows the exact percentage** (it's what powers the `/usage` panel), and this project now reads that real number directly rather than reconstructing an estimate. See "Authoritative usage source" below - this superseded two failed local-estimation attempts (raw token sum, then cost-basis) that both drifted badly within a single session. The old ccusage-based estimate still exists, but only as a fallback for when the authoritative source is unreachable.

## `shared/` - the contract

`shared/src/types.ts` defines `UsageResponse`, the only thing both sides need to agree on:

```ts
interface UsageWindow {
  tokensUsed: number;
  tokenLimit: number | null;   // null = no limit configured, show raw tokens
  percentUsed: number | null;  // null if tokenLimit is null
  windowStart: string;         // ISO 8601
  windowEnd: string;
  minutesRemaining: number;    // pre-computed so firmware never does date math
  source: "anthropic" | "estimated"; // "anthropic" = exact, from Anthropic's own accounting; "estimated" = local reconstruction, may be off
}

interface UsageResponse {
  schemaVersion: 1;
  generatedAt: string;
  service: { status: "ok" | "degraded"; source: "ccusage" | "jsonl-fallback"; error?: string };
  session: (UsageWindow & { active: boolean }) | null;  // null = no active block anywhere right now
  week: UsageWindow | null;
}
```

`session`/`week` being `null` is a **legitimate, tested state** (no active block exists, e.g. during a real gap in usage) - not an error. Don't "fix" it by fabricating a fake window.

## `service/` - the Node/TS backend

Runs via `npx tsx --env-file-if-exists=.env src/index.ts` from `service/`. Serves `GET /usage` on `0.0.0.0:4317` (configurable via `PORT` env var). Polls every 15s (`POLL_INTERVAL_MS`).

### Authoritative usage source (`src/anthropic-usage.ts`)

Claude Code itself already knows the exact session/weekly percentage - it's what renders in its own `/usage` panel. This module reads that real number instead of estimating, in three tiers, tried in order per poll:

1. **Local cache file** - `~/.claude.json` → `cachedUsageUtilization.utilization.{five_hour,seven_day}`. Written by Claude Code itself as it runs; matches the panel exactly; needs zero credentials or network calls. Validated for freshness (`fetchedAtMs` within `CACHE_STALE_MS` = 1 hour, matching Claude Code's own threshold) and for account match (`accountUuid` against `oauthAccount.accountUuid`) before trusting it.
2. **Undocumented OAuth endpoint** - `GET https://api.anthropic.com/api/oauth/usage`, used only if the cache is missing/stale. Requires `Authorization: Bearer <token>` (read from, in order: macOS Keychain `security find-generic-password -s "Claude Code-credentials" -w`, then `~/.claude/.credentials.json`, then `CLAUDE_CODE_OAUTH_TOKEN` env var - never logged, never re-derived by this project, Claude Code refreshes it itself). **Critically requires `User-Agent: claude-code/<version>`** - without it, real-world reports show the request lands in an aggressively rate-limited bucket returning `429` for *hours*. TTL-cached (`createAuthoritativeUsageFetcher`) with exponential backoff on 429 (180s base, doubles up to 16x) since polling happens every 15s but this token is shared with Claude Code's own panel.
3. **Estimate fallback** - if both of the above fail, falls back to the ccusage-based estimate described below, marked `source: "estimated"`.

Session and week fall back **independently** - if the cache/API has one window but not the other, only the missing one drops to the estimate. `createUsageSource()` wires tiers 1+2 together; `usage.ts` adds tier 3.

**Firmware surfaces the difference**: `ui.c` prefixes an estimated percentage with `~` and renders it in muted grey (`COLOR_MUTED`) so an untrustworthy number is visually obvious; an authoritative number renders exactly as before.

### File-by-file

- **`src/anthropic-usage.ts`** - see "Authoritative usage source" above.
- **`src/ccusage.ts`** - the only file that shells out to `ccusage`. Resolves the exact pinned binary via `ccusage/package.json`'s `bin` field (not PATH, not `npx @latest` - both were measured slower/less reliable during initial investigation; direct pinned-binary invocation is ~0.5-1.6s per call with no network dependency). All `execFile` calls have a 10s timeout. Exposes:
  - `getActiveSessionBlock` / `createActiveBlockRunner` - current 5-hour block (`ccusage blocks --active --json --offline`)
  - `getWeeklyTotal` / `createWeeklyRunner` - calendar-week fallback (`ccusage weekly --json --last 1 --offline --timezone UTC`)
  - `getRollingWeekTotal` - sums 5-hour blocks inside a **real rolling 7-day window** anchored to `WEEKLY_RESET_ANCHOR`, since Anthropic's actual weekly reset is a fixed moment on the account, not the UTC calendar week `ccusage weekly` buckets by
  - `getHistoricalMaxBlockTokens` / `getHistoricalMaxWeeklyTokens` - self-calibration fallback: highest token count among *completed* blocks/weeks (excludes the currently-active one, since including it would make it its own baseline)
  - All parsing validates semantically (real calendar dates, not just regex shape) after an adversarial review caught that invalid-but-well-typed input could silently produce `NaN` → `null` while `service.status` stayed `"ok"`.
- **`src/transcripts.ts`** - scans `~/.claude/projects/**/*.jsonl` for the true first-message timestamp inside the active block's window. **Why this exists**: `ccusage` floors a block's reported start to the top of the hour, but the real 5-hour window starts at the actual first message, which can be anywhere within that hour (confirmed empirically: one real block's true start was 50 minutes after `ccusage`'s floored value). This closed a ~41-minute countdown error down to ~4 minutes. Skips any file whose mtime predates the window (cheap-scan optimization) and caches the result per block (`createFirstEntryTimeCache`) so it's not re-scanned every poll.
- **`src/limits.ts` / `src/env.ts`** - `CLAUDE_SESSION_TOKEN_LIMIT`, `WEEKLY_TOKEN_LIMIT` (optional positive ints, silently `null` if unset/invalid - this is a legitimate "not configured" state, not an error), `WEEKLY_RESET_ANCHOR` (optional ISO date), `PORT`/`POLL_INTERVAL_MS` (required-with-default, but **throw** on a set-but-invalid value - config typos should fail loud, not silently misbehave).
- **`src/compute.ts`** - pure `buildUsageWindow()`: percent (clamped 0-100) and minutes-remaining (clamped ≥0) math. No I/O, fully unit-tested.
- **`src/usage.ts`** - orchestrator (`buildUsageResponse`). Runs session/weekly/self-calibration calls in parallel via `Promise.all`; memoizes the full-history blocks dump when it's needed by both the rolling-week calc and self-calibration in the same pass, so it's one subprocess call, not two. Per window, prefers the authoritative source (see above) and only falls to the ccusage-based estimate if it's absent for that window - this is decided independently for session vs. week. A failure in one half (session or week) never blanks the other - each computes independently and only that half goes `null`, with `service.status` flipping to `"degraded"` and a sanitized error message (raw errors, which can contain local file paths, are logged server-side via `console.error` but never sent over HTTP). `sessionTokensUsed` is always taken from ccusage's own block lookup regardless of which source supplied the percentage, so an authoritative session never gets blanked just because ccusage's block lookup failed.
- **`src/poller.ts`** - `startPolling()`: caches the latest snapshot in memory, fires an immediate poll on start (non-blocking - `index.ts` binds the HTTP server right away with a "starting up" placeholder rather than blocking on the first `ccusage` call), then every `POLL_INTERVAL_MS`. Has an in-flight guard (skip a tick if the previous poll hasn't resolved) plus a sequence check, so a slow poll can never resolve late and clobber fresher data - this exact race was reproduced and fixed after an adversarial review.
- **`src/server.ts`** - trivial `node:http` server, just serves the cached snapshot as JSON on `GET /usage`, 404 otherwise.
- **`src/index.ts`** - wires it all together, reads env config, starts the poller and server, handles `SIGINT`.

### Config (`service/.env`, gitignored)

```
CLAUDE_SESSION_TOKEN_LIMIT=<int>       # back-calculated, see comments in the actual .env
WEEKLY_TOKEN_LIMIT=<int>               # rebased for the ROLLING window, not the calendar week
WEEKLY_RESET_ANCHOR=<ISO datetime>     # e.g. 2026-09-19T18:00:00Z = "Sat 11:00 AM" Pacific
```

**These values drift** - Anthropic's real accounting weights models differently than `ccusage`'s raw token sum, and plan limits themselves change over time (already happened once: a Sept 2026 promotion rollback moved the real weekly limit). To recalibrate: open Claude Code's Account & Usage panel (or the `claude.ai` usage popover), compare its reported percentage against the service's `tokensUsed` for the same window, and solve `limit = tokensUsed / percent`. The weekly reset anchor comes directly from the panel's "Resets [day] [time]" text, converted to UTC.

### Running as a LaunchAgent (how it actually runs day to day)

`~/Library/LaunchAgents/com.panicbus.claude-usage-monitor.plist` (not in this repo - it's user-level config) runs the service with `RunAtLoad` + `KeepAlive`, so it starts at login and restarts if it dies. Without it the device just shows `* no signal` after any reboot, which is exactly what prompted adding it.

```bash
launchctl bootout gui/$(id -u)/com.panicbus.claude-usage-monitor                      # stop
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.panicbus.claude-usage-monitor.plist  # start / reload after editing the plist
launchctl list | grep panicbus          # 2nd column is last exit status; "-" in col 1 means not running
tail -f ~/Library/Logs/claude-usage-monitor.err.log
```

`kickstart -k` restarts the job but does **not** re-read a changed plist - use bootout/bootstrap for that. Two things it's sensitive to: `WorkingDirectory` must point at `service/` (the `--env-file-if-exists=.env` path is relative to it), and the Node it launches must be the same one that installed `node_modules` (see the arm64/x64 gotcha below). Also note `KeepAlive` means a crash-looping service rewrites the error log fast - it reached 21MB during one such loop.

### Testing

`npm test --workspace=service` → Vitest, 9 files / 75 tests, all fixture-driven (no real `ccusage` calls in tests). Run from repo root or `service/`.

## `firmware/` - the ESP32-S3 device

### Hardware (verified, not assumed)

- Board: **Waveshare ESP32-S3-Touch-AMOLED-1.8**, revision **V2** (confirmed from the physical back label and by I2C-probing the touch controller address at boot - do not assume V1, the two revisions have completely different display/touch chips).
- Display: **CO5300** AMOLED driver, 368×448, QSPI (`esp_lcd_co5300` under the hood, but the project uses the higher-level `waveshare/esp32_s3_touch_amoled_1_8` BSP component, not the raw driver directly).
- Touch: **CST816S** (unused - this project has no interactive UI).
- Power: **AXP2101** PMIC, on the *same shared I2C bus* as touch (`BSP_I2C_SDA`=GPIO15, `BSP_I2C_SCL`=GPIO14, via `bsp_i2c_get_handle()`) - not the separate bus/pins Waveshare's generic PMU example assumes for other boards.
- IO expander: **TCA9554** (used internally by the BSP; not touched directly by this project's code).
- Flash: 16MB, QIO mode. PSRAM: 8MB octal.
- **No battery ships with this board by default** - confirmed via Waveshare's own docs and via runtime I2C probe of the AXP2101's STATUS1 register (bit 3 = battery-connected). This device's battery header is empty; `power_read_status()` in `power.c` checks this at boot and logs the result - if a battery is ever added, it'll be detected automatically on the next boot.
- USB: native ESP32-S3 USB-Serial/JTAG (shows up as `/dev/cu.usbmodemXXXX` on macOS, `USB JTAG/serial debug unit` in `ioreg`) - no external USB-UART bridge chip. A charge-only USB-C cable will NOT work for flashing; needs a real data cable.

### Toolchain: ESP-IDF, NOT Arduino or PlatformIO

Waveshare's own repo for this board only ships ESP-IDF and Arduino IDE examples - no PlatformIO support at all. This project targets **ESP-IDF v5.5.5** (installed at `~/esp/esp-idf`, matching one of the two versions - the other being v6.0.2 - Waveshare's own repo validates against). Activate in a new shell with the `get_idf` alias (added to `~/.zshrc`; sources `~/esp/esp-idf/export.sh`).

```bash
get_idf                                          # once per new shell
cd firmware
idf.py build
idf.py -p /dev/cu.usbmodemXXXX flash
idf.py -p /dev/cu.usbmodemXXXX monitor           # serial log
```

If you edit `sdkconfig.defaults`, you **must** `rm -f sdkconfig` before rebuilding - defaults only apply when `sdkconfig` doesn't already exist; editing the defaults file alone does nothing to an existing build.

### BSP, not raw drivers

Uses the vendor's managed component `waveshare/esp32_s3_touch_amoled_1_8` (pulled via `idf_component.yml`, lands in `firmware/managed_components/` - **gitignored, regenerated automatically by `idf.py`, do not commit it**, it's ~5000 files). `bsp_display_start()` handles all display/LVGL wiring; app code just calls `bsp_display_lock()`/`bsp_display_unlock()` around any LVGL API use from outside the LVGL port's own task. `idf_component.yml` also pulls `espressif/mdns` the same way, for the hostname resolution described under "Kconfig options" below.

### File-by-file (`firmware/main/`)

- **`main.c`** - `app_main()`: NVS init, display start, one-time battery probe, WiFi connect, `mdns_init()` (see "Kconfig options" below), then the main loop (poll `/usage` every 15s, update UI, refresh battery if one was found). Tracks `last_success_us` (via `esp_timer_get_time()`) so the offline state can distinguish "never connected" from "lost it N minutes ago."
- **`wifi.c`/`.h`** - WiFi station connect. Retries forever, unconditionally - both the *initial* connection at boot and any later disconnect - with exponential backoff (2s, doubling, capped at 60s) so a permanently wrong credential doesn't hammer the AP. `wifi_connect()` returns `void`: it blocks until connected and, by construction, cannot return any other way. Earlier versions bounded the initial attempt to 5 tries and gave up permanently (a real bug: device went permanently offline after the router and device power-cycled together), and separately called `esp_wifi_connect()` synchronously from the disconnect handler with no backoff at all (measured live: ~3-5s forever against a wrong password) - both fixed together.
  Supports three trusted networks in priority order (`s_known_networks`: `WIFI_SSID` home, then `WIFI_SSID_2` e.g. a phone hotspot, then `WIFI_SSID_3` a spare like a travel router or office network). Empty slots are skipped. Every connection attempt (initial and every retry) scans for each known SSID *directly* (one targeted per-SSID scan, not one generic broadcast scan for everything) and connects to the highest-priority one actually found, falling back to the top-priority network if neither is found (a miss just costs one failed attempt, not a stall). **If an iPhone hotspot is never found, it is almost certainly one of two things, neither of them scan-related** (diagnosed 2026-10-02 from the Mac side while it was joined to the hotspot - an earlier version of this note blamed generic-vs-directed scanning, which was never actually observed and was wrong):
  1. **The hotspot is on 5 GHz.** The ESP32-S3 radio is 2.4 GHz only, so a 5 GHz hotspot is physically invisible to it. iOS puts Personal Hotspot on 5 GHz unless **Settings → Personal Hotspot → Maximize Compatibility** is on. Check from the Mac: `system_profiler SPAirPortDataType` → "Current Network Information" → `Channel: 149 (5GHz, …)` means the board can't see it.
  2. **The SSID's apostrophe.** iOS device names use the curly `’` (U+2019, bytes `e2 80 99`), not ASCII `'`. SSIDs match byte-for-byte, so `"Nico's iPhone"` typed with a straight quote never matches the real `"Nico’s iPhone"`. Get the true bytes from the Mac with `networksetup -listpreferredwirelessnetworks en0 | xxd` (the `ipconfig getsummary` / `-getairportnetwork` routes redact the SSID without Location permission).
  The directed per-SSID scan is still the right design (it also finds networks that don't advertise in a broadcast scan), but switching to it did not, by itself, fix anything here. Each targeted scan blocks for roughly a second, so this never runs on the event-loop task or inside an esp_timer callback - both `WIFI_EVENT_STA_START` and the backoff timer just notify a dedicated `s_reconnect_task`, which does the actual scan-and-connect work. **Known limitation, accepted deliberately**: this only re-evaluates on an actual disconnect - if the device is happily connected to the hotspot with a stable link, it won't proactively re-scan and roam back to home WiFi just because home WiFi came back. Fine for the common case (a hotspot connection is usually the less stable one and will drop on its own eventually); a periodic proactive re-check was scoped out as unnecessary complexity for a real but infrequent edge case.
- **`usage_client.c`/`.h`** - polls `CONFIG_USAGE_SERVICE_URL`, parses the JSON with cJSON into a `usage_snapshot_t`. Has a reentrancy guard (`s_poll_in_progress`) around its static response buffer. The URL targets the dev Mac by **mDNS/Bonjour hostname** (e.g. `http://my-mac.local:4317/usage`), not a raw IP - see "Kconfig options" below for why.
- **`power.c`/`.h`** - minimal, hand-rolled I2C reads against the AXP2101 (register map verified against the open-source `lewisxhe/XPowersLib`, not guessed): STATUS1 bit 3 (battery present), STATUS2 bits [7:5] (charging state), register 0xA4 (battery percent). Deliberately does *not* pull in the full XPowersLib C++ dependency for what's a 3-register read.
- **`ui.c`/`.h`** - all LVGL screen construction and updates. Two "rows" (Current/Weekly), each: big percentage (Montserrat 48px) or raw token count if no limit is configured, a color-coded bar (green <50%, amber 50-80%, red >80%), a reset countdown (Montserrat 32px). Title "Usage" in Fira Code SemiBold 56px (`fira_code_56.c` - a generated LVGL font file, converted from the real Fira Code TTF via `lv_font_conv`, not a placeholder). A hand-drawn pixel-art mascot (top-left, drawn into an `lv_image_dsc_t` pixel buffer from an ASCII pattern in source, not an image asset) continuously cycles hue with a per-row phase lag so the color change visibly cascades top-to-bottom. Status line at bottom: `* connected` / `* degraded` / `* no signal (Xm)` / `* starting up...`. When there's no active session anywhere (a real usage gap, not an error), rows show `0%` / `"No active session"` rather than a bare blank `--`. When a window's `source` is `"estimated"` (see "Authoritative usage source"), the percentage is prefixed `~` and rendered in `COLOR_MUTED` instead of `COLOR_TEXT` - a quiet visual tell that the number is a local reconstruction, not Anthropic's own accounting. `usage_client.c`'s `parse_window()` sets `usage_window_t.is_estimated` from the JSON `source` field.
- **`fira_code_56.c`** - generated font data, do not hand-edit; regenerate via `lv_font_conv` if the font/size needs to change.

### Kconfig options (`main/Kconfig.projbuild`)

`WIFI_SSID`, `WIFI_PASSWORD`, `WIFI_SSID_2`, `WIFI_PASSWORD_2`, `WIFI_SSID_3`, `WIFI_PASSWORD_3`, `USAGE_SERVICE_URL` - real values live in `firmware/sdkconfig.defaults.local` (gitignored, contains WiFi passwords - never commit this file). The `_2`/`_3` pairs are optional (blank = disabled) and hold fallback trusted networks - see the `wifi.c` bullet above for how they're prioritized. Note these are read from the defaults files only when `sdkconfig` is generated fresh, so after editing them you must `rm -f sdkconfig` and rebuild (same gotcha as `sdkconfig.defaults`). The committed `sdkconfig.defaults` has the non-secret build config (flash mode/size, PSRAM, partition table, fonts, `CONFIG_LWIP_DNS_SUPPORT_MDNS_QUERIES`).

`USAGE_SERVICE_URL` targets the dev Mac by its **mDNS/Bonjour hostname** (`http://<hostname>.local:4317/usage` - find yours with `scutil --get LocalHostName`), not a raw LAN IP. `CONFIG_LWIP_DNS_SUPPORT_MDNS_QUERIES` makes lwIP transparently resolve any `.local` hostname via mDNS instead of standard DNS; `main.c` calls `mdns_init()` once after WiFi connects to start the resolver, and `usage_client.c` needs no changes at all - `esp_http_client` just resolves the hostname like any other. See "Key decisions" below for why this replaced a hardcoded IP.

## Key decisions worth knowing before changing anything

1. **Authoritative usage source over local estimation, when available** - the single biggest architecture decision. Two prior local-estimation approaches (raw token sum, then ccusage `costUSD` cost-basis) were each empirically measured to drift badly - the implied session limit climbed within a single session (e.g. raw tokens: ~81M→97M→196M across one session's readings) rather than staying constant, meaning cumulative-sum math fundamentally can't track Anthropic's real accounting (leading hypothesis: rate/burst smoothing). Reading Claude Code's own known-good number (`~/.claude.json` cache, or its OAuth `/api/oauth/usage` endpoint as fallback) instead of re-deriving one was the fix - verified to match the account panel exactly. See "Authoritative usage source" above. The old estimate is kept only as a last-resort fallback, not deleted.
2. **ccusage over direct JSONL parsing** - deliberate, tested tradeoff. Pinned exact binary, invoked directly (not via PATH/npx), because ccusage already solves block-boundary logic and evolving token-schema parsing that would otherwise be significant ongoing maintenance.
3. **mDNS hostname over a hardcoded LAN IP for `USAGE_SERVICE_URL`** - fixes a real, twice-reproduced outage: the dev Mac's DHCP lease changed, the firmware kept polling the old dead IP, and the device froze on whatever percentage was last successfully fetched (sometimes for hours) while the status line quietly read `* no signal`. Critically, this isn't a WiFi problem - the board's own WiFi/IP stack was fine both times, so the WiFi retry/backoff fix (below) can't help it. `CONFIG_LWIP_DNS_SUPPORT_MDNS_QUERIES` + `mdns_init()` in `main.c` let the firmware target the Mac's stable Bonjour hostname instead, which survives any future DHCP change with no reflash.
4. **Self-calibration excludes the in-progress block/week** from the "historical max" calculation - including it would make a block its own baseline, distorting the percentage toward 100% as it grows.
5. **Session refinement can legitimately show a *later* windowStart than ccusage's floor** - this is correct, not a bug (verified: real gaps in usage mean the true first message of a block can be up to an hour after the floored hour boundary).
6. **`session`/`week` being `null` is valid** - it means no active block exists right now (e.g. you haven't used Claude Code in the current window). Don't treat this as an error state to eliminate; the UI now handles it explicitly (0% + "No active session") instead of a bare blank.
7. **No PlatformIO/Arduino** - ESP-IDF only, because that's all Waveshare supports for this exact board.
8. **No XPowersLib dependency** - a full C++ PMU driver library was deliberately avoided in favor of 3 direct register reads, since the battery feature only needs presence/percent/charging-state.

## Gotchas learned the hard way

- **Killing a process holding `/dev/cu.usbmodemXXXX` (`kill -9`) can leave the board held in reset**, making the screen go blank until the next real flash/reset - this caused several false "the display is broken" scares. If the screen is unexpectedly blank, check `lsof /dev/cu.usbmodemXXXX` for a stray process before assuming a firmware bug.
- **A charge-only USB-C cable won't show up as any USB device at all** (`ioreg -p IOUSB` shows nothing new, no `/dev/cu.usbmodem*` appears) - the fix is a real data cable, not a firmware/driver issue.
- **Editing `sdkconfig.defaults` requires `rm -f sdkconfig` before the next build** or the change silently doesn't apply.
- **`goto` past a variable declaration with an initializer will fail this project's build** (`-Werror=all` includes `-Wjump-misses-init`) - restructure with an early-return helper function instead.
- **This repo lives in `~/Developer/UsageDongle` and must NOT be moved back under `~/Documents`.** It was moved out on 2026-10-02 precisely because iCloud sync made it unusable: iCloud evicted the files and served them back on demand at roughly **2 seconds per file** (measured - reading 300 small files took 10m49s at 0% CPU, i.e. pure I/O wait, with *zero* read failures, so nothing was corrupt, just evicted). That broke three separate things, each reported by the tool itself rather than inferred: git (`.git/index: unable to map index file: Operation timed out` - `rm -f .git/index && git reset` rebuilds it, since the index is a derived cache), the compiler (`lvgl.h: Operation timed out` on headers under `firmware/managed_components/`, which also surfaced as a nonsense `undefined reference to 'fira_code_56'` link error - fixed by deleting `managed_components` and letting `idf.py` re-fetch it), and the service (Node hanging forever during module load, or dying with `Unknown system error -11` / EAGAIN, because it couldn't read its own `node_modules`). The same 300-file read after the move: **0.868s**, a ~750x difference.
- **macOS has no `timeout` command**, so a `timeout N cmd && echo OK || echo FAIL` probe reports FAIL for *everything* (exit 127, command not found) - this produced a completely false "all files are unreadable" diagnosis during the iCloud debugging above, and nearly led to the wrong fix. Use `head -c`/`cat` directly, or install `coreutils` for `gtimeout`.
- **This Mac has two Node installs, and the LaunchAgent must use the native one.** `/usr/local/bin/node` is **arm64, v24** (what an interactive `npm install` uses), while `/usr/local/opt/node@22/bin/node` is **x64 under Rosetta, v22**. The agent was originally pinned to the x64 one; after a fresh `npm install` (done with the arm64 node) that combination broke, because npm installed `@esbuild/darwin-arm64` while the x64 node demanded `@esbuild/darwin-x64` - `tsx` depends on esbuild, so the service died on startup with esbuild's "you installed esbuild for another platform" error. Keep the plist's `ProgramArguments[0]` and its `PATH` on `/usr/local/bin`, so the node that runs the service is the same one that installed `node_modules`. `/usr/local` here is *Intel* Homebrew's prefix but `/usr/local/bin/node` is still the arm64 build - check `node -p process.arch`, don't assume from the path.
- **`get_idf` / `export.sh` can break when Homebrew upgrades Python.** `export.sh` derives its virtualenv name from whatever `python3` resolves to, so after Homebrew moved `python@3.11` → `python@3.12`, `python3` became Xcode's 3.9 and it looked for a nonexistent `idf5.5_py3.9_env` ("Please run the install script"). The existing `idf5.5_py3.11_env` is still fine - just point at it explicitly: `export IDF_PYTHON_ENV_PATH="$HOME/.espressif/python_env/idf5.5_py3.11_env"` before sourcing `export.sh`.
- When debugging "the display shows nothing," **always check the serial log for a crash/watchdog backtrace before assuming a rendering bug** - a real instance of this was traced to a task-watchdog panic inside `lv_label_set_text` called on a NULL widget (from an incomplete manual test reduction, not the actual shipped code).

## Current status (as of the initial commit, `caa2b4d`)

All 10 original waypoints complete: service (ccusage integration → HTTP endpoint) and firmware (flashing → WiFi → polling → real UI → offline state → polish) are both done and bench-verified against the physical device. Known acceptable limitations, not bugs: token limits require periodic manual recalibration (see above); the weekly reset anchor is a manually-entered date, not auto-detected.
