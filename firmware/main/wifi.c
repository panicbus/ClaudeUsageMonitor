#include "wifi.h"

#include <stdbool.h>
#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"

#define WIFI_CONNECTED_BIT BIT0

// Backoff for repeated disconnects, e.g. a stale WiFi password - not for the
// ordinary case, which is paced by the WPA handshake's own ~3s timeout.
// Measured empirically (real device, wrong password): each failed attempt
// already takes ~3s end to end, so retrying forever with no cap on top of
// that is ~1200 auth attempts/hour indefinitely against the AP. Doubling up
// to a 60s ceiling keeps the "always eventually connects" guarantee while
// making a permanent misconfiguration settle down instead of hammering.
#define WIFI_RETRY_BASE_DELAY_MS 2000
#define WIFI_RETRY_MAX_DELAY_MS 60000

// After this many consecutive failed attempts on one network (couldn't
// associate, or never got an IP), select_best_known_network() skips it in
// favor of the next trusted network in range. Without this, a network that's
// visible but unusable (weak signal, changed password) would win every scan
// on priority alone and starve a lower-priority network that would work.
#define WIFI_MAX_FAILURES_PER_NETWORK 2

// Trusted networks, in priority order - the earliest one that's actually in
// range wins, so WIFI_SSID (home) beats WIFI_SSID_2 (e.g. a phone hotspot),
// which beats WIFI_SSID_3 (a spare: travel router, office, second phone). An
// empty ssid means that slot isn't configured and is skipped.
typedef struct {
  const char *ssid;
  const char *password;
} known_network_t;

#define NUM_KNOWN_NETWORKS 3
static const known_network_t s_known_networks[NUM_KNOWN_NETWORKS] = {
    {CONFIG_WIFI_SSID, CONFIG_WIFI_PASSWORD},
    {CONFIG_WIFI_SSID_2, CONFIG_WIFI_PASSWORD_2},
    {CONFIG_WIFI_SSID_3, CONFIG_WIFI_PASSWORD_3},
};

static const char *TAG = "wifi";

static EventGroupHandle_t s_wifi_event_group;
static esp_timer_handle_t s_reconnect_timer;
static TaskHandle_t s_reconnect_task;
static int s_retry_count = 0;

// Owned by s_reconnect_task alone (the event-loop task never touches them):
// consecutive failed attempts per network, and which network the current or
// most recent attempt targeted (-1 before the first attempt).
static int s_failures[NUM_KNOWN_NETWORKS];
static int s_current_index = -1;

// Shared between tasks, each written from one place: set by the event
// handler (got an IP / link dropped), cleared by s_reconnect_task at the
// start of an attempt. Plain word-sized flags, so volatile is sufficient.
static volatile bool s_attempt_succeeded = false;
static volatile bool s_connected = false;
static volatile bool s_reselect_requested = false;

static uint32_t backoff_delay_ms(int retry_count) {
  int shift = retry_count - 1;
  if (shift > 5) {  // 2000ms << 5 = 64000ms, already past the 60s cap
    shift = 5;
  }
  uint32_t delay = (uint32_t)WIFI_RETRY_BASE_DELAY_MS << shift;
  return delay > WIFI_RETRY_MAX_DELAY_MS ? WIFI_RETRY_MAX_DELAY_MS : delay;
}

// Backs off, then re-runs the scan-and-connect cycle via the reconnect task.
// Every failure that won't otherwise produce a WIFI_EVENT_STA_DISCONNECTED
// must come through here too: esp_wifi_connect() failing synchronously (e.g.
// ESP_ERR_WIFI_SSID for a blank SSID) emits no event at all, so without this
// the retry chain would die silently and wifi_connect() would block forever.
// The retry is deferred via esp_timer rather than run inline, both to pace
// repeated failures and because the DISCONNECTED handler runs on the shared
// system event loop task, which blocking would stall.
static void schedule_reconnect(const char *reason) {
  s_retry_count++;
  uint32_t delay_ms = backoff_delay_ms(s_retry_count);
  ESP_LOGW(TAG, "%s, retrying in %lu ms (attempt %d)", reason,
           (unsigned long)delay_ms, s_retry_count);
  esp_err_t err =
      esp_timer_start_once(s_reconnect_timer, (uint64_t)delay_ms * 1000);
  // INVALID_STATE just means a retry is already armed.
  if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
    ESP_LOGE(TAG, "failed to schedule reconnect: %s", esp_err_to_name(err));
  }
}

