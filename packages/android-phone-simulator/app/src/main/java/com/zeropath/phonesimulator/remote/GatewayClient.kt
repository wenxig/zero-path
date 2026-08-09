package com.zeropath.phonesimulator.remote

import android.content.Context
import android.os.Build
import android.provider.Settings
import com.zeropath.phonesimulator.audio.AudioTestController
import com.zeropath.phonesimulator.audio.AudioTestSnapshot
import com.zeropath.phonesimulator.security.PinManager
import com.zeropath.phonesimulator.security.ShellExecutor
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

class GatewayClient(
  context: Context,
  private val audioController: AudioTestController,
  private val pinManager: PinManager,
  private val shellExecutor: ShellExecutor,
  private val commandExecutor: ExecutorService,
) {
  private val appContext = context.applicationContext
  private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
  val deviceId: String = Settings.Secure.getString(appContext.contentResolver, Settings.Secure.ANDROID_ID)
  private val connectionLock = Any()
  private val reconnectExecutor = Executors.newSingleThreadScheduledExecutor()
  private var socket: WebSocket? = null
  @Volatile private var authenticatedSocket: WebSocket? = null
  private val generation = AtomicLong()
  @Volatile private var shouldReconnect = false
  var onStatus: (String) -> Unit = {}

  init {
    audioController.addListener(::sendSnapshot)
  }

  fun start(url: String, token: String, allowInsecure: Boolean) {
    require(url.startsWith("ws://") || url.startsWith("wss://")) { "Gateway URL must use ws:// or wss://" }
    require(url.startsWith("wss://") || allowInsecure) {
      "Plaintext ws:// requires the explicit LAN development option"
    }
    require(token.isNotBlank()) { "Gateway token is required" }
    stop()
    shouldReconnect = true
    val connectionGeneration = generation.get()
    connect(url, token, connectionGeneration)
  }

  fun stop() {
    shouldReconnect = false
    generation.incrementAndGet()
    val previous = synchronized(connectionLock) {
      authenticatedSocket = null
      socket.also { socket = null }
    }
    previous?.close(1000, "stopped")
  }

  private fun connect(url: String, token: String, connectionGeneration: Long) {
    if (generation.get() != connectionGeneration) return
    onStatus("connecting to gateway")
    val request = Request.Builder()
      .url(url)
      .header("Authorization", "Bearer $token")
      .header("X-Zero-Path-Device-Id", deviceId)
      .build()
    val newSocket = client.newWebSocket(request, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        val claimed = synchronized(connectionLock) {
          if (
            generation.get() == connectionGeneration &&
            shouldReconnect &&
            (socket == null || socket === webSocket)
          ) {
            socket = webSocket
            true
          } else {
            false
          }
        }
        if (!claimed) {
          webSocket.close(1000, "superseded")
          return
        }
        webSocket.send(
          JSONObject()
            .put("kind", "hello")
            .put("deviceId", deviceId)
            .put("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}")
            .put("protocolVersion", 1)
            .toString(),
        )
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        val message = runCatching { JSONObject(text) }.getOrElse {
          onStatus("invalid gateway message")
          return
        }
        if (message.optString("kind") == "hello_ack") {
          if (message.optString("deviceId") != deviceId) {
            webSocket.close(4003, "gateway identity mismatch")
            return
          }
          val accepted = synchronized(connectionLock) {
            if (generation.get() == connectionGeneration && socket === webSocket) {
              authenticatedSocket = webSocket
              true
            } else {
              false
            }
          }
          if (!accepted) return
          onStatus("gateway connected")
          sendSnapshot(audioController.snapshot())
          return
        }
        if (authenticatedSocket !== webSocket) {
          webSocket.close(4003, "gateway handshake required")
          return
        }
        if (message.optString("kind") != "command") return
        try {
          commandExecutor.execute {
            if (isCurrent(webSocket, connectionGeneration)) handleCommand(webSocket, message)
          }
        } catch (_: RejectedExecutionException) {
          message.optString("requestId").takeIf { it.isNotBlank() }?.let {
            webSocket.send(resultMessage(it, false, null, "device command queue is full").toString())
          }
        }
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        if (generation.get() != connectionGeneration) return
        clearSocket(webSocket)
        onStatus("gateway disconnected")
        reconnect(url, token, connectionGeneration)
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        if (generation.get() != connectionGeneration) return
        clearSocket(webSocket)
        onStatus("gateway error: ${t.message}")
        reconnect(url, token, connectionGeneration)
      }
    })
    synchronized(connectionLock) {
      if (
        generation.get() == connectionGeneration &&
        shouldReconnect &&
        (socket == null || socket === newSocket)
      ) {
        socket = newSocket
      } else {
        newSocket.cancel()
      }
    }
  }

  private fun reconnect(url: String, token: String, connectionGeneration: Long) {
    if (!shouldReconnect) return
    val nextGeneration = connectionGeneration + 1
    if (!generation.compareAndSet(connectionGeneration, nextGeneration)) return
    reconnectExecutor.schedule({
      if (shouldReconnect && generation.get() == nextGeneration) connect(url, token, nextGeneration)
    }, 3, TimeUnit.SECONDS)
  }

  private fun handleCommand(webSocket: WebSocket, message: JSONObject) {
    val requestId = message.optString("requestId").takeIf { it.isNotBlank() }
    if (requestId == null) {
      onStatus("invalid gateway command")
      return
    }
    try {
      val command = message.getJSONObject("command")
      val result = executeCommand(command)
      webSocket.send(resultMessage(requestId, true, result, null).toString())
      sendSnapshot(audioController.snapshot())
    } catch (error: Exception) {
      webSocket.send(resultMessage(requestId, false, null, error.message ?: "command failed").toString())
    }
  }

  private fun executeCommand(command: JSONObject): JSONObject {
    return when (command.getString("name")) {
      "get_state" -> snapshotJson(audioController.snapshot())
      "start_audio_upload" -> snapshotJson(
        audioController.startUpload(
          command.getString("fixture"),
          command.getLong("durationMs"),
        ),
      )
      "stop_audio_upload" -> snapshotJson(audioController.stopUpload())
      "start_audio_download" -> snapshotJson(audioController.startDownload(command.getLong("durationMs")))
      "stop_audio_download" -> snapshotJson(audioController.stopDownload())
      "set_simulation_mode" -> {
        require(command.getString("mode") == "protocol") { "Only protocol audio testing is enabled" }
        snapshotJson(audioController.snapshot())
      }
      "arm_shell" -> pinManager.arm(command.getString("pin")).let {
        JSONObject().put("sessionToken", it.token).put("expiresAt", it.expiresAt.toString())
      }
      "execute_shell" -> shellExecutor.execute(
        command.getString("command"),
        command.getString("sessionToken"),
        command.getLong("timeoutMs"),
      ).let {
        JSONObject()
          .put("exitCode", it.exitCode)
          .put("output", it.output)
          .put("truncated", it.truncated)
          .put("durationMs", it.durationMs)
      }
      else -> throw IllegalArgumentException("Unsupported command: ${command.getString("name")}")
    }
  }

  private fun sendSnapshot(snapshot: AudioTestSnapshot) {
    authenticatedSocket?.send(
      JSONObject()
        .put("kind", "event")
        .put("event", "state")
        .put("state", snapshot.state.name)
        .put("mode", "protocol")
        .put("sentFrames", snapshot.sentFrames)
        .put("receivedFrames", snapshot.receivedFrames)
        .put("droppedFrames", snapshot.droppedFrames)
        .put("message", snapshot.status)
        .toString(),
    )
  }

  private fun snapshotJson(snapshot: AudioTestSnapshot) = JSONObject()
    .put("state", snapshot.state.name)
    .put("connected", snapshot.connected)
    .put("sentFrames", snapshot.sentFrames)
    .put("receivedFrames", snapshot.receivedFrames)
    .put("droppedFrames", snapshot.droppedFrames)
    .put("lastDownloadPath", snapshot.lastDownloadPath)
    .put("status", snapshot.status)

  private fun resultMessage(requestId: String, ok: Boolean, data: JSONObject?, error: String?) = JSONObject()
    .put("kind", "result")
    .put("requestId", requestId)
    .put("ok", ok)
    .put("data", data)
    .put("error", error)

  private fun isCurrent(webSocket: WebSocket, connectionGeneration: Long): Boolean =
    generation.get() == connectionGeneration && synchronized(connectionLock) { socket === webSocket }

  private fun clearSocket(webSocket: WebSocket) {
    synchronized(connectionLock) {
      if (socket === webSocket) socket = null
      if (authenticatedSocket === webSocket) authenticatedSocket = null
    }
  }
}
