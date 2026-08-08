#include "zero_path/audio_protocol/frame_codec.hpp"

#include <algorithm>
#include <array>
#include <cstring>

namespace zero_path::audio_protocol {
namespace {

constexpr auto raw_header_size =
    1 + 1 + sizeof(std::uint32_t) + sizeof(std::uint64_t) + sizeof(std::uint16_t);
constexpr auto raw_crc_size = sizeof(std::uint32_t);

void write_u16(std::byte* destination, std::uint16_t value) {
  destination[0] = static_cast<std::byte>(value & 0xffU);
  destination[1] = static_cast<std::byte>((value >> 8U) & 0xffU);
}

void write_u32(std::byte* destination, std::uint32_t value) {
  for (auto index = 0uz; index < sizeof(value); ++index) {
    destination[index] = static_cast<std::byte>((value >> (index * 8U)) & 0xffU);
  }
}

void write_u64(std::byte* destination, std::uint64_t value) {
  for (auto index = 0uz; index < sizeof(value); ++index) {
    destination[index] = static_cast<std::byte>((value >> (index * 8U)) & 0xffU);
  }
}

[[nodiscard]] std::uint16_t read_u16(const std::byte* source) {
  return static_cast<std::uint16_t>(std::to_integer<std::uint8_t>(source[0])) |
         static_cast<std::uint16_t>(std::to_integer<std::uint8_t>(source[1]) << 8U);
}

[[nodiscard]] std::uint32_t read_u32(const std::byte* source) {
  auto value = std::uint32_t{0};
  for (auto index = 0uz; index < sizeof(value); ++index) {
    value |= static_cast<std::uint32_t>(std::to_integer<std::uint8_t>(source[index]))
             << (index * 8U);
  }
  return value;
}

[[nodiscard]] std::uint64_t read_u64(const std::byte* source) {
  auto value = std::uint64_t{0};
  for (auto index = 0uz; index < sizeof(value); ++index) {
    value |= static_cast<std::uint64_t>(std::to_integer<std::uint8_t>(source[index]))
             << (index * 8U);
  }
  return value;
}

[[nodiscard]] std::uint32_t crc32(std::span<const std::byte> bytes) {
  auto crc = std::uint32_t{0xffffffffU};
  for (const auto byte : bytes) {
    crc ^= std::to_integer<std::uint8_t>(byte);
    for (auto bit = 0; bit < 8; ++bit) {
      crc = (crc & 1U) != 0U ? (crc >> 1U) ^ 0xedb88320U : crc >> 1U;
    }
  }
  return ~crc;
}

[[nodiscard]] CodecError cobs_encode(std::span<const std::byte> input, std::span<std::byte> output,
                                     std::size_t& written) {
  if (output.empty())
    return CodecError::output_too_small;

  auto read = 0uz;
  auto write = 1uz;
  auto code = 0uz;
  auto code_index = 0uz;

  while (read < input.size()) {
    if (input[read] == std::byte{0}) {
      if (code_index >= output.size())
        return CodecError::output_too_small;
      output[code_index] = static_cast<std::byte>(code + 1U);
      code = 0;
      code_index = write++;
      if (code_index >= output.size() && read + 1 < input.size())
        return CodecError::output_too_small;
      ++read;
      continue;
    }

    if (write >= output.size())
      return CodecError::output_too_small;
    output[write++] = input[read++];
    ++code;
    if (code == 0xfeU) {
      output[code_index] = static_cast<std::byte>(code + 1U);
      code = 0;
      code_index = write++;
      if (code_index >= output.size() && read < input.size())
        return CodecError::output_too_small;
    }
  }

  if (code_index >= output.size())
    return CodecError::output_too_small;
  output[code_index] = static_cast<std::byte>(code + 1U);
  written = write;
  return CodecError::none;
}

[[nodiscard]] CodecError cobs_decode(std::span<std::byte> buffer, std::size_t& decoded_size) {
  if (buffer.empty())
    return CodecError::malformed_cobs;

  auto read = 0uz;
  auto write = 0uz;
  while (read < buffer.size()) {
    const auto code = std::to_integer<std::uint8_t>(buffer[read++]);
    if (code == 0U || read + code - 1U > buffer.size())
      return CodecError::malformed_cobs;

    for (auto index = 1uz; index < code; ++index) {
      buffer[write++] = buffer[read++];
    }
    if (code != 0xffU && read < buffer.size())
      buffer[write++] = std::byte{0};
  }
  decoded_size = write;
  return CodecError::none;
}

} // namespace

EncodeResult encode_frame(FrameView frame, std::span<std::byte> output) {
  if (frame.payload.size() > max_payload_size)
    return {.error = CodecError::invalid_length, .bytes_written = 0};

  auto raw = std::array<std::byte, raw_header_size + max_payload_size + raw_crc_size>{};
  raw[0] = static_cast<std::byte>(protocol_version);
  raw[1] = static_cast<std::byte>(frame.type);
  write_u32(raw.data() + 2, frame.sequence);
  write_u64(raw.data() + 6, frame.timestamp_us);
  write_u16(raw.data() + 14, static_cast<std::uint16_t>(frame.payload.size()));
  std::memcpy(raw.data() + raw_header_size, frame.payload.data(), frame.payload.size());
  const auto raw_size = raw_header_size + frame.payload.size();
  write_u32(raw.data() + raw_size, crc32(std::span<const std::byte>(raw.data(), raw_size)));

  auto encoded_size = 0uz;
  const auto error = cobs_encode(std::span<const std::byte>(raw.data(), raw_size + raw_crc_size),
                                 output, encoded_size);
  if (error != CodecError::none)
    return {.error = error, .bytes_written = 0};
  if (encoded_size >= output.size())
    return {.error = CodecError::output_too_small, .bytes_written = 0};
  output[encoded_size] = std::byte{0};
  return {.error = CodecError::none, .bytes_written = encoded_size + 1};
}

DecodeResult decode_frame(std::span<std::byte> encoded) {
  const auto failure = [](const CodecError error) {
    return DecodeResult{.error = error, .frame = {}};
  };

  if (!encoded.empty() && encoded.back() == std::byte{0})
    encoded = encoded.first(encoded.size() - 1);

  auto decoded_size = 0uz;
  const auto cobs_error = cobs_decode(encoded, decoded_size);
  if (cobs_error != CodecError::none)
    return failure(cobs_error);
  if (decoded_size < raw_header_size + raw_crc_size)
    return failure(CodecError::malformed_frame);

  const auto decoded = std::span<const std::byte>(encoded.data(), decoded_size);
  if (std::to_integer<std::uint8_t>(decoded[0]) != protocol_version)
    return failure(CodecError::invalid_version);
  const auto payload_size = read_u16(decoded.data() + 14);
  if (payload_size > max_payload_size ||
      raw_header_size + payload_size + raw_crc_size != decoded_size) {
    return failure(CodecError::invalid_length);
  }
  if (read_u32(decoded.data() + raw_header_size + payload_size) !=
      crc32(decoded.first(raw_header_size + payload_size))) {
    return failure(CodecError::invalid_crc);
  }

  return {.error = CodecError::none,
          .frame = {.type = static_cast<MessageType>(std::to_integer<std::uint8_t>(decoded[1])),
                    .sequence = read_u32(decoded.data() + 2),
                    .timestamp_us = read_u64(decoded.data() + 6),
                    .payload = decoded.subspan(raw_header_size, payload_size)}};
}

const char* to_string(CodecError error) {
  switch (error) {
  case CodecError::none:
    return "none";
  case CodecError::output_too_small:
    return "output_too_small";
  case CodecError::malformed_cobs:
    return "malformed_cobs";
  case CodecError::malformed_frame:
    return "malformed_frame";
  case CodecError::invalid_version:
    return "invalid_version";
  case CodecError::invalid_length:
    return "invalid_length";
  case CodecError::invalid_crc:
    return "invalid_crc";
  }
  return "unknown";
}

} // namespace zero_path::audio_protocol
