#include "zero_path/audio_protocol/frame_codec.hpp"

#include <algorithm>
#include <array>
#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wc2y-extensions"
#endif
#include <catch2/catch_test_macros.hpp>
#include <cstddef>
#include <limits>
#include <string_view>

using namespace zero_path::audio_protocol;

TEST_CASE("frames round trip through COBS and CRC", "[frame_codec]") {
  constexpr std::string_view text = "hello hfp";
  std::array<std::byte, 640> encoded{};
  const FrameView original{.type = MessageType::audio_downlink,
                           .sequence = 42,
                           .timestamp_us = 123456,
                           .payload = std::as_bytes(std::span{text})};

  const auto encode = encode_frame(original, encoded);
  REQUIRE(encode);

  const auto decode = decode_frame(std::span{encoded}.first(encode.bytes_written));
  REQUIRE(decode);
  CHECK(decode.frame.type == original.type);
  CHECK(decode.frame.sequence == original.sequence);
  CHECK(decode.frame.timestamp_us == original.timestamp_us);
  CHECK(std::string_view(reinterpret_cast<const char*>(decode.frame.payload.data()),
                         decode.frame.payload.size()) == text);
}

TEST_CASE("zero bytes in payload survive COBS round trip", "[frame_codec]") {
  constexpr std::array<std::byte, 8> payload{std::byte{0}, std::byte{1}, std::byte{0},
                                             std::byte{2}, std::byte{0}, std::byte{0},
                                             std::byte{3}, std::byte{0}};
  std::array<std::byte, 640> encoded{};
  const FrameView original{
      .type = MessageType::audio_uplink, .sequence = 7, .timestamp_us = 99, .payload = payload};

  const auto encode = encode_frame(original, encoded);
  REQUIRE(encode);
  const auto decode = decode_frame(std::span{encoded}.first(encode.bytes_written));
  REQUIRE(decode);
  REQUIRE(decode.frame.payload.size() == payload.size());
  CHECK(std::ranges::equal(decode.frame.payload, payload));
}

TEST_CASE("empty payload round trips without backing storage", "[frame_codec]") {
  std::array<std::byte, 64> encoded{};
  const FrameView original{
      .type = MessageType::heartbeat, .sequence = 1, .timestamp_us = 2, .payload = {}};

  const auto encode = encode_frame(original, encoded);
  REQUIRE(encode);

  const auto decode = decode_frame(std::span{encoded}.first(encode.bytes_written));
  REQUIRE(decode);
  CHECK(decode.frame.payload.empty());
}

TEST_CASE("encoding stays inside the supplied output span", "[frame_codec][memory]") {
  constexpr auto guard = std::byte{0xa5};
  std::array<std::byte, max_payload_size> payload{};
  std::ranges::fill(payload, std::byte{0x7f});
  const FrameView frame{.type = MessageType::audio_downlink,
                        .sequence = std::numeric_limits<std::uint32_t>::max(),
                        .timestamp_us = std::numeric_limits<std::uint64_t>::max(),
                        .payload = payload};
  std::array<std::byte, 640> storage{};

  for (auto output_size = 0uz; output_size <= storage.size(); ++output_size) {
    std::ranges::fill(storage, guard);
    [[maybe_unused]] const auto result = encode_frame(frame, std::span{storage}.first(output_size));
    CHECK(std::ranges::all_of(std::span{storage}.subspan(output_size),
                              [guard](const auto byte) { return byte == guard; }));
  }
}

TEST_CASE("malformed COBS blocks stay inside the supplied input span", "[frame_codec][memory]") {
  constexpr auto guard = std::byte{0xa5};
  auto guards_intact = true;

  for (auto code = 0U; code <= std::numeric_limits<std::uint8_t>::max(); ++code) {
    auto storage = std::array{guard, static_cast<std::byte>(code), guard};
    [[maybe_unused]] const auto result = decode_frame(std::span{storage}.subspan(1, 1));
    guards_intact = guards_intact && storage.front() == guard && storage.back() == guard;
  }

  CHECK(guards_intact);
}

TEST_CASE("CRC errors are rejected", "[frame_codec]") {
  std::array<std::byte, 640> encoded{};
  const FrameView original{
      .type = MessageType::heartbeat, .sequence = 1, .timestamp_us = 2, .payload = {}};
  const auto encode = encode_frame(original, encoded);
  REQUIRE(encode);
  encoded[2] ^= std::byte{1};

  CHECK(decode_frame(std::span{encoded}.first(encode.bytes_written)).error ==
        CodecError::invalid_crc);
}

#if defined(__clang__)
#pragma clang diagnostic pop
#endif
