/**
 * @file flash_logger.h
 * @brief Flash Logger for Zero Data Loss
 *
 * When BLE link is congested or disconnected, samples are logged
 * to SPI Flash. When link recovers, samples are drained and sent.
 *
 * Architecture: Simple circular log in NVS storage
 * Capacity: ~100,000 samples (100 seconds at 1 kHz)
 */

#ifndef FLASH_LOGGER_H_
#define FLASH_LOGGER_H_

#include <stdbool.h>
#include <stdint.h>
#include <zephyr/kernel.h>

/*============================================================================
 * Flash Logger Configuration
 *===========================================================================*/

/* Maximum samples to store in flash (limited by flash size) */
#define FLASH_LOG_MAX_SAMPLES 102400 /* 100 KB worth = ~100 sec at 1 kHz */

/* Sample structure for flash storage (compact: 8 bytes) */
typedef struct __attribute__((packed)) {
  uint16_t timestamp_ms; /* Relative timestamp */
  int16_t accel_x;
  int16_t accel_y;
  int16_t accel_z;
} flash_sample_t;

#define FLASH_SAMPLE_SIZE sizeof(flash_sample_t) /* 8 bytes */

/*============================================================================
 * Flash Logger State
 *===========================================================================*/

typedef enum {
  FLASH_LOGGER_IDLE,     /* No samples pending */
  FLASH_LOGGER_LOGGING,  /* Writing samples to flash */
  FLASH_LOGGER_DRAINING, /* Sending samples from flash */
} flash_logger_state_t;

/*============================================================================
 * Flash Logger API
 *===========================================================================*/

/**
 * @brief Initialize flash logger subsystem
 * @return 0 on success, negative errno on failure
 */
int flash_logger_init(void);

/**
 * @brief Write a sample to flash log
 * @param sample Sample to store
 * @return 0 on success, -ENOSPC if full, negative errno on error
 */
int flash_logger_write(const flash_sample_t *sample);

/**
 * @brief Write multiple samples to flash log
 * @param samples Array of samples
 * @param count Number of samples
 * @return Number of samples written, negative errno on error
 */
int flash_logger_write_bulk(const flash_sample_t *samples, uint16_t count);

/**
 * @brief Read samples from flash log (for BLE transmission)
 * @param samples Buffer to read into
 * @param max_count Maximum samples to read
 * @return Number of samples read, 0 if empty, negative errno on error
 */
int flash_logger_read(flash_sample_t *samples, uint16_t max_count);

/**
 * @brief Get number of samples pending in flash log
 * @return Number of pending samples
 */
uint32_t flash_logger_get_pending(void);

/**
 * @brief Get current logger state
 * @return Current state
 */
flash_logger_state_t flash_logger_get_state(void);

/**
 * @brief Clear all samples from flash log
 * @return 0 on success
 */
int flash_logger_clear(void);

/**
 * @brief Check if flash logger is enabled
 * @return true if enabled
 */
bool flash_logger_is_enabled(void);

#endif /* FLASH_LOGGER_H_ */
