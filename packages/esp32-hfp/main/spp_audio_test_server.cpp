#include "spp_audio_test_server.hpp"

#include "esp_bt.h"
#include "esp_bt_device.h"
#include "esp_bt_main.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "zero_path/audio_protocol/frame_codec.hpp"

#include <algorithm>
#include <array>
#include <cinttypes>
#include <cmath>
#include <cstring>
#include <span>

namespace zero_path::esp32_hfp {
namespace {

constexpr char tag[] = "zero-path-spp";
constexpr char device_name[] = "Zero Path Audio Test";
constexpr char service_name[] = "ZERO_PATH_AUDIO";
constexpr auto sample_rate = 8'000U;
constexpr auto samples_per_frame = 160UZ;
constexpr auto tone_frequency = 440U;
constexpr auto tone_amplitude = 12'000.0F;
constexpr auto pcm_frame_bytes = samples_per_frame * sizeof(std::int16_t);

} // namespace

SppAudioTestServer* SppAudioTestServer::instance_ = nullptr;

void SppAudioTestServer::start() { // NOLINT(readability-function-cognitive-complexity)
  instance_ = this;
  receive_queue_ = xQueueCreate(8, sizeof(RxChunk));
  ESP_ERROR_CHECK(receive_queue_ == nullptr ? ESP_ERR_NO_MEM : ESP_OK);

  ESP_ERROR_CHECK(esp_bt_controller_mem_release(ESP_BT_MODE_BLE));
  esp_bt_controller_config_t controller_config = BT_CONTROLLER_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_bt_controller_init(&controller_config));
  ESP_ERROR_CHECK(esp_bt_controller_enable(ESP_BT_MODE_CLASSIC_BT));

  esp_bluedroid_config_t bluedroid_config = BT_BLUEDROID_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_bluedroid_init_with_cfg(&bluedroid_config));
  ESP_ERROR_CHECK(esp_bluedroid_enable());
  ESP_ERROR_CHECK(esp_bt_gap_register_callback(gapCallback));
  ESP_ERROR_CHECK(esp_spp_register_callback(sppCallback));

  const auto spp_config = esp_spp_cfg_t{
      .mode = ESP_SPP_MODE_CB,
      .enable_l2cap_ertm = true,
      .tx_buffer_size = 0,
  };
  ESP_ERROR_CHECK(esp_spp_enhanced_init(&spp_config));

  const auto pin_type = ESP_BT_PIN_TYPE_FIXED;
  esp_bt_pin_code_t pin_code{'1', '2', '3', '4'};
  ESP_ERROR_CHECK(esp_bt_gap_set_pin(pin_type, 4, pin_code));
  ESP_ERROR_CHECK(xTaskCreate(workerEntry, "spp_audio", 6'144, this, 5, &worker_task_) == pdPASS
                      ? ESP_OK
                      : ESP_ERR_NO_MEM);
}

void SppAudioTestServer::gapCallback(esp_bt_gap_cb_event_t event,
                                     esp_bt_gap_cb_param_t* parameter) {
  if (event == ESP_BT_GAP_PIN_REQ_EVT) {
    esp_bt_pin_code_t pin_code{'1', '2', '3', '4'};
    esp_bt_gap_pin_reply(parameter->pin_req.bda, true, 4, pin_code);
  }
}

void SppAudioTestServer::sppCallback(esp_spp_cb_event_t event, esp_spp_cb_param_t* parameter) {
  if (instance_ != nullptr) {
    instance_->handleSppEvent(event, parameter);
  }
}

void SppAudioTestServer::workerEntry(void* context) {
  static_cast<SppAudioTestServer*>(context)->workerLoop();
}

