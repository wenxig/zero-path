find_package(asio CONFIG REQUIRED)
find_package(CLI11 CONFIG REQUIRED)
find_package(fmt CONFIG REQUIRED)

add_executable(zero_path_serial_bridge
  src/main.cpp
  src/serial_bridge.cpp
)

target_include_directories(zero_path_serial_bridge PRIVATE include)
target_link_libraries(zero_path_serial_bridge PRIVATE
  zero_path::audio_protocol
  zero_path_project_options
  asio::asio
  CLI11::CLI11
  fmt::fmt
)

if(APPLE)
  target_link_libraries(zero_path_serial_bridge PRIVATE "-framework CoreFoundation")
endif()

install(TARGETS zero_path_serial_bridge RUNTIME DESTINATION bin)
