# Claude Usage Monitor

A small AMOLED desk display that shows your **Claude Code usage limits** at a glance: how much of the current 5-hour session and of your weekly limit you've used, and when each one resets. It updates about every 15 seconds.

<p align="center"><img src="docs/claude-usage-monitor.png" width="420" alt="The device on a desk: the Usage screen showing Current 39% (resets in 4h 11m) and Weekly 44% (resets in 2d 18h), status connected"></p>

It has two parts:

- **A small service** (Node.js/TypeScript) that runs on the computer where you use Claude Code. It works out your current usage and serves it as JSON on your local network.
- **Firmware** for a $30 ESP32-S3 AMOLED board. The board joins your WiFi, polls the service, and draws the screen.

> This is an independent hobby project. It isn't affiliated with or endorsed by Anthropic. It reads files Claude Code keeps on your own computer, and those can change format with any Claude Code update.

---

## Contents

- [How it works](#how-it-works)
- [What you need](#what-you-need)
- [Setup, step by step](#setup-step-by-step)
  - [1. Run the service](#1-run-the-service)
  - [2. Install ESP-IDF](#2-install-esp-idf)
  - [3. Configure the firmware](#3-configure-the-firmware)
  - [4. Build and flash](#4-build-and-flash)
  - [5. Run the service at login](#5-run-the-service-at-login)
- [Reading the screen](#reading-the-screen)
- [Accuracy, and the optional live API](#accuracy-and-the-optional-live-api)
- [Configuration reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Porting to another board](#porting-to-another-board)
- [Development](#development)
- [License](#license)

---

## How it works

```
 Your computer                                         Desk device
 ┌──────────────────────────────────────────┐          ┌──────────────────┐
 │ Claude Code ──writes──► ~/.claude.json    │          │ ESP32-S3 AMOLED  │
 │             ──writes──► ~/.claude/projects│  WiFi    │                  │
 │                              │            │ ◄─────── │ GET /usage       │
 │                    usage service :4317 ───┼────────► │ every 15 s       │
 └──────────────────────────────────────────┘   JSON   └──────────────────┘
```

Anthropic doesn't publish an API for "how much of my limit is left", but Claude Code already knows the exact figure: it's what the `/usage` panel shows. The service gets the number from the most accurate source available, checked separately for the session and for the week:

1. **Claude Code's local usage cache** (`~/.claude.json`). This is the exact figure from the `/usage` panel, and it needs no network calls or credentials. Claude Code only refreshes it occasionally, though, so the service ignores it once it's more than an hour old.
2. **Anthropic's live usage endpoint.** *Off by default.* See [Accuracy, and the optional live API](#accuracy-and-the-optional-live-api).
3. **A local estimate** built from Claude Code's transcripts using [ccusage](https://github.com/ryoppippi/ccusage). The device shows estimated numbers in grey with a `~` prefix, so you can always tell them apart.

The device finds your computer by its `.local` hostname (mDNS/Bonjour), not by IP address, so it keeps working when your router hands your computer a new IP.

---

## What you need

### Hardware

| Item | Notes |
|---|---|
| **Waveshare ESP32-S3-Touch-AMOLED-1.8**, revision **V2** | About $28–30 from [Waveshare](https://www.waveshare.com/esp32-s3-touch-amoled-1.8.htm), Amazon, or AliExpress. V2 has the **CO5300** display driver; check the label on the back or the product listing. The original V1 uses different display and touch chips and is **not supported**. The version without a battery is fine, since the device runs on USB power. |
| **USB-C *data* cable** | A charge-only cable won't work: the computer won't detect the board at all. |
| **A 2.4 GHz WiFi network** | The ESP32-S3 can't see 5 GHz networks. Most home routers broadcast both. For an iPhone hotspot, turn on *Settings → Personal Hotspot → Maximize Compatibility*. |

**Board specs:** ESP32-S3 (dual-core, 240 MHz), 16 MB flash, 8 MB PSRAM, 1.8" 368×448 AMOLED (CO5300, QSPI), AXP2101 power chip. The touch screen isn't used.

### Software

| | Needed for | Tested on |
|---|---|---|
| **Claude Code**, signed in with a Claude subscription (Pro/Max) | Producing the usage data | macOS |
| **Node.js 22.12 or newer** and npm | The service | macOS (Apple Silicon). Linux should work the same way. Windows is untested. |
| **Git** | Cloning | |
| **ESP-IDF v5.5.x** | Building and flashing the firmware, once | v5.5.5 on macOS |

The service must run on **the same computer you use Claude Code on**, since it reads that computer's local files. If you use Claude Code on several machines, the device shows the machine the service runs on.

---

## Setup, step by step

Expect about an hour. Most of it is the one-time ESP-IDF install.

### 1. Run the service

```bash
git clone https://github.com/panicbus/claude-usage-monitor.git
cd claude-usage-monitor
npm install
npm start
```

You should see:

```
claude-usage-monitor service listening on 0.0.0.0:4317
authoritative usage: local cache (~/.claude.json), then estimate (USE_OAUTH_USAGE_API not set)
```

In another terminal, check that it's serving data:

```bash
curl http://localhost:4317/usage
```

You'll get JSON with `session` and `week` objects. If you haven't used Claude Code recently, `session` may be `null`, which is normal: it means no session window is open right now.

**macOS:** the first time the service starts, you may be asked whether to allow `node` to accept incoming network connections. Click **Allow**, or the device won't be able to reach it.

The service needs no configuration. To change settings, copy the example file and edit it (see the [configuration reference](#service-servicesenv)):

```bash
cp service/.env.example service/.env
```

Next, find your computer's **mDNS hostname**. The device will use it to find the service:

| OS | Command | URL to use |
|---|---|---|
| macOS | `scutil --get LocalHostName` | `http://<that>.local:4317/usage` |
| Linux | `hostname` (`avahi-daemon` must be running) | `http://<that>.local:4317/usage` |

Check that it resolves: `curl http://<that>.local:4317/usage` should return the same JSON.

Leave the service running and move on to the firmware.

### 2. Install ESP-IDF

ESP-IDF is Espressif's official toolchain for the ESP32. Waveshare only supports ESP-IDF and Arduino IDE for this board, and this project uses ESP-IDF. You only install it once.

Follow Espressif's [installation guide](https://docs.espressif.com/projects/esp-idf/en/v5.5.5/esp32s3/get-started/index.html) for your OS. On macOS and Linux it comes down to this:

```bash
# macOS prerequisites: brew install cmake ninja dfu-util python3
# Linux prerequisites: see the guide (git, wget, flex, bison, gperf, python3, cmake, ninja-build, ...)

mkdir -p ~/esp && cd ~/esp
git clone -b v5.5.5 --recursive https://github.com/espressif/esp-idf.git
cd esp-idf
./install.sh esp32s3
```

Then, in **every new terminal** where you build firmware:

```bash
. ~/esp/esp-idf/export.sh
```

Optionally, add `alias get_idf='. ~/esp/esp-idf/export.sh'` to your shell profile. Check that it works with `idf.py --version`.

### 3. Configure the firmware

WiFi credentials and the service URL are compiled into the firmware. They live in a file that git ignores, so your passwords never get committed.

```bash
cd firmware
cp sdkconfig.defaults.local.example sdkconfig.defaults.local
```

Edit `firmware/sdkconfig.defaults.local`:

```ini
CONFIG_WIFI_SSID="MyHomeWiFi"
CONFIG_WIFI_PASSWORD="hunter2"

# Optional fallbacks, e.g. your phone's hotspot. Leave blank to disable.
CONFIG_WIFI_SSID_2="Alex’s iPhone"
CONFIG_WIFI_PASSWORD_2="hotspotpass"
CONFIG_WIFI_SSID_3=""
CONFIG_WIFI_PASSWORD_3=""

CONFIG_USAGE_SERVICE_URL="http://my-macbook.local:4317/usage"
```

A few details matter here:

- **The SSID must match exactly, byte for byte.** iPhone hotspot names use a curly apostrophe (`’`), not a straight one (`'`). Copy the name from your phone's settings instead of typing it.
- The device tries networks in priority order (1, then 2, then 3). It uses whichever is in range and working, and switches if one keeps failing.
- Whenever you change this file later, run `rm -f sdkconfig` before rebuilding. Otherwise the change is silently ignored (see [Troubleshooting](#troubleshooting)).

### 4. Build and flash

Plug in the board with the data cable, then:

```bash
. ~/esp/esp-idf/export.sh        # if not already done in this terminal
cd firmware
idf.py build                     # first build downloads components; takes a few minutes
```

Find the board's serial port:

| OS | Command | Looks like |
|---|---|---|
| macOS | `ls /dev/cu.usbmodem*` | `/dev/cu.usbmodem1101` |
| Linux | `ls /dev/ttyACM*` | `/dev/ttyACM0` (you may need to be in the `dialout` group) |

Flash it and watch the log:

```bash
idf.py -p /dev/cu.usbmodem1101 flash monitor
```

On a healthy first boot, the log shows:

```
Claude Usage Monitor firmware booting
starting display
battery: not detected
connecting to SSID: MyHomeWiFi
got IP: 192.168.1.42
WiFi connected
```

The screen shows `* starting up...`, then fills in within a few seconds, and the status line changes to `* connected`. Press `Ctrl+]` to leave the monitor. From then on the board only needs USB power; you don't have to reflash unless you change the WiFi settings or the URL.

### 5. Run the service at login

So far the service only runs while that terminal is open. After a reboot, the device would show `* no signal` until you start it again. Install it as a background service:

<details>
<summary><b>macOS (LaunchAgent)</b></summary>

```bash
REPO="$(pwd)"                       # run from the repo root
NODE_BIN="$(dirname "$(which npx)")"
sed -e "s|__REPO__|$REPO|g" -e "s|__NODE_BIN__|$NODE_BIN|g" -e "s|__HOME__|$HOME|g" \
  deploy/macos/com.claude-usage-monitor.plist \
  > ~/Library/LaunchAgents/com.claude-usage-monitor.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-usage-monitor.plist
```

Stop the `npm start` you ran in step 1 first, since only one copy can hold port 4317.

```bash
launchctl list | grep claude-usage-monitor            # a PID in column 1 = running
tail -f ~/Library/Logs/claude-usage-monitor.err.log   # errors
launchctl kickstart -k gui/$(id -u)/com.claude-usage-monitor   # restart (e.g. after editing .env)
launchctl bootout gui/$(id -u)/com.claude-usage-monitor        # stop and unload
```

**Important:** the plist must point at the same `node`/`npx` you ran `npm install` with. If you have more than one Node install (e.g. arm64 and x64), a mismatch kills the service at startup with an esbuild "installed for another platform" error.

</details>

<details>
<summary><b>Linux (systemd user service)</b></summary>

```bash
REPO="$(pwd)"
NODE_BIN="$(dirname "$(which npx)")"
mkdir -p ~/.config/systemd/user
sed -e "s|__REPO__|$REPO|g" -e "s|__NODE_BIN__|$NODE_BIN|g" \
  deploy/linux/claude-usage-monitor.service \
  > ~/.config/systemd/user/claude-usage-monitor.service
systemctl --user daemon-reload
systemctl --user enable --now claude-usage-monitor
journalctl --user -u claude-usage-monitor -f
```

</details>

<details>
<summary><b>Windows (untested)</b></summary>

The service should run under Node on Windows (`npm start`). To start it at login, create a Task Scheduler task that runs `npx tsx --env-file-if-exists=.env src/index.ts` with **Start in** set to the repo's `service` folder. Allow Node through Windows Firewall on private networks. If the board can't resolve your PC's `.local` name, give the PC a fixed IP in your router and use that in `CONFIG_USAGE_SERVICE_URL`.

</details>

---

## Reading the screen

| Element | Meaning |
|---|---|
| **Current** | The current 5-hour session window |
| **Weekly** | Your rolling weekly limit |
| `42%` (white) | Exact figure from Claude Code's own accounting |
| `~42%` (grey) | **Estimate.** No exact figure was available, so this was reconstructed locally and may be off |
| Bar color | Green below 50%, amber from 50–80%, red above 80% |
| `Resets in 2h 13m` | Time until that window resets |
| `0%` / `No active session` | No window is open right now (you haven't used Claude Code recently). This is normal, not an error. |
| `* connected` | Last poll succeeded |
| `* degraded` | The service is running, but part of the data failed. Check the service log. |
| `* no signal (5m)` | The device hasn't reached the service for 5 minutes. It keeps showing the last good numbers. |
| `* starting up...` | Just booted, no data yet |

---

## Accuracy, and the optional live API

Out of the box, the service uses only data already on your computer:

- When Claude Code's local cache is fresh, the device shows **exact** numbers.
- Claude Code rewrites that cache only occasionally, often hours apart. In between, the service falls back to a **local estimate** (`~`, grey). Weekly estimates tend to be close. Session estimates are rougher, because Anthropic's accounting isn't a simple token count.

### `USE_OAUTH_USAGE_API` (opt-in, at your own risk)

The service can also ask Anthropic's **undocumented** `api.anthropic.com/api/oauth/usage` endpoint directly. Claude Code's own `/usage` panel uses the same endpoint. This gives exact numbers nearly all the time. To do it, the service reads the OAuth token Claude Code has already stored on your machine (macOS Keychain, or `~/.claude/.credentials.json`) and sends it with a Claude Code `User-Agent`. The token is never logged or sent anywhere else, and the service never refreshes it itself.

**Read this before enabling it:** Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) and its February 2026 update restrict using Claude subscription OAuth credentials in anything other than Claude Code and claude.ai. This use is read-only and low-volume (cached, with backoff), but it is still a third-party tool using that token, against an endpoint that can change or disappear without notice. **That's why it's off by default.** Decide for yourself; if you enable it, you do so at your own risk.

```bash
# service/.env
USE_OAUTH_USAGE_API=1
```

Restart the service afterwards. The startup log tells you whether the API is enabled.

### Tuning the estimate

The estimate needs no setup: it compares current usage with your own historical maximum. To pin it closer to Anthropic's numbers instead:

1. Open Claude Code's `/usage` panel and note a percentage.
2. Run `curl localhost:4317/usage` and note `tokensUsed` for the same window.
3. Set the limit to `tokensUsed / (percent / 100)` in `service/.env` (`CLAUDE_SESSION_TOKEN_LIMIT` or `WEEKLY_TOKEN_LIMIT`).
4. Set `WEEKLY_RESET_ANCHOR` from the panel's "Resets *day time*" text, converted to UTC, so the weekly window lines up with your account's real reset.

Plan limits change over time, so recalibrate if the estimate drifts.

---

## Configuration reference

### Service (`service/.env`)

All settings are optional. [`service/.env.example`](service/.env.example) documents each one.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4317` | HTTP port. Must match the firmware URL. |
| `POLL_INTERVAL_MS` | `15000` | How often usage is recomputed |
| `USE_OAUTH_USAGE_API` | off | Opt in to the live API (`1`/`true`). [Read the warning first.](#use_oauth_usage_api-opt-in-at-your-own-risk) |
| `CLAUDE_SESSION_TOKEN_LIMIT` | self-calibrating | Session token limit used by the estimate |
| `CLAUDE_SESSION_COST_LIMIT` | unset | Dollar-cost alternative for the session estimate. Takes priority over the token limit. |
| `WEEKLY_TOKEN_LIMIT` | self-calibrating | Weekly token limit used by the estimate |
| `WEEKLY_RESET_ANCHOR` | UTC calendar week | Any past or future weekly reset time, ISO 8601 (e.g. `2026-01-03T19:00:00Z`) |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Set this only if you run Claude Code with a custom config directory |

`PORT`, `POLL_INTERVAL_MS`, and `USE_OAUTH_USAGE_API` stop the service at startup if they're set to an invalid value, so a typo fails loudly instead of being silently ignored.

### Firmware (`firmware/sdkconfig.defaults.local`)

| Key | Required | Purpose |
|---|---|---|
| `CONFIG_WIFI_SSID` / `CONFIG_WIFI_PASSWORD` | yes | Primary 2.4 GHz network |
| `CONFIG_WIFI_SSID_2` / `_PASSWORD_2` | no | First fallback (e.g. a phone hotspot) |
| `CONFIG_WIFI_SSID_3` / `_PASSWORD_3` | no | Second fallback |
| `CONFIG_USAGE_SERVICE_URL` | yes | `http://<hostname>.local:4317/usage` |

After any change: `rm -f sdkconfig && idf.py build flash`.

---

## Troubleshooting

**The board doesn't show up as a USB device / no `/dev/cu.usbmodem*`**
You're almost certainly using a charge-only cable. Try a different cable that you know carries data.

**The screen stays blank after flashing**
- Check the serial log (`idf.py -p PORT monitor`) for a crash or watchdog backtrace before assuming it's a display problem.
- If you force-killed a serial monitor, the board can be left held in reset. On macOS, run `lsof /dev/cu.usbmodem*`, close whatever still has the port open, then unplug and replug the board.
- Confirm you have a **V2** board (CO5300). V1 boards aren't supported.

**`* no signal`**
Work through these in order:
1. Is the service running? Run `curl http://localhost:4317/usage` on the computer.
2. Does the hostname resolve? Run `curl http://<hostname>.local:4317/usage` from the same computer.
3. Is a firewall blocking port 4317? On macOS, check *System Settings → Network → Firewall* and allow `node`.
4. Is the board on the same network as the computer? A board on home WiFi can't reach a laptop that's on a phone hotspot. After about a minute of failed polls, the board tries any other configured network that's in range.
5. Check the serial log for the WiFi connection lines.

**The board never finds my phone hotspot**
1. The hotspot is probably on 5 GHz, which the board can't see. Turn on *Maximize Compatibility* (iPhone) or set the band to 2.4 GHz (Android).
2. The SSID doesn't match exactly. Watch for the curly apostrophe in iPhone names (`’`, not `'`).

**I changed `sdkconfig.defaults.local` (or `sdkconfig.defaults`) and nothing changed**
These files only apply when `sdkconfig` is generated fresh. Run `rm -f sdkconfig` and rebuild.

**Numbers show `~` most of the time**
This is expected without the live API: Claude Code's local cache is often stale. See [Accuracy, and the optional live API](#accuracy-and-the-optional-live-api).

**Service crashes with esbuild "installed for another platform"**
The Node that runs the service isn't the one that ran `npm install` (e.g. arm64 vs x64 on a Mac). Point the LaunchAgent or systemd unit at the same `node`/`npx`, or rerun `npm install` with the Node the service uses.

**`idf.py` says "Please run the install script" after a Python upgrade**
ESP-IDF's virtualenv name includes the Python version. Point at the env that already exists, then source `export.sh` again: `export IDF_PYTHON_ENV_PATH="$HOME/.espressif/python_env/idf5.5_py3.11_env"` (check `~/.espressif/python_env/` for the right name).

**Builds or git are mysteriously slow, or time out (macOS)**
Don't keep the repo in an iCloud-synced folder (`~/Documents`, `~/Desktop`). iCloud can evict files and fetch them back one at a time, which looks like random timeouts.

---

## Security

- The service listens on `0.0.0.0:4317` **without authentication**, so anyone on your local network can read your usage percentages and token counts. Responses never contain tokens, credentials, or file paths; errors are logged locally and sanitized before they're served. **Don't expose port 4317 to the internet** (no port forwarding).
- WiFi passwords are compiled into the firmware image, so anyone with physical access to the board could read them out of flash.
- `service/.env` and `firmware/sdkconfig.defaults.local` are gitignored. Keep them that way.

---

## Porting to another board

The service doesn't care what hardware is on the other end: anything that can poll `GET /usage` and parse the JSON works. The contract is [`shared/src/types.ts`](shared/src/types.ts).

To port the firmware to a different ESP32 display board, the board-specific code is confined to four files:

| File | What's board-specific |
|---|---|
| [`firmware/main/idf_component.yml`](firmware/main/idf_component.yml) | The Waveshare BSP component. Swap in your board's BSP. |
| [`firmware/main/main.c`](firmware/main/main.c) | `bsp_display_start()`, `bsp_display_brightness_set()`, `bsp_display_lock()`/`bsp_display_unlock()` |
| [`firmware/main/power.c`](firmware/main/power.c) | Battery status read from the AXP2101 over the BSP's I2C bus. Stub it out if your board doesn't have one. |
| [`firmware/main/ui.c`](firmware/main/ui.c) | Layout tuned for 368 px width (`SCREEN_W`) and fixed row positions |

`wifi.c` and `usage_client.c` are plain ESP-IDF and should work on any ESP32 with WiFi. [`CLAUDE.md`](CLAUDE.md) has detailed design notes on every file.

---

## Development

```
service/    Node/TypeScript service (the only npm workspace with code)
shared/     The UsageResponse JSON contract shared by service and firmware
firmware/   ESP-IDF project for the device
deploy/     Run-at-login templates (macOS LaunchAgent, Linux systemd)
```

```bash
npm test             # Vitest; fixture-driven, never calls the real ccusage
npm run typecheck
npm start            # run the service in the foreground
```

A Husky pre-commit hook runs Prettier on staged TypeScript, the typecheck, and a [gitleaks](https://github.com/gitleaks/gitleaks) secret scan. Install gitleaks with `brew install gitleaks` (the hook warns and skips the scan if it's missing).

[`CLAUDE.md`](CLAUDE.md) records the architecture and the reasoning behind non-obvious decisions. Read it before changing behavior.

---

## License

[MIT](LICENSE). Third-party components and fonts are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