// Whether the given trusted network is currently in range. Scans for its SSID
// *directly* (a targeted scan, not a broadcast scan for everything), which
// also finds networks that don't advertise in a broadcast scan. An iPhone
// hotspot that's never found is a phone-side problem, not a scan problem: it
// must be on 2.4 GHz ("Maximize Compatibility" on - this radio can't see
// 5 GHz), and the configured SSID must match byte-for-byte, including iOS's
// curly apostrophe in names like "Nico’s iPhone".
// A scan that finds nothing dwells on every channel and takes ~2.5s (measured
// on the device), so this only ever runs on s_reconnect_task, never on the
// event-loop task or inside an esp_timer callback.
static bool ssid_in_range(size_t i) {
  wifi_scan_config_t scan_config = {
      .ssid = (uint8_t *)s_known_networks[i].ssid,
  };
  if (esp_wifi_scan_start(&scan_config, true) != ESP_OK) {
    return false;
  }

  wifi_ap_record_t ap_record;
  uint16_t ap_count = 1;
  return esp_wifi_scan_get_ap_records(&ap_count, &ap_record) == ESP_OK &&
         ap_count > 0;
}

// Returns the index of the highest-priority trusted network that's in range
// and hasn't failed repeatedly, or -1 if none of them are in range. If every
// network in range has failed repeatedly, the failure counts are forgotten
// (they exist only to give a lower-priority network a turn) and the
// highest-priority one in range is returned, so selection never gets stuck.
static int select_best_known_network(void) {
  int first_in_range = -1;
  for (size_t i = 0; i < NUM_KNOWN_NETWORKS; i++) {
    if (s_known_networks[i].ssid[0] == '\0' || !ssid_in_range(i)) {
      continue;
    }
    if (s_failures[i] < WIFI_MAX_FAILURES_PER_NETWORK) {
      return (int)i;
    }
    if (first_in_range < 0) {
      first_in_range = (int)i;
    }
  }

  if (first_in_range >= 0) {
    memset(s_failures, 0, sizeof(s_failures));
  }
  return first_in_range;
}

// Picks the best currently-usable trusted network (falling back to the
// top-priority one if none is in range, since a scan can miss a network
// transiently and a wrong guess just costs one failed attempt) and connects.
static void connect_to_best_known_network(void) {
  // Settle the previous attempt first: reaching an IP clears that network's
  // failure count; anything else (couldn't associate, or the link was
  // deliberately dropped by switch_to_other_network) adds one.
  if (s_current_index >= 0) {
    s_failures[s_current_index] =
        s_attempt_succeeded ? 0 : s_failures[s_current_index] + 1;
  }

  int index = select_best_known_network();
  if (index < 0) {
    index = 0;
  }
  const known_network_t *network = &s_known_networks[index];
  s_current_index = index;
  s_attempt_succeeded = false;

  wifi_config_t wifi_config = {0};
  strlcpy((char *)wifi_config.sta.ssid, network->ssid,
          sizeof(wifi_config.sta.ssid));
  strlcpy((char *)wifi_config.sta.password, network->password,
          sizeof(wifi_config.sta.password));
  wifi_config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;

  ESP_LOGI(TAG, "connecting to SSID: %s", network->ssid);
  esp_err_t err = esp_wifi_set_config(WIFI_IF_STA, &wifi_config);
  if (err == ESP_OK) {
    err = esp_wifi_connect();
  }
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "starting connection to \"%s\" failed: %s", network->ssid,
             esp_err_to_name(err));
    schedule_reconnect("connect failed");
  }
}

