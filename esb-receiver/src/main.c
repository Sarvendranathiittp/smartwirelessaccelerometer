/**
 * @file main.c
 * @brief ISRO ESB Receiver (PRX) — Real-Time Data Forwarding
 *
 * Architecture: Single-core on nRF5340 Network Core (CPUNET)
 *
 * Receives 248-byte ESB packets from the transmitter containing
 * 40 accelerometer samples each. Forwards data over UART (VCOM1)
 * to the host PC for dashboard visualization.
 *
 * Output Format (binary, per packet):
 *   [SYNC 0xAA 0x55] [packet_counter:4] [sample_count:1] [reserved:1]
 *   [samples: 40 × (X:2, Y:2, Z:2)] [crc16:2]
 *   Total: 2 + 248 = 250 bytes per packet at ~25.6 Hz
 */

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/drivers/clock_control.h>
#include <zephyr/drivers/clock_control/nrf_clock_control.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/sys/crc.h>
#include <nrfx.h>
#include <esb.h>
#include <string.h>

LOG_MODULE_REGISTER(esb_prx, LOG_LEVEL_INF);

/*============================================================================
 * ESB Packet Format (must match transmitter exactly)
 *===========================================================================*/

#define SAMPLES_PER_PACKET 40

typedef struct __attribute__((packed)) {
  uint32_t packet_counter;
  uint8_t  sample_count;
  uint8_t  reserved;
  int16_t  samples[SAMPLES_PER_PACKET][3];  /* 240 bytes */
  uint16_t crc16;
} esb_accel_packet_t;  /* 248 bytes */

_Static_assert(sizeof(esb_accel_packet_t) == 248, "Packet must be 248 bytes");

#define ESB_RF_CHANNEL 78  /* 2478 MHz — must match transmitter */

/*============================================================================
 * Statistics
 *===========================================================================*/

static volatile uint32_t packets_received = 0;
static volatile uint32_t crc_errors = 0;

/*============================================================================
 * UART Output Device
 *===========================================================================*/

static const struct device *uart_dev;

static void uart_send_bytes(const uint8_t *data, size_t len)
{
  for (size_t i = 0; i < len; i++) {
    uart_poll_out(uart_dev, data[i]);
  }
}

/*============================================================================
 * ESB Event Handler
 *===========================================================================*/

static struct esb_payload rx_payload;
static const uint8_t sync_header[2] = {0xAA, 0x55};

void esb_evt_cb(struct esb_evt const *event)
{
  int err;

  switch (event->evt_id) {
  case ESB_EVENT_TX_SUCCESS:
    break;
  case ESB_EVENT_TX_FAILED:
    break;
  case ESB_EVENT_RX_RECEIVED:
    while ((err = esb_read_rx_payload(&rx_payload)) == 0) {
      if (rx_payload.length != sizeof(esb_accel_packet_t)) {
        LOG_WRN("Bad packet length: %u", rx_payload.length);
        continue;
      }

      /* Verify CRC */
      esb_accel_packet_t *pkt = (esb_accel_packet_t *)rx_payload.data;
      uint16_t calc_crc = crc16_ccitt(0, (uint8_t *)pkt,
                                       sizeof(esb_accel_packet_t) - sizeof(uint16_t));
      if (calc_crc != pkt->crc16) {
        crc_errors++;
        LOG_WRN("CRC error: calc=0x%04X pkt=0x%04X", calc_crc, pkt->crc16);
        continue;
      }

      packets_received++;

      /* Forward to UART: [SYNC] [packet data] */
      uart_send_bytes(sync_header, 2);
      uart_send_bytes(rx_payload.data, sizeof(esb_accel_packet_t));
    }
    break;
  }
}

/*============================================================================
 * ESB PRX Initialization
 *===========================================================================*/

static int esb_radio_init(void)
{
  int err;

  uint8_t base_addr_0[4] = {0xE7, 0xE7, 0xE7, 0xE7};
  uint8_t base_addr_1[4] = {0xC2, 0xC2, 0xC2, 0xC2};
  uint8_t addr_prefix[8] = {0xE7, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8};

  struct esb_config config = ESB_DEFAULT_CONFIG;

  config.protocol          = ESB_PROTOCOL_ESB_DPL;
  config.payload_length    = sizeof(esb_accel_packet_t);
  config.bitrate           = ESB_BITRATE_2MBPS;
  config.mode              = ESB_MODE_PRX;
  config.event_handler     = esb_evt_cb;
  config.selective_auto_ack = true;

  err = esb_init(&config);
  if (err) {
    LOG_ERR("ESB init failed: %d", err);
    return err;
  }

  err = esb_set_base_address_0(base_addr_0);
  if (err) return err;

  err = esb_set_base_address_1(base_addr_1);
  if (err) return err;

  err = esb_set_prefixes(addr_prefix, ARRAY_SIZE(addr_prefix));
  if (err) return err;

  err = esb_set_rf_channel(ESB_RF_CHANNEL);
  if (err) return err;

  LOG_INF("ESB PRX initialized: 2 Mbps, channel %d, payload %u bytes",
          ESB_RF_CHANNEL, sizeof(esb_accel_packet_t));
  return 0;
}

/*============================================================================
 * HF Clock Start
 *===========================================================================*/

static int clocks_start(void)
{
  int err;
  int res;
  struct onoff_manager *clk_mgr;
  struct onoff_client clk_cli;

  clk_mgr = z_nrf_clock_control_get_onoff(CLOCK_CONTROL_NRF_SUBSYS_HF);
  if (!clk_mgr) {
    LOG_ERR("Unable to get the Clock manager");
    return -ENXIO;
  }

  sys_notify_init_spinwait(&clk_cli.notify);

  err = onoff_request(clk_mgr, &clk_cli);
  if (err < 0) {
    LOG_ERR("Clock request failed: %d", err);
    return err;
  }

  do {
    err = sys_notify_fetch_result(&clk_cli.notify, &res);
    if (!err && res) {
      LOG_ERR("Clock could not be started: %d", res);
      return res;
    }
  } while (err);

  LOG_INF("HF clock started");
  return 0;
}

/*============================================================================
 * Main
 *===========================================================================*/

int main(void)
{
  int err;

  LOG_INF("================================================");
  LOG_INF("ISRO ESB Receiver — Real-Time Data Forwarding");
  LOG_INF("================================================");

  /* Get UART device for binary data output */
  uart_dev = DEVICE_DT_GET(DT_NODELABEL(uart0));
  if (!device_is_ready(uart_dev)) {
    LOG_ERR("UART device not ready");
    return 0;
  }

  /* Start HF clock */
  err = clocks_start();
  if (err) {
    LOG_ERR("Clock start failed");
    return 0;
  }

  /* Initialize ESB radio as PRX */
  err = esb_radio_init();
  if (err) {
    LOG_ERR("ESB radio init failed: %d", err);
    return 0;
  }

  /* Start listening */
  err = esb_start_rx();
  if (err) {
    LOG_ERR("ESB RX start failed: %d", err);
    return 0;
  }

  LOG_INF("Listening for ESB packets on channel %d...", ESB_RF_CHANNEL);

  /* Main loop — just print stats periodically */
  while (1) {
    k_sleep(K_SECONDS(5));
    LOG_INF("RX Stats: packets=%u crc_errors=%u",
            packets_received, crc_errors);
  }

  return 0;
}
