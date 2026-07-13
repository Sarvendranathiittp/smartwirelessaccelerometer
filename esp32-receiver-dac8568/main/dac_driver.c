#include "dac_driver.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <math.h>
#include <string.h>

static const char *TAG = "DAC8568C";

#define PIN_MOSI 11
#define PIN_SCLK 12
#define PIN_CS 10

static spi_device_handle_t spi_dev = NULL;

static esp_err_t spi_init(int mode) {
  /* If already initialized, clean up first */
  if (spi_dev) {
    spi_bus_remove_device(spi_dev);
    spi_dev = NULL;
    spi_bus_free(SPI2_HOST);
  }

  spi_bus_config_t bus = {
      .mosi_io_num = PIN_MOSI,
      .miso_io_num = -1,
      .sclk_io_num = PIN_SCLK,
      .quadwp_io_num = -1,
      .quadhd_io_num = -1,
      .max_transfer_sz = 4,
  };
  esp_err_t ret = spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_DISABLED);
  if (ret != ESP_OK)
    return ret;

  spi_device_interface_config_t dev = {
      .clock_speed_hz = 500000, /* 500 kHz — very slow */
      .mode = mode,
      .spics_io_num = PIN_CS,
      .queue_size = 1,
  };
  return spi_bus_add_device(SPI2_HOST, &dev, &spi_dev);
}

static esp_err_t dac_send(uint32_t cmd) {
  uint8_t tx[4] = {
      (cmd >> 24) & 0xFF,
      (cmd >> 16) & 0xFF,
      (cmd >> 8) & 0xFF,
      cmd & 0xFF,
  };
  spi_transaction_t t = {0};
  t.length = 32;
  t.tx_buffer = tx;
  return spi_device_polling_transmit(spi_dev, &t);
}

static void test_dc_all_channels(uint16_t value) {
  for (int ch = 0; ch < 8; ch++) {
    uint32_t cmd = ((uint32_t)0x03 << 24) | ((uint32_t)(ch & 0x07) << 20) |
                   ((uint32_t)value << 4);
    dac_send(cmd);
    esp_rom_delay_us(100);
  }
}

esp_err_t dac_driver_init(void) {
  ESP_LOGW(TAG, "========================================");
  ESP_LOGW(TAG, "  DAC8568C MULTI-MODE SPI TEST");
  ESP_LOGW(TAG, "  MOSI=%d, SCLK=%d, CS=%d", PIN_MOSI, PIN_SCLK, PIN_CS);
  ESP_LOGW(TAG, "========================================");

  for (int mode = 0; mode < 4; mode++) {
    ESP_LOGW(TAG, "");
    ESP_LOGW(TAG, "===== SPI MODE %d =====", mode);

    esp_err_t ret = spi_init(mode);
    if (ret != ESP_OK) {
      ESP_LOGE(TAG, "SPI init FAILED for mode %d: %s", mode,
               esp_err_to_name(ret));
      continue;
    }
    ESP_LOGI(TAG, "SPI Mode %d initialized OK", mode);

    /* Enable internal reference (DAC8568C has it on by default, but just in
     * case) */
    dac_send(0x08000001);
    vTaskDelay(pdMS_TO_TICKS(50));

    /* Write FULL SCALE */
    ESP_LOGW(TAG, "  Mode %d: FULL SCALE (0xFFFF) → expect ~2.5V, 10 sec",
             mode);
    test_dc_all_channels(0xFFFF);
    vTaskDelay(pdMS_TO_TICKS(10000));

    /* Write ZERO */
    ESP_LOGW(TAG, "  Mode %d: ZERO (0x0000) → expect ~0V, 10 sec", mode);
    test_dc_all_channels(0x0000);
    vTaskDelay(pdMS_TO_TICKS(10000));

    /* Write MID */
    ESP_LOGW(TAG, "  Mode %d: MID (0x8000) → expect ~1.25V, 10 sec", mode);
    test_dc_all_channels(0x8000);
    vTaskDelay(pdMS_TO_TICKS(10000));
  }

  ESP_LOGW(TAG, "All 4 modes tested. Restarting from Mode 0...");

  /* Loop forever with Mode 0 sine wave */
  spi_init(0);
  dac_send(0x08000001);
  vTaskDelay(pdMS_TO_TICKS(50));

  uint16_t sine[100];
  for (int i = 0; i < 100; i++) {
    float r = i * 2.0f * M_PI / 100.0f;
    sine[i] = (uint16_t)(((sinf(r) + 1.0f) / 2.0f) * 65535.0f);
  }

  while (1) {
    for (int i = 0; i < 100; i++) {
      uint32_t cmd = (0x03 << 24) | ((uint32_t)sine[i] << 4);
      dac_send(cmd);
      vTaskDelay(pdMS_TO_TICKS(1));
    }
  }
  return ESP_OK;
}

void dac_write_xyz(int16_t x, int16_t y, int16_t z) {}
