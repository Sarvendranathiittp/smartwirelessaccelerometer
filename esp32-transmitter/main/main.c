#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "driver/gpio.h"
#include "driver/i2c.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_rom_sys.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "esp_bt.h"

/* NimBLE */
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/ble_uuid.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

static const char *TAG = "transmitter";

/*============================================================================
 * ST H3LIS331DL Register Mappings & Constants
 *===========================================================================*/
#define H3LIS331DL_REG_WHO_AM_I  0x0F
#define H3LIS331DL_REG_CTRL_REG1 0x20
#define H3LIS331DL_REG_CTRL_REG2 0x21
#define H3LIS331DL_REG_CTRL_REG3 0x22
#define H3LIS331DL_REG_CTRL_REG4 0x23
#define H3LIS331DL_REG_OUT_X_L   0x28

#define I2C_MASTER_NUM             I2C_NUM_0
#define I2C_MASTER_TX_BUF_DISABLE  0
#define I2C_MASTER_RX_BUF_DISABLE  0

/*============================================================================
 * Data Structures & Formats
 *===========================================================================*/
#pragma pack(push, 1)
typedef struct {
    uint16_t rel_timestamp_ms;
    int16_t accel_x;
    int16_t accel_y;
    int16_t accel_z;
} accel_sample_t;

typedef struct {
    uint32_t packet_counter;
    uint8_t first_sample_offset;
    accel_sample_t samples[29];
    uint16_t crc16;
} accel_packet_t;

typedef struct {
    char sensor_name[24];
    int16_t range_g;
    char unit[8];
    uint8_t h3lis_status;
    uint8_t mpu_status; /* Kept for dashboard compatibility (set to 0) */
} sensor_metadata_t;
#pragma pack(pop)

/*============================================================================
 * Global Variables & States
 *===========================================================================*/
static uint8_t h3lis_addr = 0x19;
static bool h3lis_detected = false;
static bool i2c_driver_installed = false;

static int I2C_SDA_PIN = 11;
static int I2C_SCL_PIN = 12;

static uint16_t conn_handle __attribute__((unused)) = BLE_HS_CONN_HANDLE_NONE;
static volatile bool device_connected = false;
static volatile bool streaming_active = false;
static volatile bool sensorReady = false;

static sensor_metadata_t sensor_meta = {
    .sensor_name = "H3LIS331DL_I2C",
    .range_g = 100, /* Default to 100g */
    .unit = "g",
    .h3lis_status = 0,
    .mpu_status = 0 /* Explicitly 0 since MPU6050 is eliminated */
};

static uint16_t sampling_rate __attribute__((unused)) = 1000;
static int8_t current_tx_power_dbm __attribute__((unused)) = 0;
static uint16_t burst_threshold __attribute__((unused)) = 29;

static enum {
    MODE_COINCELL_BURST = 0x00,
    MODE_CONTINUOUS_LAB = 0x01
} current_mode = MODE_CONTINUOUS_LAB;

/* Task & Timer handles */
static TaskHandle_t pullTaskHandle = NULL;
static portMUX_TYPE myMutex = portMUX_INITIALIZER_UNLOCKED;
static SemaphoreHandle_t sample_sem = NULL;
static esp_timer_handle_t periodic_timer = NULL;

/* Sample circular buffer queue */
#define QUEUE_SIZE 16384
static accel_sample_t valueQueue[QUEUE_SIZE];
static volatile int queueHead = 0;
static volatile int queueTail = 0;
static volatile int queueCount = 0;

/* GATT Characteristic Handles */
static uint16_t data_val_handle;
static uint16_t timestamp_val_handle;
static uint16_t rate_val_handle;
static uint16_t meta_val_handle;
static uint16_t mode_val_handle;
static uint16_t txpower_val_handle;

/* Forward Declarations */
static void set_esp32_tx_power(int8_t dbm);
static void save_tx_power(int8_t dbm);
static void set_sensor_range(uint16_t range_g);
static void start_streaming(void);
static void stop_streaming(void);
static void process_operating_mode_cmd(uint8_t cmd);
static void h3lis331dl_sleep(void);
static void h3lis331dl_wake_and_configure(void);
static void apply_sampling_rate(uint16_t rate);
static void save_sampling_rate(uint16_t rate);
static void save_burst_threshold(uint16_t threshold);

/*============================================================================
 * CRC16 CCITT Calculation
 *===========================================================================*/
static uint16_t crc16_ccitt(uint16_t crc, const uint8_t *data, size_t len) {
    while (len--) {
        crc ^= (uint16_t)*data++ << 8;
        for (int i = 0; i < 8; i++) {
            if (crc & 0x8000) {
                crc = (crc << 1) ^ 0x1021;
            } else {
                crc = crc << 1;
            }
        }
    }
    return crc;
}

/*============================================================================
 * I2C Reg Read/Write Helper Functions
 *===========================================================================*/
static esp_err_t legacy_write_reg(uint8_t addr, uint8_t reg, uint8_t val) {
    i2c_cmd_handle_t cmd = i2c_cmd_link_create();
    i2c_master_start(cmd);
    i2c_master_write_byte(cmd, (addr << 1) | I2C_MASTER_WRITE, true);
    i2c_master_write_byte(cmd, reg, true);
    i2c_master_write_byte(cmd, val, true);
    i2c_master_stop(cmd);
    esp_err_t ret = i2c_master_cmd_begin(I2C_MASTER_NUM, cmd, pdMS_TO_TICKS(50));
    i2c_cmd_link_delete(cmd);
    return ret;
}

