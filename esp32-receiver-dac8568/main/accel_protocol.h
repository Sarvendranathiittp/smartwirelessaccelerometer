/**
 * @file accel_protocol.h
 * @brief Shared accelerometer packet format definitions (Rev 9)
 *
 * Must match the nRF5340 coincell-firmware packet format exactly.
 */

#pragma once

#include <stdint.h>

/*============================================================================
 * BLE UUIDs (128-bit, matching nRF5340 firmware)
 *===========================================================================*/

/* Service: 12340000-1234-5678-9abc-def012345678 */
#define ACCEL_SERVICE_UUID_128                                                 \
  0x78, 0x56, 0x34, 0x12, 0xf0, 0xde, 0xbc, 0x9a, 0x78, 0x56, 0x34, 0x12,      \
      0x00, 0x00, 0x34, 0x12

/* Accel Data Characteristic: 12340001-... (NOTIFY) */
#define ACCEL_DATA_CHAR_UUID_128                                               \
  0x78, 0x56, 0x34, 0x12, 0xf0, 0xde, 0xbc, 0x9a, 0x78, 0x56, 0x34, 0x12,      \
      0x01, 0x00, 0x34, 0x12

/* Operating Mode Characteristic: 12340005-... (READ+WRITE) */
#define OPERATING_MODE_CHAR_UUID_128                                           \
  0x78, 0x56, 0x34, 0x12, 0xf0, 0xde, 0xbc, 0x9a, 0x78, 0x56, 0x34, 0x12,      \
      0x05, 0x00, 0x34, 0x12

/*============================================================================
 * Packet Format (Rev 9)
 *===========================================================================*/

#define SAMPLES_PER_PACKET 29
#define ACCEL_SAMPLE_SIZE 8
#define ACCEL_PACKET_SIZE 239 /* 4 + 1 + (29*8) + 2 = 239 */

/* 8-byte compact sample */
typedef struct __attribute__((packed)) {
  uint16_t rel_timestamp_ms; /* Relative to burst start */
  int16_t accel_x;           /* Raw counts (LSB/g = 2048) */
  int16_t accel_y;
  int16_t accel_z;
} accel_sample_t;

_Static_assert(sizeof(accel_sample_t) == 8, "Sample must be 8 bytes");

/* 239-byte packet */
typedef struct __attribute__((packed)) {
  uint32_t packet_counter;
  uint8_t first_sample_offset;
  accel_sample_t samples[SAMPLES_PER_PACKET];
  uint16_t crc16;
} accel_packet_t;

_Static_assert(sizeof(accel_packet_t) == 239, "Packet must be 239 bytes");

/*============================================================================
 * Buffer Mode Commands (written to Operating Mode characteristic)
 *===========================================================================*/

#define BUFFER_MODE_NONE 0x10    /* ~29ms latency, no buffering */
#define BUFFER_MODE_DEFAULT 0x20 /* ~232ms latency */
#define BUFFER_MODE_DEEP 0x30    /* ~512ms latency */

/*============================================================================
 * Conversion
 *===========================================================================*/

#define LSB_PER_G 2048.0f
