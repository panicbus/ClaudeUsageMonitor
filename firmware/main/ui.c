#include "ui.h"

#include <stdint.h>
#include <stdio.h>

#include "lvgl.h"

LV_FONT_DECLARE(fira_code_56);

#define SCREEN_W 368
#define SIDE_PAD 22
#define CONTENT_W (SCREEN_W - 2 * SIDE_PAD)
#define BAR_H 12

#define COLOR_BG lv_color_black()
#define COLOR_TEXT lv_color_white()
#define COLOR_MUTED lv_color_hex(0xB0B0B0)
#define COLOR_PILL lv_color_hex(0x2A2A2A)
#define COLOR_ACCENT lv_color_hex(0xFF6B35)
#define COLOR_OK lv_color_hex(0x4ADE80)
#define COLOR_WARN lv_color_hex(0xFACC15)
#define COLOR_DANGER lv_color_hex(0xEF4444)

// Pixel-art mascot, drawn from this pattern rather than an image asset so
// it lives in source and stays editable. 'X' = accent pixel, '.' = clear.
#define ROBOT_COLS 16
#define ROBOT_ROWS_N 11
#define ROBOT_SCALE 5
#define ROBOT_W (ROBOT_COLS * ROBOT_SCALE)
#define ROBOT_H (ROBOT_ROWS_N * ROBOT_SCALE)

// Eyes are '.' rather than a dark pixel - the screen behind is already
// black, so clearing those cells reads as eyes for free.
static const char *const ROBOT_ROWS[ROBOT_ROWS_N] = {
    "..XXXXXXXXXXXX..",
    "..XXXXXXXXXXXX..",
    "..XX.XXXXXX.XX..",
    "..XX.XXXXXX.XX..",
    "XXXXXXXXXXXXXXXX",
    "XXXXXXXXXXXXXXXX",
    "XXXXXXXXXXXXXXXX",
    "..XXXXXXXXXXXX..",
    "..XXXXXXXXXXXX..",
    "..XX.XX..XX.XX..",
    "..XX.XX..XX.XX..",
};

static uint32_t s_robot_pixels[ROBOT_W * ROBOT_H];
static lv_image_dsc_t s_robot_dsc;

// Degrees the color wave advances per animation tick, and how far behind
// (in degrees) each pixel-row lags the row above it - together these give
// a slow rainbow that visibly cascades from the top of the mascot downward
// rather than shifting all rows in lockstep.
#define ROBOT_ANIM_PERIOD_MS 150
#define ROBOT_ANIM_STEP_DEG 2
#define ROBOT_ANIM_ROW_LAG_DEG 18
static int s_robot_hue = 0;

typedef struct {
  lv_obj_t *percent;
  lv_obj_t *bar;
  lv_obj_t *reset;
} usage_row_t;

static lv_obj_t *s_status_label;
static lv_obj_t *s_battery_label;
static usage_row_t s_session_row;
static usage_row_t s_week_row;

static void format_duration(int minutes, char *buf, size_t buf_size) {
  if (minutes < 0) {
    snprintf(buf, buf_size, "--");
  } else if (minutes >= 24 * 60) {
    snprintf(buf, buf_size, "%dd %dh", minutes / (24 * 60),
              (minutes / 60) % 24);
  } else {
    snprintf(buf, buf_size, "%dh %dm", minutes / 60, minutes % 60);
  }
}

// Green below 50%, amber to 80%, red above - so status reads at a glance
// from across the desk without parsing the digits.
static lv_color_t color_for_percent(int percent) {
  if (percent >= 80) return COLOR_DANGER;
  if (percent >= 50) return COLOR_WARN;
  return COLOR_OK;
}

static lv_obj_t *make_label(lv_obj_t *parent, const lv_font_t *font,
                             lv_color_t color, const char *text) {
  lv_obj_t *label = lv_label_create(parent);
  lv_label_set_text(label, text);
  lv_obj_set_style_text_font(label, font, 0);
  lv_obj_set_style_text_color(label, color, 0);
  return label;
}

