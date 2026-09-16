#include <stdbool.h>

#include "bsp/esp-bsp.h"
#include "esp_idf_version.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "power.h"
#include "ui.h"
#include "usage_client.h"
#include "wifi.h"

#define POLL_INTERVAL_MS 15000

static const char *TAG = "usage_monitor";

void app_main(void) {
  ESP_LOGI(TAG, "Claude Usage Monitor firmware booting");

  esp_err_t ret = nvs_flash_init();
  if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    ret = nvs_flash_init();
  }
  ESP_ERROR_CHECK(ret);

  ESP_LOGI(TAG, "starting display");
#if ESP_IDF_VERSION < ESP_IDF_VERSION_VAL(6, 0, 0)
  esp_log_level_t i2c_log_level = esp_log_level_get("i2c.master");
  esp_log_level_set("i2c.master", ESP_LOG_NONE);
#endif
  lv_display_t *display = bsp_display_start();
#if ESP_IDF_VERSION < ESP_IDF_VERSION_VAL(6, 0, 0)
  esp_log_level_set("i2c.master", i2c_log_level);
#endif
  if (display == NULL) {
    ESP_LOGE(TAG, "display start failed");
    return;
  }
  ESP_ERROR_CHECK(bsp_display_brightness_set(85));

  bool ui_ready = false;
  if (bsp_display_lock(0)) {
    ui_init();
    ui_ready = true;
    bsp_display_unlock();
  } else {
    ESP_LOGE(TAG, "failed to lock LVGL for ui_init - UI will not be shown");
  }

  // Probed once at boot: on a corded desk device a battery is the
  // exception, not the rule, so there's no need to keep re-checking for
  // one that was never there. If one IS found, keep refreshing its charge
  // level in the poll loop below.
  power_status_t power = {0};
  bool has_battery = power_read_status(&power) && power.battery_present;
  ESP_LOGI(TAG, "battery: %s", has_battery ? "present" : "not detected");
  if (ui_ready && bsp_display_lock(0)) {
    ui_set_battery(has_battery, power.percent, power.charging);
    bsp_display_unlock();
  }

  if (!wifi_connect()) {
    ESP_LOGE(TAG, "failed to connect to WiFi");
  } else {
    ESP_LOGI(TAG, "WiFi connected");
  }

  // -1 means "never had a successful poll yet" - kept distinct from a real
  // elapsed time so the UI can tell "never connected" from "lost it a
  // while ago" instead of collapsing both into the same message.
  int64_t last_success_us = -1;

  while (1) {
    usage_snapshot_t snapshot;
    usage_client_poll(&snapshot);
    if (snapshot.ok) {
      last_success_us = esp_timer_get_time();
    }

    if (has_battery) {
      power_read_status(&power);
    }

    if (ui_ready) {
      if (bsp_display_lock(0)) {
        if (snapshot.ok) {
          ui_update(&snapshot);
        } else {
          int seconds_since_last_success =
              last_success_us < 0
                  ? -1
                  : (int)((esp_timer_get_time() - last_success_us) / 1000000);
          ui_set_unreachable(seconds_since_last_success);
        }
        if (has_battery) {
          ui_set_battery(power.battery_present, power.percent, power.charging);
        }
        bsp_display_unlock();
      } else {
        ESP_LOGE(TAG, "failed to lock LVGL for ui_update");
      }
    }

    vTaskDelay(pdMS_TO_TICKS(POLL_INTERVAL_MS));
  }
}
