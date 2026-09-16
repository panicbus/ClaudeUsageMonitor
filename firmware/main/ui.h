#pragma once

#include "usage_client.h"

// Builds the widget tree once. Must be called after bsp_display_start()
// and while holding the LVGL lock (bsp_display_lock()).
void ui_init(void);

// Updates all labels/bars from a fresh snapshot. Must be called while
// holding the LVGL lock.
void ui_update(const usage_snapshot_t *snapshot);

// Shows a real battery icon/percent when present is true, or hides the
// icon entirely when false - a fake battery indicator on a device with no
// battery is worse than no icon at all.
void ui_set_battery(bool present, int percent, bool charging);

// Updates just the status line to reflect an unreachable service, leaving
// the last-known-good numbers on screen rather than blanking them.
// seconds_since_last_success is -1 if a successful poll has never happened
// at all (distinguishes "never connected" from "lost it a while ago").
// Must be called while holding the LVGL lock.
void ui_set_unreachable(int seconds_since_last_success);