// Approximate HSV(hue, 100%, 100%) -> 0xAARRGGBB. Kept as plain integer
// math rather than pulling in a color-conversion library for one caller.
static uint32_t hue_to_argb(int hue_deg) {
  int h = ((hue_deg % 360) + 360) % 360;
  int region = h / 60;
  int remainder = (h % 60) * 255 / 60;
  uint8_t r, g, b;
  switch (region) {
    case 0: r = 255; g = remainder; b = 0; break;
    case 1: r = 255 - remainder; g = 255; b = 0; break;
    case 2: r = 0; g = 255; b = remainder; break;
    case 3: r = 0; g = 255 - remainder; b = 255; break;
    case 4: r = remainder; g = 0; b = 255; break;
    default: r = 255; g = 0; b = 255 - remainder; break;
  }
  return 0xFF000000u | ((uint32_t)r << 16) | ((uint32_t)g << 8) | b;
}

static void redraw_robot_pixels(void) {
  for (int y = 0; y < ROBOT_H; y++) {
    const int row = y / ROBOT_SCALE;
    const uint32_t color = hue_to_argb(s_robot_hue - row * ROBOT_ANIM_ROW_LAG_DEG);
    for (int x = 0; x < ROBOT_W; x++) {
      const char cell = ROBOT_ROWS[row][x / ROBOT_SCALE];
      s_robot_pixels[y * ROBOT_W + x] = (cell == 'X') ? color : 0u;
    }
  }
}

static void animate_robot(lv_timer_t *timer) {
  s_robot_hue = (s_robot_hue + ROBOT_ANIM_STEP_DEG) % 360;
  redraw_robot_pixels();
  lv_obj_invalidate((lv_obj_t *)lv_timer_get_user_data(timer));
}

static lv_obj_t *create_robot(lv_obj_t *parent) {
  redraw_robot_pixels();

  s_robot_dsc.header.magic = LV_IMAGE_HEADER_MAGIC;
  s_robot_dsc.header.cf = LV_COLOR_FORMAT_ARGB8888;
  s_robot_dsc.header.w = ROBOT_W;
  s_robot_dsc.header.h = ROBOT_H;
  s_robot_dsc.header.stride = ROBOT_W * 4;
  s_robot_dsc.data = (const uint8_t *)s_robot_pixels;
  s_robot_dsc.data_size = sizeof(s_robot_pixels);

  lv_obj_t *img = lv_image_create(parent);
  lv_image_set_src(img, &s_robot_dsc);
  lv_timer_create(animate_robot, ROBOT_ANIM_PERIOD_MS, img);
  return img;
}

