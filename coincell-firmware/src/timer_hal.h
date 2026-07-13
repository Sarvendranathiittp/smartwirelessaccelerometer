/*============================================================================
 * Hardware TIMER1 for Exact 1000 Hz Sampling (Proven for 1.69mA Baseline)
 *===========================================================================*/

#include <hal/nrf_timer.h>
#include <hal/nrf_clock.h>
#include <zephyr/irq.h>

/* Semaphore given by TIMER1 ISR every 1000µs */
static K_SEM_DEFINE(sample_sem, 0, 10);

static void timer_handler(const struct device *dev, void *user_data)
{
    ARG_UNUSED(dev);
    ARG_UNUSED(user_data);
    
    if (nrf_timer_event_check(NRF_TIMER1, NRF_TIMER_EVENT_COMPARE0)) {
        nrf_timer_event_clear(NRF_TIMER1, NRF_TIMER_EVENT_COMPARE0);
        k_sem_give(&sample_sem);
    }
}

static int init_sample_timer(void)
{
    /* Note: Connect once at boot to prevent crashes on re-init */
    static bool connected = false;
    
    nrf_timer_task_trigger(NRF_TIMER1, NRF_TIMER_TASK_STOP);
    nrf_timer_task_trigger(NRF_TIMER1, NRF_TIMER_TASK_CLEAR);
    
    nrf_timer_mode_set(NRF_TIMER1, NRF_TIMER_MODE_TIMER);
    nrf_timer_bit_width_set(NRF_TIMER1, NRF_TIMER_BIT_WIDTH_32);
    
    /* 16MHz / 2^4 = 1MHz (1 tick = 1µs) */
    nrf_timer_prescaler_set(NRF_TIMER1, 4);
    
    nrf_timer_cc_set(NRF_TIMER1, NRF_TIMER_CC_CHANNEL0, 1000);
    nrf_timer_shorts_enable(NRF_TIMER1, NRF_TIMER_SHORT_COMPARE0_CLEAR_MASK);
    nrf_timer_int_enable(NRF_TIMER1, NRF_TIMER_INT_COMPARE0_MASK);
    
    if (!connected) {
        IRQ_CONNECT(TIMER1_IRQn, 5, timer_handler, NULL, 0);
        irq_enable(TIMER1_IRQn);
        connected = true;
    }
    
    LOG_INF("TIMER1 initialized for 1000 Hz hardware sampling");
    return 0;
}
