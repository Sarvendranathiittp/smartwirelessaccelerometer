/**
 * @file dac8568.c
 * @brief DAC8568C SPI Driver — with ISR-safe write
 *
 * Adds dac8568_write_isr() for calling from GPTimer ISR context.
 * The bus is permanently acquired at init, so polling transmit is ISR-safe.
 */

#include "dac8568.h"

#include <math.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "soc/gpio_struct.h"

static const char *TAG = "dac8568";

#define PIN_SCLK 7
#define PIN_MOSI 9
#define PIN_CS 13

#define CMD_WRITE_UPDATE_N 0x3 /* Write to channel and update output */
#define CMD_INT_REF 0x8        /* Internal reference enable/disable */

static spi_device_handle_t spi_dev = NULL;

/* Pre-built SPI transaction — reused in ISR to avoid stack allocation */
static DRAM_ATTR spi_transaction_t isr_trans;
static DRAM_ATTR uint8_t isr_tx_buf[4];

static inline uint32_t build_frame(uint8_t cmd, uint8_t ch, uint16_t val) {
  return ((uint32_t)(cmd & 0x0F) << 24) | ((uint32_t)(ch & 0x0F) << 20) |
         ((uint32_t)val << 4);
}

static void dac_send(uint32_t frame) {
  uint8_t tx[4] = {
      (uint8_t)((frame >> 24) & 0xFF),
      (uint8_t)((frame >> 16) & 0xFF),
      (uint8_t)((frame >> 8) & 0xFF),
      (uint8_t)(frame & 0xFF),
  };
  spi_transaction_t t;
  memset(&t, 0, sizeof(t));
  t.length = 32;
  t.tx_buffer = tx;
  gpio_set_level(PIN_CS, 0);
  spi_device_polling_transmit(spi_dev, &t);
  gpio_set_level(PIN_CS, 1);
}

esp_err_t dac8568_init(void) {
  ESP_LOGI(TAG, "Init: SCLK=%d MOSI=%d CS=%d", PIN_SCLK, PIN_MOSI, PIN_CS);

  gpio_config_t cs_cfg = {
      .pin_bit_mask = (1ULL << PIN_CS),
      .mode = GPIO_MODE_OUTPUT,
      .pull_up_en = GPIO_PULLUP_DISABLE,
      .pull_down_en = GPIO_PULLDOWN_DISABLE,
      .intr_type = GPIO_INTR_DISABLE,
  };
  gpio_config(&cs_cfg);
  gpio_set_level(PIN_CS, 1);

  spi_bus_config_t buscfg = {
      .mosi_io_num = PIN_MOSI,
      .miso_io_num = -1,
      .sclk_io_num = PIN_SCLK,
      .quadwp_io_num = -1,
      .quadhd_io_num = -1,
      .max_transfer_sz = 4,
  };
  esp_err_t ret = spi_bus_initialize(SPI2_HOST, &buscfg, SPI_DMA_DISABLED);
  if (ret != ESP_OK)
    return ret;

  spi_device_interface_config_t devcfg = {
      .clock_speed_hz =
          4 * 1000 * 1000, /* 4 MHz — needed for 10kHz ISR (3ch × 8µs = 24µs) */
      .mode = 1,
      .spics_io_num = -1,
      .queue_size = 1,
  };
  ret = spi_bus_add_device(SPI2_HOST, &devcfg, &spi_dev);
  if (ret != ESP_OK)
    return ret;

  /* Permanently acquire bus — required for ISR-safe polling transmit */
  ret = spi_device_acquire_bus(spi_dev, portMAX_DELAY);
  if (ret != ESP_OK)
    return ret;

  /* Prepare reusable ISR transaction */
  memset(&isr_trans, 0, sizeof(isr_trans));
  isr_trans.length = 32;
  isr_trans.tx_buffer = isr_tx_buf;

  ESP_LOGI(TAG, "SPI ready (1MHz Mode1, bus acquired for ISR use)");

  /* Enable internal reference (static mode, powers up 2.5V ref)
   * DAC8568C has built-in 2× output gain: Vout = 2 × VREF × D/65536
   * With 2.5V ref → output range 0-5V, but clipped by AVDD (~3.3V)
   * The AC coupling in playback.c centers the signal safely. */
  dac_send(0x08000001);
  vTaskDelay(pdMS_TO_TICKS(10));
  ESP_LOGI(TAG, "Internal reference enabled (2.5V, 2× gain → 0-5V range)");

  /* Set mid-scale (1.25V) as default output */
  dac_send(build_frame(CMD_WRITE_UPDATE_N, 0, 0x8000));
  vTaskDelay(pdMS_TO_TICKS(10));

  ESP_LOGW(TAG, "DAC8568 initialized — ISR-safe writes enabled");
  return ESP_OK;
}

void dac8568_write_channel(uint8_t channel, uint16_t code) {
  dac_send(build_frame(CMD_WRITE_UPDATE_N, channel & 0x07, code));
}

/**
 * ISR-safe DAC write — called directly from GPTimer ISR.
 * Uses pre-allocated DRAM buffers, no heap, no RTOS calls.
 * Bus is pre-acquired so spi_device_polling_transmit is safe.
 */
void IRAM_ATTR dac8568_write_isr(uint8_t channel, uint16_t code) {
  uint32_t frame = ((uint32_t)0x3 << 24) | ((uint32_t)(channel & 0x07) << 20) |
                   ((uint32_t)code << 4);

  isr_tx_buf[0] = (uint8_t)((frame >> 24) & 0xFF);
  isr_tx_buf[1] = (uint8_t)((frame >> 16) & 0xFF);
  isr_tx_buf[2] = (uint8_t)((frame >> 8) & 0xFF);
  isr_tx_buf[3] = (uint8_t)(frame & 0xFF);

  gpio_set_level(PIN_CS, 0);
  spi_device_polling_transmit(spi_dev, &isr_trans);
  gpio_set_level(PIN_CS, 1);
}
