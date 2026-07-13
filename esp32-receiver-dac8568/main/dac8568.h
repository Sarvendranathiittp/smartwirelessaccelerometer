/**
 * @file dac8568.h
 * @brief DAC8568C SPI Driver — ISR-safe write
 *
 * Hardware: ESP32-S3-Zero → DAC8568C EVM (SLAU301)
 * Pins: SCLK=GPIO7, MOSI=GPIO9, CS=GPIO13 (software /SYNC)
 * SPI Mode 1 (CPOL=0, CPHA=1), 1 MHz
 * Internal reference enabled (2.5V), full range 0x0000–0xFFFF
 * EVM: JP2 SHORTED (LDAC=GND), JP3 pins 1-2 (REF5025)
 */

#pragma once

#include "esp_err.h"
#include <stdint.h>

/**
 * @brief Initialize SPI bus and DAC8568 (software reset, no internal ref)
 * @return ESP_OK on success
 */
esp_err_t dac8568_init(void);

/**
 * @brief Write a 16-bit code to a DAC channel (task context)
 */
void dac8568_write_channel(uint8_t channel, uint16_t code);

/**
 * @brief ISR-safe write — callable from GPTimer ISR
 * @note Bus must be pre-acquired via dac8568_init()
 */
void dac8568_write_isr(uint8_t channel, uint16_t code);
