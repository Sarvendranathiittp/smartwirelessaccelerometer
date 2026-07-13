/**
 * @file gatt_client.c
 * @brief BLE GATT Client — Service Discovery & Notification Handler
 *
 * Discovers the custom ISRO accel service on the nRF5340 peripheral,
 * finds the accel data characteristic, and subscribes to notifications.
 */

#include "esp_log.h"
#include "host/ble_gatt.h"
#include "host/ble_hs.h"
#include "host/ble_uuid.h"
#include <string.h>

#include "accel_protocol.h"
#include "gatt_client.h"

static const char *TAG = "gatt_client";

/*============================================================================
 * State
 *===========================================================================*/

static accel_notify_cb_t notify_callback = NULL;
static uint16_t accel_data_val_handle = 0;
static uint16_t accel_data_cccd_handle = 0;
static uint16_t op_mode_val_handle = 0;

/* GATT handle cache — skip full discovery on reconnection */
static bool handles_cached = false;
static uint16_t cached_val_handle = 0;
static uint16_t cached_cccd_handle = 0;

/* 128-bit UUIDs */
static const ble_uuid128_t accel_svc_uuid =
    BLE_UUID128_INIT(ACCEL_SERVICE_UUID_128);

static const ble_uuid128_t accel_data_chr_uuid =
    BLE_UUID128_INIT(ACCEL_DATA_CHAR_UUID_128);

static const ble_uuid128_t op_mode_chr_uuid =
    BLE_UUID128_INIT(OPERATING_MODE_CHAR_UUID_128);

/*============================================================================
 * Forward Declarations
 *===========================================================================*/

static int on_disc_svc(uint16_t conn_handle, const struct ble_gatt_error *error,
                       const struct ble_gatt_svc *service, void *arg);

static int on_disc_chr(uint16_t conn_handle, const struct ble_gatt_error *error,
                       const struct ble_gatt_chr *chr, void *arg);

static int on_disc_dsc(uint16_t conn_handle, const struct ble_gatt_error *error,
                       uint16_t chr_val_handle, const struct ble_gatt_dsc *dsc,
                       void *arg);

/*============================================================================
 * Notification Handler
 *===========================================================================*/

/**
 * Called by NimBLE when a notification arrives on a subscribed characteristic.
 */
int gatt_client_on_notify(uint16_t conn_handle, uint16_t attr_handle,
                          struct os_mbuf *om, void *arg) {
  uint16_t data_len = OS_MBUF_PKTLEN(om);

  if (data_len == 0) {
    return 0;
  }

  /* Copy notification data from mbuf chain */
  uint8_t buf[256];
  uint16_t copy_len = data_len < sizeof(buf) ? data_len : sizeof(buf);
  os_mbuf_copydata(om, 0, copy_len, buf);

  /* Forward to registered callback */
  if (notify_callback) {
    notify_callback(buf, copy_len);
  }

  return 0;
}

/*============================================================================
 * Service Discovery Chain
 *
 * Flow: discover_service → discover_chars → discover_descriptors → subscribe
 *===========================================================================*/

static uint16_t svc_start_handle = 0;
static uint16_t svc_end_handle = 0;

/**
 * Step 1: Discover the custom accel service by 128-bit UUID
 */
static int on_disc_svc(uint16_t conn_handle, const struct ble_gatt_error *error,
                       const struct ble_gatt_svc *service, void *arg) {
  if (error->status == 0) {
    ESP_LOGI(TAG, "Found accel service: handles %d-%d", service->start_handle,
             service->end_handle);
    svc_start_handle = service->start_handle;
    svc_end_handle = service->end_handle;
  } else if (error->status == BLE_HS_EDONE) {
    if (svc_start_handle == 0) {
      ESP_LOGE(TAG, "Accel service NOT found!");
      return 0;
    }
    /* Step 2: Discover characteristics within the service */
    ESP_LOGI(TAG, "Discovering characteristics...");
    int rc = ble_gattc_disc_all_chrs(conn_handle, svc_start_handle,
                                     svc_end_handle, on_disc_chr, NULL);
    if (rc != 0) {
      ESP_LOGE(TAG, "Char discovery failed: %d", rc);
    }
  } else {
    ESP_LOGE(TAG, "Service discovery error: %d", error->status);
  }
  return 0;
}

/**
 * Step 2: Find accel_data and operating_mode characteristics
 */
