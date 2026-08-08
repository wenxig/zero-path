#include "zero_path/serial_bridge/serial_bridge.hpp"

#include <asio/error_code.hpp>

namespace zero_path::serial_bridge {

SerialBridge::SerialBridge(SerialSettings settings)
    : serial_port_(io_context_), settings_(std::move(settings)) {}

SerialBridge::~SerialBridge() { [[maybe_unused]] const auto close_error = close(); }

void SerialBridge::open() {
  serial_port_.open(settings_.device);
  const auto set_option = [this](auto option) { serial_port_.set_option(option); };
  set_option(asio::serial_port_base::baud_rate(settings_.baud_rate));
  set_option(asio::serial_port_base::character_size(8));
  set_option(asio::serial_port_base::parity(asio::serial_port_base::parity::none));
  set_option(asio::serial_port_base::stop_bits(asio::serial_port_base::stop_bits::one));
  set_option(asio::serial_port_base::flow_control(asio::serial_port_base::flow_control::none));
}

asio::error_code SerialBridge::close() noexcept {
  if (!serial_port_.is_open())
    return {};
  auto error = asio::error_code{};
  return serial_port_.close(error);
}

bool SerialBridge::is_open() const noexcept { return serial_port_.is_open(); }

} // namespace zero_path::serial_bridge
