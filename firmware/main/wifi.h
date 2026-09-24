#pragma once

// Connects to a trusted WiFi network, blocking until connected. Scans and
// prefers CONFIG_WIFI_SSID (home) whenever it's in range, falling back to
// CONFIG_WIFI_SSID_2 (e.g. a phone hotspot, optional) only when it isn't.
// Retries indefinitely (with backoff on repeated failures) and therefore
// always eventually returns - including if neither network is up yet at
// boot (e.g. the router and this device power-cycled together).
void wifi_connect(void);