// One usage row: big percentage on the left, a pill-shaped category label
// on the right, a proportional bar beneath, then the reset countdown.
static usage_row_t create_row(lv_obj_t *parent, const char *pill_text, int y) {
  usage_row_t row = {0};

  row.percent = make_label(parent, &lv_font_montserrat_48, COLOR_TEXT, "--");
  lv_obj_set_pos(row.percent, SIDE_PAD, y);

  lv_obj_t *pill = lv_obj_create(parent);
  lv_obj_set_size(pill, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
  lv_obj_set_style_bg_color(pill, COLOR_PILL, 0);
  lv_obj_set_style_bg_opa(pill, LV_OPA_COVER, 0);
  lv_obj_set_style_border_width(pill, 0, 0);
  lv_obj_set_style_radius(pill, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_pad_hor(pill, 14, 0);
  lv_obj_set_style_pad_ver(pill, 6, 0);
  lv_obj_t *pill_label =
      make_label(pill, &lv_font_montserrat_16, COLOR_TEXT, pill_text);
  lv_obj_center(pill_label);
  lv_obj_update_layout(pill);
  lv_obj_set_pos(pill, SCREEN_W - SIDE_PAD - lv_obj_get_width(pill), y + 14);

  row.bar = lv_bar_create(parent);
  lv_obj_set_size(row.bar, CONTENT_W, BAR_H);
  lv_obj_set_pos(row.bar, SIDE_PAD, y + 60);
  lv_bar_set_range(row.bar, 0, 100);
  lv_bar_set_value(row.bar, 0, LV_ANIM_OFF);
  lv_obj_set_style_radius(row.bar, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_bg_color(row.bar, COLOR_PILL, 0);
  lv_obj_set_style_bg_opa(row.bar, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(row.bar, LV_RADIUS_CIRCLE, LV_PART_INDICATOR);
  lv_obj_set_style_bg_color(row.bar, COLOR_OK, LV_PART_INDICATOR);
  lv_obj_set_style_bg_opa(row.bar, LV_OPA_COVER, LV_PART_INDICATOR);

  row.reset = make_label(parent, &lv_font_montserrat_32, COLOR_MUTED, "");
  lv_obj_set_pos(row.reset, SIDE_PAD, y + 78);

  return row;
}

void ui_init(void) {
  lv_obj_t *root = lv_scr_act();
  lv_obj_set_style_bg_color(root, COLOR_BG, 0);
  lv_obj_set_style_bg_opa(root, LV_OPA_COVER, 0);
  lv_obj_set_style_pad_all(root, 0, 0);
  lv_obj_clear_flag(root, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *title = make_label(root, &fira_code_56, COLOR_TEXT, "Usage");
  lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 18);

  lv_obj_t *robot = create_robot(root);
  lv_obj_set_pos(robot, 12, 26);

  // Empty until power_read_status() confirms a battery is actually present -
  // no icon at all is more honest than a fake one on a corded device.
  s_battery_label = make_label(root, &lv_font_montserrat_24, COLOR_TEXT, "");
  lv_obj_align(s_battery_label, LV_ALIGN_TOP_RIGHT, -SIDE_PAD, 44);

  s_session_row = create_row(root, "Current", 112);
  s_week_row = create_row(root, "Weekly", 248);

  s_status_label = make_label(root, &lv_font_montserrat_16, COLOR_ACCENT,
                               "* starting up...");
  lv_obj_align(s_status_label, LV_ALIGN_BOTTOM_MID, 0, -26);
}

static void update_row(usage_row_t *row, const usage_window_t *window) {
  // No active block means genuinely no session running anywhere right now
  // (ccusage reports zero blocks during a gap) - not an error, but a bare
  // "--" with no explanation reads as broken. Show 0% explicitly and say
  // why, instead of a blank that looks the same as "something's wrong."
  if (!window->present) {
    lv_label_set_text(row->percent, "0%");
    lv_bar_set_value(row->bar, 0, LV_ANIM_OFF);
    lv_obj_set_style_bg_color(row->bar, COLOR_OK, LV_PART_INDICATOR);
    lv_label_set_text(row->reset, "No active session");
    return;
  }

  if (window->has_percent) {
    lv_label_set_text_fmt(row->percent, "%d%%", window->percent_used);
    lv_bar_set_value(row->bar, window->percent_used, LV_ANIM_ON);
    lv_obj_set_style_bg_color(row->bar, color_for_percent(window->percent_used),
                               LV_PART_INDICATOR);
  } else {
    lv_label_set_text_fmt(row->percent, "%.1fM", window->tokens_used / 1e6);
    lv_bar_set_value(row->bar, 0, LV_ANIM_OFF);
  }

  char reset_buf[32];
  format_duration(window->minutes_remaining, reset_buf, sizeof(reset_buf));
  lv_label_set_text_fmt(row->reset, "Resets in %s", reset_buf);
}

void ui_update(const usage_snapshot_t *snapshot) {
  update_row(&s_session_row, &snapshot->session);
  update_row(&s_week_row, &snapshot->week);

  lv_label_set_text(s_status_label,
                     snapshot->degraded ? "* degraded" : "* connected");
  lv_obj_set_style_text_color(s_status_label, COLOR_ACCENT, 0);
  lv_obj_align(s_status_label, LV_ALIGN_BOTTOM_MID, 0, -26);
}

void ui_set_battery(bool present, int percent, bool charging) {
  if (!present) {
    lv_label_set_text(s_battery_label, "");
    return;
  }

  const char *icon;
  if (charging) {
    icon = LV_SYMBOL_CHARGE;
  } else if (percent >= 80) {
    icon = LV_SYMBOL_BATTERY_FULL;
  } else if (percent >= 55) {
    icon = LV_SYMBOL_BATTERY_3;
  } else if (percent >= 30) {
    icon = LV_SYMBOL_BATTERY_2;
  } else if (percent >= 10) {
    icon = LV_SYMBOL_BATTERY_1;
  } else {
    icon = LV_SYMBOL_BATTERY_EMPTY;
  }
  lv_label_set_text(s_battery_label, icon);
}

void ui_set_unreachable(int seconds_since_last_success) {
  if (seconds_since_last_success < 0) {
    lv_label_set_text(s_status_label, "* no signal");
  } else if (seconds_since_last_success < 60) {
    lv_label_set_text(s_status_label, "* no signal (just now)");
  } else {
    lv_label_set_text_fmt(s_status_label, "* no signal (%dm)",
                           seconds_since_last_success / 60);
  }
  lv_obj_set_style_text_color(s_status_label, COLOR_DANGER, 0);
  lv_obj_align(s_status_label, LV_ALIGN_BOTTOM_MID, 0, -26);
}
