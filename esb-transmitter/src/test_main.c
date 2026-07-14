#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/pm/device.h>
#include <zephyr/logging/log.h>
#include <hal/nrf_gpio.h>

LOG_MODULE_REGISTER(power_test, LOG_LEVEL_INF);

int main(void)
{
    LOG_INF("Entering Deep Sleep Test...");

    /* Force the SPI peripheral to suspend immediately */
    const struct device *spi_dev = DEVICE_DT_GET(DT_NODELABEL(spi0));
    if (device_is_ready(spi_dev)) {
        pm_device_action_run(spi_dev, PM_DEVICE_ACTION_SUSPEND);
    }

    /* Configure SPI pins to default state */
    nrf_gpio_cfg_default(47); // P1.15 (SCK)
    nrf_gpio_cfg_default(46); // P1.14 (MOSI)
    nrf_gpio_cfg_default(45); // P1.13 (MISO)
    nrf_gpio_cfg_default(44); // P1.12 (CS)

    LOG_INF("Sleeping forever.");
    
    while(1) {
        k_sleep(K_FOREVER);
    }
    return 0;
}