static esp_err_t legacy_read_reg(uint8_t addr, uint8_t reg, uint8_t *val) {
    i2c_cmd_handle_t cmd = i2c_cmd_link_create();
    i2c_master_start(cmd);
    i2c_master_write_byte(cmd, (addr << 1) | I2C_MASTER_WRITE, true);
    i2c_master_write_byte(cmd, reg, true);
    i2c_master_start(cmd);
    i2c_master_write_byte(cmd, (addr << 1) | I2C_MASTER_READ, true);
    i2c_master_read_byte(cmd, val, I2C_MASTER_NACK);
    i2c_master_stop(cmd);
    esp_err_t ret = i2c_master_cmd_begin(I2C_MASTER_NUM, cmd, pdMS_TO_TICKS(50));
    i2c_cmd_link_delete(cmd);
    return ret;
}

/*============================================================================
 * Sensor Wake / Sleep Controllers
 *===========================================================================*/
static void h3lis331dl_sleep(void) {
    if (!h3lis_detected) return;
    legacy_write_reg(h3lis_addr, H3LIS331DL_REG_CTRL_REG1, 0x00);
}

static void h3lis331dl_wake_and_configure(void) {
    if (!h3lis_detected) return;
    legacy_write_reg(h3lis_addr, H3LIS331DL_REG_CTRL_REG1, 0x00);
    vTaskDelay(pdMS_TO_TICKS(5));

    uint8_t fs_bits = 0x30; /* Default ±400g */
    if (sensor_meta.range_g == 100) {
        fs_bits = 0x00;
    } else if (sensor_meta.range_g == 200) {
        fs_bits = 0x10;
    }

    legacy_write_reg(h3lis_addr, H3LIS331DL_REG_CTRL_REG4, 0x80 | fs_bits); /* BDU enabled */
    legacy_write_reg(h3lis_addr, H3LIS331DL_REG_CTRL_REG2, 0x00);           /* No HPF */
    legacy_write_reg(h3lis_addr, H3LIS331DL_REG_CTRL_REG1, 0x3F);           /* 1000 Hz, Normal mode, all axes on */
    vTaskDelay(pdMS_TO_TICKS(10));
}

/*============================================================================
 * I2C Scanning and Driver Setup
 *===========================================================================*/
static esp_err_t scan_i2c_devices(int sda, int scl, uint32_t speed_hz) {
    if (i2c_driver_installed) {
        i2c_driver_delete(I2C_MASTER_NUM);
        i2c_driver_installed = false;
    }

    i2c_config_t conf = {
        .mode = I2C_MODE_MASTER,
        .sda_io_num = sda,
        .sda_pullup_en = GPIO_PULLUP_ENABLE,
        .scl_io_num = scl,
        .scl_pullup_en = GPIO_PULLUP_ENABLE,
        .master.clk_speed = speed_hz,
        .clk_flags = 0
    };
    esp_err_t err = i2c_param_config(I2C_MASTER_NUM, &conf);
    if (err != ESP_OK) return err;

    err = i2c_driver_install(I2C_MASTER_NUM, conf.mode, I2C_MASTER_RX_BUF_DISABLE, I2C_MASTER_TX_BUF_DISABLE, 0);
    if (err != ESP_OK) return err;
    i2c_driver_installed = true;

    for (uint8_t addr = 0x03; addr <= 0x77; addr++) {
        i2c_cmd_handle_t cmd = i2c_cmd_link_create();
        i2c_master_start(cmd);
        i2c_master_write_byte(cmd, (addr << 1) | I2C_MASTER_WRITE, true);
        i2c_master_stop(cmd);
        err = i2c_master_cmd_begin(I2C_MASTER_NUM, cmd, pdMS_TO_TICKS(10));
        i2c_cmd_link_delete(cmd);

        if (err == ESP_OK) {
            ESP_LOGI(TAG, "  Found responding device at I2C address 0x%02X", addr);
            /* Check for H3LIS331DL */
            uint8_t whoami_h3lis = 0;
            esp_err_t rd_err = legacy_read_reg(addr, H3LIS331DL_REG_WHO_AM_I, &whoami_h3lis);
            if (rd_err == ESP_OK) {
                ESP_LOGI(TAG, "    WHO_AM_I returned 0x%02X", whoami_h3lis);
                if (whoami_h3lis == 0x32) {
                    h3lis_detected = true;
                    h3lis_addr = addr;
                    ESP_LOGI(TAG, "    ✓ MATCH! H3LIS331DL detected!");
                }
            } else {
                ESP_LOGE(TAG, "    Failed to read WHO_AM_I: %s", esp_err_to_name(rd_err));
            }
        }
    }

    if (h3lis_detected) {
        return ESP_OK;
    }

    i2c_driver_delete(I2C_MASTER_NUM);
    i2c_driver_installed = false;
    return ESP_ERR_NOT_FOUND;
}