void SppAudioTestServer::handleSppEvent( // NOLINT(readability-function-cognitive-complexity)
    esp_spp_cb_event_t event, esp_spp_cb_param_t* parameter) {
  switch (event) {
  case ESP_SPP_INIT_EVT:
    if (parameter->init.status == ESP_SPP_SUCCESS) {
      ESP_ERROR_CHECK(
          esp_spp_start_srv(ESP_SPP_SEC_AUTHENTICATE, ESP_SPP_ROLE_SLAVE, 0, service_name));
    }
    break;
  case ESP_SPP_START_EVT:
    if (parameter->start.status == ESP_SPP_SUCCESS) {
      ESP_ERROR_CHECK(esp_bt_gap_set_device_name(device_name));
      ESP_ERROR_CHECK(esp_bt_gap_set_scan_mode(ESP_BT_CONNECTABLE, ESP_BT_GENERAL_DISCOVERABLE));
      ESP_LOGI(tag, "SPP audio test service ready");
    }
    break;
  case ESP_SPP_SRV_OPEN_EVT:
    if (parameter->srv_open.status != ESP_SPP_SUCCESS) {
      break;
    }
    if (connected_.load()) {
      ESP_LOGW(tag, "Rejecting extra SPP connection handle=%" PRIu32,
               parameter->srv_open.handle);
      esp_spp_disconnect(parameter->srv_open.handle);
      break;
    }
    connection_handle_.store(parameter->srv_open.handle);
    connection_generation_.fetch_add(1);
    connected_.store(true);
    congested_.store(false);
    resetTransmit();
    download_enabled_.store(false);
    loopback_enabled_.store(false);
    esp_bt_gap_set_scan_mode(ESP_BT_CONNECTABLE, ESP_BT_NON_DISCOVERABLE);
    ESP_LOGI(tag, "Android audio test device connected, handle=%" PRIu32,
             parameter->srv_open.handle);
    wakeWorker();
    break;
  case ESP_SPP_CLOSE_EVT:
    if (parameter->close.handle != connection_handle_.load()) {
      break;
    }
    connected_.store(false);
    connection_handle_.store(0);
    connection_generation_.fetch_add(1);
    download_enabled_.store(false);
    loopback_enabled_.store(false);
    congested_.store(false);
    resetTransmit();
    esp_bt_gap_set_scan_mode(ESP_BT_CONNECTABLE, ESP_BT_GENERAL_DISCOVERABLE);
    ESP_LOGI(tag, "Android audio test device disconnected");
    wakeWorker();
    break;
  case ESP_SPP_DATA_IND_EVT:
    if (parameter->data_ind.status == ESP_SPP_SUCCESS && connected_.load() &&
        parameter->data_ind.handle == connection_handle_.load()) {
      enqueueReceived(connection_generation_.load(), parameter->data_ind.data,
                      parameter->data_ind.len);
    }
    break;
  case ESP_SPP_WRITE_EVT: {
    if (parameter->write.handle != connection_handle_.load()) {
      break;
    }
    if (!write_pending_.load()) {
      wakeWorker();
      break;
    }
    congested_.store(parameter->write.cong);
    write_in_flight_.store(false);
    const auto offset = transmit_offset_.load();
    const auto total = transmit_size_.load();
    const auto written = parameter->write.len > 0
                             ? static_cast<std::size_t>(parameter->write.len)
                             : 0UZ;
    if (parameter->write.status != ESP_SPP_SUCCESS || written == 0 || offset > total ||
        written > total - offset) {
      resetTransmit();
      ++dropped_frames_;
      wakeWorker();
      break;
    }
    transmit_offset_.store(offset + written);
    if (offset + written == total) {
      resetTransmit();
    } else if (!parameter->write.cong && !continueWrite(parameter->write.handle)) {
      resetTransmit();
      ++dropped_frames_;
    }
    wakeWorker();
    break;
  }
  case ESP_SPP_CONG_EVT:
    if (parameter->cong.handle == connection_handle_.load() &&
        parameter->cong.status == ESP_SPP_SUCCESS) {
      congested_.store(parameter->cong.cong);
      if (!parameter->cong.cong && write_pending_.load() &&
          !continueWrite(parameter->cong.handle)) {
        resetTransmit();
        ++dropped_frames_;
      }
      wakeWorker();
    }
    break;
  default:
    break;
  }
}

