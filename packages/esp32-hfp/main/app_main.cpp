#include "esp_chip_info.h"
#include "esp_log.h"
#include "esp_system.h"
#include "nvs_flash.h"
#include "spp_audio_test_server.hpp"

#include <cstdint>

namespace {
constexpr char tag[] = "zero-path";
zero_path::esp32_hfp::SppAudioTestServer audio_test_server;
} // namespace

extern "C" void app_main() { // NOLINT(readability-function-cognitive-complexity,readability-identifier-naming)
  const esp_err_t nvs_result = nvs_flash_init();
  if (nvs_result == ESP_ERR_NVS_NO_FREE_PAGES || nvs_result == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    ESP_ERROR_CHECK(nvs_flash_init());
  } else {
    ESP_ERROR_CHECK(nvs_result);
  }

  esp_chip_info_t chip_info{};
  esp_chip_info(&chip_info);
  ESP_LOGI(tag, "ESP32 audio test bridge, C++26, chip revision=%u", chip_info.revision);
  audio_test_server.start();
}
