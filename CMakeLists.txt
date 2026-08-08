cmake_minimum_required(VERSION 3.28)

project(zero_path_native LANGUAGES CXX)

include(CTest)

option(ZERO_PATH_ENABLE_SANITIZERS "Enable AddressSanitizer and UndefinedBehaviorSanitizer" OFF)
option(ZERO_PATH_WARNINGS_AS_ERRORS "Treat compiler warnings as errors" ON)

add_library(zero_path_project_options INTERFACE)
target_compile_features(zero_path_project_options INTERFACE cxx_std_26)

if(NOT CMAKE_CXX_COMPILER_ID STREQUAL "Clang")
  message(FATAL_ERROR "zero-path native C++ requires Clang; found ${CMAKE_CXX_COMPILER_ID}")
endif()

target_compile_options(zero_path_project_options INTERFACE
  -Wall
  -Wextra
  -Wpedantic
  -Wconversion
  -Wsign-conversion
  -Wshadow
  -Wnon-virtual-dtor
  -Wold-style-cast
  -Wcast-align
  -Wunused
  -Woverloaded-virtual
  -Wnull-dereference
  -Wdouble-promotion
  -Wformat=2
  -Wimplicit-fallthrough
)

if(ZERO_PATH_WARNINGS_AS_ERRORS)
  target_compile_options(zero_path_project_options INTERFACE -Werror)
endif()

if(ZERO_PATH_ENABLE_SANITIZERS AND CMAKE_SYSTEM_NAME STREQUAL "Darwin")
  target_compile_options(zero_path_project_options INTERFACE -fsanitize=address,undefined -fno-omit-frame-pointer)
  target_link_options(zero_path_project_options INTERFACE -fsanitize=address,undefined)
endif()

add_subdirectory(packages/audio-protocol)
add_subdirectory(packages/serial-bridge)
