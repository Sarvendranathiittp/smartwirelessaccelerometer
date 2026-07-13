/**
 * @file link_monitor.c
 * @brief BLE Link Monitor Implementation
 *
 * Tracks connection health, detects congestion, and signals when
 * to use flash logging for zero data loss.
 */

#include "link_monitor.h"

#include <string.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(link_monitor, LOG_LEVEL_INF);

/*============================================================================
 * Congestion Thresholds
 *===========================================================================*/

#define TX_FAIL_THRESHOLD 5    /* Failures before congested */
#define TX_FAIL_CRITICAL 20    /* Failures before critical */
#define CONGESTION_DECAY 1     /* Reduce congestion per success */
#define MIN_THROUGHPUT_BPS 500 /* Below this = congested */

/* Recommended buffer sizes based on link quality */
#define BUFFER_SIZE_FAST_LINK 512  /* Good link: small buffer */
#define BUFFER_SIZE_SLOW_LINK 1024 /* Slow link: larger buffer */
#define BUFFER_SIZE_CONGESTED 2048 /* Congested: maximum buffer */

/*============================================================================
 * Module State
 *===========================================================================*/

static link_status_t status = {
    .mtu = 23,
    .conn_interval_ms = 0,
    .latency = 0,
    .packets_sent = 0,
    .packets_failed = 0,
    .bytes_per_second = 0,
    .tx_queue_depth = 0,
    .congestion_level = 0,
    .last_sample_time_ms = 0,
    .state = LINK_STATE_DISCONNECTED,
};

static uint32_t window_start_ms = 0;
static uint32_t window_packets = 0;
static uint32_t consecutive_failures = 0;

/*============================================================================
 * Public API
 *===========================================================================*/

void link_monitor_init(void) {
  memset(&status, 0, sizeof(status));
  status.state = LINK_STATE_DISCONNECTED;
  status.mtu = 23;
  window_start_ms = 0;
  window_packets = 0;
  consecutive_failures = 0;
  LOG_INF("Link monitor initialized");
}

void link_monitor_on_connected(struct bt_conn *conn) {
  ARG_UNUSED(conn);
  status.state = LINK_STATE_CONNECTING;
  status.packets_sent = 0;
  status.packets_failed = 0;
  status.congestion_level = 0;
  consecutive_failures = 0;
  window_start_ms = k_uptime_get_32();
  window_packets = 0;
  LOG_INF("Link: connected, negotiating MTU...");
}

void link_monitor_on_disconnected(void) {
  status.state = LINK_STATE_DISCONNECTED;
  status.mtu = 23;
  status.conn_interval_ms = 0;
  LOG_INF("Link: disconnected");
}

void link_monitor_on_mtu_updated(uint16_t mtu) {
  status.mtu = mtu;

  if (mtu >= 246) {
    status.state = LINK_STATE_READY;
    LOG_INF("Link: MTU %u bytes - READY", mtu);
  } else {
    status.state = LINK_STATE_CONNECTED;
    LOG_WRN("Link: MTU %u bytes - too small for 239B packets", mtu);
  }
}

void link_monitor_on_params_updated(uint16_t interval, uint16_t latency) {
  status.conn_interval_ms = (interval * 125) / 100; /* 1.25ms units */
  status.latency = latency;

  LOG_INF("Link params: interval=%u ms, latency=%u", status.conn_interval_ms,
          latency);

  /* Faster intervals are better */
  if (status.conn_interval_ms <= 15) {
    LOG_INF("Link: Fast connection interval - good for streaming");
  } else if (status.conn_interval_ms <= 50) {
    LOG_WRN("Link: Medium interval - may see some congestion");
  } else {
    LOG_WRN("Link: Slow interval - expect congestion, using flash buffer");
  }
}

void link_monitor_on_tx(bool success) {
  status.packets_sent++;
  window_packets++;

  if (success) {
    /* Decay congestion on success */
    if (consecutive_failures > 0) {
      consecutive_failures--;
    }
    if (status.congestion_level > 0) {
      status.congestion_level -= CONGESTION_DECAY;
    }

    /* Exit congested state if cleared */
    if (status.state == LINK_STATE_CONGESTED && status.congestion_level < 20) {
      status.state = LINK_STATE_READY;
      LOG_INF("Link: Congestion cleared");
    }
    if (status.state == LINK_STATE_CRITICAL && consecutive_failures == 0) {
      status.state = LINK_STATE_CONGESTED;
    }
  } else {
    /* Increase congestion on failure */
    status.packets_failed++;
    consecutive_failures++;

    if (status.congestion_level < 100) {
      status.congestion_level += 5;
    }

    /* Escalate state based on failures */
    if (consecutive_failures >= TX_FAIL_CRITICAL) {
      if (status.state != LINK_STATE_CRITICAL) {
        status.state = LINK_STATE_CRITICAL;
        LOG_ERR("Link: CRITICAL - switching to flash logging");
      }
    } else if (consecutive_failures >= TX_FAIL_THRESHOLD) {
      if (status.state == LINK_STATE_READY) {
        status.state = LINK_STATE_CONGESTED;
        LOG_WRN("Link: CONGESTED - %u failures", consecutive_failures);
      }
    }
  }

  /* Calculate throughput every second */
  uint32_t now = k_uptime_get_32();
  if (now - window_start_ms >= 1000) {
    status.bytes_per_second = window_packets * 239; /* Packet size */
    window_packets = 0;
    window_start_ms = now;
  }
}

link_status_t link_monitor_get_status(void) { return status; }

bool link_monitor_is_congested(void) {
  return (status.state == LINK_STATE_CONGESTED ||
          status.state == LINK_STATE_CRITICAL ||
          status.state == LINK_STATE_DISCONNECTED);
}

bool link_monitor_is_ready(void) { return (status.state == LINK_STATE_READY); }

uint16_t link_monitor_get_recommended_buffer(void) {
  switch (status.state) {
  case LINK_STATE_READY:
    if (status.conn_interval_ms <= 15) {
      return BUFFER_SIZE_FAST_LINK;
    }
    return BUFFER_SIZE_SLOW_LINK;

  case LINK_STATE_CONGESTED:
  case LINK_STATE_CRITICAL:
    return BUFFER_SIZE_CONGESTED;

  default:
    return BUFFER_SIZE_SLOW_LINK;
  }
}

int link_monitor_get_status_bytes(uint8_t *buf, size_t len) {
  if (len < 16) {
    return -EINVAL;
  }

  /* Pack status into bytes for BLE characteristic */
  buf[0] = (uint8_t)status.state;
  buf[1] = status.congestion_level;
  buf[2] = (status.mtu >> 8) & 0xFF;
  buf[3] = status.mtu & 0xFF;
  buf[4] = (status.conn_interval_ms >> 8) & 0xFF;
  buf[5] = status.conn_interval_ms & 0xFF;
  buf[6] = (status.bytes_per_second >> 24) & 0xFF;
  buf[7] = (status.bytes_per_second >> 16) & 0xFF;
  buf[8] = (status.bytes_per_second >> 8) & 0xFF;
  buf[9] = status.bytes_per_second & 0xFF;
  buf[10] = (status.packets_failed >> 24) & 0xFF;
  buf[11] = (status.packets_failed >> 16) & 0xFF;
  buf[12] = (status.packets_failed >> 8) & 0xFF;
  buf[13] = status.packets_failed & 0xFF;
  buf[14] = 0; /* Reserved */
  buf[15] = 0; /* Reserved */

  return 16;
}
