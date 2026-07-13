/**
 * @file playback.c
 * @brief DAC8568 Playback Engine — Production Grade
 *
 * Architecture:
 *   BLE (1 kHz) → Ring Buffer → 10× Polyphase Sinc → DAC (10 kHz)
 *
 * Key Design Decisions:
 *   - Kaiser window (β=7.85, 80dB rejection) for FlexLogger compatibility
 *   - int32_t arithmetic throughout — NO int16_t truncation in signal path
 *   - Saturating clamp at DAC output stage (prevents wrap-around distortion)
 *   - Diagnostic bypass mode for isolating sensor vs DSP issues
 *   - Comprehensive runtime statistics (underflows, clipping, buffer depth)
 *
 * @version 5.0 — Production
 */

#include "playback.h"
#include "dac8568.h"
#include "driver/gptimer.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "esp_timer.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

static const char *TAG = "playback";

#ifndef M_PI
#define M_PI 3.14159265358979323846f
#endif

/*============================================================================
 * Build Configuration
 *
 * BYPASS_SINC: output raw 1kHz samples (zero-order hold) for diagnostics
 *              Comment out for normal operation.
 *===========================================================================*/

/* #define BYPASS_SINC */

/*============================================================================
 * Constants
 *===========================================================================*/

#define NUM_CH 3
#define PRE_BUFFER_MS 150
#define KAISER_BETA 8.0f
#define FIR_NTAPS 240
#define FIR_CENTER ((FIR_NTAPS - 1) / 2.0f)

/* --- 10x Mode (Active) --- */
#define DAC_TICKS 100   /* 100 µs = 10 kHz output rate */
#define SINC_L 10       /* 10x Upsampling */
#define POLY_TAPS 24    /* 240 / 10 */

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
 * Input Ring Buffer (BLE @ 1 kHz → ISR @ 10 kHz)
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
static inline bool IRAM_ATTR ring_pop(accel_sample_t *s) {
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
  int32_t buf[POLY_TAPS]; /* sample history (int32 — no truncation!) */
  int idx;
  int32_t last_raw; /* int32 — NOT int16 */
} fir_ch_t;

static DRAM_ATTR fir_ch_t fir[NUM_CH];

static inline void IRAM_ATTR fir_push_sample(int ch, int32_t v) {
  if (++fir[ch].idx >= POLY_TAPS)
    fir[ch].idx = 0;
  fir[ch].buf[fir[ch].idx] = v;
}

/**
 * Evaluate one polyphase branch. Returns int32_t — full precision,
 * NO truncation to int16_t anywhere in this path.
 */
