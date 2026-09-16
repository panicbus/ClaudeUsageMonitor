#include "usage_client.h"

#include <string.h>

#include "cJSON.h"
#include "esp_http_client.h"
#include "esp_log.h"

#define USAGE_BUFFER_SIZE 2048

static const char *TAG = "usage_client";

static void parse_window(cJSON *window, usage_window_t *out) {
  memset(out, 0, sizeof(*out));

  if (!window || cJSON_IsNull(window)) {
    return;
  }

  cJSON *tokens_used = cJSON_GetObjectItem(window, "tokensUsed");
  cJSON *percent_used = cJSON_GetObjectItem(window, "percentUsed");
  cJSON *minutes_remaining = cJSON_GetObjectItem(window, "minutesRemaining");

  out->present = true;
  out->tokens_used = cJSON_IsNumber(tokens_used) ? tokens_used->valuedouble : 0;
  out->minutes_remaining =
      cJSON_IsNumber(minutes_remaining) ? minutes_remaining->valueint : 0;

  if (cJSON_IsNumber(percent_used)) {
    out->has_percent = true;
    out->percent_used = percent_used->valueint;
  }
}

// usage_client_poll() is not reentrant: the response buffer below is static
// (too large to put on a FreeRTOS task's stack) and shared across calls.
// This guard turns a concurrent second call into a clean failure instead of
// silent buffer corruption, in case a future caller (e.g. a manual-refresh
// button) is added alongside the main polling loop.
static volatile bool s_poll_in_progress = false;

static bool poll_locked(usage_snapshot_t *out) {
  static char buffer[USAGE_BUFFER_SIZE];

  esp_http_client_config_t config = {
      .url = CONFIG_USAGE_SERVICE_URL,
      .method = HTTP_METHOD_GET,
      .timeout_ms = 10000,
  };

  esp_http_client_handle_t client = esp_http_client_init(&config);
  esp_err_t err = esp_http_client_open(client, 0);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "failed to open connection to %s: %s",
             CONFIG_USAGE_SERVICE_URL, esp_err_to_name(err));
    esp_http_client_cleanup(client);
    return false;
  }

  esp_http_client_fetch_headers(client);

  int total_read = 0;
  int read_len;
  while (total_read < (int)sizeof(buffer) - 1 &&
         (read_len = esp_http_client_read(client, buffer + total_read,
                                           sizeof(buffer) - total_read - 1)) >
             0) {
    total_read += read_len;
  }
  buffer[total_read] = '\0';

  int status = esp_http_client_get_status_code(client);
  esp_http_client_close(client);
  esp_http_client_cleanup(client);

  if (status != 200) {
    ESP_LOGE(TAG, "usage service returned status %d", status);
    return false;
  }

  cJSON *root = cJSON_Parse(buffer);
  if (!root) {
    ESP_LOGE(TAG, "failed to parse usage JSON (%d bytes read)", total_read);
    return false;
  }

  cJSON *service = cJSON_GetObjectItem(root, "service");
  cJSON *service_status =
      service ? cJSON_GetObjectItem(service, "status") : NULL;
  out->degraded = cJSON_IsString(service_status) &&
                  strcmp(service_status->valuestring, "degraded") == 0;

  parse_window(cJSON_GetObjectItem(root, "session"), &out->session);
  parse_window(cJSON_GetObjectItem(root, "week"), &out->week);
  out->ok = true;

  cJSON_Delete(root);
  return true;
}

bool usage_client_poll(usage_snapshot_t *out) {
  memset(out, 0, sizeof(*out));

  if (s_poll_in_progress) {
    ESP_LOGE(TAG, "usage_client_poll() called re-entrantly - ignoring");
    return false;
  }
  s_poll_in_progress = true;

  bool ok = poll_locked(out);

  s_poll_in_progress = false;
  return ok;
}
