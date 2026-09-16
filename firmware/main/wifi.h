#pragma once

#include <stdbool.h>

// Connects to the WiFi network configured via CONFIG_WIFI_SSID /
// CONFIG_WIFI_PASSWORD, blocking until connected or all retries are
// exhausted. Returns true on success.
bool wifi_connect(void);