// Connected, but the usage service isn't reachable from here (see
// wifi_request_reselect). If another trusted network is in range, penalize
// the current one and drop the link: the DISCONNECTED event then drives the
// normal scan-and-connect cycle, which skips the penalized network and lands
// on the other. Returns true if it dropped the link. If nothing else is in
// range it does nothing - bouncing the link wouldn't help.
static bool switch_to_other_network(void) {
  if (!s_connected || s_current_index < 0) {
    return false;
  }
  for (size_t i = 0; i < NUM_KNOWN_NETWORKS; i++) {
    if ((int)i == s_current_index || s_known_networks[i].ssid[0] == '\0' ||
        !ssid_in_range(i)) {
      continue;
    }
    ESP_LOGW(TAG, "service unreachable via \"%s\"; switching to \"%s\"",
             s_known_networks[s_current_index].ssid, s_known_networks[i].ssid);
    s_failures[s_current_index] = WIFI_MAX_FAILURES_PER_NETWORK;
    s_attempt_succeeded = false;
    esp_wifi_disconnect();
    return true;
  }
  return false;
}

static void reconnect_task(void *arg) {
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);

    bool dropped_link = false;
    if (s_reselect_requested) {
      s_reselect_requested = false;
      dropped_link = switch_to_other_network();
    }

    // Only run a connect cycle when there's no link: notifications coalesce,
    // so a reselect request can arrive in the same wakeup as a retry timer
    // (that cycle must still run), and a late timer notification after
    // we've already reconnected must not bounce a working link.
    if (!dropped_link && !s_connected) {
      connect_to_best_known_network();
    }
  }
}

static void reconnect_timer_callback(void *arg) {
  xTaskNotifyGive(s_reconnect_task);
}

void wifi_request_reselect(void) {
  if (!s_connected || s_reconnect_task == NULL) {
    return;
  }
  s_reselect_requested = true;
  xTaskNotifyGive(s_reconnect_task);
}

static void wifi_event_handler(void *arg, esp_event_base_t event_base,
                                int32_t event_id, void *event_data) {
  if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
    xTaskNotifyGive(s_reconnect_task);
  } else if (event_base == WIFI_EVENT &&
             event_id == WIFI_EVENT_STA_DISCONNECTED) {
    // Retry forever, unconditionally - both for a transient drop after a
    // prior success (router reboot, brief outage) AND for the *initial*
    // connection at boot, since the network may simply not be up yet (e.g.
    // the router and this device power-cycled together after an outage). A
    // desk device that requires a manual reset to come back online after
    // any of these is a bug, not acceptable behavior.
    s_connected = false;
    schedule_reconnect("disconnected");
  } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
    ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
    ESP_LOGI(TAG, "got IP: " IPSTR, IP2STR(&event->ip_info.ip));
    s_retry_count = 0;
    s_attempt_succeeded = true;
    s_connected = true;
    xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
  }
}

void wifi_connect(void) {
  s_wifi_event_group = xEventGroupCreate();

  ESP_ERROR_CHECK(esp_netif_init());
  ESP_ERROR_CHECK(esp_event_loop_create_default());
  esp_netif_create_default_wifi_sta();

  const esp_timer_create_args_t timer_args = {
      .callback = &reconnect_timer_callback,
      .name = "wifi_reconnect",
  };
  ESP_ERROR_CHECK(esp_timer_create(&timer_args, &s_reconnect_timer));

  // Does the actual (scan + connect) work off the event-loop/timer tasks,
  // since a scan blocks for a couple of seconds - see ssid_in_range.
  xTaskCreate(reconnect_task, "wifi_reconnect_task", 8192, NULL, 5,
              &s_reconnect_task);

  wifi_init_config_t init_config = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&init_config));

  ESP_ERROR_CHECK(esp_event_handler_register(
      WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL));
  ESP_ERROR_CHECK(esp_event_handler_register(
      IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL));

  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
  ESP_ERROR_CHECK(esp_wifi_start());

  xEventGroupWaitBits(s_wifi_event_group, WIFI_CONNECTED_BIT, pdFALSE, pdFALSE,
                       portMAX_DELAY);
}
