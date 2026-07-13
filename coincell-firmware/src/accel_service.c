/**
 * @file accel_service.c
 * @brief Coin-Cell Wireless Accelerometer GATT Service Implementation
 *
 * Architecture: Rev 3 - Supports both burst and continuous modes
 */

#include <string.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/crc.h>
#include <zephyr/settings/settings.h>

#include "accel_service.h"

#include <zephyr/bluetooth/hci.h>
#include <zephyr/bluetooth/hci_vs.h>
#include <zephyr/sys/byteorder.h>

LOG_MODULE_REGISTER(accel_svc, LOG_LEVEL_INF);

/*============================================================================
 * Configuration
 *===========================================================================*/

#define SAMPLING_RATE_HZ 1000

/*============================================================================
 * State Variables
 *===========================================================================*/

static bool data_notify_enabled = false;
static bool timestamp_notify_enabled = false;
static bool battery_notify_enabled = false;
static uint8_t battery_level_val = 0xFF;
static struct bt_conn *current_conn = NULL;
static operating_mode_t current_mode = MODE_CONTINUOUS_LAB;

/* Dynamic burst threshold (changeable via BLE write)
 * Set to SAMPLES_PER_PACKET (29) to use PATH A: direct TX with FIFO */
static uint16_t burst_threshold = 29; /* No-buffer mode: TX immediately when 1 packet (29 samples) is ready */

/* Cached attribute pointers - resolved at init, not hard-coded indices */
static const struct bt_gatt_attr *accel_data_attr = NULL;
static const struct bt_gatt_attr *timestamp_attr = NULL;
static const struct bt_gatt_attr *battery_attr = NULL;

/* External power detection stub - TODO: implement ADC check */
static bool external_power_detected = false;

/* TX Power state (default matches the static config of -8 dBm) */
static int8_t current_tx_power_dbm = -8;
/*============================================================================
 * Static Metadata
 *===========================================================================*/

static uint16_t sampling_rate = SAMPLING_RATE_HZ;
static uint32_t current_timestamp = 0;

static sensor_metadata_t sensor_meta = {
    .sensor_name = "ISRO_Phase3_Accel",
    .range_g = 16,
    .unit = "g",
    .h3lis_status = 0,
    .mpu_status = 0};

/*============================================================================
 * CCC Callbacks
 *===========================================================================*/

/* Weak callbacks that main.c can override */
__attribute__((weak)) void accel_service_on_notify_enabled(void) {}
__attribute__((weak)) void accel_service_on_notify_disabled(void) {}

static void accel_data_ccc_changed(const struct bt_gatt_attr *attr,
                                   uint16_t value) {
  bool was_enabled = data_notify_enabled;
  data_notify_enabled = (value == BT_GATT_CCC_NOTIFY);
  LOG_INF("Acceleration Data notifications %s",
          data_notify_enabled ? "ENABLED" : "DISABLED");

  /* Call notification callbacks for burst control */
  if (data_notify_enabled && !was_enabled) {
    accel_service_on_notify_enabled();
  } else if (!data_notify_enabled && was_enabled) {
    accel_service_on_notify_disabled();
  }
}

static void timestamp_ccc_changed(const struct bt_gatt_attr *attr,
                                  uint16_t value) {
  timestamp_notify_enabled = (value == BT_GATT_CCC_NOTIFY);
  LOG_INF("Timestamp notifications %s",
          timestamp_notify_enabled ? "enabled" : "disabled");
}

/*============================================================================
 * Read Callbacks
 *===========================================================================*/

static ssize_t read_timestamp(struct bt_conn *conn,
                              const struct bt_gatt_attr *attr, void *buf,
                              uint16_t len, uint16_t offset) {
  current_timestamp = (uint32_t)k_uptime_get();
  return bt_gatt_attr_read(conn, attr, buf, len, offset, &current_timestamp,
                           sizeof(current_timestamp));
}

static void battery_ccc_changed(const struct bt_gatt_attr *attr, uint16_t value) {
  battery_notify_enabled = (value == BT_GATT_CCC_NOTIFY);
}

static ssize_t read_battery_level(struct bt_conn *conn,
                                  const struct bt_gatt_attr *attr, void *buf,
                                  uint16_t len, uint16_t offset) {
  return bt_gatt_attr_read(conn, attr, buf, len, offset, &battery_level_val,
                           sizeof(battery_level_val));
}

