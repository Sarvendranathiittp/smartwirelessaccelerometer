/*
 * Copyright (c) 2018 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
 *
 * ESB Wireless Vibration Telemetry — Network Core (PTX)
 * ISRO RESPOND Programme / IIT Tirupati Smart Mechatronics Lab
 *
 * Architecture:
 *   - RTC0 (LFCLK, 32 ticks = 976 µs) fires at exact 1024 Hz
 *   - H3LIS331DL read via bare-register SPIM gate (ENABLE=7→0 per sample)
 *   - HFCLK (HFINT) active only during ~12 µs SPI transfer per sample
 *   - ESB TX fires every 40 samples (~25.6 Hz); HFXO started 1 ms early
 *   - HFXO stopped immediately in TX event handler
 *   - CPU stays in sleep mode for remainder of each 976 µs window
 *   - App core is kept in sleep mode via custom empty_app_core
 */

#include <zephyr/drivers/clock_control.h>
#include <zephyr/drivers/clock_control/nrf_clock_control.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/irq.h>
#include <zephyr/logging/log.h>
#include <nrfx.h>
#include <esb.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/kernel.h>
#include <zephyr/types.h>
#include <zephyr/drivers/spi.h>
#include <zephyr/pm/device.h>
#include <hal/nrf_rtc.h>
#include <hal/nrf_clock.h>
#include <zephyr/sys/crc.h>

LOG_MODULE_REGISTER(esb_ptx, CONFIG_LOG_DEFAULT_LEVEL);

/* ============================================================================
 * Packet Format
 * Total size = 4 + 1 + 1 + (40×6) + 2 = 248 bytes — fits ESB 252-byte max
 * ===========================================================================*/
#define SAMPLES_PER_PACKET 40

typedef struct __attribute__((packed)) {
    uint32_t packet_counter;
    uint8_t  sample_count;
    uint8_t  reserved;
    int16_t  samples[SAMPLES_PER_PACKET][3];  /* [X, Y, Z] in raw ADC counts */
    uint16_t crc16;
} esb_accel_packet_t;

/* ============================================================================
 * H3LIS331DL Register Map
 * Datasheet: DocID 17116 Rev 8
 * ===========================================================================*/
#define H3LIS331DL_WHO_AM_I         0x0F
#define H3LIS331DL_CTRL_REG1        0x20
#define H3LIS331DL_CTRL_REG2        0x21
#define H3LIS331DL_CTRL_REG3        0x22  /* INT1 source control */
#define H3LIS331DL_CTRL_REG4        0x23
#define H3LIS331DL_CTRL_REG5        0x24  /* FIFO control */
#define H3LIS331DL_FIFO_CTRL_REG    0x2E  /* FIFO mode + watermark */
#define H3LIS331DL_FIFO_SRC_REG     0x2F  /* FIFO status */
#define H3LIS331DL_OUT_X_L_MULTI    (0x28 | 0x80 | 0x40)  /* Read | Auto-inc */
#define H3LIS331DL_SPI_READ_BIT     0x80

/* CTRL_REG1 values */
#define H3LIS331DL_POWER_DOWN       0x00
#define H3LIS331DL_ODR_1KHZ         0x3F   /* PM=Normal, ODR=1000Hz, XYZ en */

/* CTRL_REG4 values */
#define H3LIS331DL_FS_400G          0x30   /* ±400g, BDU=0, BLE=0 */

/* FIFO_CTRL_REG: Stream mode, watermark = 32 samples */
#define H3LIS331DL_FIFO_STREAM_WM32 ((0x2 << 6) | 0x1F)

/* CTRL_REG5: FIFO_EN=1 */
#define H3LIS331DL_CTRL5_FIFO_EN    (1 << 6)

/* CTRL_REG3: I2_WTM=1 → INT2 pulses when FIFO watermark is reached */
#define H3LIS331DL_CTRL3_I2_WTM     (1 << 1)

/* ============================================================================
 * SPI Configuration
 *
 * MISO = P1.13 — we toggle its input buffer to eliminate leakage current
 * between SPI transfers.
 * ===========================================================================*/
#define MISO_PIN_INDEX 13   /* P1.13 on port 1 */

static const struct spi_dt_spec spi_dev =
    SPI_DT_SPEC_GET(DT_NODELABEL(h3lis331dl),
                    SPI_WORD_SET(8) | SPI_TRANSFER_MSB, 0);

/* ============================================================================
 * ESB State
 * ===========================================================================*/
static volatile bool esb_ready = true;
static uint32_t packet_counter  = 0;
static uint32_t esb_tx_success  = 0;
static uint32_t esb_tx_failed   = 0;

#define ESB_RF_CHANNEL 78   /* 2478 MHz — above all 2.4 GHz WiFi channels */

