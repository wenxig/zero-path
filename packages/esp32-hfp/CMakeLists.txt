cmake_minimum_required(VERSION 3.28)

set(IDF_TARGET esp32 CACHE STRING "ESP-IDF target")
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../audio-protocol")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
idf_build_set_property(MINIMAL_BUILD ON)
project(zero_path_esp32_hfp)