static bool init_sensor(void) {
    h3lis_detected = false;

    int sda_pins[] = {1, 11, 6, 4, 8, 9};
    int scl_pins[] = {2, 12, 4, 6, 9, 8};
    int num_configs = sizeof(sda_pins)/sizeof(sda_pins[0]);

    for (int i = 0; i < num_configs; i++) {
        ESP_LOGI(TAG, "Probing I2C pins: SDA=GPIO%d, SCL=GPIO%d...", sda_pins[i], scl_pins[i]);
        
        /* 1. Try scanning at 100 kHz (highly robust/tolerant) */
        if (scan_i2c_devices(sda_pins[i], scl_pins[i], 100000) == ESP_OK) {
            I2C_SDA_PIN = sda_pins[i];
            I2C_SCL_PIN = scl_pins[i];
            sensor_meta.h3lis_status = h3lis_detected ? 1 : 0;
            sensor_meta.mpu_status = 0;

            /* Re-initialize I2C driver at 400 kHz for high-speed operation */
            ESP_LOGI(TAG, "Re-initializing I2C driver at 400 kHz for high-speed streaming...");
            if (i2c_driver_installed) {
                i2c_driver_delete(I2C_MASTER_NUM);
                i2c_driver_installed = false;
            }
            i2c_config_t conf = {
                .mode = I2C_MODE_MASTER,
                .sda_io_num = I2C_SDA_PIN,
                .sda_pullup_en = GPIO_PULLUP_ENABLE,
                .scl_io_num = I2C_SCL_PIN,
                .scl_pullup_en = GPIO_PULLUP_ENABLE,
                .master.clk_speed = 400000,
                .clk_flags = 0
            };
            i2c_param_config(I2C_MASTER_NUM, &conf);
            i2c_driver_install(I2C_MASTER_NUM, conf.mode, I2C_MASTER_RX_BUF_DISABLE, I2C_MASTER_TX_BUF_DISABLE, 0);
            i2c_driver_installed = true;

            if (h3lis_detected) h3lis331dl_sleep();
            return true;
        }
    }
    return false;
}

static bool read_active_sensor_data(int16_t *x, int16_t *y, int16_t *z) {
    uint8_t data[6] = {0};
    esp_err_t err;

    if (!h3lis_detected) return false;
    uint8_t reg = H3LIS331DL_REG_OUT_X_L | 0x80; /* Auto-increment read */
    i2c_cmd_handle_t cmd = i2c_cmd_link_create();
    i2c_master_start(cmd);
    i2c_master_write_byte(cmd, (h3lis_addr << 1) | I2C_MASTER_WRITE, true);
    i2c_master_write_byte(cmd, reg, true);
    i2c_master_start(cmd);
    i2c_master_write_byte(cmd, (h3lis_addr << 1) | I2C_MASTER_READ, true);
    i2c_master_read(cmd, data, 5, I2C_MASTER_ACK);
    i2c_master_read_byte(cmd, &data[5], I2C_MASTER_NACK);
    i2c_master_stop(cmd);
    err = i2c_master_cmd_begin(I2C_MASTER_NUM, cmd, pdMS_TO_TICKS(10));
    i2c_cmd_link_delete(cmd);

    if (err == ESP_OK) {
        /* H3LIS331DL outputs raw counts in Little-Endian */
        *x = (int16_t)(data[0] | (data[1] << 8));
        *y = (int16_t)(data[2] | (data[3] << 8));
        *z = (int16_t)(data[4] | (data[5] << 8));
        return true;
    }
    return false;
}

/*============================================================================
 * BLE GATT Server Definition
 *===========================================================================*/
/* Service UUID: 12340000-1234-5678-9ABC-DEF012345678 (Little Endian for NimBLE) */
static const ble_uuid128_t gatt_svr_svc_uuid =
    BLE_UUID128_INIT(0x78, 0x56, 0x34, 0x12, 0xf0, 0xde, 0xbc, 0x9a, 0x78, 0x56, 0x34, 0x12, 0x00, 0x00, 0x34, 0x12);

/* Data Characteristic: 12340001-... (NOTIFY) */
static const ble_uuid128_t gatt_svr_chr_data_uuid =
    BLE_UUID128_INIT(0x78, 0x56, 0x34, 0x12, 0xf0, 0xde, 0xbc, 0x9a, 0x78, 0x56, 0x34, 0x12, 0x01, 0x00, 0x34, 0x12);

/* Timestamp Characteristic: 12340002-... (READ | NOTIFY) */
static const ble_uuid128_t gatt_svr_chr_timestamp_uuid =
    BLE_UUID128_INIT(0x78, 0x56, 0x34, 0x12, 0xf0, 0xde, 0xbc, 0x9a, 0x78, 0x56, 0x34, 0x12, 0x02, 0x00, 0x34, 0x12);

/* Sampling Rate Characteristic: 12340003-... (READ) */
static const ble_uuid128_t gatt_svr_chr_samplerate_uuid =
    BLE_UUID128_INIT(0x78, 0x56, 0x34, 0x12, 0xf0, 0xde, 0xbc, 0x9a, 0x78, 0x56, 0x34, 0x12, 0x03, 0x00, 0x34, 0x12);

/* Metadata Characteristic: 12340004-... (READ) */
static const ble_uuid128_t gatt_svr_chr_metadata_uuid =
    BLE_UUID128_INIT(0x78, 0x56, 0x34, 0x12, 0xf0, 0xde, 0xbc, 0x9a, 0x78, 0x56, 0x34, 0x12, 0x04, 0x00, 0x34, 0x12);

