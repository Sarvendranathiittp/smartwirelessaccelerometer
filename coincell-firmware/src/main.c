/**
 * @file main.c
 * @brief Coin-Cell Wireless Accelerometer Firmware
 *
 * Architecture: Rev 23 - H3LIS331DL + RTC2 LFCLK PIPELINE
 *
 * Sensor: ST H3LIS331DL (3-axis, up to ±400g, SPI @ 1 MHz)
 * Timer:  NRF_RTC2 hardware ISR at exactly 1024.0 Hz (LFCLK-driven)
 *
 * Low power design:
 *   - H3LIS331DL in power-down when idle (~1 µA)
 *   - H3LIS331DL in normal mode at 1000 Hz during streaming (~300 µA)
 *   - NRF_RTC2 runs on LFCLK (32.768 kHz) — HFCLK stays off between SPI reads
 *   - SPI PM_DEVICE_RUNTIME auto-suspends the SPIM3 peripheral between reads
 *   - Dynamic BLE connection intervals (fast when streaming, slow when idle)
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/drivers/spi.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/sys/crc.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/settings/settings.h>
#include <zephyr/irq.h>
#include <string.h>
#include <zephyr/drivers/adc.h>
#include <zephyr/bluetooth/services/bas.h>
#include <hal/nrf_saadc.h>
#include <zephyr/dt-bindings/adc/nrf-saadc.h>

#include <hal/nrf_rtc.h>
#include <hal/nrf_timer.h>

#include "accel_service.h"

LOG_MODULE_REGISTER(main, LOG_LEVEL_INF);

/* Forward Declarations */
static void h3lis331dl_sleep(void);
static void h3lis331dl_wake_and_configure(void);

/*============================================================================
 * H3LIS331DL Register Map
 *
 * Datasheet: https://www.st.com/resource/en/datasheet/h3lis331dl.pdf
 *===========================================================================*/

/* I2C address: 0x18 when SA0=LOW (GND), 0x19 when SA0=HIGH (VDD) */
#define H3LIS331DL_ADDR        0x18

#define H3LIS331DL_WHO_AM_I    0x0F  /* Expected value: 0x32 */
#define H3LIS331DL_CTRL_REG1   0x20
#define H3LIS331DL_CTRL_REG2   0x21
#define H3LIS331DL_CTRL_REG3   0x22
#define H3LIS331DL_CTRL_REG4   0x23
#define H3LIS331DL_STATUS_REG  0x27
#define H3LIS331DL_OUT_X_L     0x28  /* 0x28..0x2D = X_L,X_H,Y_L,Y_H,Z_L,Z_H */

/*
 * CTRL_REG1 encoding:
 *   [PM2:PM0] Power mode: 000=power-down, 001=normal, 010-111=low-power
 *   [DR1:DR0] Data rate (when PM=001):
 *             00=50Hz, 01=100Hz, 10=400Hz, 11=1000Hz
 *   [ZEN][YEN][XEN] Axis enables
 *
 * 1000 Hz, Normal mode, all axes on:
 *   PM=001, DR=11, ZEN=1, YEN=1, XEN=1
 *   = 0b00111111 = 0x3F
 *
 * Power-down: 0x00
 */
#define H3LIS331DL_CTRL_REG1_ODR_1KHZ   0x3F  /* Normal, 1000 Hz, XYZ on */
#define H3LIS331DL_CTRL_REG1_POWER_DOWN 0x00

/*
 * CTRL_REG4 encoding:
 *   [BDU] Block Data Update: 0=continuous, 1=until read (we use 0 for speed)
 *   [FS1:FS0] Full scale:
 *             00=±100g (49 mg/LSB), 01=±200g (98 mg/LSB), 11=±400g (195 mg/LSB)
 *
 * ±100g, BDU=0: 0x00
 * ±200g, BDU=0: 0x10
 * ±400g, BDU=0: 0x30
 */
#define H3LIS331DL_CTRL_REG4_FS_100G    0x00  /* ±100g, 49 mg/LSB */
#define H3LIS331DL_CTRL_REG4_FS_200G    0x10  /* ±200g, 98 mg/LSB */
#define H3LIS331DL_CTRL_REG4_FS_400G    0x30  /* ±400g, 195 mg/LSB */

/*
 * STATUS_REG bit 3 = ZYXDA (all-axes data available)
 * Clear automatically when OUT registers are read.
 */
#define H3LIS331DL_STATUS_ZYXDA  BIT(3)



/*
 * SPI Protocol Specifics
 * Read bit is Bit 7 (0x80). Auto-increment bit is Bit 6 (0x40).
 * Data format: little-endian (LOW byte first, HIGH byte second)
 */
#define H3LIS331DL_SPI_READ_BIT       0x80
#define H3LIS331DL_SPI_AUTO_INCR_BIT  0x40
#define H3LIS331DL_OUT_X_L_MULTI      (H3LIS331DL_OUT_X_L | H3LIS331DL_SPI_READ_BIT | H3LIS331DL_SPI_AUTO_INCR_BIT)

/*============================================================================
 * Hardware & State
 *===========================================================================*/

#include <zephyr/drivers/spi.h>
static const struct spi_dt_spec spi_dev = SPI_DT_SPEC_GET(
    DT_NODELABEL(h3lis331dl), 
    SPI_OP_MODE_MASTER | SPI_MODE_CPOL | SPI_MODE_CPHA | SPI_WORD_SET(8) | SPI_TRANSFER_MSB, 
    2);

static uint32_t total_samples   = 0;
static uint32_t packets_sent    = 0;
static uint32_t packets_dropped = 0;
static volatile uint32_t packet_counter  = 0;
static volatile uint32_t burst_start_ms  = 0;
static volatile bool     streaming_active = false;
/* Indexing variables managed locally by playout buffer */

