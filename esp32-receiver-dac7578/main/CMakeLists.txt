idf_component_register(
    SRCS "main.c" "gatt_client.c" "dac7578.c" "playback.c"
    INCLUDE_DIRS "."
    REQUIRES bt nvs_flash driver esp_timer
)
