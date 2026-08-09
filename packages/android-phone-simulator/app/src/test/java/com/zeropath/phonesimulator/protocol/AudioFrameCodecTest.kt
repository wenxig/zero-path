package com.zeropath.phonesimulator.protocol

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioFrameCodecTest {
  private val codec = AudioFrameCodec()

  @Test
  fun roundTripsBinaryPayload() {
    val payload = byteArrayOf(0, 1, 2, 0, 0x7f)
    val decoded = codec.decode(
      codec.encode(AudioFrame(MessageType.AUDIO_UPLINK, 42, 123_456, payload)),
    )

    assertEquals(MessageType.AUDIO_UPLINK, decoded.type)
    assertEquals(42, decoded.sequence)
    assertEquals(123_456, decoded.timestampUs)
    assertArrayEquals(payload, decoded.payload)
  }

  @Test
  fun rejectsCorruptFrame() {
    val encoded = codec.encode(AudioFrame(MessageType.TEST_COMMAND, 1, 2, byteArrayOf(1)))
    encoded[3] = (encoded[3].toInt() xor 0x40).toByte()

    assertThrows(IllegalArgumentException::class.java) { codec.decode(encoded) }
  }

  @Test
  fun discardsEntireOversizedFrameBeforeResuming() {
    val decoder = AudioFrameStreamDecoder(codec)
    val valid = codec.encode(AudioFrame(MessageType.HEARTBEAT, 7, 8, byteArrayOf()))
    val frames = mutableListOf<AudioFrame>()
    val errors = mutableListOf<Exception>()

    decoder.feed(ByteArray(700) { 1 } + byteArrayOf(0) + valid, frames::add, errors::add)

    assertEquals(1, errors.size)
    assertEquals(1, frames.size)
    assertEquals(7, frames.single().sequence)
    assertTrue(errors.single().message!!.contains("too large"))
  }

  @Test
  fun matchesCppGoldenVector() {
    val encoded = codec.encode(
      AudioFrame(
        MessageType.AUDIO_UPLINK,
        0x01020304,
        0x0102030405060708,
        byteArrayOf(0, 1, 0, 0xff.toByte()),
      ),
    )
    val expected = "1001070403020108070605040302010401020106ff9f1fc0f500"
      .chunked(2)
      .map { it.toInt(16).toByte() }
      .toByteArray()

    assertArrayEquals(expected, encoded)
  }

  @Test
  fun roundTripsMaximumPayload() {
    val payload = ByteArray(AudioFrameCodec.MAX_PAYLOAD_SIZE) { it.toByte() }

    val decoded = codec.decode(
      codec.encode(AudioFrame(MessageType.AUDIO_DOWNLINK, 9, 10, payload)),
    )

    assertArrayEquals(payload, decoded.payload)
  }
}
