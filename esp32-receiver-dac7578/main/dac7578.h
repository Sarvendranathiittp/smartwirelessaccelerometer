#ifndef DAC7578_H
#define DAC7578_H

#include "esp_err.h"
#include <stdint.h>

// ================= DAC7578 Address & Channels =================
#define DAC7578_ADDR        0x4C
#define DAC7578_CH_X        0x30
#define DAC7578_CH_Y        0x31
#define DAC7578_CH_Z        0x32
#define DAC7578_MAX         4095

// ================= I2C Pin Setup =================
#define DAC7578_I2C_SDA     1
#define DAC7578_I2C_SCL     2
#define DAC7578_I2C_PORT    0

/**
 * @brief Initialize I2C driver for the DAC7578.
 * Configures SDA=GPIO1, SCL=GPIO2, Port=0, 1 MHz clock speed.
 */
esp_err_t dac7578_init(void);

/**
 * @brief Write 12-bit code to a DAC7578 channel.
 * @param channel Reg/channel identifier (e.g. 0x30, 0x31, 0x32)
 * @param value   12-bit value (0 - 4095)
 */
esp_err_t dac7578_write(uint8_t channel, uint16_t value);

#endif // DAC7578_H
