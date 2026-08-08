#pragma once

#include <asio/error_code.hpp>
#include <asio/io_context.hpp>
#include <asio/serial_port.hpp>
#include <cstdint>
#include <memory>
#include <string>

namespace zero_path::serial_bridge {

struct SerialSettings {
  std::string device;
  std::uint32_t baud_rate = 921600;
};

class SerialBridge final {
public:
  explicit SerialBridge(SerialSettings settings);
  ~SerialBridge();

  SerialBridge(const SerialBridge&) = delete;
  SerialBridge& operator=(const SerialBridge&) = delete;

  void open();
  asio::error_code close() noexcept;
  [[nodiscard]] bool is_open() const noexcept;

private:
  asio::io_context io_context_;
  asio::serial_port serial_port_;
  SerialSettings settings_;
};

} // namespace zero_path::serial_bridge