/*============================================================================
 * Dual Sample Timer — RTC0 (1024 Hz) or TIMER1 (2-5 kHz)
 *
 * RTC0:   32.768 kHz LFCLK, CC[0]=32 → 1024 Hz exactly. Ultra-low-power.
 * TIMER1: 16 MHz HFCLK, CC[0]=16M/rate → 2000-5000 Hz. Higher power.
 *
 * The active timer is selected by accel_service_use_hf_timer().
 *===========================================================================*/

static K_SEM_DEFINE(sample_sem, 0, 1);
static bool using_hf_timer = false; /* tracks which timer is currently active */

/* ---- RTC0 ISR (1024 Hz, LFCLK-driven) ---- */
static void rtc0_isr(const void *arg) {
  ARG_UNUSED(arg);
  if (nrf_rtc_event_check(NRF_RTC0, NRF_RTC_EVENT_COMPARE_0)) {
    nrf_rtc_event_clear(NRF_RTC0, NRF_RTC_EVENT_COMPARE_0);
    (void)nrf_rtc_event_check(NRF_RTC0, NRF_RTC_EVENT_COMPARE_0);

    uint32_t interval = accel_service_get_rtc_tick_interval();
    uint32_t cc = nrf_rtc_cc_get(NRF_RTC0, 0);
    uint32_t new_cc = (cc + interval) & 0x00FFFFFF;
    uint32_t cnt = nrf_rtc_counter_get(NRF_RTC0);

    uint32_t diff = (new_cc - cnt) & 0x00FFFFFF;
    if (diff > 0x800000) {
      new_cc = (cnt + 2) & 0x00FFFFFF;
    }

    nrf_rtc_cc_set(NRF_RTC0, 0, new_cc);
    k_sem_give(&sample_sem);
  }
}

/* ---- TIMER1 ISR (2-5 kHz, HFCLK-driven) ---- */
static void timer1_isr(const void *arg) {
  ARG_UNUSED(arg);
  if (nrf_timer_event_check(NRF_TIMER1, NRF_TIMER_EVENT_COMPARE0)) {
    nrf_timer_event_clear(NRF_TIMER1, NRF_TIMER_EVENT_COMPARE0);
    k_sem_give(&sample_sem);
  }
}

static void start_rtc0_timer(void) {
  nrf_rtc_task_trigger(NRF_RTC0, NRF_RTC_TASK_STOP);
  nrf_rtc_task_trigger(NRF_RTC0, NRF_RTC_TASK_CLEAR);
  nrf_rtc_prescaler_set(NRF_RTC0, 0);

  uint32_t interval = accel_service_get_rtc_tick_interval();
  nrf_rtc_cc_set(NRF_RTC0, 0, interval);
  nrf_rtc_int_enable(NRF_RTC0, NRF_RTC_INT_COMPARE0_MASK);
  nrf_rtc_event_clear(NRF_RTC0, NRF_RTC_EVENT_COMPARE_0);

  IRQ_CONNECT(NRFX_IRQ_NUMBER_GET(NRF_RTC0), 1, rtc0_isr, NULL, 0);
  irq_enable(NRFX_IRQ_NUMBER_GET(NRF_RTC0));
  nrf_rtc_task_trigger(NRF_RTC0, NRF_RTC_TASK_START);
}

static void stop_rtc0_timer(void) {
  nrf_rtc_task_trigger(NRF_RTC0, NRF_RTC_TASK_STOP);
  nrf_rtc_int_disable(NRF_RTC0, NRF_RTC_INT_COMPARE0_MASK);
  irq_disable(NRFX_IRQ_NUMBER_GET(NRF_RTC0));
}

static void start_timer1(void) {
  nrf_timer_task_trigger(NRF_TIMER1, NRF_TIMER_TASK_STOP);
  nrf_timer_task_trigger(NRF_TIMER1, NRF_TIMER_TASK_CLEAR);

  /* 16 MHz (prescaler=0), 32-bit mode, auto-clear on CC[0] match (shortcut) */
  nrf_timer_mode_set(NRF_TIMER1, NRF_TIMER_MODE_TIMER);
  nrf_timer_bit_width_set(NRF_TIMER1, NRF_TIMER_BIT_WIDTH_32);
  nrf_timer_prescaler_set(NRF_TIMER1, 0); /* prescaler 0 = 16 MHz */

  uint32_t interval = accel_service_get_timer1_interval();
  nrf_timer_cc_set(NRF_TIMER1, NRF_TIMER_CC_CHANNEL0, interval);

  /* Enable COMPARE0 → CLEAR shortcut for periodic interrupts */
  nrf_timer_shorts_enable(NRF_TIMER1, NRF_TIMER_SHORT_COMPARE0_CLEAR_MASK);

  nrf_timer_int_enable(NRF_TIMER1, NRF_TIMER_INT_COMPARE0_MASK);
  nrf_timer_event_clear(NRF_TIMER1, NRF_TIMER_EVENT_COMPARE0);

  IRQ_CONNECT(NRFX_IRQ_NUMBER_GET(NRF_TIMER1), 1, timer1_isr, NULL, 0);
  irq_enable(NRFX_IRQ_NUMBER_GET(NRF_TIMER1));
  nrf_timer_task_trigger(NRF_TIMER1, NRF_TIMER_TASK_START);
}

static void stop_timer1(void) {
  nrf_timer_task_trigger(NRF_TIMER1, NRF_TIMER_TASK_STOP);
  nrf_timer_int_disable(NRF_TIMER1, NRF_TIMER_INT_COMPARE0_MASK);
  nrf_timer_shorts_disable(NRF_TIMER1, NRF_TIMER_SHORT_COMPARE0_CLEAR_MASK);
  irq_disable(NRFX_IRQ_NUMBER_GET(NRF_TIMER1));
}