static ssize_t read_sampling_rate(struct bt_conn *conn,
                                  const struct bt_gatt_attr *attr, void *buf,
                                  uint16_t len, uint16_t offset) {
  return bt_gatt_attr_read(conn, attr, buf, len, offset, &sampling_rate,
                           sizeof(sampling_rate));
}

static ssize_t write_sampling_rate(struct bt_conn *conn,
                                   const struct bt_gatt_attr *attr,
                                   const void *buf, uint16_t len,
                                   uint16_t offset, uint8_t flags) {
  if (len != sizeof(uint16_t)) {
    return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
  }

  uint16_t requested = ((const uint8_t *)buf)[0] | (((const uint8_t *)buf)[1] << 8);

  int err = accel_service_save_sampling_rate(requested);
  if (err) {
    return BT_GATT_ERR(BT_ATT_ERR_WRITE_NOT_PERMITTED);
  }

  return len;
}

static ssize_t read_sensor_meta(struct bt_conn *conn,
                                const struct bt_gatt_attr *attr, void *buf,
                                uint16_t len, uint16_t offset) {
  return bt_gatt_attr_read(conn, attr, buf, len, offset, &sensor_meta,
                           sizeof(sensor_meta));
}

void accel_service_update_meta_range(uint16_t range) {
  sensor_meta.range_g = (int16_t)range;
  LOG_INF("BLE sensor_meta.range_g updated to %d", sensor_meta.range_g);
}

void accel_service_update_sensor_status(uint8_t h3lis_ok, uint8_t mpu_ok) {
  sensor_meta.h3lis_status = h3lis_ok;
  sensor_meta.mpu_status = mpu_ok;
  LOG_INF("BLE sensor_meta status updated: H3LIS=%d, MPU=%d", h3lis_ok, mpu_ok);
}

void accel_service_update_sensor_name(const char *name) {
  strncpy(sensor_meta.sensor_name, name, sizeof(sensor_meta.sensor_name) - 1);
  sensor_meta.sensor_name[sizeof(sensor_meta.sensor_name) - 1] = '\0';
  LOG_INF("BLE sensor_meta.sensor_name updated to %s", sensor_meta.sensor_name);
}

static ssize_t read_operating_mode(struct bt_conn *conn,
                                   const struct bt_gatt_attr *attr, void *buf,
                                   uint16_t len, uint16_t offset) {
  uint8_t mode_byte = BUFFER_MODE_NONE; // default 0x10
  
  if (burst_threshold <= 29) {
    mode_byte = BUFFER_MODE_NONE; // 0x10
  } else {
    static const uint16_t duration_ms[] = { 300, 1000, 2000, 5000, 10000 };
    uint32_t best_diff = 999999;
    uint8_t best_mode = BUFFER_MODE_300MS; // default 0x11
    
    for (int i = 0; i < 5; i++) {
      uint32_t target_thresh = ((uint32_t)duration_ms[i] * (uint32_t)sampling_rate) / 1000;
      if (target_thresh > RING_BUFFER_SAMPLES) {
        target_thresh = RING_BUFFER_SAMPLES;
      }
      if (target_thresh < 29) {
        target_thresh = 29;
      }
      uint32_t diff = (burst_threshold > target_thresh) ? (burst_threshold - target_thresh) : (target_thresh - burst_threshold);
      if (diff < best_diff) {
        best_diff = diff;
        best_mode = BUFFER_MODE_300MS + i;
      }
    }
    mode_byte = best_mode;
  }

  return bt_gatt_attr_read(conn, attr, buf, len, offset, &mode_byte,
                           sizeof(mode_byte));
}

