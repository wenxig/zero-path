package com.zeropath.phonesimulator.audio

import android.content.Context
import android.os.SystemClock
import com.zeropath.phonesimulator.protocol.AudioFrame
import com.zeropath.phonesimulator.protocol.AudioFrameCodec
import com.zeropath.phonesimulator.protocol.MessageType
import com.zeropath.phonesimulator.protocol.TestCommand
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.math.PI
import kotlin.math.sin

enum class AudioTransferState { IDLE, UPLOADING, DOWNLOADING, DUPLEX }

data class AudioTestSnapshot(
  val state: AudioTransferState,
  val connected: Boolean,
  val sentFrames: Long,
  val receivedFrames: Long,
  val droppedFrames: Long,
  val lastDownloadPath: String?,
  val status: String,
)

class AudioTestController(context: Context, val transport: SppAudioTransport) {
  private val appContext = context.applicationContext
  private val codec = AudioFrameCodec()
  private val scheduler = Executors.newSingleThreadScheduledExecutor()
  private val listeners = CopyOnWriteArrayList<(AudioTestSnapshot) -> Unit>()
  private val stateLock = Any()
  private val operationLock = Any()
  private var uploadTask: ScheduledFuture<*>? = null
  private var uploadStopTask: ScheduledFuture<*>? = null
  private var downloadStopTask: ScheduledFuture<*>? = null
  private var uploadGeneration = 0L
  private var downloadGeneration = 0L
  private var recorder: WavRecorder? = null
  private var sequence = 0L
  private var tonePhase = 0
  private var sentFrames = 0L
  private var receivedFrames = 0L
  private var droppedFrames = 0L
  private var lastDownlinkSequence: Long? = null
  private var lastDownloadPath: String? = null
  private var status = "idle"

  init {
    transport.onFrame = ::handleFrame
    transport.onStatus = {
      synchronized(stateLock) { status = it }
      publish()
    }
    transport.onDisconnected = ::handleDisconnect
    transport.onDecodeError = {
      synchronized(stateLock) {
        droppedFrames++
        status = "frame error: ${it.message}"
      }
      publish()
    }
  }

  fun addListener(listener: (AudioTestSnapshot) -> Unit): AutoCloseable {
    listeners.add(listener)
    listener(snapshot())
    return AutoCloseable { listeners.remove(listener) }
  }

  fun connect(address: String?) = transport.connect(address)

  fun startUpload(fixture: String, durationMs: Long): AudioTestSnapshot {
    require(transport.connected) { "ESP32 is not connected" }
    require(fixture == "silence" || fixture == "tone-440") { "unknown fixture: $fixture" }
    require(durationMs in 100..3_600_000) { "invalid duration" }
    synchronized(operationLock) {
      stopDownloadInternal(sendControl = true)
      stopUploadInternal(sendControl = true)
      sendControl(TestCommand.ENABLE_LOOPBACK)
      val currentGeneration = synchronized(stateLock) {
        status = "uploading $fixture"
        ++uploadGeneration
      }
      val frameTask = scheduler.scheduleWithFixedDelay(
        { sendUploadFrame(fixture, currentGeneration) },
        0,
        20,
        TimeUnit.MILLISECONDS,
      )
      val stopTask = scheduler.schedule(
        { stopUpload(currentGeneration) },
        durationMs,
        TimeUnit.MILLISECONDS,
      )
      synchronized(stateLock) {
        uploadTask = frameTask
        uploadStopTask = stopTask
      }
    }
    publish()
    return snapshot()
  }

  fun stopUpload(): AudioTestSnapshot {
    synchronized(operationLock) { stopUploadInternal(sendControl = true) }
    publish()
    return snapshot()
  }

  fun startDownload(durationMs: Long): AudioTestSnapshot {
    require(transport.connected) { "ESP32 is not connected" }
    require(durationMs in 100..3_600_000) { "invalid duration" }
    synchronized(operationLock) {
      stopUploadInternal(sendControl = true)
      stopDownloadInternal(sendControl = true)
      val directory = File(appContext.getExternalFilesDir(null), "downloads")
      require(directory.isDirectory || directory.mkdirs()) { "Cannot create the WAV download directory" }
      val newRecorder = WavRecorder(File(directory, "esp32-${System.currentTimeMillis()}.wav"))
      val currentGeneration = synchronized(stateLock) {
        recorder = newRecorder
        status = "downloading ESP32 tone"
        ++downloadGeneration
      }
      try {
        sendControl(TestCommand.START_DOWNLOAD_TONE)
      } catch (error: Exception) {
        synchronized(stateLock) {
          if (recorder === newRecorder) recorder = null
          downloadGeneration++
          status = "download start failed: ${error.message}"
        }
        newRecorder.close()
        throw error
      }
      val stopTask = scheduler.schedule(
        { stopDownload(currentGeneration) },
        durationMs,
        TimeUnit.MILLISECONDS,
      )
      synchronized(stateLock) { downloadStopTask = stopTask }
    }
    publish()
    return snapshot()
  }

  fun stopDownload(): AudioTestSnapshot {
    synchronized(operationLock) { stopDownloadInternal(sendControl = true) }
    publish()
    return snapshot()
  }

  fun snapshot(): AudioTestSnapshot = synchronized(stateLock) {
    AudioTestSnapshot(
      state = when {
        uploadTask != null && recorder != null -> AudioTransferState.DUPLEX
        uploadTask != null -> AudioTransferState.UPLOADING
        recorder != null -> AudioTransferState.DOWNLOADING
        else -> AudioTransferState.IDLE
      },
      connected = transport.connected,
      sentFrames = sentFrames,
      receivedFrames = receivedFrames,
      droppedFrames = droppedFrames,
      lastDownloadPath = lastDownloadPath,
      status = status,
    )
  }

