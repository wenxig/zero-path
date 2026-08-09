package com.zeropath.phonesimulator.protocol

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.CRC32

enum class MessageType(val value: Int) {
  HELLO(1),
  HEARTBEAT(2),
  PAIRING_STATE(3),
  CALL_STATE(4),
  SCO_STATE(5),
  AUDIO_DOWNLINK(6),
  AUDIO_UPLINK(7),
  AUDIO_STATS(8),
  ERROR(9),
  TEST_COMMAND(10);

  companion object {
    fun fromValue(value: Int): MessageType = entries.firstOrNull { it.value == value }
      ?: throw IllegalArgumentException("unknown message type: $value")
  }
}

enum class TestCommand(val value: Byte) {
  START_DOWNLOAD_TONE(1),
  STOP_DOWNLOAD_TONE(2),
  ENABLE_LOOPBACK(3),
  DISABLE_LOOPBACK(4),
}

data class AudioFrame(
  val type: MessageType,
  val sequence: Long,
  val timestampUs: Long,
  val payload: ByteArray,
)

class AudioFrameCodec {
  fun encode(frame: AudioFrame): ByteArray {
    require(frame.payload.size <= MAX_PAYLOAD_SIZE) { "payload is too large" }
    val raw = ByteBuffer.allocate(HEADER_SIZE + frame.payload.size + CRC_SIZE)
      .order(ByteOrder.LITTLE_ENDIAN)
    raw.put(PROTOCOL_VERSION)
    raw.put(frame.type.value.toByte())
    raw.putInt(frame.sequence.toInt())
    raw.putLong(frame.timestampUs)
    raw.putShort(frame.payload.size.toShort())
    raw.put(frame.payload)
    val crc = CRC32().apply { update(raw.array(), 0, HEADER_SIZE + frame.payload.size) }.value
    raw.putInt(crc.toInt())
    return cobsEncode(raw.array()) + byteArrayOf(0)
  }

  fun decode(encoded: ByteArray): AudioFrame {
    val bytes = if (encoded.lastOrNull() == 0.toByte()) encoded.copyOf(encoded.size - 1) else encoded
    val raw = cobsDecode(bytes)
    require(raw.size >= HEADER_SIZE + CRC_SIZE) { "frame is too short" }
    val buffer = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN)
    require(buffer.get() == PROTOCOL_VERSION) { "invalid protocol version" }
    val type = MessageType.fromValue(buffer.get().toInt() and 0xff)
    val sequence = buffer.int.toLong() and 0xffffffffL
    val timestampUs = buffer.long
    val payloadSize = buffer.short.toInt() and 0xffff
    require(payloadSize <= MAX_PAYLOAD_SIZE) { "payload is too large" }
    require(raw.size == HEADER_SIZE + payloadSize + CRC_SIZE) { "invalid payload length" }
    val payload = ByteArray(payloadSize)
    buffer.get(payload)
    val expectedCrc = buffer.int.toLong() and 0xffffffffL
    val actualCrc = CRC32().apply { update(raw, 0, HEADER_SIZE + payloadSize) }.value
    require(expectedCrc == actualCrc) { "invalid CRC" }
    return AudioFrame(type, sequence, timestampUs, payload)
  }

  private fun cobsEncode(input: ByteArray): ByteArray {
    val output = ByteArray(input.size + input.size / 254 + 1)
    var read = 0
    var write = 1
    var codeIndex = 0
    var code = 1
    while (read < input.size) {
      if (input[read] == 0.toByte()) {
        output[codeIndex] = code.toByte()
        code = 1
        codeIndex = write++
        read++
      } else {
        output[write++] = input[read++]
        code++
        if (code == 0xff) {
          output[codeIndex] = code.toByte()
          code = 1
          codeIndex = write++
        }
      }
    }
    output[codeIndex] = code.toByte()
    return output.copyOf(write)
  }

  private fun cobsDecode(input: ByteArray): ByteArray {
    require(input.isNotEmpty()) { "empty COBS frame" }
    val output = ByteArray(input.size)
    var read = 0
    var write = 0
    while (read < input.size) {
      val code = input[read++].toInt() and 0xff
      require(code != 0) { "invalid COBS code" }
      val count = code - 1
      require(read + count <= input.size) { "invalid COBS block" }
      repeat(count) { output[write++] = input[read++] }
      if (code != 0xff && read < input.size) output[write++] = 0
    }
    return output.copyOf(write)
  }

  companion object {
    const val MAX_PAYLOAD_SIZE = 512
    private const val HEADER_SIZE = 16
    private const val CRC_SIZE = 4
    private const val PROTOCOL_VERSION: Byte = 1
  }
}

class AudioFrameStreamDecoder(private val codec: AudioFrameCodec = AudioFrameCodec()) {
  private val buffer = ArrayList<Byte>(600)
  private var discardingOversizedFrame = false

  fun feed(bytes: ByteArray, onFrame: (AudioFrame) -> Unit, onError: (Exception) -> Unit) {
    for (byte in bytes) {
      if (discardingOversizedFrame) {
        if (byte == 0.toByte()) discardingOversizedFrame = false
        continue
      }
      if (byte == 0.toByte()) {
        if (buffer.isNotEmpty()) {
          try {
            onFrame(codec.decode(buffer.toByteArray()))
          } catch (error: Exception) {
            onError(error)
          }
          buffer.clear()
        }
      } else if (buffer.size < 600) {
        buffer.add(byte)
      } else {
        buffer.clear()
        discardingOversizedFrame = true
        onError(IllegalArgumentException("encoded frame is too large"))
      }
    }
  }
}