static void ptx_event_handler(struct esb_evt const *event)
{
    esb_ready = true;

    /* Stop HFXO immediately after TX — saves ~800 µA average.
     * ESB fires this at ~25.6 Hz (once per 40-sample packet), never at 1024 Hz. */
    NRF_CLOCK_NS->TASKS_HFCLKSTOP = 1;

    switch (event->evt_id) {
    case ESB_EVENT_TX_SUCCESS: esb_tx_success++; break;
    case ESB_EVENT_TX_FAILED:  esb_tx_failed++;  break;
    case ESB_EVENT_RX_RECEIVED: break;  /* PTX does not receive */
    }
}

static int esb_radio_init(void)
{
    int err;
    uint8_t base_addr_0[4] = {0xE7, 0xE7, 0xE7, 0xE7};
    uint8_t base_addr_1[4] = {0xC2, 0xC2, 0xC2, 0xC2};
    uint8_t addr_prefix[8] = {0xE7, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8};

    struct esb_config config = ESB_DEFAULT_CONFIG;
    config.protocol           = ESB_PROTOCOL_ESB_DPL;
    config.retransmit_delay   = 600;
    config.retransmit_count   = 0;
    config.bitrate            = ESB_BITRATE_2MBPS;
    config.event_handler      = ptx_event_handler;
    config.mode               = ESB_MODE_PTX;
    config.selective_auto_ack = true;
    /* -8 dBm: radio draws ~6 mA vs ~10 mA at 0 dBm during TX burst.
     * At 25.6 packets/sec × ~150 µs/burst: saves ~27 µA average. */
    config.tx_output_power    = ESB_TX_POWER_NEG8DBM;

    err = esb_init(&config);                             if (err) return err;
    err = esb_set_base_address_0(base_addr_0);           if (err) return err;
    err = esb_set_base_address_1(base_addr_1);           if (err) return err;
    err = esb_set_prefixes(addr_prefix, ARRAY_SIZE(addr_prefix)); if (err) return err;
    err = esb_set_rf_channel(ESB_RF_CHANNEL);            if (err) return err;

    LOG_INF("ESB: 2Mbps ch=%d pkt=%uB -8dBm noack",
            ESB_RF_CHANNEL, (unsigned)sizeof(esb_accel_packet_t));
    return 0;
}

/* ============================================================================
 * RTC0 — 1024 Hz Sample Timer
 * ===========================================================================*/
static K_SEM_DEFINE(sample_sem, 0, 1);

static void rtc0_isr(const void *arg)
{
    ARG_UNUSED(arg);
    if (nrf_rtc_event_check(NRF_RTC0, NRF_RTC_EVENT_COMPARE_0)) {
        nrf_rtc_event_clear(NRF_RTC0, NRF_RTC_EVENT_COMPARE_0);
        uint32_t cc = nrf_rtc_cc_get(NRF_RTC0, 0);
        nrf_rtc_cc_set(NRF_RTC0, 0, (cc + 32) & 0x00FFFFFF);
        k_sem_give(&sample_sem);
    }
}

static void start_sample_timer(void)
{
    nrf_rtc_task_trigger(NRF_RTC0, NRF_RTC_TASK_STOP);
    nrf_rtc_task_trigger(NRF_RTC0, NRF_RTC_TASK_CLEAR);
    nrf_rtc_prescaler_set(NRF_RTC0, 0);
    nrf_rtc_cc_set(NRF_RTC0, 0, 32);
    nrf_rtc_int_enable(NRF_RTC0, NRF_RTC_INT_COMPARE0_MASK);
    nrf_rtc_event_clear(NRF_RTC0, NRF_RTC_EVENT_COMPARE_0);

    IRQ_CONNECT(NRFX_IRQ_NUMBER_GET(NRF_RTC0), 2, rtc0_isr, NULL, 0);
    irq_enable(NRFX_IRQ_NUMBER_GET(NRF_RTC0));

    nrf_rtc_task_trigger(NRF_RTC0, NRF_RTC_TASK_START);
    LOG_INF("RTC0 started: 1024 Hz (32768/32, priority 2)");
}

/* ============================================================================
 * H3LIS331DL SPI Access
 * ===========================================================================*/

static int h3lis331dl_write_reg(uint8_t reg, uint8_t value)
{
    uint8_t tx[2] = {reg & ~H3LIS331DL_SPI_READ_BIT, value};
    const struct spi_buf     tx_buf = {.buf = tx, .len = 2};
    const struct spi_buf_set tx_set = {.buffers = &tx_buf, .count = 1};

    pm_device_action_run(spi_dev.bus, PM_DEVICE_ACTION_RESUME);
    int ret = spi_write_dt(&spi_dev, &tx_set);
    pm_device_action_run(spi_dev.bus, PM_DEVICE_ACTION_SUSPEND);
    return ret;
}

