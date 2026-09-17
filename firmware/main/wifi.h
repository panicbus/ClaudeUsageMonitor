#pragma once

// Connects to the WiFi network configured via CONFIG_WIFI_SSID /
// CONFIG_WIFI_PASSWORD, blocking until connected. Retries indefinitely (with
// backoff on repeated failures) and therefore always eventually returns -
// including if the network isn't up yet at boot (e.g. the router and this
// device power-cycled together).
void wifi_connect(void);
