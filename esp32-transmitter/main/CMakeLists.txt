idf_component_register(
    SRCS "main.c"
    INCLUDE_DIRS "."
    REQUIRES bt nvs_flash driver esp_timer
)
component_compile_options(-Wno-unused-variable -Wno-unused-function)
