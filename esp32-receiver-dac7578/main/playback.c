/**
 * @file playback.c
 * @brief DAC7578 Playback Engine — 3x Polyphase Upsampling
 */

#include "playback.h"
#include "dac7578.h"
#include "driver/gptimer.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

static const char *TAG = "playback";

#ifndef M_PI
#define M_PI 3.14159265358979323846f
#endif

/*============================================================================
 * Constants
 *===========================================================================*/

#define NUM_CH 3
#define PRE_BUFFER_MS 150
#define KAISER_BETA 8.0f
#define FIR_NTAPS 24
#define FIR_CENTER ((FIR_NTAPS - 1) / 2.0f)

/* --- 3x Mode (Active) --- */
#define DAC_TICKS 326   /* 325.5 µs = 3072 Hz output rate (L=3 * 1024Hz) */
#define SINC_L 3        /* 3x Upsampling */
#define POLY_TAPS 8     /* 24 / 3 = 8 taps per branch */

#define FIR_FC (1.0f / (float)SINC_L)

/*============================================================================
 * Bessel I0 (for Kaiser window computation at init time)
 *===========================================================================*/
static float bes_i0(float x) {
  float sum = 1.0f, u = 1.0f;
  for (int k = 1; k < 25; k++) {
    u *= (x * x) / (4.0f * (float)k * (float)k);
    sum += u;
    if (u < sum * 1e-7f)
      break;
  }
  return sum;
}

/*============================================================================
 * Polyphase FIR Coefficient Table (computed once at init)
 *===========================================================================*/

static DRAM_ATTR int32_t poly_q31[SINC_L][POLY_TAPS];
static DRAM_ATTR int32_t q31_scale;

static void fir_init(void) {
  float *h = malloc(FIR_NTAPS * sizeof(float));
  if (!h) return;
  float i0b = bes_i0(KAISER_BETA);

  /* Compute windowed sinc prototype */
  for (int n = 0; n < FIR_NTAPS; n++) {
    float x = (float)n - FIR_CENTER;
    float sinc =
        (fabsf(x) < 1e-7f) ? FIR_FC : sinf(M_PI * FIR_FC * x) / (M_PI * x);
    float t = 2.0f * (float)n / (float)(FIR_NTAPS - 1) - 1.0f;
    float win = bes_i0(KAISER_BETA * sqrtf(1.0f - t * t)) / i0b;
    h[n] = sinc * win * (float)SINC_L;
  }

  /* Decompose into polyphase branches + normalize DC gain */
  float (*poly_f)[POLY_TAPS] = malloc(SINC_L * sizeof(*poly_f));
  if (!poly_f) { free(h); return; }
  
  memset(poly_f, 0, SINC_L * sizeof(*poly_f));
  for (int p = 0; p < SINC_L; p++) {
    float sum = 0.0f;
    for (int k = 0; k < POLY_TAPS; k++) {
      int idx = p + k * SINC_L;
      poly_f[p][k] = (idx < FIR_NTAPS) ? h[idx] : 0.0f;
      sum += poly_f[p][k];
    }
    if (fabsf(sum) > 1e-9f)
      for (int k = 0; k < POLY_TAPS; k++)
        poly_f[p][k] /= sum;
  }

  /* Quantize to high precision (using 24-bit range to prevent overflow) */
  float mx = 0.0f;
  for (int p = 0; p < SINC_L; p++)
    for (int k = 0; k < POLY_TAPS; k++)
      if (fabsf(poly_f[p][k]) > mx)
        mx = fabsf(poly_f[p][k]);

  /* Scale factor: use 2^24 (16,777,216) to ensure q31_scale (mx * sf) fits int32 */
  float sf = 16777216.0f; 
  q31_scale = (int32_t)sf;

  for (int p = 0; p < SINC_L; p++)
    for (int k = 0; k < POLY_TAPS; k++) {
      float v = poly_f[p][k] * sf;
      poly_q31[p][k] = (int32_t)(v >= 0.0f ? v + 0.5f : v - 0.5f);
    }

  free(h);
  free(poly_f);

  ESP_LOGI(TAG, "FIR: %d-tap Kaiser(%.1f) → %d branches × %d taps, Fixed-24",
           FIR_NTAPS, KAISER_BETA, SINC_L, POLY_TAPS);
}

/*============================================================================
 * Input Ring Buffer (BLE @ 1 kHz → Task @ 3 kHz)
 *===========================================================================*/

#define RING_SZ 2048
#define RING_MASK (RING_SZ - 1)

typedef struct {
  accel_sample_t buf[RING_SZ];
  volatile uint32_t head, tail;
} ring_t;

static DRAM_ATTR ring_t ring;