/* Operating Mode Characteristic: 12340005-... (READ | WRITE) */
static const ble_uuid128_t gatt_svr_chr_mode_uuid =
    BLE_UUID128_INIT(0x78, 0x56, 0x34, 0x12, 0xf0, 0xde, 0xbc, 0x9a, 0x78, 0x56, 0x34, 0x12, 0x05, 0x00, 0x34, 0x12);

static const ble_uuid128_t gatt_svr_chr_txpower_uuid =
    BLE_UUID128_INIT(0x78, 0x56, 0x34, 0x12, 0xf0, 0xde, 0xbc, 0x9a, 0x78, 0x56, 0x34, 0x12, 0x06, 0x00, 0x34, 0x12);

/* Battery Service (BAS) */
static const ble_uuid16_t gatt_svr_svc_batt_uuid = BLE_UUID16_INIT(0x180F);
static const ble_uuid16_t gatt_svr_chr_batt_level_uuid = BLE_UUID16_INIT(0x2A19);
static uint16_t batt_level_val_handle;

static int gatt_svr_access(uint16_t conn_handle, uint16_t attr_handle,
                           struct ble_gatt_access_ctxt *ctxt, void *arg);

static const struct ble_gatt_svc_def gatt_svr_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &gatt_svr_svc_uuid.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            {
                .uuid = &gatt_svr_chr_data_uuid.u,
                .access_cb = gatt_svr_access,
                .flags = BLE_GATT_CHR_F_NOTIFY,
                .val_handle = &data_val_handle,
            },
            {
                .uuid = &gatt_svr_chr_timestamp_uuid.u,
                .access_cb = gatt_svr_access,
                .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
                .val_handle = &timestamp_val_handle,
            },
            {
                .uuid = &gatt_svr_chr_samplerate_uuid.u,
                .access_cb = gatt_svr_access,
                .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE,
                .val_handle = &rate_val_handle,
            },
            {
                .uuid = &gatt_svr_chr_metadata_uuid.u,
                .access_cb = gatt_svr_access,
                .flags = BLE_GATT_CHR_F_READ,
                .val_handle = &meta_val_handle,
            },
            {
                .uuid = &gatt_svr_chr_mode_uuid.u,
                .access_cb = gatt_svr_access,
                .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE,
                .val_handle = &mode_val_handle,
            },
            {
                .uuid = &gatt_svr_chr_txpower_uuid.u,
                .access_cb = gatt_svr_access,
                .flags = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_WRITE,
                .val_handle = &txpower_val_handle,
            },
            {
                0, /* No more characteristics */
            }
        },
    },
    {
        0, /* No more services */
    }
};

static int gatt_svr_access(uint16_t conn_handle, uint16_t attr_handle,
                           struct ble_gatt_access_ctxt *ctxt, void *arg) {
    const ble_uuid_t *uuid = ctxt->chr->uuid;
    char uuid_str[BLE_UUID_STR_LEN];
    ble_uuid_to_str(uuid, uuid_str);
    ESP_LOGI(TAG, "GATT access: uuid=%s, op=%d", uuid_str, (int)ctxt->op);

    if (ble_uuid_cmp(uuid, &gatt_svr_chr_timestamp_uuid.u) == 0) {
        if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
            uint32_t ts = (uint32_t)(esp_timer_get_time() / 1000);
            os_mbuf_append(ctxt->om, &ts, sizeof(ts));
            return 0;
        }
    } else if (ble_uuid_cmp(uuid, &gatt_svr_chr_samplerate_uuid.u) == 0) {
        if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
            os_mbuf_append(ctxt->om, &sampling_rate, sizeof(sampling_rate));
            return 0;
        } else if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
            uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
            if (len != sizeof(uint16_t)) {
                return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
            }
            uint16_t rate;
            ble_hs_mbuf_to_flat(ctxt->om, &rate, sizeof(rate), NULL);
            if (rate == 1000 || rate == 2000 || rate == 3000 || rate == 4000 || rate == 5000) {
                ESP_LOGI(TAG, "Changing sampling rate to %u Hz", rate);
                save_sampling_rate(rate);
                return 0;
            } else {
                ESP_LOGE(TAG, "Invalid sampling rate write for ESP32: %u Hz", rate);
                return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
            }
        }
    } else if (ble_uuid_cmp(uuid, &gatt_svr_chr_metadata_uuid.u) == 0) {
        if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
            os_mbuf_append(ctxt->om, &sensor_meta, sizeof(sensor_meta));
            return 0;
        }
    } else if (ble_uuid_cmp(uuid, &gatt_svr_chr_mode_uuid.u) == 0) {
        if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
            uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
            uint8_t val[16];
            if (len > sizeof(val)) len = sizeof(val);
            ble_hs_mbuf_to_flat(ctxt->om, val, len, NULL);
            ESP_LOGI(TAG, "Mode Characteristic Write: 0x%02X", val[0]);
            process_operating_mode_cmd(val[0]);
            return 0;
        } else if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
            uint8_t mode_byte = 0x10; // default BUFFER_MODE_NONE
            if (burst_threshold <= 29) {
                mode_byte = 0x10;
            } else {
                static const uint16_t duration_ms[] = { 300, 1000, 2000, 5000, 10000 };
                uint32_t best_diff = 999999;
                uint8_t best_mode = 0x11;
                for (int i = 0; i < 5; i++) {
                    uint32_t target_thresh = ((uint32_t)duration_ms[i] * (uint32_t)sampling_rate) / 1000;
                    uint32_t diff = (burst_threshold > target_thresh) ? (burst_threshold - target_thresh) : (target_thresh - burst_threshold);
                    if (diff < best_diff) {
                        best_diff = diff;
                        best_mode = 0x11 + i;
                    }
                }
                mode_byte = best_mode;
            }
            os_mbuf_append(ctxt->om, &mode_byte, sizeof(mode_byte));
            return 0;
        }
    } else if (ble_uuid_cmp(uuid, &gatt_svr_chr_txpower_uuid.u) == 0) {
        if (ctxt->op == BLE_GATT_ACCESS_OP_WRITE_CHR) {
            uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
            int8_t requested_dbm = 0;
            if (len == 1) {
                ble_hs_mbuf_to_flat(ctxt->om, &requested_dbm, 1, NULL);
                ESP_LOGI(TAG, "TX Power write request: %d dBm", requested_dbm);
                save_tx_power(requested_dbm);
            }
            return 0;
        } else if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
            os_mbuf_append(ctxt->om, &current_tx_power_dbm, sizeof(current_tx_power_dbm));
            return 0;
        }
    } else if (ble_uuid_cmp(uuid, &gatt_svr_chr_batt_level_uuid.u) == 0) {
        if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
            uint8_t level = 95; // Mock 95% battery level for ESP32
            os_mbuf_append(ctxt->om, &level, sizeof(level));
            return 0;
        }
    }
    return BLE_ATT_ERR_UNLIKELY;
}