static int h3lis331dl_read_reg(uint8_t reg, uint8_t *value)
{
    uint8_t tx[2] = {reg | H3LIS331DL_SPI_READ_BIT, 0};
    uint8_t rx[2] = {0};
    const struct spi_buf     tb = {.buf = tx, .len = 2};
    const struct spi_buf_set ts = {.buffers = &tb, .count = 1};
    const struct spi_buf     rb = {.buf = rx, .len = 2};
    const struct spi_buf_set rs = {.buffers = &rb, .count = 1};

    pm_device_action_run(spi_dev.bus, PM_DEVICE_ACTION_RESUME);
    int ret = spi_transceive_dt(&spi_dev, &ts, &rs);
    pm_device_action_run(spi_dev.bus, PM_DEVICE_ACTION_SUSPEND);

    if (ret == 0) *value = rx[1];
    return ret;
}

static int h3lis331dl_read_accel_raw(int16_t *ax, int16_t *ay, int16_t *az)
{
    uint8_t tx[7] = {H3LIS331DL_OUT_X_L_MULTI, 0, 0, 0, 0, 0, 0};
    uint8_t rx[7] = {0};
    const struct spi_buf     tb = {.buf = tx, .len = 7};
    const struct spi_buf_set ts = {.buffers = &tb, .count = 1};
    const struct spi_buf     rb = {.buf = rx, .len = 7};
    const struct spi_buf_set rs = {.buffers = &rb, .count = 1};

    NRF_P1_NS->PIN_CNF[MISO_PIN_INDEX] &= ~GPIO_PIN_CNF_INPUT_Msk; /* Connect */
    NRF_SPIM0_NS->ENABLE = 7;  /* HFINT starts in ~0.6 µs */

    int ret = spi_transceive_dt(&spi_dev, &ts, &rs); /* EasyDMA: ~12 µs */

    NRF_SPIM0_NS->ENABLE = 0;  /* Gate HFCLK immediately */
    NRF_P1_NS->PIN_CNF[MISO_PIN_INDEX] |= GPIO_PIN_CNF_INPUT_Msk;  /* Disconnect */

    if (ret == 0) {
        *ax = (int16_t)((rx[2] << 8) | rx[1]);
        *ay = (int16_t)((rx[4] << 8) | rx[3]);
        *az = (int16_t)((rx[6] << 8) | rx[5]);
    }
    return ret;
}

/* ============================================================================
 * Sample Buffer
 * ===========================================================================*/
typedef struct { int16_t x, y, z; } raw_sample_t;
static raw_sample_t sample_buf[SAMPLES_PER_PACKET];

/* ============================================================================
 * Main
 * ===========================================================================*/
