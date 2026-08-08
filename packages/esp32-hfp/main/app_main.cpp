#include <cstdint>

#include "esp_log.h"
#include "esp_system.h"
#include "nvs_flash.h"

namespace {
constexpr char tag[] = "zero-path";
}

extern "C" void app_main() {
  const esp_err_t nvs_result = nvs_flash_init();
  if (nvs_result == ESP_ERR_NVS_NO_FREE_PAGES || nvs_result == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    ESP_ERROR_CHECK(nvs_flash_init());
  } else {
    ESP_ERROR_CHECK(nvs_result);
  }

  ESP_LOGI(tag, "ESP32 HFP bridge skeleton, C++26, chip revision=%u", esp_get_chip_revision());
}