void SppAudioTestServer::enqueueReceived(std::uint32_t generation, const std::uint8_t* data,
                                         std::size_t size) {
  while (size > 0) {
    auto chunk = RxChunk{};
    chunk.generation = generation;
    const auto count = std::min(size, chunk.data.size());
    chunk.size = static_cast<std::uint16_t>(count);
    std::memcpy(chunk.data.data(), data, count);
    if (xQueueSend(receive_queue_, &chunk, 0) != pdPASS) {
      ++dropped_frames_;
    }
    data += count;
    size -= count;
  }
  wakeWorker();
}

void SppAudioTestServer::wakeWorker() {
  if (worker_task_ != nullptr) {
    xTaskNotifyGive(worker_task_);
  }
}

void SppAudioTestServer::workerLoop() {
  auto chunk = RxChunk{};
  auto last_tone_tick = xTaskGetTickCount();
  auto tone_active = false;
  const auto tone_interval = std::max<TickType_t>(1, pdMS_TO_TICKS(20));
  while (true) {
    while (xQueueReceive(receive_queue_, &chunk, 0) == pdPASS) {
      consume(chunk);
    }

    const auto now = xTaskGetTickCount();
    const auto tone_enabled = connected_.load() && download_enabled_.load();
    auto wait = portMAX_DELAY;
    if (!tone_enabled) {
      tone_active = false;
    } else if (!tone_active) {
      tone_active = true;
      last_tone_tick = now;
      wait = tone_interval;
    } else {
      auto elapsed = now - last_tone_tick;
      if (elapsed >= tone_interval && !write_pending_.load() && !congested_.load()) {
        if (sendDownloadTone()) {
          last_tone_tick += tone_interval;
          elapsed = xTaskGetTickCount() - last_tone_tick;
        } else {
          wait = 1;
        }
      }
      if (wait != 1 && elapsed < tone_interval) {
        wait = tone_interval - elapsed;
      }
    }
    ulTaskNotifyTake(pdTRUE, wait);
  }
}

void SppAudioTestServer::consume(const RxChunk& chunk) {
  if (chunk.generation != connection_generation_.load()) {
    return;
  }
  if (worker_generation_ != chunk.generation) {
    worker_generation_ = chunk.generation;
    frame_size_ = 0;
    discarding_frame_ = false;
  }
  for (auto index = 0UZ; index < chunk.size; ++index) {
    const auto byte = chunk.data[index];
    if (discarding_frame_) {
      if (byte == std::byte{0}) {
        discarding_frame_ = false;
      }
      continue;
    }
    if (byte == std::byte{0}) {
      if (frame_size_ > 0) {
        processFrame(frame_size_);
      }
      frame_size_ = 0;
      continue;
    }
    if (frame_size_ >= frame_buffer_.size()) {
      frame_size_ = 0;
      discarding_frame_ = true;
      ++dropped_frames_;
      continue;
    }
    frame_buffer_[frame_size_++] = byte;
  }
}

void SppAudioTestServer::processFrame(std::size_t size) {
  using namespace zero_path::audio_protocol;
  const auto result = decode_frame(std::span<std::byte>(frame_buffer_.data(), size));
  if (!result) {
    ++dropped_frames_;
    return;
  }

  if (result.frame.type == MessageType::audio_uplink) {
    if (result.frame.payload.size() != pcm_frame_bytes) {
      ++dropped_frames_;
      return;
    }
    ++upload_frames_;
    if (loopback_enabled_.load() &&
        !sendFrame(static_cast<std::uint8_t>(MessageType::audio_downlink),
                   result.frame.payload.data(), result.frame.payload.size())) {
      ++dropped_frames_;
    }
    return;
  }

  if (result.frame.type != MessageType::test_command) {
    return;
  }
  if (result.frame.payload.size() != 1) {
    ++dropped_frames_;
    return;
  }
  switch (static_cast<TestCommand>(std::to_integer<std::uint8_t>(result.frame.payload[0]))) {
  case TestCommand::start_download_tone:
    loopback_enabled_.store(false);
    download_enabled_.store(true);
    break;
  case TestCommand::stop_download_tone:
    download_enabled_.store(false);
    break;
  case TestCommand::enable_loopback:
    download_enabled_.store(false);
    loopback_enabled_.store(true);
    break;
  case TestCommand::disable_loopback:
    loopback_enabled_.store(false);
    break;
  default:
    ++dropped_frames_;
    break;
  }
}