  private fun sendUploadFrame(fixture: String, expectedGeneration: Long) {
    try {
      val publishNow = synchronized(operationLock) {
        if (synchronized(stateLock) { uploadGeneration != expectedGeneration }) return
        val payload = if (fixture == "silence") ByteArray(320) else toneFrame()
        val queued = transport.send(codec.encode(frame(MessageType.AUDIO_UPLINK, payload)))
        synchronized(stateLock) {
          if (queued) sentFrames++ else droppedFrames++
          sentFrames % 50L == 0L || !queued
        }
      }
      if (publishNow) publish()
    } catch (error: Exception) {
      synchronized(operationLock) {
        if (synchronized(stateLock) { uploadGeneration != expectedGeneration }) return
        synchronized(stateLock) {
          droppedFrames++
          status = "upload error: ${error.message}"
        }
        stopUploadInternal(sendControl = false)
      }
      publish()
    }
  }

  private fun sendControl(command: TestCommand) {
    check(
      transport.send(
        codec.encode(frame(MessageType.TEST_COMMAND, byteArrayOf(command.value))),
        control = true,
      ),
    ) { "ESP32 control queue is full" }
  }

  private fun frame(type: MessageType, payload: ByteArray): AudioFrame {
    val currentSequence = synchronized(stateLock) { sequence++ }
    return AudioFrame(type, currentSequence, SystemClock.elapsedRealtimeNanos() / 1_000, payload)
  }

  private fun toneFrame(): ByteArray {
    val buffer = ByteBuffer.allocate(320).order(ByteOrder.LITTLE_ENDIAN)
    synchronized(stateLock) {
      repeat(160) {
        val angle = 2.0 * PI * tonePhase / 8_000.0
        buffer.putShort((sin(angle) * 12_000).toInt().toShort())
        tonePhase = (tonePhase + 440) % 8_000
      }
    }
    return buffer.array()
  }

  private fun handleFrame(frame: AudioFrame) {
    if (frame.type != MessageType.AUDIO_DOWNLINK) return
    val publishNow = synchronized(stateLock) {
      if (frame.payload.size != PCM_FRAME_BYTES) {
        droppedFrames++
        status = "invalid PCM frame size: ${frame.payload.size}"
        return@synchronized true
      }
      val expectedSequence = lastDownlinkSequence?.let { (it + 1) and 0xffffffffL }
      if (expectedSequence != null && frame.sequence != expectedSequence) droppedFrames++
      lastDownlinkSequence = frame.sequence
      receivedFrames++
      recorder?.write(frame.payload)
      receivedFrames % 50L == 0L
    }
    if (publishNow) publish()
  }

  private fun publish() {
    val value = snapshot()
    listeners.forEach { it(value) }
  }

  private fun stopUpload(expectedGeneration: Long) {
    synchronized(operationLock) {
      if (synchronized(stateLock) { uploadGeneration != expectedGeneration }) return
      stopUploadInternal(sendControl = true)
    }
    publish()
  }

  private fun stopUploadInternal(sendControl: Boolean) {
    val wasActive = synchronized(stateLock) {
      val active = uploadTask != null || uploadStopTask != null
      uploadGeneration++
      uploadTask?.cancel(false)
      uploadStopTask?.cancel(false)
      uploadTask = null
      uploadStopTask = null
      if (active) transport.clearAudioQueue()
      status = if (recorder == null) "idle" else "downloading"
      active
    }
    if (wasActive && sendControl && transport.connected) {
      val queued = runCatching { sendControl(TestCommand.DISABLE_LOOPBACK) }.isSuccess
      if (!queued) {
        synchronized(stateLock) { status = "stop control failed; disconnecting ESP32" }
        transport.disconnect()
      }
    }
  }

  private fun stopDownload(expectedGeneration: Long) {
    synchronized(operationLock) {
      if (synchronized(stateLock) { downloadGeneration != expectedGeneration }) return
      stopDownloadInternal(sendControl = true)
    }
    publish()
  }

  private fun stopDownloadInternal(sendControl: Boolean) {
    val activeRecorder = synchronized(stateLock) {
      downloadGeneration++
      downloadStopTask?.cancel(false)
      downloadStopTask = null
      recorder.also { recorder = null }
    }
    var forcedDisconnect = false
    if (activeRecorder != null && sendControl && transport.connected) {
      val queued = runCatching { sendControl(TestCommand.STOP_DOWNLOAD_TONE) }.isSuccess
      if (!queued) {
        forcedDisconnect = true
        synchronized(stateLock) { status = "stop control failed; disconnecting ESP32" }
        transport.disconnect()
      }
    }
    if (activeRecorder != null) {
      runCatching { activeRecorder.close() }
      synchronized(stateLock) { lastDownloadPath = activeRecorder.path }
    }
    synchronized(stateLock) {
      status = when {
        forcedDisconnect -> "ESP32 disconnected"
        uploadTask == null -> "idle"
        else -> "uploading"
      }
    }
  }

  private fun handleDisconnect() {
    synchronized(operationLock) {
      stopUploadInternal(sendControl = false)
      stopDownloadInternal(sendControl = false)
      synchronized(stateLock) {
        lastDownlinkSequence = null
        status = "ESP32 disconnected"
      }
    }
    publish()
  }

  companion object {
    private const val PCM_FRAME_BYTES = 320
  }
}
