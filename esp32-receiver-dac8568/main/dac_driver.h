#ifndef DAC_DRIVER_H
#define DAC_DRIVER_H

#include "esp_err.h"
#include <stdint.h>

/**
 * @brief Initializes the I2C Master and configures the DAC7578 interface.
 * Note: Includes an automatic I2C scan to find the DAC's exact address.
 */
esp_err_t dac_driver_init(void);

/**
 * @brief Converts raw MPU6050 accelerometer counts (+/- 16g)
 *        into DAC7578 values (12-bit, 0 - 4095)
 *        and writes them sequentially via I2C to channels X, Y, Z (A, B, C).
 *
 * @param x_raw Raw X-axis accelerometer data from MPU6050
 * @param y_raw Raw Y-axis accelerometer data from MPU6050
 * @param z_raw Raw Z-axis accelerometer data from MPU6050
 */
void dac_write_xyz(int16_t x_raw, int16_t y_raw, int16_t z_raw);

#endif // DAC_DRIVER_H
