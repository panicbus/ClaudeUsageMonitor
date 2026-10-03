# Third-party notices

This project's own code is MIT-licensed (see [LICENSE](LICENSE)). It also
includes or depends on the following.

## Included in this repository

| Component | License | Where |
|---|---|---|
| [Fira Code](https://github.com/tonsky/FiraCode) SemiBold, converted to an LVGL bitmap font with `lv_font_conv` | SIL Open Font License 1.1 | `firmware/main/fira_code_56.c` - full license in [licenses/OFL-FiraCode.txt](licenses/OFL-FiraCode.txt) |

## Fetched at install/build time (not stored in this repository)

| Component | License | Fetched by |
|---|---|---|
| [ccusage](https://github.com/ryoppippi/ccusage) | MIT | `npm install` |
| [LVGL](https://github.com/lvgl/lvgl), including its built-in Montserrat fonts (OFL 1.1) | MIT | `idf.py` component manager |
| [Waveshare ESP32-S3-Touch-AMOLED-1.8 BSP](https://components.espressif.com/components/waveshare/esp32_s3_touch_amoled_1_8) | Apache-2.0 | `idf.py` component manager |
| Espressif components (`esp_lvgl_port`, `esp_lcd_co5300`, `esp_lcd_touch_*`, `esp_io_expander*`, `mdns`, …) | Apache-2.0 | `idf.py` component manager |
| [ESP-IDF](https://github.com/espressif/esp-idf) | Apache-2.0 | installed separately |

"Claude" and "Claude Code" are trademarks of Anthropic. This is an
independent hobby project, not affiliated with or endorsed by Anthropic.