static void start_sample_timer(void) {
  if (accel_service_use_hf_timer()) {
    start_timer1();
    using_hf_timer = true;
    LOG_INF("Started TIMER1 (16 MHz) for %u Hz sampling",
            accel_service_get_sampling_rate());
  } else {
    start_rtc0_timer();
    using_hf_timer = false;
    LOG_INF("Started RTC0 (32 kHz) for %u Hz sampling",
            accel_service_get_sampling_rate());
  }
}

static void stop_sample_timer(void) {
  if (using_hf_timer) {
    stop_timer1();
  } else {
    stop_rtc0_timer();
  }
  k_sem_reset(&sample_sem);
}

void accel_service_restart_timer(void) {
  if (streaming_active) {
    stop_sample_timer();
    start_sample_timer();
    LOG_INF("Sample timer restarted for %u Hz",
            accel_service_get_sampling_rate());
  }
}

/*============================================================================
 * ADXL345 Driver — Direct Raw SPI (No Zephyr Sensor API Overhead)
 *===========================================================================*/

#define ADXL345_REG_DEVID       0x00
#define ADXL345_REG_BW_RATE     0x2C
#define ADXL345_REG_POWER_CTL   0x2D
#define ADXL345_REG_DATA_FORMAT 0x31
#define ADXL345_REG_DATAX0      0x32

static const struct spi_dt_spec spi_adxl = SPI_DT_SPEC_GET(
    DT_NODELABEL(adxl345), 
    SPI_OP_MODE_MASTER | SPI_MODE_CPOL | SPI_MODE_CPHA | SPI_WORD_SET(8) | SPI_TRANSFER_MSB, 
    0);

static uint16_t current_sensor_range_g = 400; // Default: ±400g
static bool adxl_detected = false;

static int adxl345_write_reg(uint8_t reg, uint8_t value) {
  uint8_t tx_buf[2] = {reg & 0x3F, value}; // Bit 7 is 0 for write
  const struct spi_buf tx = {.buf = tx_buf, .len = 2};
  const struct spi_buf_set tx_set = {.buffers = &tx, .count = 1};
  return spi_write_dt(&spi_adxl, &tx_set);
}

static int adxl345_read_reg(uint8_t reg, uint8_t *value) {
  uint8_t tx_buf[2] = {reg | 0x80, 0}; // Bit 7 is 1 for read
  const struct spi_buf tx = {.buf = tx_buf, .len = 2};
  const struct spi_buf_set tx_set = {.buffers = &tx, .count = 1};
  
  uint8_t rx_buf[2];
  const struct spi_buf rx = {.buf = rx_buf, .len = 2};
  const struct spi_buf_set rx_set = {.buffers = &rx, .count = 1};
  
  int ret = spi_transceive_dt(&spi_adxl, &tx_set, &rx_set);
  if (ret == 0) {
    *value = rx_buf[1];
  }
  return ret;
}

static int adxl345_read_accel_raw(int16_t *ax, int16_t *ay, int16_t *az) {
  // Multi-byte read: Bit 7 is 1 (read), Bit 6 is 1 (multi-byte)
  uint8_t tx_buf[7] = {ADXL345_REG_DATAX0 | 0x80 | 0x40, 0, 0, 0, 0, 0, 0};
  const struct spi_buf tx = {.buf = tx_buf, .len = 7};
  const struct spi_buf_set tx_set = {.buffers = &tx, .count = 1};
  
  uint8_t rx_buf[7];
  const struct spi_buf rx = {.buf = rx_buf, .len = 7};
  const struct spi_buf_set rx_set = {.buffers = &rx, .count = 1};
  
  int ret = spi_transceive_dt(&spi_adxl, &tx_set, &rx_set);
  if (ret == 0) {
    /* rx_buf[0] is dummy data from address transmission */
    *ax = (int16_t)(rx_buf[1] | (rx_buf[2] << 8));
    *ay = (int16_t)(rx_buf[3] | (rx_buf[4] << 8));
    *az = (int16_t)(rx_buf[5] | (rx_buf[6] << 8));
  }
  return ret;
}

static int adxl345_sleep(void) {
  LOG_INF("ADXL345 → sleep mode");
  return adxl345_write_reg(ADXL345_REG_POWER_CTL, 0x00); // Standby mode
}

static int adxl345_wake_and_configure(void) {
  int ret;
  ret = adxl345_write_reg(ADXL345_REG_POWER_CTL, 0x00); // Standby first
  if (ret < 0) return ret;
  k_msleep(5);

  uint8_t range_bits = 0x03; /* Default ±16g */
  if (current_sensor_range_g == 2) range_bits = 0x00;
  else if (current_sensor_range_g == 4) range_bits = 0x01;
  else if (current_sensor_range_g == 8) range_bits = 0x02;
  else if (current_sensor_range_g == 16) range_bits = 0x03;

  ret = adxl345_write_reg(ADXL345_REG_DATA_FORMAT, 0x08 | range_bits); // FULL_RES = 1 + range
  if (ret < 0) return ret;
  ret = adxl345_write_reg(ADXL345_REG_BW_RATE, 0x0E); // 1600 Hz ODR
  if (ret < 0) return ret;
  ret = adxl345_write_reg(ADXL345_REG_POWER_CTL, 0x08); // Measurement Mode
  if (ret < 0) return ret;

  LOG_INF("ADXL345 awake and configured at ±%ug! ✓", current_sensor_range_g);
  return 0;
}

static int adxl345_init(void) {
  if (!spi_is_ready_dt(&spi_adxl)) {
    LOG_ERR("SPI ADXL spec not ready");
    return -ENODEV;
  }
  return adxl345_sleep();
}

/*============================================================================
 * H3LIS331DL Driver — Direct Raw SPI (No Zephyr Sensor API Overhead)
 *===========================================================================*/

