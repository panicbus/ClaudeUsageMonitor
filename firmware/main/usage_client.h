#pragma once

#include <stdbool.h>

typedef struct {
  bool present;           // false if this window was null in the response
  double tokens_used;
  bool has_percent;       // false if percentUsed was null (no limit configured)
  int percent_used;
  int minutes_remaining;
} usage_window_t;

typedef struct {
  bool ok;                 // false if the fetch/parse itself failed
  bool degraded;           // true if service.status == "degraded"
  usage_window_t session;
  usage_window_t week;
} usage_snapshot_t;

// Fetches GET <CONFIG_USAGE_SERVICE_URL> and parses the UsageResponse JSON
// into `out`. Returns false (and leaves out->ok = false) on any network,
// HTTP-status, or JSON-parse failure - never aborts.
bool usage_client_poll(usage_snapshot_t *out);
