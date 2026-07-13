/**
 * @file link_monitor.h
 * @brief BLE Link Monitor for Dynamic MTU & Congestion Detection
 *
 * Monitors BLE connection health and signals congestion state.
 * Enables adaptive behavior based on link quality.
 */

#ifndef LINK_MONITOR_H_
#define LINK_MONITOR_H_

#include <stdbool.h>
#include <stdint.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/kernel.h>

/*============================================================================
 * Link Status
 *===========================================================================*/

typedef enum {
  LINK_STATE_DISCONNECTED, /* No BLE connection */
  LINK_STATE_CONNECTING,   /* Connection in progress */
  LINK_STATE_CONNECTED,    /* Connected, negotiating MTU */
  LINK_STATE_READY,        /* MTU ready, normal operation */
  LINK_STATE_CONGESTED,    /* TX queue backing up */
  LINK_STATE_CRITICAL,     /* Severe congestion, flash logging */
} link_state_t;

typedef struct {
  /* Connection parameters */
  uint16_t mtu;              /* Current MTU */
  uint16_t conn_interval_ms; /* Connection interval in ms (×1.25) */
  uint16_t latency;          /* Slave latency */

  /* Throughput metrics */
  uint32_t packets_sent;     /* Total packets sent */
  uint32_t packets_failed;   /* Failed TX attempts */
  uint32_t bytes_per_second; /* Calculated throughput */

  /* Congestion metrics */
  uint8_t tx_queue_depth;       /* Current TX queue utilization */
  uint8_t congestion_level;     /* 0-100% congestion */
  uint32_t last_sample_time_ms; /* For throughput calculation */

  /* State */
  link_state_t state;
} link_status_t;

/*============================================================================
 * Link Monitor API
 *===========================================================================*/

/**
 * @brief Initialize link monitor
 */
void link_monitor_init(void);

/**
 * @brief Called when connection is established
 */
void link_monitor_on_connected(struct bt_conn *conn);

/**
 * @brief Called when connection is lost
 */
void link_monitor_on_disconnected(void);

/**
 * @brief Called when MTU exchange completes
 */
void link_monitor_on_mtu_updated(uint16_t mtu);

/**
 * @brief Called when connection parameters are updated
 */
void link_monitor_on_params_updated(uint16_t interval, uint16_t latency);

/**
 * @brief Called after each TX attempt
 * @param success true if TX succeeded
 */
void link_monitor_on_tx(bool success);

/**
 * @brief Get current link status
 */
link_status_t link_monitor_get_status(void);

/**
 * @brief Check if link is congested (should use flash logging)
 */
bool link_monitor_is_congested(void);

/**
 * @brief Check if link is ready for normal TX
 */
bool link_monitor_is_ready(void);

/**
 * @brief Get recommended buffer depth based on link quality
 * @return Recommended ring buffer samples
 */
uint16_t link_monitor_get_recommended_buffer(void);

/**
 * @brief Get status as packed bytes for BLE characteristic
 * @param buf Buffer to fill (at least 16 bytes)
 * @return Number of bytes written
 */
int link_monitor_get_status_bytes(uint8_t *buf, size_t len);

#endif /* LINK_MONITOR_H_ */