bool SppAudioTestServer::sendDownloadTone() {
  auto payload = std::array<std::byte, pcm_frame_bytes>{};
  auto next_tone_phase = tone_phase_;
  for (auto sample = 0UZ; sample < samples_per_frame; ++sample) {
    const auto angle = 2.0F * static_cast<float>(M_PI) * static_cast<float>(next_tone_phase) /
                       static_cast<float>(sample_rate);
    const auto value = static_cast<std::int16_t>(std::sin(angle) * tone_amplitude);
    payload[sample * 2] = static_cast<std::byte>(value & 0xff);
    payload[(sample * 2) + 1] =
        static_cast<std::byte>((static_cast<std::uint16_t>(value) >> 8) & 0xff);
    next_tone_phase = (next_tone_phase + tone_frequency) % sample_rate;
  }
  if (!sendFrame(static_cast<std::uint8_t>(audio_protocol::MessageType::audio_downlink),
                  payload.data(), payload.size())) {
    return false;
  }
  tone_phase_ = next_tone_phase;
  ++download_frames_;
  return true;
}

bool SppAudioTestServer::sendFrame(std::uint8_t type, const std::byte* payload,
                                   std::size_t payload_size) {
  using namespace zero_path::audio_protocol;
  const auto generation = connection_generation_.load();
  const auto handle = connection_handle_.load();
  if (!connected_.load() || handle == 0 || congested_.load() || write_pending_.load()) {
    return false;
  }
  if (generation != connection_generation_.load() || handle != connection_handle_.load()) {
    return false;
  }
  const auto result =
      encode_frame({.type = static_cast<MessageType>(type),
                    .sequence = sequence_++,
                    .timestamp_us = static_cast<std::uint64_t>(esp_timer_get_time()),
                    .payload = std::span<const std::byte>(payload, payload_size)},
                   transmit_buffer_);
  if (!result) {
    resetTransmit();
    return false;
  }
  transmit_generation_.store(generation);
  transmit_offset_.store(0);
  transmit_size_.store(result.bytes_written);
  write_in_flight_.store(false);
  write_pending_.store(true);
  if (generation != connection_generation_.load() || handle != connection_handle_.load()) {
    resetTransmit();
    return false;
  }
  if (!continueWrite(handle)) {
    resetTransmit();
    return false;
  }
  return true;
}

bool SppAudioTestServer::continueWrite(std::uint32_t handle) {
  if (!write_pending_.load() || !connected_.load() || handle != connection_handle_.load() ||
      transmit_generation_.load() != connection_generation_.load()) {
    return false;
  }
  const auto offset = transmit_offset_.load();
  const auto total = transmit_size_.load();
  if (offset >= total) {
    return false;
  }
  if (congested_.load()) {
    return true;
  }
  auto expected = false;
  if (!write_in_flight_.compare_exchange_strong(expected, true)) {
    return true;
  }
  const auto result = esp_spp_write(
      handle, static_cast<int>(total - offset),
      reinterpret_cast<std::uint8_t*>(transmit_buffer_.data() + offset));
  if (result != ESP_OK) {
    write_in_flight_.store(false);
    return false;
  }
  return true;
}

void SppAudioTestServer::resetTransmit() {
  transmit_size_.store(0);
  transmit_offset_.store(0);
  transmit_generation_.store(0);
  write_in_flight_.store(false);
  write_pending_.store(false);
}

} // namespace zero_path::esp32_hfp
