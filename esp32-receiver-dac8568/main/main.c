#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "nvs_flash.h"

/* NimBLE */
#include "host/ble_gap.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"

#include "accel_protocol.h"
#include "gatt_client.h"
#include "playback.h"

static const char *TAG = "main";

/*============================================================================
 * State
 *===========================================================================*/

static uint16_t conn_handle = BLE_HS_CONN_HANDLE_NONE;
static bool is_connected = false;

#define TARGET_DEVICE_NAME "ISRO_AccelSensor"

static uint32_t total_packets = 0;
static uint32_t total_samples = 0;
static int64_t stream_start_us = 0;

/*============================================================================
 * Serial Output Queue
 *===========================================================================*/

typedef struct {
  uint32_t pkt_counter;
  uint16_t num_samples;
  accel_sample_t samples[SAMPLES_PER_PACKET];
} serial_pkt_t;

#define SERIAL_QUEUE_LEN 64
static QueueHandle_t serial_queue = NULL;

static void serial_output_task(void *arg) {
  serial_pkt_t pkt;
  char out_buf[2048];
  while (1) {
    if (xQueueReceive(serial_queue, &pkt, portMAX_DELAY) == pdTRUE) {
      int pos = 0;
      for (uint16_t i = 0; i < pkt.num_samples; i++) {
        pos +=
            snprintf(out_buf + pos, sizeof(out_buf) - pos,
                     "PKT,%lu,%u,%u,%d,%d,%d\n", (unsigned long)pkt.pkt_counter,
                     i, pkt.samples[i].rel_timestamp_ms, pkt.samples[i].accel_x,
                     pkt.samples[i].accel_y, pkt.samples[i].accel_z);
      }
      fwrite(out_buf, 1, pos, stdout);
      fflush(stdout);
    }
  }
}

/*============================================================================
 * Notification Callback
 *===========================================================================*/

static void on_accel_notification(const uint8_t *data, uint16_t length) {
  if (length < 5)
    return;
  const accel_packet_t *pkt = (const accel_packet_t *)data;
  uint16_t num_samples = SAMPLES_PER_PACKET;
  if (length < ACCEL_PACKET_SIZE) {
    num_samples = (length - 5 - 2) / ACCEL_SAMPLE_SIZE;
    if (num_samples > SAMPLES_PER_PACKET)
      num_samples = SAMPLES_PER_PACKET;
  }
  if (total_packets == 0)
    stream_start_us = esp_timer_get_time();
  total_packets++;
  total_samples += num_samples;

  serial_pkt_t spkt;
  spkt.pkt_counter = pkt->packet_counter;
  spkt.num_samples = num_samples;
  memcpy(spkt.samples, pkt->samples, num_samples * sizeof(accel_sample_t));
  xQueueSend(serial_queue, &spkt, 0);

  playback_enqueue(pkt);
}

/*============================================================================
 * GAP Event Handler
 *===========================================================================*/

static void start_scan(void);

static int gap_event_handler(struct ble_gap_event *event, void *arg) {
  int rc;
  switch (event->type) {

  case BLE_GAP_EVENT_DISC: {
    struct ble_hs_adv_fields fields;
    rc = ble_hs_adv_parse_fields(&fields, event->disc.data,
                                 event->disc.length_data);
    if (rc != 0)
      break;
    if (fields.name != NULL && fields.name_len > 0 &&
        fields.name_len == strlen(TARGET_DEVICE_NAME) &&
        memcmp(fields.name, TARGET_DEVICE_NAME, fields.name_len) == 0) {
      ESP_LOGW(TAG, "★ Found %s! RSSI=%d, connecting...", TARGET_DEVICE_NAME,
               event->disc.rssi);
      ble_gap_disc_cancel();
      struct ble_gap_conn_params cp = {.scan_itvl = 16,
                                       .scan_window = 16,
                                       .itvl_min = 6,
                                       .itvl_max = 12,
                                       .latency = 0,
                                       .supervision_timeout = 400,
                                       .min_ce_len = 0,
                                       .max_ce_len = 0};
      rc = ble_gap_connect(BLE_OWN_ADDR_PUBLIC, &event->disc.addr, 30000, &cp,
                           gap_event_handler, NULL);
      if (rc != 0) {
        ESP_LOGE(TAG, "Connect failed: %d", rc);
        start_scan();
      }
    }
    break;
  }

  case BLE_GAP_EVENT_CONNECT: {
    if (event->connect.status == 0) {
      conn_handle = event->connect.conn_handle;
      is_connected = true;
      ESP_LOGW(TAG, "✓ Connected! handle=%d", conn_handle);

      struct ble_gap_conn_desc desc;
      rc = ble_gap_conn_find(conn_handle, &desc);
      if (rc == 0) {
        ESP_LOGI(TAG, "  CI=%d (%.1f ms), latency=%d, timeout=%d",
                 desc.conn_itvl, desc.conn_itvl * 1.25, desc.conn_latency,
                 desc.supervision_timeout);
      }
      ble_gap_set_prefered_le_phy(conn_handle, BLE_GAP_LE_PHY_2M_MASK,
                                  BLE_GAP_LE_PHY_2M_MASK,
                                  BLE_GAP_LE_PHY_CODED_ANY);
      ble_gattc_exchange_mtu(conn_handle, NULL, NULL);
      ble_gap_set_data_len(conn_handle, 251, 2120);
      struct ble_gap_upd_params up = {.itvl_min = 6,
                                      .itvl_max = 6,
                                      .latency = 0,
                                      .supervision_timeout = 400,
                                      .min_ce_len = 6,
                                      .max_ce_len = 12};
      ble_gap_update_params(conn_handle, &up);
      ESP_LOGI(TAG, "Starting GATT service discovery...");
      gatt_client_discover(conn_handle);
    } else {
      ESP_LOGE(TAG, "Connection failed: %d", event->connect.status);
      start_scan();
    }
    break;
  }

  case BLE_GAP_EVENT_DISCONNECT: {
    ESP_LOGW(TAG, "Disconnected: reason=%d", event->disconnect.reason);
    conn_handle = BLE_HS_CONN_HANDLE_NONE;
    is_connected = false;
    playback_reset();
    if (total_packets > 0) {
      float sec = (esp_timer_get_time() - stream_start_us) / 1e6f;
      ESP_LOGI(TAG, "Session: %lu pkts, %lu samples, %.1f Hz",
               (unsigned long)total_packets, (unsigned long)total_samples,
               total_samples / sec);
    }
    total_packets = total_samples = 0;
    start_scan();
    break;
  }

  case BLE_GAP_EVENT_PHY_UPDATE_COMPLETE:
    ESP_LOGI(TAG, "PHY: TX=%d RX=%d", event->phy_updated.tx_phy,
             event->phy_updated.rx_phy);
    break;

  case BLE_GAP_EVENT_MTU:
    ESP_LOGI(TAG, "MTU: %d", event->mtu.value);
    break;

  case BLE_GAP_EVENT_NOTIFY_RX:
    gatt_client_on_notify(event->notify_rx.conn_handle,
                          event->notify_rx.attr_handle, event->notify_rx.om,
                          NULL);
    break;

  case BLE_GAP_EVENT_CONN_UPDATE: {
    struct ble_gap_conn_desc desc;
    rc = ble_gap_conn_find(event->conn_update.conn_handle, &desc);
    if (rc == 0) {
      ESP_LOGW(TAG, "CI updated: %d (%.1f ms)", desc.conn_itvl,
               desc.conn_itvl * 1.25);
    }
    break;
  }

  default:
    break;
  }
  return 0;
}

