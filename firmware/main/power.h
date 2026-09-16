#pragma once

#include <stdbool.h>

typedef struct {
  bool battery_present;
  int percent;    // 0-100, only meaningful when battery_present is true
  bool charging;
} power_status_t;

// Reads the AXP2101 power-management chip over the board's shared I2C bus.
// Returns false if the chip itself doesn't respond (wrong bus/address, or
// hardware fault) - a real battery reading always returns true, with
// out->battery_present telling you whether one is actually connected.
bool power_read_status(power_status_t *out);