static void start_advertising(void);

static int gap_event_handler(struct ble_gap_event *event, void *arg) {
    switch (event->type) {
        case BLE_GAP_EVENT_CONNECT:
            if (event->connect.status == 0) {
                conn_handle = event->connect.conn_handle;
                device_connected = true;
                ESP_LOGW(TAG, "✓ App connected via BLE!");

                /* Start slow connection interval on idle (100 ms) */
                struct ble_gap_upd_params params = {
                    .itvl_min = 80,
                    .itvl_max = 100,
                    .latency = 4,
                    .supervision_timeout = 400,
                    .min_ce_len = 0,
                    .max_ce_len = 0,
                };
                ble_gap_update_params(conn_handle, &params);
            } else {
                start_advertising();
            }
            break;

        case BLE_GAP_EVENT_DISCONNECT:
            ESP_LOGW(TAG, "BLE Disconnected. Stopping stream and restarting ads...");
            conn_handle = BLE_HS_CONN_HANDLE_NONE;
            device_connected = false;
            stop_streaming();
            start_advertising();
            break;

        case BLE_GAP_EVENT_SUBSCRIBE:
            ESP_LOGI(TAG, "CCCD Subscribe Event: cur_notify=%d", event->subscribe.cur_notify);
            if (event->subscribe.attr_handle == data_val_handle) {
                if (event->subscribe.cur_notify) {
                    start_streaming();
                } else {
                    stop_streaming();
                }
            }
            break;

        case BLE_GAP_EVENT_MTU:
            ESP_LOGI(TAG, "MTU updated to: %d", event->mtu.value);
            break;
    }
    return 0;
}

static void start_advertising(void) {
    struct ble_gap_adv_params adv_params;
    struct ble_hs_adv_fields adv_fields;
    int rc;

    memset(&adv_fields, 0, sizeof(adv_fields));
    adv_fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    adv_fields.name = (uint8_t *)"ISRO_AccelSensor_ESP";
    adv_fields.name_len = strlen("ISRO_AccelSensor_ESP");
    adv_fields.name_is_complete = 1;

    rc = ble_gap_adv_set_fields(&adv_fields);
    if (rc != 0) {
        ESP_LOGE(TAG, "Error setting advertisement fields; rc=%d", rc);
        return;
    }

    memset(&adv_params, 0, sizeof(adv_params));
    adv_params.conn_mode = BLE_GAP_CONN_MODE_UND;
    adv_params.disc_mode = BLE_GAP_DISC_MODE_GEN;

    rc = ble_gap_adv_start(BLE_OWN_ADDR_RANDOM, NULL, BLE_HS_FOREVER,
                           &adv_params, gap_event_handler, NULL);
    if (rc != 0) {
        ESP_LOGE(TAG, "Error starting advertisement; rc=%d", rc);
    } else {
        ESP_LOGI(TAG, "Advertising successfully started");
    }
}

/*============================================================================
 * Active Streaming State Machine
 *===========================================================================*/
static void set_sensor_range(uint16_t range_g) {
    /* Map low-g ranges back to H3LIS331DL 100g minimum range since MPU6050 is eliminated */
    if (range_g < 100) {
        ESP_LOGW(TAG, "MPU6050 eliminated. Mapping low-g range request %ug to H3LIS331DL 100g", range_g);
        range_g = 100;
    }

    if (range_g != 100 && range_g != 200 && range_g != 400) {
        return;
    }
    
    sensor_meta.range_g = (int16_t)range_g;

    nvs_handle_t my_handle;
    if (nvs_open("storage", NVS_READWRITE, &my_handle) == ESP_OK) {
        nvs_set_u16(my_handle, "g_range", range_g);
        nvs_commit(my_handle);
        nvs_close(my_handle);
        ESP_LOGI(TAG, "Saved range_g=%u to NVS", range_g);
    }

    if (streaming_active) {
        h3lis331dl_wake_and_configure();
    }
}

