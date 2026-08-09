package com.zeropath.phonesimulator.audio

import java.io.File
import java.io.RandomAccessFile

class WavRecorder(file: File) : AutoCloseable {
  private val output = RandomAccessFile(file, "rw")
  private var dataBytes = 0L

  val path: String = file.absolutePath

  init {
    output.setLength(0)
    output.write(ByteArray(44))
  }

  @Synchronized
  fun write(pcm: ByteArray) {
    output.write(pcm)
    dataBytes += pcm.size
  }

  @Synchronized
  override fun close() {
    output.seek(0)
    output.writeBytes("RIFF")
    output.writeLittleEndianInt(36 + dataBytes.toInt())
    output.writeBytes("WAVEfmt ")
    output.writeLittleEndianInt(16)
    output.writeLittleEndianShort(1)
    output.writeLittleEndianShort(1)
    output.writeLittleEndianInt(8_000)
    output.writeLittleEndianInt(16_000)
    output.writeLittleEndianShort(2)
    output.writeLittleEndianShort(16)
    output.writeBytes("data")
    output.writeLittleEndianInt(dataBytes.toInt())
    output.close()
  }

  private fun RandomAccessFile.writeLittleEndianInt(value: Int) {
    write(value and 0xff)
    write(value ushr 8 and 0xff)
    write(value ushr 16 and 0xff)
    write(value ushr 24 and 0xff)
  }

  private fun RandomAccessFile.writeLittleEndianShort(value: Int) {
    write(value and 0xff)
    write(value ushr 8 and 0xff)
  }
}
