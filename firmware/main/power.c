#include "power.h"

#include "bsp/esp-bsp.h"
#include "driver/i2c_master.h"
#include "esp_log.h"

// Register map verified against lewisxhe/XPowersLib's XPowersAXP2101.hpp -
// not guessed, since getting a status register wrong on a PMU is the kind
// of mistake worth being careful about.
#define AXP2101_I2C_ADDR 0x34
#define AXP2101_REG_STATUS1 0x00        // bit 3: battery connected
#define AXP2101_REG_STATUS2 0x01        // bits [7:5]: 0x01=charging, 0x02=discharging
#define AXP2101_REG_BAT_PERCENT 0xA4    // 0-100, only valid if battery connected
#define AXP2101_BATTERY_CONNECTED_BIT (1 << 3)

static const char *TAG = "power";

static esp_err_t read_register(i2c_master_dev_handle_t dev, uint8_t reg,
                                uint8_t *out_value) {
  return i2c_master_transmit_receive(dev, &reg, 1, out_value, 1, 1000);
}

bool power_read_status(power_status_t *out) {
  out->battery_present = false;
  out->percent = 0;
  out->charging = false;

  i2c_master_bus_handle_t bus = bsp_i2c_get_handle();
  if (!bus) {
    ESP_LOGW(TAG, "no I2C bus handle available");
    return false;
  }

  i2c_device_config_t dev_config = {
      .dev_addr_length = I2C_ADDR_BIT_LEN_7,
      .device_address = AXP2101_I2C_ADDR,
      .scl_speed_hz = 100000,
  };
  i2c_master_dev_handle_t dev = NULL;
  if (i2c_master_bus_add_device(bus, &dev_config, &dev) != ESP_OK) {
    ESP_LOGW(TAG, "failed to register AXP2101 I2C device");
    return false;
  }

  uint8_t status1 = 0;
  esp_err_t err = read_register(dev, AXP2101_REG_STATUS1, &status1);
  if (err != ESP_OK) {
    ESP_LOGW(TAG, "AXP2101 did not respond on the I2C bus: %s",
             esp_err_to_name(err));
    i2c_master_bus_rm_device(dev);
    return false;
  }

  out->battery_present = (status1 & AXP2101_BATTERY_CONNECTED_BIT) != 0;

  if (out->battery_present) {
    uint8_t status2 = 0;
    if (read_register(dev, AXP2101_REG_STATUS2, &status2) == ESP_OK) {
      out->charging = ((status2 >> 5) & 0x07) == 0x01;
    }

    uint8_t percent = 0;
    if (read_register(dev, AXP2101_REG_BAT_PERCENT, &percent) == ESP_OK) {
      out->percent = percent;
    }
  }

  i2c_master_bus_rm_device(dev);
  return true;
}