static int on_disc_chr(uint16_t conn_handle, const struct ble_gatt_error *error,
                       const struct ble_gatt_chr *chr, void *arg) {
  if (error->status == 0) {
    char uuid_str[BLE_UUID_STR_LEN];
    ble_uuid_to_str(&chr->uuid.u, uuid_str);

    if (ble_uuid_cmp(&chr->uuid.u, &accel_data_chr_uuid.u) == 0) {
      accel_data_val_handle = chr->val_handle;
      ESP_LOGI(TAG, "Found accel data char: val_handle=%d",
               accel_data_val_handle);
    } else if (ble_uuid_cmp(&chr->uuid.u, &op_mode_chr_uuid.u) == 0) {
      op_mode_val_handle = chr->val_handle;
      ESP_LOGI(TAG, "Found operating mode char: val_handle=%d",
               op_mode_val_handle);
    }
  } else if (error->status == BLE_HS_EDONE) {
    if (accel_data_val_handle == 0) {
      ESP_LOGE(TAG, "Accel data characteristic NOT found!");
      return 0;
    }
    /* Step 3: Discover descriptors for the accel data characteristic */
    ESP_LOGI(TAG, "Discovering descriptors for accel data...");
    int rc = ble_gattc_disc_all_dscs(conn_handle, accel_data_val_handle,
                                     svc_end_handle, on_disc_dsc, NULL);
    if (rc != 0) {
      ESP_LOGE(TAG, "Descriptor discovery failed: %d", rc);
    }
  } else {
    ESP_LOGE(TAG, "Char discovery error: %d", error->status);
  }
  return 0;
}

/**
 * Step 3: Find the CCCD and write 0x0001 to enable notifications
 */
static int on_disc_dsc(uint16_t conn_handle, const struct ble_gatt_error *error,
                       uint16_t chr_val_handle, const struct ble_gatt_dsc *dsc,
                       void *arg) {
  if (error->status == 0) {
    /* Look for the CCCD (UUID 0x2902) — only take the FIRST one */
    if (ble_uuid_u16(&dsc->uuid.u) == BLE_GATT_DSC_CLT_CFG_UUID16 &&
        accel_data_cccd_handle == 0) {
      accel_data_cccd_handle = dsc->handle;
      ESP_LOGI(TAG, "Found accel data CCCD: handle=%d", accel_data_cccd_handle);
    }
  } else if (error->status == BLE_HS_EDONE) {
    if (accel_data_cccd_handle == 0) {
      ESP_LOGE(TAG, "CCCD not found!");
      return 0;
    }

    /* Cache handles for instant reconnection */
    cached_val_handle = accel_data_val_handle;
    cached_cccd_handle = accel_data_cccd_handle;
    handles_cached = true;
    ESP_LOGI(TAG, "Handles cached: val=%d cccd=%d", cached_val_handle, cached_cccd_handle);

    /* Write 0x0001 to CCCD to enable notifications */
    ESP_LOGI(TAG, "Subscribing to notifications...");
    uint16_t notify_enable = 0x0001;
    int rc =
        ble_gattc_write_flat(conn_handle, accel_data_cccd_handle,
                             &notify_enable, sizeof(notify_enable), NULL, NULL);
    if (rc == 0) {
      ESP_LOGI(TAG, "*** Notifications ENABLED — streaming! ***");
    } else {
      ESP_LOGE(TAG, "CCCD write failed: %d", rc);
    }
  } else {
    ESP_LOGE(TAG, "Descriptor discovery error: %d", error->status);
  }
  return 0;
}

/*============================================================================
 * Public API
 *===========================================================================*/

void gatt_client_init(accel_notify_cb_t callback) {
  notify_callback = callback;
  accel_data_val_handle = 0;
  accel_data_cccd_handle = 0;
  op_mode_val_handle = 0;
  svc_start_handle = 0;
  svc_end_handle = 0;
}

int gatt_client_discover(uint16_t conn_handle) {
  /* Fast path: if handles are cached from a previous connection, skip
   * the entire 3-step GATT discovery chain and write CCCD directly.
   * This saves ~300ms of round-trip GATT discovery overhead. */
  if (handles_cached) {
    ESP_LOGW(TAG, "Using cached handles (val=%d cccd=%d) — skipping discovery!",
             cached_val_handle, cached_cccd_handle);
    accel_data_val_handle = cached_val_handle;
    accel_data_cccd_handle = cached_cccd_handle;

    uint16_t notify_enable = 0x0001;
    int rc = ble_gattc_write_flat(conn_handle, cached_cccd_handle,
                                  &notify_enable, sizeof(notify_enable), NULL, NULL);
    if (rc == 0) {
      ESP_LOGW(TAG, "*** Notifications ENABLED (cached) — streaming! ***");
    } else {
      ESP_LOGE(TAG, "Cached CCCD write failed: %d — falling back to full discovery", rc);
      handles_cached = false;
      /* Fall through to full discovery below */
    }
    if (rc == 0) return 0;
  }

  ESP_LOGI(TAG, "Starting full service discovery...");
  accel_data_val_handle = 0;
  accel_data_cccd_handle = 0;
  op_mode_val_handle = 0;
  svc_start_handle = 0;
  svc_end_handle = 0;

  return ble_gattc_disc_svc_by_uuid(conn_handle, &accel_svc_uuid.u, on_disc_svc,
                                    NULL);
}

int gatt_client_set_buffer_mode(uint16_t conn_handle, uint8_t mode) {
  if (op_mode_val_handle == 0) {
    ESP_LOGE(TAG, "Operating mode char not discovered yet");
    return -1;
  }

  return ble_gattc_write_flat(conn_handle, op_mode_val_handle, &mode,
                              sizeof(mode), NULL, NULL);
}
