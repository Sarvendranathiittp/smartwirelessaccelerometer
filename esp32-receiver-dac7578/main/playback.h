#ifndef PLAYBACK_H
#define PLAYBACK_H

#include "accel_protocol.h"

/**
 * Initialize DAC hardware and create playback engine tasks.
 */
void playback_init(void);

/**
 * Enqueue a BLE packet for DAC playback.
 */
void playback_enqueue(const accel_packet_t *packet);

/**
 * Reset playback state.
 */
void playback_reset(void);

/**
 * Configure the G-range scaling limits dynamically.
 */
void playback_set_range(int16_t range_g);

/**
 * Start the alarm timer and clear playback queue.
 */
void playback_start(void);

/**
 * Stop the alarm timer and set DAC to 0g mid-scale.
 */
void playback_stop(void);

#endif // PLAYBACK_H
