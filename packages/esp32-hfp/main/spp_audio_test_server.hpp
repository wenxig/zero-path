#pragma once

#include "esp_gap_bt_api.h"
#include "esp_spp_api.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>

namespace zero_path::esp32_hfp {

class SppAudioTestServer final {
public:
  void start();

private:
  static constexpr auto chunk_size = 512UZ;
  static constexpr auto frame_buffer_size = 600UZ;

  struct RxChunk {
    std::uint32_t generation = 0;
    std::uint16_t size = 0;
    std::array<std::byte, chunk_size> data{};
  };

  static void gapCallback(esp_bt_gap_cb_event_t event, esp_bt_gap_cb_param_t* parameter);
  static void sppCallback(esp_spp_cb_event_t event, esp_spp_cb_param_t* parameter);
  static void workerEntry(void* context);

  void handleSppEvent(esp_spp_cb_event_t event, esp_spp_cb_param_t* parameter);
  void enqueueReceived(std::uint32_t generation, const std::uint8_t* data, std::size_t size);
  void workerLoop();
  void consume(const RxChunk& chunk);
  void processFrame(std::size_t size);
  void sendDownloadTone();
  bool sendFrame(std::uint8_t type, const std::byte* payload, std::size_t payload_size);
  bool continueWrite(std::uint32_t handle);
  void resetTransmit();

  static SppAudioTestServer* instance_;

  QueueHandle_t receive_queue_ = nullptr;
  TaskHandle_t worker_task_ = nullptr;
  std::array<std::byte, frame_buffer_size> frame_buffer_{};
  std::array<std::byte, frame_buffer_size> transmit_buffer_{};
  std::size_t frame_size_ = 0;
  std::uint32_t worker_generation_ = 0;
  bool discarding_frame_ = false;
  std::uint32_t sequence_ = 0;
  std::uint32_t upload_frames_ = 0;
  std::uint32_t download_frames_ = 0;
  std::atomic_uint32_t dropped_frames_ = 0;
  std::uint32_t tone_phase_ = 0;
  std::atomic_uint32_t connection_handle_ = 0;
  std::atomic_uint32_t connection_generation_ = 0;
  std::atomic_uint32_t transmit_generation_ = 0;
  std::atomic_size_t transmit_offset_ = 0;
  std::atomic_size_t transmit_size_ = 0;
  std::atomic_bool connected_ = false;
  std::atomic_bool congested_ = false;
  std::atomic_bool write_pending_ = false;
  std::atomic_bool write_in_flight_ = false;
  std::atomic_bool download_enabled_ = false;
  std::atomic_bool loopback_enabled_ = false;
};

} // namespace zero_path::esp32_hfp