/*============================================================================
 * Scanning
 *===========================================================================*/

static void start_scan(void) {
  struct ble_gap_disc_params sp = {.itvl = 16,     /* 10 ms — aggressive scan */
                                   .window = 16,   /* 10 ms — 100% duty cycle */
                                   .filter_policy = 0,
                                   .limited = 0,
                                   .passive = 0,
                                   .filter_duplicates = 1};
  ESP_LOGI(TAG, "Scanning for %s...", TARGET_DEVICE_NAME);
  int rc = ble_gap_disc(BLE_OWN_ADDR_PUBLIC, BLE_HS_FOREVER, &sp,
                        gap_event_handler, NULL);
  if (rc != 0)
    ESP_LOGE(TAG, "Scan failed: %d", rc);
}

/*============================================================================
 * Stats Timer
 *===========================================================================*/

static void stats_timer_cb(void *arg) {
  if (!is_connected || total_packets == 0)
    return;
  float sec = (esp_timer_get_time() - stream_start_us) / 1e6f;
  if (sec < 1.0f)
    return;
  ESP_LOGI(TAG, "BLE: %lu pkts (%.1f/s) | %lu samples (%.1f Hz)",
           (unsigned long)total_packets, total_packets / sec,
           (unsigned long)total_samples, total_samples / sec);
}

/*============================================================================
 * NimBLE Host
 *===========================================================================*/

static void ble_on_sync(void) {
  ble_hs_util_ensure_addr(0);
  ESP_LOGI(TAG, "BLE synced — starting scan");
  start_scan();
}

static void ble_on_reset(int reason) { ESP_LOGE(TAG, "BLE reset: %d", reason); }

static void nimble_task(void *p) {
  nimble_port_run();
  nimble_port_freertos_deinit();
}

/*============================================================================
 * App Main
 *===========================================================================*/

void app_main(void) {
  ESP_LOGW(TAG, "============================================");
  ESP_LOGW(TAG, "  ISRO BLE Accelerometer → DAC8568 Receiver");
  ESP_LOGW(TAG, "============================================");

  /* NVS */
  esp_err_t ret = nvs_flash_init();
  if (ret == ESP_ERR_NVS_NO_FREE_PAGES ||
      ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    ESP_ERROR_CHECK(nvs_flash_init());
  }

  /* DAC + Playback engine */
  playback_init();

  /* Serial output */
  serial_queue = xQueueCreate(SERIAL_QUEUE_LEN, sizeof(serial_pkt_t));
  xTaskCreatePinnedToCore(serial_output_task, "serial", 4096, NULL, 3, NULL, 0);

  /* Register BLE notification callback */
  gatt_client_init(on_accel_notification);

  /* Stats timer */
  esp_timer_handle_t st;
  esp_timer_create_args_t sa = {.callback = stats_timer_cb,
                                .name = "ble_stats"};
  ESP_ERROR_CHECK(esp_timer_create(&sa, &st));
  ESP_ERROR_CHECK(esp_timer_start_periodic(st, 5000000));

  /* NimBLE */
  ESP_ERROR_CHECK(nimble_port_init());
  ble_hs_cfg.sync_cb = ble_on_sync;
  ble_hs_cfg.reset_cb = ble_on_reset;
  nimble_port_freertos_init(nimble_task);

  ESP_LOGW(TAG, "System ready");
}