static inline uint32_t ring_count(void) {
  return (ring.head - ring.tail) & RING_MASK;
}
static inline bool ring_push(accel_sample_t s) {
  uint32_t nxt = (ring.head + 1) & RING_MASK;
  if (nxt == ring.tail)
    return false;
  ring.buf[ring.head] = s;
  ring.head = nxt;
  return true;
}
static inline bool ring_pop(accel_sample_t *s) {
  if (ring.head == ring.tail)
    return false;
  *s = ring.buf[ring.tail];
  ring.tail = (ring.tail + 1) & RING_MASK;
  return true;
}

/*============================================================================
 * Per-Channel FIR State
 *===========================================================================*/

typedef struct {
  int32_t buf[POLY_TAPS]; /* sample history */
  int idx;
  int32_t last_raw;
} fir_ch_t;

static DRAM_ATTR fir_ch_t fir[NUM_CH];

static inline void fir_push_sample(int ch, int32_t v) {
  if (++fir[ch].idx >= POLY_TAPS)
    fir[ch].idx = 0;
  fir[ch].buf[fir[ch].idx] = v;
}

static inline int32_t fir_eval(int ch, int phase) {
  const int32_t *c = poly_q31[phase];
  const int32_t *b = fir[ch].buf;
  int i = fir[ch].idx;
  int64_t acc = 0;
  for (int k = 0; k < POLY_TAPS; k++) {
    acc += (int64_t)c[k] * (int64_t)b[i];
    if (--i < 0)
      i = POLY_TAPS - 1;
  }
  return (int32_t)(acc / (int64_t)q31_scale);
}

/*============================================================================
 * Dynamic G-Scaling & Mapping [0, 4095]
 *===========================================================================*/

static volatile float current_g_limit = 100.0f; // Default to ±100g
static volatile float lsb_per_g = 327.68f;      // 32768 / 100
static volatile bool running = false;

static DRAM_ATTR uint32_t clip_count = 0;

void playback_set_range(int16_t range_g) {
  if (range_g <= 0) range_g = 100;
  current_g_limit = (float)range_g;
  lsb_per_g = 32768.0f / current_g_limit;
  ESP_LOGW(TAG, "★ Playback scaling updated for range ±%dG (lsb_per_g=%.2f)", range_g, lsb_per_g);
}

static inline uint16_t val_to_dac(int32_t raw_val) {
  float g = (float)raw_val / lsb_per_g;
  if (g > current_g_limit) {
    g = current_g_limit;
    clip_count++;
  } else if (g < -current_g_limit) {
    g = -current_g_limit;
    clip_count++;
  }
  // Convert physical Gs linearly to 12-bit DAC code: [G_MIN, G_MAX] -> [0, 4095]
  return (uint16_t)(((g + current_g_limit) * 4095.0f) / (2.0f * current_g_limit));
}

/*============================================================================
 * Runtime Statistics
 *===========================================================================*/

static DRAM_ATTR uint32_t isr_uf = 0;  /* underflow: ring empty */
static DRAM_ATTR uint32_t ovf_cnt = 0; /* overflow: ring full (enqueue) */
static uint32_t stat_ts = 0;

static void stats_cb(void *arg) {
  if (!running) return;
  uint32_t now = (uint32_t)(esp_timer_get_time() / 1000000ULL);
  uint32_t dt = now - stat_ts;
  if (dt == 0)
    dt = 1;
  stat_ts = now;
  ESP_LOGI(TAG, "buf=%4lu | uf=%lu clip=%lu ovf=%lu | limit=±%.1fG",
           (unsigned long)ring_count(), (unsigned long)isr_uf,
           (unsigned long)clip_count, (unsigned long)ovf_cnt,
           current_g_limit);
}

/*============================================================================
 * Task-Based Playback & I2C Writing
 *===========================================================================*/

static DRAM_ATTR uint8_t phase = 0;
static gptimer_handle_t gtimer = NULL;

static SemaphoreHandle_t timer_sem = NULL;
static TaskHandle_t playback_task_handle = NULL;

static void playback_task(void *arg) {
  accel_sample_t s;
  
  while (1) {
    if (xSemaphoreTake(timer_sem, portMAX_DELAY) == pdTRUE) {
      if (!running) continue;

      /* Phase 0: Dequeue new sample and push history */
      if (phase == 0) {
        if (ring_pop(&s)) {
          fir[0].last_raw = (int32_t)s.accel_x;
          fir[1].last_raw = (int32_t)s.accel_y;
          fir[2].last_raw = (int32_t)s.accel_z;
        } else {
          isr_uf++;
        }
        for (int ch = 0; ch < NUM_CH; ch++) {
          fir_push_sample(ch, fir[ch].last_raw);
        }
      }

      /* Write interpolated coordinates directly over I2C (safe in Task context) */
      int32_t val_x = fir_eval(0, phase);
      int32_t val_y = fir_eval(1, phase);
      int32_t val_z = fir_eval(2, phase);

      dac7578_write(DAC7578_CH_X, val_to_dac(val_x));
      dac7578_write(DAC7578_CH_Y, val_to_dac(val_y));
      dac7578_write(DAC7578_CH_Z, val_to_dac(val_z));

      phase = (phase + 1) % SINC_L;
    }
  }
}

