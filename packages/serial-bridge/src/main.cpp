#include "zero_path/serial_bridge/serial_bridge.hpp"

#include <CLI/CLI.hpp>
#include <cstdlib>
#include <exception>
#include <fmt/format.h>
#include <iostream>

int main(int argc, char** argv) {
  CLI::App app{"Zero Path ESP32 HFP serial bridge"};
  std::string device;
  auto baud_rate = std::uint32_t{921600};
  auto probe_only = false;

  app.add_option("--device", device, "macOS serial device");
  app.add_option("--baud", baud_rate, "UART baud rate")->check(CLI::Range(115200u, 2000000u));
  app.add_flag("--probe", probe_only, "validate configuration without opening a serial device");

  try {
    CLI11_PARSE(app, argc, argv);
    if (probe_only) {
      std::cout << fmt::format("C++26 serial bridge configured for {} baud\n", baud_rate);
      return EXIT_SUCCESS;
    }
    if (device.empty()) {
      std::cerr << "--device is required unless --probe is used\n";
      return EXIT_FAILURE;
    }

    auto bridge = zero_path::serial_bridge::SerialBridge({device, baud_rate});
    bridge.open();
    std::cout << fmt::format("opened {} at {} baud\n", device, baud_rate);
    return EXIT_SUCCESS;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  }
}