static ssize_t write_operating_mode(struct bt_conn *conn,
                                    const struct bt_gatt_attr *attr,
                                    const void *buf, uint16_t len,
                                    uint16_t offset, uint8_t flags) {
  if (len != 1) {
    return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
  }

  uint8_t requested = ((const uint8_t *)buf)[0];

  /* Handle operating and buffer mode commands */
  if (requested == MODE_CONTINUOUS_LAB) {
    if (!external_power_detected) {
      LOG_WRN("Rejecting CONTINUOUS mode: no external power");
      return BT_GATT_ERR(BT_ATT_ERR_WRITE_NOT_PERMITTED);
    }
    current_mode = MODE_CONTINUOUS_LAB;
    LOG_INF("Mode switched to CONTINUOUS (Lab)");
  } else if (requested == MODE_COINCELL_BURST) {
    current_mode = MODE_COINCELL_BURST;
    LOG_INF("Mode switched to BURST (Coin-cell)");
  } else if (requested == BUFFER_MODE_NONE) {
    /* No buffer — 29 samples = 1 packet, immediate TX */
    int err = accel_service_save_burst_threshold(29);
    if (err) {
      return BT_GATT_ERR(BT_ATT_ERR_UNLIKELY);
    }
  } else if (requested >= BUFFER_MODE_300MS && requested <= BUFFER_MODE_10S) {
    /* Time-based buffer modes: compute threshold from duration and sampling rate */
    static const uint16_t duration_ms[] = { 300, 1000, 2000, 5000, 10000 };
    uint16_t idx = requested - BUFFER_MODE_300MS; /* 0..4 */
    uint32_t threshold = ((uint32_t)duration_ms[idx] * sampling_rate) / 1000;
    if (threshold > RING_BUFFER_SAMPLES) {
      threshold = RING_BUFFER_SAMPLES;
    }
    if (threshold < 29) {
      threshold = 29; /* Minimum 1 packet */
    }
    int err = accel_service_save_burst_threshold((uint16_t)threshold);
    if (err) {
      return BT_GATT_ERR(BT_ATT_ERR_UNLIKELY);
    }
  } else if (requested == 0x20) {
    int err = accel_service_save_sensor_range(100);
    if (err) {
      return BT_GATT_ERR(BT_ATT_ERR_UNLIKELY);
    }
  } else if (requested == 0x21) {
    int err = accel_service_save_sensor_range(200);
    if (err) {
      return BT_GATT_ERR(BT_ATT_ERR_UNLIKELY);
    }
  } else if (requested == 0x22) {
    int err = accel_service_save_sensor_range(400);
    if (err) {
      return BT_GATT_ERR(BT_ATT_ERR_UNLIKELY);
    }
  } else if (requested == 0x23) {
    int err = accel_service_save_sensor_range(16);
    if (err) {
      return BT_GATT_ERR(BT_ATT_ERR_UNLIKELY);
    }
  } else if (requested == 0x24) {
    int err = accel_service_save_sensor_range(8);
    if (err) {
      return BT_GATT_ERR(BT_ATT_ERR_UNLIKELY);
    }
  } else if (requested == 0x25) {
    int err = accel_service_save_sensor_range(4);
    if (err) {
      return BT_GATT_ERR(BT_ATT_ERR_UNLIKELY);
    }
  } else if (requested == 0x26) {
    int err = accel_service_save_sensor_range(2);
    if (err) {
      return BT_GATT_ERR(BT_ATT_ERR_UNLIKELY);
    }
  } else {
    LOG_WRN("Unknown BLE command received: 0x%02X", requested);
    return BT_GATT_ERR(BT_ATT_ERR_WRITE_NOT_PERMITTED);
  }

  return len;
}

/*============================================================================
 * TX Power Read/Write Callbacks
 *===========================================================================*/

static ssize_t read_tx_power(struct bt_conn *conn,
                              const struct bt_gatt_attr *attr, void *buf,
                              uint16_t len, uint16_t offset) {
  return bt_gatt_attr_read(conn, attr, buf, len, offset, &current_tx_power_dbm,
                           sizeof(current_tx_power_dbm));
}

static ssize_t write_tx_power(struct bt_conn *conn,
                               const struct bt_gatt_attr *attr,
                               const void *buf, uint16_t len,
                               uint16_t offset, uint8_t flags) {
  if (len != 1) {
    return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
  }

  int8_t requested_dbm = (int8_t)((const uint8_t *)buf)[0];
  LOG_INF("TX Power write request: %d dBm", requested_dbm);

  if (requested_dbm != 3 && requested_dbm != 0 && requested_dbm != -8 && requested_dbm != -12) {
    LOG_WRN("Invalid TX Power requested: %d dBm (only +3, 0, -8, -12 are configurable)", requested_dbm);
    return BT_GATT_ERR(BT_ATT_ERR_WRITE_NOT_PERMITTED);
  }

  int err = accel_service_save_tx_power(requested_dbm);
  if (err) {
    LOG_ERR("Failed to set TX power: %d", err);
    return BT_GATT_ERR(BT_ATT_ERR_UNLIKELY);
  }

  return len;
}

/*============================================================================
 * GATT Service Definition
 *===========================================================================*/

