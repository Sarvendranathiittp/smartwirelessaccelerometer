cmake_minimum_required(VERSION 3.20.0)
find_package(Zephyr REQUIRED)
project(phase2_accel_gatt)

target_sources(app PRIVATE
    src/main.c
    src/accel_service.c
)
