#include "wifi.h"

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

static uint32_t backoff_delay_ms(int retry_count) {
  int shift = retry_count - 1;
  if (shift > 5) {  // 2000ms << 5 = 64000ms, already past the 60s cap
    shift = 5;
  }
  uint32_t delay = (uint32_t)WIFI_RETRY_BASE_DELAY_MS << shift;
  return delay > WIFI_RETRY_MAX_DELAY_MS ? WIFI_RETRY_MAX_DELAY_MS : delay;
}

// Scans for the highest-priority (i.e. earliest in s_known_networks) trusted
// network that's actually in range, and returns its index, or -1 if none of
// them are. Scans for each known SSID *directly* (one targeted scan per
// candidate), which also finds networks that don't advertise in a broadcast
// scan. An iPhone hotspot that's never found is a phone-side problem, not a
// scan problem: it must be on 2.4 GHz ("Maximize Compatibility" on - this
// radio can't see 5 GHz), and the configured SSID must match byte-for-byte,
// including iOS's curly apostrophe in names like "Nico’s iPhone".
// Each targeted scan blocks for on the order of a second, so this only ever
// runs on s_reconnect_task, never on the event-loop task or inside an
// esp_timer callback.
static int select_best_known_network(void) {
  for (size_t i = 0; i < NUM_KNOWN_NETWORKS; i++) {
    if (s_known_networks[i].ssid[0] == '\0') {
      continue;
    }

    wifi_scan_config_t scan_config = {
        .ssid = (uint8_t *)s_known_networks[i].ssid,
    };
    if (esp_wifi_scan_start(&scan_config, true) != ESP_OK) {
      continue;
    }

    wifi_ap_record_t ap_record;
    uint16_t ap_count = 1;
    if (esp_wifi_scan_get_ap_records(&ap_count, &ap_record) == ESP_OK &&
        ap_count > 0) {
      return (int)i;
    }
  }
  return -1;
}

// Picks the best currently-visible trusted network (falling back to the
// top-priority one if the scan finds none of them, since a scan can miss a
// network transiently and a wrong guess just costs one failed attempt) and
// connects to it.
static void connect_to_best_known_network(void) {
  int index = select_best_known_network();
  if (index < 0) {
    index = 0;
  }
  const known_network_t *network = &s_known_networks[index];

  wifi_config_t wifi_config = {0};
  strlcpy((char *)wifi_config.sta.ssid, network->ssid,
          sizeof(wifi_config.sta.ssid));
  strlcpy((char *)wifi_config.sta.password, network->password,
          sizeof(wifi_config.sta.password));
  wifi_config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;

  ESP_LOGI(TAG, "connecting to SSID: %s", network->ssid);
  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
  esp_wifi_connect();
}

static void reconnect_task(void *arg) {
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    connect_to_best_known_network();
  }
}

static void reconnect_timer_callback(void *arg) {
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
    // any of these is a bug, not acceptable behavior. The retry itself is
    // deferred via esp_timer (see backoff_delay_ms) rather than called
    // straight from this handler, both to pace repeated failures and
    // because this handler runs on the shared system event loop task,
    // which blocking here would stall.
    s_retry_count++;
    uint32_t delay_ms = backoff_delay_ms(s_retry_count);
    ESP_LOGW(TAG, "disconnected, retrying in %lu ms (attempt %d)",
             (unsigned long)delay_ms, s_retry_count);
    esp_err_t err =
        esp_timer_start_once(s_reconnect_timer, (uint64_t)delay_ms * 1000);
    if (err != ESP_OK) {
      ESP_LOGE(TAG, "failed to schedule reconnect: %s", esp_err_to_name(err));
    }
  } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
    ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
    ESP_LOGI(TAG, "got IP: " IPSTR, IP2STR(&event->ip_info.ip));
    s_retry_count = 0;
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
  // since a scan blocks for a couple of seconds - see select_best_known_network.
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
