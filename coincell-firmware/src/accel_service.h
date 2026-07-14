/**
 * @file accel_service.h
 * @brief BLE Accelerometer Service for ISRO Smart Accelerometer
 *
 * Architecture: Rev 10 - FIFO Watermark Interrupt-Driven
 * - Sample: 8 bytes (timestamp + XYZ)
 * - Packet: 239 bytes (29 samples + packet_counter)
 * - Wakeup: GPIO interrupt on P1.11 from MPU6050 FIFO
 *
 * @version 10.0
 * @date 2026
 */

#ifndef ACCEL_SERVICE_H_
#define ACCEL_SERVICE_H_

#include <zephyr/bluetooth/conn.h>
#include <zephyr/types.h>

#ifdef __cplusplus
extern "C" {
#endif

/*============================================================================
 * GATT UUIDs
 *===========================================================================*/

/* Custom Service UUID: 12340000-1234-5678-9ABC-DEF012345678 */
#define ACCEL_SERVICE_UUID_VAL                                                 \
  BT_UUID_128_ENCODE(0x12340000, 0x1234, 0x5678, 0x9ABC, 0xDEF012345678)

/* Acceleration Data Characteristic UUID: 12340001-... (NOTIFY) */
#define ACCEL_DATA_CHAR_UUID_VAL                                               \
  BT_UUID_128_ENCODE(0x12340001, 0x1234, 0x5678, 0x9ABC, 0xDEF012345678)

/* Timestamp Characteristic UUID: 12340002-... (READ | NOTIFY) */
#define TIMESTAMP_CHAR_UUID_VAL                                                \
  BT_UUID_128_ENCODE(0x12340002, 0x1234, 0x5678, 0x9ABC, 0xDEF012345678)

/* Sampling Rate Characteristic UUID: 12340003-... (READ) */
#define SAMPLE_RATE_CHAR_UUID_VAL                                              \
  BT_UUID_128_ENCODE(0x12340003, 0x1234, 0x5678, 0x9ABC, 0xDEF012345678)

/* Sensor Metadata (TEDS) Characteristic UUID: 12340004-... (READ) */
#define SENSOR_META_CHAR_UUID_VAL                                              \
  BT_UUID_128_ENCODE(0x12340004, 0x1234, 0x5678, 0x9ABC, 0xDEF012345678)

/* Operating Mode Characteristic UUID: 12340005-... (READ | WRITE) */
#define OPERATING_MODE_CHAR_UUID_VAL                                           \
  BT_UUID_128_ENCODE(0x12340005, 0x1234, 0x5678, 0x9ABC, 0xDEF012345678)

/* TX Power Control Characteristic UUID: 12340006-... (READ | WRITE) */
#define TX_POWER_CHAR_UUID_VAL                                                 \
  BT_UUID_128_ENCODE(0x12340006, 0x1234, 0x5678, 0x9ABC, 0xDEF012345678)

/* Custom Battery Level Characteristic UUID: 12340007-... (READ | NOTIFY) */
#define BATTERY_CHAR_UUID_VAL                                                  \
  BT_UUID_128_ENCODE(0x12340007, 0x1234, 0x5678, 0x9ABC, 0xDEF012345678)

#define ACCEL_SERVICE_UUID BT_UUID_DECLARE_128(ACCEL_SERVICE_UUID_VAL)
#define ACCEL_DATA_CHAR_UUID BT_UUID_DECLARE_128(ACCEL_DATA_CHAR_UUID_VAL)
#define TIMESTAMP_CHAR_UUID BT_UUID_DECLARE_128(TIMESTAMP_CHAR_UUID_VAL)
#define SAMPLE_RATE_CHAR_UUID BT_UUID_DECLARE_128(SAMPLE_RATE_CHAR_UUID_VAL)
#define SENSOR_META_CHAR_UUID BT_UUID_DECLARE_128(SENSOR_META_CHAR_UUID_VAL)
#define OPERATING_MODE_CHAR_UUID                                               \
  BT_UUID_DECLARE_128(OPERATING_MODE_CHAR_UUID_VAL)
#define TX_POWER_CHAR_UUID                                                     \
  BT_UUID_DECLARE_128(TX_POWER_CHAR_UUID_VAL)
#define BATTERY_CHAR_UUID                                                      \
  BT_UUID_DECLARE_128(BATTERY_CHAR_UUID_VAL)

/*============================================================================
 * Operating Modes
 *===========================================================================*/

typedef enum {
  MODE_COINCELL_BURST = 0x00, /* Default: ~232ms latency, power-gated */
  MODE_CONTINUOUS_LAB = 0x01  /* Lab: ≤40ms latency, network always on */
} operating_mode_t;

/* Buffer modes (written to Operating Mode char by dashboard) */
#define BUFFER_MODE_NONE    0x10 /* No buffer — packet-by-packet (29 samples) */
#define BUFFER_MODE_300MS   0x11 /* 300ms buffer */
#define BUFFER_MODE_1S      0x12 /* 1 second buffer */
#define BUFFER_MODE_2S      0x13 /* 2 second buffer */
#define BUFFER_MODE_5S      0x14 /* 5 second buffer */
#define BUFFER_MODE_10S     0x15 /* 10 second buffer */

/*============================================================================
 * Sample Format (8 bytes, packed) - Rev 9
 *
 * CHANGE: Removed sample_counter (now using packet_counter in header)
 * - rel_timestamp_ms: 16-bit, ms from burst start
 * - accel_xyz: 6 bytes, signed raw counts (±16g range)
 *===========================================================================*/

typedef struct __attribute__((packed)) {
  uint16_t rel_timestamp_ms; /* 2 bytes - ms since burst_start_ms in main.c */
  int16_t accel_x;           /* 2 bytes */
  int16_t accel_y;           /* 2 bytes */
  int16_t accel_z;           /* 2 bytes */
} accel_sample_t;            /* TOTAL = 8 bytes */

#define ACCEL_SAMPLE_SIZE sizeof(accel_sample_t) /* 8 */

/*============================================================================
 * Packet Format (243 bytes) - Rev 9
 *
 * CHANGE: Added 32-bit packet_counter, increased samples to 29
 * - 29 samples per packet (29 × 8 = 232 bytes)
 * - 4 byte header (packet_counter)
 * - 1 byte first_sample_offset (for sync)
 * - 2 bytes CRC16
 * - Fits in BLE MTU (244 bytes)
 *===========================================================================*/

#define SAMPLES_PER_PACKET 29
#define PACKET_PAYLOAD_SIZE (SAMPLES_PER_PACKET * ACCEL_SAMPLE_SIZE) /* 232 */

typedef struct __attribute__((packed)) {
  uint32_t packet_counter;     /* 4 bytes - monotonic, loss detection */
  uint8_t first_sample_offset; /* 1 byte - sample index of first sample */
  accel_sample_t samples[SAMPLES_PER_PACKET]; /* 232 bytes */
  uint16_t crc16;                             /* 2 bytes - integrity check */
} accel_packet_t;                             /* TOTAL = 239 bytes */

#define ACCEL_PACKET_SIZE sizeof(accel_packet_t) /* 239 */

/*============================================================================
 * Ring Buffer Configuration
 *
 * 256 samples = 256ms @ 1kHz
 * 8 packets per burst (232 samples = 8 × 29)
 *===========================================================================*/

#define RING_BUFFER_SAMPLES 16384
#define RING_BUFFER_MASK (RING_BUFFER_SAMPLES - 1) /* 0x3FFF */
#define PACKETS_PER_BURST 8 /* default: 232 / 29 = 8 packets per burst */

/*============================================================================
 * Sensor Metadata (TEDS-like)
 *===========================================================================*/

typedef struct __attribute__((packed)) {
  char sensor_name[24];
  int16_t range_g;
  char unit[8];
  uint8_t h3lis_status;
  uint8_t mpu_status;
} sensor_metadata_t;

void accel_service_update_sensor_status(uint8_t h3lis_ok, uint8_t mpu_ok);
void accel_service_update_sensor_name(const char *name);

/*============================================================================
 * API Functions
 *===========================================================================*/

/**
 * @brief Callbacks for BLE notification changes (weakly defined in service, overridden in main.c)
 */
void accel_service_on_notify_enabled(void);
void accel_service_on_notify_disabled(void);

/**
 * @brief Initialize the Accelerometer GATT Service
 * @return 0 on success, negative errno on failure
 */
int accel_service_init(void);

/**
 * @brief Send a complete burst packet (243 bytes)
 * @param conn Connection object (NULL for all connections)
 * @param packet Pointer to packet structure
 * @return 0 on success, negative errno on failure
 */
int accel_service_notify_packet(struct bt_conn *conn,
                                const accel_packet_t *packet);

/**
 * @brief Send timestamp notification
 * @param conn Connection object (NULL for all connections)
 * @param uptime_ms Current uptime in milliseconds
 * @return 0 on success, negative errno on failure
 */
int accel_service_notify_timestamp(struct bt_conn *conn, uint32_t uptime_ms);

/**
 * @brief Check if notifications are enabled for acceleration data
 * @return true if enabled, false otherwise
 */
bool accel_service_data_notify_enabled(void);

/**
 * @brief Set the current connection reference
 * @param conn Connection object
 */
void accel_service_set_conn(struct bt_conn *conn);

/**
 * @brief Get current operating mode
 * @return Current mode (MODE_COINCELL_BURST or MODE_CONTINUOUS_LAB)
 */
operating_mode_t accel_service_get_mode(void);

/**
 * @brief Set operating mode (only if external power detected)
 * @param mode Requested mode
 * @param external_power_detected true if USB/external power present
 * @return 0 on success, -EPERM if trying to set LAB mode without power
 */
int accel_service_set_mode(operating_mode_t mode, bool external_power_detected);

/**
 * @brief Update external power state for mode switching permission
 * @param detected true if USB/external power is present
 */
void accel_service_set_power_detected(bool detected);

/**
 * @brief Get current burst threshold (set by dashboard via buffer mode)
 * @return Number of samples to buffer before bursting
 */
uint16_t accel_service_get_burst_threshold(void);

/**
 * @brief Set the BLE TX power level dynamically via HCI VS command
 * @param tx_power_dbm TX power in dBm (valid: 3, 0, -8, -12)
 * @return 0 on success, negative errno on failure
 */
int accel_service_set_tx_power(int8_t tx_power_dbm);

/**
 * @brief Get the current TX power level
 * @return Current TX power in dBm
 */
int8_t accel_service_get_tx_power(void);

/**
 * @brief Set the accelerometer G-range dynamically
 * @param range_g range in Gs (100, 200, 400)
 * @return 0 on success, negative errno on failure
 */
int accel_service_set_sensor_range(uint16_t range_g);

/**
 * @brief Set and persistently save the accelerometer G-range dynamically
 * @param range_g range in Gs (100, 200, 400)
 * @return 0 on success, negative errno on failure
 */
int accel_service_save_sensor_range(uint16_t range_g);

/**
 * @brief Get the current accelerometer G-range
 * @return range in Gs
 */
uint16_t accel_service_get_sensor_range(void);

/**
 * @brief Update the internal sensor metadata struct G-range
 * @param range range in Gs
 */
void accel_service_update_meta_range(uint16_t range);

/**
 * @brief Set and persistently save the BLE TX power level dynamically via HCI VS command
 * @param tx_power_dbm TX power in dBm
 * @return 0 on success, negative errno on failure
 */
int accel_service_save_tx_power(int8_t tx_power_dbm);

/**
 * @brief Set the sampling rate dynamically (valid: 1024, 2000, 3000, 4000, 5000)
 * @return 0 on success, negative errno on failure
 */
int accel_service_set_sampling_rate(uint16_t rate);

/**
 * @brief Set and persistently save the sampling rate dynamically
 * @return 0 on success, negative errno on failure
 */
int accel_service_save_sampling_rate(uint16_t rate);

/**
 * @brief Get the current sampling rate
 */
uint16_t accel_service_get_sampling_rate(void);

/**
 * @brief Get the current RTC compare tick interval (only valid for 1024 Hz)
 */
uint32_t accel_service_get_rtc_tick_interval(void);

/**
 * @brief Get the TIMER1 compare value for the current sampling rate (16 MHz base)
 * Only valid for rates > 1024 Hz.
 */
uint32_t accel_service_get_timer1_interval(void);

/**
 * @brief Check if the current sampling rate requires the HF TIMER1 peripheral
 * @return true if rate > 1024 Hz, false if RTC0 should be used
 */
bool accel_service_use_hf_timer(void);

/**
 * @brief Set the burst threshold (buffer mode) dynamically
 */
int accel_service_set_burst_threshold(uint16_t threshold);

/**
 * @brief Set and save the burst threshold dynamically
 */
int accel_service_save_burst_threshold(uint16_t threshold);

/**
 * @brief Update the battery level dynamically and trigger notify if enabled
 */
void accel_service_update_battery_level(uint8_t percent);

/**
 * @brief Get the GATT attribute pointer for the accelerometer data characteristic
 * Used by the TX thread for bt_gatt_notify_cb flow control.
 */
const struct bt_gatt_attr *accel_service_get_data_attr(void);

/**
 * @brief Get the current active BLE connection
 * Returns NULL if no connection is active.
 */
struct bt_conn *accel_service_get_conn(void);

#ifdef __cplusplus
}
#endif

#endif /* ACCEL_SERVICE_H_ */