static void periodic_timer_callback(void *arg) {
    if (sample_sem != NULL) {
        BaseType_t xHigherPriorityTaskWoken = pdFALSE;
        xSemaphoreGiveFromISR(sample_sem, &xHigherPriorityTaskWoken);
        if (xHigherPriorityTaskWoken) {
            portYIELD_FROM_ISR();
        }
    }
}

static void start_streaming(void) {
    if (streaming_active) return;
    ESP_LOGI(TAG, ">>> STREAMING START (%u Hz, range=%u Gs)", sampling_rate, sensor_meta.range_g);

    h3lis331dl_wake_and_configure();

    portENTER_CRITICAL(&myMutex);
    queueHead = 0;
    queueTail = 0;
    queueCount = 0;
    portEXIT_CRITICAL(&myMutex);

    streaming_active = true;

    /* Request fast BLE connection parameters for high throughput (7.5ms - 15ms) */
    if (device_connected && conn_handle != BLE_HS_CONN_HANDLE_NONE) {
        struct ble_gap_upd_params params = {
            .itvl_min = 6,
            .itvl_max = 12,
            .latency = 0,
            .supervision_timeout = 400,
            .min_ce_len = 0,
            .max_ce_len = 0,
        };
        ble_gap_update_params(conn_handle, &params);
    }

    /* Start ESP-IDF High-Resolution Hardware Periodic Timer dynamically based on sampling rate */
    if (periodic_timer == NULL) {
        const esp_timer_create_args_t periodic_timer_args = {
            .callback = &periodic_timer_callback,
            .name = "sampling_timer"
        };
        esp_timer_create(&periodic_timer_args, &periodic_timer);
    }
    uint64_t timer_interval_us = 1000000ULL / sampling_rate;
    esp_timer_start_periodic(periodic_timer, timer_interval_us);
}

static void stop_streaming(void) {
    if (!streaming_active) return;
    streaming_active = false;

    if (periodic_timer != NULL) {
        esp_timer_stop(periodic_timer);
    }

    h3lis331dl_sleep();

    portENTER_CRITICAL(&myMutex);
    queueHead = 0;
    queueTail = 0;
    queueCount = 0;
    portEXIT_CRITICAL(&myMutex);

    /* Reset BLE connection parameters to slow connection interval */
    if (device_connected && conn_handle != BLE_HS_CONN_HANDLE_NONE) {
        struct ble_gap_upd_params params = {
            .itvl_min = 80,
            .itvl_max = 100,
            .latency = 4,
            .supervision_timeout = 400,
            .min_ce_len = 0,
            .max_ce_len = 0,
        };
        ble_gap_update_params(conn_handle, &params);
    }

    ESP_LOGI(TAG, ">>> STREAMING STOP");
}

static void process_operating_mode_cmd(uint8_t cmd) {
    if (cmd == MODE_CONTINUOUS_LAB) {
        current_mode = MODE_CONTINUOUS_LAB;
        ESP_LOGI(TAG, "Mode switched to CONTINUOUS");
    } else if (cmd == MODE_COINCELL_BURST) {
        current_mode = MODE_COINCELL_BURST;
        ESP_LOGI(TAG, "Mode switched to BURST");
    } else if (cmd == 0x10) {
        ESP_LOGI(TAG, "Buffer mode: No Buffer (packet-by-packet)");
        save_burst_threshold(29);
    } else if (cmd >= 0x11 && cmd <= 0x15) {
        /* Time-based buffer modes: compute threshold from duration and sampling rate */
        static const uint16_t duration_ms[] = { 300, 1000, 2000, 5000, 10000 };
        uint16_t idx = cmd - 0x11; /* 0..4 */
        uint32_t threshold = ((uint32_t)duration_ms[idx] * sampling_rate) / 1000;
        if (threshold > QUEUE_SIZE) threshold = QUEUE_SIZE; /* cap to ring buffer size */
        if (threshold < 29) threshold = 29;     /* minimum 1 packet */
        ESP_LOGI(TAG, "Buffer mode 0x%02X: %ums -> threshold=%lu samples", cmd, duration_ms[idx], (unsigned long)threshold);
        save_burst_threshold((uint16_t)threshold);
    } else if (cmd == 0x00) {
        start_streaming();
    } else if (cmd == 0x01) {
        stop_streaming();
    } else if (cmd == 0x20) {
        set_sensor_range(100);
    } else if (cmd == 0x21) {
        set_sensor_range(200);
    } else if (cmd == 0x22) {
        set_sensor_range(400);
    } else if (cmd >= 0x23 && cmd <= 0x26) {
        /* Dashboard requesting low-g MPU6050 modes, fall back to 100g H3LIS331DL */
        set_sensor_range(100);
    } else {
        ESP_LOGW(TAG, "Unknown operating mode command: 0x%02X", cmd);
    }
}

/*============================================================================
 * BLE TX Power Management
 *===========================================================================*/