static int h3lis331dl_write_reg(uint8_t reg, uint8_t value) {
  uint8_t tx_buf[2] = {reg & ~H3LIS331DL_SPI_READ_BIT, value};
  const struct spi_buf tx = {.buf = tx_buf, .len = 2};
  const struct spi_buf_set tx_set = {.buffers = &tx, .count = 1};
  return spi_write_dt(&spi_dev, &tx_set);
}

static int h3lis331dl_read_reg(uint8_t reg, uint8_t *value) {
  uint8_t tx_buf[2] = {reg | H3LIS331DL_SPI_READ_BIT, 0};
  const struct spi_buf tx = {.buf = tx_buf, .len = 2};
  const struct spi_buf_set tx_set = {.buffers = &tx, .count = 1};
  
  uint8_t rx_buf[2];
  const struct spi_buf rx = {.buf = rx_buf, .len = 2};
  const struct spi_buf_set rx_set = {.buffers = &rx, .count = 1};
  
  int ret = spi_transceive_dt(&spi_dev, &tx_set, &rx_set);
  if (ret == 0) {
    *value = rx_buf[1];
  }
  return ret;
}

/**
 * @brief Burst-read all 6 output registers in one SPI transaction.
 *
 * The H3LIS331DL uses little-endian byte order (LOW byte at lower address).
 * 6 bytes: [X_L][X_H][Y_L][Y_H][Z_L][Z_H]
 */
static int h3lis331dl_read_accel_raw(int16_t *ax, int16_t *ay, int16_t *az) {
  uint8_t tx_buf[7] = {0};
  tx_buf[0] = H3LIS331DL_OUT_X_L_MULTI;
  const struct spi_buf tx = {.buf = tx_buf, .len = 7};
  const struct spi_buf_set tx_set = {.buffers = &tx, .count = 1};
  
  uint8_t rx_buf[7];
  const struct spi_buf rx = {.buf = rx_buf, .len = 7};
  const struct spi_buf_set rx_set = {.buffers = &rx, .count = 1};
  
  int ret = spi_transceive_dt(&spi_dev, &tx_set, &rx_set);
  if (ret == 0) {
    /* rx_buf[0] is dummy data from address transmission */
    *ax = (int16_t)((rx_buf[2] << 8) | rx_buf[1]);
    *ay = (int16_t)((rx_buf[4] << 8) | rx_buf[3]);
    *az = (int16_t)((rx_buf[6] << 8) | rx_buf[5]);
  }
  return ret;
}



/**
 * @brief Wake H3LIS331DL and configure for 1000 Hz with the selected dynamic G-range.
 *
 * Startup sequence per datasheet section 3.2:
 * 1. Write CTRL_REG4 first (full-scale, BDU) while sensor is in power-down
 * 2. Then write CTRL_REG1 to enable and set ODR (this starts conversions)
 */
static void h3lis331dl_wake_and_configure(void) {
  /* Ensure power-down first */
  h3lis331dl_write_reg(H3LIS331DL_CTRL_REG1, H3LIS331DL_CTRL_REG1_POWER_DOWN);
  k_msleep(5);

  uint8_t fs_bits = H3LIS331DL_CTRL_REG4_FS_400G;
  if (current_sensor_range_g == 100) {
    fs_bits = H3LIS331DL_CTRL_REG4_FS_100G;
  } else if (current_sensor_range_g == 200) {
    fs_bits = H3LIS331DL_CTRL_REG4_FS_200G;
  }

  /* Set full-scale, BDU=on (block data update to prevent data tearing) */
  h3lis331dl_write_reg(H3LIS331DL_CTRL_REG4, 0x80 | fs_bits);

  /* No high-pass filter */
  h3lis331dl_write_reg(H3LIS331DL_CTRL_REG2, 0x00);

  /* Start: Normal mode, 1000 Hz, all axes enabled */
  h3lis331dl_write_reg(H3LIS331DL_CTRL_REG1, H3LIS331DL_CTRL_REG1_ODR_1KHZ);

  /* Wait for first conversion to be ready (1/ODR = 1 ms + margin) */
  k_msleep(10);
}

int accel_service_set_sensor_range(uint16_t range_g) {
  if (range_g != 2 && range_g != 4 && range_g != 8 && range_g != 16 &&
      range_g != 100 && range_g != 200 && range_g != 400) {
    return -EINVAL;
  }
  uint16_t prev_range_g = current_sensor_range_g;
  current_sensor_range_g = range_g;
  accel_service_update_meta_range(range_g);

  if (range_g <= 16) {
    accel_service_update_sensor_name("ADXL345");
  } else {
    accel_service_update_sensor_name("H3LIS331DL");
  }

  if (streaming_active) {
    if (range_g <= 16) {
      if (prev_range_g >= 100) {
        h3lis331dl_sleep();
      }
      adxl345_wake_and_configure();
      LOG_INF("Switched to ADXL345 (±%ug) on active hardware", range_g);
    } else {
      if (prev_range_g <= 16) {
        adxl345_sleep();
      }
      h3lis331dl_wake_and_configure();
      LOG_INF("Switched to H3LIS331DL (±%ug) on active hardware", range_g);
    }
  } else {
    LOG_INF("Sensor range updated (cached) to ±%ug", range_g);
  }
  return 0;
}

uint16_t accel_service_get_sensor_range(void) {
  return current_sensor_range_g;
}

int accel_service_save_sensor_range(uint16_t range_g) {
  int err = accel_service_set_sensor_range(range_g);
  if (err == 0) {
#if IS_ENABLED(CONFIG_SETTINGS)
    settings_save_one("app/g_range", &current_sensor_range_g, sizeof(current_sensor_range_g));
    LOG_INF("Saved g_range to settings: %u", current_sensor_range_g);
#endif
  }
  return err;
}