BT_GATT_SERVICE_DEFINE(
    accel_svc,
    /* Primary Service Declaration */
    BT_GATT_PRIMARY_SERVICE(ACCEL_SERVICE_UUID),

    /* Acceleration Data Characteristic (NOTIFY only) */
    BT_GATT_CHARACTERISTIC(ACCEL_DATA_CHAR_UUID, BT_GATT_CHRC_NOTIFY,
                           BT_GATT_PERM_NONE, NULL, NULL, NULL),
    BT_GATT_CCC(accel_data_ccc_changed, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),

    /* Timestamp Characteristic (READ | NOTIFY) */
    BT_GATT_CHARACTERISTIC(TIMESTAMP_CHAR_UUID,
                           BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
                           BT_GATT_PERM_READ, read_timestamp, NULL, NULL),
    BT_GATT_CCC(timestamp_ccc_changed, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),

    /* Sampling Rate Characteristic (READ | WRITE) */
    BT_GATT_CHARACTERISTIC(SAMPLE_RATE_CHAR_UUID,
                           BT_GATT_CHRC_READ | BT_GATT_CHRC_WRITE,
                           BT_GATT_PERM_READ | BT_GATT_PERM_WRITE,
                           read_sampling_rate, write_sampling_rate, NULL),

    /* Sensor Metadata Characteristic (READ only) */
    BT_GATT_CHARACTERISTIC(SENSOR_META_CHAR_UUID, BT_GATT_CHRC_READ,
                           BT_GATT_PERM_READ, read_sensor_meta, NULL, NULL),

    /* Operating Mode Characteristic (READ | WRITE) */
    BT_GATT_CHARACTERISTIC(OPERATING_MODE_CHAR_UUID,
                           BT_GATT_CHRC_READ | BT_GATT_CHRC_WRITE,
                           BT_GATT_PERM_READ | BT_GATT_PERM_WRITE,
                           read_operating_mode, write_operating_mode, NULL),

    /* TX Power Control Characteristic (READ | WRITE) */
    BT_GATT_CHARACTERISTIC(TX_POWER_CHAR_UUID,
                           BT_GATT_CHRC_READ | BT_GATT_CHRC_WRITE,
                           BT_GATT_PERM_READ | BT_GATT_PERM_WRITE,
                           read_tx_power, write_tx_power, NULL),

    /* Custom Battery Level Characteristic (READ | NOTIFY) */
    BT_GATT_CHARACTERISTIC(BATTERY_CHAR_UUID,
                           BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
                           BT_GATT_PERM_READ,
                           read_battery_level, NULL, NULL),
    BT_GATT_CCC(battery_ccc_changed, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
);

/*============================================================================
 * API Implementation
 *===========================================================================*/

int accel_service_init(void) {
  /* Resolve attribute pointers to avoid hard-coded indices */
  accel_data_attr = bt_gatt_find_by_uuid(accel_svc.attrs, accel_svc.attr_count,
                                         ACCEL_DATA_CHAR_UUID);
  timestamp_attr = bt_gatt_find_by_uuid(accel_svc.attrs, accel_svc.attr_count,
                                        TIMESTAMP_CHAR_UUID);
  battery_attr = bt_gatt_find_by_uuid(accel_svc.attrs, accel_svc.attr_count,
                                      BATTERY_CHAR_UUID);

  if (!accel_data_attr || !timestamp_attr || !battery_attr) {
    LOG_ERR("Failed to find GATT attributes");
    return -EINVAL;
  }

  LOG_INF("Accelerometer GATT Service initialized (Rev 3)");
  LOG_INF("  Sample size: %u bytes", ACCEL_SAMPLE_SIZE);
  LOG_INF("  Packet size: %u bytes (%u samples)", ACCEL_PACKET_SIZE,
          SAMPLES_PER_PACKET);
  LOG_INF("  Packets per burst: %u", PACKETS_PER_BURST);
  LOG_INF("  Initial mode: %s",
          current_mode == MODE_COINCELL_BURST ? "BURST" : "CONTINUOUS");

  /* Explicitly set default TX power to -8 dBm on reset */
  accel_service_set_tx_power(-8);

  /* Initialize sensor metadata range to current sensor range */
  sensor_meta.range_g = (int16_t)accel_service_get_sensor_range();

  return 0;
}

int accel_service_notify_packet(struct bt_conn *conn,
                                const accel_packet_t *packet) {
  if (!data_notify_enabled) {
    return -ENOTCONN;
  }

  struct bt_conn *target = conn ? conn : current_conn;
  if (!target) {
    return -ENOTCONN;
  }

  /* Packet already includes CRC, just send it */
  return bt_gatt_notify(target, accel_data_attr, packet, ACCEL_PACKET_SIZE);
}

int accel_service_notify_timestamp(struct bt_conn *conn, uint32_t uptime_ms) {
  if (!timestamp_notify_enabled) {
    return -ENOTCONN;
  }

  struct bt_conn *target = conn ? conn : current_conn;
  if (!target) {
    return -ENOTCONN;
  }

  return bt_gatt_notify(target, timestamp_attr, &uptime_ms, sizeof(uptime_ms));
}

bool accel_service_data_notify_enabled(void) {
  return data_notify_enabled && (current_conn != NULL);
}

const struct bt_gatt_attr *accel_service_get_data_attr(void) {
  return accel_data_attr;
}

struct bt_conn *accel_service_get_conn(void) {
  return current_conn;
}

void accel_service_set_conn(struct bt_conn *conn) {
  if (current_conn) {
    bt_conn_unref(current_conn);
  }
  current_conn = conn ? bt_conn_ref(conn) : NULL;

  if (!current_conn) {
    /* Reset CCC state on disconnect to ensure safety */
    data_notify_enabled = false;
    timestamp_notify_enabled = false;
    LOG_INF("CCC state reset on disconnect");
  } else {
    /* Apply cached TX power level to the new connection handle */
    accel_service_set_tx_power(current_tx_power_dbm);
  }
}

operating_mode_t accel_service_get_mode(void) { return current_mode; }

int accel_service_set_mode(operating_mode_t mode, bool power_detected) {
  /* Update static state for GATT callbacks */
  external_power_detected = power_detected;

  if (mode == MODE_CONTINUOUS_LAB && !external_power_detected) {
    LOG_WRN("Cannot switch to CONTINUOUS mode without external power");
    return -EPERM;
  }

  current_mode = mode;
  LOG_INF("Operating mode set to %s",
          mode == MODE_COINCELL_BURST ? "BURST" : "CONTINUOUS");
  return 0;
}

void accel_service_set_power_detected(bool detected) {
  external_power_detected = detected;
  if (!detected && current_mode == MODE_CONTINUOUS_LAB) {
    LOG_WRN("External power lost, reverting to BURST mode");
    current_mode = MODE_COINCELL_BURST;
  }
}

uint16_t accel_service_get_burst_threshold(void) { return burst_threshold; }

/*============================================================================
 * Dynamic TX Power Control via HCI Vendor-Specific Commands
 *===========================================================================*/

int accel_service_set_tx_power(int8_t tx_power_dbm) {
  struct bt_hci_cp_vs_write_tx_power_level *cp;
  struct bt_hci_rp_vs_write_tx_power_level *rp;
  struct net_buf *buf, *rsp = NULL;
  int err;

  /* Set TX power for advertising handle */
  buf = bt_hci_cmd_create(BT_HCI_OP_VS_WRITE_TX_POWER_LEVEL, sizeof(*cp));
  if (!buf) {
    LOG_ERR("Unable to allocate HCI command buffer for ADV TX power");
    return -ENOMEM;
  }

  cp = net_buf_add(buf, sizeof(*cp));
  cp->handle = sys_cpu_to_le16(0);  /* ADV handle = 0 */
  cp->handle_type = BT_HCI_VS_LL_HANDLE_TYPE_ADV;
  cp->tx_power_level = tx_power_dbm;

  err = bt_hci_cmd_send_sync(BT_HCI_OP_VS_WRITE_TX_POWER_LEVEL, buf, &rsp);
  if (err) {
    LOG_ERR("Failed to set ADV TX power: %d", err);
  } else {
    rp = (void *)rsp->data;
    LOG_INF("ADV TX power set: requested=%d dBm, selected=%d dBm",
            tx_power_dbm, rp->selected_tx_power);
    net_buf_unref(rsp);
    rsp = NULL;
  }

  /* Set TX power for connection handle (if connected) */
  if (current_conn) {
    uint16_t conn_handle;
    err = bt_hci_get_conn_handle(current_conn, &conn_handle);
    if (err) {
      LOG_ERR("Failed to get connection handle: %d", err);
    } else {
      buf = bt_hci_cmd_create(BT_HCI_OP_VS_WRITE_TX_POWER_LEVEL, sizeof(*cp));
      if (!buf) {
        LOG_ERR("Unable to allocate HCI command buffer for CONN TX power");
        return -ENOMEM;
      }

      cp = net_buf_add(buf, sizeof(*cp));
      cp->handle = sys_cpu_to_le16(conn_handle);
      cp->handle_type = BT_HCI_VS_LL_HANDLE_TYPE_CONN;
      cp->tx_power_level = tx_power_dbm;

      err = bt_hci_cmd_send_sync(BT_HCI_OP_VS_WRITE_TX_POWER_LEVEL, buf, &rsp);
      if (err) {
        LOG_ERR("Failed to set CONN TX power: %d", err);
      } else {
        rp = (void *)rsp->data;
        LOG_INF("CONN TX power set: requested=%d dBm, selected=%d dBm",
                tx_power_dbm, rp->selected_tx_power);
        current_tx_power_dbm = rp->selected_tx_power;
        net_buf_unref(rsp);
        rsp = NULL;
      }
    }
  } else {
    /* No active connection, just update the cached value */
    current_tx_power_dbm = tx_power_dbm;
  }

  return 0;
}

int8_t accel_service_get_tx_power(void) { return current_tx_power_dbm; }

int accel_service_save_tx_power(int8_t tx_power_dbm) {
  int err = accel_service_set_tx_power(tx_power_dbm);
  if (err == 0) {
#if IS_ENABLED(CONFIG_SETTINGS)
    int8_t current_val = accel_service_get_tx_power();
    settings_save_one("app/tx_power", &current_val, sizeof(current_val));
    LOG_INF("Saved tx_power to settings: %d", current_val);
#endif
  }
  return err;
}

int accel_service_set_sampling_rate(uint16_t rate) {
  if (rate != 1024 && rate != 2000 && rate != 3000 && rate != 4000 && rate != 5000) {
    LOG_ERR("Invalid sampling rate requested: %u Hz", rate);
    return -EINVAL;
  }
  sampling_rate = rate;
  LOG_INF("Sampling rate set to %u Hz", rate);

  /* Trigger dynamic timer restart if streaming is active */
  extern void accel_service_restart_timer(void);
  accel_service_restart_timer();

  return 0;
}

int accel_service_save_sampling_rate(uint16_t rate) {
  int err = accel_service_set_sampling_rate(rate);
  if (err == 0) {
#if IS_ENABLED(CONFIG_SETTINGS)
    uint16_t current_val = accel_service_get_sampling_rate();
    settings_save_one("app/sampling_rate", &current_val, sizeof(current_val));
    LOG_INF("Saved sampling_rate to settings: %u", current_val);
#endif
  }
  return err;
}

uint16_t accel_service_get_sampling_rate(void) {
  return sampling_rate;
}

uint32_t accel_service_get_rtc_tick_interval(void) {
  /* RTC0 runs at 32768 Hz. Only 1024 Hz divides evenly: 32768/1024 = 32 */
  return 32;
}

uint32_t accel_service_get_timer1_interval(void) {
  /* TIMER1 runs at 16 MHz. Returns ticks for one sample period. */
  if (sampling_rate == 0) return 16000; /* fallback: 1 kHz */
  return 16000000U / sampling_rate;
}

bool accel_service_use_hf_timer(void) {
  return sampling_rate > 1024;
}

int accel_service_set_burst_threshold(uint16_t threshold) {
  if (threshold < 1 || threshold > RING_BUFFER_SAMPLES) {
    LOG_ERR("Invalid burst threshold: %u (max %u)", threshold, RING_BUFFER_SAMPLES);
    return -EINVAL;
  }
  burst_threshold = threshold;
  LOG_INF("Burst threshold (buffer mode) set to %u", burst_threshold);
  return 0;
}

int accel_service_save_burst_threshold(uint16_t threshold) {
  int err = accel_service_set_burst_threshold(threshold);
  if (err == 0) {
#if IS_ENABLED(CONFIG_SETTINGS)
    uint16_t current_val = accel_service_get_burst_threshold();
    settings_save_one("app/burst_threshold", &current_val, sizeof(current_val));
    LOG_INF("Saved burst_threshold to settings: %u", current_val);
#endif
  }
  return err;
}

void accel_service_update_battery_level(uint8_t percent) {
  battery_level_val = percent;

  if (battery_notify_enabled && current_conn) {
    int err = bt_gatt_notify(current_conn, battery_attr, &battery_level_val, sizeof(battery_level_val));
    if (err) {
      LOG_DBG("Failed to notify battery level: %d", err);
    }
  }
}