int main(void)
{
    int err;

    LOG_INF("ISRO ESB Telemetry v3 — network core starting");

    /* ── 1. Start LFCLK for RTC0 ──────────────────────────────────────────*/
    NRF_CLOCK_NS->TASKS_LFCLKSTART = 1;
    while (NRF_CLOCK_NS->EVENTS_LFCLKSTARTED == 0) { /* ~100 µs typical */ }
    NRF_CLOCK_NS->EVENTS_LFCLKSTARTED = 0;

    /* ── 2. Drive P0.18 (QSPI flash CS) HIGH ─────────────────────────────
     * Flash CS high prevents flash leakage (~2-3 mA saved). */
    NRF_P0_NS->PIN_CNF[18] = (GPIO_PIN_CNF_DIR_Output      << GPIO_PIN_CNF_DIR_Pos) |
                              (GPIO_PIN_CNF_INPUT_Disconnect << GPIO_PIN_CNF_INPUT_Pos);
    NRF_P0_NS->OUTSET = (1UL << 18);

    /* ── 3. Verify SPI bus and sensor ────────────────────────────────────*/
    if (!spi_is_ready_dt(&spi_dev)) {
        LOG_ERR("SPI not ready — check overlay pinctrl and DT binding");
        return -EIO;
    }

    uint8_t who_am_i = 0;
    h3lis331dl_read_reg(H3LIS331DL_WHO_AM_I, &who_am_i);
    k_msleep(10);
    who_am_i = 0;
    err = h3lis331dl_read_reg(H3LIS331DL_WHO_AM_I, &who_am_i);
    if (err || who_am_i != 0x32) {
        LOG_ERR("H3LIS331DL not found (WHO_AM_I=0x%02X, expected 0x32)", who_am_i);
    } else {
        LOG_INF("H3LIS331DL OK (WHO_AM_I=0x32)");
    }

    /* ── 4. Initialize ESB radio ──────────────────────────────────────────*/
    err = esb_radio_init();
    if (err) {
        LOG_ERR("ESB init failed: %d", err);
        return err;
    }

    /* ── 5. Configure sensor — 1000 Hz, ±400g ─────────────────────────────*/
    h3lis331dl_write_reg(H3LIS331DL_CTRL_REG1, H3LIS331DL_POWER_DOWN);
    k_msleep(5);
    h3lis331dl_write_reg(H3LIS331DL_CTRL_REG4, H3LIS331DL_FS_400G);
    h3lis331dl_write_reg(H3LIS331DL_CTRL_REG2, 0x00);
    h3lis331dl_write_reg(H3LIS331DL_CTRL_REG1, H3LIS331DL_ODR_1KHZ);
    k_msleep(10);
    LOG_INF("Sensor configured: 1000 Hz, ±400g");

    /* ── 6. Start 1024 Hz RTC0 timer ─────────────────────────────────────*/
    start_sample_timer();

    /* ── 7. Setup system registers ─────────────────────────────────────*/
    SCB->SCR |= SCB_SCR_SLEEPDEEP_Msk;

    /* GPIOTE latency config */
    NRF_GPIOTE_NS->LATENCY = GPIOTE_LATENCY_LATENCY_LowPower;

    /* Disable all GPIOTE channel interrupts */
    NRF_GPIOTE_NS->INTENCLR = 0xFFFFFFFF;

    /* Release boot-time HFCLK request */
    NRF_CLOCK_NS->TASKS_HFCLKSTOP = 1;

    /* Pre-disable SPIM and disconnect MISO */
    NRF_SPIM0_NS->ENABLE = 0;
    NRF_P1_NS->PIN_CNF[MISO_PIN_INDEX] |= GPIO_PIN_CNF_INPUT_Msk;

    /* ── 8. Main sampling + transmission loop ────────────────────────────*/
    LOG_INF("Streaming: %d samples/pkt @ 25.6 pkt/sec", SAMPLES_PER_PACKET);

    static esb_accel_packet_t pkt;
    static struct esb_payload esb_tx_payload;
    int16_t ax, ay, az;
    int16_t last_ax = 0, last_ay = 0, last_az = 0;
    uint32_t total_samples = 0;
    uint16_t buf_idx       = 0;
    bool hfxo_started      = false;

    esb_tx_payload.pipe   = 0;
    esb_tx_payload.noack  = true;
    esb_tx_payload.length = sizeof(esb_accel_packet_t);

    while (1) {
        k_sem_take(&sample_sem, K_FOREVER);

        int ret = h3lis331dl_read_accel_raw(&ax, &ay, &az);
        if (ret < 0) {
            ax = last_ax; ay = last_ay; az = last_az;
        } else {
            last_ax = ax; last_ay = ay; last_az = az;
        }

        sample_buf[buf_idx].x = ax;
        sample_buf[buf_idx].y = ay;
        sample_buf[buf_idx].z = az;
        buf_idx++;
        total_samples++;

        /* Anticipatory HFXO startup (1 sample = 976 µs before TX) */
        if (buf_idx == SAMPLES_PER_PACKET - 1 && esb_ready) {
            NRF_CLOCK_NS->TASKS_HFCLKSTART = 1;
            hfxo_started = true;
        }

        /* TX block: fires every 40 samples */
        if (buf_idx >= SAMPLES_PER_PACKET) {
            bool do_tx = esb_ready;

            if (do_tx && !hfxo_started) {
                NRF_CLOCK_NS->TASKS_HFCLKSTART = 1;
            }
            hfxo_started = false;

            /* Build packet */
            pkt.packet_counter = packet_counter++;
            pkt.sample_count   = SAMPLES_PER_PACKET;
            pkt.reserved       = 0;
            for (int i = 0; i < SAMPLES_PER_PACKET; i++) {
                pkt.samples[i][0] = sample_buf[i].x;
                pkt.samples[i][1] = sample_buf[i].y;
                pkt.samples[i][2] = sample_buf[i].z;
            }
            pkt.crc16 = crc16_ccitt(0, (uint8_t *)&pkt,
                                    sizeof(esb_accel_packet_t) - sizeof(uint16_t));
            memcpy(esb_tx_payload.data, &pkt, sizeof(esb_accel_packet_t));

            if (do_tx) {
                esb_ready = false;
                esb_flush_tx();

                while (NRF_CLOCK_NS->EVENTS_HFCLKSTARTED == 0) { /* wait */ }
                NRF_CLOCK_NS->EVENTS_HFCLKSTARTED = 0;

                ret = esb_write_payload(&esb_tx_payload);
                if (ret) {
                    LOG_ERR("ESB TX failed: %d", ret);
                    esb_ready = true;
                    NRF_CLOCK_NS->TASKS_HFCLKSTOP = 1;
                }
            }

            buf_idx = 0;

            if (packet_counter % 256 == 0) {
                LOG_INF("pkts=%u ok=%u fail=%u samples=%u",
                        packet_counter, esb_tx_success,
                        esb_tx_failed, total_samples);
            }
        }
    }
    return 0;
}