#if IS_ENABLED(CONFIG_SETTINGS)
static int app_settings_set(const char *name, size_t len, settings_read_cb read_cb, void *cb_arg) {
  const char *next;
  if (settings_name_steq(name, "g_range", &next) && !next) {
    uint16_t val;
    if (read_cb(cb_arg, &val, sizeof(val)) == sizeof(val)) {
      if (val == 2 || val == 4 || val == 8 || val == 16 || val == 100 || val == 200 || val == 400) {
        accel_service_set_sensor_range(val);
        LOG_INF("Settings load: g_range = %u", val);
      }
    }
    return 0;
  }
  if (settings_name_steq(name, "tx_power", &next) && !next) {
    int8_t val;
    if (read_cb(cb_arg, &val, sizeof(val)) == sizeof(val)) {
      accel_service_set_tx_power(val);
      LOG_INF("Settings load: tx_power = %d", val);
    }
    return 0;
  }
  if (settings_name_steq(name, "sampling_rate", &next) && !next) {
    uint16_t val;
    if (read_cb(cb_arg, &val, sizeof(val)) == sizeof(val)) {
      accel_service_set_sampling_rate(val);
      LOG_INF("Settings load: sampling_rate = %u", val);
    }
    return 0;
  }
  if (settings_name_steq(name, "burst_threshold", &next) && !next) {
    uint16_t val;
    if (read_cb(cb_arg, &val, sizeof(val)) == sizeof(val)) {
      accel_service_set_burst_threshold(val);
      LOG_INF("Settings load: burst_threshold = %u", val);
    }
    return 0;
  }
  return -ENOENT;
}

static struct settings_handler app_settings = {
  .name = "app",
  .h_set = app_settings_set,
};
#endif

/**
 * @brief Put H3LIS331DL into power-down mode.
 * Current consumption: ~1 µA typ.
 */
static void h3lis331dl_sleep(void) {
  h3lis331dl_write_reg(H3LIS331DL_CTRL_REG1, H3LIS331DL_CTRL_REG1_POWER_DOWN);
}

/*============================================================================
 * Raw Sample Circular Buffer & TX Semaphore
 *===========================================================================*/

typedef struct {
  int16_t x;
  int16_t y;
  int16_t z;
} raw_sample_t;

#define RAW_BUF_SIZE RING_BUFFER_SAMPLES
static raw_sample_t raw_buffer[RAW_BUF_SIZE];
static volatile uint16_t raw_write_idx = 0;
static volatile uint16_t raw_read_idx = 0;
static volatile uint16_t raw_count = 0;

static K_SEM_DEFINE(tx_sem, 0, 1);

/* Flow-control semaphore: signalled when BLE controller has accepted a packet */
static K_SEM_DEFINE(tx_done_sem, 0, 1);

static void tx_sent_cb(struct bt_conn *conn, void *user_data) {
  ARG_UNUSED(conn);
  ARG_UNUSED(user_data);
  k_sem_give(&tx_done_sem);
}

static void tx_thread_fn(void *p1, void *p2, void *p3) {
  static accel_packet_t pkt;
  while (1) {
    k_sem_take(&tx_sem, K_FOREVER);
    LOG_INF("[TX] Woken up! raw_count=%u, active=%d, notify_enabled=%d",
            raw_count, streaming_active, accel_service_data_notify_enabled());

    if (!accel_service_data_notify_enabled()) {
      continue;
    }

    /* Process all accumulated raw samples in multiples of 29 (SAMPLES_PER_PACKET) */
    while (raw_count >= SAMPLES_PER_PACKET && streaming_active) {
      pkt.packet_counter      = packet_counter++;
      pkt.first_sample_offset = 0;

      for (int i = 0; i < SAMPLES_PER_PACKET; i++) {
        raw_sample_t sample = raw_buffer[raw_read_idx];
        raw_read_idx = (raw_read_idx + 1) % RAW_BUF_SIZE;

        unsigned int key = irq_lock();
        raw_count--;
        irq_unlock(key);

        /* Re-calculate un-aliased physical timestamp based on absolute sample index */
        uint32_t current_sample_index = pkt.packet_counter * SAMPLES_PER_PACKET + i + 1;
        uint32_t active_rate = accel_service_get_sampling_rate();
        if (active_rate == 0) active_rate = 1024;
        pkt.samples[i].rel_timestamp_ms = (uint16_t)(((uint64_t)current_sample_index * 1000U) / active_rate);

        pkt.samples[i].accel_x = sample.x;
        pkt.samples[i].accel_y = sample.y;
        pkt.samples[i].accel_z = sample.z;
      }

      pkt.crc16 = crc16_ccitt(0, (uint8_t *)&pkt, 237);

      /* === Zero-Loss Flow-Controlled BLE Transmission ===
       * Use bt_gatt_notify_cb with a completion callback + semaphore.
       * If the BLE TX queue is momentarily full (-ENOMEM), yield and
       * retry indefinitely — NEVER drop a packet. Only abort on
       * connection loss (-ENOTCONN).
       */
      struct bt_gatt_notify_params params = {
        .attr = accel_service_get_data_attr(),
        .data = &pkt,
        .len  = ACCEL_PACKET_SIZE,
        .func = tx_sent_cb,
        .user_data = NULL,
      };

      int ret;
      while (streaming_active) {
        if (!accel_service_data_notify_enabled()) {
          ret = -ENOTCONN;
          break;
        }

        struct bt_conn *target = accel_service_get_conn();
        if (!target) {
          ret = -ENOTCONN;
          break;
        }

        ret = bt_gatt_notify_cb(target, &params);
        if (ret == 0) {
          /* Packet accepted by BLE controller — wait for TX completion */
          k_sem_take(&tx_done_sem, K_MSEC(500));
          break;
        } else if (ret == -ENOTCONN) {
          LOG_WRN("[TX] Connection lost during send");
          break;
        } else {
          /* -ENOMEM or other transient error: BLE TX queue full, yield and retry */
          k_yield();
        }
      }

      if (ret == 0) {
        packets_sent++;
        if (packets_sent % 100 == 0) {
          LOG_INF("[TX] Sent %u packets (dropped: %u)", packets_sent, packets_dropped);
        }
      } else if (ret != -ENOTCONN) {
        packets_dropped++;
        LOG_ERR("[TX] Failed to send packet #%u! ret=%d", pkt.packet_counter, ret);
      }
    }
  }
}
K_THREAD_DEFINE(tx_thread, 3072, tx_thread_fn, NULL, NULL, NULL, 8, 0, 0);

