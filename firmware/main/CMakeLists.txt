idf_component_register(SRCS "main.c" "wifi.c" "usage_client.c" "ui.c" "power.c" "fira_code_56.c"
                        INCLUDE_DIRS "."
                        REQUIRES esp_wifi esp_event nvs_flash esp_netif esp_http_client json
                                  esp32_s3_touch_amoled_1_8 lvgl__lvgl esp_driver_i2c esp_timer)

idf_build_get_property(build_components BUILD_COMPONENTS)
if("lvgl__lvgl" IN_LIST build_components)
    idf_component_get_property(LVGL_LIB lvgl__lvgl COMPONENT_LIB)
    if(TARGET ${LVGL_LIB})
        target_compile_options(${LVGL_LIB} PRIVATE -Wno-error=attributes)
    endif()
endif()
