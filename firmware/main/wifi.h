#pragma once

// Connects to a trusted WiFi network, blocking until connected. Scans and
// prefers CONFIG_WIFI_SSID (home) whenever it's in range, falling back to
// CONFIG_WIFI_SSID_2 (e.g. a phone hotspot) and then CONFIG_WIFI_SSID_3 (both
// optional). A network that's in range but keeps failing is skipped in favor
// of the next one. Retries indefinitely (with backoff on repeated failures)
// and therefore always eventually returns - including if no network is up
// yet at boot (e.g. the router and this device power-cycled together).
void wifi_connect(void);

// Call after sustained failure to reach the usage service while connected:
// being on the wrong network (e.g. this board on home WiFi while the Mac is on
// a phone hotspot) looks healthy to the WiFi layer, so nothing else will ever
// move it. If another trusted network is in range, drops the current link so
// the normal scan-and-connect cycle moves to that one; if not, or if there's
// no link, does nothing. Safe to call repeatedly and from any task.
void wifi_request_reselect(void);
