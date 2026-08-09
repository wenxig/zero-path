#pragma once

#include <cstddef>
#include <cstdint>
#include <span>

namespace zero_path::audio_protocol {

inline constexpr std::uint8_t protocol_version = 1;
inline constexpr std::size_t max_payload_size = 512;

enum class MessageType : std::uint8_t {
  hello = 1,
  heartbeat = 2,
  pairing_state = 3,
  call_state = 4,
  sco_state = 5,
  audio_downlink = 6,
  audio_uplink = 7,
  audio_stats = 8,
  error = 9,
  test_command = 10,
};

enum class TestCommand : std::uint8_t {
  start_download_tone = 1,
  stop_download_tone = 2,
  enable_loopback = 3,
  disable_loopback = 4,
};

enum class CodecError : std::uint8_t {
  none = 0,
  output_too_small,
  malformed_cobs,
  malformed_frame,
  invalid_version,
  invalid_length,
  invalid_crc,
};

struct FrameView {
  MessageType type = MessageType::hello;
  std::uint32_t sequence = 0;
  std::uint64_t timestamp_us = 0;
  std::span<const std::byte> payload{};
};

struct EncodeResult {
  CodecError error;
  std::size_t bytes_written;

  explicit operator bool() const { return error == CodecError::none; }
};

struct DecodeResult {
  CodecError error;
  FrameView frame;

  explicit operator bool() const { return error == CodecError::none; }
};

[[nodiscard]] EncodeResult encode_frame(FrameView frame, std::span<std::byte> output);

// Decoding happens in place. The returned payload aliases encoded and is valid only while the
// input storage remains alive and unchanged. The delimiter byte, when present, is ignored.
[[nodiscard]] DecodeResult decode_frame(std::span<std::byte> encoded);

[[nodiscard]] const char* to_string(CodecError error);

} // namespace zero_path::audio_protocol
