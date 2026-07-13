#include "dac7578.h"
#include "driver/i2c.h"
#include "esp_log.h"

static const char *TAG = "dac7578";

esp_err_t dac7578_init(void) {
    i2c_config_t conf = {
        .mode = I2C_MODE_MASTER,
        .sda_io_num = DAC7578_I2C_SDA,
        .sda_pullup_en = GPIO_PULLUP_ENABLE,
        .scl_io_num = DAC7578_I2C_SCL,
        .scl_pullup_en = GPIO_PULLUP_ENABLE,
        .master.clk_speed = 1000000, // 1 MHz clock speed
        .clk_flags = 0
    };
    esp_err_t err = i2c_param_config(DAC7578_I2C_PORT, &conf);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "I2C param config failed: %s", esp_err_to_name(err));
        return err;
    }
    err = i2c_driver_install(DAC7578_I2C_PORT, conf.mode, 0, 0, 0);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "I2C driver install failed: %s", esp_err_to_name(err));
        return err;
    }
    ESP_LOGI(TAG, "DAC7578 initialized successfully on SDA=GPIO%d, SCL=GPIO%d at 1MHz",
             DAC7578_I2C_SDA, DAC7578_I2C_SCL);
    return ESP_OK;
}

esp_err_t dac7578_write(uint8_t channel, uint16_t value) {
    value &= 0x0FFF;
    uint8_t data[2];
    data[0] = (uint8_t)(value >> 4);
    data[1] = (uint8_t)((value & 0x0F) << 4);

    i2c_cmd_handle_t cmd = i2c_cmd_link_create();
    i2c_master_start(cmd);
    i2c_master_write_byte(cmd, (DAC7578_ADDR << 1) | I2C_MASTER_WRITE, true);
    i2c_master_write_byte(cmd, channel, true);
    i2c_master_write(cmd, data, 2, true);
    i2c_master_stop(cmd);

    esp_err_t ret = i2c_master_cmd_begin(DAC7578_I2C_PORT, cmd, pdMS_TO_TICKS(10));
    i2c_cmd_link_delete(cmd);
    return ret;
}