/*============================================================================
 * Sampling Thread — Driven by Hardware NRF_RTC0 at Exactly 1024 Hz
 *===========================================================================*/

static void sampling_thread_fn(void *p1, void *p2, void *p3) {
  int16_t ax = 0, ay = 0, az = 0;
  int16_t last_ax = 0, last_ay = 0, last_az = 0;
  uint32_t consecutive_spi_err = 0;
  LOG_INF("Sampling thread ready — waiting for streaming_active");

  while (!streaming_active) {
    k_msleep(10);
  }

  while (1) {
    /* Block until LFCLK RTC fires — exactly every 976.56 µs */
    k_sem_take(&sample_sem, K_FOREVER);

    if (!streaming_active) {
      raw_write_idx = 0;
      raw_read_idx  = 0;
      raw_count     = 0;
      k_sem_reset(&tx_sem);
      while (!streaming_active) {
        k_msleep(10);
      }
      continue;
    }

    int ret;
    if (current_sensor_range_g <= 16) {
      ret = adxl345_read_accel_raw(&ax, &ay, &az);
      if (ret < 0) {
        consecutive_spi_err++;
        ax = last_ax;
        ay = last_ay;
        az = last_az;
        if (consecutive_spi_err >= 50) {
          adxl345_wake_and_configure();
          consecutive_spi_err = 0;
        }
      } else {
        consecutive_spi_err = 0;
        last_ax = ax;
        last_ay = ay;
        last_az = az;
      }
    } else {
      ret = h3lis331dl_read_accel_raw(&ax, &ay, &az);
      if (ret < 0) {
        consecutive_spi_err++;
        ax = last_ax;
        ay = last_ay;
        az = last_az;
        if (consecutive_spi_err >= 50) {
          h3lis331dl_wake_and_configure();
          consecutive_spi_err = 0;
        }
      } else {
        consecutive_spi_err = 0;
        last_ax = ax;
        last_ay = ay;
        last_az = az;
      }
    }

    total_samples++;

    /* Save raw sample into circular buffer */
    if (raw_count >= RAW_BUF_SIZE) {
      packets_dropped++; /* Buffer overflow, drop sample */
    } else {
      raw_buffer[raw_write_idx].x = ax;
      raw_buffer[raw_write_idx].y = ay;
      raw_buffer[raw_write_idx].z = az;
      raw_write_idx = (raw_write_idx + 1) % RAW_BUF_SIZE;
      
      unsigned int key = irq_lock();
      raw_count++;
      irq_unlock(key);
    }

    uint16_t threshold = accel_service_get_burst_threshold();
    
    /* Auto-align threshold to a multiple of SAMPLES_PER_PACKET (29) */
    if (threshold < SAMPLES_PER_PACKET) {
      threshold = SAMPLES_PER_PACKET;
    }

    /* Signal transmission when burst threshold is met */
    if (raw_count >= threshold) {
      k_sem_give(&tx_sem);
    }
  }
}
K_THREAD_DEFINE(sampling_thread, 2048, sampling_thread_fn, NULL, NULL, NULL,
                7, 0, 0);

/*============================================================================
 * BLE Advertising Data (defined before callbacks that reference them)
 *===========================================================================*/

static const struct bt_data ad[] = {
    BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
    BT_DATA(BT_DATA_NAME_COMPLETE, CONFIG_BT_DEVICE_NAME,
            sizeof(CONFIG_BT_DEVICE_NAME) - 1),
};

static const struct bt_data sd[] = {
    BT_DATA_BYTES(BT_DATA_UUID128_ALL, ACCEL_SERVICE_UUID_VAL),
};

/*============================================================================
 * BLE Callbacks
 *===========================================================================*/

static struct bt_conn *active_conn = NULL;

static void connected(struct bt_conn *conn, uint8_t err) {
  if (!err) {
    LOG_INF("Connected");
    active_conn = bt_conn_ref(conn);
    accel_service_set_conn(conn);
    /* Start with a low-power, slow connection interval when idle (100-125 ms, slave latency 4) */
    struct bt_le_conn_param *param = BT_LE_CONN_PARAM(80, 100, 4, 400);
    bt_conn_le_param_update(conn, param);
  }
}

static void disconnected(struct bt_conn *conn, uint8_t reason) {
  LOG_INF("Disconnected: %u", reason);
  
  /* Gracefully stop streaming if it was active to save power and reset state */
  accel_service_on_notify_disabled();

  if (active_conn) {
    bt_conn_unref(active_conn);
    active_conn = NULL;
  }
  accel_service_set_conn(NULL);

  static struct bt_le_adv_param adv_param =
      BT_LE_ADV_PARAM_INIT(BT_LE_ADV_OPT_CONN, BT_GAP_ADV_SLOW_INT_MIN,
                           BT_GAP_ADV_SLOW_INT_MAX, NULL);

  int err = bt_le_adv_start(&adv_param, ad, ARRAY_SIZE(ad), sd,
                             ARRAY_SIZE(sd));
  if (err) {
    LOG_ERR("Failed to restart advertising: %d", err);
  }
}

