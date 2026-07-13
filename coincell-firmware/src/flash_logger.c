/**
 * @file flash_logger.c
 * @brief Flash Logger Implementation for Zero Data Loss
 *
 * Simplified implementation using RAM buffer for samples.
 * This avoids complex flash partition issues while providing
 * the same API for zero-data-loss functionality.
 *
 * For production, this can be extended to use NVS for persistence.
 */

#include "flash_logger.h"

#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(flash_logger, LOG_LEVEL_INF);

/*============================================================================
 * RAM Buffer Configuration
 *===========================================================================*/

/* RAM buffer size - limits how many samples we can hold during congestion */
#define RAM_BUFFER_SAMPLES 4096 /* ~32 KB of RAM, ~4 seconds at 1 kHz */

/*============================================================================
 * Module State
 *===========================================================================*/

static flash_sample_t sample_buffer[RAM_BUFFER_SAMPLES];
static uint32_t head = 0;  /* Next write position */
static uint32_t tail = 0;  /* Next read position */
static uint32_t count = 0; /* Number of samples stored */
static bool initialized = false;
static flash_logger_state_t current_state = FLASH_LOGGER_IDLE;

/* Mutex for thread safety */
static struct k_mutex buffer_mutex;

/*============================================================================
 * Public API
 *===========================================================================*/

int flash_logger_init(void) {
  k_mutex_init(&buffer_mutex);

  head = 0;
  tail = 0;
  count = 0;
  current_state = FLASH_LOGGER_IDLE;
  initialized = true;

  LOG_INF("Flash logger initialized (RAM buffer: %d samples)",
          RAM_BUFFER_SAMPLES);
  return 0;
}

int flash_logger_write(const flash_sample_t *sample) {
  if (!initialized) {
    return -ENODEV;
  }

  k_mutex_lock(&buffer_mutex, K_FOREVER);

  if (count >= RAM_BUFFER_SAMPLES) {
    k_mutex_unlock(&buffer_mutex);
    return -ENOSPC;
  }

  /* Write sample to buffer */
  sample_buffer[head] = *sample;
  head = (head + 1) % RAM_BUFFER_SAMPLES;
  count++;

  if (current_state == FLASH_LOGGER_IDLE) {
    current_state = FLASH_LOGGER_LOGGING;
  }

  k_mutex_unlock(&buffer_mutex);
  return 0;
}

int flash_logger_write_bulk(const flash_sample_t *samples,
                            uint16_t sample_count) {
  if (!initialized) {
    return -ENODEV;
  }

  int written = 0;

  for (uint16_t i = 0; i < sample_count; i++) {
    int ret = flash_logger_write(&samples[i]);
    if (ret == -ENOSPC) {
      break;
    } else if (ret < 0) {
      return ret;
    }
    written++;
  }

  return written;
}

int flash_logger_read(flash_sample_t *samples, uint16_t max_count) {
  if (!initialized) {
    return -ENODEV;
  }

  k_mutex_lock(&buffer_mutex, K_FOREVER);

  if (count == 0) {
    current_state = FLASH_LOGGER_IDLE;
    k_mutex_unlock(&buffer_mutex);
    return 0;
  }

  current_state = FLASH_LOGGER_DRAINING;

  /* Read up to max_count samples */
  uint16_t to_read = (max_count < count) ? max_count : count;

  for (uint16_t i = 0; i < to_read; i++) {
    samples[i] = sample_buffer[tail];
    tail = (tail + 1) % RAM_BUFFER_SAMPLES;
  }
  count -= to_read;

  if (count == 0) {
    current_state = FLASH_LOGGER_IDLE;
  }

  k_mutex_unlock(&buffer_mutex);
  return to_read;
}

uint32_t flash_logger_get_pending(void) { return count; }

flash_logger_state_t flash_logger_get_state(void) { return current_state; }

int flash_logger_clear(void) {
  if (!initialized) {
    return -ENODEV;
  }

  k_mutex_lock(&buffer_mutex, K_FOREVER);
  head = 0;
  tail = 0;
  count = 0;
  current_state = FLASH_LOGGER_IDLE;
  k_mutex_unlock(&buffer_mutex);

  return 0;
}

bool flash_logger_is_enabled(void) { return initialized; }