static void set_esp32_tx_power(int8_t dbm) {
    esp_power_level_t lvl;
    if (dbm <= -12)      lvl = ESP_PWR_LVL_N12;
    else if (dbm <= 0)   lvl = ESP_PWR_LVL_N0;
    else                 lvl = ESP_PWR_LVL_P9; /* Cap at +9 dBm for ESP32-S3 BLE */

    esp_err_t err_def = esp_ble_tx_power_set(ESP_BLE_PWR_TYPE_DEFAULT, lvl);
    esp_err_t err_adv = esp_ble_tx_power_set(ESP_BLE_PWR_TYPE_ADV, lvl);
    esp_err_t err_conn = esp_ble_tx_power_set(ESP_BLE_PWR_TYPE_CONN_HDL0, lvl);

    ESP_LOGI(TAG, "Applied ESP32 BLE TX power: %d dBm (mapped to level %d). status default: %s, adv: %s, conn: %s",
             dbm, (int)lvl, esp_err_to_name(err_def), esp_err_to_name(err_adv), esp_err_to_name(err_conn));
}

static void save_tx_power(int8_t dbm) {
    current_tx_power_dbm = dbm;

    nvs_handle_t my_handle;
    if (nvs_open("storage", NVS_READWRITE, &my_handle) == ESP_OK) {
        nvs_set_i8(my_handle, "tx_power", dbm);
        nvs_commit(my_handle);
        nvs_close(my_handle);
        ESP_LOGI(TAG, "Saved tx_power=%d to NVS", dbm);
    }
    set_esp32_tx_power(dbm);
}

static void apply_sampling_rate(uint16_t rate) {
    sampling_rate = rate;
    if (streaming_active && periodic_timer != NULL) {
        esp_timer_stop(periodic_timer);
        uint64_t timer_interval_us = 1000000ULL / rate;
        esp_timer_start_periodic(periodic_timer, timer_interval_us);
        ESP_LOGI(TAG, "Reconfigured periodic timer to %llu us (%u Hz) dynamically", timer_interval_us, rate);
    }
}

static void save_sampling_rate(uint16_t rate) {
    apply_sampling_rate(rate);

    nvs_handle_t my_handle;
    if (nvs_open("storage", NVS_READWRITE, &my_handle) == ESP_OK) {
        nvs_set_u16(my_handle, "sample_rate", rate);
        nvs_commit(my_handle);
        nvs_close(my_handle);
        ESP_LOGI(TAG, "Saved sample_rate=%u to NVS", rate);
    }
}

static void save_burst_threshold(uint16_t threshold) {
    burst_threshold = threshold;

    nvs_handle_t my_handle;
    if (nvs_open("storage", NVS_READWRITE, &my_handle) == ESP_OK) {
        nvs_set_u16(my_handle, "burst_thresh", threshold);
        nvs_commit(my_handle);
        nvs_close(my_handle);
        ESP_LOGI(TAG, "Saved burst_thresh=%u to NVS", threshold);
    }
}

static void load_nvs_settings(void) {
    nvs_handle_t my_handle;
    esp_err_t err = nvs_open("storage", NVS_READONLY, &my_handle);
    if (err == ESP_OK) {
        uint16_t range = 100;
        if (nvs_get_u16(my_handle, "g_range", &range) == ESP_OK) {
            sensor_meta.range_g = range;
            ESP_LOGI(TAG, "NVS loaded range_g=%u", range);
        }

        int8_t tx_power = 0;
        if (nvs_get_i8(my_handle, "tx_power", &tx_power) == ESP_OK) {
            current_tx_power_dbm = tx_power;
            ESP_LOGI(TAG, "NVS loaded tx_power=%d", tx_power);
        }

        uint16_t rate = 1000;
        if (nvs_get_u16(my_handle, "sample_rate", &rate) == ESP_OK) {
            sampling_rate = rate;
            ESP_LOGI(TAG, "NVS loaded sampling_rate=%u", rate);
        }

        uint16_t threshold = 29;
        if (nvs_get_u16(my_handle, "burst_thresh", &threshold) == ESP_OK) {
            burst_threshold = threshold;
            ESP_LOGI(TAG, "NVS loaded burst_threshold=%u", threshold);
        }
        nvs_close(my_handle);
    }
}

/*============================================================================
 * FreeRTOS Tasks
 *===========================================================================*/

/* Core 0: Read active sensor at 1000 Hz (driven by periodic hardware timer) */
static void pushTask(void *pvParameters) {
    int16_t rawX, rawY, rawZ;
    int16_t last_x = 0, last_y = 0, last_z = 0;

    while (1) {
        if (xSemaphoreTake(sample_sem, portMAX_DELAY) == pdTRUE) {
            if (streaming_active) {
                if (read_active_sensor_data(&rawX, &rawY, &rawZ)) {
                    last_x = rawX;
                    last_y = rawY;
                    last_z = rawZ;
                } else {
                    rawX = last_x;
                    rawY = last_y;
                    rawZ = last_z;
                }

                uint32_t currentMillis = (uint32_t)(esp_timer_get_time() / 1000);

                portENTER_CRITICAL(&myMutex);
                valueQueue[queueTail].rel_timestamp_ms = (uint16_t)(currentMillis & 0xFFFF);
                valueQueue[queueTail].accel_x = rawX;
                valueQueue[queueTail].accel_y = rawY;
                valueQueue[queueTail].accel_z = rawZ;

                queueTail = (queueTail + 1) % QUEUE_SIZE;
                queueCount++;
                portEXIT_CRITICAL(&myMutex);

                if (queueCount >= burst_threshold) {
                    if (pullTaskHandle != NULL) {
                        xTaskNotifyGive(pullTaskHandle);
                    }
                }
            } else {
                portENTER_CRITICAL(&myMutex);
                queueHead = 0;
                queueTail = 0;
                queueCount = 0;
                portEXIT_CRITICAL(&myMutex);
            }
        }
    }
}