BT_CONN_CB_DEFINE(conn_callbacks) = {
    .connected    = connected,
    .disconnected = disconnected,
};

/*============================================================================
 * Notification Callbacks (called from accel_service on CCCD writes)
 *===========================================================================*/

void accel_service_on_notify_enabled(void) {
  LOG_INF(">>> STREAMING START (1024 Hz, range=%u Gs)", current_sensor_range_g);

  if (current_sensor_range_g <= 16) {
    h3lis331dl_sleep();
    adxl345_wake_and_configure();
  } else {
    adxl345_sleep();
    h3lis331dl_wake_and_configure();
  }

  burst_start_ms   = k_uptime_get_32();
  packet_counter   = 0;
  total_samples    = 0;
  packets_sent     = 0;
  packets_dropped  = 0;
  
  raw_write_idx    = 0;
  raw_read_idx     = 0;
  raw_count        = 0;
  k_sem_reset(&tx_sem);
  k_sem_reset(&tx_done_sem);
  
  streaming_active = true;

  /* Switch to fast connection interval (7.5-15 ms) for high throughput */
  if (active_conn) {
    struct bt_le_conn_param *fast = BT_LE_CONN_PARAM(6, 12, 0, 400);
    bt_conn_le_param_update(active_conn, fast);
  }

  start_sample_timer();
}

void accel_service_on_notify_disabled(void) {
  streaming_active = false;
  
  raw_write_idx    = 0;
  raw_read_idx     = 0;
  raw_count        = 0;
  k_sem_reset(&tx_sem);

  stop_sample_timer();
  h3lis331dl_sleep();
  adxl345_sleep();

  /* Switch back to slow, low-power connection parameters when idle */
  if (active_conn) {
    struct bt_le_conn_param *slow = BT_LE_CONN_PARAM(80, 100, 4, 400);
    bt_conn_le_param_update(active_conn, slow);
  }

  LOG_INF(">>> STREAMING STOP | sent=%u dropped=%u", packets_sent,
          packets_dropped);
}

/*============================================================================
 * Battery Monitoring (BAS + internal SAADC)
 *===========================================================================*/

#define ADC_RESOLUTION 12
#define ADC_GAIN ADC_GAIN_1_6
#define ADC_REFERENCE ADC_REF_INTERNAL
#define ADC_ACQUISITION_TIME ADC_ACQ_TIME(ADC_ACQ_TIME_MICROSECONDS, 40)
#define ADC_CHANNEL_ID 0

static const struct device *adc_dev = DEVICE_DT_GET(DT_NODELABEL(adc));
static struct k_work_delayable battery_work;

static uint8_t vdd_to_percentage(int32_t vdd_mv) {
  if (vdd_mv >= 3000) return 100;
  if (vdd_mv <= 2000) return 0;

  // Piecewise linear interpolation for CR2032
  if (vdd_mv > 2900) return 90 + ((vdd_mv - 2900) * 10) / 100;
  if (vdd_mv > 2800) return 80 + ((vdd_mv - 2800) * 10) / 100;
  if (vdd_mv > 2700) return 60 + ((vdd_mv - 2700) * 20) / 100;
  if (vdd_mv > 2600) return 40 + ((vdd_mv - 2600) * 20) / 100;
  if (vdd_mv > 2500) return 20 + ((vdd_mv - 2500) * 20) / 100;
  if (vdd_mv > 2400) return 10 + ((vdd_mv - 2400) * 10) / 100;
  return ((vdd_mv - 2000) * 10) / 400;
}

static bool battery_monitoring_configured = false;

static void battery_work_handler(struct k_work *work) {
  LOG_INF("battery_work_handler: firing");

  if (!device_is_ready(adc_dev)) {
    LOG_ERR("battery_work_handler: ADC device not ready inside handler!");
    k_work_reschedule(&battery_work, K_SECONDS(2));
    return;
  }

  if (!battery_monitoring_configured) {
    struct adc_channel_cfg channel_cfg = {
        .gain             = ADC_GAIN,
        .reference        = ADC_REFERENCE,
        .acquisition_time = ADC_ACQUISITION_TIME,
        .channel_id       = ADC_CHANNEL_ID,
        .input_positive   = NRF_SAADC_VDD,
    };

    int err = adc_channel_setup(adc_dev, &channel_cfg);
    if (err) {
      LOG_ERR("battery_work_handler: Failed to setup ADC channel dynamically: %d", err);
      k_work_reschedule(&battery_work, K_SECONDS(2));
      return;
    }
    battery_monitoring_configured = true;
    LOG_INF("battery_work_handler: ADC channel dynamic setup successful");
  }

  int16_t raw_val = 0;
  struct adc_sequence sequence = {
      .channels    = BIT(ADC_CHANNEL_ID),
      .buffer      = &raw_val,
      .buffer_size = sizeof(raw_val),
      .resolution  = ADC_RESOLUTION,
  };

  int err = adc_read(adc_dev, &sequence);
  if (err == 0) {
    int32_t vdd_mv = (raw_val * 3600) / 4096;
    uint8_t battery_percent = vdd_to_percentage(vdd_mv);
    LOG_INF("battery_work_handler: Read success: raw=%d, VDD=%d mV (%d%%)", raw_val, vdd_mv, battery_percent);
    accel_service_update_battery_level(battery_percent);
  } else {
    LOG_ERR("battery_work_handler: Failed to read ADC: %d", err);
  }

  k_work_reschedule(&battery_work, K_SECONDS(2));
}

