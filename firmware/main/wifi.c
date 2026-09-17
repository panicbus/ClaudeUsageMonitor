#include "wifi.h"

#include "esp_event.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

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

static const char *TAG = "wifi";

static EventGroupHandle_t s_wifi_event_group;
static esp_timer_handle_t s_reconnect_timer;
static int s_retry_count = 0;

static uint32_t backoff_delay_ms(int retry_count) {
  int shift = retry_count - 1;
  if (shift > 5) {  // 2000ms << 5 = 64000ms, already past the 60s cap
    shift = 5;
  }
  uint32_t delay = (uint32_t)WIFI_RETRY_BASE_DELAY_MS << shift;
  return delay > WIFI_RETRY_MAX_DELAY_MS ? WIFI_RETRY_MAX_DELAY_MS : delay;
}

static void reconnect_timer_callback(void *arg) { esp_wifi_connect(); }

static void wifi_event_handler(void *arg, esp_event_base_t event_base,
                                int32_t event_id, void *event_data) {
  if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
    esp_wifi_connect();
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

  wifi_init_config_t init_config = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&init_config));

  ESP_ERROR_CHECK(esp_event_handler_register(
      WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL));
  ESP_ERROR_CHECK(esp_event_handler_register(
      IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL));

  wifi_config_t wifi_config = {
      .sta =
          {
              .ssid = CONFIG_WIFI_SSID,
              .password = CONFIG_WIFI_PASSWORD,
              .threshold.authmode = WIFI_AUTH_WPA2_PSK,
          },
  };

  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
  ESP_ERROR_CHECK(esp_wifi_start());

  ESP_LOGI(TAG, "connecting to SSID: %s", CONFIG_WIFI_SSID);

  xEventGroupWaitBits(s_wifi_event_group, WIFI_CONNECTED_BIT, pdFALSE, pdFALSE,
                       portMAX_DELAY);
}