static inline int32_t IRAM_ATTR fir_eval(int ch, int phase) {
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
 * Output Scaling: int32 → uint16 DAC code (SATURATING, never wrapping)
 *
 * Input:  int32_t value in MPU6050 raw-count domain (~±32768)
 *         May exceed ±32768 due to sinc overshoot (Gibbs phenomenon)
 * Output: uint16_t DAC code [0, 65535]
 *
 * The key fix: we clamp BEFORE converting, so sinc overshoot
 * saturates gracefully instead of wrapping around.
 *===========================================================================*/

static DRAM_ATTR uint32_t clip_count = 0;

static inline uint16_t IRAM_ATTR val_to_dac(int32_t val) {
  int32_t code = val + 32768;
  if (code < 0) {
    code = 0;
    clip_count++;
  }
  if (code > 65535) {
    code = 65535;
    clip_count++;
  }
  return (uint16_t)code;
}

/*============================================================================
 * Runtime Statistics
 *===========================================================================*/

static DRAM_ATTR uint32_t isr_uf = 0;  /* underflow: ring empty */
static DRAM_ATTR uint32_t ovf_cnt = 0; /* overflow: ring full (enqueue) */
static uint32_t stat_ts = 0;

static void stats_cb(void *arg) {
  uint32_t now = (uint32_t)(esp_timer_get_time() / 1000000ULL);
  uint32_t dt = now - stat_ts;
  if (dt == 0)
    dt = 1;
  stat_ts = now;
  ESP_LOGI(TAG, "buf=%4lu | uf=%lu clip=%lu ovf=%lu",
           (unsigned long)ring_count(), (unsigned long)isr_uf,
           (unsigned long)clip_count, (unsigned long)ovf_cnt);
}

/*============================================================================
 * ISR: 10 kHz GPTimer Callback
 *===========================================================================*/

static DRAM_ATTR uint8_t phase = 0;
static gptimer_handle_t gtimer = NULL;
static volatile bool running = false;

static bool IRAM_ATTR playback_isr(gptimer_handle_t t,
                                   const gptimer_alarm_event_data_t *e,
                                   void *u) {
#ifdef BYPASS_SINC
  /* ── DIAGNOSTIC MODE: Raw 1kHz ZOH (no interpolation) ── */
  static uint8_t zoh_cnt = 0;
  if (zoh_cnt == 0) {
    accel_sample_t s;
    if (ring_pop(&s)) {
      fir[0].last_raw = (int32_t)s.accel_x;
      fir[1].last_raw = (int32_t)s.accel_y;
      fir[2].last_raw = (int32_t)s.accel_z;
    } else {
      isr_uf++;
    }
  }
  for (int ch = 0; ch < NUM_CH; ch++) {
    dac8568_write_isr(ch, val_to_dac(fir[ch].last_raw));
  }
  zoh_cnt = (zoh_cnt + 1) % SINC_L;

#else
  /* ── PRODUCTION MODE: 10× Polyphase Sinc ── */

  /* Phase 0: consume one input sample from ring buffer */
  if (phase == 0) {
    accel_sample_t s;
    if (ring_pop(&s)) {
      fir[0].last_raw = (int32_t)s.accel_x;
      fir[1].last_raw = (int32_t)s.accel_y;
      fir[2].last_raw = (int32_t)s.accel_z;
    } else {
      isr_uf++;
      /* Graceful hold: keep last_raw unchanged */
    }
    for (int ch = 0; ch < NUM_CH; ch++) {
      fir_push_sample(ch, fir[ch].last_raw);
    }
  }

  /* Evaluate polyphase branch for current phase and output to DAC */
  for (int ch = 0; ch < NUM_CH; ch++) {
    int32_t val = fir_eval(ch, phase);      /* int32 — full range */
    dac8568_write_isr(ch, val_to_dac(val)); /* saturating clamp */
  }

  phase = (phase + 1) % SINC_L;
#endif

  return false;
}

/*============================================================================
 * Public API
 *===========================================================================*/

void playback_init(void) {
  /* Reset state */
  ring.head = ring.tail = 0;
  phase = 0;
  isr_uf = ovf_cnt = clip_count = 0;

  for (int ch = 0; ch < NUM_CH; ch++) {
    memset(fir[ch].buf, 0, sizeof(fir[ch].buf));
    fir[ch].idx = 0;
    fir[ch].last_raw = 0;
  }

  /* Initialize filter coefficients */
  fir_init();

  /* Initialize DAC hardware */
  if (dac8568_init() != ESP_OK) {
    ESP_LOGE(TAG, "DAC8568 init FAILED");
    return;
  }

  /* Start 10 kHz GPTimer */
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
  ESP_ERROR_CHECK(gptimer_start(gtimer));
  running = true;

  /* Start stats timer (every 5 seconds) */
  esp_timer_handle_t st;
  esp_timer_create_args_t sa = {.callback = stats_cb, .name = "pb_stats"};
  ESP_ERROR_CHECK(esp_timer_create(&sa, &st));
  ESP_ERROR_CHECK(esp_timer_start_periodic(st, 5000000));

#ifdef BYPASS_SINC
  ESP_LOGW(TAG, "★ DIAGNOSTIC MODE: Raw 1kHz ZOH (sinc BYPASSED)");
#else
  ESP_LOGW(TAG, "★ PRODUCTION: 121-tap Kaiser Sinc → 10kHz DAC");
#endif
}

void playback_enqueue(const accel_packet_t *packet) {
  for (int i = 0; i < SAMPLES_PER_PACKET; i++) {
    if (!ring_push(packet->samples[i]))
      ovf_cnt++;
  }

  /* Auto-start after jitter buffer fills */
  /* (Timer is already running from init — data just flows through) */
}

void playback_reset(void) {
  ESP_LOGW(TAG, "Reset: uf=%lu clip=%lu ovf=%lu", (unsigned long)isr_uf,
           (unsigned long)clip_count, (unsigned long)ovf_cnt);
  if (running && gtimer) {
    gptimer_stop(gtimer);
    gptimer_disable(gtimer);
    gptimer_del_timer(gtimer);
    gtimer = NULL;
    running = false;
  }
  playback_init();
}
