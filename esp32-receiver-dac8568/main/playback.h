#ifndef PLAYBACK_H
#define PLAYBACK_H

#include "accel_protocol.h"

/**
 * Initialize DAC hardware and start playback engine.
 * In LOCAL_SINE_TEST mode, generates a 200 Hz sine directly.
 * In normal mode, waits for BLE data before starting.
 */
void playback_init(void);

/**
 * Enqueue a BLE packet for DAC playback.
 * Called from BLE notification callback (non-blocking).
 */
void playback_enqueue(const accel_packet_t *packet);

/**
 * Reset playback state (called on BLE disconnect).
 */
void playback_reset(void);

#endif
