/**
 * @file gatt_client.h
 * @brief BLE GATT Client for ISRO Accelerometer Service
 *
 * Handles service discovery, characteristic lookup, and
 * notification subscription on the nRF5340 peripheral.
 */

#pragma once

#include <stdbool.h>
#include <stdint.h>

/* Forward declaration for NimBLE mbuf */
struct os_mbuf;

/**
 * @brief Callback for received accelerometer notification data
 *
 * @param data   Raw notification payload (239-byte accel_packet_t)
 * @param length Length of the payload
 */
typedef void (*accel_notify_cb_t)(const uint8_t *data, uint16_t length);

/**
 * @brief Initialize GATT client and register notification callback
 */
void gatt_client_init(accel_notify_cb_t callback);

/**
 * @brief Start service discovery on a connected peer
 *
 * Called automatically after GAP connect. Discovers the custom
 * accel service, finds the data characteristic, and subscribes
 * to notifications.
 *
 * @param conn_handle  BLE connection handle
 * @return 0 on success
 */
int gatt_client_discover(uint16_t conn_handle);

/**
 * @brief Write buffer mode to the peripheral
 *
 * @param conn_handle  BLE connection handle
 * @param mode         BUFFER_MODE_NONE / DEFAULT / DEEP
 * @return 0 on success
 */
int gatt_client_set_buffer_mode(uint16_t conn_handle, uint8_t mode);

/**
 * @brief Write command/mode byte to Operating Mode characteristic.
 * 
 * @param conn_handle Connection handle
 * @param command     Command byte (e.g. 0x00 for START, 0x01 for STOP)
 * @return 0 on success
 */
int gatt_client_write_mode(uint16_t conn_handle, uint8_t command);

/**
 * @brief Handle incoming BLE notification event
 *
 * Called from the GAP event handler when a NOTIFY_RX event arrives.
 *
 * @param conn_handle  BLE connection handle
 * @param attr_handle  Attribute handle that sent the notification
 * @param om           OS mbuf chain with notification payload
 * @param arg          User argument (unused)
 * @return 0 on success
 */
int gatt_client_on_notify(uint16_t conn_handle, uint16_t attr_handle,
                          struct os_mbuf *om, void *arg);