static int init_battery_monitoring(void) {
  LOG_INF("init_battery_monitoring: starting");
  
  k_work_init_delayable(&battery_work, battery_work_handler);
  
  if (!device_is_ready(adc_dev)) {
    LOG_WRN("init_battery_monitoring: ADC device not ready at startup, scheduling retry");
    k_work_reschedule(&battery_work, K_SECONDS(1));
    return 0;
  }
  LOG_INF("init_battery_monitoring: ADC device is ready");

  struct adc_channel_cfg channel_cfg = {
      .gain             = ADC_GAIN,
      .reference        = ADC_REFERENCE,
      .acquisition_time = ADC_ACQUISITION_TIME,
      .channel_id       = ADC_CHANNEL_ID,
      .input_positive   = NRF_SAADC_VDD,
  };

  int err = adc_channel_setup(adc_dev, &channel_cfg);
  if (err) {
    LOG_WRN("init_battery_monitoring: Failed to setup ADC channel at startup: %d. Will retry in work handler", err);
  } else {
    battery_monitoring_configured = true;
    LOG_INF("init_battery_monitoring: ADC channel setup successful");
  }

  k_work_reschedule(&battery_work, K_NO_WAIT);
  LOG_INF("init_battery_monitoring: battery_work scheduled");
  return 0;
}

/*============================================================================
 * Main
 *===========================================================================*/

int main(void) {
  int err;

  LOG_INF("================================================");
  LOG_INF("ISRO Accelerometer Rev 22 - H3LIS331DL + HW TIMER");
  LOG_INF("================================================");

  if (!spi_is_ready_dt(&spi_dev)) {
    LOG_ERR("SPI H3LIS spec not ready");
    return 0;
  }
  if (!spi_is_ready_dt(&spi_adxl)) {
    LOG_ERR("SPI ADXL spec not ready");
    return 0;
  }

  /* 
   * De-assert both Chip Select (CS) lines by initializing the SPI driver state
   * and putting both devices into sleep/standby mode immediately.
   */
  h3lis331dl_sleep();
  adxl345_sleep();
  k_msleep(15); // Let levels settle

  /* Verify H3LIS331DL is present and responding */
  uint8_t who_am_i = 0;
  bool h3lis_detected = false;

  int id_ret = h3lis331dl_read_reg(H3LIS331DL_WHO_AM_I, &who_am_i);
  if (id_ret != 0 || who_am_i != 0x32) {
    LOG_ERR("H3LIS331DL not found! WHO_AM_I=0x%02X (expected 0x32), ret=%d",
            who_am_i, id_ret);
    h3lis_detected = false;
  } else {
    LOG_INF("H3LIS331DL found: WHO_AM_I=0x32 ✓");
    h3lis_detected = true;
  }

  /* Verify ADXL345 is present and responding */
  adxl345_init();
  uint8_t adxl_who = 0;
  int adxl_ret = adxl345_read_reg(ADXL345_REG_DEVID, &adxl_who);
  if (adxl_ret == 0 && adxl_who == 0xE5) {
    LOG_INF("ADXL345 found on SPI: DEVID=0xE5 ✓");
    adxl_detected = true;
  } else {
    LOG_ERR("ADXL345 not found on SPI! DEVID=0x%02X, ret=%d", adxl_who, adxl_ret);
  }

  /* Put ADXL345 to sleep immediately — wake only on streaming start */
  adxl345_sleep();

  err = bt_enable(NULL);
  if (err) {
    LOG_ERR("BT init failed: %d", err);
    return 0;
  }

  #if IS_ENABLED(CONFIG_SETTINGS)
  int settings_err = settings_register(&app_settings);
  if (settings_err) {
    LOG_ERR("Failed to register app settings: %d", settings_err);
  }
  #endif

  accel_service_init();

  if (IS_ENABLED(CONFIG_SETTINGS)) {
    settings_load();
  }

  // Determine active sensor based on the loaded range if both are present
  bool use_h3lis = false;
  if (h3lis_detected && adxl_detected) {
    use_h3lis = (current_sensor_range_g > 16);
  } else if (h3lis_detected) {
    use_h3lis = true;
  } else {
    use_h3lis = false;
  }

  // Update dynamic name in BLE metadata based on active sensor type
  if (use_h3lis) {
    accel_service_update_sensor_name("H3LIS331DL");
  } else if (adxl_detected) {
    accel_service_update_sensor_name("ADXL345");
  } else {
    accel_service_update_sensor_name("None");
  }

  accel_service_update_sensor_status(h3lis_detected, adxl_detected);
  init_battery_monitoring();

  // Sanitize g_range based on selected active sensor to prevent starting in mismatched modes
  if (!use_h3lis && adxl_detected) {
    if (current_sensor_range_g > 16 || (current_sensor_range_g != 2 && current_sensor_range_g != 4 && current_sensor_range_g != 8 && current_sensor_range_g != 16)) {
      current_sensor_range_g = 16; // default 16g
    }
  } else if (use_h3lis && h3lis_detected) {
    if (current_sensor_range_g < 100 || (current_sensor_range_g != 100 && current_sensor_range_g != 200 && current_sensor_range_g != 400)) {
      current_sensor_range_g = 400; // default 400g
    }
  }
  accel_service_update_meta_range(current_sensor_range_g);

  static struct bt_le_adv_param adv_param =
      BT_LE_ADV_PARAM_INIT(BT_LE_ADV_OPT_CONN, BT_GAP_ADV_SLOW_INT_MIN,
                           BT_GAP_ADV_SLOW_INT_MAX, NULL);

  err = bt_le_adv_start(&adv_param, ad, ARRAY_SIZE(ad), sd, ARRAY_SIZE(sd));
  if (err) {
    LOG_ERR("Advertising failed: %d", err);
    return err;
  }

  LOG_INF("Advertising as '%s'", CONFIG_BT_DEVICE_NAME);

  while (1) {
    k_sleep(K_SECONDS(60));
  }

  return 0;
}