static bool IRAM_ATTR playback_isr(gptimer_handle_t t,
                                   const gptimer_alarm_event_data_t *e,
                                   void *u) {
  BaseType_t high_task_awoken = pdFALSE;
  xSemaphoreGiveFromISR(timer_sem, &high_task_awoken);
  return high_task_awoken == pdTRUE;
}

/*============================================================================
 * Public API
 *===========================================================================*/

void playback_init(void) {
  phase = 0;
  isr_uf = ovf_cnt = clip_count = 0;
  running = false;

  for (int ch = 0; ch < NUM_CH; ch++) {
    memset(fir[ch].buf, 0, sizeof(fir[ch].buf));
    fir[ch].idx = 0;
    fir[ch].last_raw = 0;
  }

  fir_init();

  if (dac7578_init() != ESP_OK) {
    ESP_LOGE(TAG, "DAC7578 hardware I2C init FAILED");
    return;
  }

  /* Set mid-scale (0g) to start with */
  dac7578_write(DAC7578_CH_X, DAC7578_MAX / 2);
  dac7578_write(DAC7578_CH_Y, DAC7578_MAX / 2);
  dac7578_write(DAC7578_CH_Z, DAC7578_MAX / 2);

  if (timer_sem == NULL) {
    timer_sem = xSemaphoreCreateBinary();
  }

  if (playback_task_handle == NULL) {
    xTaskCreatePinnedToCore(playback_task, "playback_task", 4096, NULL, 20, &playback_task_handle, 1);
  }

  /* Setup 3072 Hz Alarm GPTimer */
  if (gtimer == NULL) {
    gptimer_config_t tc = {.clk_src = GPTIMER_CLK_SRC_DEFAULT,
                           .direction = GPTIMER_COUNT_UP,
                           .resolution_hz = 1000000};
    ESP_ERROR_CHECK(gptimer_new_timer(&tc, &gtimer));

    gptimer_event_callbacks_t cb = {.on_alarm = playback_isr};
    ESP_ERROR_CHECK(gptimer_register_event_callbacks(gtimer, &cb, NULL));

    gptimer_alarm_config_t ac = {.reload_count = 0,
                                 .alarm_count = DAC_TICKS,
                                 .flags.auto_reload_on_alarm = true};
    ESP_ERROR_CHECK(gptimer_set_alarm_action(gtimer, &ac));
    ESP_ERROR_CHECK(gptimer_enable(gtimer));
  }

  /* Start stats timer (every 5 seconds) */
  static esp_timer_handle_t st = NULL;
  if (st == NULL) {
    esp_timer_create_args_t sa = {.callback = stats_cb, .name = "pb_stats"};
    ESP_ERROR_CHECK(esp_timer_create(&sa, &st));
    ESP_ERROR_CHECK(esp_timer_start_periodic(st, 5000000));
  }

  ESP_LOGW(TAG, "★ Playback initialized: 3x polyphase upsampling → 3072Hz DAC7578 I2C task");
}

void playback_start(void) {
  if (running) return;
  ring.head = ring.tail = 0;
  phase = 0;
  isr_uf = ovf_cnt = clip_count = 0;

  for (int ch = 0; ch < NUM_CH; ch++) {
    memset(fir[ch].buf, 0, sizeof(fir[ch].buf));
    fir[ch].idx = 0;
    fir[ch].last_raw = 0;
  }

  running = true;
  if (gtimer) {
    ESP_ERROR_CHECK(gptimer_start(gtimer));
  }
  ESP_LOGW(TAG, "★ Playback engine STARTED");
}

void playback_stop(void) {
  if (!running) return;
  running = false;
  if (gtimer) {
    ESP_ERROR_CHECK(gptimer_stop(gtimer));
  }

  /* Set mid-scale (0g) on stop */
  dac7578_write(DAC7578_CH_X, DAC7578_MAX / 2);
  dac7578_write(DAC7578_CH_Y, DAC7578_MAX / 2);
  dac7578_write(DAC7578_CH_Z, DAC7578_MAX / 2);
  ESP_LOGW(TAG, "★ Playback engine STOPPED (channels set to mid-scale)");
}

void playback_enqueue(const accel_packet_t *packet) {
  if (!running) return;
  for (int i = 0; i < SAMPLES_PER_PACKET; i++) {
    if (!ring_push(packet->samples[i]))
      ovf_cnt++;
  }
}

void playback_reset(void) {
  playback_stop();
  playback_start();
}
