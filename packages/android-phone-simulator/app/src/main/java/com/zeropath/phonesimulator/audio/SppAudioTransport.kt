package com.zeropath.phonesimulator.audio

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import com.zeropath.phonesimulator.protocol.AudioFrame
import com.zeropath.phonesimulator.protocol.AudioFrameStreamDecoder
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class SppAudioTransport(context: Context) {
  private val bluetoothManager = context.getSystemService(BluetoothManager::class.java)
  private val ioExecutor: ExecutorService = Executors.newFixedThreadPool(4)
  private val stateLock = Any()
  private var generation = 0L
  private var pendingSocket: BluetoothSocket? = null
  private var connection: Connection? = null

  var onFrame: (AudioFrame) -> Unit = {}
  var onStatus: (String) -> Unit = {}
  var onDecodeError: (Exception) -> Unit = {}
  var onDisconnected: () -> Unit = {}

  val connected: Boolean
    get() = synchronized(stateLock) { connection != null }

  @SuppressLint("MissingPermission")
  fun connect(address: String?) {
    val adapter = bluetoothManager.adapter ?: throw IllegalStateException("Bluetooth is unavailable")
    require(adapter.isEnabled) { "Bluetooth is disabled" }
    val device = if (address.isNullOrBlank()) {
      adapter.bondedDevices.firstOrNull { it.name == DEVICE_NAME }
        ?: throw IllegalStateException("Pair $DEVICE_NAME in Android settings first")
    } else {
      adapter.getRemoteDevice(address)
    }
    val attempt = synchronized(stateLock) {
      generation++
      ConnectionAttempt(
        generation = generation,
        previousConnection = connection.also { connection = null },
        previousPendingSocket = pendingSocket.also { pendingSocket = null },
      )
    }
    runCatching { attempt.previousPendingSocket?.close() }
    if (attempt.previousConnection != null) {
      close(attempt.previousConnection)
      onDisconnected()
    }
    onStatus("connecting to ${device.address}")
    ioExecutor.execute {
      var candidate: BluetoothSocket? = null
      try {
        adapter.cancelDiscovery()
        val newSocket = device.createRfcommSocketToServiceRecord(SPP_UUID)
        candidate = newSocket
        val registered = synchronized(stateLock) {
          if (
            generation == attempt.generation &&
            pendingSocket == null &&
            connection == null
          ) {
            pendingSocket = newSocket
            true
          } else {
            false
          }
        }
        if (!registered) {
          newSocket.close()
          return@execute
        }
        newSocket.connect()
        val active = Connection(newSocket)
        val accepted = synchronized(stateLock) {
          if (
            generation == attempt.generation &&
            pendingSocket === newSocket &&
            connection == null
          ) {
            pendingSocket = null
            connection = active
            true
          } else {
            false
          }
        }
        if (!accepted) {
          candidate.close()
          return@execute
        }
        onStatus("connected to ${device.address}")
        ioExecutor.execute { writeLoop(active) }
        readLoop(active)
      } catch (error: Exception) {
        val current = synchronized(stateLock) {
          if (pendingSocket === candidate) pendingSocket = null
          generation == attempt.generation
        }
        runCatching { candidate?.close() }
        if (current) {
          onStatus("ESP32 connection failed: ${error.message}")
        }
      }
    }
  }

  fun send(frame: ByteArray, control: Boolean = false): Boolean {
    val active = synchronized(stateLock) { connection }
      ?: throw IllegalStateException("ESP32 is not connected")
    return if (control) active.controlQueue.offer(frame) else active.audioQueue.offer(frame)
  }

  fun clearAudioQueue() {
    synchronized(stateLock) { connection }?.audioQueue?.clear()
  }

  fun disconnect() {
    val previous = synchronized(stateLock) {
      generation++
      DisconnectedSockets(
        connection = connection.also { connection = null },
        pendingSocket = pendingSocket.also { pendingSocket = null },
      )
    }
    runCatching { previous.pendingSocket?.close() }
    if (previous.connection != null) {
      close(previous.connection)
      onStatus("ESP32 disconnected")
      onDisconnected()
    } else if (previous.pendingSocket != null) {
      onStatus("ESP32 connection canceled")
    }
  }

  private fun readLoop(active: Connection) {
    val decoder = AudioFrameStreamDecoder()
    val chunk = ByteArray(1_024)
    try {
      while (isActive(active)) {
        val count = active.socket.inputStream.read(chunk)
        if (count < 0) break
        decoder.feed(chunk, onFrame, onDecodeError, count)
      }
    } catch (error: IOException) {
      closeActive(active, "ESP32 connection closed: ${error.message}")
    } finally {
      closeActive(active, "ESP32 connection closed")
    }
  }

  private fun writeLoop(active: Connection) {
    try {
      while (isActive(active)) {
        val frame = active.controlQueue.poll() ?: active.audioQueue.poll(20, TimeUnit.MILLISECONDS)
        if (frame != null && isActive(active)) active.socket.outputStream.write(frame)
      }
    } catch (error: Exception) {
      closeActive(active, "ESP32 write failed: ${error.message}")
    }
  }

  private fun isActive(active: Connection): Boolean = synchronized(stateLock) { connection === active }

  private fun closeActive(active: Connection, status: String) {
    val removed = synchronized(stateLock) {
      if (connection === active) {
        connection = null
        generation++
        true
      } else {
        false
      }
    }
    if (!removed) return
    close(active)
    onStatus(status)
    onDisconnected()
  }

  private fun close(active: Connection) {
    active.controlQueue.clear()
    active.audioQueue.clear()
    try {
      active.socket.close()
    } catch (_: IOException) {
    }
  }

  private class Connection(val socket: BluetoothSocket) {
    val controlQueue = ArrayBlockingQueue<ByteArray>(16)
    val audioQueue = ArrayBlockingQueue<ByteArray>(2)
  }

  private data class ConnectionAttempt(
    val generation: Long,
    val previousConnection: Connection?,
    val previousPendingSocket: BluetoothSocket?,
  )

  private data class DisconnectedSockets(
    val connection: Connection?,
    val pendingSocket: BluetoothSocket?,
  )

  companion object {
    private const val DEVICE_NAME = "Zero Path Audio Test"
    private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
  }
}