/* Core 1: Pack queue elements and send custom notifications */
static void pullTask(void *pvParameters) {
    pullTaskHandle = xTaskGetCurrentTaskHandle();
    accel_packet_t packet;
    uint32_t packetSequence = 0;

    while (1) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);

        if (!device_connected || !streaming_active) continue;

        while (queueCount >= 29 && streaming_active) {
            packet.packet_counter = packetSequence++;
            packet.first_sample_offset = 0x00;

            portENTER_CRITICAL(&myMutex);
            for (int i = 0; i < 29; i++) {
                /* Compute sequential un-aliased milliseconds from index matching coincell-firmware */
                uint32_t current_sample_index = packet.packet_counter * 29 + i + 1;
                packet.samples[i].rel_timestamp_ms = (uint16_t)(((uint64_t)current_sample_index * 1000ULL) / sampling_rate);
                packet.samples[i].accel_x = valueQueue[queueHead].accel_x;
                packet.samples[i].accel_y = valueQueue[queueHead].accel_y;
                packet.samples[i].accel_z = valueQueue[queueHead].accel_z;

                queueHead = (queueHead + 1) % QUEUE_SIZE;
            }
            queueCount -= 29;
            portEXIT_CRITICAL(&myMutex);

            packet.crc16 = crc16_ccitt(0, (uint8_t *)&packet, 237);

            struct os_mbuf *om = ble_hs_mbuf_from_flat(&packet, sizeof(accel_packet_t));
            if (om != NULL) {
                int rc = ble_gatts_notify_custom(conn_handle, data_val_handle, om);
                if (rc != 0) {
                    ESP_LOGE(TAG, "Error sending BLE notification; rc=%d", rc);
                }
            }

            if (packetSequence % 10 == 0) {
                ESP_LOGI(TAG, "Packet %lu sent. Left in queue: %d", (unsigned long)packetSequence, queueCount);
            }

            vTaskDelay(pdMS_TO_TICKS(1)); /* breathing room yield */
        }
    }
}

// Timer callback moved above start_streaming

void ble_on_sync(void) {
    ble_hs_util_ensure_addr(1);
    start_advertising();
    set_esp32_tx_power(current_tx_power_dbm);
}

void ble_on_reset(int reason) {
    ESP_LOGE(TAG, "BLE Reset: reason=%d", reason);
}

void nimble_host_task(void *param) {
    nimble_port_run();
    nimble_port_freertos_deinit();
}

/*============================================================================
 * App Entry Point
 *===========================================================================*/
void app_main(void) {
    vTaskDelay(pdMS_TO_TICKS(1500)); /* Delay for console stability */

    ESP_LOGW(TAG, "================================================");
    ESP_LOGW(TAG, "  ESP32-S3 H3LIS331DL I2C DAQ Firmware (Rev 22)");
    ESP_LOGW(TAG, "================================================");

    /* 1. Initialize NVS */
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    load_nvs_settings();

    /* 2. Initialize NimBLE Port */
    ESP_ERROR_CHECK(nimble_port_init());

    ble_hs_cfg.sync_cb = ble_on_sync;
    ble_hs_cfg.reset_cb = ble_on_reset;

    int rc = ble_gatts_count_cfg(gatt_svr_svcs);
    if (rc != 0) {
        ESP_LOGE(TAG, "ble_gatts_count_cfg failed; rc=%d", rc);
        return;
    }

    rc = ble_gatts_add_svcs(gatt_svr_svcs);
    if (rc != 0) {
        ESP_LOGE(TAG, "ble_gatts_add_svcs failed; rc=%d", rc);
        return;
    }

    rc = ble_svc_gap_device_name_set("ISRO_AccelSensor_ESP");
    if (rc != 0) {
        ESP_LOGE(TAG, "ble_svc_gap_device_name_set failed; rc=%d", rc);
        return;
    }

    nimble_port_freertos_init(nimble_host_task);

    /* 3. Probe and initialize I2C Sensors */
    sensorReady = init_sensor();
    if (!sensorReady) {
        ESP_LOGE(TAG, "[WARNING] H3LIS331DL sensor not detected on bus scan!");
    } else {
        ESP_LOGI(TAG, "Sensor scan complete. H3LIS331DL = OK, MPU6050 = ELIMINATED");
    }

    /* 4. Setup Tasks and Semaphores */
    sample_sem = xSemaphoreCreateBinary();
    xTaskCreatePinnedToCore(pushTask, "pushTask", 4096, NULL, 5, NULL, 0);
    xTaskCreatePinnedToCore(pullTask, "pullTask", 6144, NULL, 5, &pullTaskHandle, 1);

    ESP_LOGW(TAG, "System ready. Waiting for connections.");

    while (1) {
        ESP_LOGI(TAG, "[HEARTBEAT] Uptime: %llds | BLE: %s | Range: ±%ug | H3LIS: %s | Queue: %d",
                 esp_timer_get_time() / 1000000,
                 device_connected ? "CONNECTED" : "WAITING",
                 sensor_meta.range_g,
                 h3lis_detected ? "OK" : "NO",
                 queueCount);
        vTaskDelay(pdMS_TO_TICKS(3000));
    }
}
